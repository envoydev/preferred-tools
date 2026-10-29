---
description: "Change or remove installed preferred tools - an MCP server's route, scope, name or data folder, a plugin's scope, claude-hud's settings - one confirmed plan"
argument-hint: "[registration name | tool id | hud]"
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/tmpdir.js"), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/inventory.js" *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/table.js" *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.js" *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/prereq.js" *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/hud-statusline.js" --check *)
---

Walk the user through changing or removing preferred tools that are already installed here. The scripts do the work and
print what you paste; you ask the questions. Argument: `$ARGUMENTS`.

Configure starts from what is installed: every question recommends what the tool has now, so keeping an answer changes
nothing. A change is built from the registration as read - its pin, its cut-off, the args and env the user added - so an
updated pin is never downgraded. Adding a tool that is not installed is `/preferred-tools:install`.

## Rules

- **Nothing is applied before one confirmation** (step 7). Every earlier step reads and asks.
- **The `claude` CLI is the only writer** of `.mcp.json` and the account file; `apply.js` calls it. Never edit those
  files by hand.
- **A registration that matches no catalog row is the user's.** It is listed, never offered, never touched.
- **A server inherited from a parent folder's `.mcp.json` is that folder's.** It is noted under the table, never
  offered; to change it, run `/preferred-tools:configure` in that folder.
- **A key comes from its key file, never from the chat.** At `project` scope a token route registers `${VAR}` (the
  committed `.mcp.json`); at `local` and `user` scope the apply writes the key into the registration from the key file
  the plan names - alfred-code's store when alfred-code is set up in this project, else `.preferred-tools/.secrets`,
  then `~/.preferred-tools/.secrets` (for `user`, the home file first). Never ask for a key, and never read, print or
  edit a key file: name it, and the user fills it by hand.
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

## 3. What to change

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.js" --questions <tmp>/inventory.json
```

Its `change.keys` maps each installed registration and plugin to its key: `mcp:<name>~<scope>` or
`plugin:<id>~<scope>`. When it is empty, say nothing from the catalog is installed here, point to
`/preferred-tools:install`, and stop.

The argument, when given:

- `hud` - go straight to 'claude-hud' (claude-hud not installed: say so and point to `/preferred-tools:install`).
- a registration name, or a tool id - the keys whose label starts with that name or names that tool. Exactly one: it is
  the only pick, go to step 5. Several: say where it is installed and ask step 4 as printed. None: say it is not
  installed and point to `/preferred-tools:install <id>`.

Otherwise ask, leaving out 'claude-hud settings' when the table shows claude-hud not installed:

```ask menu
What do you want to change?
- 'Change tools (Recommended)' - pick installed tools, then route, scope, name and location
- 'Remove tools' - choose the registrations and plugins to remove
- 'claude-hud settings' - the status line and its recommended settings - only shown when claude-hud is installed
- 'Done' - nothing changes
```

'Done' ends the command. 'Remove tools' goes to step 9. 'claude-hud settings' goes to 'claude-hud'.

## 4. Pick

Ask each `change.calls` call as printed - one `AskUserQuestion` of up to four multi-select questions, one option per
registration or plugin (a tool at two scopes is two options; your own servers are not there). Turn each picked label into
its key through `change.keys`. 'None of these', or nothing picked: say so and stop.

## 5. Each pick

Write `{"targets": [<picked keys>], "routes": {}}` to `<tmp>/picks.json` and run
`plan.js --questions <tmp>/inventory.json <tmp>/picks.json`. Its `targets.<key>` holds the tool's `row`, what it has
now (`current`: name, scope, route) and the questions, each with what it has now first and recommended. For each key in
order:

1. A target whose `route` is not null: ask that one question first. Record the answer under `routes.<key>` in
   `picks.json` and run the command again, because the scope options depend on the route.
2. Ask `targets.<key>.questions` as one call, as printed. Write the answers into `<tmp>/answers.json` as
   `{"change": {<key>: {"row": <targets.<key>.row>, ...}}}`, mapped as below, and leave out every answer that keeps what
   the tool has now - the plan reads a missing key as 'keep':

| Answer | Entry |
|---|---|
| route 'Hosted' / 'Local', when it is not `current.route` | `"route": "remote"` / `"local"` |
| scope, the label's first word, when it is not `current.scope` | `"scope": "local"` / `"project"` / `"user"` |
| name 'Keep ...' | nothing |
| name 'Use `x`' or Other | `"name": "x"` |
| location 'Keep ...' | nothing |
| location 'Use `x`' | `{"side": "project"}` or `{"side": "account"}`, as its description says |
| location Other, or 'Another folder' | `{"side": "path", "path": "<typed>"}` |
| browser 'A browser binary I name', or Other | `"executablePath": "<typed>"` |
| browser 'Default for this engine', when it is not first | `"executablePath": ""` (drops `--executable-path`) |
| API key 'Use `${VAR}`' / 'No key', when it is not first | `"token": true` / `"token": false` |
| host Other, or the hosted host when it is not first | `"params": {"host": "<that host>"}` |

A scope change on an MCP server is a move too: the registration picked leaves its old scope, so a copy for every project
moved to `local` is gone from the other projects. To keep it there and add this project's own copy, use
`/preferred-tools:install` instead; say so when the user picks another scope for a user-scope registration.

A plugin has one question, its scope; another scope is a move - the plan installs it there and uninstalls the copy you
picked once the new one reads back. When claude-hud is picked, run 'claude-hud' now and set `"hud"` in the answers from
its answer.

## 6. Prerequisites

Only when an entry in `answers.json` has a `route` (a route change):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/prereq.js" <tmp>/answers.json --audit
node "${CLAUDE_PLUGIN_ROOT}/scripts/prereq.js" <tmp>/answers.json --json
```

