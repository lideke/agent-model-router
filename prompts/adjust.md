The agent-model-router plugin has a config for this project at `.claude/agent-model-router.json`. It routes each subagent to a model, and runs a task one model higher when the same task is delegated again. Adjust that config to this project, then report. Keep it short.

## Read first

1. `.claude/agent-model-router.json`.
2. `.claude/agents/*.md`: each agent's name, `model` and description.
3. The project's `CLAUDE.md` (and any file it points to for the workflow): how work is split into tasks, how tasks are named, where outcomes (reviews, verdicts, ledgers) are recorded.
4. Two or three of those task or outcome files, to see real task names.

## Change in the config

- `agents`: one entry per agent in `.claude/agents/`, plus `Explore`. Keep each agent's frontmatter model. Do not add models that are not on `ladder`, and do not change `ladder` or `maxModel`.
- `escalation.taskKey`: a case-insensitive regular expression that matches the name of one task as this project writes it, in the project's language (`bloc\\s*\\d+|intro|outro`, `ticket\\s*#?\\d+`). The plugin uses the first match, searched in the delegation's `description`, then in its `prompt`. Leave it out when tasks have no stable names.
- `agents.<name>.rules`: add one only when the project clearly marks a kind of task as harder (an opening, a security change). Match a phrase that appears only in the request (`write the intro`), never a word that also appears in repeated context such as a list of finished tasks.
- `context`: globs of the files where outcomes are recorded.
- Regular expressions: JSON-escape backslashes. In JavaScript, `\b` only knows ASCII letters: never put `\b` next to an accented letter.

Write the file. Keep it valid JSON: the plugin reads it on every spawn, and a broken file turns routing off.

## Propose, do not apply

Retry detection works only if each delegation names its task in the `description` of the Agent call. Find the project's delegation rules in `CLAUDE.md` and propose one line to add there, in the project's language, for example:

> The `description` of each Agent call names the task and its scope, for example `Block 3 episode 2`.

Ask the user before editing `CLAUDE.md`.

## Report

Three to six lines: what changed in the config and why, the proposed `CLAUDE.md` line, and that `/model-router` shows the active config.
