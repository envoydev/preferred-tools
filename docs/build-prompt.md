# Build prompt - the preferred-tools plugin

Paste this into a Claude Code session opened at the root of this repository (`preferred-tools`). It is self-contained:
everything it relies on is either stated here or named with the file to read.

Graded 2026-10-27 by independent reviewers: 79 -> 79 -> 88 -> 95; six findings fixed after the last grade.

---

You are building `preferred-tools`, a Claude Code plugin in this repository. The repo collects the tools its owner has
tested and likes - MCP servers and Claude Code plugins - with their install, update, rename, relocation and fix
procedures. The plugin installs nothing by itself: the user drives it through two manual commands and one skill.

## Goal

1. `/preferred-tools:install` - a guided, configure-style walk: pick tools, then per tool the route (remote or local,
   only where the tool has both), the scope, the registration NAME and the data LOCATION; then apply, read back and
   report. It also changes or removes what an earlier run installed.
2. `/preferred-tools:fix` - detects known problems in the installed tools (the first one: serena's TypeScript language
   server failing on Windows) and applies the recorded fix.
3. The `update-tools` skill - brings every installed plugin and every registered catalog server up to date when it is
   behind, and says so in one line when nothing is.

Done means every acceptance criterion in 'Acceptance criteria' holds and its proof is in your report.

## The catalog - 17 rows

Items marked (verify) are facts from the alfred-code record or from memory, unchecked against today's vendor docs. Step
1 checks each one and records the source.

| Row | Kind | Original name | Routes | Package or endpoint at the last known pin |
|---|---|---|---|---|
| serena | MCP | `serena` | local | `uvx --python 3.13 --from serena-agent@2.1.0 serena start-mcp-server --context claude-code --project-from-cwd ...` |
| memory | MCP | `memory` | local | `uvx --python 3.13 --with numpy --from mcp-memory-service[sqlite]==12.1.1 memory server` |
| context7 | MCP | `context7` | remote, local | remote `https://mcp.context7.com/mcp` + header `Context7-API-Key`; local `npx -y @upstash/context7-mcp@<pin>` (verify) |
| github | MCP | `github` | remote, local | remote `https://api.githubcopilot.com/mcp/`; local the Docker image `ghcr.io/github/github-mcp-server:<tag>` running `stdio`, chosen because it is the vendor's documented local route and a tag pins it; the release binary only when Docker is absent (verify) |
| gitlab | MCP | `gitlab` | remote | GitLab's own hosted server, `https://<host>/api/v4/mcp` (gitlab.com or a self-managed host), OAuth (verify); GitLab ships no local server, so the route is remote only |
| atlassian | MCP | `atlassian` | remote | Atlassian's hosted Rovo MCP server, `https://mcp.atlassian.com/v1/...`, OAuth (verify the path) |
| sentry | MCP | `sentry` | remote, local | remote `https://mcp.sentry.dev/mcp` (OAuth); local `npx -y @sentry/mcp-server@<pin>` + `SENTRY_ACCESS_TOKEN` (verify) |
| playwright-chrome | MCP | `playwright-chrome` | local | `npx -y @playwright/mcp@0.0.83 --browser chrome --user-data-dir <dir> --output-dir <dir>/output --no-webmcp` |
| playwright-msedge | MCP | `playwright-msedge` | local | the same, `--browser msedge` |
| playwright-firefox | MCP | `playwright-firefox` | local | the same, `--browser firefox` |
| playwright-webkit | MCP | `playwright-webkit` | local | the same, `--browser webkit` |
| appium | MCP | `appium-mcp` | local | `npx -y appium-mcp@1.97.1` |
| macos-control | MCP | `macos-desktop` | local, macOS only | `uvx --python 3.13 --from macos-mcp==0.4.6 macos-mcp serve` |
| windows-control | MCP | `windows-desktop` | local, Windows only | `uvx --python 3.14 --from windows-mcp==0.8.8 windows-mcp serve --exclude-tools PowerShell,Registry,Process,FileSystem` |
| claude-hud | plugin | `claude-hud@claude-hud` | marketplace `jarrodwatts/claude-hud` | status line; also writes its statusLine and config (see 'claude-hud') |
| typescript-lsp | plugin | `typescript-lsp@claude-plugins-official` | marketplace `anthropics/claude-plugins-official` | needs `typescript-language-server` + `typescript@6` on PATH, Node 22.22.2 or later |
| csharp-lsp | plugin | `csharp-lsp@claude-plugins-official` | the same | needs `csharp-ls` on PATH (`dotnet tool install -g csharp-ls`, .NET 10 SDK) |

The ten servers the stack used to ship (serena, memory, context7, the four browsers, appium, macOS, Windows) have a
paste-ready entry each, with every env key and pin, in the alfred-code checkout beside this one:
`../alfred-code/stack/mcp/original-mcps.json` (also `https://github.com/envoydev/alfred-code/blob/main/stack/mcp/original-mcps.json`),
summarised in `../alfred-code/stack/mcp/README.md`. Read both before writing `catalog/tools.json`. The launchers that ran
them hold the per-machine lessons in their header comments: `git -C ../alfred-code show f779a349:stack/mcp/<file>` for
`serena-launch.js`, `uv-python.js`, `browser-launch.js`, `mobile-launch.js`, `desktop-launch.js`. Carry each lesson into
a catalog field or a fix row; never copy a launcher.

## Design - how a tool is registered

**Every MCP server is a plain registration written by the `claude` CLI** (`claude mcp add-json <name> '<json>' -s
<scope>`, `claude mcp remove <name> -s <scope>`), with the machine's values resolved at install time. The CLI is the only
writer of `.mcp.json` and `~/.claude.json`; scripts read those files, never write them.

