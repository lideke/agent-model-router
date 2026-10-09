# agent-model-router

A Claude Code plugin that picks the model each subagent runs on, per project.

- **A table per project.** Each agent gets a model, plus optional rules that match the task text.
- **Steps up on retry.** When the same task is sent to the same agent again, the plugin runs it one model higher (`haiku` → `sonnet` → `opus`). A retry usually means the first attempt failed review.
- **Logs every choice.** Each decision goes to a local journal. The bundled `model-tuner` agent reads that journal, plus any project files you point it to, and proposes changes to the table backed by numbers.
- **A cost cap.** `maxModel` caps every choice.

The plugin never blocks an agent. With no config, or a broken one, agents run exactly as they would without it.

## Who it is for

The plugin acts only when Claude delegates work to a **subagent** (the Agent tool). It does nothing to the main conversation's model.

It pays off in projects that define their own agents in `.claude/agents/` and delegate repeated tasks to them: a writer, a reviewer, a researcher. There the table, the retry escalation and the tuning have something to work on.

| Your project | What the plugin does |
|---|---|
| Agents in `.claude/agents/`, delegated to often | Everything this README describes |
| No agents of its own | Routes only the built-in agents Claude spawns by itself (`Explore` on `haiku` by default). Little to gain |
| No delegation at all | Nothing. Its only cost is the `model-tuner` agent's description, about 80 tokens per session. Leave it uninstalled |

## Install

In a Claude Code terminal session:

```
/plugin marketplace add lideke/agent-model-router
/plugin install agent-model-router@agent-model-router
```

Pick a scope when asked. The plugin is active right away.

From a shell, the same steps are `claude plugin marketplace add lideke/agent-model-router` and `claude plugin install agent-model-router@agent-model-router`.

Requires Claude Code 2.1.293 or later (function hooks).

## Set up a project

```
/model-router
```

One command, run as often as you like. The first time, it does two things, with nothing to edit by hand:

1. **Writes `.claude/agent-model-router.json`** from your project: one entry per agent in `.claude/agents/`, on the model its frontmatter names, plus `Explore` on `haiku`. An agent whose model is not on the ladder (`fable`, `inherit`) keeps its own model: the table never moves it. Routing is on from here, with a working config.
2. **Asks Claude to fit it to the project**, in a turn of its own right after the command. Claude reads your agents and `CLAUDE.md`, then sets `escalation.taskKey` to the way your tasks are named (in their language: `bloc 3`, `ticket 42`), adds rules only where the project marks a kind of task as harder, and points `context` at the files where outcomes are recorded. It then proposes one line for your `CLAUDE.md` so that each delegation names its task (see [How a retry is recognized](#how-a-retry-is-recognized)), and asks before writing it. This step is skipped when the project has no agents of its own (see [Who it is for](#who-it-is-for)).

Each later run shows the active config, then fits it again to the project as it is now (a new agent, a renamed task). It never overwrites the config: Claude edits it, with your permission.

| Command | What it does |
|---|---|
| `/model-router` | Creates the config if there is none, shows it, then has Claude fit it to the project |
| `/model-router status` | Only shows the config, the retry history and the last decisions. No model turn |

Claude Code asks your permission before Claude edits a file under `.claude/`; accept it to let the fitting apply. In a headless `claude -p` run nobody can accept, so Claude only reports the changes it proposes: run `/model-router` later in an interactive session.

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

## How a retry is recognized

You do not write delegations; Claude does. When the main session hands work to a subagent, it calls the Agent tool with two texts:

- `description`: a title of a few words, such as `Block 3 episode 2`;
- `prompt`: the full instructions, which often repeat context such as the list of tasks already done.

The plugin computes a task key for each spawn:

1. With `escalation.taskKey`, the key is the **first** match of that pattern, searched in the `description` first, then in the `prompt`.
2. With no match, or no `taskKey`, the key is the whole `description`.

The key is prefixed with the agent name. Two spawns with the same key, inside `windowMinutes`, count as a retry: the second runs one model higher.

The key is only as good as the `description`. With `"taskKey": "block\\s*\\d+"`:

| Delegation | Key | Result |
|---|---|---|
| description `Block 3 episode 2` | `writer\|block 3` | Correct |
| description `Write narration`, prompt `Done so far: Block 1, Block 2. Now write Block 3.` | `writer\|block 1` | Wrong: the first match in the prompt is a finished task. A later spawn about block 1 escalates for no reason |
| description `Write narration`, no match in the prompt | `writer\|write narration` | Every writer spawn looks like the same task, so all but the first escalate |

So tell Claude to put the task name in the `description`. Add a line such as this one to your project's `CLAUDE.md`, next to its delegation rules:

> The `description` of each Agent call names the task and its scope, for example `Block 3 episode 2`.

Things to watch:

- **Same names in two scopes.** `Block 3` of episode 1 and `Block 3` of episode 2 share a key. Working on both within `windowMinutes` makes the second one escalate. Shorten the window, or put the scope in the pattern (`episode\\s*\\d+\\s*block\\s*\\d+`) and in the descriptions.
- **Rules read the prompt too.** A rule matches the description and the prompt together, so a word that appears in the repeated context (`intro` in a list of finished blocks) triggers it on every spawn. Match a phrase that only appears in the request itself (`write the intro`).
- **Accented words.** In JavaScript regular expressions, `\b` only knows ASCII letters: `\bécris` never matches. Leave out `\b` before or after an accented letter.
- **Check the keys.** Each journal line has a `task` field. After a few delegations, read `.claude/agent-model-router/journal.jsonl` and check that each task got its own key.

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
