import type { AgentSpawnInput, On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import { decide, parseConfig, rankOf, taskKeyOf } from './route.ts'

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
const world = (on: On, config?: object | string) => {
  const files = new Map<string, string>()
  if (config !== undefined) files.set(CONFIG, typeof config === 'string' ? config : JSON.stringify(config))
  const toasts: string[] = []
  const spawned: (string | undefined)[] = []
  on('session.root', () => ({ value: ROOT }))
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('agent.spawn', ($, e) => {
    spawned.push(e.model)
    const model = e.model === undefined ? 'claude-sonnet-5-5' : /^[a-z]+$/.test(e.model) ? `claude-${e.model}-5-5` : e.model
    return { model, agentId: `agent-${spawned.length}` }
  })
  mock.store(on)
  mock.clock(on, { now: Date.UTC(2026, 9, 9) })
  return { files, toasts, spawned }
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
