---
description: "Change or remove installed preferred tools - an MCP server's route, scope, name, data folder, key name or settings, a root folder, a plugin's scope, claude-hud's settings - one confirmed plan"
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
- **Scopes are Global, Project and Local.** Global is `user` scope - every project on this machine.
- **Keys live in `.mcps-secrets` in the root folder**, one per root (the project root for Project and Local, the global
  root for Global), and the user fills each value by hand. The apply writes names only, as empty `NAME=` lines. A hosted
  route reads its key through `mcp-headers.js` each time Claude Code connects; a local route's key is written into the
  registration at Local and Global scope. Never ask for a key, and never read, print or edit a value: name the file and
  the name.
- **Every ask is data or one of the blocks below.** Ask exactly the options printed, in the order printed; do not add or
  reword one. `AskUserQuestion` adds 'Other' itself.
- **A typed value is asked next, in one plain line that ends your turn.** When the option picked says 'asked next' (a
  folder you name, a name you choose, a setting, a browser binary, a host), ask for that one value in a single line of
  text - no `AskUserQuestion` - and end the turn; the user's next message is the value. A value the user typed as the
  Other answer to that question is taken the same way.
- Every file below lives in one temp folder. Make it once with `node "${CLAUDE_PLUGIN_ROOT}/scripts/tmpdir.js"` and call
  its path `<tmp>`.

## 1. Inventory

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/inventory.js" --json <tmp>/inventory.json --data "${CLAUDE_PLUGIN_DATA}"
```

It reads `.mcp.json`, the account file (user servers and this project's local ones), `claude plugin list --json`, the
servers enabled plugins provide, and the records of earlier answers, and starts no server. Exit 3 with one line means
the `claude` CLI is missing: say so and stop. A file named as not valid JSON is unreadable: its scope gets no write, and
you offer nothing that writes there.

## 2. The table

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/table.js" <tmp>/inventory.json
```

Paste the output verbatim in a fenced block. It is the whole catalog for this OS, numbered, with what is installed at
each scope as `name [route, pin]`.

## 3. What to change

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.js" --questions <tmp>/inventory.json --data "${CLAUDE_PLUGIN_DATA}"
```

Its `change.keys` maps each option to its key: an installed registration or plugin (`mcp:<name>~<scope>`,
`plugin:<id>~<scope>`), a server left on its own (`mcp:...`, `plugin-mcp:<plugin>/<server>`, `connector:<Name>`), and a
root folder in use (`root:project`, `root:global`). When it is empty, say nothing from the catalog is installed here,
point to `/preferred-tools:install`, and stop.

The argument, when given:

- `hud` - go straight to 'claude-hud' (claude-hud not installed: say so and point to `/preferred-tools:install`).
- a registration name, or a tool id - the keys whose label starts with that name or names that tool. Exactly one: it is
  the only pick, go to step 5. Several: say where it is installed and ask step 4 as printed. None: say it is not
  installed and point to `/preferred-tools:install <id>`.

Otherwise ask, leaving out 'claude-hud settings' when the table shows claude-hud not installed:

```ask menu
What do you want to change?
- 'Change tools (Recommended)' - pick installed tools, servers on their own or a root folder, then what to change
- 'Remove tools' - choose the registrations and plugins to remove
- 'claude-hud settings' - the status line and its recommended settings - only shown when claude-hud is installed
- 'Done' - nothing changes
```

'Done' ends the command. 'Remove tools' goes to step 9. 'claude-hud settings' goes to 'claude-hud'.

## 4. Pick

Ask each `change.calls` call as printed - one `AskUserQuestion` of up to four multi-select questions, one option per
registration or plugin (a tool at two scopes is two options; your own servers are not there), then the 'On their own'
group (servers left on their own, with a plugin or with claude.ai) and the 'Root folders' group. Turn each picked label
into its key through `change.keys`. 'None of these', or nothing picked: say so and stop.

## 5. Each pick, one step at a time

Write `{"targets": [<picked keys>], "done": []}` to `<tmp>/picks.json` and run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.js" --questions <tmp>/inventory.json <tmp>/picks.json --data "${CLAUDE_PLUGIN_DATA}"
```

Its `targets.<key>` holds each pick's `row` and what it has now (`current`: name, scope, route); a target with an
`error` is not changed - say why. Its `next` is the one step to ask now: `next.id`, `next.call` (the questions, as one
`AskUserQuestion`), `next.answers` (what a label picked stands for) and, sometimes, `next.set`. Every question
recommends what the pick has now. Until `next.id` is `done`:

