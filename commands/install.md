---
description: "Install preferred tools that are not installed yet (MCP servers and plugins): pick, set up, one confirmed plan"
argument-hint: "[tool id]"
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/tmpdir.js"), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/inventory.js" *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/table.js" *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.js" *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/prereq.js" *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/hud-statusline.js" --check *)
---

Walk the user through installing preferred tools that are not installed here yet. The scripts do the work and print what
you paste; you ask the questions. Argument: `$ARGUMENTS`.

Install only adds; it never changes, moves or removes a registration. A tool already installed in this project is
changed or removed with `/preferred-tools:configure`; say so whenever the user asks for that here.

## Rules

- **Nothing is applied before one confirmation** (step 6). Every earlier step reads and asks.
- **The `claude` CLI is the only writer** of `.mcp.json` and the account file; `apply.js` calls it. Never edit those
  files by hand.
- **A registration that matches no catalog row is the user's.** It is listed, never touched.
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

## 3. Pick

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.js" --questions <tmp>/inventory.json --data "${CLAUDE_PLUGIN_DATA}" --connectors "<Name>,<Name>"
```

`<Name>,<Name>`: the claude.ai connectors this session has loaded - each `<Name>` in your own tool names
`mcp__claude_ai_<Name>__<tool>`, once each (`mcp__claude_ai_Context7__query-docs` gives `Context7`); `""` when there are
none. The call reads the registrations and starts no server; it asks nothing about servers already set up.

Its `pick` holds only the tools not installed here, without a server left on its own. When it is empty, say every
catalog tool for this OS is installed or left on its own, point to `/preferred-tools:configure` to change or remove one,
and stop.

If the argument is a tool id from the table: installed, say where (from the table) and point to
`/preferred-tools:configure <id>`, then stop; not installed, take it as the only pick and go to step 4.

Otherwise ask each `pick` call as printed - one `AskUserQuestion` of up to four multi-select questions of 2 to 4
options, grouped Code, Docs and forges, Browsers, Machine - and collect the labels picked; each label is the tool id,
then what it already has:

- `(installed for every project ...)` - a copy is installed at Global scope. The pick gets this project's own copy
  beside it; the one for every project is never changed or removed. Its questions leave out the scope it already has
  (and the scope question itself when one scope is left). Under the same name, the copy is the one Claude Code uses in
  this project. A tool whose data defaults to the global root (memory) defaults to the project root for a copy, so it
  starts empty and the global data is not seen here; 'Keep' at the location question shares that data instead. Say
  this when such a tool is picked.
- `(also connected through claude.ai)` or `(also provided by the <plugin> plugin)` - the same server reaches this
  session another way. The pick adds this project's own registration beside it, and the plan names the two servers.

'None of these', or nothing picked: say so and stop.

## 4. Settings, one tool at a time

Write `{"rows": [<picked ids>], "done": []}` to `<tmp>/picks.json` and run:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.js" --questions <tmp>/inventory.json <tmp>/picks.json --data "${CLAUDE_PLUGIN_DATA}"
```

Its `next` is the one step to ask now: `next.id`, the `next.tool` it belongs to, `next.call` (the questions, as one
`AskUserQuestion`), `next.answers` (what a label picked stands for) and, sometimes, `next.set`. The first step is the
settings question; every step after it is one tool's, and one tool's steps come one after another - its route, scope and
name, the root folder its scope uses when this run has not asked it yet, its location and extras, then its key name and
settings. Until `next.id` is `done`:

1. Ask `next.call` as printed. When `next.call` is empty, make no call.
2. Record each answer in `<tmp>/picks.json` and in the tool's entry in `<tmp>/answers.json` (`{"picks": {<id>: {...}}}`),
   mapped by the table below. In `picks.json`:
   - the settings answer is `next.answers.settings.<label>`, written as `"walk"`: `"recommended"` or `"each"`;
   - a route goes under `"routes": {<id>: ...}`, a scope under `"scopes"`, a name under `"names"` ('Keep ...' is
     `"keep"`) and the API key under `"tokens": {<id>: true | false}`;
   - a root folder is `next.answers.<question id>.<label>`, a `{family, id, root}`: write `"roots": {<family>: {"id":
     <id>}}` in both files; 'A folder you name' is asked next and recorded as `{"id": "named", "path": "<typed>"}`.
