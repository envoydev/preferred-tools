# preferred-tools

The tools I have tested and like to use - MCP servers and Claude Code plugins - packaged as one Claude Code plugin. The
plugin carries each tool's install, update, rename, relocation and fix procedure, so a new machine or a new project is
a short walk instead of a hunt through old notes.

It installs nothing by itself. You drive it through four manual commands:

- `/preferred-tools:install` - first asks once about each server already set up here that it knows (a registration, a
  server another plugin provides, a claude.ai connector): leave it on its own, or let this plugin look after it. Then it
  adds tools that are not installed in this project: pick them, then per tool the route (hosted or local, where the
  tool has both) and the scope (Global, Project or Local, the recommended one first), the root folders, and the
  registration name, the key's name and the settings. A tool you installed for every project can get this project's
  own copy; the global one stays as it is. It shows one plan, applies it after one confirmation and reads the result
  back.
- `/preferred-tools:configure` - changes or removes what is installed: pick a registration or plugin, then change its
  route, scope, name, data location, key name or settings, or a plugin's scope, or claude-hud's settings; or move a
  root folder; or hand a server left on its own back to this plugin. Every question recommends what
  the tool has now, and a change keeps its pin and the args you added.
- `/preferred-tools:fix` - finds known problems in the installed tools and applies the recorded fix.
- `/preferred-tools:update` - brings installed plugins, pinned servers, language servers and key helpers up to date
  when they are behind, offering only releases at least 7 days old.

## Install

```bash
claude plugin marketplace add envoydev/alfred-code
claude plugin install preferred-tools@envoydev
```

The plugin is listed in the `envoydev` marketplace (the alfred-code repo, `.claude-plugin/marketplace.json`). Its entry
follows this repo's `main` branch with no pinned commit (no `sha`), so a release is a version bump merged to `main`.
Run the commands from the project you want the tools in, not from this repo. Updates are pulled: run
`claude plugin marketplace update envoydev` and `claude plugin update preferred-tools@envoydev`.

## The catalog

17 rows in `catalog/tools.json`: serena, memory, context7, github, gitlab, atlassian, sentry, four Playwright browsers
(chrome, msedge, firefox, webkit), appium, macOS and Windows desktop control, and the plugins claude-hud,
typescript-lsp and csharp-lsp. Every outside fact (package, version, endpoint, flag) is recorded with its URL and date
in `docs/sources.md`.

## How it works

- Every MCP server is a plain registration written by the `claude` CLI (`claude mcp add-json`, `remove`, `get`); no
  script writes `.mcp.json` or `~/.claude.json`, and no launcher sits between Claude Code and the server.
- A registration is recognised by what it launches (its package, or its URL host and path), not by its name, so a tool
  under a custom per-project name is still found, and a server of your own is never touched.
- Scopes are Global (every project on this machine - Claude Code's user scope), Project (the committed `.mcp.json`)
  and Local (this project, only you).
- Two root folders hold every file the plugin writes: the project root for Project and Local scope - `.alfred` where
  alfred-code is set up in the project, else `.preferred-tools`, or a folder you name inside the project - and the
  global root for Global scope - `~/.preferred-tools`, `~/.alfred` when it exists, or a folder you name. Each holds the
  tools' data folders (`<root>/<name>`), the key file `.mcps-secrets`, the key helper `mcp-headers.js`, the record of
  your answers `preferred-tools.json` and a `.gitignore` that keeps everything but itself and the helper out of git (alfred-code's own
  `.gitignore` covers `.alfred`). Each root is asked once, not per tool; `/preferred-tools:configure` moves one.
- Keys live in `.mcps-secrets` (`NAME=value` lines; a note goes after whitespace and `#`, or on its own `#` line),
  which you fill by hand: the plugin writes names only, and never asks for, prints or puts a key in a file a command
  names. A hosted route reads its key through `mcp-headers.js` each
  time Claude Code connects, so the registration holds no key and no `${VAR}`; a Project-scope server's helper runs once
  you accept the folder's trust prompt. A local route's key is written into the registration at Local and Global scope
  (`/preferred-tools:fix`, `token-sync`, writes it again after you change it); such a route is not offered at Project
  scope. Remote routes with no key prefer OAuth. Keys in 0.1.x's files (alfred-code's store, `.preferred-tools/.secrets`)
  are not read any more: the plan names where one still sits and where to move it.
- A data folder written relative (project scope, for a tool measured to follow the folder it starts in) lands in each
  folder Claude starts in; `/preferred-tools:fix` (`data-folder-ignore`) keeps it out of git in a child or a subfolder.
- A new package is downloaded right after its registration is written, and the server is started once, in the
  background, so the first session start answers inside Claude Code's 30-second limit (memory's first start downloads
  an embedding model for about 2 minutes). Restart Claude Code once that reports. If it fails, nothing is undone and
  the first session start does it instead. A session started during that download can break an npx server's cache for
  good (every start then fails with `ENOENT`); `/preferred-tools:fix` (`npx-cache-entry`) repairs it.

Requires Node 22 for the scripts (built-ins only, no dependencies) and the `claude` CLI on PATH. The design record is
`docs/build-prompt.md`; this repo's own rules are in `.claude/CLAUDE.md` (not loaded by installs).

## Development

```bash
npm test          # node:test, one file per script
npm run lint      # catalog and manifest shape checks
npm run validate  # claude plugin validate --profile directory --strict, on a copy of the files git would ship
npm run matrix    # real-CLI cases in a throwaway home and account (minutes; plugin cases need the network)
npm run refresh-pins          # print which catalog pins have a newer release at least 7 days old
npm run refresh-pins -- --write   # move catalog/tools.json; a moved pin is a release (see the output)
```

## Credits

The plugin icon (`.claude-plugin/icon.png`) is Google's Material Symbols 'home_repair_service' glyph (rounded, filled)
on a teal ground, used under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0) from
[google/material-design-icons](https://github.com/google/material-design-icons).

## License

MIT - see [LICENSE](LICENSE).
