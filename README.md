# agent-model-router

A Claude Code plugin that picks the model each subagent runs on, per project.

- **A table per project.** Each agent gets a model, plus optional rules that match the task text.
- **Steps up on retry.** When the same task is sent to the same agent again, the plugin runs it one model higher (`haiku` → `sonnet` → `opus`). A retry usually means the first attempt failed review.
- **Logs every choice.** Each decision goes to a local journal. The bundled `model-tuner` agent reads that journal, plus any project files you point it to, and proposes changes to the table backed by numbers.
- **A cost cap.** `maxModel` caps every choice.

The plugin never blocks an agent. With no config, or a broken one, agents run exactly as they would without it.

## Install

In a Claude Code terminal session:

```
/plugin install agent-model-router --marketplace <owner>/agent-model-router
```

Answer `y` to add the marketplace, then pick a scope. The plugin is active right away.

Requires Claude Code 2.1.293 or later (function hooks).

## Set up a project

```
/model-router init
```

This creates `.claude/agent-model-router.json` from the example. Edit the agent names to match your `.claude/agents/` (or built-in types such as `Explore`). Check what is active with:

```
/model-router
```

## Configuration

`.claude/agent-model-router.json`, read on every spawn, so edits apply immediately:

```json
{
  "ladder": ["haiku", "sonnet", "opus"],
  "maxModel": "opus",
  "agents": {
    "Explore": { "model": "haiku" },
    "writer": {
      "model": "sonnet",
      "rules": [{ "match": "\\b(intro|hook)\\b", "model": "opus" }]
    },
    "*": { "model": "sonnet" }
  },
  "escalation": { "enabled": true, "taskKey": "(?:task|step)\\s*#?\\d+", "windowMinutes": 240 },
  "journal": { "enabled": true, "path": ".claude/agent-model-router/journal.jsonl", "maxEntries": 5000 },
  "tags": true,
  "notify": true,
  "context": ["docs/reviews/*.md"]
}
```

| Field | Meaning | Default |
|---|---|---|
| `enabled` | Turns routing off without removing the file | `true` |
| `ladder` | Models from cheapest to most capable. Aliases or full ids; a full id matches the alias it contains | `["haiku", "sonnet", "opus"]` |
| `maxModel` | Highest model the plugin may choose. Must be on `ladder`. A model off the ladder (a tag such as `[model: fable]` under the default ladder) is capped too | none |
| `agents.<name>.model` | Model for that agent. Omit it to keep the agent's own frontmatter model | agent default |
| `agents.<name>.rules` | `{ match, model }` list. `match` is a case-insensitive regular expression tested on the task description and prompt; the first match wins | `[]` |
| `agents["*"]` | Entry for agents not listed | none |
| `escalation.taskKey` | Regular expression that identifies "the same task" in the description or prompt. Without it, the task description is the key | none |
| `escalation.windowMinutes` | How long a task is remembered for retry detection | `240` |
| `journal.path` | Where decisions are logged: a relative path under `.claude/`, no `..`. Any other value turns routing off, and the plugin never writes through a symbolic link that leads outside the project | `.claude/agent-model-router/journal.jsonl` |
| `tags` | Honour `[model: <name>]` written in a delegation prompt | `true` |
| `notify` | Show a toast when the plugin changes a model | `true` |
| `context` | Files or globs the `model-tuner` agent reads to learn which tasks passed or failed | `[]` |

Agent names match the spawned type exactly (`agent-model-router:model-tuner`) or by its last segment (`model-tuner`).

### Order of decision

1. A `[model: <name>]` tag in the prompt. Tags are never escalated.
2. The `model` the caller passed to the Agent tool.
3. The agent's first matching rule.
4. The agent's table model.
5. Retry: if the same task was spawned before, one rung above the model the previous attempt ran on, when that is higher.
6. `maxModel` caps the result.

If the spawn is refused on the chosen model (for example a model your account does not have), the agent runs on the model it would have used without the plugin, and a toast says so. The default ladder stops at `opus`, so escalation never picks a model you did not list.

Forks always inherit their parent's model, and workflow agents cannot be rewritten: the plugin leaves both alone.

## Tuning the table

After a batch of work, ask Claude:

> Run the model-tuner agent.

`model-tuner` reads the config, the journal, the files listed in `context` and your agents' frontmatter. It reports first-attempt success per agent and model, and proposes minimal config changes with the numbers behind them. It proposes only; you edit the config. Below about 20 journal entries it answers "not enough data".

## Privacy

The journal stores task descriptions, agent names and models, never prompts. Its folder gets a `.gitignore` containing `*` on first write, so it stays out of git unless you remove that file.

## Limits

- Retry detection is a proxy for failure. A task re-sent for another reason (new scope) also escalates. Set `taskKey` so distinct tasks get distinct keys.
- Rules match the prompt as Claude Code passes it to the subagent, which can include text added by the engine. Keep patterns specific.
- Retry history lives in the plugin's store across sessions, keyed by project root and pruned after `windowMinutes`.

## Development

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## License

MIT
