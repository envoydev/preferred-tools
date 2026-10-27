# CLAUDE.md - preferred-tools

## What this repo is

The tools its owner has tested and likes to use, MCP servers and Claude Code plugins, packaged as ONE Claude Code
plugin, `preferred-tools`. The plugin carries each tool's install, update, rename, relocation and fix procedure. It
is listed in the `envoydev` marketplace, which lives in the alfred-code repo
(`https://github.com/envoydev/alfred-code`, `.claude-plugin/marketplace.json`); users install it as
`preferred-tools@envoydev`.

- `/preferred-tools:install` - manual (`disable-model-invocation: true`), configure-style walk: pick tools, then
  route, scope, name and location per tool.
- `/preferred-tools:fix` - manual; detects known problems and applies the recorded fix.
- `update-tools` skill - updates installed plugins and registered catalog servers that are behind.

The build brief, with every design decision, its reason and the user's rulings, is `docs/build-prompt.md`. Read it
before changing the design.

**This file is not loaded by installs.** The repo root is the plugin root, so this file ships in every install's cache
but Claude Code never loads a plugin's `CLAUDE.md`. It is for working IN this repo only. Anything the plugin needs at
runtime goes in a command, the skill or a script.

**Public repo.** Everything here ships to every machine that installs the plugin (the cache is the whole repo). No
private project names, no absolute local paths, no tokens, nothing from a user's machine.

## Invariants

- **The `claude` CLI is the only writer** of `.mcp.json` and the account `.claude.json`: `claude mcp add-json`,
  `remove` and `get`, and `claude plugin install`, `update`, `uninstall` and `list --json`. Scripts read those files,
  never write them.
- **Plain registrations, no launcher** (the user's ruling, 2026-10-27, made twice). Per-machine values are resolved
  at install time, and `/preferred-tools:fix` repairs a changed machine.
- **Identity is the launch, not the name.** A registration is matched to a catalog row by its fingerprint (the package
  in `args`, or the URL host plus path). That is how a custom per-project name works with no ledger. A registration
  that matches no row is the user's and is never touched.
- **A change starts from what is installed.** Only a fresh add builds from `catalog/tools.json`. A rename, a move, a
  fix or a re-run starts from the registration as read (its pin, its cut-off, the args or env the user added), so an
  updated pin is never downgraded.
- **No secret in any file.** Remote routes prefer OAuth; token routes register `${VAR}`.
- **Paths by scope.** `project` scope (the committed `.mcp.json`) gets relative paths and `${VAR}` only. `local` and
  `user` scope get absolute paths, with `~` expanded by the script.
- **Script paths go through the plugin root.** A command's shell runs in the user's project, so every call is
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/<file>"`.
- **Asks stay within the AskUserQuestion limits** (1-4 questions per call, 2-4 options each). Exactly one option is
  marked `(Recommended)`, listed first, and nothing is applied before the plan is confirmed.
- **Zero runtime dependencies.** Node 22 built-ins only. A plugin's Node dependencies install only with a lockfile and
  `--ignore-scripts`, and `claude plugin update` installs none of the new `dependencies` a release adds. So the
  manifest never declares `dependencies`.

## Plugin facts this repo relies on

From `.claude/skills/plugin-authoring/` (checked against the Claude Code plugin docs on 2026-09-12) and
`docs/plugin-cli-evidence.md` (measured). Re-verify a fact against the docs when Claude Code has moved far past
those dates.

- **One version, in `.claude-plugin/plugin.json`.** It silently overrides a version in the marketplace entry. A source
  change without a version bump is not delivered, so bump on every user-visible change.
- **Updates are pulled.** Auto-update is off for third-party marketplaces, so a release reaches users on their own
  `claude plugin marketplace update` / `claude plugin update`.
- **Never rename or drop the id `preferred-tools`.** Every install goes silent and does not self-heal.
- **`install` is not a no-op over an installed plugin.** It adds a second row, or flips a disabled one on, and always
  prints `Successfully installed`. `enable` over enabled and `disable` over disabled exit 1.
- **`plugin list --json` `enabled` is not proof** that a plugin runs. Read the settings file at its scope; its
  `errors` field is the only place a broken plugin says so.
- **Component paths start with `./`** and never reach above the root. A path field replaces its default folder,
  except `skills`, which adds to it.
- **`${CLAUDE_PLUGIN_ROOT}` changes on every update** (the cache is versioned), so nothing durable lives under it and
  no registration points into it. `${CLAUDE_PLUGIN_DATA}` is the plugin's persistent dir.
- **`allowed-tools` in a command is a per-turn pre-approval**, not a restriction, and it lasts only the turn the
  command runs in.

## Working in this repo

- **Every change is proven on a throwaway project, never the real account.** Run the matrix under an isolated
  `CLAUDE_CONFIG_DIR` and `HOME` in the session scratchpad. Two real side effects happened before this rule existed:
  matrix installs left records for deleted scratch projects in the real `~/.claude/plugins/installed_plugins.json`,
  and nested `claude -p` sessions on the real config ended logged out. Ask before any run against the real account,
  and say it may cost a `/login`.
- **Read the result, not the exit code.** Open the written `.mcp.json`, account file and settings after each case.
  A case not run is reported as NOT RUN, never implied as passing. Windows-only behaviour is proved on the user's
  Windows VM or reported NOT RUN.
- **Check order before a publish:** `claude plugin validate . --strict`, a `claude --plugin-dir .` session in a
  scratch project, then `claude plugin details`. The skill has the full list.
- **Outside facts are verified, not recalled.** A package, version, endpoint, CLI flag or marketplace shape is checked
  against the vendor's own docs and recorded with its URL and date in `docs/sources.md`.
- **Branches.** `main` is the default branch. Work lands on a branch; commit or push only on the user's word.
- **Voice.** Direct and lean, single dashes, single quotes in prose; recommend one option with a reason.

## Related repos

- alfred-code (`../alfred-code` when checked out beside this one) hosts the marketplace. It holds the record of the
  servers it shipped until 2.10.1: `stack/mcp/original-mcps.json`, `stack/mcp/shipped-mcps.json` and
  `stack/mcp/README.md`. Its claude-hud settings step is `scripts/plugin-settings.js`, `scripts/hud-statusline.js` and
  `meta/plugin-settings.json`. A change there follows its own CLAUDE.md, never an edit from this repo.
- claude-hud, typescript-lsp and csharp-lsp move from alfred-code to this plugin. Until alfred-code's hand-off ships,
  both install them (`docs/build-prompt.md`, Risks).
