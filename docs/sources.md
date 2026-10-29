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

## Platforms - macOS, Linux and Windows (measured 2026-10-29)

Each OS ran `npm test`, the hook replay (`node tests/probes/alfred-hooks.js`, alfred-code v2.9.0, v2.11.0, v3.0.0 and
v3.2.1) and `npm run matrix`, each in a throwaway home and account. Every machine here is ARM: Windows on x64 is NOT RUN,
and Linux x64 ran only under emulation.

- **macOS arm64** (Claude Code 2.1.312, uv 0.13.4): npm test 240, 239 pass, 0 fail, 1 skip (no alfred-code checkout
  beside the scratch copy); `npm run validate` pass; matrix 57, 53 pass, 0 fail, 4 NOT RUN (windows-control x2: not
  darwin; sentry and github local: no token). The hook replay is the next section's.
- **Linux aarch64** (Docker `node:22.23.3`, Claude Code 2.1.312, uv 0.13.4, git 2.39.5): npm test 240, 239 pass, 1 skip
  (PL7: no claude-hud in the container's plugin cache); matrix 57, 50 pass, 0 fail, 7 NOT RUN (macos-control x2 and
  windows-control x2: not linux; sentry local: no token; github local: docker not on PATH; csharp-ls not on PATH); the
  hook replay 1845 PASS, 0 FINDING, 50 NOT RUN (`fetch.js` with no fetch file handed on, `hud-statusline.js --check`
  with claude-hud not picked).
- **Linux x64, emulated** (the same versions in a `linux/amd64` image under Docker Desktop's Rosetta): npm test 240,
  228 pass, 2 skip, 10 fail - all ten `plugin-settings.test.js` argument-error cases, for one reason: Rosetta writes
  `$HOME/.cache/rosetta` for every x64 process (`HOME=<empty> node -e 0` leaves it), and those cases assert the throwaway
  home stays empty. Each one's exit 2 and message passed first. Not a result for x64 hardware.
- **Windows 11 on ARM64** (a Parallels VM driven by `prlctl exec`, which runs as SYSTEM; node 22.23.3, Claude Code
  2.1.309 as the native `claude.exe`; uv 0.13.4 installed for this run at the user's word, with
  `https://astral.sh/uv/0.13.4/install.ps1` into the machine PATH):
  - npm test, the first run of the unit suite on Windows: 25 of 240 failed, all from the test world. A spawn of `claude`
    looks for a `.exe` or `.com` only, so it ran the real `claude.exe` instead of the `claude.cmd` shim;
    `tests/helpers.js` now leaves a PATH folder holding a real `claude`, `npm`, `uvx` or `docker` `.exe` or `.com` out of
    a test's PATH, and `claude-cli.js` takes its `cmd.exe` route to the shim. Eight more tests were shaped for POSIX or
    x64 and now expect each platform's own result: serena's data folder on Windows is `<home>\.serena`
    (serena-windows-home); a home path inside the add-json JSON has its backslashes escaped; a bare
    `spawnSync('claude')` cannot reach a `.cmd`; ARM64 Windows gets the x64 Python build (windows-arm-python); a
    darwin-shaped seed on Windows also meets serena-windows-home. After: 240, 235 pass, 0 fail, 5 skip (three POSIX-only tests by design, no
    alfred-code checkout beside the copy, PL7: no claude-hud in the cache). D6's test (local servers found
    under the key Claude Code writes on Windows) passes.
  - matrix 58, first run: 45 pass, 4 fail, 9 NOT RUN. The two serena data-folder checks failed on the POSIX shape above
    (2/2 after the fix); `starts: appium` got no answer after a 346 s fetch on a VM another workload loaded, and that
    run's cleanup hit EBUSY - alone, appium answered in 12.6 s, '√ Connected'. With uv: serena answered in 3.7 s on the
    x64 Python build and memory in 3.8 s, each '√ Connected'; windows-control fetched `windows-mcp==0.8.8` and exited
    'No active interactive desktop for physical input control', since SYSTEM has no desktop (`fetch.js` warned and kept
    the registration, as it should). NOT RUN: macos-control x2 (not darwin), the windows-control start (no interactive
    desktop), sentry local (no token), github local (docker not on PATH), typescript-language-server and csharp-ls (not
    on PATH).
  - the hook replay: 1881 PASS, 40 NOT RUN (the two kinds above) and 5 FINDING, all `error ETIMEDOUT` at v2.11.0 solo
    (forge-session.js x2, docs-session.js x2, guard-answer.js) under that load; the v2.11.0 rerun (solo, root and child;
    install, configure and fix) gave 486 PASS, 0 FINDING, 12 NOT RUN.
  - Windows x64: NOT RUN - no x64 machine. An x64 node under the VM's emulation still reads ARM64 from
    `PROCESSOR_ARCHITECTURE`, as `isWindowsArm` means it to, so the x64 choices (`--python 3.13`, not the x64 build) are
    covered only by unit tests on a simulated platform.

