# Build prompt - the preferred-tools plugin

Paste this into a Claude Code session opened at the root of this repository (`preferred-tools`). It is self-contained:
everything it relies on is either stated here or named with the file to read.

Graded 2026-10-27 by independent reviewers: 79 -> 79 -> 88 -> 95; six findings fixed after the last grade.

---

You are building `preferred-tools`, a Claude Code plugin in this repository. The repo collects the tools its owner has
tested and likes - MCP servers and Claude Code plugins - with their install, update, rename, relocation and fix
procedures. The plugin installs nothing by itself: the user drives it through four manual commands.

## Goal

1. `/preferred-tools:install` - a guided walk over the tools NOT installed yet: pick tools, then per tool the route
   (remote or local, only where the tool has both), the scope, the registration NAME and the data LOCATION; then apply,
   read back and report.
2. `/preferred-tools:configure` - the same walk over what IS installed: pick a registration or a plugin (one option
   each; a tool at two scopes is two), then change its route, scope, name or location, a plugin's scope, or
   claude-hud's settings, or remove it. Every question recommends what the pick has now.
3. `/preferred-tools:fix` - detects known problems in the installed tools (the first one: serena's TypeScript language
   server failing on Windows) and applies the recorded fix.
4. `/preferred-tools:update` - brings every installed plugin and every registered catalog server up to date when it is
   behind, and says so in one line when nothing is. It was built as the model-invocable `update-tools` skill; the
   user's ruling of 2026-10-27 made it a command (see 'The update command').

