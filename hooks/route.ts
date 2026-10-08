// Pure routing logic: config parsing and the model decision for one spawn.
// No `$` here, so every rule is testable on plain values.

export const CONFIG_PATH = '.claude/agent-model-router.json'
export const TUNER = 'model-tuner'

export type Rule = { match: string; model: string }

export type AgentEntry = { model?: string; rules: Rule[] }

export type Config = {
  enabled: boolean
  ladder: string[]
  maxModel?: string
  agents: Record<string, AgentEntry>
  tags: boolean
  escalation: { enabled: boolean; taskKey?: string; windowMinutes: number }
  journal: { enabled: boolean; path: string; maxEntries: number }
  notify: boolean
  context: string[]
}

export type Attempt = { model: string; count: number; at: number }

export type Source = 'tag' | 'caller' | 'rule' | 'table' | 'escalation' | 'default'

export type Choice = { model?: string; source: Source; detail?: string }

export type SpawnFacts = {
  agent: string
  prompt: string
  description: string
  given?: string
}

const TAG = /\[model:\s*([\w.\-]+)\s*\]/i

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const str = (v: unknown, where: string): string => {
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`${where} must be a non-empty string`)
  return v.trim()
}

const regex = (pattern: string, where: string): RegExp => {
  try {
    return new RegExp(pattern, 'i')
  } catch {
    throw new Error(`${where} is not a valid regular expression: ${pattern}`)
  }
}

/** Parses the project config, filling defaults. Throws a readable error on a bad field. */
export const parseConfig = (text: string): Config => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new Error(`${CONFIG_PATH} is not valid JSON: ${(err as Error).message}`)
  }
  if (!isRecord(raw)) throw new Error(`${CONFIG_PATH} must hold a JSON object`)

  const ladder = raw.ladder === undefined
    ? ['haiku', 'sonnet', 'opus']
    : Array.isArray(raw.ladder) ? raw.ladder.map((m, i) => str(m, `ladder[${i}]`).toLowerCase()) : []
  if (ladder.length < 2) throw new Error('ladder must list at least two models, cheapest first')

  const agents: Record<string, AgentEntry> = {}
  const rawAgents = raw.agents ?? {}
  if (!isRecord(rawAgents)) throw new Error('agents must be an object keyed by agent name')
  for (const [name, value] of Object.entries(rawAgents)) {
    if (!isRecord(value)) throw new Error(`agents.${name} must be an object`)
    const rules = value.rules ?? []
    if (!Array.isArray(rules)) throw new Error(`agents.${name}.rules must be a list`)
    agents[name] = {
      model: value.model === undefined || value.model === null ? undefined : str(value.model, `agents.${name}.model`),
      rules: rules.map((r, i) => {
        const where = `agents.${name}.rules[${i}]`
        if (!isRecord(r)) throw new Error(`${where} must be { "match": ..., "model": ... }`)
        const match = str(r.match, `${where}.match`)
        regex(match, `${where}.match`)
        return { match, model: str(r.model, `${where}.model`) }
      }),
    }
  }

  const esc = isRecord(raw.escalation) ? raw.escalation : {}
  const taskKey = esc.taskKey === undefined ? undefined : str(esc.taskKey, 'escalation.taskKey')
  if (taskKey) regex(taskKey, 'escalation.taskKey')
  const jr = isRecord(raw.journal) ? raw.journal : {}
  const maxModel = raw.maxModel === undefined ? undefined : str(raw.maxModel, 'maxModel')

  return {
    enabled: raw.enabled !== false,
    ladder,
    maxModel,
    agents,
    tags: raw.tags !== false,
    escalation: {
      enabled: esc.enabled !== false,
      taskKey,
      windowMinutes: typeof esc.windowMinutes === 'number' && esc.windowMinutes > 0 ? esc.windowMinutes : 240,
    },
    journal: {
      enabled: jr.enabled !== false,
      path: typeof jr.path === 'string' && jr.path.trim() !== '' ? jr.path.trim() : '.claude/agent-model-router/journal.jsonl',
      maxEntries: typeof jr.maxEntries === 'number' && jr.maxEntries > 0 ? Math.floor(jr.maxEntries) : 5000,
    },
    notify: raw.notify !== false,
    context: Array.isArray(raw.context) ? raw.context.filter((c): c is string => typeof c === 'string') : [],
  }
}

