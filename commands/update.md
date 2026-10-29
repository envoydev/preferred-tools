---
description: "Update what is behind - installed plugins, pinned MCP servers and language servers - to releases at least 7 days old, after one confirmation"
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/update.js" --check), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/update.js" --check *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/update.js" --questions), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/update.js" --questions *)
---

Bring what is installed up to date: every plugin on this machine (catalog or not), the pinned MCP servers, and the
language servers on PATH. The script finds what is behind and does the work; you paste what it prints and ask.

## Rules

- **Nothing changes before one confirmation** (step 3). `--check` and `--questions` read; only `--apply` writes, and Claude
  Code asks permission for that call itself - `--apply` is deliberately not in `allowed-tools`.
- **The `claude` CLI is the only writer** of `.mcp.json` and the account file; the script calls it. Never edit those files.
- **A pin moves only to a release at least 7 days old.** A newer, younger release is listed as held back, never offered.
  The rewrite keeps the registration's name, scope, args and env; only the pin and the cut-off beside it move.
- **A registration that matches no catalog row is the user's.** The script never looks at it.
- **Every ask is data.** Ask exactly the options printed, in the order printed; `AskUserQuestion` adds 'Other' itself.
- This command never changes `catalog/tools.json`. Its pins move only through the repo script `npm run refresh-pins`.
- A rename, a move or a route change is not an update; that is `/preferred-tools:configure`.

## 1. What is behind

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/update.js" --check
```

Paste the output verbatim in a fenced block. It refreshes each marketplace the installed plugins come from
(`claude plugin marketplace update <name>`), then lists, in tables: catalog plugins, other plugins, MCP servers as
`current -> offered` with the release's age, and language servers. Below them: plugins whose marketplace lists no version
(`claude plugin update` is the check for those, so each is offered on its own), releases held back, what was skipped (a hosted URL has no
pin; a Docker image tag is not checked), what could not be checked, and the language servers on PATH.

Exit 3 with one line means the `claude` CLI is missing: say so and stop. When the last line is
`preferred-tools: everything current`, say that and stop. A line under 'Could not check' is a registry that did not
answer; it is never read as current - say so.

## 2. Which

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/update.js" --questions --no-refresh
```

It prints `{ "offer": <ask>, "pick": [<calls>] }`. Ask the `offer` as printed:

```ask updateOffer
Update what is behind?
- 'All of them (Recommended)' - update everything offered
- 'Pick which' - choose among them
- 'Skip' - nothing changes
```

When only unchecked plugins remain, the printed `offer` leaves 'All of them' out and recommends 'Pick which'; ask what is
printed. 'Skip' ends the command. 'Pick which': ask each call in `pick` as printed (up to four multi-select questions of at
most four options) and collect the options picked. Each option's description is the offer id to pass on.

## 3. Apply

State what will change - each `current -> offered` - and, for an MCP server, that its registration is removed and added
again, so the server is briefly unregistered. Then run, with the ids picked (comma-separated), or `all` for 'All of them':

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/update.js" --apply <id,id | all>
```

Run it with the Bash tool's `timeout: 600000` (10 minutes, the most it allows by default): a plugin update clones its marketplace and
a language server installs through npm, and the new MCP pins are downloaded after it, not inside it. `all` is every
offer with a known newer version; an unchecked plugin runs only when its own id is given. Each update is read back: a
plugin from the plugin list, an MCP pin from the file the CLI wrote, a language server from `--version`. A failed MCP
rewrite puts the old registration back and prints the line that does it by hand if that fails too (`RESTORE BY HAND`):
give it to the user as written.
A key in it shows as `${PREFERRED_TOOLS_KEPT}`, never its value: the user puts their key back there. Paste the output verbatim, then report each result as read back.

A new pin is not in the runtime's cache yet, so an MCP update prints `Fetch next, in the background (...): <file>`. Run,
with the Bash tool's `run_in_background`:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/fetch.js" "<file>"
```

One server at a time, it downloads each new pin and starts the server once with no 30-second limit, then prints each
server's status (`claude mcp get`): without it the first session start does that download, and any first-run work of
the new version, inside Claude Code's 30-second limit, and a first download can take minutes. Claude Code asks
permission for it - it downloads and runs a package's install and starts the server. Tell the user to restart only once
it reports, so a session start does not download the same package beside it; paste its output when it finishes. A
`warn` line changes nothing: the registration is updated, and its first start downloads the pin and may time out once. When background runs
are turned off, run it in the foreground with `timeout: 600000`, and again if the limit stops it. End with the restart line (new
servers load on the next session start; `/reload-plugins` for plugins).

After claude-hud moves, the script re-runs its settings check and names any recommended key the new version's
`dist/config.js` no longer mentions. It removes nothing from the user's config; pass the names on.

## Language servers

`--check` reports `typescript-language-server` and `csharp-ls` when they are on PATH. `typescript-language-server` is
offered like the rest (`npm install -g typescript-language-server typescript@6`, TypeScript 7 ships no `tsserver.js`) and
changes the machine only when picked. `csharp-ls` is reported with its version; for a copy installed with
`dotnet tool` the update line is `dotnet tool update --global csharp-ls`; you run it only when the user asks, and a copy
installed another way (Homebrew) is updated that way.

## Windows and serena

A serena bump on Windows needs nothing extra here: this plugin does not patch serena's TypeScript launcher (the user's
ruling, recorded in `docs/sources.md`). If symbol tools fail afterwards, `/preferred-tools:fix` lists what it can detect.
