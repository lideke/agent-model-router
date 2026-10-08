import type { EngineInterface, Register } from 'claude-code'
import {
  type AgentFile,
  type Attempt,
  CONFIG_PATH,
  type Choice,
  type Config,
  decide,
  isTuner,
  parseConfig,
  prune,
  readAgentFile,
  starterConfig,
  taskKeyOf,
} from './route.ts'

const COMMAND = 'model-router'
const ATTEMPTS = 'attempts'

type Loaded = { path: string; config?: Config; error?: string }

const join = (root: string, path: string): string =>
  path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) ? path : `${root.replace(/[\\/]$/, '')}/${path}`

const dirOf = (path: string): string => path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')))

const short = (agent: string): string => agent.split(':').pop() ?? agent

const loadConfig = async ($: EngineInterface): Promise<Loaded> => {
  const root = await $.session.root()
  const path = join(root, CONFIG_PATH)
  if (!(await $.fs.exists(path))) return { path }
  try {
    return { path, config: parseConfig(await $.fs.read(path)) }
  } catch (err) {
    return { path, error: (err as Error).message }
  }
}

const isUnder = (path: string, root: string): boolean =>
  path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`)

/**
 * A cloned project can hold a symbolic link where the journal goes: every
 * step of `rel` that exists must resolve inside the project root, and a
 * step that exists without resolving (a dangling link) is refused.
 */
const staysInside = async ($: EngineInterface, root: string, rel: string): Promise<boolean> => {
  const realRoot = (await $.fs.stat(root, { resolve: true })).realPath
  if (realRoot === undefined) return false
  let at = root.replace(/[\\/]$/, '')
  for (const part of rel.split('/')) {
    const parent = at
    at = `${at}/${part}`
    const stat = await $.fs.stat(at, { resolve: true }).catch(() => undefined)
    if (stat === undefined) {
      const entries = await $.fs.list(parent).catch(() => [])
      return !entries.some(entry => entry.name === part)
    }
    if (stat.realPath === undefined || !isUnder(stat.realPath, realRoot)) return false
  }
  return true
}

// One journal write at a time: parallel spawns would otherwise overwrite each other.
let journalQueue: Promise<void> = Promise.resolve()

const appendJournal = ($: EngineInterface, cfg: Config, root: string, entry: object): Promise<void> => {
  const path = join(root, cfg.journal.path)
  const run = journalQueue.then(async () => {
    const relDir = dirOf(cfg.journal.path)
    if (!(await staysInside($, root, cfg.journal.path)) || !(await staysInside($, root, `${relDir}/.gitignore`))) {
      throw new Error(`${cfg.journal.path} resolves outside the project`)
    }
    const ignore = join(root, `${relDir}/.gitignore`)
    // The journal holds task descriptions: keep its folder out of git by default.
    if (!(await $.fs.exists(ignore))) await $.fs.write(ignore, '*\n')
    const old = (await $.fs.exists(path)) ? (await $.fs.read(path)).split('\n').filter(l => l.trim() !== '') : []
    old.push(JSON.stringify(entry))
    await $.fs.write(path, `${old.slice(-cfg.journal.maxEntries).join('\n')}\n`)
  })
  journalQueue = run.catch(() => {})
  return run
}

// The store is the user's, shared by every project: retry history is keyed by
// project root, so one task name in two projects never counts as a retry.
const scoped = (root: string, task: string): string => `${root}|${task}`

// One read-modify-write of the attempts at a time: parallel spawns would
// otherwise each write back their own copy and drop the others' tasks.
let attemptsQueue: Promise<unknown> = Promise.resolve()

const recordAttempt = ($: EngineInterface, cfg: Config, key: string, model: string, now: number): Promise<Attempt> => {
  const run = attemptsQueue.then(async () => {
    const attempts = prune(await $.store.get(ATTEMPTS), now, cfg.escalation.windowMinutes)
    const attempt = { model, count: (attempts[key]?.count ?? 0) + 1, at: now }
    attempts[key] = attempt
    await $.store.set(ATTEMPTS, attempts)
    return attempt
  })
  attemptsQueue = run.catch(() => {})
  return run
}

const label = (choice: Choice): string =>
  choice.source === 'rule' ? `rule /${choice.detail}/` : choice.detail ? `${choice.source}, ${choice.detail}` : choice.source

const reported = new Set<string>()

/** The project's own agents, from `.claude/agents/*.md`; none when the folder is missing. */
const projectAgents = async ($: EngineInterface, root: string): Promise<AgentFile[]> => {
  const dir = join(root, '.claude/agents')
  const files = (await $.fs.list(dir).catch(() => [])).filter(f => f.name.endsWith('.md')).sort((a, b) => a.name.localeCompare(b.name))
  const agents: AgentFile[] = []
  for (const f of files) {
    const text = await $.fs.read(`${dir}/${f.name}`).catch(() => undefined)
    if (text !== undefined) agents.push(readAgentFile(text, f.name))
  }
  return agents
}