1. Ask `next.call` as printed. When `next.call` is empty, make no call.
2. Record each answer as below, in `<tmp>/picks.json` and in `<tmp>/answers.json`.
3. Write `next.set` when it is there: `{"location": ...}` is the one folder left at the new scope, written as the
   target's `"location"`, since the folder it uses now cannot stay there.
4. Append `next.id` to `"done"` in `picks.json` and run the command again.

What each step is, and where its answer goes:

- **On its own** (a server left on its own, a plugin's server or a connector): the question is the one the record
  asked. Its answer is `next.answers.<question id>.<label>`, a `{key, choice}`: write `"existing": {<key>: <choice>}`
  into `answers.json`. 'Let preferred-tools manage it' hands it to configure, update and fix from now on; for a plugin's
  server or a connector, the other option lets install offer preferred-tools' own beside it.
- **A root folder** (`root:project`, `root:global`): the root in use first. Its answer is
  `next.answers.<question id>.<label>`, a `{family, id, root}`; 'A folder you name' is asked next. A root other than
  the one in use writes `"roots": {<family>: {"id": <id>}}` (or `{"id": "named", "path": "<typed>"}`) and
  `"rootChange": [<family>]` into `answers.json`. The plan re-adds each registration of that family with its helper,
  and its data folder when it sits in the old root, pointing into the new root; it moves no data and no key value, and
  names both.
- **A registration**: its first question is 'Who looks after <name>?', a `{key, choice}` in `next.answers`. Write
  `"existing": {<key>: <choice>}` into both files.
  - 'Leave it on its own' ends this pick: it gets no `change` entry, and the plan saves it in the record named in the
    option, so configure, update and fix skip it from now on.
  - 'preferred-tools' goes on to its route, its scope and name, its location and extras, then its key name and
    settings. Record a route under `"routes": {<key>: ...}`, a scope under `"scopes"`, a name under `"names"` ('Keep
    ...' is `"keep"`) and the API key under `"tokens": {<key>: true | false}` in `picks.json`, and each answer that
    changes something in the target's `change` entry, mapped by the table below.
- **A plugin**: one question, its scope.

The key name is `next.answers.<question id>.<label>` - the name it uses now first, 'A name you choose' asked next - and
another name goes to `"keyNames": {<key>: "<NAME>"}` at the top of `answers.json`. The walk leaves the key name out when
the API key answer is now 'No key - lower rate limits' or 'Sign in with OAuth'. 'Change or add a setting' asks next for
`NAME=value` pairs, written to `"settings": {<key>: {"<NAME>": "<value>"}}`; 'Keep these settings' writes nothing.

A bridge route (sentry's 'Bridge') adds one 'URL name' question per value its URL takes from `.mcps-secrets` - the name
it uses now first. Another name goes to `"urlNames": {<key>: {"<VAR>": "<NAME>"}}` at the top of `answers.json`, where
`<VAR>` ends the question id (`urlname-<id>-<VAR>`); 'A name you choose' is asked next, checked against
`^[A-Za-z_][A-Za-z0-9_]*$`. The plan rewrites only the URL template and the key argument of the registration as read,
keeping its pin, and refuses a URL name that is the key's name or reads as a credential, and a name two parts of the URL
share. A change takes effect when the server starts again: say to restart Claude Code or reconnect it in `/mcp`.

Write the answers into `<tmp>/answers.json` as `{"change": {<key>: {"row": <targets.<key>.row>, ...}}}`, mapped as
below, and leave out every answer that keeps what the tool has now - the plan reads a missing key as 'keep':

| Answer | Entry |
|---|---|
| route 'Hosted' / 'Local' / 'Bridge', when it is not `current.route` | `"route": "remote"` / `"local"` / `"bridge"` |
| scope 'Global' / 'Project' / 'Local', when it is not `current.scope` | `"scope": "user"` / `"project"` / `"local"` |
| name 'Keep ...' | nothing |
| name 'Use `x`', or a name typed | `"name": "x"` |
| location 'The folder it uses now' | nothing |
| location, another label | `"location":` the entry `next.answers` gives for the label picked |
| location 'Another ...folder', asked next | `"location": {"side": "path", "path": "<typed>"}` |
| browser 'A browser binary I name', asked next | `"executablePath": "<typed>"` |
| browser 'Default for this engine', when it is not first | `"executablePath": ""` (drops `--executable-path`) |
| API key 'Use a key from .mcps-secrets' / 'No key - lower rate limits' or 'Sign in with OAuth', when it is not first | `"token": true` / `"token": false` |
| host 'A self-managed host' asked next, or the hosted host when it is not first | `"params": {"host": "<that host>"}` |
| key name, when it is not first | top-level `"keyNames": {<key>: "<NAME>"}` |
| URL name, when it is not first | top-level `"urlNames": {<key>: {"<VAR>": "<NAME>"}}` |
| settings, pairs asked next | top-level `"settings": {<key>: {"<NAME>": "<value>"}}` |

A name must match `^[A-Za-z_][A-Za-z0-9_]*$`, and a setting whose name looks like a credential is refused by the plan - a
key goes in `.mcps-secrets` and is picked as the key's name, never typed here.

A scope change on an MCP server is a move too: the registration picked leaves its old scope, so a copy for every project
moved to Local is gone from the other projects. To keep it there and add this project's own copy, use
`/preferred-tools:install` instead; say so when the user picks another scope for a Global registration.

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
node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.js" <tmp>/inventory.json <tmp>/answers.json --out <tmp>/plan.json --data "${CLAUDE_PLUGIN_DATA}"
```

Paste the output verbatim in a fenced block: every CLI call, every file it writes (a root's `.gitignore`,
`mcp-headers.js`, the key names in `.mcps-secrets`), the `Key:` line of each route that uses a key (never a value) and
the line under it that says how the server connects once the key is there, the sign-in a remote route will ask for,
and the tools that can run code. `writes` or `removes <root>/preferred-tools.json` is the record of the servers left on
their own - a server handed back to preferred-tools leaves it, and the file is removed once none is left.
`reorders <project>/.mcp.json (no value changes)` follows a change at Project scope: the catalog servers in the user's
order, the user's own servers and those left on their own after them. A move to Project scope takes no key
in `.mcp.json`; one whose entry holds a credential anywhere else - a header of its own, a userinfo URL - is a plan error
naming the field, never written. A rename or a scope move adds the new registration first, reads it back, then removes
the old one; a route, location, key name, settings or root change rewrites it in place and keeps the old entry to put
back if the add fails. A root change notes that the user copies the values from the old `.mcps-secrets` to the new one
themselves - say it again after the apply. Exit 1 means the plan has errors; show them and go back to the ask that
causes them, never around them. Then:

```ask apply
Apply this plan?
- 'Apply (Recommended)' - runs the calls above in order, stops at the first failure
- 'Change something' - go back to the answers
- 'Cancel' - nothing is applied
```

A plan that says 'Nothing to do' means every answer kept what is installed; show that and stop without asking.

## 8. Apply

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/apply.js" <tmp>/plan.json --tmp <tmp> --data "${CLAUDE_PLUGIN_DATA}"
```

Run it with the Bash tool's `timeout: 600000` (10 minutes, the most it allows by default); every download is left to the
fetch below, so the apply ends well inside the limit and its report comes back in this turn. Claude Code asks permission
for this call itself - `apply.js` is deliberately not in `allowed-tools` - so a skipped ask still cannot change
anything. It runs the steps in order - the root's files, the CLI calls with their read-back, then the records - and
stops at the first failure, leaving what was applied in place and naming it. Paste the output verbatim. A failure prints
the line that puts a registration back (`RESTORE BY HAND`): give it to the user as written. A key in it shows as
`${PREFERRED_TOOLS_KEPT}`, never its value: the user puts their key back there.

Then report each changed tool as the read-back printed it (name, scope, route). A moved data folder or root moves no
data: the plan named the old folder, so name it again. Keys: relay each `key:` line as printed (the name and its file,
never a value). After the read-back the apply prints one line per hosted server that takes a key - relay each as
printed: 'connects with its key at the next session start' with the `/mcp -> <name> -> Reconnect` path for a session
already running; 'fill <NAME> in <file>, then Reconnect it in /mcp' when the key is not there yet; or 'the server
refused the key in <NAME>' with what that server takes, when it answered 401 or 403 to the key it was sent - the user
fixes the value in the file and reconnects.

**Fetch.** A change that launches a different package - a hosted route made local, say - prints `Fetch next, in the
background (...): <file>`. Run, with the Bash tool's `run_in_background`:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/fetch.js" "<file>"
```

It is `/preferred-tools:install` step 8, word for word: one server at a time, it fills the runtime's cache and starts the
server once with no 30-second limit, so its first-run work (memory's model download) is done before the next session,
then prints each changed server's status (`claude mcp get`); Claude Code asks permission for it. Tell the user to
restart only once it reports, paste its output when it finishes, and say a `warn` line changes nothing. An npx server
that fails at every start with `ENOENT` afterwards was started beside the download: `/preferred-tools:fix` repairs it.
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
nothing picked: say so and stop. Put them in `answers.json` under `"remove"` and go to step 7. Data folders and key
files stay where they are; the plan names them.

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
