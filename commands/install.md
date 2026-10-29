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

## 3. Pick

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.js" --questions <tmp>/inventory.json
```

Its `pick` holds only the tools not installed here. When it is empty, say every catalog tool for this OS is installed,
point to `/preferred-tools:configure` to change or remove one, and stop.

If the argument is a tool id from the table: installed, say where (from the table) and point to
`/preferred-tools:configure <id>`, then stop; not installed, take it as the only pick and go to step 4.

Otherwise ask each `pick` call as printed - one `AskUserQuestion` of up to four multi-select questions of 2 to 4
options, grouped Code, Docs and forges, Browsers, Machine - and collect the labels picked; each label is the tool id,
then `(installed for every project ...)` when a copy is installed at user scope. 'None of these', or nothing picked: say
so and stop.

A pick installed for every project gets this project's own copy beside it; the one for every project is never changed
or removed. Its questions leave out the scope it already has (and the scope question itself when one scope is left).
Under the same name, the copy is the one Claude Code uses in this project. A tool whose data defaults to the account
folder (memory) defaults to the project folder for a copy, so it starts empty and the account-wide data is not seen
here; 'Keep' at the location question shares that data instead. Say this when such a tool is picked.

## 4. Settings

```ask settings
How do you want to set the tools up?
- 'Use the recommended settings for all (Recommended)' - route, scope, name and location as recommended
- 'Set each tool' - ask route, scope, name and location per tool
```

'Use the recommended settings for all': every pick is `{}` in the answers file. A tool already installed in this
project is never offered, so this adds only: nothing installed is changed.

'Set each tool': write `{"rows": [<picked ids>], "routes": {<id>: <route>}}` to `<tmp>/picks.json`, run
`plan.js --questions <tmp>/inventory.json <tmp>/picks.json`, and for each picked tool in order:

1. A tool whose `tools.<id>.route` is not null: ask that one question first. Record the route, write it into
   `routes` in `picks.json`, and run the command again, because the scope options depend on the route.
2. Ask `tools.<id>.questions` as one call, as printed. Map the answers into that tool's entry in `<tmp>/answers.json`
   (`{"picks": {<id>: {...}}}`):

| Answer | Entry |
|---|---|
| route 'Hosted' / 'Local' | `"route": "remote"` / `"local"` |
| scope, the label's first word | `"scope": "local"` / `"project"` / `"user"` |
| name 'Keep ...' | `"name": "keep"` |
| name 'Use `x`' or Other | `"name": "x"` |
| location 'Keep ...' | `{"side": "default"}` |
| location 'Use alfred-code's `x`' | `{"side": "alfred"}` |
| location 'Use `x`' | `{"side": "project"}` or `{"side": "account"}`, as its description says |
| location Other, or 'Another folder' | `{"side": "path", "path": "<typed>"}` |
| browser 'A browser binary I name' | `"executablePath": "<typed>"` |
| API key 'Use `${VAR}`' | `"token": true` (the reference only) |
| host Other | `"params": {"host": "<typed>"}` |

Skip a key the user left at its default; the plan reads a missing key as the recommendation.

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

## 6. Plan, then one confirmation

When claude-hud is picked, set `"hud": "defer"` in the answers: its settings are asked after the install (see
'claude-hud').

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/plan.js" <tmp>/inventory.json <tmp>/answers.json --out <tmp>/plan.json
```

Paste the output verbatim in a fenced block: every CLI call, every file it writes, the environment variables the user
must set for a token route, the sign-in a remote route will ask for, and the tools that can run code. Exit 1 means the
plan has errors; show them and go back to the ask that causes them, never around them. Add the audit and 'register
anyway' lines from step 5. Then:

```ask apply
Apply this plan?
- 'Apply (Recommended)' - runs the calls above in order, stops at the first failure
- 'Change something' - go back to the answers
- 'Cancel' - nothing is applied
```

An empty plan says 'Nothing to apply'; show that and stop without asking.

## 7. Apply

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/apply.js" <tmp>/plan.json --tmp <tmp>
```

Run it with the Bash tool's `timeout: 600000` (10 minutes, the most it allows by default). It makes only the CLI calls
and their read-back - seconds a tool, a plugin install a little more - and leaves every download to step 8, so it ends
well inside the limit and its report comes back in this turn. Claude Code asks permission for this call itself - `apply.js` is deliberately not in `allowed-tools` - so a
skipped ask still cannot change anything. It runs the calls in order, reads each back from the file the CLI wrote, and
stops at the first failure, leaving what was applied in place and naming it. Paste the output verbatim. A failure prints
the line that puts a registration back (`RESTORE BY HAND`): give it to the user as written.
A key in it shows as `${PREFERRED_TOOLS_KEPT}`, never its value: the user puts their key back there.

Then report each picked tool as the read-back printed it (name, scope, route). Start step 8, and while it runs, continue
with 'claude-hud' if the plan set `hudAfter`. Tokens: list the variable names to set, nothing else. Close with one line: a
later rename, move, route or location change, or a remove, is `/preferred-tools:configure`.

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
download beside it, and two at once is the one case measured to break a start. When it finishes, paste its output
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