/** Place of a model on the ladder: an alias (`sonnet`) or a full id that contains it. -1 when unknown. */
export const rankOf = (model: string | undefined, ladder: readonly string[]): number => {
  if (!model) return -1
  const m = model.toLowerCase()
  for (let i = ladder.length - 1; i >= 0; i--) {
    const step = ladder[i]
    if (step !== undefined && (m === step || m.includes(step))) return i
  }
  return -1
}

export const stepUp = (model: string, ladder: readonly string[]): string | undefined => {
  const r = rankOf(model, ladder)
  if (r < 0) return undefined
  return ladder[Math.min(r + 1, ladder.length - 1)]
}

export const isTuner = (agent: string): boolean => agent === TUNER || agent.endsWith(`:${TUNER}`)

export const entryFor = (agent: string, cfg: Config): AgentEntry | undefined =>
  cfg.agents[agent] ?? cfg.agents[agent.split(':').pop() ?? agent] ?? cfg.agents['*']

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()

/** Identifies "the same task" across spawns: agent plus the taskKey match, else the description. */
export const taskKeyOf = (facts: SpawnFacts, cfg: Config): string => {
  let part = norm(facts.description)
  if (cfg.escalation.taskKey) {
    const m = regex(cfg.escalation.taskKey, 'escalation.taskKey').exec(`${facts.description}\n${facts.prompt}`)
    if (m) part = norm(m[1] ?? m[0])
  }
  return `${facts.agent}|${part}`
}

/** Drops attempts older than the window. */
export const prune = (raw: unknown, now: number, windowMinutes: number): Record<string, Attempt> => {
  const kept: Record<string, Attempt> = {}
  if (!isRecord(raw)) return kept
  const limit = now - windowMinutes * 60_000
  for (const [key, a] of Object.entries(raw)) {
    if (isRecord(a) && typeof a.model === 'string' && typeof a.count === 'number' && typeof a.at === 'number' && a.at >= limit) {
      kept[key] = { model: a.model, count: a.count, at: a.at }
    }
  }
  return kept
}

/**
 * The model for one spawn. Order: an explicit `[model: x]` tag in the prompt,
 * the caller's own `model`, the agent's first matching rule, the agent's table
 * model. A retry of the same task then steps one rung above what the previous
 * attempt ran on (never for a tag). `maxModel` caps everything.
 */
export const decide = (facts: SpawnFacts, cfg: Config, previous?: Attempt): Choice => {
  const text = `${facts.description}\n${facts.prompt}`
  const entry = entryFor(facts.agent, cfg)
  let choice: Choice = { source: 'default' }

  const tag = cfg.tags ? TAG.exec(facts.prompt) : null
  if (tag?.[1]) {
    choice = { model: tag[1].toLowerCase(), source: 'tag' }
  } else if (facts.given) {
    choice = { model: facts.given, source: 'caller' }
  } else {
    const rule = entry?.rules.find(r => regex(r.match, 'rule').test(text))
    if (rule) choice = { model: rule.model, source: 'rule', detail: rule.match }
    else if (entry?.model) choice = { model: entry.model, source: 'table' }
  }

  if (choice.source !== 'tag' && previous && cfg.escalation.enabled) {
    const up = stepUp(previous.model, cfg.ladder)
    if (up && rankOf(up, cfg.ladder) > rankOf(choice.model, cfg.ladder)) {
      choice = { model: up, source: 'escalation', detail: `attempt ${previous.count + 1}, previous ${previous.model}` }
    }
  }

  if (choice.model && cfg.maxModel) {
    const max = rankOf(cfg.maxModel, cfg.ladder)
    if (max >= 0 && rankOf(choice.model, cfg.ladder) > max) {
      choice = { ...choice, model: cfg.maxModel, detail: [choice.detail, `capped at ${cfg.maxModel}`].filter(Boolean).join(', ') }
    }
  }

  return choice
}