Paste the first output verbatim; its audit lines go into step 7's confirmation as they are, and an 'audit not run' line
is not a pass. From the second (JSON) output, copy `machine` into `<tmp>/answers.json` under `"machine"`. For each change
with a missing prerequisite, ask once (up to four per call):

```ask prereqMissing
<tool> needs <prerequisite>, which is missing. What now?
- 'Skip this tool (Recommended)' - leave it out of the plan
- 'Install it now' - run the install line shown, or install it yourself and re-check
- 'Register anyway' - register it; it will not start until the prerequisite is there
```

'Skip': delete that key from `change`. 'Install it now': when the output gave an `install:` command, run it; when it gave
only a page, give the user that page, wait for them to say it is done, and run `prereq.js` again. 'Register anyway': keep
it, and say in the confirmation that it will not start yet.

## 7. Plan, then one confirmation

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.js" <tmp>/inventory.json <tmp>/answers.json --out <tmp>/plan.json
```

Paste the output verbatim in a fenced block: every CLI call, every file it writes, the key file each token route reads
(at project scope, the variable to set), the sign-in a remote route will ask for, and the tools that can run code. A
move to project scope writes `${VAR}` into `.mcp.json` in place of the key; one whose entry holds a credential anywhere
else - a header of its own, a userinfo URL - is a plan error naming the field, never written. A rename or a scope
move adds the new registration first, reads it back, then removes the old one; a route or location change rewrites it in
place and keeps the old entry to put back if the add fails. Exit 1 means the plan has errors; show them and go back to
the ask that causes them, never around them. Then:

```ask apply
Apply this plan?
- 'Apply (Recommended)' - runs the calls above in order, stops at the first failure
- 'Change something' - go back to the answers
- 'Cancel' - nothing is applied
```

A plan that says 'Nothing to do' means every answer kept what is installed; show that and stop without asking.

## 8. Apply

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/apply.js" <tmp>/plan.json --tmp <tmp>
```