/**
 * Hands the fitting of the config to Claude: a turn of its own, once the
 * session is idle. The engine refuses a prompt submitted while the command's
 * hook runs, so it is submitted from a timer, after the command has answered.
 * False when the instructions cannot be read.
 */
const adjust = async ($: EngineInterface): Promise<boolean> => {
  let text: string
  try {
    text = await $.fs.read(`${$.plugin.root}/prompts/adjust.md`)
  } catch {
    return false
  }
  $.clock.after(0, () => {
    void $.prompt.submit({ text }).catch(err => $.ui.log(`agent-model-router: adjustment not started: ${(err as Error).message}`))
  })
  return true
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'model-router',
      description: 'Show agent-model-router status; "init" creates the config, "adjust" fits it to this project',
      argumentHint: '[status|init|adjust]',
    })
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    // A fork keeps its parent's model, a workflow agent cannot be rewritten,
    // and the tuner must not be routed by the table it is tuning.
    if (e.fork || e.workflow || isTuner(e.subagentType)) return next(e)

    const loaded = await loadConfig($)
    if (loaded.error && !reported.has(loaded.error)) {
      reported.add(loaded.error)
      $.ui.toast(`agent-model-router is off: ${loaded.error}`)
    }
    const cfg = loaded.config
    if (!cfg || !cfg.enabled) return next(e)

    const facts = { agent: e.subagentType, prompt: e.prompt, description: e.description, given: e.model }
    const now = await $.clock.now()
    const root = await $.session.root()
    const task = taskKeyOf(facts, cfg)
    const key = scoped(root, task)
    const previous = prune(await $.store.get(ATTEMPTS), now, cfg.escalation.windowMinutes)[key]
    let choice = decide(facts, cfg, previous)

    const routed = choice.model !== undefined && choice.model !== e.model
    let result = await next(routed ? { ...e, model: choice.model } : e)
    // Refused on the model the table chose (one the account may not have, such
    // as `fable`): run the agent as it would have run without the plugin.
    if (routed && 'deny' in result && result.deny !== undefined) {
      const refused = `${choice.model} refused (${result.deny})`
      $.ui.toast(`agent-model-router: ${refused}, ${short(e.subagentType)} runs on its own model`)
      choice = { model: e.model, source: 'default', detail: refused }
      result = await next(e)
    }
    if ('deny' in result && result.deny !== undefined) return result

    // The agent is running: nothing below may throw, or the fail-open catch
    // would spawn it a second time.
    try {
      const attempt = await recordAttempt($, cfg, key, result.model, now)

      if (cfg.notify && choice.source !== 'default' && choice.source !== 'caller') {
        $.ui.toast(`${short(e.subagentType)} → ${choice.model} (${label(choice)})`)
      }

      if (cfg.journal.enabled) {
        await appendJournal($, cfg, root, {
          ts: new Date(now).toISOString(),
          agent: e.subagentType,
          task,
          attempt: attempt.count,
          source: choice.source,
          detail: choice.detail,
          requested: choice.model ?? null,
          resolved: result.model,
          description: e.description,
          promptChars: e.prompt.length,
        }).catch(err => $.ui.log(`agent-model-router: journal not written: ${(err as Error).message}`))
      }
    } catch (err) {
      $.ui.log(`agent-model-router: decision not recorded: ${(err as Error).message}`)
    }

    return result
  }).catch(($, e, next) => next(e)) // fail open: a broken config or store never blocks an agent

  on('command.run', { command: 'model-router' }, async ($, e) => {
    const loaded = await loadConfig($)

    const arg = e.args.trim()
    if (arg === 'init') {
      if (loaded.config || loaded.error) return { text: `${loaded.path} already exists. Run /${COMMAND} adjust to fit it to this project.` }
      const root = await $.session.root()
      if (!(await staysInside($, root, CONFIG_PATH))) return { text: `${loaded.path} resolves outside the project; not written.` }
      const agents = await projectAgents($, root)
      await $.fs.write(loaded.path, `${JSON.stringify(starterConfig(agents), null, 2)}\n`)
      const names = ['Explore', ...agents.map(a => a.name)].join(', ')
      const adjusting = await adjust($)
      return {
        text: `Created ${loaded.path} with ${names}. Routing is on.${adjusting
          ? ' Claude now fits task names, rules and context to this project.'
          : ` Run /${COMMAND} adjust in an interactive session to fit it to this project.`}`,
      }
    }

    if (arg === 'adjust') {
      if (!loaded.config && !loaded.error) return { text: `No config yet. Run /${COMMAND} init first.` }
      return { text: (await adjust($)) ? `Claude now fits ${loaded.path} to this project.` : 'Could not start the adjustment here; run it in an interactive session.' }
    }

    const lines = [`agent-model-router: ${loaded.path}`]
    const cfg = loaded.config
    if (loaded.error) lines.push(`Config error, routing is off: ${loaded.error}`)
    else if (!cfg) lines.push(`No config, routing is off. Run /${COMMAND} init to create one.`)
    else {
      lines.push(`Routing: ${cfg.enabled ? 'on' : 'off (enabled: false)'}`)
      lines.push(`Ladder: ${cfg.ladder.join(' < ')}${cfg.maxModel ? `, capped at ${cfg.maxModel}` : ''}`)
      lines.push(`Escalation on retry: ${cfg.escalation.enabled ? `on, within ${cfg.escalation.windowMinutes} min` : 'off'}`)
      for (const [name, entry] of Object.entries(cfg.agents)) {
        const rules = entry.rules.length ? `, ${entry.rules.length} rule(s)` : ''
        lines.push(`  ${name}: ${entry.model ?? 'agent default'}${rules}`)
      }
      const now = await $.clock.now()
      const root = await $.session.root()
      const attempts = prune(await $.store.get(ATTEMPTS), now, cfg.escalation.windowMinutes)
      const tracked = Object.keys(attempts).filter(k => k.startsWith(scoped(root, ''))).length
      lines.push(`Tasks tracked for retry: ${tracked}`)

      const journal = join(root, cfg.journal.path)
      if (cfg.journal.enabled && (await $.fs.exists(journal)) && (await staysInside($, root, cfg.journal.path))) {
        const last = (await $.fs.read(journal)).split('\n').filter(l => l.trim() !== '').slice(-10)
        lines.push('Last decisions:')
        for (const l of last) {
          try {
            const j = JSON.parse(l) as Record<string, unknown>
            lines.push(`  ${String(j.ts).slice(0, 16)} ${short(String(j.agent))} → ${String(j.resolved)} (${String(j.source)}, attempt ${String(j.attempt)})`)
          } catch {
            // a hand-edited line: skip it
          }
        }
      }
    }
    return { text: lines.join('\n') }
  })
}