Why, against the alternatives:

- Servers declared in the plugin's own `plugin.json` - rejected: Claude Code names a plugin's server after the plugin,
  so the per-project name the user asked for is impossible, and alfred-code's 2.x needed one plugin per server to work
  around exactly that.
- Launcher scripts inside the plugin, referenced from the registration - rejected: the plugin cache path carries the
  version, so every plugin update breaks every registration, and `${CLAUDE_PLUGIN_ROOT}` is not expanded in a project's
  `.mcp.json` (verify in step 1; if it is, this alternative is still rejected for the version path).
- A plain registration costs the runtime work the launchers did (Python per machine, SDK paths): it moves to install
  time, and `/preferred-tools:fix` re-checks it when the machine changes. The user chose this over a launcher layer
  on 2026-10-27 ('Keep it simple').

**Identity is the launch, not the name.** `scripts/inventory.js` matches each registration it finds to a catalog row by
its fingerprint - the package name in `args` (`serena-agent`, `@playwright/mcp` plus its `--browser` value,
`mcp-memory-service`, ...) or, for a remote one, its URL host plus path pattern (gitlab: any host whose path is
`/api/v4/mcp`, so a self-managed GitLab is recognised too). So a tool under a custom name is still recognised by every
command, with no ledger file to drift. A registration that matches no row is the user's and is never touched.

**Names.** The default is the row's original name. The user can type another per project (AskUserQuestion's 'Other').
A name must match `^[A-Za-z0-9_-]{1,64}$`, must not already belong to a different registration at the same scope, and
must not be a stack name alfred-code once registered (`alfred-navigation`, `alfred-documentation`, `alfred-memory`,
`chrome-control`, `msedge-control`, `firefox-control`, `webkit-control`, `windows-control`, `macos-control`,
`mobile-control`, `browser-chrome`, ...). alfred-code's retire path may remove a registration under such a name when its
shape matches the old template. It never touches an ORIGINAL name: `ADD_BACK_NAMES` in
`../alfred-code/scripts/install/mcp.js` exempts every key of `original-mcps.json`, which is why the catalog defaults
(`serena`, `memory`, `appium-mcp`, ...) are safe. Build the reserved set from the files, not from this line: every id in
`../alfred-code/meta/retired-plugins.json` whose `retiredIn` is `2.10.1` (the retires that can still fire), plus every
name in `../alfred-code/meta/stack-manifest.json` `retired.mcps` that has no row there (today `browser`; `mcp.js` prunes
a name with no row on every run), minus the keys of `original-mcps.json`. The `2.0.0` rows (`sentry`, `appium-mcp`, `context7-local`, ...) stay out of the set:
their retire fires only on an update from before 2.0.0, and only on the old template's exact shape (each row's
`note`). A test asserts that no catalog default is in the set.
Each Playwright engine is its own row, so each gets its own name, scope and location. A rename is add-new, read back,
then remove-old; the old one stays if the new one fails.

**A change starts from what is installed.** Only a fresh add builds its entry from `catalog/tools.json`. A rename, a
location or scope change, a fix or a re-run on an installed row starts from the registration as read: its pin, its
cut-off and any args or env the user added. It then changes only what the answer names. So an update past the catalog
pin is never downgraded by a later rename, and a re-run with the same answers sees no difference and makes no call.

**Locations.** A row with data has ONE location root the user sets. Every path argument or env key derives from it,
listed in the row's `locations` map:

- serena: `SERENA_HOME` = `<root>`;
- memory: `MCP_MEMORY_SQLITE_PATH` = `<root>/memory.db`;
- each browser: `--user-data-dir` = `<root>`, `--output-dir` = `<root>/output`;
- appium: `SCREENSHOTS_DIR` = `<root>/screenshots`, `PAGE_SOURCES_DIR` = `<root>/page-sources`.

Browser rows also take an optional `--executable-path` for the browser binary itself, unset by default so Playwright
uses its own, and asked as its own question (step 5). Defaults for the root, in this order:

1. The alfred-code data already on disk, when present - the user's existing profiles, index and memories. Read each
   row's old root from its entry in `original-mcps.json`, never from a pattern: serena `.alfred/serena/home` (its
   `SERENA_HOME`, not `.alfred/serena`), each browser `.alfred/<engine>-control`, appium `.alfred/mobile-control`,
   memory `~/.alfred-memory`.
2. Otherwise, the project default `.preferred-tools/<registration name>/`. Memory's default is the account folder
   `~/.preferred-tools/memory/`, shared across projects as before.

The walk's second option is always the other place: the account folder `~/.preferred-tools/<registration name>/`
for a project default, the project folder for memory. Path form by scope: at `local` and `user` scope `plan.js`
writes the root resolved to an absolute path, with `~` expanded by the script (never left for the server). So a
session started in a subfolder uses the same profile, index and database. Only `project` scope writes it relative.
`plan.js` has a test per scope. A folder the plugin creates gets a `.gitignore` holding `*`, so the project's own `.gitignore` is
never edited. Moving a location never moves data: the walk says where the old data is and leaves it. One exception
to the defaults: serena on Windows. Its root must be absolute, in backslashes and space-free (fix row
`serena-windows-home`), so that rule wins over the order above. The walk offers `C:\Users\<name>\.serena` when the
profile path has no space, else asks for a space-free folder.

