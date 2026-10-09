# Changelog

## 0.5.0

- Patterns (`rules[].match`, `escalation.taskKey`) are capped at 300 characters, and a pattern that repeats a group which itself repeats or has alternatives (`(a+)+`, `(a|b)*`) is refused: it could stall every spawn on a long prompt. Patterns see at most the first 20,000 characters.
- The journal keeps 1000 lines by default instead of 5000, since it is rewritten whole on each spawn. Existing configs keep their own `maxEntries`.
- A config that resolves outside the project, through a symbolic link, turns routing off instead of being read.
- The unused example config is removed.
- Continuous integration runs `claude plugin validate` and `claude plugin test` on every push.

## 0.4.2

- Each check for a symbolic link now runs right before the write it guards. A short window remains, since the plugin API has no write that refuses to follow links.

## 0.4.1

- Security: `/model-router fable on|off` no longer writes through a config that is a symbolic link to a file outside the project.

## 0.4.0

- `/model-router fable on|off` puts `fable` on top of the ladder and makes it the cap, after checking that the account can use it, or takes it off.
- Clearer README section on how a retry is recognized.

## 0.3.0

- `/model-router` with no argument creates the config if needed, shows it, then has Claude fit it to the project. `/model-router status` only shows it. The fitting keeps entries the user tuned.

## 0.2.0

- `/model-router init` builds the table from `.claude/agents/` instead of copying an example, then hands Claude the fitting of task names, rules and context. `/model-router adjust` reruns it.
- An agent on a model off the ladder (`fable`, `inherit`) keeps its own model.
- A project with no agents gets a working config and is told the plugin has little to do there.
- README: who the plugin is for, and how a retry is recognized.

## 0.1.0

- First release: per-project model table with rules, one-rung escalation on retry, `maxModel` cap, `[model: x]` tags, decision journal, the `model-tuner` agent and the `/model-router` command.
- `maxModel` also caps a model that is not on the ladder; a spawn refused on the routed model reruns on the agent's own model.
- Retry history is kept per project, and parallel spawns no longer lose each other's tasks.
- The journal never leaves the project, even through a symbolic link.
