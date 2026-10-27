---
description: "Install, change or remove the preferred tools (MCP servers and plugins), one confirmed plan at a time"
argument-hint: "[tool id | hud]"
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/tmpdir.js"), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/inventory.js" *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/table.js" *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.js" *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/prereq.js" *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/hud-statusline.js" --check *)
---

Walk the user through installing, changing or removing the preferred tools. The scripts do the work and print what you
paste; you ask the questions. Argument: `$ARGUMENTS`.

## Rules

- **Nothing is applied before one confirmation** (step 7). Every earlier step reads and asks.
- **The `claude` CLI is the only writer** of `.mcp.json` and the account file; `apply.js` calls it. Never edit those
  files by hand.
- **A registration that matches no catalog row is the user's.** It is listed, never touched.
- **No secret goes into a file.** A token route registers `${VAR}`; tell the user which variable to set, never ask for its
  value, never write it.
- **Every ask is data or one of the blocks below.** Ask exactly the options printed, in the order printed; do not add or
  reword one. `AskUserQuestion` adds 'Other' itself.
- Every file below lives in one temp folder. Make it once with `node "${CLAUDE_PLUGIN_ROOT}/scripts/tmpdir.js"` and call
  its path `<tmp>`.

## 1. Inventory

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/inventory.js" --json <tmp>/inventory.json
```

It reads `.mcp.json`, the account file (user servers and this project's local ones) and `claude plugin list --json`, and
starts no server. Exit 3 with one line means the `claude` CLI is missing: say so and stop. A file named as not valid
JSON is unreadable: its scope gets no write, and you offer nothing that writes there.

## 2. The table

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/table.js" <tmp>/inventory.json
```

Paste the output verbatim in a fenced block. It is the whole catalog for this OS, numbered, with what is installed at
each scope as `name [route, pin]`.

## 3. What to do

If the argument is `hud`, go straight to 'claude-hud' below. If it is a tool id from the table, take it as the only
pick and go to step 5. Otherwise ask, leaving out 'Remove tools' when the table shows nothing installed:

```ask menu
What do you want to do?
- 'Add or change tools (Recommended)' - pick tools, then route, scope, name and location
- 'Remove tools' - only shown when something is installed
- 'Done' - nothing changes
```

'Done' ends the command. 'Remove tools' goes to step 9.

## 4. Pick

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.js" --questions <tmp>/inventory.json
```

Its `pick` is a list of calls. Ask each call as printed - one `AskUserQuestion` of up to four multi-select questions of at
most four options, grouped Code, Docs and forges, Browsers, Machine - and collect the labels picked. A label is the tool
id, then `(installed as ...)` when it is installed. Nothing picked: say so and stop.

## 5. Settings

```ask settings
How do you want to set the tools up?
- 'Use the recommended settings for all (Recommended)' - route, scope, name and location as recommended
- 'Set each tool' - ask route, scope, name and location per tool
```

'Use the recommended settings for all': every pick is `{}` in the answers file. An installed tool keeps what it has, so
this changes nothing for it; to change an installed tool, use 'Set each tool'.

'Set each tool': write `{"rows": [<picked ids>], "routes": {<id>: <route>}}` to `<tmp>/picks.json`, run
`plan.js --questions <tmp>/inventory.json <tmp>/picks.json`, and for each picked tool in order:

1. A tool whose `tools.<id>.route` is not null: ask that one question first. Record the route, write it into
   `routes` in `picks.json`, and run the command again, because the scope options depend on the route.
2. Ask `tools.<id>.questions` as one call, as printed. Map the answers into that tool's entry in `<tmp>/answers.json`
   (`{"picks": {<id>: {...}}}`):

| Answer | Entry |
|---|---|
| route 'Remote' / 'Local' | `"route": "remote"` / `"local"` |
| scope, the label's first word | `"scope": "local"` / `"project"` / `"user"` |
| name 'Keep ...' | `"name": "keep"` |
| name 'Use `x`' or Other | `"name": "x"` |
| location 'Keep ...' | `"location": {"side": "keep"}` (installed) or `{"side": "default"}` |
| location 'Use `x`' | `{"side": "project"}` or `{"side": "account"}`, as its description says |
| location Other, or 'Another folder' | `{"side": "path", "path": "<typed>"}` |
| browser 'A browser binary I name' | `"executablePath": "<typed>"` |
| API key 'Use `${VAR}`' | `"token": true` (the reference only) |
| host Other | `"params": {"host": "<typed>"}` |

A plugin picked at a scope other than where it is installed is a move: add `"moveFrom": [<the installed scopes>]`.
Skip a key the user left at its default; the plan reads a missing key as the recommendation.

## 6. Prerequisites

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/prereq.js" <tmp>/answers.json --audit
node "${CLAUDE_PLUGIN_ROOT}/scripts/prereq.js" <tmp>/answers.json --json
```

Paste the first output verbatim. It checks `uvx`, `npx`, Node 22.22.2 or newer, Docker or the github binary,
`typescript-language-server` with TypeScript 6, `csharp-ls`, the Android SDK and a JDK, only for the picks that need them,
and runs `npm audit` on appium's package. The audit lines go into step 7's confirmation as they are; an 'audit not run'
line is not a pass.