0.1.3 - the workspaces branch (inherited servers, key files, the `claude.cmd` quoting, the final review's fixes), on
the same machines:

- **macOS arm64:** npm test 282, 281 pass, 0 fail, 1 skip (the Windows-only `claude.cmd` round trip); matrix 62, 58
  pass, 0 fail, 4 NOT RUN (windows-control x2: not win32; sentry and github local: no token); the hook replay 1884 PASS,
  0 FINDING, 40 NOT RUN; the workspace checks W1-W4 pass.
- **Linux aarch64:** npm test 282, 280 pass, 0 fail, 2 skip (the `claude.cmd` round trip; PL7); matrix 62, 55 pass, 0
  fail, 7 NOT RUN (macos-control x2 and windows-control x2: not linux; sentry local: no token; github local: docker not
  on PATH; csharp-ls not on PATH); W1-W4 pass; the hook replay 1845 PASS, 0 FINDING, 50 NOT RUN.
- **Linux x64, emulated:** npm test 282, 270 pass, 2 skip, 10 fail - the same ten Rosetta `.cache` cases as above;
  matrix 62, 55 pass, 0 fail, 7 NOT RUN, as aarch64; the hook replay as aarch64.
- **Windows 11 on ARM64** (Claude Code 2.1.309, uv 0.13.4): npm test 282, 275 pass, 0 fail, 7 skip (three POSIX-only
  tests, PL7, the reserved-names test and the two key-engine contract tests: no alfred-code git checkout beside the copy -
  W4 reads the real engine of each release on Windows instead); matrix 62, 55 pass, 0 fail, 7 NOT RUN (macos-control x2:
  not darwin; the windows-control start: no interactive desktop; sentry local: no token; github local: docker not on
  PATH; typescript-language-server and csharp-ls: not on PATH); W1-W4 pass; appium answered its first start in 5.9 s,
  '√ Connected'. The hook replay at v3.2.1 (solo, root and child; install, configure, fix and update): 573 PASS, 0
  FINDING, 12 NOT RUN. Its first run, beside the Linux legs, had one `error ETIMEDOUT` (v3.2.1 child, SessionStart
  `docs-session.js`) in 1884 PASS; alone it passed.
- Found by the first 0.1.3 runs and fixed before these: the `claude.cmd` quoting (Windows; the Windows section below).
  The rest were test shapes: a temp-folder check that matched any `tmp` in a path (Linux and Windows), the account file
  read by the Windows project key, and the probe reading its scratch folder's real path before making it.

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

**After the fix (same day, same releases and folders).** Every file a command line names carries a credential value as
`${PREFERRED_TOOLS_KEPT}` (`scripts/kept.js`), which the guard's `isPlaceholder` reads as no value, and `apply.js` takes
the real one back from the registration in its own process; the route is worded 'hosted' in every ask. The full replay
gave 1864 PASS, 0 `shell-guards.js` blocks, no Stop block and no rotation ask; its only FINDINGs were the remote-state
note on configure's change pick ('remote route, pin ...'), and a configure replay after that word changed gave 631 PASS
and 0 FINDING at every release. The NOT RUN lines are the same two as before (no fetch file handed on, claude-hud not
picked).

## Claude Code - .mcp.json in parent folders (measured 2026-10-29, Claude Code 2.1.312, macOS arm64)

The docs say only that a project `.mcp.json` sits 'at your project's root directory'
(https://code.claude.com/docs/en/mcp, read 2026-10-29); they say nothing of parent folders or subfolders.
`node tests/probes/mcp-tree.js` measures it with the real CLI in a throwaway home and account, logged out, no model:
`HOME` is `<S>/<variant>/home`, a `.mcp.json` sits above `HOME` (`p-above`), in `HOME` (`p-home`), in `ws` (`p-ws`,
`dup` tagged `ws`) and in `ws/api` (`p-api`, `dup` tagged `api`); `ws/api` and `ws/web` are git repos, and `ws` is one
in variant A and not in variant B. Every server is `tests/fake-mcp-server.js`, which logs its tag and working folder when
it starts. A session is a logged-out `claude -p hi`: the docs say `-p` 'loads project-scoped servers without asking'
(same page), and its stdio servers start before the login stop - but only the first batch of
`MCP_SERVER_CONNECTION_BATCH_SIZE` ('Maximum number of local MCP servers (stdio) to connect in parallel during startup
(default: 3)', https://code.claude.com/docs/en/env-vars), so the probe sets it to 20. The probe refuses to run unless
`claude auth status` says `"loggedIn": false`.

RESULT lines (folders relative to `HOME`):

- control: `-p` from `ws/api` started `[api, p-above, p-api, p-home, p-ws]`.
- M1, the same in both variants: from `ws` and `ws/web` `mcp list` names and `-p` starts `p-above`, `p-home`, `p-ws`,
  `dup` (`ws`); from `ws/api` and `ws/api/src` it adds `p-api` and `dup` is `api`. Every project server lists as
  '⏸ Pending approval'. The servers start in the session's folder (`ws/api/src` from `ws/api/src`), not in the folder
  of the file that names them.
- M2: `dup` started from `ws/api` and `ws/api/src` is `api`; `claude mcp get dup` in `ws/api` shows the `api` entry,
  'Project config (shared via .mcp.json)'.
- M3: with `dup` added at local scope in `ws/web`, the local one starts there and lists '✔ Connected'; the `ws` one
  does not start.
- M4: from `ws/api/src`, `add-json -s project` writes a new `ws/api/src/.mcp.json`; `-s local` keys the entry
  `ws/api`, the repo root, and `mcp list` shows it connected from `ws/api/src` and from `ws/api`. From `ws/web/sub`:
  `ws/web/sub/.mcp.json` and the key `ws/web`; from `ws/notes` inside `ws`'s repo (variant A): `ws/notes/.mcp.json`
  and the key `ws`. From `ws/notes` in no repo (variant B): `ws/notes/.mcp.json` and the key `ws/notes`, which `ws`
  does not list.
- M5: from a symlink to `ws/api`, the list and the starts are those of `ws/api`, the servers start in `ws/api`, and
  `-s local` keys `ws/api`.
- M6: `ws/.mcp.json` as `{ not json`: from `ws/api`, `mcp list` exits 0, prints '[Failed to parse] Project config
  (shared via .mcp.json)', and lists and starts the other files' servers; only that file's are lost.
- M7, `p-ws` from `ws/web` (a repo root), each state with `ws/web` trusted, then untrusted, through
  `projects["<ws/web>"].hasTrustDialogAccepted`, the docs' manual route (https://code.claude.com/docs/en/permissions):
  nothing set - pending both ways; `enabledMcpjsonServers` in the account file's `ws/web` entry, or in
  `ws/web/.claude/settings.local.json` - connected trusted, pending untrusted; the same in `ws/.claude/settings.local.json`
  - pending both ways (a parent folder's settings approve nothing); `disabledMcpjsonServers` in the account file's
  `ws/web` entry or in `ws/web/.claude/settings.local.json` - rejected both ways, and `mcp list` leaves the server out
  (`claude mcp get` says '✘ Rejected (see disabledMcpjsonServers in settings)'; the docs say list shows it);
  `enableAllProjectMcpServers` in the user `settings.json` - connected both ways. `claude mcp reset-project-choices`
  ('approvals and rejections stored for this project have been reset') cleared `enabledMcpjsonServers` from both the
  account file's entry and `ws/web/.claude/settings.local.json`, so the interactive prompt's choices live there. The MCP
  page agrees: in an untrusted folder only the user settings, managed settings and `--settings` approve, and 'A
  `disabledMcpjsonServers` entry in any settings file still rejects the server'.

The facts the inventory encodes:

```text
walk: filesystem-root
nearest-wins: yes
local-over-inherited: yes
symlink: real
subfolder-project-file: cwd
subfolder-local-key: git-root (no repo: cwd)
approval: rejected - disabledMcpjsonServers in the user settings, the folder's settings or its account entry (trusted or not)
approval: approved - enableAllProjectMcpServers or enabledMcpjsonServers in the user settings (trusted or not)
approval: approved - enabledMcpjsonServers or enableAllProjectMcpServers in the folder's settings or account entry, folder trusted
approval: pending - otherwise, a parent folder's settings included
(the folder is the repo root, or the session folder in no repo; trust is its account entry's hasTrustDialogAccepted)
```

Linux and Windows (measured 2026-10-29, the same probe): Linux aarch64 (Docker `node:22.23.3`, Claude Code 2.1.312)
gave all 31 RESULT lines as macOS did. Windows 11 on ARM64 (Claude Code 2.1.309, the native `claude.exe`; M5's link is
a directory junction) gave 30 of them; in the 31st, M5, the servers start in the junction's own path (`../link`), not
in `ws/api`, while `-s local` still keys `ws/api`. The 21 lines the inventory encodes (above) are identical on all
three. Linux x64 and Windows x64: NOT RUN - no x64 machine.

## alfred-code key files and `claude mcp add-json` (read 2026-10-29)

D7 (key files, `scripts/keys.js`) rests on these:

- alfred-code's key engine is `stack/hooks/secret-chain.js`, which its installer copies into a project's
  `.claude/hooks/` (`HOOK_ENGINES`, `scripts/install/alfred-code.js:106` at v2.11.0, `:107` at v3.0.0 and v3.2.1; not
  in v2.9.0). It exports `{ SECRET_FILES, readStore, storesOf, valuesOf, masker, chainOf }` (v2.11.0 `:138`, v3.0.0 and
  v3.2.1 `:109`); `chainOf(start, { env })` (v2.11.0 `:124`, v3.0.0 and v3.2.1 `:95`) returns `{ stores, values, from,
  notes }`: the project's store, then each linked workspace member's, nearest value first, a key an `ignore secret`
  line names dropped. It requires only `./layout.js` beside it, which requires only Node's own modules.
  `SECRET_FILES` is `.secrets`, then `.sensitive-data`; at each place the chain reads the first that exists, under the
  data root `layout.dataRootOf` reports (`.alfred` unless a `DATA_PATH` setting moves it).
- The store grammar is `layout.js` `readDotenv` (v3.2.1 `:443`, `DOTENV_LINE` `:417`): `KEY=value`, an optional
  `export `, one pair of matching quotes dropped from the trimmed value, `#` and `;` lines and blank lines comments, a
  BOM deciding UTF-16. `keys.js` `readDotenv` reads the same grammar for `.preferred-tools/.secrets` and an engine-less
  `.alfred` store.
- `tests/keys.test.js` requires the real engine of v2.11.0 and v3.2.1 from their tags and reads a project store through
  it (the contract test); a release that drops or changes `chainOf` is a named error and the registration keeps
  `${VAR}`.
- `claude mcp add-json --help` (Claude Code 2.1.312, isolated home): `Usage: claude mcp add-json [options] <name>
  <json>`, options `--client-secret` and `-s, --scope`. The MCP docs' 'Add MCP servers from JSON configuration'
  (https://code.claude.com/docs/en/mcp, read 2026-10-29) show only `claude mcp add-json <name> '<json>'`. No stdin or
  file form exists, so `apply.js` passes the filled entry as the argument: the key is visible in the process list while
  that one call runs, and in nothing a command prints or names.
- The same page, 'Credential variables that read as empty': 'In a remote server's `url` and `headers`, Claude Code
  reads credential variables from your environment as empty rather than expanding them' - Claude Code's own
  credentials, cloud provider credentials and others such as `HTTPS_PROXY` and `NPM_TOKEN`; 'A name outside this set,
  such as `API_KEY`, expands as written.' `CONTEXT7_API_KEY` and `GITHUB_PERSONAL_ACCESS_TOKEN` are outside the named
  set, so a project-scope `${VAR}` header still expands; a remote route written at local or user scope holds the key
  itself and expands nothing.

## Windows - the claude.cmd route (measured 2026-10-29, Windows 11 on ARM64, node 22.23.3)

npm installs Claude Code on Windows as `claude.cmd`, which Node spawns only through `cmd.exe`; `claude-cli.js` falls
back to that route on ENOENT or EINVAL (the native `claude.exe` is spawned directly and never takes it). The line is read
twice by cmd.exe - once for `cmd /d /s /c`, again for the shim's `%*` - and then by the C runtime of the node the shim
starts. Through an npm-shaped shim (`@"<node>" "%~dp0\echo.js" %*`) the old quoting (`"..."`, a quote as `""`) cut a JSON
value holding `\"` short, let cmd.exe expand `%PATH%`, and broke a path ending in a backslash; Task 6's key test with a
key holding `%^"` failed 'Invalid JSON' on it.

`cmdArg` now quotes each argument by the argv rules - a run of backslashes before a quote doubled plus one, before the
closing quote doubled, others kept
(https://learn.microsoft.com/en-us/cpp/c-language/parsing-c-command-line-arguments, read 2026-10-29), written as a loop,
linear in the argument - then caret-escapes each cmd.exe metacharacter ``()[]%!^"`<>&|;, *?`` twice, cross-spawn's
`escapeArgument` for a shim (https://github.com/moxystudio/node-cross-spawn/blob/master/lib/util/escape.js, read
2026-10-29). All 14 measured values - a JSON quote, `%VAR%`, carets, `&` and `|`, runs of backslashes before a quote and
the end, an empty argument, Unicode - came back unchanged (`tests/claude-cli.test.js`).

## windows-mcp 0.8.8 - the sticky overlay failure (read 2026-10-29)

The `windows-mcp-one-per-desktop` fix row (advice only) rests on the 0.8.8 wheel from
https://pypi.org/project/windows-mcp/0.8.8/ (sha256 matching PyPI's; 0.8.8, uploaded 2026-10-10, is the newest release)
and https://github.com/CursorTouch/Windows-MCP:

- `windows_mcp/desktop/control_overlay.py` `change()` (`:237`) waits `timeout=3.0` (`:276`) for the overlay thread to
  apply a state; on a miss it sets `self.error` (`:281`) under the comment 'Make the failure sticky so health checks can
  never grant a new AI lease with an invisible indicator'. The overlay thread's own failure sets it too (`:375`).
  Nothing clears it.
- `is_healthy()` (`:469`) needs `indicator.error is None` (`:477`).
- `windows_mcp/desktop/control.py` `_recover_after_rehook` (`:412`) leaves the `unavailable` state only when the health
  probe passes (`:421`), as does the lease check (`:540`).
- `windows_mcp/__main__.py` starts the overlay once in the server's lifespan and hands the controller its health probe
  (`:336-337`); it stops it only at shutdown (`:348`).
- No mutex or single-instance guard anywhere in the package.

So one missed confirmation leaves that server process 'unavailable' for its life, while `/mcp` shows it connected
(stdio); a new Claude Code session starts a new process. A second windows-mcp on the same desktop (each with its
low-level input hooks and overlay window) is the likely trigger - not reproduced: the test VM's `prlctl exec` has no
signed-in desktop.

alfred-code launches windows-mcp from plugins: its v2.9.0 `.claude-plugin/marketplace.json` lists `windows-control`
(mcpServers `windows-control`) and `windows-desktop` ('RETIRED in 2.4.0 - renamed windows-control', mcpServers
`windows-desktop`), both through `desktop-launch.js` with `windows-mcp==0.8.8`; v2.10.0 is the last to list them,
v2.11.0 lists neither, and preferred-tools is first listed in v3.0.0 - so no marketplace version lists both. A plugin
whose id the marketplace dropped stops loading and says so only in `plugin list --json`'s `errors`
(`docs/plugin-cli-evidence.md` S13, S25), so `inventory.windowsMcpServers` counts these plugins only enabled and with no
`errors` (a stale marketplace clone still loads them), beside the registrations that start here (M2, M3, M7 above).

Measured 2026-10-29 on this change (0.1.4, after its review fix): macOS arm64, Claude Code 2.1.312 - `npm test` 289: 288 pass, 1 skip;
`npm run matrix` 63: 59 pass, 0 fail, 4 NOT RUN (the win32-only windows-control cases; github and sentry local need
their keys). Windows 11 on ARM64, Claude Code 2.1.309, node 22.23.3, uv 0.13.4 - `npm test` 289: 282 pass, 0 fail, 7
skip; `npm run matrix` 63: 56 pass, 0 fail, 7 NOT RUN (the macos-control cases; windows-control's start, no interactive
desktop; sentry's key; github's docker; the two LSP binaries). The matrix case 'fix windows-mcp-one-per-desktop' passes
on both: two real registrations are reported once, blocked, asked nothing, and left byte-identical. Linux NOT RUN (the
user's ruling: the row is win32-only and its logic is OS-independent). The live two-server state is NOT RUN: no
interactive desktop on the test VM.

## Claude Code - a plugin off for one project, and this folder's own .mcp.json approval (measured 2026-10-30, Claude Code 2.1.312, macOS arm64)

A throwaway `HOME` and `CLAUDE_CONFIG_DIR`, a directory marketplace `mk` with three one-command plugins (`pp`, `qq`,
`rr`). Each probe starts a logged-out session in the folder named (`claude -p hi --output-format stream-json
--verbose`) and reads its `init` event's `plugins` for the plugin's name.

- P1: `pp` installed `--scope user` (user `settings.json` `enabledPlugins` `true`); the project's
  `.claude/settings.json` `{ "enabledPlugins": { "pp@mk": false } }` - not loaded, its command absent; the same in
  `.claude/settings.local.json` - not loaded; the user setting stays `true`; `plugin list --json` there reads
  `enabled: false`.
- P2: the project's `settings.json` `false` and `settings.local.json` `true` - loaded.
- P3: `claude plugin disable pp@mk --scope project` - 'Successfully disabled plugin: pp (scope: project)', the
  project's `settings.json` `false`, user `true`; in a fresh project `--scope local` - its `settings.local.json`
  `false`, user `true`, not loaded there. `qq` installed `--scope project` (`settings.json` `true`) with
  `settings.local.json` `false` - not loaded; `rr` installed `--scope local` (`settings.local.json` `true`) with
  `settings.json` `false` - loaded.
- P4: a git repository with a folder `sub`, `pp` at user scope, the session started in `sub`: the repository root's
  `.claude/settings.local.json` `false` - not loaded (in the root too); `sub/.claude/settings.local.json` `false` - not
  loaded; the root's `.claude/settings.json` `false` - loaded; `sub/.claude/settings.json` `false` - not loaded.
  `claude plugin disable pp@mk --scope local` run in `sub` writes the root's `.claude/settings.local.json`.
- P5: in `sub`, the root's `settings.local.json` `false` over `sub`'s `settings.local.json` `true` - not loaded; the
  root's `true` over `sub`'s `settings.local.json` `false` and `settings.json` `false` - loaded.
- M8: a server in the session folder's own `.mcp.json`, by M7's rules: nothing set - `claude mcp list` '⏸ Pending
  approval'; `disabledMcpjsonServers` in `.claude/settings.local.json` - `claude mcp get` '✘ Rejected (see
  disabledMcpjsonServers in settings)'; `enableAllProjectMcpServers` in the user `settings.json` - started ('Failed to
  connect' for a server that exits at once).

So a plugin loads by the first boolean `enabledPlugins[<id>]` in: the trust root's `settings.local.json` (the git root,
else the folder), the session folder's `settings.local.json`, its `settings.json`, then the user settings - counting
only files at or above the install scope (local, then project, then user). That is the file list the approvals above
read (M7). The inventory keeps it as `enabledHere` beside `enabled` (the install scope's own reading, which configure
and update act on); only `windowsMcpServers` reads it, with the folder's own server's `approval` (M8). A side effect
seen: a session in a project auto-created a local-scope install row for a plugin the marketplace lists.
