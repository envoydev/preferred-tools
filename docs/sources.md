# Sources - every external fact, with its URL and the date read

Read on 2026-10-27 (build session) unless a line says otherwise. A line is `CONFIRMED` when the vendor's page matches
the build brief, `CHANGED` when it does not (the catalog follows the page, not the brief), `MEASURED` when it was run
on this machine under an isolated `CLAUDE_CONFIG_DIR` and `HOME`. Registry facts (version, publish time) are the
registry's own answer on the same day. The age gate is 7 days: with today 2026-10-27, a release counts only if
published on or before 2026-10-20.

## Pins - registry state on 2026-10-27

| Package | Registry | Latest | Latest that is 7+ days old (the pin) | Note |
|---|---|---|---|---|
| `serena-agent` | PyPI | 2.1.0 (2026-10-19) | 2.1.0 | `requires_python` `>=3.11,<3.15` |
| `mcp-memory-service` | PyPI | 12.4.0 (2026-10-26) | 12.1.1 (2026-10-16) | 12.2.0 to 12.4.0 are all newer than 7 days |
| `macos-mcp` | PyPI | 0.4.6 (2026-09-08) | 0.4.6 | `requires_python` `>=3.11` |
| `windows-mcp` | PyPI | 0.8.8 (2026-10-10) | 0.8.8 | `requires_python` `>=3.14` |
| `@playwright/mcp` | npm | 0.0.83 (2026-09-28) | 0.0.83 | bin `playwright-mcp`, node `>=18` |
| `appium-mcp` | npm | 1.99.1 (2026-10-27) | 1.97.1 (2026-10-12) | 1.97.2 to 1.99.1 are all newer than 7 days |
| `@upstash/context7-mcp` | npm | 4.4.4 (2026-10-19) | 4.4.4 | bin `context7-mcp` |
| `@sentry/mcp-server` | npm | 0.42.0 (2026-09-25) | 0.42.0 | |
| `ghcr.io/github/github-mcp-server` | GitHub releases | v2.0.3 (2026-10-21) | v2.0.2 (2026-10-08) | project moved to a 2.x major on 2026-10-06 |
| `typescript-language-server` | npm | 6.0.2 (2026-10-09) | 6.0.2 | |
| `typescript` | npm | 7.0.2 (2026-10-26) | - | see 'typescript-lsp' |

Sources: `https://pypi.org/pypi/<package>/json` and `npm view <package> time --json`, read 2026-10-27.

## GitHub MCP server - github/github-mcp-server