Run it with the Bash tool's `timeout: 600000` (10 minutes, the most it allows by default); every download is left to the
fetch below, so the apply ends well inside the limit and its report comes back in this turn. Claude Code asks permission for this call itself - `apply.js` is deliberately not
in `allowed-tools` - so a skipped ask still cannot change anything. It runs the calls in order, reads each back from the
file the CLI wrote, and stops at the first failure, leaving what was applied in place and naming it. Paste the output
verbatim. A failure prints the line that puts a registration back (`RESTORE BY HAND`): give it to the user as written.
A key in it shows as `${PREFERRED_TOOLS_KEPT}`, never its value: the user puts their key back there.

Then report each changed tool as the read-back printed it (name, scope, route). A moved data folder moves no data: the
plan named the old folder, so name it again. Keys: relay each `key:` line as printed (the key and its file, never a
value); for a key in none of its files, name the file to fill, and say `/preferred-tools:fix` writes it in once it is
there.

**Fetch.** A change that launches a different package - a hosted route made local, say - prints `Fetch next, in the
background (...): <file>`. Run, with the Bash tool's `run_in_background`:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/fetch.js" "<file>"
```

It is `/preferred-tools:install` step 8, word for word: one server at a time, it fills the runtime's cache and starts the
server once with no 30-second limit, so its first-run work (memory's model download) is done before the next session,
then prints each changed server's status (`claude mcp get`); Claude Code asks permission for it. Tell the user to
restart only once it reports, paste its output when it finishes, and say a `warn` line changes nothing.
A rename, a scope move or a location change keeps the package: it prints no fetch line, and the apply printed each status
itself. End with the restart line: a changed registration loads on the next session start, and a project-scope server
also needs the trust prompt then. When background runs are turned off, run fetch.js in the foreground with
`timeout: 600000`, and again if the limit stops it.

## 9. Remove

```ask removeFirst
Remove what?
- 'Pick which (Recommended)' - choose the registrations and plugins to remove
- 'Cancel' - nothing is removed
```

'Pick which': ask the `remove` calls from step 3's output as printed (one option per registration; a tool at two scopes
is two options). Each option's description is the exact command, from which you read the target:
`claude mcp remove <name> -s <scope>` is `{"kind": "mcp", "name": ..., "scope": ...}`, and
`claude plugin uninstall <id> --scope <scope>` is `{"kind": "plugin", "id": ..., "scope": ...}`. 'None of these', or
nothing picked: say so and stop. Put them in `answers.json` under `"remove"` and go to step 7. Data folders stay where
they are; the plan names them.

## claude-hud

The status line and its recommended settings, for an installed claude-hud.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/hud-statusline.js" --check --catalog "${CLAUDE_PLUGIN_ROOT}/catalog/plugin-settings.json" --project .
```

Paste its output verbatim. It shows the statusLine's state and the row as it lands after the statusLine write - the
refresh interval included, and none beside a statusLine that is not claude-hud's. Its last line is
`hud-check: statusLine=<state> missing=<n> differs=<m> match=<k>`. The statusLine itself is never behind the ask: it is
written whenever claude-hud is kept, add-only. Ask once, with the counts:

```ask hud
Apply the recommended claude-hud settings? <n> missing, <m> differing, <k> matching.
- 'Apply recommended (Recommended)' - adds only the missing keys; every value already chosen is kept
- 'Apply and replace differing' - adds the missing keys and overwrites the differing ones
- 'Skip' - nothing changes
```

- claude-hud picked in step 5: the answer goes into `answers.json` as `"hud": "recommended"`, `"replace"` or `"skip"`,
  and `apply.js` runs it after the plugin calls.
- Reached from the menu or the `hud` argument: this ask is the confirmation. Run the same script with the matching flag
  (`--catalog` and `--project .` as above) and paste its output; Claude Code asks permission for it, since only
  `--check` is in `allowed-tools`. 'Apply recommended': `hud-statusline.js`. 'Apply and replace differing':
  `hud-statusline.js --replace`. 'Skip': `hud-statusline.js --statusline-only` - claude-hud still shows on screen, no
  catalog key is written.

The account's `settings.json` is copied to `settings.json.bak.<date>` before the first write; name that file. On Windows
the output carries a note about the refresh interval; pass it on.