3. Write `next.set` when it is there: `{"location": ...}` is the one folder left for the tool, written as its
   `"location"` in `answers.json`.
4. Append `next.id` to `"done"` in `picks.json` and run the command again.

'Use the recommended settings' ends the walk at once: every pick is `{}` in the answers file, and the recommended route,
scope, roots, key names and settings are used. A tool already installed in this project is never offered, so either
answer only adds: nothing installed is changed.

The key name is `next.answers.<question id>.<label>`: a name goes to `"keyNames": {<id>: "<NAME>"}` at the top of
`answers.json`; `named` - 'A name you choose' - is asked next. The walk leaves the key name out when the API key answer
was 'No key - lower rate limits' or 'Sign in with OAuth'. Settings 'Keep these settings' or 'No settings' write nothing;
'Change or add a setting' asks next for `NAME=value` pairs, written to `"settings": {<id>: {"<NAME>": "<value>"}}`.

A bridge route (sentry's 'Bridge') asks one 'URL name' question per value its URL takes from `.mcps-secrets`, beside the
key name: which name holds the organization slug, and the project slug. The catalog's name is recommended, and a filled
name holding the row's word (`SENTRY`) is offered beside it, never above it. The answer is
`next.answers.<question id>.<label>`, a name written to `"urlNames": {<id>: {"<VAR>": "<NAME>"}}` at the top of
`answers.json`, where `<VAR>` ends the question id (`urlname-<id>-<VAR>`); `named` - 'A name you choose' - is asked
next, checked against `^[A-Za-z_][A-Za-z0-9_]*$` as for the key name. A URL value is a plain name the user writes in `.mcps-secrets`, never a key: the plan
refuses a URL name that is the key's name or reads as a credential, and a name two parts of the URL share.

| Answer | Entry |
|---|---|
| route 'Hosted' / 'Local' / 'Bridge' | `"route": "remote"` / `"local"` / `"bridge"` |
| scope 'Global' / 'Project' / 'Local' | `"scope": "user"` / `"project"` / `"local"` |
| name 'Keep ...' | `"name": "keep"` |
| name 'Use `x`', or a name typed | `"name": "x"` |
| location | `"location":` the entry `next.answers` gives for the label picked |
| location 'Another ...folder', asked next | `"location": {"side": "path", "path": "<typed>"}` |
| browser 'A browser binary I name', asked next | `"executablePath": "<typed>"` |
| API key 'Use a key from .mcps-secrets' / 'No key - lower rate limits' or 'Sign in with OAuth' | `"token": true` / `"token": false`, for every answer |
| host 'A self-managed host', asked next | `"params": {"host": "<typed>"}` |
| key name, a name or one asked next | top-level `"keyNames": {<id>: "<NAME>"}` |
| URL name, a name or one asked next | top-level `"urlNames": {<id>: {"<VAR>": "<NAME>"}}` |
| settings, pairs asked next | top-level `"settings": {<id>: {"<NAME>": "<value>"}}` |
| root, an option or a folder asked next | top-level `"roots": {<family>: {"id": <id>}}`, or `{"id": "named", "path": "<typed>"}` |

Skip any other answer the user left at its default; the plan reads a missing key as the recommendation. The API key is
the exception: write it either way, since a key is the recommended way into every hosted server. A name must match
`^[A-Za-z_][A-Za-z0-9_]*$`, and a setting whose name looks like a credential is refused by the plan - a key goes in
`.mcps-secrets` and is picked as the key's name, never typed here.

## 5. Prerequisites

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/prereq.js" <tmp>/answers.json --audit
node "${CLAUDE_PLUGIN_ROOT}/scripts/prereq.js" <tmp>/answers.json --json
```

Paste the first output verbatim. It checks `uvx`, `npx`, Node 22.22.2 or newer, Docker or the github binary,
`typescript-language-server` with TypeScript 6, `csharp-ls`, the Android SDK and a JDK, only for the picks that need them,
and runs `npm audit` on appium's package. The audit lines go into step 6's confirmation as they are; an 'audit not run'
line is not a pass.

From the second (JSON) output, copy `machine` into `<tmp>/answers.json` under `"machine"`; it is how the plan knows
whether Docker is there. For each tool with a missing prerequisite, ask once, one tool per call, as the walk asks:

```ask prereqMissing
<tool> needs <prerequisite>, which is missing. What now?
- 'Skip this tool (Recommended)' - leave it out of the plan
- 'Install it now' - run the install line shown, or install it yourself and re-check
- 'Register anyway' - register it; it will not start until the prerequisite is there
```

'Skip': delete the tool from `answers.json`. 'Install it now': when the output gave an `install:` command, run it; when
it gave only a page, give the user that page, wait for them to say it is done, and run `prereq.js` again. 'Register
anyway': keep it, and say in the confirmation that it will not start yet.

## 6. Plan, then one confirmation

When claude-hud is picked, set `"hud": "defer"` in the answers: its settings are asked after the install (see
'claude-hud').

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.js" <tmp>/inventory.json <tmp>/answers.json --out <tmp>/plan.json --data "${CLAUDE_PLUGIN_DATA}" --connectors "<Name>,<Name>"
```

`--connectors` names the same connectors as step 3, so a recorded connector that is gone is dropped and a server also
connected through claude.ai is named beside this project's own. Paste the output verbatim in a fenced block: every CLI
call, every file it writes (the root's `.gitignore`, `mcp-headers.js`, the key names in `.mcps-secrets`), the `Key:`
line of each route that uses a key (the name, the files it is read from, filled or not - never a value) and the line
under it that says how the server connects once the key is there, the sign-in a remote route will ask for, and the tools
that can run code. Two kinds of step may read new:

- `writes` or `removes <root>/preferred-tools.json` - the servers left on their own; a managed server has no entry, so
  the file is removed once none is left.
- `reorders <project>/.mcp.json (no value changes)` - after a change at Project scope, the catalog servers in the user's
  order, the user's own servers after them; no entry is changed.

Exit 1 means the plan has errors; show them and go back to the ask that causes them, never around them. Add the audit
and 'register anyway' lines from step 5. Then:

```ask apply
Apply this plan?
- 'Apply (Recommended)' - runs the calls above in order, stops at the first failure
- 'Change something' - go back to the answers
- 'Cancel' - nothing is applied
```

An empty plan says 'Nothing to apply'; show that and stop without asking.

## 7. Apply

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/apply.js" <tmp>/plan.json --tmp <tmp> --data "${CLAUDE_PLUGIN_DATA}"
```

Run it with the Bash tool's `timeout: 600000` (10 minutes, the most it allows by default). It writes the root's files
first, then makes the CLI calls and their read-back - seconds a tool, a plugin install a little more - then the records,
and leaves every download to step 8, so it ends well inside the limit and its report comes back in this turn. Claude
Code asks permission for this call itself - `apply.js` is deliberately not in `allowed-tools` - so a skipped ask still
cannot change anything. It runs the steps in order, reads each back, and stops at the first failure, leaving what was
applied in place and naming it; a re-run reuses the files already written. Paste the output verbatim. A failure prints
the line that puts a registration back (`RESTORE BY HAND`): give it to the user as written. A key in it shows as
`${PREFERRED_TOOLS_KEPT}`, never its value: the user puts their key back there.

Then report each picked tool as the read-back printed it (name, scope, route). Start step 8, and while it runs, continue
with 'claude-hud' if the plan set `hudAfter`. Keys: relay each `key:` line as printed (the name and its file, never a
value). After the read-back the apply prints one line per hosted server that takes a key - relay each as printed:

- `<name>: connects with its key at the next session start; in a session already running, /mcp -> <name> -> Reconnect`
  - the key is filled;
- `<name>: fill <NAME> in <file>, then Reconnect it in /mcp - ...` - it is not, and the line says how the server runs
  until then;
- `<name>: the server refused the key in <NAME> - <hint>` - the server answered 401 or 403 to the key it was sent: the
  value is wrong for that server, and the hint says what it takes (gitlab a fine-grained token, atlassian
  `email:api_token`). The user fixes the value in the file and reconnects; nothing here reads it.

A Project- or Local-scope server with a key helper connects with its key only once the trust prompt is accepted - say
so. A bridge reads its key and URL names each time the server starts: repeat the plan's 'fill ... in ...' note, and say
that after a change to them the user restarts Claude Code or reconnects the server in `/mcp`. Close with one line: a later rename, move, route, location, key name, settings or root folder change, or a remove,
is `/preferred-tools:configure`.

## 8. Fetch

With no `Fetch next` line there is nothing to download (hosted routes and plugins only): the apply printed each server's
status itself, so end with the restart line below. When the apply output has `Fetch next, in the background (...):
<file>`, run, with the Bash tool's `run_in_background`:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/fetch.js" "<file>"
```

One server at a time, it downloads what the server launches into its runtime's cache (npm, uv or Docker), then starts
the server once exactly as registered and stops it when it answers, then prints each server's status as `claude mcp get`
reports it. Claude Code gives a server 30 seconds to answer, and a first start can take minutes: memory's package came
down in seconds, but its first start then downloaded its embedding model for about 2 minutes, while later starts took 2
seconds. A server whose `${VAR}` is not set is fetched but not started (a `skip` line). A foreground call past its time
limit (2 minutes by default, 10 at most) is moved to the background, or stopped where background runs are turned off,
so this one starts in the background. Claude Code asks permission for it - it downloads and runs a package's install and
starts the server - so it is not in `allowed-tools`.

Tell the user it is running, and to restart Claude Code only once it reports: a session started now begins the same
download beside it, and two at once is the one case measured to break a start - an npx server then fails at every start
with `ENOENT` until `/preferred-tools:fix` (`npx-cache-entry`) repairs it. When it finishes, paste its output
verbatim and end with the restart line: the new registrations load on the next session start, and a project-scope
server also needs the trust prompt then. A `warn` line changes nothing: the registration stays, and its first session
start does the download or first-run work and may time out once - say so. When background runs are turned off, run it
in the foreground with `timeout: 600000`; one stopped by the limit is run again, and the cache keeps what it finished.

## claude-hud

The status line and its recommended settings, asked once claude-hud has just been installed (the plan's `hudAfter`).
Later changes to them are `/preferred-tools:configure hud`.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/hud-statusline.js" --check --catalog "${CLAUDE_PLUGIN_ROOT}/catalog/plugin-settings.json" --project .
```

Paste its output verbatim. It shows the statusLine's state and the row as it lands after the statusLine write - the
refresh interval included, and none beside a statusLine that is not claude-hud's. Its last line is
`hud-check: statusLine=<state> missing=<n> differs=<m> match=<k>`. The statusLine itself is never behind the ask: it is
written whenever claude-hud is installed, add-only. Ask once, with the counts:

```ask hud
Apply the recommended claude-hud settings? <n> missing, <m> differing, <k> matching.
- 'Apply recommended (Recommended)' - adds only the missing keys; every value already chosen is kept
- 'Apply and replace differing' - adds the missing keys and overwrites the differing ones
- 'Skip' - nothing changes
```

Run the same script with the matching flag (`--catalog` and `--project .` as above) and paste its output; Claude Code asks
permission for it, since only `--check` is in `allowed-tools`:

- 'Apply recommended': `hud-statusline.js`
- 'Apply and replace differing': `hud-statusline.js --replace`
- 'Skip': `hud-statusline.js --statusline-only` - claude-hud still shows on screen, no catalog key is written

The account's `settings.json` is copied to `settings.json.bak.<date>` before the first write; name that file. On Windows
the output carries a note about the refresh interval; pass it on.