- Remote URL `https://api.githubcopilot.com/mcp/` - CONFIRMED. README (https://github.com/github/github-mcp-server).
  The install guide writes it without the trailing slash.
- Bearer PAT header `Authorization: Bearer <PAT>` - CONFIRMED. Claude Code MCP docs
  (https://code.claude.com/docs/en/mcp): `claude mcp add --transport http github https://api.githubcopilot.com/mcp/ --header "Authorization: Bearer YOUR_GITHUB_PAT"`; fine-grained PAT advised.
- Docker route - CONFIRMED. README: `docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server`.
  Claude Code guide (https://github.com/github/github-mcp-server/blob/main/docs/installation-guides/install-claude.md):
  `claude mcp add github -e GITHUB_PERSONAL_ACCESS_TOKEN=... -- docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server`.
  Version tags are published by the Docker workflow (README); the tag names on ghcr.io were not listed by the page, so
  the catalog uses the release tag `v2.0.2` and the install check is `docker manifest inspect` (step 12, NOT RUN if
  Docker has no network).
- Release binary - CONFIRMED. Release v2.0.3 assets are `github-mcp-server_{Darwin,Linux,Windows}_{arm64,x86_64,i386}`
  (.tar.gz, .zip on Windows) plus a checksums file; stdio form `github-mcp-server stdio` (install guide JSON:
  `{"command":"github-mcp-server","args":["stdio"],"env":{"GITHUB_PERSONAL_ACCESS_TOKEN":"..."}}`).
- OAuth: the README documents OAuth for the remote server; the guide shows an OAuth form only for the local Docker
  route (`GITHUB_OAUTH_CALLBACK_PORT`). The catalog's remote route uses the `${GITHUB_PERSONAL_ACCESS_TOKEN}` bearer
  form (no token in any file), the vendor's documented Claude Code form.
- Latest release v2.0.3 published 2026-10-21T09:52:29Z (`gh release list -R github/github-mcp-server`): 6 days old, so
  the age gate holds the pin at v2.0.2 (2026-10-08).

## GitLab - hosted MCP server

- Endpoint `https://<host>/api/v4/mcp` (gitlab.com or a self-managed host) - CONFIRMED.
  https://docs.gitlab.com/user/model_context_protocol/mcp_server/ (the older `/user/gitlab_duo/...` path redirects).
- OAuth 2.0 Dynamic Client Registration - CONFIRMED; an admin can turn DCR off, then a pre-registered OAuth app is
  needed. A fine-grained PAT with the MCP resource and Execute permission also works (legacy tokens are rejected). The
  exact PAT header form is not on the page, so the catalog offers OAuth only.
- Version and tier: HTTP transport from GitLab 18.6; generally available in 19.5; Free tier since 19.2. A self-managed
  instance needs an administrator to allow MCP access at instance level. No feature flag.
- Claude Code form documented: `claude mcp add -s user --transport http GitLab https://<host>/api/v4/mcp`. The page warns
  a `local` entry with the same name wins over a `user` one.
- No local server from GitLab is documented - CONFIRMED (route is remote only).

## Atlassian - Rovo MCP server

- Endpoint - CHANGED. The brief's `https://mcp.atlassian.com/v1/...` is superseded: `https://mcp.atlassian.com/v2/mcp`
  is the recommended endpoint; `/v1/mcp` and `/v1/mcp/authv2` are 'still supported'. The `/v1/sse` endpoint stopped
  being supported after 2026-06-30. https://github.com/atlassian/atlassian-mcp-server and
  https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/.
  Catalog: `https://mcp.atlassian.com/v2/mcp`.
- Claude Code form (both pages): `claude mcp add --transport http atlassian https://mcp.atlassian.com/v2/mcp`, then
  `/mcp` for OAuth. CONFIRMED (OAuth route).
- API-token alternative exists (`Authorization: Basic <base64(email:token)>` or `Bearer <service account key>`) and an
  org admin must enable it; vendor and community reports disagree on the Bearer form, so the catalog offers OAuth only.
- The Claude Code MCP page has no Atlassian example.

## Sentry

- Remote `https://mcp.sentry.dev/mcp` (OAuth) - CONFIRMED. https://mcp.sentry.dev/ (docs.sentry.io/product/sentry-mcp/
  redirects there) and https://code.claude.com/docs/en/mcp: `claude mcp add --transport http sentry https://mcp.sentry.dev/mcp`, then `/mcp`.
  The remote also accepts `/mcp/{organizationSlug}/{projectSlug}`.
- Local stdio - CONFIRMED. https://github.com/getsentry/sentry-mcp: `npx @sentry/mcp-server@latest --access-token=...`;
  flags `--access-token`, `--host` (hostname only), `--insecure-http`, `--skills`, `--disable-skills`; env
  `SENTRY_ACCESS_TOKEN`, `SENTRY_HOST` (names from a page summary, not a direct quote). The catalog registers
  `npx -y @sentry/mcp-server@0.42.0` with `SENTRY_ACCESS_TOKEN=${SENTRY_ACCESS_TOKEN}`.

## Context7 - upstash/context7

- Remote `https://mcp.context7.com/mcp` - CONFIRMED.
- Header - CHANGED. The docs use `Authorization: Bearer YOUR_API_KEY`, not `Context7-API-Key`
  (https://context7.com/docs/resources/all-clients, README https://github.com/upstash/context7:
  'pass your API key via the `Authorization: Bearer YOUR_API_KEY` header'). The old `Context7-API-Key` header could not
  be re-confirmed, so the catalog follows the page. The key is recommended, not required (README: 'API Key
  Recommended ... higher rate limits'; the API guide says no key means low rate limits).
- Local `npx -y @upstash/context7-mcp --api-key YOUR_API_KEY` - CONFIRMED (flag). No environment-variable form is
  documented, so a local route has no token-free way to carry the key: the local row registers it as an arg built from
  `${CONTEXT7_API_KEY}` (expanded by Claude Code at launch, never written).

## Claude Code - MCP registration (`claude mcp`) and `.mcp.json`

- `claude mcp add-json <name> '<json>' [-s local|project|user]`, `remove <name> [-s <scope>]`, `get <name>` - CONFIRMED.
  https://code.claude.com/docs/en/mcp (scope default `local`). MEASURED on Claude Code 2.1.311: `add-json` prints
  `Added stdio MCP server <name> to <scope> config`; `-s project` writes `<project>/.mcp.json`.
- Where the scopes are stored - MEASURED with `CLAUDE_CONFIG_DIR` set: the CLI writes `$CLAUDE_CONFIG_DIR/.claude.json`
  (local scope under `projects["<realpath of the project>"].mcpServers`, user scope under top-level `mcpServers`) and
  creates `$CLAUDE_CONFIG_DIR/backups/.claude.json.backup.<ms>`. The real `~/.claude.json` kept its mtime. The project key
  is the real path (macOS `/tmp` resolves to `/private/tmp`), so `scripts/account.js` must `realpath` the project.
  The docs page does not say where `CLAUDE_CONFIG_DIR` puts the file; the measurement does.
- The project key by OS - MEASURED. macOS, Claude Code 2.1.312, 2026-10-29: `add-json -s local` from a folder typed
  `work/shop` whose disk name is `Work/Shop` stored the key as the real path in the disk's case, the same string
  `fs.realpathSync.native` returns - so macOS needs no case fold, and a fold would be wrong on a case-sensitive volume.
  Windows 11 VM, Claude Code 2.1.309, 2026-10-26 (alfred-code `docs/workspace-layering-evidence.md`, 'Release 2 - MCP
  probes', A7 and A8): the key is the cwd AS TYPED, `\` written as `/`, the typed case kept - `C:\mcpw\keys\child` is
  stored as `C:/mcpw/keys/child` and `C:\MCPW\KEYS\CHILD` as `C:/MCPW/KEYS/CHILD`. Node's realpath gives backslashes
  there, so `account.js` `projectEntry` matches a win32 key by its `/` form, the typed cwd first, then any case.
- Variable expansion in `.mcp.json` - CONFIRMED. Syntax `${VAR}` and `${VAR:-default}`, in `command`, `args`, `env`,
  `url`, `headers`. An unset variable with no default loads as the literal `${VAR}` text. MEASURED: `add-json` stores
  `${HOME}`, `${FOO:-bar}`, `${TOK}` literally, in `.mcp.json` and in the account file.
  `CLAUDE_PROJECT_DIR` is set in the spawned server's environment, not Claude Code's, so referencing it in a project
  `.mcp.json` `command` or `args` needs `${CLAUDE_PROJECT_DIR:-.}`. The page does not say `${CLAUDE_PLUGIN_ROOT}`
  expands in a project `.mcp.json` (it is documented for plugin-provided servers only); the design rejects that route
  either way, and no registration uses it.
- The stdio server's working directory is not stated on the page. Step 12 measures it per local row.
- OAuth for a remote server: `/mcp` in a session, or `claude mcp login <name>` - CONFIRMED. Project-scope servers need
  the approval prompt in interactive sessions (`claude mcp reset-project-choices` clears it) - CONFIRMED.
- Windows `cmd /c` for npx - CHANGED, NOT DOCUMENTED. The current MCP page has no such rule (all 228 pages in
  https://code.claude.com/llms.txt and the changelog were searched). The changelog entry for 2.1.119 reads: 'Windows:
  removed false-positive "Windows requires 'cmd /c' wrapper" MCP config warning'
  (https://code.claude.com/docs/en/changelog.md). The hooks doc says exec form on Windows cannot spawn `.cmd` shims
  (https://code.claude.com/docs/en/hooks.md). The `windows-npx-cmd` rule is therefore kept as a precaution (it is a
  no-op where npx would have run anyway) but is NOT proved: it needs the Windows VM (NOT RUN here), and the catalog marks
  it `documented: false`.

## Claude Code - time limits behind the fetch step (read 2026-10-27)

- `MCP_TIMEOUT` - 'Timeout in milliseconds for MCP server startup (default: 30000, or 30 seconds)' - CONFIRMED
  (https://code.claude.com/docs/en/env-vars.md). MEASURED on 2.1.311: `claude mcp get` on appium's registration before
  any npx install printed 'Failed to connect ... timed out after 30000ms'; memory's first uvx start answered after about
  180 s (`tests/matrix/starts.test.js`). So the first start of an unfetched package route times out.
- memory's first start - MEASURED on macOS arm64, 2026-10-27, throwaway home: the package fetch (`uvx ... --help`) took
  6 s, then start 1 answered `initialize` after 110.0 s, start 2 after 2.1 s, start 3 after 2.3 s. Start 1 fills
  `~/.cache/mcp_memory/onnx_models/all-MiniLM-L6-v2` from `https://chroma-onnx-models.s3.amazonaws.com/all-MiniLM-L6-v2/onnx.tar.gz`
  (`mcp_memory_service/embeddings/onnx_embeddings.py` in the 12.1.1 wheel). With only the package fetch, `claude mcp
  get` still printed '✘ Failed to connect' and the next start took 72.8 s. Hence `fetch.js` starts each server once
  after its fetch: after that first start the macOS matrix's starts answered in 0.7 s (serena) to 2.6 s (playwright).
- After the fetch alone (no first start yet), `claude mcp get` printed '✔ Connected' for serena, context7, playwright-chrome,
  appium and macos-control on macOS (matrix, 2026-10-27); appium, flaky before (1 start in 3), answered in 2.2 s.
- Bash tool limits - CONFIRMED (https://code.claude.com/docs/en/tools-reference.md, 'Timeout and output limits'):
  `BASH_DEFAULT_TIMEOUT_MS` two minutes and the ceiling ten minutes out of the box; a foreground command that reaches
  its timeout is moved to the background, not stopped, unless `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` or bare mode;
  a background command has no time limit in an interactive local session and 30 minutes (2 hours at most) in an
  unattended one (v2.1.285+). Hence `apply.js` stays short and `fetch.js` starts in the background.
- MEASURED on npm 11.6.1: an npx first install killed partway (as the 30 s health check kills it) heals on the next run;
  two first installs of the same package running at once left `_npx/<hash>` without its `package.json` and the start
  failed with `ENOENT` (a local repro, not shipped). Hence `fetch.js` runs one fetch at a time and the commands ask
  for the restart only after it reports.

## Claude Code - plugin CLI

Docs: https://code.claude.com/docs/en/plugins/cli-reference.md and https://code.claude.com/docs/en/plugins/marketplace-reference.md.

- `--scope` takes `user|project|local` (`update` also `managed`). `install` default scope `user`; `uninstall`
  (aliases `remove`, `rm`), `enable`, `disable`, `update` take `-s/--scope`; `enable` auto-detects local, project, user.
  `update` without `--scope` picks the most specific (v2.1.281+). CONFIRMED.
- `enable` over enabled and `disable` over disabled exit 1 - CONFIRMED (docs) and MEASURED (2.1.311):
  `Failed to enable plugin ... already enabled at project scope`, exit 1.
- `install` over an installed plugin - the docs describe only the same-scope case ('already installed', exit 0).
  MEASURED on 2.1.311, which matches `docs/plugin-cli-evidence.md` S28: (d) same scope, enabled: `already installed`, exit
  0, nothing changed; (c) same scope, disabled: `Successfully installed`, `enabledPlugins` flips `false` to `true`;
  (b) a different scope: a second row (`project` and `user` both listed). The evidence file stands.
- `plugin list --json` - CONFIRMED. One object per installation: `id`, `version`, `scope`, `enabled`, `installPath`;
  optional `readFromFolder`, `folderVersion`, `installedAt`, `lastUpdated`, `projectPath`, `projectEnabled`,
  `mcpServers`, `errors`, `notes`. `version` is the installed version only. `list --json --available` returns
  `{installed, available}` where `available` holds only plugins NOT installed. MEASURED the same shape. So the
  marketplace's newer version is NOT in `list --json`: the update script reads it from the marketplace clone
  (`marketplace list --json` gives `installLocation`; the entry's relative `source` folder holds `plugin.json`, whose
  `version` wins over the entry's). For an entry sourced from another repo with no `version`, the available version is
  unknown without fetching: `claude plugin update` is itself the check (`already at the latest version`, exit 0).
- `marketplace add <source> [--scope user|project|local]`, `marketplace list [--json]`, `marketplace update <name>`
  (a name is required, v2.1.287+), `marketplace remove` (removes the plugins installed from it) - CONFIRMED.
- `github` plugin source in a marketplace entry - CONFIRMED: `{"source":"github","repo":"owner/repo","ref":"<branch or
  tag>","sha":"<40 hex>"}`, `ref` and `sha` optional, `sha` wins. `git-subdir` takes `url` and `path`. Verbatim example:
  `{"name":"formatter","source":{"source":"github","repo":"your-org/formatter","ref":"v2.0.0","sha":"a1b2..."}}`.
- An entry may omit `version`; when entry and `plugin.json` both set one, `plugin.json` wins and validate warns -
  CONFIRMED (manifest reference, https://code.claude.com/docs/en/plugins-reference).
- Marketplace name `envoydev` - ALLOWED (not reserved; names allow letters, digits, `.`, `_`, `-`).
- `--plugin-dir <path>` - CONFIRMED and MEASURED in `claude --help`: 'Load a plugin from a directory or .zip for this
  session only', repeatable; it overrides an installed plugin of the same name; the plugin lists as `<name>@inline`,
  scope `session`, and `claude plugin list` shows it only when the flag precedes the subcommand.
- `claude plugin validate <path> [--strict] [--json]` - exit 0 pass, 1 fail (or warning with `--strict`), 2 validator
  error. It warns on a `CLAUDE.md` at the plugin root (manifest reference). MEASURED on 2.1.311 (2026-10-27): with the
  file at `.claude/CLAUDE.md` instead, `--strict` passes with nothing to report, and the memory docs list
  `./.claude/CLAUDE.md` as a project-instructions location equal to `./CLAUDE.md`
  (https://code.claude.com/docs/en/memory.md), so the repo keeps its rules there. The same run's plugin-directory
  checks want a square PNG icon (512-2048 px, under 2 MB, at `.claude-plugin/icon.png` or named by `icon` in
  plugin.json) and no `.DS_Store`; Claude Code ignores the icon, Anthropic's directory reads it
  (https://code.claude.com/docs/en/plugins-reference.md, 'Directory listing fields').
- Those directory checks only report under plain `--strict`: MEASURED on 2.1.311, a folder holding a `.DS_Store`
  printed the finding and still exited 0. `--profile directory` makes them count, and with `--strict` their warnings
  fail (`claude plugin validate --help`); the validator itself advises running it 'on a fresh checkout', since it reads
  the folder on disk while a submission holds only what is committed. MEASURED: on the folder with a `.DS_Store` it
  exits 1; on a copy of `git ls-files --cached --others --exclude-standard` it exits 0; on that copy without the icon
  it exits 1 with ICON_MISSING. `npm run validate` (`tests/validate-plugin.js`) is that copy, at that profile.
- The icon - Material Symbols `home_repair_service`, rounded, filled
  (`symbols/web/home_repair_service/materialsymbolsrounded/home_repair_service_fill1_48px.svg`) from
  https://github.com/google/material-design-icons at commit 10ecc14790612ca8fd164e3f4ffe9c16fc50d5b7 (2026-10-23),
  read 2026-10-27. License: Apache 2.0 (the repo's LICENSE); its README: 'Feel free to remix and re-share these icons
  ... We'd love attribution in your app's about screen, but it's not required.' Credited in the README. Drawn white
  (#f4f7f6) at 0.8 scale, centred, with a soft shadow, on a #14857c to #0b3b38 diagonal gradient; rendered to 1024 px
  with headless Chrome.
- `claude plugin details <name>`: name, version, source, component inventory, projected token cost - CONFIRMED.
- Official marketplace - MEASURED: `claude plugin marketplace add anthropics/claude-plugins-official` registers it
  under the name `claude-plugins-official` (a built-in `anthropic-plugin-directory` is listed beside it and is a
  different marketplace). Docs: a fresh interactive session registers `claude-plugins-official` itself; a headless or
  fresh config dir may lack it (`Marketplace "claude-plugins-official" not found`), so the plan adds it when
  `marketplace list` does not show it.

## LSP plugins

- `typescript-lsp` and `csharp-lsp` are in `claude-plugins-official` - CONFIRMED and MEASURED in the clone
  (`.claude-plugin/marketplace.json`): both version 1.0.0, `strict: false`, `lspServers` inline. `typescript-lsp`
  runs `typescript-language-server --stdio` for ts, tsx, js, jsx, mts, cts, mjs, cjs; `csharp-ls` runs `csharp-ls` for
  `.cs`. https://github.com/anthropics/claude-plugins-official/tree/main/plugins/typescript-lsp and `.../csharp-lsp`.
- TypeScript install line - CHANGED. The plugin README says `npm install -g typescript-language-server typescript`
  and pins no major. `typescript-language-server`'s own README says `npm install -g typescript-language-server typescript@6`
  (https://github.com/typescript-language-server/typescript-language-server). The brief's `typescript@6` is CONFIRMED:
  `typescript@7.0.2` (latest, 2026-10-26) has no `tsserver.js` (its `lib/` holds `version.cjs`, `getExePath.js`,
  `tsc.js`; native binaries come from `@typescript/typescript-<platform>`), and the server resolves
  `require.resolve('typescript')` then `tsserver.js` in that folder (`src/tsServer/versionProvider.ts`). So the plugin
  README's unpinned line installs a TypeScript the server cannot use: the `typescript-lsp-ts7` fix row stands.
  TypeScript 7 announcement: https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/ (2026-07-08).
- `typescript-language-server` 6.0.2 - `engines.node >=22.22.2` (6.0.0 changelog: 'Node.js >=22.22.2 is required') -
  CONFIRMED, as the brief says. No peer dependencies; bin `lib/cli.mjs`.
- `csharp-ls` install: `dotnet tool install --global csharp-ls`, or `brew install csharp-ls` on macOS - CONFIRMED.
  The plugin README says '.NET SDK 6.0 or later'; the brief's '.NET 10 SDK' is alfred-code's own pin and is checked by
  the prerequisite script against `dotnet --version` (see the catalog `prereqs.note`).
- `csharp-ls` update: `dotnet tool update -g <id>` (alias `--global`) updates a global tool to the latest stable version -
  CONFIRMED, read 2026-10-27: https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-tool-update . The update command
  prints `dotnet tool update --global csharp-ls` and runs nothing; a copy installed with Homebrew is updated with brew,
  which is not verified here.

## claude-hud

- https://github.com/jarrodwatts/claude-hud - marketplace `claude-hud`, plugin `claude-hud`, install
  `claude plugin marketplace add jarrodwatts/claude-hud` then `claude plugin install claude-hud@claude-hud` - CONFIRMED.
  Update: `claude plugin marketplace update claude-hud`, then `claude plugin update claude-hud@claude-hud`.
- Latest release v0.13.1 (2026-10-26), v0.13.0 (2026-10-24), v0.12.1 (2026-10-21). The alfred-code row was verified on
  0.12.1.
- `dist/config.js` `DEFAULT_CONFIG` at tag v0.13.1 (dist is committed) - CONFIRMED to hold every key the ported row
  sets: `lineLayout` ('expanded' by default), `showSeparators`, `display.{showConfigCounts, showSkills, showMcp,
  showAgents, showTools, showCost, showEffortLevel, showPromptCache}` (all false by default),
  `gitStatus.{showAheadBehind, showFileStats}` (false by default). Step 8 re-read all 12 catalog keys against that file
  and against the installed 0.12.1 `dist/config.js`: every one present in both, and `migrateLegacyLayout` is still there
  (what `chosen_by` relies on). The row's `verified` line now names 0.13.1 (2026-10-27). The `why` strings were reworded
  to stand without alfred-code's internals; keys and values are as ported.
- README 'Auto-Refresh': a `refreshInterval` (seconds) on the `statusLine` entry keeps countdowns ticking while idle;
  setup does not write it. On Windows the README warns short intervals can make Git Bash fail (`add_item ... failed,
  errno 1`) and advises none or 30 seconds or more. NOTE for the port: the row's `refreshInterval: 5` is the
  alfred-code value; it stays as ported (the user's ruling is to port, not redesign) and the Windows caveat is printed in
  the walk when the OS is Windows.
- claude-hud 0.13.x ships its own setup (`scripts/setup.mjs install`, commands `setup` and `configure`) that writes the
  `statusLine` entry with a launcher copied to `<config dir>/plugins/claude-hud/statusline.mjs`. The ported
  `hud-statusline.js` writes the entry itself, add-only, as in alfred-code; if both ran, the add-only rule keeps the
  first. Not a design change.

## serena - oraios/serena

- Issue #311 - CHANGED. https://github.com/oraios/serena/issues/311 is CLOSED (completed, 2025-07-29), with no linked PR.
  The maintainer's comment: 'The analysis above is incorrect, there's no need to do anything windows specific for the TS
  langserver. The tests on windows run through in CI'. The closing fix was commit `c5fe377693d` (an install check made
  on a directory instead of the executable). The reporter's symptom was a 'typescript-language-server executable not
  found' assertion; the `WinError 193` theory was the reporter's own. So the build brief's premise - that #311 records a
  cmd.exe failure on the extensionless shim - is NOT what the issue says. See 'Decision - serena-windows-ts-shim' below.
- Code at the pin - MEASURED by reading the serena-agent 2.1.0 wheel (downloaded to an empty scratch folder, never run):
  `solidlsp/language_servers/typescript_language_server.py` `_create_launch_command` still reads
  `return [core_path, "--stdio"]`, `core_path` being `<tsserver dir>/node_modules/.bin/typescript-language-server`. The
  launch goes through `solidlsp/util/subprocess_util.py`: `subprocess.Popen(cmd, ..., shell=True)` with
  `oslex.join(cmd)`, so on Windows it reaches cmd.exe. cmd.exe resolves a path with no extension through PATHEXT
  (`.CMD`), which is why the unpatched launch may work; that is NOT RUN (no Windows here). The same `shell=True` path is
  why an unquoted `SERENA_HOME` with a space or `/` is cut (the `serena-windows-home` row), consistent with alfred-code's
  launcher header.
- Related: #368 closed; PR #369 ('TypeScript, Intelephense server initialization on Windows under Claude Code') was closed
  unmerged; #368 was a hang and a `bash.exe` quoting error, not the shim.
- `SERENA_HOME` ('defaults to ~/.serena ... set the SERENA_HOME environment variable',
  `docs/02-usage/050_configuration.md`; `serena/config/serena_config.py` reads it) - CONFIRMED.
- `SERENA_USAGE_REPORTING=false` (same doc; `serena/agent.py` returns early on it) - CONFIRMED.
- Flags in 2.1.0 `serena/cli.py` `start-mcp-server`: `--context`, `--project-from-cwd` ('nearest ancestor containing
  .serena/project.yml or .git'; cannot combine with `--project`), `--enable-web-dashboard <bool>`, `--agent-interface
  tools|REPL` - CONFIRMED. `serena/config/client_setup.py` itself emits `--context=claude-code --project-from-cwd`.
- PyPI 2.1.0 `requires_python` `>=3.11,<3.15`, uploaded 2026-10-19 - CONFIRMED (so 3.13 is inside the range).

## Playwright MCP - microsoft/playwright-mcp 0.0.83

- https://github.com/microsoft/playwright-mcp/blob/main/README.md - CONFIRMED options: `--browser` (chrome, firefox,
  webkit, msedge), `--executable-path`, `--no-webmcp` ('do not collect or expose the tools that a page registers through
  the WebMCP API'), `--output-dir`, `--secrets`, `--user-data-dir` ('If not specified, a temporary directory will be
  created').
- Relative paths - read from the bundled playwright-core (`lib/coreBundle.js`): `--user-data-dir` is
  `path.isAbsolute(p) ? p : path.resolve(p)` and `--output-dir` is `path.resolve(...)`, so a relative value resolves
  against the MCP process's cwd, not against the MCP roots. A relative root is safe only if the server starts in the
  project directory; step 12 measures that per row.

## appium-mcp

- Env table (README in the 1.97.1 tarball and on main) - CONFIRMED for `SCREENSHOTS_DIR` (relative paths resolve from the
  cwd), `PAGE_SOURCES_DIR`, `NO_UI`, `REMOTE_SERVER_URL_ALLOW_REGEX`, `ANDROID_HOME`. `ALLOW_REMOTE_APP_URLS` is in the
  README but the string was not found in the 1.97.1 `dist`, so it may be a no-op at that pin; it stays (harmless).
- `JAVA_HOME` - NOT FOUND in appium-mcp's docs or dist. It is Appium's own Android toolchain variable (the alfred-code
  `mobile-launch.js` header measured the need), so `appium-sdk-env` keeps it, recorded as not documented by appium-mcp.
- `npm audit` for an npx-only package - MEASURED: in an empty scratch project `npm install --package-lock-only
  --ignore-scripts appium-mcp@1.97.1` then `npm audit --json` works and reports `metadata.vulnerabilities` of
  `{info 0, low 1, moderate 1, high 17, critical 3, total 22}` over 1191 dependencies (2026-10-27). Nothing was
  executed. The walk's pre-apply audit uses exactly these two commands in a temp folder.
- Latest 1.99.1 (2026-10-27) is under the age gate; 1.97.1 (2026-10-12) is the pin.

## Desktop servers

- windows-mcp 0.8.8 (https://github.com/CursorTouch/Windows-MCP): `serve`; `--exclude-tools "A,B"` after `serve` (env
  `WINDOWS_MCP_EXCLUDE_TOOLS`); tools App, PowerShell, FileSystem, Registry, Process, Clipboard, Notification, Snapshot,
  Screenshot, Scrape, Click, Type, Scroll, Move, Shortcut, Wait, WaitFor, MultiSelect, MultiEdit, ControlStatus,
  DisplayInventory; `ANONYMIZED_TELEMETRY=false`; Python 3.14+; `App` has `launch` and `launch_executable` modes - all
  CONFIRMED.
- macos-mcp 0.4.6 (https://github.com/CursorTouch/MacOS-MCP; PyPI points at jeomon/MacOS-MCP, which redirects there):
  `serve`; tools App, Shell, Snapshot, Click, Type, Scroll, Move, Shortcut, Wait, Scrape, Notification; no
  `--exclude-tools` flag (a config file `[tools] exclude = [...]` instead); `ANONYMIZED_TELEMETRY=false`; Python >=3.11 -
  CONFIRMED.

## memory - doobidoo/mcp-memory-service

- 12.1.1 is the pin (12.4.0 is latest, newer than 7 days). Extras `[sqlite]` exists; console script `memory`
  (`memory = mcp_memory_service.cli.main:main`) with the click subcommand `server`; README `claude mcp add memory --
  memory server` - CONFIRMED. Env `MCP_MEMORY_STORAGE_BACKEND=sqlite_vec`, `MCP_MEMORY_SQLITE_PATH`,
  `MCP_MEMORY_SQLITE_PRAGMAS` (docs example `journal_mode=WAL,busy_timeout=15000`) - CONFIRMED.
- CHANGED: `numpy>=1.24.0` and `sqlite-vec` are core dependencies in 12.1.1, so `--with numpy` is redundant. The catalog
  drops it. 12.4.0's notes change none of the above.

## uv and npm

- `uvx --python <req>` and `--exclude-newer <RFC 3339 timestamp>` (also `UV_EXCLUDE_NEWER`) - CONFIRMED
  (https://docs.astral.sh/uv/reference/cli/, https://docs.astral.sh/uv/guides/tools/). The page read was the `uv run`
  section; `uvx` taking the same flag is the one inferred point, and the matrix runs `uvx ... --help` to prove it.
- `npm_config_before` for npx - the npm docs describe `before` for `npm install` only. MEASURED on npm 11.6.1: with
  `npm_config_before=2026-08-30T00:00:00Z`, `npx -y @playwright/mcp@latest --version` printed 0.0.79; with
  `2026-09-10T00:00:00Z`, 0.0.80 (releases 0.0.79 on 2026-08-06, 0.0.80 on 2026-09-01, 0.0.81 on 2026-09-14). CONFIRMED.

## Catalog changes after step 1

| Row | Brief | Catalog now | Source |
|---|---|---|---|
| context7 | header `Context7-API-Key` | `Authorization: Bearer ${CONTEXT7_API_KEY}`; local `npx -y @upstash/context7-mcp@4.4.4 --api-key ${CONTEXT7_API_KEY}` | all-clients page |
| github | image tag `<tag>` | `ghcr.io/github/github-mcp-server:v2.0.2` (v2.0.3 is 6 days old); remote bearer `${GITHUB_PERSONAL_ACCESS_TOKEN}` | releases, README |
| gitlab | path `/api/v4/mcp` | same; needs GitLab 18.6+ and an admin-enabled MCP setting on self-managed | GitLab docs |
| atlassian | `/v1/...` | `https://mcp.atlassian.com/v2/mcp` | Atlassian README |
| sentry | `@sentry/mcp-server@<pin>` | 0.42.0 | npm |
| memory | `--with numpy` | dropped (core dependency) | PyPI metadata |
| appium | 1.97.1 | 1.97.1 (age gate holds it; latest is 1.99.1) | npm |
| windows-npx-cmd | 'Claude Code's MCP docs ask for' `cmd /c` | kept as an unproved precaution, `documented: false`, Windows VM NOT RUN | changelog 2.1.119 |
| serena-windows-ts-shim | 'upstream #311' | left out - see 'Decision - serena-windows-ts-shim' | issue, wheel |

## Decision - serena-windows-ts-shim

The brief put the shim patch in three places: the install plan on Windows (pre-warm, then patch), the serena bump in the
update skill, and `/preferred-tools:fix`. Its stated reason was serena #311. Verified in step 1: #311 is closed as an
incorrect analysis, there is no upstream fix to wait for, and the 2.1.0 launch runs through `shell=True`/cmd.exe, which may
resolve the extensionless shim itself. Nothing proves the patch is needed or that it is not: only a Windows run of an
unpatched 2.1.0 does, and the patch edits a file in uv's cache.

**Ruled by the user, 2026-10-27: leave it out.** Not in the install plan, not in the update command, not in the fix command.
The row stays in `catalog/fixes.json` with `hold` and this evidence, and `fix.js` lists it as 'Held, not checked'. If a
Windows run of an unpatched serena shows the failure, the row becomes a detector in `scripts/fixes/` and the three
places follow; until then nothing here writes to uv's cache.

## Step 12 - temp-project matrix (measured 2026-10-27, Claude Code 2.1.311, macOS arm64, isolated HOME and CLAUDE_CONFIG_DIR)

`npm run matrix` (`tests/matrix/`), the real `claude` CLI against a throwaway home and account, each result read back
from the file the CLI wrote.

- **projectScope measurement - NOT RUN.** Every local row keeps `projectScope: false`, the only value the brief allows
  without a measurement. Measuring a row means starting its server from the project root and from a subfolder and then
  driving a tool call (the browser, desktop and memory servers create their data folders on first use, not at start), and
  a tool call needs a signed-in session that the isolated account does not have. A relative `--user-data-dir` or
  `SERENA_HOME` resolves against the server's working directory, which Claude Code sets to the directory it was started
  in, so from a subfolder it splits the data. Left for the live check on the user's account.
- **`uvx --python 3.13 --exclude-newer 2026-10-20T23:59:59Z --from serena-agent@2.1.0 serena --help`** - exit 0 on uvx
  0.13.4 (scratch `UV_CACHE_DIR`), so the pin-plus-cut-off form the catalog writes is accepted.
- **Windows rows** (windows-control, serena-windows-home, windows-npx-cmd, windows-arm-python): the plan and detectors
  run with a simulated platform and the CLI rewrite is the real one; a real Windows machine is the user's live check.
  windows-control itself is NOT RUN on macOS.
- **Start check after fetch.js** (`tests/matrix/starts.test.js`, 2026-10-27, Claude Code 2.1.311): each local row
  installed, fetched and started once by `fetch.js`, `claude mcp get` read, then started again and timed against the
  30-second limit. macOS arm64: serena 0.6 s, memory 1.9 s (its first start inside `fetch.js` took 138 s), context7
  0.6 s, playwright-chrome 0.7 s, appium 1.5 s, macos-control 1.3 s, each '✔ Connected'; matrix 53 pass, 0 fail, 4 NOT
  RUN (windows-control: not darwin; sentry and github local: no token). Linux aarch64 (Docker `node:22` with uv 0.13.4
  and the same CLI): serena 0.6 s, memory 1.1 s, context7 0.9 s, playwright-chrome 0.7 s, appium 1.6 s,
  typescript-language-server answered; unit tests 218 pass, matrix 50 pass, 0 fail, 7 NOT RUN (macos-control and
  windows-control: not linux; sentry local: no token; github local: no docker in the container; csharp-ls: not
  installed there). Windows: NOT RUN - the user's VM.

## alfred-code hooks over the commands (measured 2026-10-29, Claude Code 2.1.312, macOS arm64)

`node tests/probes/alfred-hooks.js --scratch <S>` replays every step of the four commands (each
`node "${CLAUDE_PLUGIN_ROOT}/scripts/..."` line parsed from `commands/*.md`, the writes of `<tmp>/picks.json` and
`<tmp>/answers.json`, every ask) through the hooks the `alfred-code` entry of each release's
`.claude-plugin/marketplace.json` registers, as one session per command: SessionStart, UserPromptSubmit,
UserPromptExpansion, PreToolUse / real run / PostToolUse per step, Stop. The payload fields are the ones a logged-out
`claude -p "/preferred-tools:install"` sent to logging hooks. Each release is installed by the real CLI into its own
isolated account (every release names its marketplace `envoydev`), its projects set up by its own installer: a plain
project at every release; a workspace root and its child from v2.11.0, the first release with workspaces (v2.11.0 joins
the child with `workspace.js register`, its own matrix's way; v3.0.0 on answers `workspace.js role`). The folder is
seeded with every catalog server for the OS plus registrations holding live-shaped values (a sentry token, a context7
`X-API-Key` header, an own server's `API_KEY`, `DB_PASS`, `userPass` and a connection-string password, a userinfo URL).

**The scratch folder sits outside the temp folder.** alfred-code's `guard-cross-project-write.js` (v3.2.1) allows the
temp folder only while the temp folder does not hold the project (`allowRoots` drops a root that contains it), so a
project built inside it saw every Write of `<tmp>/picks.json` blocked - a block no real project meets. The probe refuses
a `--scratch` inside the temp folder.

Counts as the run printed them; the probe now also prints the two step-changing contexts below as FINDING.

| Release | Folders | PASS | CONTEXT | FINDING | NOT RUN |
|---|---|---|---|---|---|
| v2.9.0 | solo | 152 | 18 | 10 | 4 |
| v2.11.0 | solo, root, child | 534 | 66 | 30 | 12 |
| v3.0.0 | solo, root, child | 534 | 66 | 30 | 12 |
| v3.2.1 | solo, root, child | 534 | 66 | 30 | 12 |

Every release and every folder gave the same FINDINGs, all on the live values (D2):

- `shell-guards.js` PreToolUse, `block (exit 2)` - 'this command runs a script FILE (`node <script>`) and names
  `<tmp>/inventory.json`, which holds a credential under `registrations.<n>.entry.env.SENTRY_ACCESS_TOKEN` - nothing
  ran': install `table.js` (step 3), `plan.js --questions` (4, 8), `plan.js` (14); configure `table.js` (3),
  `plan.js --questions` (4, 9), `plan.js` (14), and `apply.js` naming `<tmp>/plan.json` (16, `steps.0.entry.env`).
- `guard-stop-contract.js` Stop, `block (exit 2)` after configure - 'A credential appears to have entered this
  session': configure's `plan.js` printed the `claude mcp add-json sentry-moved '...'` line it would run with the live
  token in it (`sntryu_`, the guard's `SECRET_SHAPE`). Beside it, at the next ask, `guard-stop-contract.js` PreToolUse
  added 'A credential-shaped value has already entered this session's tool results ... ask whether to rotate it'.
- `guard-stop-contract.js` AskUserQuestion PreToolUse (additionalContext, configure steps 6 and 7) - 'This ask named
  remote or job state that no remote-aware read in this turn backed. Read it fresh (`git fetch` ...) before acting':
  the route ask '<tool>: remote or local?' with its 'Remote' option. The guard's `REMOTE_STATE_RE` (v3.2.1 :2528)
  matches a bare `remote`, which in preferred-tools names the hosted route, not git state. Counted as a FINDING: it
  sends Claude to fetch and re-ask.

The rest of the CONTEXT lines only inform and are recorded as PASS: `docs-session.js`, `preferences-session.js`,
`forge-session.js`, `memory-session.js` and `history-session.js` at SessionStart, `guard-answer.js`'s answer budget at
UserPromptSubmit. `fix` and `update` passed whole at every release. NOT RUN in every install and configure session:
`fetch.js "<file>"` (the replayed apply handed no fetch file on) and `hud-statusline.js --check` (claude-hud not
picked).