**Scopes and paths.** Ask per tool, recommending `local` for a local route (its paths and Python are this machine's) and
`project` for a remote route whose entry holds no secret. A `project` registration lands in the committed `.mcp.json`, so
it may carry only relative paths and `${VAR}` references. Each local row carries `projectScope` in `catalog/tools.json`,
`false` until step 12 measures that the tool resolves a relative root against the project directory. The walk offers
`project` for a local route only where it is `true`. Expect few: serena's Windows home must be absolute, and the old
browser launcher used absolute paths because Playwright resolves a relative one by its own rules. Plugins: `claude-hud` recommends `user`, the LSP pair
`project`.

**Secrets.** No token is ever written to any file. A remote route prefers OAuth (the user runs `/mcp` once to log in); a
token route registers `${VAR}` (for example `Authorization: Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}`) and the walk tells
the user where to set the variable (their shell, or the account `settings.json` `env`). An unset variable is reported,
not filled.

**Per-OS rules, applied at install time** (each also a fix row): uvx servers get the row's `--python` (3.13; 3.14 for
windows-control) and on Windows ARM64 the x64 build (`cpython-3.13-windows-x86_64-none`) - `../alfred-code/docs/uv-python-pin-evidence.md`
says why; npx servers on native Windows get the `cmd /c` wrapper Claude Code's MCP docs ask for (verify); macOS and
Windows control are offered only on their own OS; pinned packages carry the dependency cut-off (`--exclude-newer
<date>` for uvx, `npm_config_before` for npx), as in `original-mcps.json`. Serena on Windows gets two more, so the
user's own example is never installed broken:

- `SERENA_HOME` absolute, in backslashes and space-free (fix row `serena-windows-home`).
- The TypeScript shim patch (fix row `serena-windows-ts-shim`). Right after registering serena, apply pre-warms it
  with the exact registered spec (`uvx --python <p> --exclude-newer <d> --from serena-agent@<pin> serena --help`), so
  uv has fetched the package, then applies the patch.

Both appear in the plan the user confirms. The user ruled on 2026-10-27, twice, against a launcher: the patch is
re-applied after install, inside every serena update, and by `/preferred-tools:fix`.

## The install command - `commands/install.md`

`disable-model-invocation: true`. Mirror alfred-code's configure walk (`../alfred-code/setup-plugin/references/walk.md`):
a script renders every table, every question is an ask with one option marked `(Recommended)` and listed first, and
nothing is applied before one confirmation.

Two rules hold for every command and the skill:

- **Script paths.** A command's shell runs in the user's project, so every script call is spelled
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/<file>"` and every catalog path `"${CLAUDE_PLUGIN_ROOT}/catalog/<file>"`, as
  alfred-code's `setup-plugin/commands/status.md` does. The short `scripts/<file>` below is that spelling, abbreviated.
- **Asks within the AskUserQuestion limits** (1-4 questions per call, 2-4 options each). Any choice among more than
  four items uses step 4's shape: multi-select questions of at most four options, grouped by the catalog's four groups,
  at most four questions per call, and a second call past sixteen items. Two pick lists start with a single-select
  first: the fix and update offers ('All of them (Recommended)', 'Pick which', 'Skip'). The install pick (step 4) opens
  straight on the grouped multi-selects. Remove opens on 'Pick which (Recommended)' or 'Cancel', never on 'All'.