From the second (JSON) output, copy `machine` into `<tmp>/answers.json` under `"machine"`; it is how the plan knows
whether Docker is there. For each tool with a missing prerequisite, ask once (up to four tools per call):

```ask prereqMissing
<tool> needs <prerequisite>, which is missing. What now?
- 'Skip this tool (Recommended)' - leave it out of the plan
- 'Install it now' - run the install line shown, or install it yourself and re-check
- 'Register anyway' - register it; it will not start until the prerequisite is there
```

'Skip': delete the tool from `answers.json`. 'Install it now': when the output gave an `install:` command, run it; when
it gave only a page, give the user that page, wait for them to say it is done, and run `prereq.js` again. 'Register
anyway': keep it, and say in the confirmation that it will not start yet.

## 7. Plan, then one confirmation

When claude-hud is picked and is not installed, set `"hud": "defer"` in the answers: its settings are asked after the
install (see 'claude-hud'). When it is already installed, do 'claude-hud' now and set `"hud"` from its answer.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.js" <tmp>/inventory.json <tmp>/answers.json --out <tmp>/plan.json
```

Paste the output verbatim in a fenced block: every CLI call, every file it writes, the environment variables the user
must set for a token route, the sign-in a remote route will ask for, and the tools that can run code. Exit 1 means the
plan has errors; show them and go back to the ask that causes them, never around them. Add the audit and 'register
anyway' lines from step 6. Then:

```ask apply
Apply this plan?
- 'Apply (Recommended)' - runs the calls above in order, stops at the first failure
- 'Change something' - go back to the answers
- 'Cancel' - nothing is applied
```

An empty plan says 'Nothing to apply'; show that and stop without asking.

## 8. Apply

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/apply.js" <tmp>/plan.json --tmp <tmp>
```

Claude Code asks permission for this call itself - `apply.js` is deliberately not in `allowed-tools` - so a skipped ask
still cannot change anything. It runs the calls in order, reads each back from the file the CLI wrote, and stops at the first failure, leaving what
was applied in place and naming it. Paste the output verbatim. A failure prints the line that puts a registration back
(`RESTORE BY HAND`): give it to the user as written.

Then report each picked tool as the read-back printed it (name, scope, route). End with the restart line: the new
registrations load on the next session start, and a project-scope server also needs the trust prompt then. If the plan
set `hudAfter`, continue with 'claude-hud'. Tokens: list the variable names to set, nothing else.

## 9. Remove

```ask removeFirst
Remove what?
- 'Pick which (Recommended)' - choose the registrations and plugins to remove
- 'Cancel' - nothing is removed
```

'Pick which': run `plan.js --questions <tmp>/inventory.json` and ask its `remove` calls as printed (one option per
registration; a tool at two scopes is two options). Each option's description is the exact command, from which you read
the target: `claude mcp remove <name> -s <scope>` is `{"kind": "mcp", "name": ..., "scope": ...}`, and
`claude plugin uninstall <id> --scope <scope>` is `{"kind": "plugin", "id": ..., "scope": ...}`. Put them in
`answers.json` under `"remove"` and go to step 7. Data folders stay where they are; the plan names them.

## claude-hud

The status line and its recommended settings. Applies whenever claude-hud is picked, or already installed and kept; the
argument `hud` comes straight here for an installed claude-hud (not installed: say so and offer step 4).

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/hud-statusline.js" --check --catalog "${CLAUDE_PLUGIN_ROOT}/catalog/plugin-settings.json" --project .
```

Paste its output verbatim. It shows the statusLine's state and the row as it lands after the statusLine write - the
refresh interval included, and none beside a statusLine that is not claude-hud's. Its last line is
`hud-check: statusLine=<state> missing=<n> differs=<m> match=<k>`. The statusLine itself is never behind the ask: it is
written whenever claude-hud is installed or kept, add-only. Ask once, with the counts:

```ask hud
Apply the recommended claude-hud settings? <n> missing, <m> differing, <k> matching.
- 'Apply recommended (Recommended)' - adds only the missing keys; every value already chosen is kept
- 'Apply and replace differing' - adds the missing keys and overwrites the differing ones
- 'Skip' - nothing changes
```

The answer is applied after the plugin install, by the same script (`--catalog` and `--project .` as above):

- 'Apply recommended': `hud-statusline.js`
- 'Apply and replace differing': `hud-statusline.js --replace`
- 'Skip': `hud-statusline.js --statusline-only` - claude-hud still shows on screen, no catalog key is written

Before the install (claude-hud already installed) the answer goes into `answers.json` as `"hud": "recommended"`,
`"replace"` or `"skip"`, and `apply.js` runs it. After a deferred install, run the script yourself with the matching
flag and paste its output. The account's `settings.json` is copied to `settings.json.bak.<date>` before the first write;
name that file. On Windows the output carries a note about the refresh interval; pass it on.