**The user's ruling, 2026-10-27: install is install, configure is configure.** The first build had one install walk
that also changed and removed. It is split: install offers only the rows not installed here, and configure owns the
change, the remove and the claude-hud settings ask for an installed claude-hud. A configure pick is keyed
`mcp:<name>~<scope>` or `plugin:<id>~<scope>` (the update command's offer ids), so one of two registrations of a row is
changed and the other is left. The plan (`answers.change`) builds the change from the registration as read, exactly as
before.

**And the same day: a project may have its own copy.** A tool installed for every project (user scope) is still offered
by install, labelled `(installed for every project ...)`. Picking it ADDS this project's registration beside the
account-wide one, which is never changed or removed; install never renames, moves or rewrites anything (an install pick
already there under its name and scope is reported unchanged), and a rename or move is configure's alone. The copy's
questions leave out the scope already taken. A row whose data defaults to the account folder (memory) defaults to the
project folder for a copy, so the copy starts empty and, under the same name, hides the account-wide data in this
project; 'Keep' at the location question shares it. A server installed in this project, or a plugin at its recommended
scope (so claude-hud at user scope), is configure's; a server at Global scope is offered for a copy even where Global is
its recommended scope (a hosted keyed route, 0.2.0 D5).

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
| gitlab | MCP | `gitlab` | remote | GitLab's own hosted server, `https://<host>/api/v4/mcp` (gitlab.com or a self-managed host); a key (`GITLAB_TOKEN`, a fine-grained personal access token, `Bearer`) since 0.3.0, OAuth with none; GitLab ships no local server, so the route is remote only |
| atlassian | MCP | `atlassian` | remote | Atlassian's hosted Rovo MCP server, `https://mcp.atlassian.com/v2/mcp`; a key (`ATLASSIAN_API_TOKEN`, `email:api_token`, `Basic`) since 0.3.0, OAuth with none |
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

A route's key mode sits in `authMode` (`token`, `oauth`, `optional-token`), and a hosted route that signs in with OAuth
when no key is chosen carries `keyless: "oauth"`. No field is named like a credential unless it holds a `${VAR}`, a
variable's name or a flag (a test in `tests/catalog.test.js`): a secret guard reads a string under such a name as a
key, and 0.2.0's `auth` and `noKey` made one treat the whole catalog as a key file (the user's ruling, 2026-11-11:
rename them here rather than ask a guard to learn the mode words).

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
command, with no ledger file to drift. A registration that matches no row is the user's and is never touched. Two
files are the exceptions to 'no ledger' (the user's rulings, 2026-11-10): the record `<root>/preferred-tools.json`,
which holds each answer about a server already set up (D6), and the roots map `${CLAUDE_PLUGIN_DATA}/roots.json`, which
finds a named root (D2). Neither names a tool's identity: a record entry whose fingerprint no longer matches is dropped
and asked again.

**Names.** The default is the row's original name. The user can name another per project (asked next, in one plain line).
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

**Locations.** Since 0.2.0 a tool's data folder is `<root>/<registration name>` in its scope family's root folder
(D2, below): the root is asked once a run, not per tool, and the per-tool question survives only for memory (the
global root's shared folder or this project's own), serena on Windows (a space-free folder), alfred-code 2.x data on
disk, and configure's 'The folder it uses now'. What follows is how a data folder's paths derive and the 0.1.x
defaults it replaced. A row with data has ONE location root. Every path argument or env key derives from it,
listed in the row's `locations` map:

- serena: `SERENA_HOME` = `<root>`;
- memory: `MCP_MEMORY_SQLITE_PATH` = `<root>/memory.db`;
- each browser: `--user-data-dir` = `<root>`, `--output-dir` = `<root>/output`;
- appium: `SCREENSHOTS_DIR` = `<root>/screenshots`, `PAGE_SOURCES_DIR` = `<root>/page-sources`.

Browser rows also take an optional `--executable-path` for the browser binary itself, unset by default so Playwright
uses its own, and asked as its own question (step 5). The default root is the plugin's own folder, never
alfred-code's (the user's ruling, 2026-10-27 - the plugin stands alone, and deleting `.alfred/` must not erase its
tools' data):

1. The project default `.preferred-tools/<registration name>/`. Since 0.3.0 memory follows its root like every other
   row (the user's ruling, 2026-11-11, 'Follow the root'): the project root at Project and Local scope, the global root
   at Global scope, so memories are shared across projects only when memory is installed at Global scope. 0.2.0 kept
   memory's default in the account folder `~/.preferred-tools/memory/`.
2. The alfred-code data already on disk, when present - the user's existing profiles, index and memories - is offered
   at install, never recommended ('alfred-code 2.x data'), saying the folder is alfred-code's. Read each row's
   old root from its entry in `original-mcps.json`, never from a pattern: serena `.alfred/serena/home` (its
   `SERENA_HOME`, not `.alfred/serena`), each browser `.alfred/<engine>-control`, appium `.alfred/mobile-control`,
   memory `~/.alfred-memory`.

The walk also offers the other place: the account folder `~/.preferred-tools/<registration name>/` for a project
default, the project folder for memory - each option only where it can be written at the scope, the recommended one
first (alfred-code's folder, below, changes which). Path form: since 0.3.0 `plan.js` writes the root resolved to an
absolute path at every scope, `project` included (the user's ruling, 2026-11-11, 'Absolute, always'), with `~`
expanded by the script (never left for the server). So a session started in a subfolder uses the same profile, index
and database. 0.2.0 wrote it relative at `project` scope; fix row `project-relative-path` rewrites such an entry.
`plan.js` has a test per scope. A folder the plugin creates gets a `.gitignore` holding `*`, so the project's own `.gitignore` is
never edited. Moving a location never moves data: the walk says where the old data is and leaves it. One exception
to the defaults: serena on Windows. Its root must be absolute, in backslashes and space-free (fix row
`serena-windows-home`), so that rule wins over the order above. The walk offers `C:\Users\<name>\.serena` when the
profile path has no space, else `<system drive>\serena-home`, and 'Another space-free folder' to type one. Since 0.3.0
serena's home on Windows is `<root>\serena` in its scope family's root when that folder is space-free, like every other
row's data; the offers above remain for a root with a space.

**alfred-code's folder (the user's rulings, 2026-11-10).** Where alfred-code is set up in the project - enabled for it,
and its `.alfred/.gitignore` there - three rulings replace the default above: 'Offer it, not default, but also do this
offer about alfred when alfred is present. also make it more undestandable about path, because ~/.alfred/ and .alfred/
makes no big different for me, I need more infromative route.'; 'when alfred is installed it suggesting .alfred for
root and for child if needed!'; and 'Project and local (Recommended)', whose description read 'User scope (every
project) keeps the account folder'. So `.alfred/<registration name>` is recommended at project and local scope for every
row (memory included since 0.3.0); user scope recommends the account folder. Without
alfred-code nothing changes. `.alfred/<name>` is never offered for a name alfred-code keeps for itself under `.alfred`
(`docs`, `state`, `statistics`, `workspace`, `flow`) or one a file already holds, and serena on Windows takes it at local
scope only when `<project>\.alfred\serena` is space-free. Each location option names the place in words - alfred-code's
folder in this project, This project's own folder, Your account folder, alfred-code 2.x data, The folder it uses now -
and its description gives the exact folder on this machine (at project scope the written form, and where it lands from
here and from a child). `plan.js --questions` maps each label to its answer (`answers`), and asks scope and name in a call
of their own before the location (`first`), because the folder is named after the registration and depends on the
scope. 0.2.0's relative folder at project scope landed in each folder Claude started in, a child or a subfolder
included; fix row `data-folder-ignore` writes the missing `.gitignore` (holding `*`) for such a copy, and for any data
folder, where neither the folder's own nor alfred-code's `.alfred/.gitignore` covers it. Its data is never moved or
deleted.

**Scopes and paths.** Every route offers user, project and local scope (the user's rulings, 2026-11-10: 'It must give
options as user/project/local' and 'Allow project, test first'), labelled Global, Project and Local (D1), the
recommended scope first, then Global, Project, Local - except a stdio route that needs a key, which is not offered at
project scope (D5: the committed file carries no key). A local route recommends `local`: its paths and Python are this
machine's, and project scope commits this machine's launch form (`cmd /c` on Windows, the x64 Python on Windows ARM64).
A hosted route recommends global scope when it will use a key (D5), and a key is the recommended answer for every
hosted route since 0.3.0; with no key it recommends `project`. A `project` registration lands in the committed
`.mcp.json`. Since 0.3.0 it carries absolute paths, like the other scopes (the user's ruling, 2026-11-11: 'Absolute,
always (Recommended)' - one data folder whatever folder Claude starts in, at the cost that `.mcp.json` names this
machine's path, so a teammate's clone points at yours); 'never a key' stands. 0.2.0 wrote a row's data folder relative
there when its `locations.relative` was `true` (measured by `tests/probes/relative-root.js`; `docs/sources.md`,
'Relative data folders - the probe'), else `${HOME}/...` (`${USERPROFILE}/...` on Windows), and serena on Windows
`${USERPROFILE}\.serena`; fix row `project-relative-path` writes each out. Plugins: `claude-hud` recommends `user`, the
LSP pair `project`.

**Secrets - `.mcps-secrets` (0.2.0, D3-D5; the user's rulings, 2026-11-10, replacing the key-file rule of 2026-10-29).**
Every key lives in `.mcps-secrets` in a root folder, written by the user alone; the plugin writes names only. A hosted
keyed route holds neither the key nor a `${VAR}` for it: its `headersHelper` runs `mcp-headers.js`, which reads the key
by name each time Claude Code connects. A stdio keyed route at local and global scope holds the value, written in by
`apply.js` from the root's file just before `claude mcp add-json`; it is not offered at project scope. A remote route
with no key prefers OAuth (the user runs `/mcp` once to log in). A key is never printed, asked for, or put in a file a
command line names (`scripts/kept.js`); the cost of the stdio route stays: the key travels as the `claude mcp add-json`
argument (the CLI takes the JSON no other way, `docs/sources.md`), visible in the process list while that call runs. A
configure move into `project` scope whose entry holds a credential outside the route's token field (a header of the
user's own, a userinfo URL) is a plan error naming the field.

What 0.1.x did, and why it was replaced: at local and user scope `apply.js` wrote the key in from alfred-code's store
when alfred-code was set up, else `.preferred-tools/.secrets`, then `~/.preferred-tools/.secrets`; at project scope the
committed entry kept `${VAR}`, read only from the environment Claude Code starts with. A hosted github then sent a bare
'Bearer ' while its key sat in a file (2026-11-10). Those files are read for names only now, so a line can say where a
key still sits and that preferred-tools no longer reads it.

**Per-OS rules, applied at install time** (each also a fix row): uvx servers get the row's `--python` (3.13; 3.14 for
windows-control) and on Windows ARM64 the x64 build (`cpython-3.13-windows-x86_64-none`) - `../alfred-code/docs/uv-python-pin-evidence.md`
says why; npx servers on native Windows get the `cmd /c` wrapper Claude Code's MCP docs ask for (verify); macOS and
Windows control are offered only on their own OS; pinned packages carry the dependency cut-off (`--exclude-newer
<date>` for uvx, `npm_config_before` for npx), as in `original-mcps.json`. Serena on Windows gets two more, so the
user's own example is never installed broken:

- `SERENA_HOME` absolute, in backslashes and space-free (fix row `serena-windows-home`; with none set, serena's default
  `<profile>\.serena` must be space-free too, so a registration made by hand on a profile path with a space is found).
- The TypeScript shim patch (fix row `serena-windows-ts-shim`). Right after registering serena, apply pre-warms it
  with the exact registered spec (`uvx --python <p> --exclude-newer <d> --from serena-agent@<pin> serena --help`), so
  uv has fetched the package, then applies the patch.

Both appear in the plan the user confirms. The user ruled on 2026-10-27, twice, against a launcher: the patch is
re-applied after install, inside every serena update, and by `/preferred-tools:fix`.

## Roots, keys and servers already set up - 0.2.0

**The user's rulings, 2026-11-10**, quoted in order: 'scope, dfinition must be global/project/local'; 'root folder for
preferred-tools must be .preferred-tools or .alfred (only when presen) or custom'; 'You must ask user about how he want
to handle the existing mcps, maybve he want that atlassian should not be the part of plugin and to be on it's own.';
'this implementation with secrets work and I guess we need to add it there' (the `headersHelper` script a workspace
session built); 'we need to have .mcps-secrets that will be in root of .preferred-tools or .alfred. It will contain mcps
data which is sensative and will be used by preferred-tools.'; 'approve' (stdio keyed routes only at local and global
scope, the 'on its own' choices saved in `<root>/preferred-tools.json`, the old key files pointed to by name and never
read for a value, the helper as a file); 'During install or configure ask user what token name or and other data env
will be for plugin or mcp'. They replace the key rule of 2026-10-29, 'Project scope keeps `${VAR}`' for keys, and 'no
ledger' for the record and the roots map only. 'Plain registrations, no launcher' stands: the helper starts no server.
Why: a hosted github and context7 sent no key because their `${VAR}` was not in the environment Claude Code started
with, while the key sat in a file (the user's Windows workspace, 2026-11-10).

- **D1 - Global, Project and Local.** The scope options read Global, Project and Local; the value stays `user`,
  `project`, `local` on the CLI and in every file. The plan says 'global (user scope)' the first time.
- **D2 - One root folder per scope family.** The project root serves project and local scope, the global root global
  scope. A root holds each tool's data folder `<root>/<name>`, the key file `.mcps-secrets`, the helper
  `mcp-headers.js`, the record `preferred-tools.json` and, unless it is `.alfred`, a `.gitignore` (`*`, `!.gitignore`,
  `!mcp-headers.js`). Options: project - `.alfred` (recommended where alfred-code is set up), `.preferred-tools`, a
  folder named inside the project; global - `~/.preferred-tools`, `~/.alfred` when it exists, a folder named. A root in
  use is listed first. Each root is asked once a run, only when a pick or an answer needs it. The roots map
  `${CLAUDE_PLUGIN_DATA}/roots.json` (folder paths only) finds a named root again; the commands pass
  `--data "${CLAUDE_PLUGIN_DATA}"` to every script that reads it.
- **D3 - The key file, `.mcps-secrets`.** The dotenv grammar - a value inside quotes stands as it is, and an unquoted
  value ends before a note after whitespace and `#` (`NAME=abc # work` is `abc`), the same in the helper and `keys.js`;
  the user writes every value. The apply's `ensure-key-name` appends empty `NAME=` lines only, refuses when git would
  not ignore the file, and leaves a UTF-16 file as it is (the plan's `Key:` line names the line to add). A hosted route's
  key is read by the helper from the root beside it (at local scope then a named global root), then
  `~/.preferred-tools/.mcps-secrets`, then `~/.alfred/.mcps-secrets`; a stdio route's by the apply (local: the project
  root, then the global root; global: the global root). The 0.1.x files (alfred-code's store, `.preferred-tools/.secrets`,
  `~/.preferred-tools/.secrets`) are read for names only, so a line can say where a key still sits.
- **D4 - The header helper, `mcp-headers.js`.** `scripts/mcp-headers.js`, Node built-ins only, first line
  `// preferred-tools mcp-headers <n>`, its SHA-256 pinned per number in `tests/lint.js`. `write-helper` copies it into
  the root when absent or lower; a higher number is never overwritten. A hosted keyed registration carries
  `headersHelper: node <path> <NAME> <SCHEME> [<global root>]` and no `Authorization` header - a path the shell would
  split is quoted (single quotes on macOS and Linux, double quotes in the committed `.mcp.json`, forward slashes on
  Windows, which cmd, PowerShell and Git Bash all pass whole); the helper prints
  `{"Authorization":"<SCHEME> <value>"}`, or `{}` and one stderr line naming the variable and the files when it finds
  none. Project and local helpers run only after the folder's trust is accepted, and not in a child folder (measured).
  Helper 2 prints a header only when Claude Code runs it - `CLAUDE_CODE_MCP_SERVER_NAME` is set (2.1.85+): run by hand,
  from a terminal or an agent's shell tool, it reads no key file and prints `{}` with one stderr line, so a key never
  lands in a transcript, with or without a secret guard installed (the user's ruling, 2026-11-11).
- **D5 - Routes and scopes.** A hosted keyed route (github; context7, sentry, gitlab and atlassian when a key is picked,
  sentry's scheme `Sentry-Bearer`, atlassian's `Basic`) uses the helper at every scope and is recommended at global
  scope. Since 0.3.0 a key is the recommended answer for every hosted route, and Project scope's description says a
  session started in a child folder connects without the key (M1). A stdio keyed route (github's
  Docker, sentry's npm) is written in at local and global scope and not offered at project scope; context7's npm route
  runs keyless there. `${VAR}` stays for machine paths at project scope only.
- **D6 - Servers already set up.** Replaced in 0.3.0 (the user's ruling, 2026-11-11, 'Managed by default'): install asks
  nothing about a server already set up - one it recognises is managed - and a claude.ai connector or another plugin's
  server shows in the pick list as `(also connected through claude.ai)` / `(also provided by the <plugin> plugin)`.
  configure's first question about a server is 'Who looks after <name>?', and only 'Leave it on its own' is recorded,
  so `preferred-tools.json` exists only when the user leaves one out; install plans the removal of a 0.2.0 record's
  'manage' entries (`record-clean`). What 0.2.0 did: before the picks, install asked once about each server here that matches a catalog
  row - a registration ('Leave it on its own' or 'Let preferred-tools manage it', the second recommended when a fix
  detector would repair it, a `key-to-helper` or `token-sync` that waits on a key the user fills included), a server an
  enabled plugin provides, a claude.ai connector the session has loaded ('Leave it with <owner>' or 'Add
  preferred-tools' own registration as well'). A registration whose helper is this plugin's (its number line, or no
  file yet and `<NAME> <SCHEME>` arguments) is not asked about; a helper of the user's own under the same name is. The
  answer is recorded in the family root's `preferred-tools.json` (names, scopes, fingerprints and choices only), so it
  is asked once - install plans the answers even when nothing is picked; 'on its own' is honoured by install,
  configure ('On their own' group), update and fix ('on its own - not checked').
- **D7 - Fix, update and configure.** Fix rows `key-to-helper`, `helper-missing`, `helper-stale` and `root-ignore`;
  `token-sync` narrowed to stdio routes; a trust note for a project or local helper. update rewrites a helper copy
  with a lower number. configure changes a root (each managed registration of the family re-added pointing into the
  new root - and, for the global root, this project's local helpers that name it; no data and no key value moves), a
  key's name and a server's settings.
- **D8 - The walk.** Since 0.3.0 the walk is script-driven and asks one tool's questions at a time: the picks, then
  'Use the recommended settings' or the tool's route, scope and name, its root, location, key and key name, settings
  and extras, before the next tool's (`plan.js --walk`, its `next` loop). 0.2.0's order was: servers already set up,
  the picks, per tool the route then the scope, the roots, then the rest; 'Use the recommended settings for all' asked
  the first only. A
  typed value is asked next in one plain line; no text tells the user to type into Other (`tests/lint.js`, with
  alfred-code's `OTHER_RE`). The apply writes the root's `.gitignore`, the helper and the key names first, the records
  last. A record or roots map from a newer version is never replaced, one that is not JSON is kept as `<file>.bak`
  first, each is written through a temporary file, and an unchanged one is not rewritten.
- **D9 - The key's name and the settings.** 'Which name holds <tool>'s key in .mcps-secrets?' - the catalog's name, up to
  two near-miss names found in the files, or a name asked next; a name filled in the chain is recommended. The server's
  own variable keeps its name; a held key is matched by value against `.mcps-secrets` only, never the 0.1.x files. A
  stdio route's settings: keep them, or `NAME=value` pairs asked next; a name or a value that looks like a credential
  is refused, and a machine path at project scope too.

## Field fixes - 0.3.0

The spec is `docs/superpowers/specs/2026-11-11-field-fixes-0.3.0-design.md` (machine-local). **The user's rulings,
2026-11-11**, quoted:

- Paths, 'Absolute, always (Recommended)' - 'e.g. C:/Projects/.../.alfred/playwright-chrome, serena's home included, on
  every OS. One data folder whatever folder Claude starts in. Cost: .mcp.json then names this machine's path, so a
  teammate's clone points at yours.' It replaces 'project scope gets relative paths'; 'never a key' stands.
- Record, 'Managed by default (Recommended)' - 'Install asks nothing about servers already set up; a server it
  recognises is managed, with no file. Configure offers 'Leave it on its own', and only that answer is saved, so
  preferred-tools.json exists only if you leave one out. A claude.ai connector just shows in the pick list as '(also
  connected through claude.ai)'.' It replaces D6's install-time ask.
- Order, 'Reorder-only write (Recommended)' - 'After its CLI calls, apply.js rewrites .mcp.json with the same servers
  and values in your order. It checks that nothing but the order changed and writes through a temp file: a narrow
  exception to 'CLI is the only writer'.' The order is `catalog.order`; the user's own servers follow it.
- memory, 'Follow the root (Recommended)' - 'Project and Local scope: the project root (.alfred/memory). Global scope:
  the global root. Memories are shared across projects only when memory is installed at Global scope.'
- The design, four answers of 'Approve (Recommended)': the walk, script-driven, one tool at a time; keys, token first
  everywhere, with gitlab and atlassian key routes; paths, absolute at project scope, plus a fix row for existing
  entries; record and order, own servers after the catalog's, version 0.3.0.

What else 0.3.0 does: a hosted keyed install or fix prints how the server connects once its key is filled ('/mcp ->
<name> -> Reconnect'), and names a key the server refused (the `Issue:` line of `claude mcp get`, measured in
`docs/sources.md`); fix gains `project-relative-path`, `mcp-order` and `helper-child-folder`, and `data-folder-ignore`
covers a 0.2.0 copy in a child folder.

## The install command - `commands/install.md`

`disable-model-invocation: true`. Mirror alfred-code's configure walk (`../alfred-code/setup-plugin/references/walk.md`):
a script renders every table, every question is an ask with one option marked `(Recommended)` and listed first, and
nothing is applied before one confirmation.

**Since 0.2.0** the install walk runs in D8's order (servers already set up, picks, route and scope, roots, the rest),
and every typed value - a name, a folder, a browser binary, a host, a key's name, a setting - is asked next in one plain
line that ends the turn, never through 'Other'; the steps below keep their 0.1.x numbering.

**Since the 2026-10-27 split** (see 'Goal'), the steps below are shared by two commands. `commands/install.md` runs
1, 2, 4 to 8 over the rows not installed, with no step 3 menu and no `(installed as ...)` labels.
`commands/configure.md` runs 1, 2, then its menu - 'Change tools (Recommended)', 'Remove tools', 'claude-hud settings'
(only when claude-hud is installed), 'Done' - then a pick of one option per installed registration or plugin, step 5's
per-tool questions with what each has now first, 6 (only for a route change), 7, 8 and 9. A multi-select question never
has a single option: a lone item joins a neighbour, and a single item in all gets 'None of these' beside it.

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
   - first, its own call for two-route rows only - route: 'Hosted' or 'Local' (the `remote` route, worded 'Hosted' because
     alfred-code's stop guard reads a bare 'remote' in an ask as git state), recommended hosted where it needs no local
     runtime;
   - then one call of up to four questions, each with two or more options and the recommended one first. Its scope
     options follow from the route just answered (`project` offered only where 'Scopes and paths' allows it), and
     `plan.js` rejects a forbidden route and scope pair, with a test:
   - scope: 'local', 'project', 'user', recommended as in 'Scopes and paths';
   - name: 'Keep `<original name>` (Recommended)' or 'Use `<project folder name>-<original name>`'; any other name is
     asked next;
   - location (only for rows with `locations`): the root - 'Keep `<default>` (Recommended)' or the other place from
     'Locations' (project or account folder); a typed path is asked next; the walk then prints the derived paths;
   - browser rows only, in the same call: 'Default for this engine (Recommended)' - for chrome and msedge, the branded
     browser installed on the machine; for firefox and webkit, Playwright's own build - or 'A browser binary I name'.
     The second option asks for the path next, in one plain line, and sets `--executable-path`.

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
   **Fetch and first start (added 2026-10-27, from a measurement).** Claude Code gives a server 30 s to answer
   (`MCP_TIMEOUT`), and a package route's first start does more than that: on 2.1.311, `claude mcp get` reported
   appium's first npx install as 'Failed to connect ... timed out after 30000ms'; memory's package came down in about
   6 s, but its first start then took 110 s, downloading its ONNX embedding model, and its second and third starts took
   2.1 s and 2.3 s. So the plan follows each written registration that launches a new package with a fetch step -
   exactly its pin, cut-off, python and env, into the runtime's cache (`npm exec --yes --package <spec> -- node -e 0`,
   `uvx <options> <tool> --help`, `docker pull <image>`) - and `fetch.js` then starts the server once as the CLI wrote
   it, sends `initialize`, waits up to 10 minutes and stops it (with what it started) once it answers. `apply.js` runs
   neither: they outlast the Bash tool's 2-minute default (10 at most), and a call past its limit is moved to the
   background (stopped, where background runs are off), so its report would not come back in the turn that asked for
   it. `apply.js` writes the written servers' fetch steps, each with its scope, to `<tmp>/fetch.json`, and the command
   runs `fetch.js` on it in the background, one server at a time (two first npx installs at once is the one case
   measured to break a start, and it does not heal: fix row `npx-cache-entry` removes the broken folder and fetches it
   again), ending with `claude mcp get` for each status. A server whose registration needs an
   unset `${VAR}` is fetched, not started. A failed fetch or start is a warning: the registration stays and its first
   session start tries again. With nothing to fetch (a hosted route, a rename, a move) apply asks for the status
   itself. `fetch.js` runs package installs and starts servers, so like `apply.js` it is never in `allowed-tools`.
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
no ask. `/preferred-tools:configure hud` jumps straight to this ask for an installed claude-hud (the 2026-10-27 split;
it was `/preferred-tools:install hud`).

**After an update.** When `/preferred-tools:update` moves claude-hud to a newer version, it re-runs `--check`, and it names
any catalog key the new `DEFAULT_CONFIG` no longer holds. It never removes such a key.

The same catalog takes a row for another plugin later. Each row's keys are read from that plugin's own source,
never from memory.

## The fix command - `commands/fix.md` and `catalog/fixes.json`

`disable-model-invocation: true`. `node scripts/fix.js --detect` runs every fix row's detector over the inventory
and the machine and prints one table: row, tool (by registration name), what was found. Then one ask, only when a found
problem can be applied: 'Apply all found (Recommended)', 'Pick which' (the grouped shape), 'Skip'. When every line is NOT
APPLICABLE, nothing is asked: the lines are the advice. `scripts/fix.js --apply <ids>` applies each pick. A
registration fix rewrites the entry through the CLI (remove, then add-json with the same name and scope). A file fix
(the shim patch) edits the package file and keeps a `.bak`. Each fix is read back, then the restart line is printed - none when every fix applied only wrote a data folder's `.gitignore`. A
row whose detector finds nothing is not shown. `/preferred-tools:fix <tool or id>` narrows it.

A fix row: `id`, `tool`, `os`, `symptom` (what the user sees), `detect` (the name of a function in `scripts/fixes/`),
`fix` (the same), `verifiedOn` (tool version and OS the fix was proved on), `source` (where the lesson comes from),
`advice` (`true` with `fix: null`: every finding is blocked - shown, never offered or applied, whatever its detector
returned). Seed
rows - each `source` line is the alfred-code file to read for the detail:

| id | Symptom | Fix | Source |
|---|---|---|---|
| serena-windows-home | serena's TypeScript language server fails to start on Windows (`'.serena' is not recognized as an internal or external command`): serena runs it through npm's `.bin` shim, which hands `SERENA_HOME` to cmd.exe unquoted, so a `/` or a space in it cuts the path | `SERENA_HOME` absolute, in backslashes, with no space (default `C:\Users\<name>\.serena` when the profile path has none, else `<system drive>\serena-home`, offered first and taken by default, or a space-free folder the user types). Absolute, so a session started in a subfolder finds the same home and does not download serena's ~327MB of language servers again. Re-verify on the current serena pin - the record says 1.7.0 to 2.1.0 | `serena-launch.js` header (f779a349) |
| serena-windows-ts-shim | every serena symbol and reference tool fails for the session on Windows: serena's solidlsp spawns npm's extensionless POSIX shim `.bin/typescript-language-server`, which cmd.exe cannot run, so the TypeScript server dies at init (upstream oraios/serena#311) | Port of `../alfred-code/scripts/fix-serena-ts-windows.ps1` to Node (`scripts/fixes/serena-ts-shim.js`). Detect: every `solidlsp/language_servers/typescript_language_server.py` under `%LOCALAPPDATA%\uv` whose `_create_launch_command` body is still `return [core_path, "--stdio"]` and has no `serena-win-fix` marker. Fix: on Windows, run `node <typescript-language-server>/lib/cli.mjs --stdio`, falling back to `<core_path>.cmd`, with a `.bak` beside it. A method whose body differs is skipped and named ('patch manually'), never forced. TRANSIENT: a uvx upgrade re-extracts the package and wipes the patch, so the update command re-runs this detector after every serena bump. Step 1 checks whether serena#311 is fixed on the current pin, and the row is retired when it is | `scripts/fix-serena-ts-windows.ps1` |
| uvx-python | a uvx server dies at start with `CONNECTION_CLOSED` (pyyaml 6.0.2 has no CPython 3.14 wheel) | add the row's `--python` | `uv-python.js` header |
| windows-arm-python | a uvx server fails to build wheels on Windows ARM64 | the x64 CPython build for the row's minor | `docs/uv-python-pin-evidence.md` |
| windows-npx-cmd | an npx server never connects on native Windows | wrap the command in `cmd /c` | Claude Code MCP docs (verify) |
| playwright-webmcp | page-registered WebMCP tools appear beside Playwright's own | add `--no-webmcp` | `browser-launch.js` header |
| appium-sdk-env | appium cannot find the Android SDK or a JDK (Claude Code started from the dock or an IDE) | look up `ANDROID_HOME` / `JAVA_HOME` and set them in the registration's `env` | `mobile-launch.js` header |
| serena-telemetry | serena sends a usage ping at every start | `SERENA_USAGE_REPORTING=false` | `serena-launch.js` |
| token-sync | a stdio token server at local or global scope lacks the key `.mcps-secrets` has, or holds an older one | write the key in from the root's `.mcps-secrets` (D3's stdio chain); a key held under no name there is blocked: 'pick the key's name with /preferred-tools:configure' | `scripts/keys.js`, D7 |
| key-to-helper | a hosted server's `Authorization` header holds a `${VAR}` or a key (0.1.x wrote both) | re-add it with `headersHelper` and without the header, once its name is filled in the hosted chain; the root's `.gitignore` and helper are written first | D4, D7 |
| helper-missing | a registration names a `mcp-headers.js` that is not there (a teammate's clone) - the server connects without its key | write the helper | D4, D7 |
| helper-stale | the helper copy is older than this plugin's, or was edited by hand | rewrite it; a newer copy is left with a note to update the plugin, and a file with no number line - not this plugin's - is never overwritten | D4, D7 |
| root-ignore | git would commit a root's `.mcps-secrets`, or ignores a project root's `mcp-headers.js` | append the lines the root's `.gitignore` lacks; a gap no appended line closes - a `.gitignore` above excluding the root folder - is blocked and named | D2, D7 |
| typescript-lsp-ts7 | typescript-lsp shows no diagnostics (TypeScript 7 ships no `tsserver.js`) | `npm install -g typescript-language-server typescript@6` | alfred-code `meta/stack-manifest.json`, the typescript-lsp row |
| windows-mcp-one-per-desktop | windows-desktop shows connected in `/mcp` but its desktop tools stay unavailable: windows-mcp 0.8.8 makes one missed overlay confirmation permanent for the process, and a second windows-mcp on the same desktop is the likely cause | advice only (`advice: true`, `fix: null`): two or more windows-mcp servers starting here are reported, each with how its owner drops it; nothing is changed, and a stuck one recovers in a new session | `docs/sources.md` 'windows-mcp 0.8.8 - the sticky overlay failure' |
| data-folder-ignore | git would commit a data folder - a project-scope folder with no `.gitignore`, or a copy a 0.2.0 session left in a child folder from a relative path | write its `.gitignore` holding `*`; a 0.2.0 copy's data is left, never moved or deleted | D2, spec F7 |
| project-relative-path | a project-scope data folder or key helper named relative or through `${HOME}` / `${USERPROFILE}` (0.2.0), so a session started in a child folder uses its own copy | rewrite each path absolute, the pin, the cut-off and the user's args kept; a parent folder's file is named NOT APPLICABLE with the folder to run fix in | spec F7 |
| mcp-order | `.mcp.json`'s catalog servers are not in `catalog.order` | the reorder-only write install and configure append: the same servers and values, the user's own after the catalog's | spec F8 |
| helper-child-folder | a parent folder's hosted server connects without its key in a child folder: Claude Code does not run a parent's `headersHelper` there | advice only: move it to Global with configure in the parent, or start Claude in the parent | spec F3a, `docs/sources.md` M1 |
| npx-cache-entry | an npx server fails at every start with `ENOENT` reading `<npm cache>/_npx/<hash>/package.json`: two first installs of one package at once (a session started while `fetch.js` runs) left the folder without it, and npx never repairs it. The cache is the machine's, so a server this folder inherits from a parent's `.mcp.json` is checked too | remove that one folder, then `fetch.js` fills it again (a parent's server read from the parent's file, started here) | measured on npm 10.9.2 and 11.6.1 (`docs/sources.md`) |

A new problem the user meets later becomes a new row, with its `verifiedOn`.

## The update command - `commands/update.md`

`disable-model-invocation: true`, like the other three commands. **The user's ruling, 2026-10-27:** the update is a
command, `/preferred-tools:update`, not a skill. It was first built as the model-invocable `skills/update-tools/SKILL.md`
(description under 160 chars, starting 'Use when'); the body, the asks and `scripts/update.js` are unchanged by the move,
and the plugin now puts no skill description in every session. It runs `node scripts/update.js`:

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
- Key helpers (D7): each `mcp-headers.js` copy a managed registration names, or a root in use holds, with a lower number
  than the plugin's is offered ('Key helpers'); an edited or newer copy is named and left to fix. A server left on its
  own (D6) is listed as 'on its own - not checked'. Every call passes `--data "${CLAUDE_PLUGIN_DATA}"`.
- Language servers on PATH: reported (`typescript-language-server --version`, `csharp-ls --version`), updated only on
  the user's yes.
- Nothing behind: one line, `preferred-tools: everything current`.

`catalog/tools.json`'s own pins move only through a repo script (`npm run refresh-pins`), never during an update.

## Repo layout

```text
.claude-plugin/plugin.json    name preferred-tools, version 0.1.0, description, author envoydev
.claude-plugin/icon.png       1024 px square toolbox (Material Symbols, Apache 2.0; docs/sources.md), for Anthropic's directory listing only - Claude Code ignores it, and the first submission may fix it for good
commands/install.md
commands/configure.md
commands/update.md
commands/fix.md
catalog/tools.json            the 17 rows: kind, original name, routes, fingerprint, args/url, env, locations, pins, os, prereqs, dangerous tools
catalog/fixes.json
catalog/plugin-settings.json  the recommended plugin settings, ported from alfred-code (the claude-hud row)
scripts/                      inventory.js, table.js, prereq.js, plan.js, apply.js, fetch.js, fix.js, fixes/, update.js, plugin-settings.js, hud-statusline.js, json-file.js, account.js, refresh-pins.js - Node 22, no dependencies
tests/                        node:test, one file per script
docs/sources.md               every external fact with its URL and the date read
.claude/CLAUDE.md             EXISTS - this repo's invariants and the plugin facts it relies on; keep it current, never replace it
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
2. **Scaffold** the layout and `plugin.json`. Read `.claude/CLAUDE.md` and `docs/plugin-cli-evidence.md`, and load the
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
    per row with a data folder (`tests/probes/relative-root.js`: launched as `plan.js` writes it at `project` scope, the
    server is started once from a root folder and once from a child, and its data file is looked for; the row's
    `locations.relative` is `true` only when both land under the folder it started in, and the result is recorded in
    `docs/sources.md`); a user's own server under a catalog name (asked, not overwritten); missing,
    empty and malformed `.mcp.json`; each of `local`, `project`, `user`; a remove; each fix detector on a seeded broken
    entry; an update with a stale pin; claude-hud's recommended settings applied once with a user value present (kept), then with
    'Apply and replace differing' (overwritten, backup written). Read the written `.mcp.json`, the account file and `settings.json` after each,
    never the exit code alone.
13. **Live check - the user's step**, on this machine (macOS) with the real account. The build session cannot type into
    a nested interactive session, so it prints a checklist and waits for the user's go:
    - create a scratch project (the exact `mkdir` line);
    - start `claude --plugin-dir <this repo>` there (verify the flag in step 1);
    - run `/preferred-tools:install` once, picking serena, memory, context7, one browser and the LSP pair;
    - run `claude mcp get <name>` per server, then `/preferred-tools:fix` and `/preferred-tools:update` once each;
    - paste the read-back into this session.

    The build session reads the pasted output and records PASS or the failure. With no go, the step is NOT RUN.
    Cleanup is on the same checklist, and its read-back is pasted too:
    - run `/preferred-tools:configure`'s Remove round at every scope used, and uninstall the plugins installed for
      the scratch project;
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
  name, at every scope (user, project and local), with a custom location root, and a re-run with the same answers
  makes no CLI call.
- Each Playwright engine can be installed under its own name and location in the same project.
- Inventory recognises a catalog tool under any name and never lists or touches a registration it does not match.
- No file the plugin writes contains a token; since 0.3.0 `.mcp.json` holds absolute paths (and `${VAR}` for nothing
  but a machine path a user wrote), and its catalog servers stay in `catalog.order` after every change.
- `/preferred-tools:fix` finds and fixes a seeded `serena-windows-home` entry and a seeded unpatched
  `typescript_language_server.py` (fixtures here; live on Windows or NOT RUN).
- Every script call in a command or skill body is spelled under `${CLAUDE_PLUGIN_ROOT}`, and the user's live check ran
  the commands from a project that is not this repo - or the report says NOT RUN.
- `/preferred-tools:update` offers a newer pin, rewrites the registration under the same name and scope, and says
  `everything current` when nothing is behind.
- Picking claude-hud ends with the recommended-settings ask; each of its three answers writes exactly what
  `hud-statusline.js --check` reported for it (the statusLine alone for 'Skip'), and `/preferred-tools:configure hud` reaches the same ask on an installed claude-hud.
- Install offers only what is not installed. Configure offers each installed registration and plugin once per scope,
  recommends what it has now in every question, changes the one picked and leaves a second registration of the same
  row as it is.
- Nothing is applied before the plan's confirmation; a failure mid-apply leaves the earlier steps in place, named.

## Risks

- A registration rewrite (fix, update, rename) loses the server for a moment, and fails between remove and add: apply
  adds first under a temporary name where the name changes; for a same-name rewrite, it saves the old JSON to
  `<tmp>/rollback.json` and re-adds it when the add fails, and the report prints the line that restores it by hand.
- A vendor endpoint or package moves after step 1: `/preferred-tools:update` re-reads the registry; a remote route that stops
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
  'Optional'. It relies on no other plugin's guard.
- Shared plugins. alfred-code also installs claude-hud and the LSP pair, and its update installs an absent pick, so it
  may add back one that preferred-tools removed. The plugins stay standalone (no hand-over), so the gap stays open.
  Mitigation: while `claude plugin list --json` shows alfred-code enabled, the walk notes on those three rows that
  alfred-code installs them too and may add a removed one back.
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

## Hand-off - the marketplace entry in alfred-code, a separate session there

preferred-tools is a standalone plugin (the user's ruling, 2026-10-27). It is listed beside alfred-code in the
`envoydev` marketplace, like any two plugins in a store: neither depends on, requires, installs or removes the other,
the user picks it or not, and it works the same with alfred-code absent. Removing alfred-code never removes
preferred-tools. Report this as the next step; it follows this repo's first push:

- **Marketplace entry.** alfred-code's `.claude-plugin/marketplace.json` (marketplace name `envoydev`) is generated by
   `scripts/build-marketplace.js`, and every entry it generates has `source: './'`. The generator keeps an entry it
   does not own (`applyToMarketplace`: anything not generated, not retired or folded, and not an MCP-only entry). So
   the `preferred-tools` entry, sourced from this GitHub repo in the shape step 1 verified, is written by hand. Then
   `npm run marketplace` confirms it survives, and `npm run lint` confirms lint accepts an entry with an outside
   source; if lint refuses it, that is a lint change there. Users then run
   `claude plugin install preferred-tools@envoydev`. The entry adds no `dependencies`, and nothing in the alfred-code
   entry names preferred-tools.

No hand-over is planned (the user's ruling, 2026-10-27, replacing an earlier hand-over of claude-hud and the LSP
pair). alfred-code keeps installing what it installs today, as if preferred-tools did not exist; pointing its users
at preferred-tools for those three would make one plugin need the other.

## Optional

- Recommended - deny rows for the three code-running tools. Reason: nothing in this plugin stops them.
  For each picked server the walk would offer a `permissions.deny` row `mcp__<registration name>__<tool>` in the
  scope's settings file. The write would be add-only, with the same backup before the first write as
  `plugin-settings.js`, and the Remove round would take the row out with its server. A permission rule cannot see a
  mode, so denying windows-mcp's `App` also loses launch, switch and resize; its ask says so. The recommendation does
  not depend on which other plugins are installed.
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