1. `node scripts/inventory.js --project <cwd> --json <tmp>` - reads `.mcp.json`, the account file (`scripts/account.js`; user and this
   project's local entries) and `claude plugin list --json`; never starts a server. Missing `claude` CLI: stop with one
   line. A file that is not valid JSON: name it, treat its scope as unreadable, offer nothing that writes there.
2. `node scripts/table.js <tmp>` - one numbered table of the whole catalog for this OS: row, kind, routes, and per scope
   what is installed (name, route, pin). The table comes back in the tool result, never via a file.
3. Ask: 'Add or change tools (Recommended)', 'Remove tools' (only when something is installed), 'Done'.
4. Add or change: ONE AskUserQuestion call of up to four multi-select questions, at most four options each, grouped -
   Code (serena, memory, typescript-lsp, csharp-lsp); Docs and forges (context7, github, gitlab, atlassian); Browsers
   (the four engines); Machine and monitoring (appium, this OS's desktop control, sentry, claude-hud). On Linux the
   last group has three. An installed row's label says `(installed as <name>, <scope>)`.
5. Ask once: 'Use the recommended settings for all (Recommended)' or 'Set each tool'. Set each, per tool:
   - first, its own call for two-route rows only - route: 'Remote' or 'Local', recommended remote where it needs no
     local runtime;
   - then one call of up to four questions, each with two or more options and the recommended one first. Its scope
     options follow from the route just answered (`project` offered only where 'Scopes and paths' allows it), and
     `plan.js` rejects a forbidden route and scope pair, with a test:
   - scope: 'local', 'project', 'user', recommended as in 'Scopes and paths';
   - name: 'Keep `<original name>` (Recommended)' or 'Use `<project folder name>-<original name>`', 'Other' for any
     name;
   - location (only for rows with `locations`): the root - 'Keep `<default>` (Recommended)' or the other place from
     'Locations' (project or account folder), 'Other' for a typed path; the walk then prints the derived paths;
   - browser rows only, in the same call: 'Default for this engine (Recommended)' - for chrome and msedge, the branded
     browser installed on the machine; for firefox and webkit, Playwright's own build - or 'A browser binary I name'.
     The second option takes the path through 'Other' or a follow-up ask, and sets `--executable-path`.

   `plan.js` emits every question, and its tests assert that each one has 2 to 4 options.
6. Prerequisites: `node scripts/prereq.js <picks>` checks `uvx`, `npx`, Node 22.22.2+, Docker or the github binary,
   `typescript-language-server` + TypeScript 6, `csharp-ls`, the Android SDK and a JDK for appium. A missing one: say
   the install line and ask 'Install it now', 'Skip this tool (Recommended)' or 'Register anyway'.
7. Plan: `node scripts/plan.js <tmp> <answers>` prints every CLI call and every file it writes. For a picked plugin
   whose marketplace `claude plugin marketplace list` does not show, the plan starts with
   `claude plugin marketplace add <repo>` (`jarrodwatts/claude-hud`, `anthropics/claude-plugins-official`). One ask: 'Apply
   (Recommended)', 'Change something', 'Cancel'.
8. Apply: `node scripts/apply.js <plan>` runs the calls in order, stops at the first failure, and leaves everything
   applied before it in place, named. Then re-run step 1 and print the read-back: each picked tool's name, scope and
   route as the CLI now reports them. Then `claude mcp get <name>` per new server for its status, and the restart
   line (project-scope servers also need the trust prompt on the next session start).
9. Remove: 'Pick which (Recommended)' or 'Cancel', then the installed rows in the grouped multi-select shape, one
   option per registration (a row at two scopes is two options), then `claude mcp remove` / `claude plugin uninstall` at the scope shown. Data folders stay; the
   report names them.

A re-run with the same answers runs no CLI call and says so.

## claude-hud - the status line and the recommended settings

alfred-code's init and configure already do this. Its walk installs claude-hud, writes the statusLine, then offers
the recommended claude-hud settings as one apply-or-skip ask. Port that step; the only changes are the three
`hud-statusline.js` flags described below. Read the three sources first:

- `../alfred-code/meta/plugin-settings.json` - the catalog. The claude-hud row has two targets:
  - `plugins/claude-hud/config.json` - Compact layout without separators; config counts, skills, MCP, agents, tools,
    cost, effort level and prompt cache shown; git ahead/behind and file stats.
  - `settings.json` - `statusLine.refreshInterval: 5`, gated by `requires_path: statusLine`.

  Each key carries a `why`, the row a `verified` line and `scope: account`. `chosen_by` makes a `layout` key the user
  set count as their choice.
- `../alfred-code/scripts/plugin-settings.js` - the tool, with its four rules:
  1. add-only by default, `--replace` to overwrite a differing key;
  2. a `requires_path` target is skipped when that path is absent;
  3. `chosen_by` is honoured, and a target that is not a JSON object is skipped, never written over;
  4. the account `settings.json` is backed up to `settings.json.bak.<YYYYMMDD-HHMMSS>` before its first write of a
     run. A failed backup writes nothing.

  Its `--check` prints one `missing`, `differs` or `match` line per key.
- `../alfred-code/scripts/hud-statusline.js` - writes the statusLine entry, then applies the row. The entry goes into
  the account `settings.json` for a user-scope claude-hud, and into the project's `settings.local.json` for one
  installed for this project alone. All paths resolve against `CLAUDE_CONFIG_DIR`, else `~/.claude`.

Copy them as `catalog/plugin-settings.json`, `scripts/plugin-settings.js` and `scripts/hud-statusline.js`, along with
their tests (`scripts/plugin-settings.test.js` and `scripts/hud-statusline.test.js` there). Four alfred-code modules
they require come along too:

- `scripts/install/json-file.js` - copy it.
- `scripts/install/stamp.js` `accountDir` - replace it with a one-line stand-in: `CLAUDE_CONFIG_DIR`, else `~/.claude`.
- `stack/hooks/shell-writes.js` `MOUNT_RE` - copy the regex into `hud-statusline.js`.
- `stack/hooks/hook-prelude.js` `blockingStdio` - copy the function into `scripts/json-file.js`.

After the copy, `grep -n "require(" scripts/` names no file outside this repo. Re-read the row's `verified` keys against the installed claude-hud
(`dist/config.js` `DEFAULT_CONFIG`), and update `verified` only when every key still exists there.

**In the install walk**, as in alfred-code's (`../alfred-code/setup-plugin/references/walk.md`, 'Plugin settings'):

1. When claude-hud is picked, or kept while already installed, run `node scripts/hud-statusline.js --check`. It
   prints `planHud`'s targets: the row as it lands after the statusLine write, the refresh interval included, and
   with the guard that never adds a refresh interval to a statusLine that is not claude-hud's (`rowTargets`).
   `plugin-settings.js --check` alone would miss the refresh interval on a fresh account. Every call to either script
   passes
   `--catalog "${CLAUDE_PLUGIN_ROOT}/catalog/plugin-settings.json"` and `--config-dir <account dir>`, because the ported
   defaults point at alfred-code's `meta/` and at `~/.claude` without reading `CLAUDE_CONFIG_DIR`. `hud-statusline.js`
   also gets `--project <cwd>` for a claude-hud installed for this project alone.
2. Paste its output verbatim in a fenced block.
3. Ask once, with the counts:

```ask
Apply the recommended claude-hud settings? <n> missing, <m> differing, <k> matching.
- 'Apply recommended (Recommended)' - adds only the missing keys; every value already chosen is kept
- 'Apply and replace differing' - adds the missing keys and overwrites the differing ones
- 'Skip' - nothing changes
```

The statusLine is not behind this ask. alfred-code writes it as its own init item
(`../alfred-code/setup-plugin/references/init-bootstrap.md`), so here it is written whenever claude-hud is installed
or kept, add-only, by `hud-statusline.js --statusline-only`. The port gains three flags, each with its own test:

- `--check` - print the plan;
- `--replace` - apply it with differing keys overwritten;
- `--statusline-only` - write the statusLine alone.

All three go through `planHud`, so the guard and the project-scope routing (`settings.local.json`) hold for every
answer. The answer is applied after the plugin install:

- 'Apply recommended' runs `hud-statusline.js` (statusLine plus the row, add-only).
- 'Apply and replace differing' runs `hud-statusline.js --replace`.
- 'Skip' runs `hud-statusline.js --statusline-only`, so claude-hud still shows on screen.

No catalog row for a picked plugin means
no ask. `/preferred-tools:install hud` jumps straight to this ask for an installed claude-hud.

**After an update.** When the update skill moves claude-hud to a newer version, it re-runs `--check`, and it names
any catalog key the new `DEFAULT_CONFIG` no longer holds. It never removes such a key.

The same catalog takes a row for another plugin later. Each row's keys are read from that plugin's own source,
never from memory.

## The fix command - `commands/fix.md` and `catalog/fixes.json`

`disable-model-invocation: true`. `node scripts/fix.js --detect` runs every fix row's detector over the inventory
and the machine and prints one table: row, tool (by registration name), what was found. Then one ask: 'Apply all found
(Recommended)', 'Pick which' (the grouped shape), 'Skip'. `scripts/fix.js --apply <ids>` applies each pick. A
registration fix rewrites the entry through the CLI (remove, then add-json with the same name and scope). A file fix
(the shim patch) edits the package file and keeps a `.bak`. Each fix is read back, then the restart line is printed. A
row whose detector finds nothing is not shown. `/preferred-tools:fix <tool or id>` narrows it.

A fix row: `id`, `tool`, `os`, `symptom` (what the user sees), `detect` (the name of a function in `scripts/fixes/`),
`fix` (the same), `verifiedOn` (tool version and OS the fix was proved on), `source` (where the lesson comes from). Seed
rows - each `source` line is the alfred-code file to read for the detail:

| id | Symptom | Fix | Source |
|---|---|---|---|
| serena-windows-home | serena's TypeScript language server fails to start on Windows (`'.serena' is not recognized as an internal or external command`): serena runs it through npm's `.bin` shim, which hands `SERENA_HOME` to cmd.exe unquoted, so a `/` or a space in it cuts the path | `SERENA_HOME` absolute, in backslashes, with no space (default `C:\Users\<name>\.serena` when the profile path has none, else a space-free folder the user picks). Absolute, so a session started in a subfolder finds the same home and does not download serena's ~327MB of language servers again. Re-verify on the current serena pin - the record says 1.7.0 to 2.1.0 | `serena-launch.js` header (f779a349) |
| serena-windows-ts-shim | every serena symbol and reference tool fails for the session on Windows: serena's solidlsp spawns npm's extensionless POSIX shim `.bin/typescript-language-server`, which cmd.exe cannot run, so the TypeScript server dies at init (upstream oraios/serena#311) | Port of `../alfred-code/scripts/fix-serena-ts-windows.ps1` to Node (`scripts/fixes/serena-ts-shim.js`). Detect: every `solidlsp/language_servers/typescript_language_server.py` under `%LOCALAPPDATA%\uv` whose `_create_launch_command` body is still `return [core_path, "--stdio"]` and has no `serena-win-fix` marker. Fix: on Windows, run `node <typescript-language-server>/lib/cli.mjs --stdio`, falling back to `<core_path>.cmd`, with a `.bak` beside it. A method whose body differs is skipped and named ('patch manually'), never forced. TRANSIENT: a uvx upgrade re-extracts the package and wipes the patch, so the update skill re-runs this detector after every serena bump. Step 1 checks whether serena#311 is fixed on the current pin, and the row is retired when it is | `scripts/fix-serena-ts-windows.ps1` |
| uvx-python | a uvx server dies at start with `CONNECTION_CLOSED` (pyyaml 6.0.2 has no CPython 3.14 wheel) | add the row's `--python` | `uv-python.js` header |
| windows-arm-python | a uvx server fails to build wheels on Windows ARM64 | the x64 CPython build for the row's minor | `docs/uv-python-pin-evidence.md` |
| windows-npx-cmd | an npx server never connects on native Windows | wrap the command in `cmd /c` | Claude Code MCP docs (verify) |
| playwright-webmcp | page-registered WebMCP tools appear beside Playwright's own | add `--no-webmcp` | `browser-launch.js` header |
| appium-sdk-env | appium cannot find the Android SDK or a JDK (Claude Code started from the dock or an IDE) | look up `ANDROID_HOME` / `JAVA_HOME` and set them in the registration's `env` | `mobile-launch.js` header |
| serena-telemetry | serena sends a usage ping at every start | `SERENA_USAGE_REPORTING=false` | `serena-launch.js` |
| typescript-lsp-ts7 | typescript-lsp shows no diagnostics (TypeScript 7 ships no `tsserver.js`) | `npm install -g typescript-language-server typescript@6` | alfred-code `meta/stack-manifest.json`, the typescript-lsp row |

A new problem the user meets later becomes a new row, with its `verifiedOn`.

## The update skill - `skills/update-tools/SKILL.md`

Model-invocable, description under 160 chars, starting 'Use when' (for example: 'Use when updating the preferred
tools - installed MCP servers and plugins - or when one is behind its release.'). It runs `node scripts/update.js`:

- Plugins: every plugin installed on this machine, catalog or not. Refresh each marketplace they come from
  (`claude plugin marketplace update <name>`), then, at every scope `claude plugin list --json` reports a plugin at,
  offer `claude plugin update <spec> --scope <scope>` where the marketplace version is newer than the installed one.
  (Verify that `plugin list --json` gives both versions; if not, read the version from the marketplace clone.) Catalog
  plugins and other plugins are two groups in one table, and the ask follows the grouped shape.
- MCP servers with a pin: the registry's latest (`npm view <pkg> version`, `https://pypi.org/pypi/<pkg>/json`), offered
  only once it is 7 or more days old. A table shows current -> offered, then the ask: 'Update all offered
  (Recommended)', 'Pick which', 'Skip'. Each pick is rewritten through the CLI with the new pin and a cut-off of the bump
  day, under the same name and scope, then read back. A serena bump on Windows includes the shim patch in the same
  run, as part of the confirmed update: pre-warm the new pin, apply `serena-windows-ts-shim`, then read it back. A
  remote route has no pin and is skipped with a line.
- Language servers on PATH: reported (`typescript-language-server --version`, `csharp-ls --version`), updated only on
  the user's yes.
- Nothing behind: one line, `preferred-tools: everything current`.

`catalog/tools.json`'s own pins move only through a repo script (`npm run refresh-pins`), never during an update.

## Repo layout

```text
.claude-plugin/plugin.json    name preferred-tools, version 0.1.0, description, author envoydev
commands/install.md
commands/fix.md
skills/update-tools/SKILL.md
catalog/tools.json            the 17 rows: kind, original name, routes, fingerprint, args/url, env, locations, pins, os, prereqs, dangerous tools
catalog/fixes.json
catalog/plugin-settings.json  the recommended plugin settings, ported from alfred-code (the claude-hud row)
scripts/                      inventory.js, table.js, prereq.js, plan.js, apply.js, fix.js, fixes/, update.js, plugin-settings.js, hud-statusline.js, json-file.js, account.js, refresh-pins.js - Node 22, no dependencies
tests/                        node:test, one file per script
docs/sources.md               every external fact with its URL and the date read
CLAUDE.md                     EXISTS - this repo's invariants and the plugin facts it relies on; keep it current, never replace it
.claude/skills/plugin-authoring/  EXISTS - the plugin authoring skill, copied from alfred-code; load it before writing any plugin file
docs/plugin-cli-evidence.md   EXISTS - measured plugin CLI behaviour (install over installed, the list flag, renames)
README.md
package.json                  scripts: test, lint (JSON schema checks), refresh-pins
```

## Steps, in order

Each step ends with its check; the next step starts only when it passes.

1. **Verify the outside facts.** Through the vendor's own docs (`WebFetch`, or a documentation server if registered):
   every (verify) item above, the current pins, `claude mcp add-json` and `claude plugin` flags, `.mcp.json` variable
   expansion (`${VAR}`, `${VAR:-default}`, whether `CLAUDE_PROJECT_DIR` or `${CLAUDE_PLUGIN_ROOT}` expand there), the
   Windows `cmd /c` rule, the marketplace source shape for a plugin in another repo, `claude --plugin-dir`, and whether
   oraios/serena#311 is fixed on the current serena pin. Write `docs/sources.md`.
   Check: every catalog row and every (verify) item has a source line; anything that changed is changed in the
   catalog, not left in the prompt.
2. **Scaffold** the layout and `plugin.json`. Read `CLAUDE.md` and `docs/plugin-cli-evidence.md`, and load the
   `plugin-authoring` skill first. Check: `claude plugin validate . --strict` passes.
3. **Catalog** - `catalog/tools.json` and `catalog/fixes.json`, plus a test that every row has the fields its kind needs
   and every fingerprint is unique. Check: `npm test` green.
4. **Inventory and fingerprint** with tests: a custom name, a user's own server, a row at two scopes, an empty, missing
   and malformed `.mcp.json`. Check: tests green.
5. **Entry building** (`plan.js`) with tests per OS (macOS, Linux, Windows x64, Windows ARM64), per route, per scope,
   names at and over the 64-char limit, a reserved name, no catalog default in the reserved set, a collision, and on
   Windows a serena entry whose `SERENA_HOME` is absolute, in backslashes and space-free. Check: tests green.
6. **Apply** with a fake `claude` on PATH that records its argv. Check: tests green, a re-run makes no call.
7. **Temp-project harness** - `tests/harness.js`. It creates a throwaway project under the session scratchpad and a
   throwaway account dir, points `CLAUDE_CONFIG_DIR` at the account dir, and checks first that the `claude` CLI writes
   there and not to the real `~/.claude.json` (if it does not, user-scope cases run only with the user's go). The walk's
   asks are stood in for by an answers JSON fed to `plan.js` and `apply.js`, so every matrix case is a script run with
   no model in the loop. The account dir has one definition, `scripts/account.js`, used by every script: the dir is
   `CLAUDE_CONFIG_DIR`, else `~/.claude`; the account file is the one the CLI was measured writing here
   (`$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json` - verify). Check: a no-op case leaves the real
   `~/.claude.json`, `~/.claude/settings.json` and `~/.claude/plugins/claude-hud/` byte-identical, and so does every
   later matrix case.
8. **claude-hud** - the three ported files and their ported tests, the row re-read against the installed
   claude-hud's `dist/config.js`, plus the `--check`, `--replace` and `--statusline-only` flags and their tests (a
   fresh account's check counts the refresh interval; replace beside a foreign statusLine adds no refresh interval). Check: the ported tests pass
   unchanged except for paths. They cover the add-only default, replace, the `requires_path` skip, `chosen_by`, a
   non-object target, and the backup before the first write - none when nothing is written, nothing written when the
   backup fails.
9. **Fixes** - `fixes.json`, `scripts/fixes/`, `fix.js`, `commands/fix.md`, a test per detector (found and not found);
   the shim patch is tested on a copy of a `typescript_language_server.py` fixture (patched, already patched, changed
   method skipped).
10. **The install command** - `commands/install.md`. It needs steps 8 and 9: the walk runs the claude-hud scripts
    and the serena shim fix. Check: the harness runs a fresh-install case for every row from an answers file and
    reads back the result.
11. **Update** - `update.js` and the skill, plus `scripts/refresh-pins.js` (`npm run refresh-pins`). It moves
    `catalog/tools.json`'s pins and cut-offs to each registry's latest that is 7 or more days old. Both are tested
    against a fake registry response: an offer, nothing behind, a too-new release held back, and the serena bump on
    Windows carrying the shim patch.
12. **Temp-project matrix**, every case through step 7's harness. Cases: fresh install; re-run (no change); a custom
    name, then a rename; an update past the catalog pin, then a rename (the updated pin and a user-added arg are
    kept); claude-hud with 'Skip' (statusLine written, no catalog key); the four Playwright engines in one project, each under its own name and location (four
    entries, four distinct `--user-data-dir` values); a token check (fake token values set in the env, every token
    route installed, then a search of every written file for those values finds none); a project-scope measurement
    per local row (register it at `project` with a relative root, start the server once from the project root and
    once from a subfolder, and check where its data lands; set the row's `projectScope` to `true` only when both
    land under the project root, and record the result in `docs/sources.md`); a user's own server under a catalog name (asked, not overwritten); missing,
    empty and malformed `.mcp.json`; each of `local`, `project`, `user`; a remove; each fix detector on a seeded broken
    entry; an update with a stale pin; claude-hud's recommended settings applied once with a user value present (kept), then with
    'Apply and replace differing' (overwritten, backup written). Read the written `.mcp.json`, the account file and `settings.json` after each,
    never the exit code alone.
13. **Live check - the user's step**, on this machine (macOS) with the real account. The build session cannot type into
    a nested interactive session, so it prints a checklist and waits for the user's go:
    - create a scratch project (the exact `mkdir` line);
    - start `claude --plugin-dir <this repo>` there (verify the flag in step 1);
    - run `/preferred-tools:install` once, picking serena, memory, context7, one browser and the LSP pair;
    - run `claude mcp get <name>` per server, then `/preferred-tools:fix` and the update skill once each;
    - paste the read-back into this session.

    The build session reads the pasted output and records PASS or the failure. With no go, the step is NOT RUN.
    Cleanup is on the same checklist, and its read-back is pasted too:
    - run the Remove round at every scope used, and uninstall the plugins installed for the scratch project;
    - delete the scratch folder;
    - read `claude plugin list --json` and the `mcpServers` of `~/.claude.json` to confirm no scratch registration
      or plugin record remains. The `projects` entry Claude Code keeps for any folder a session ran in is its own;
      report it, do not hand-edit it.

    Windows-only rows (windows-control, serena-windows-home, serena-windows-ts-shim, windows-npx-cmd,
    windows-arm-python) are proved on the user's Windows VM the same way, or reported NOT RUN.
14. **Close.** Commit on a branch (not the default branch), push only on the user's word. Report: each step's check
    with its result, the matrix with every case PASS or NOT RUN, and the hand-off below.

## Acceptance criteria

- `claude plugin validate .` passes; `npm test` is green.
- The install walk installs each of the 17 rows on an OS it supports, by either route where it has two, under a custom
  name, at every scope the row allows (`projectScope`), with a custom location root, and a re-run with the same answers
  makes no CLI call.
- Each Playwright engine can be installed under its own name and location in the same project.
- Inventory recognises a catalog tool under any name and never lists or touches a registration it does not match.
- No file the plugin writes contains a token; `.mcp.json` holds only relative paths and `${VAR}` references.
- `/preferred-tools:fix` finds and fixes a seeded `serena-windows-home` entry and a seeded unpatched
  `typescript_language_server.py` (fixtures here; live on Windows or NOT RUN).
- Every script call in a command or skill body is spelled under `${CLAUDE_PLUGIN_ROOT}`, and the user's live check ran
  the commands from a project that is not this repo - or the report says NOT RUN.
- The update skill offers a newer pin, rewrites the registration under the same name and scope, and says
  `everything current` when nothing is behind.
- Picking claude-hud ends with the recommended-settings ask; each of its three answers writes exactly what
  `hud-statusline.js --check` reported for it (the statusLine alone for 'Skip'), and `/preferred-tools:install hud` reaches the same ask on an installed claude-hud.
- Nothing is applied before the plan's confirmation; a failure mid-apply leaves the earlier steps in place, named.

## Risks

- A registration rewrite (fix, update, rename) loses the server for a moment, and fails between remove and add: apply
  adds first under a temporary name where the name changes; for a same-name rewrite, it saves the old JSON to
  `<tmp>/rollback.json` and re-adds it when the add fails, and the report prints the line that restores it by hand.
- A vendor endpoint or package moves after step 1: the update skill re-reads the registry; a remote route that stops
  answering shows as failed in `claude mcp get`, and the fix is a catalog change plus a re-run of install.
- Supply chain: pins plus the cut-off; the 7-day age gate on updates; appium-mcp 1.97.1 had 20 critical and 21 high
  npm advisories on 2026-10-21 (alfred-code's `shipped-mcps.json` pins) - the walk shows the current count from
  `npm audit` before appium is applied (verify the command works for an npx package; if not, name the gap).
- A user's own server under a catalog name: identity by fingerprint keeps it out of the walk; a name collision is an
  ask, never an overwrite.
- Trade-off: plain registrations freeze per-machine values at install time, where alfred-code's launchers
  re-resolved them at every start. What is frozen is narrow: uvx still resolves the `--python` request at each start,
  so only the request string is fixed (the x64 build string on Windows ARM64 - one more reason a uvx row's local
  route is `local` scope). The Android SDK and JDK paths in appium's `env` are fixed too. A moved SDK is caught by
  `/preferred-tools:fix` (`appium-sdk-env` checks that the paths still exist).
- The serena shim patch is a file edit in uv's cache, lost on every serena upgrade or uv cache wipe. Mitigation: the
  install applies it after a pre-warm, and a serena update re-applies it in the same run. Gap: a wipe outside an
  update (`uv cache clean`) leaves serena broken until `/preferred-tools:fix` runs. The user accepted that gap on
  2026-10-27 over a launcher.
- Three servers expose a tool that runs arbitrary code (Playwright's `browser_run_code_unsafe`, windows-mcp's `App` in
  mode `launch_executable`, macos-mcp's `Shell`). This build adds no guard of its own; see the deny-row line under
  'Optional'. Where alfred-code is installed, its `guard-desktop-exec` hook already gates all three by tool name
  under any server name.
- Two owners between this repo's first push and alfred-code's hand-off 2. Until then, alfred-code still lists
  claude-hud and the LSP pair among its picks, and its update installs an absent pick. So it would undo a
  preferred-tools Remove of them. Mitigation: while `claude plugin list --json` shows alfred-code enabled, the walk
  marks those three rows 'also managed by alfred-code' and says a Remove holds only once alfred-code's hand-off has
  shipped. Hand-off 2 closes the gap.
- Backward compatibility: a project still on alfred-code 2.10.0 or older has the stack's servers under the reserved
  names; the walk shows them as 'alfred-code (retired)' and offers nothing over them until alfred-code's update has
  removed them.

## Rollback

Every server is one `claude mcp remove <name> -s <scope>`; every plugin one `claude plugin uninstall <spec> --scope
<scope>`; the install command's Remove round does both. Uninstalling `preferred-tools` itself leaves every registration
working (none depends on it). The only irreversible-looking step - a location change - moves no data. claude-hud's
statusLine write is add-only and named in the report so it can be deleted by hand; the recommended settings back up
the account `settings.json` before their first write (`settings.json.bak.<timestamp>`), and the `config.json` keys
they added are listed in the report.

## Assumptions - each wrong one changes the design

- `claude mcp add-json` / `remove` / `get` and `claude plugin install|update|uninstall|list --json` keep their current
  flags (step 1 verifies).
- Claude Code launches a stdio server from the session's start directory, so a relative path resolves against the
  project when the session starts at its root (step 12 measures it per tool; a tool that fails loses `project` scope
  for its local route).
- `CLAUDE_CONFIG_DIR` isolates the account file for the matrix (step 7 checks it first).
- 'Set their core location' means where each tool keeps its data (profiles, index, database, captures), plus
  Playwright's browser binary as an optional extra. If the user meant something else, it is one more entry in a row's
  `locations` list, not a design change.
- 'Update all local plugins' means every plugin installed on this machine plus every catalog MCP server registered
  for this project or user. Nothing is updated without a pick.
- The alfred-code `envoydev` marketplace can list a plugin whose source is this repo (step 1 reads the marketplace
  docs).

## Out of scope

- No MCP server is bundled or launched by the plugin; no daemon, no SessionStart hook.
- No edit to `../alfred-code` in this run - its changes are the hand-off below.
- No Cursor twin.
- No hand-edit of `.mcp.json` or `~/.claude.json`.

## Hand-off - alfred-code changes, a separate session there

Report these as next steps; they follow this repo's first push, in this order:

1. **Marketplace entry.** alfred-code's `.claude-plugin/marketplace.json` (marketplace name `envoydev`) is generated by
   `scripts/build-marketplace.js`, and every entry it generates has `source: './'`. The generator keeps an entry it
   does not own (`applyToMarketplace`: anything not generated, not retired or folded, and not an MCP-only entry). So
   the `preferred-tools` entry, sourced from this GitHub repo in the shape step 1 verified, is written by hand. Then
   `npm run marketplace` confirms it survives, and `npm run lint` confirms lint accepts an entry with an outside
   source; if lint refuses it, that is a lint change there. Users then run
   `claude plugin install preferred-tools@envoydev`.
2. **Hand-over of claude-hud and the LSP pair.** alfred-code stops installing and configuring them (its plugin layer,
   `meta/evidence.json`, `meta/recommendations.json`, `scripts/hud-statusline.js`, the LSP binaries init installs). It
   must NOT retire them the usual way: its retire path uninstalls a retired plugin on the next update, which would
   remove what preferred-tools now owns. Instead it drops them from its install record, so its update and uninstall
   leave them alone, and prints one line naming `preferred-tools` as their new home. That change follows alfred-code's
   own rules (a spec, its temp-project matrix, a version bump).

## Optional

- Recommended - deny rows for the three code-running tools. Reason: without alfred-code's hook, nothing stops them.
  For each picked server the walk would offer a `permissions.deny` row `mcp__<registration name>__<tool>` in the
  scope's settings file. The write would be add-only, with the same backup before the first write as
  `plugin-settings.js`, and the Remove round would take the row out with its server. A permission rule cannot see a
  mode, so denying windows-mcp's `App` also loses launch, switch and resize. So it would recommend 'No deny' for
  `App` where alfred-code is enabled for the project (its hook gates only `launch_executable`), and 'Deny' everywhere
  else.
- Recommended - `/preferred-tools:status`, a read-only print of the install walk's table (`table.js`), since the walk already renders it.
- Recommended - a `docs/tools/<row>.md` page per tool with why it was chosen and its quirks, matching the repo's
  purpose of collecting tested tools.
- Not worth it - a local GitLab route through a community server (such as `@zereight/mcp-gitlab`): third-party, and
  it holds a token in its env. It is only worth adding for a self-managed GitLab too old to serve `/api/v4/mcp`.
- Not worth it - a per-project names file; identity by fingerprint already covers custom names.
- Not worth it - a launcher layer for runtime adaptation; `/preferred-tools:fix` covers a changed machine.

## Revisit when

- Claude Code lets a plugin's server take a per-project name - then plugin-declared servers beat plain registrations.
- A fix row is applied on the same machine more than twice - the install-time rule behind it is wrong.
