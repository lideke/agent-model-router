import type { AgentSpawnInput, On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import { decide, parseConfig, rankOf, readAgentFile, taskKeyOf } from './route.ts'

const ROOT = '/proj'
const CONFIG = `${ROOT}/.claude/agent-model-router.json`
const JOURNAL = `${ROOT}/.claude/agent-model-router/journal.jsonl`

const BASE = {
  ladder: ['haiku', 'sonnet', 'opus'],
  agents: {
    writer: { model: 'sonnet', rules: [{ match: '\\bintro\\b', model: 'opus' }] },
    reviewer: { model: 'haiku' },
  },
  escalation: { taskKey: 'block\\s*\\d+' },
}

// The world beneath the plugin: a file system in memory, a project root, a
// store, a clock, and an Agent tool that resolves aliases the way the engine does.
type Options = { unavailable?: string; store?: Record<string, unknown> }

const world = (on: On, config?: object | string, options: Options = {}) => {
  const files = new Map<string, string>()
  // Symbolic links by path, to where they lead; a dangling one leads nowhere.
  const links = new Map<string, string>()
  const dangling = new Set<string>()
  const real = (path: string): string => {
    for (const [link, target] of links) {
      if (path === link || path.startsWith(`${link}/`)) return target + path.slice(link.length)
    }
    return path
  }
  const names = (): string[] => [ROOT, ...files.keys(), ...links.keys(), ...dangling]
  const isThere = (path: string): boolean =>
    links.has(path) || names().some(n => n === path || n.startsWith(`${path}/`))
  if (config !== undefined) files.set(CONFIG, typeof config === 'string' ? config : JSON.stringify(config))
  const toasts: string[] = []
  const prompts: string[] = []
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  const spawned: (string | undefined)[] = []
  on('session.root', () => ({ value: ROOT }))
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.read', ($, e) => {
    if (e.path.endsWith('/prompts/adjust.md')) return { value: 'ADJUST THE CONFIG' }
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.stat', ($, e) => {
    if (dangling.has(e.path) || !isThere(e.path)) throw new Error(`ENOENT ${e.path}`)
    const kind = files.has(e.path) ? 'file' as const : 'dir' as const
    return { value: { kind, size: 0, mtimeMs: 0, isLink: links.has(e.path), realPath: real(e.path) } }
  })
  on('fs.list', ($, e) => {
    const children = new Set(names().filter(n => n.startsWith(`${e.path}/`)).map(n => n.slice(e.path.length + 1).split('/')[0] ?? ''))
    return { value: [...children].map(name => ({ name, kind: 'other' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const logs: string[] = []
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('agent.spawn', ($, e) => {
    // A model the account cannot use: the spawn is refused.
    if (options.unavailable && e.model?.includes(options.unavailable)) return { deny: `model ${e.model} is not available` }
    spawned.push(e.model)
    const model = e.model === undefined ? 'claude-sonnet-5-5' : /^[a-z]+$/.test(e.model) ? `claude-${e.model}-5-5` : e.model
    return { model, agentId: `agent-${spawned.length}` }
  })
  mock.store(on, options.store)
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 9) })
  return { files, links, dangling, toasts, spawned, prompts, clock, logs }
}

// What the Agent tool fills in before `agent.spawn` is raised.
const call = (args: Pick<AgentSpawnInput, 'subagentType' | 'prompt' | 'description'>): AgentSpawnInput => ({
  tool_use_id: 'toolu_test',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: false,
  fork: false,
  ...args,
})

describe('routing', () => {
  test('without a config the agent keeps its own model', async ($, on) => {
    const w = world(on)
    const r = await $.agent.spawn(call({ subagentType: 'writer', prompt: 'Write block 1', description: 'block 1' }))
    expect(w.spawned).toEqual([undefined])
    expect(r.model).toBe('claude-sonnet-5-5')
    expect(w.files.has(JOURNAL)).toBe(false)
  })

  test('the table model applies', async ($, on) => {
    const w = world(on, BASE)
    await $.agent.spawn(call({ subagentType: 'reviewer', prompt: 'Review block 2', description: 'review' }))
    expect(w.spawned).toEqual(['haiku'])
  })

  test('a matching rule beats the table model', async ($, on) => {
    const w = world(on, BASE)
    await $.agent.spawn(call({ subagentType: 'writer', prompt: 'Write the intro', description: 'intro' }))
    expect(w.spawned).toEqual(['opus'])
    expect(w.toasts[0]).toContain('writer → opus')
  })

  test('a retry of the same task steps one rung up', async ($, on) => {
    const w = world(on, BASE)
    await $.agent.spawn(call({ subagentType: 'writer', prompt: 'Write block 3', description: 'first draft' }))
    await $.agent.spawn(call({ subagentType: 'writer', prompt: 'Rewrite Block 3, the review failed', description: 'second draft' }))
    await $.agent.spawn(call({ subagentType: 'writer', prompt: 'Write block 4', description: 'new task' }))
    expect(w.spawned).toEqual(['sonnet', 'opus', 'sonnet'])
  })

  test('a tag wins and is never escalated', async ($, on) => {
    const w = world(on, BASE)
    await $.agent.spawn(call({ subagentType: 'writer', prompt: 'Write block 5 [model: haiku]', description: 'x' }))
    await $.agent.spawn(call({ subagentType: 'writer', prompt: 'Write block 5 again [model: haiku]', description: 'y' }))
    expect(w.spawned).toEqual(['haiku', 'haiku'])
  })

  test('maxModel caps every choice', async ($, on) => {
    const w = world(on, { ...BASE, maxModel: 'sonnet' })
    await $.agent.spawn(call({ subagentType: 'writer', prompt: 'Write the intro', description: 'intro' }))
    expect(w.spawned).toEqual(['sonnet'])
  })

  test('the tuner is never routed', async ($, on) => {
    const w = world(on, { ...BASE, agents: { '*': { model: 'haiku' } } })
    await $.agent.spawn(call({ subagentType: 'agent-model-router:model-tuner', prompt: 'Tune', description: 'tune' }))
    expect(w.spawned).toEqual([undefined])
  })

  test('a broken config turns routing off and says why once', async ($, on) => {
    const w = world(on, '{ not json')
    await $.agent.spawn(call({ subagentType: 'writer', prompt: 'a', description: 'a' }))
    await $.agent.spawn(call({ subagentType: 'writer', prompt: 'b', description: 'b' }))
    expect(w.spawned).toEqual([undefined, undefined])
    expect(w.toasts.length).toBe(1)
    expect(w.toasts[0]).toContain('is off')
  })

  test('each decision is journaled, and the journal folder ignores itself', async ($, on) => {
    const w = world(on, BASE)
    await $.agent.spawn(call({ subagentType: 'writer', prompt: 'Write block 6', description: 'block 6' }))
    const lines = (w.files.get(JOURNAL) ?? '').trim().split('\n')
    expect(lines.length).toBe(1)
    const entry = JSON.parse(lines[0] ?? '{}')
    expect(entry.agent).toBe('writer')
    expect(entry.source).toBe('table')
    expect(entry.resolved).toBe('claude-sonnet-5-5')
    expect(entry.prompt).toBeUndefined()
    expect(w.files.get(`${ROOT}/.claude/agent-model-router/.gitignore`)).toBe('*\n')
  })
})

describe('models the user may not have', () => {
  test('escalation stops at the top of the ladder, never past it', async ($, on) => {
    const w = world(on, BASE)
    for (const n of [1, 2, 3]) await $.agent.spawn(call({ subagentType: 'writer', prompt: `Write block 11, try ${n}`, description: 'b' }))
    expect(w.spawned).toEqual(['sonnet', 'opus', 'opus'])
  })

  test('maxModel also caps a model that is not on the ladder', async ($, on) => {
    const w = world(on, { ...BASE, maxModel: 'opus', agents: { writer: { model: 'claude-fable-5-1' } } })
    await $.agent.spawn(call({ subagentType: 'writer', prompt: 'Write block 12 [model: fable]', description: 'a' }))
    await $.agent.spawn(call({ subagentType: 'writer', prompt: 'Write block 13', description: 'b' }))
    expect(w.spawned).toEqual(['opus', 'opus'])
  })

  test('without maxModel an explicit model off the ladder is kept', () => {
    const cfg = parseConfig(JSON.stringify(BASE))
    expect(decide({ agent: 'writer', prompt: '[model: fable]', description: 'd' }, cfg).model).toBe('fable')
  })

  test('a maxModel that is not on the ladder is a config error', () => {
    expect(() => parseConfig(JSON.stringify({ ...BASE, maxModel: 'fable' }))).toThrow('maxModel')
    expect(parseConfig(JSON.stringify({ ...BASE, maxModel: 'claude-opus-5-5' })).maxModel).toBe('claude-opus-5-5')
  })

  test('a model the account cannot use falls back to the agent own model', async ($, on) => {
    const w = world(on, { ...BASE, ladder: ['haiku', 'sonnet', 'opus', 'fable'], agents: { writer: { model: 'fable' } } }, { unavailable: 'fable' })
    const r = await $.agent.spawn(call({ subagentType: 'writer', prompt: 'Write block 14', description: 'b' }))
    expect(w.spawned).toEqual([undefined])
    expect(r.model).toBe('claude-sonnet-5-5')
  })
})

describe('retry history', () => {
  test('a task from another project is not a retry', async ($, on) => {
    const attempts = { 'writer|block 15': { model: 'claude-sonnet-5-5', count: 1, at: Date.UTC(2026, 9, 9) } }
    const w = world(on, BASE, { store: { attempts } })
    await $.agent.spawn(call({ subagentType: 'writer', prompt: 'Write block 15', description: 'b' }))
    expect(w.spawned).toEqual(['sonnet'])
  })

  test('parallel spawns of different tasks are all remembered', async ($, on) => {
    const w = world(on, BASE)
    await Promise.all([16, 17, 18].map(n => $.agent.spawn(call({ subagentType: 'writer', prompt: `Write block ${n}`, description: 'b' }))))
    for (const n of [16, 17, 18]) await $.agent.spawn(call({ subagentType: 'writer', prompt: `Redo block ${n}`, description: 'b' }))
    expect(w.spawned).toEqual(['sonnet', 'sonnet', 'sonnet', 'opus', 'opus', 'opus'])
  })
})

describe('/model-router init', () => {
  // The prompt is submitted from a timer, once the command has answered.
  const settle = async (w: ReturnType<typeof world>) => {
    await w.clock.advance(1)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const agent = (name: string, model?: string): string =>
    `---\nname: ${name}\ndescription: x\n${model ? `model: ${model}\n` : ''}---\n\nBody.\n`

  test('builds the table from the project agents, then hands the fitting to Claude', async ($, on) => {
    const w = world(on)
    w.files.set(`${ROOT}/.claude/agents/writer.md`, agent('writer', 'sonnet'))
    w.files.set(`${ROOT}/.claude/agents/director.md`, agent('director', 'claude-opus-5-5'))
    w.files.set(`${ROOT}/.claude/agents/notes.txt`, 'not an agent')
    const r = await $.command.run({ command: 'model-router', args: 'init' })
    const cfg = parseConfig(w.files.get(CONFIG) ?? '')
    expect(Object.keys(cfg.agents)).toEqual(['Explore', 'director', 'writer'])
    expect(cfg.agents.writer?.model).toBe('sonnet')
    expect(cfg.agents.director?.model).toBe('claude-opus-5-5')
    expect(cfg.escalation.taskKey).toBeUndefined()
    expect(r.text).toContain('Explore, director, writer')
    await settle(w)
    expect(w.prompts).toEqual(['ADJUST THE CONFIG'])
    expect(w.logs).toEqual([])
  })

  test('an agent on a model off the ladder keeps it, uncapped', async ($, on) => {
    const w = world(on)
    w.files.set(`${ROOT}/.claude/agents/poet.md`, agent('poet', 'fable'))
    w.files.set(`${ROOT}/.claude/agents/helper.md`, agent('helper', 'inherit'))
    await $.command.run({ command: 'model-router', args: 'init' })
    const cfg = parseConfig(w.files.get(CONFIG) ?? '')
    expect(cfg.agents.poet).toEqual({ model: undefined, rules: [] })
    expect(cfg.agents.helper).toEqual({ model: undefined, rules: [] })
    await $.agent.spawn(call({ subagentType: 'poet', prompt: 'Write a poem', description: 'poem' }))
    expect(w.spawned).toEqual([undefined])
  })

  test('without agents the config still works, and says the plugin has little to do', async ($, on) => {
    const w = world(on)
    const r = await $.command.run({ command: 'model-router', args: 'init' })
    expect(Object.keys(parseConfig(w.files.get(CONFIG) ?? '').agents)).toEqual(['Explore'])
    expect(r.text).toContain('no agents in .claude/agents/')
    await settle(w)
    expect(w.prompts).toEqual([])
  })

  test('with a config, /model-router shows it and fits it again', async ($, on) => {
    const w = world(on, BASE)
    w.files.set(`${ROOT}/.claude/agents/writer.md`, agent('writer', 'sonnet'))
    const before = w.files.get(CONFIG)
    const r = await $.command.run({ command: 'model-router', args: '' })
    expect(r.text).toContain('Routing: on')
    expect(r.text).toContain('Claude now fits')
    expect(w.files.get(CONFIG)).toBe(before)
    await settle(w)
    expect(w.prompts).toEqual(['ADJUST THE CONFIG'])
  })

  test('without a config, /model-router creates it, then fits it', async ($, on) => {
    const w = world(on)
    w.files.set(`${ROOT}/.claude/agents/writer.md`, agent('writer', 'sonnet'))
    const r = await $.command.run({ command: 'model-router', args: '' })
    expect(r.text).toContain('Created')
    expect(parseConfig(w.files.get(CONFIG) ?? '').agents.writer?.model).toBe('sonnet')
    await settle(w)
    expect(w.prompts).toEqual(['ADJUST THE CONFIG'])
  })

  test('status only shows, and init never overwrites', async ($, on) => {
    const w = world(on, BASE)
    w.files.set(`${ROOT}/.claude/agents/writer.md`, agent('writer', 'sonnet'))
    const before = w.files.get(CONFIG)
    const shown = await $.command.run({ command: 'model-router', args: 'status' })
    expect(shown.text).toContain('Routing: on')
    const again = await $.command.run({ command: 'model-router', args: 'init' })
    expect(again.text).toContain('already exists')
    expect(w.files.get(CONFIG)).toBe(before)
    await settle(w)
    expect(w.prompts).toEqual([])
  })

  test('with a config but no agents there is nothing to fit', async ($, on) => {
    const w = world(on, BASE)
    const r = await $.command.run({ command: 'model-router', args: '' })
    expect(r.text).toContain('nothing to fit')
    await settle(w)
    expect(w.prompts).toEqual([])
  })

  test('frontmatter is read, quotes and all, with the file name as fallback', () => {
    expect(readAgentFile('---\nname: "writer"\nmodel: \'opus\'\n---\nx', 'w.md')).toEqual({ name: 'writer', model: 'opus' })
    expect(readAgentFile('no frontmatter', 'editor.md')).toEqual({ name: 'editor', model: undefined })
  })
})

describe('the journal stays inside the project', () => {
  test('a config cannot point the journal outside .claude/', () => {
    for (const path of ['/etc/passwd', '../outside.jsonl', '.claude/../x.jsonl', 'logs/j.jsonl', 'C:/x.jsonl', '.claude']) {
      expect(() => parseConfig(JSON.stringify({ journal: { path } }))).toThrow('journal.path')
    }
    expect(parseConfig(JSON.stringify({ journal: { path: '.claude/logs/j.jsonl' } })).journal.path).toBe('.claude/logs/j.jsonl')
  })

  test('an unsafe journal path turns routing off', async ($, on) => {
    const w = world(on, { ...BASE, journal: { path: '../../home/me/.bashrc' } })
    await $.agent.spawn(call({ subagentType: 'writer', prompt: 'Write block 8', description: 'b' }))
    expect(w.spawned).toEqual([undefined])
    expect(w.toasts[0]).toContain('journal.path')
  })

  test('a symlinked journal folder is not written through', async ($, on) => {
    const w = world(on, BASE)
    w.links.set(`${ROOT}/.claude/agent-model-router`, '/home/me')
    await $.agent.spawn(call({ subagentType: 'writer', prompt: 'Write block 9', description: 'b' }))
    expect(w.spawned).toEqual(['sonnet'])
    expect([...w.files.keys()].filter(k => k !== CONFIG)).toEqual([])
  })

  test('a dangling link where the journal goes is refused', async ($, on) => {
    const w = world(on, BASE)
    w.dangling.add(JOURNAL)
    await $.agent.spawn(call({ subagentType: 'writer', prompt: 'Write block 10', description: 'b' }))
    expect(w.files.has(JOURNAL)).toBe(false)
  })
})

describe('pure rules', () => {
  test('full model ids land on their rung', () => {
    const ladder = ['haiku', 'sonnet', 'opus']
    expect(rankOf('claude-opus-5-5', ladder)).toBe(2)
    expect(rankOf('sonnet', ladder)).toBe(1)
    expect(rankOf('gpt-x', ladder)).toBe(-1)
  })

  test('the task key falls back to the description', () => {
    const cfg = parseConfig(JSON.stringify(BASE))
    expect(taskKeyOf({ agent: 'w', prompt: 'nothing', description: 'Fix  Login' }, cfg)).toBe('w|fix login')
    expect(taskKeyOf({ agent: 'w', prompt: 'redo BLOCK 7', description: 'x' }, cfg)).toBe('w|block 7')
  })

  test('the caller model is kept unless a retry needs more', () => {
    const cfg = parseConfig(JSON.stringify(BASE))
    const facts = { agent: 'writer', prompt: 'p', description: 'd', given: 'opus' }
    expect(decide(facts, cfg).model).toBe('opus')
    expect(decide({ ...facts, given: 'haiku' }, cfg, { model: 'claude-haiku-5-5', count: 1, at: 0 }).model).toBe('sonnet')
  })

  test('a bad rule is reported with its place', () => {
    expect(() => parseConfig('{"agents":{"w":{"rules":[{"match":"(","model":"opus"}]}}}')).toThrow('agents.w.rules[0].match')
  })
})
