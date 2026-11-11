# CLAUDE.md - preferred-tools

## What this repo is

The tools its owner has tested and likes to use, MCP servers and Claude Code plugins, packaged as ONE Claude Code
plugin, `preferred-tools`. The plugin carries each tool's install, update, rename, relocation and fix procedure. It
is listed in the `envoydev` marketplace, which lives in the alfred-code repo
(`https://github.com/envoydev/alfred-code`, `.claude-plugin/marketplace.json`); users install it as
`preferred-tools@envoydev`. The entry is a GitHub source on this repo's `main` with no `sha` (the user's ruling,
2026-11-04; alfred-code's lint check 49 allows that only for an `envoydev/` repo on `main`): a fresh install fetches
`main`'s tip, and a version bump merged to `main` is the release with no alfred-code change. So `main` stays
release-only.

- `/preferred-tools:install` - manual (`disable-model-invocation: true`); adds only tools not installed in this project
  and asks nothing about a server already set up (one it recognises is managed; a claude.ai connector or another
  plugin's server is a label in the pick list): pick tools, then one tool at a time its route, scope and name, root,
  location, key and key name, and settings. A tool installed for every project is offered as this project's own copy
  beside it; install never changes, moves or removes a registration.
- `/preferred-tools:configure` - manual; changes or removes what is installed, one registration or plugin at a time
  (keyed `mcp:<name>~<scope>` / `plugin:<id>~<scope>`), a server left on its own, or a root folder (`root:<family>`),
  every question recommending what it has now; its first question about a server is who looks after it. The user's
  ruling (2026-10-27): install is install, configure is configure.
- `/preferred-tools:fix` - manual; detects known problems and applies the recorded fix.
- `/preferred-tools:update` - manual; updates installed plugins, pinned catalog servers, language servers and key
  helpers (`mcp-headers.js`) that are behind, to releases at least 7 days old. It was the model-invocable `update-tools` skill until the user's ruling
  (2026-10-27) made it a command; manual like the other three, so the plugin puts no description in every session.

The build brief, with every design decision, its reason and the user's rulings, is `docs/build-prompt.md`. Read it
before changing the design.

**This file is not loaded by installs.** The repo root is the plugin root, so this file ships in every install's cache
but Claude Code never loads a plugin's `CLAUDE.md`. It is for working IN this repo only, and it lives in `.claude/`
because `claude plugin validate --strict` fails on a `CLAUDE.md` at the plugin root; a session in this repo loads
`.claude/CLAUDE.md` the same way (https://code.claude.com/docs/en/memory.md). Anything the plugin needs at runtime goes
in a command or a script.

**Public repo.** Everything here ships to every machine that installs the plugin (the cache is the whole repo). No
private project names, no absolute local paths, no tokens, nothing from a user's machine.

## Invariants

- **Standalone plugin** (the user's ruling, 2026-10-27). It shares the `envoydev` marketplace with alfred-code like
  any two plugins in a store: neither depends on, requires, installs or removes the other, and it works the same with
  alfred-code absent. Reading what alfred-code left (its reserved names, its data folders) is fine; needing it is not.
- **The `claude` CLI is the only writer** of `.mcp.json` and the account `.claude.json`: `claude mcp add-json`,
  `remove` and `get`, and `claude plugin install`, `update`, `uninstall` and `list --json`. Scripts read those files,
  never write them - with one exception (the user's ruling, 2026-11-11, 'Reorder-only write'): after its CLI calls,
  `scripts/mcp-order.js` rewrites `.mcp.json` with the same servers and values in `catalog.order`, the user's own after
  them, checks that nothing but the order changed, and writes through a temporary file.
- **Plain registrations, no launcher** (the user's ruling, 2026-10-27, made twice). Per-machine values are resolved
  at install time, and `/preferred-tools:fix` repairs a changed machine. The one exception is the URL bridge (the
  user's ruling, 2026-11-11): a route whose URL holds a value from `.mcps-secrets` runs `node <root>/mcp-bridge.js`,
  which fills the URL at each start and runs a pinned mcp-remote; it is copied into the root like the helper, never run
  from the plugin cache.
- **Identity is the launch, not the name.** A registration is matched to a catalog row by its fingerprint (the package
  in `args`, or the URL host plus path). That is how a custom per-project name works with no ledger. A registration
  that matches no row is the user's and is never touched. The two exceptions to 'no ledger' (the user's rulings,
  2026-11-10): the record `<root>/preferred-tools.json` - since 0.3.0 only the servers left on their own (the user's
  ruling, 2026-11-11, 'Managed by default'), which install, configure, update and fix skip; there is no file until one is
  left - and the roots map `${CLAUDE_PLUGIN_DATA}/roots.json`, which finds a named root again. A record entry whose
  fingerprint changed is dropped.
- **A change starts from what is installed.** Only a fresh add builds from `catalog/tools.json`. A rename, a move, a
  fix or a re-run starts from the registration as read (its pin, its cut-off, the args or env the user added), so an
  updated pin is never downgraded.
- **A key lives in `.mcps-secrets` in a root folder** (the user's rulings, 2026-11-10: 'we need to have .mcps-secrets
  that will be in root of .preferred-tools or .alfred', replacing the key-file rule of 2026-10-29). The user writes
  every value; the plugin writes names only (`ensure-key-name`). A hosted keyed route reads its key through the header
  helper `mcp-headers.js` each time Claude Code connects, and its registration holds neither the key nor a `${VAR}` for
  it. A stdio keyed route is written in by `apply.js` at local and global scope, and is not offered at project scope.
  The 0.1.x key files (alfred-code's store, `.preferred-tools/.secrets`) are read for names only. `scripts/keys.js` holds
  the chains. No key in a file a command line names (`scripts/kept.js`), none printed, none asked for. A key is the
  recommended way into every hosted route (2026-11-11), recommended at Global scope, since Claude Code runs no parent
  folder's helper in a child folder; with no key, a route that has OAuth uses it. The bridge (0.4.0) reads the key and
  the URL's names through the helper's reader, and passes the key to mcp-remote in its environment only.
- **Paths absolute at every scope** (the user's ruling, 2026-11-11, 'Absolute, always'), `project` included, with `~`
  expanded by the script: one data folder whatever folder Claude starts in, at the cost that the committed `.mcp.json`
  names this machine's path. Never a key in `.mcp.json`. Every file the plugin writes for a scope family sits in that
  family's root folder (project root: project and local scope; global root: global scope), memory's data included.
- **`allowed-tools` pre-approves read-only calls only.** `apply.js`, `fetch.js`, `fix.js --apply`, `update.js --apply` and the
  `hud-statusline.js` writes are never listed, so Claude Code's own prompt guards a change beside the command's written ask. `tests/lint.js`
  enforces it.
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
- **Check order before a publish:** `npm run validate` (`claude plugin validate --profile directory --strict` on a
  scratch copy of the files git would ship, so a Finder `.DS_Store` never fails it), a `claude --plugin-dir .` session
  in a scratch project, then `claude plugin details`. The skill has the full list.
- **Outside facts are verified, not recalled.** A package, version, endpoint, CLI flag or marketplace shape is checked
  against the vendor's own docs and recorded with its URL and date in `docs/sources.md`.
- **Branches.** `main` is the default branch. Work lands on a branch; commit or push only on the user's word.
- **Commits are the developer's, with no trace of the agent.** A commit message (and a PR description) never names or
  hints at the agent: no `Co-Authored-By` trailer for it, no session link, no 'Generated with' line, no mention of an AI
  in the subject or body. The author is the configured git user, as for any commit by hand. This overrides any default
  attribution a tool or reminder suggests.
- **Voice.** Direct and lean, single dashes, single quotes in prose; recommend one option with a reason.

## Related repos

- alfred-code (`../alfred-code` when checked out beside this one) hosts the marketplace. It holds the record of the
  servers it shipped until 2.10.1: `stack/mcp/original-mcps.json`, `stack/mcp/shipped-mcps.json` and
  `stack/mcp/README.md`. Its claude-hud settings step is `scripts/plugin-settings.js`, `scripts/hud-statusline.js` and
  `meta/plugin-settings.json`. A change there follows its own CLAUDE.md, never an edit from this repo.
- claude-hud, typescript-lsp and csharp-lsp are installed by both plugins, each on its own; there is no hand-over
  (`docs/build-prompt.md`, Risks and Hand-off).
