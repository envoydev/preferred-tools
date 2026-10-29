# preferred-tools

The tools I have tested and like to use - MCP servers and Claude Code plugins - packaged as one Claude Code plugin. The
plugin carries each tool's install, update, rename, relocation and fix procedure, so a new machine or a new project is
a short walk instead of a hunt through old notes.

It installs nothing by itself. You drive it through four manual commands:

- `/preferred-tools:install` - adds tools that are not installed in this project: pick them, then per tool the route
  (hosted or local, where the tool has both), the scope, the registration name and the data location. A tool you
  installed for every project can get this project's own copy; the account-wide one stays as it is. It shows one plan,
  applies it after one confirmation and reads the result back.
- `/preferred-tools:configure` - changes or removes what is installed: pick a registration or plugin, then change its
  route, scope, name or data location, or a plugin's scope, or claude-hud's settings. Every question recommends what
  the tool has now, and a change keeps its pin and the args you added.
- `/preferred-tools:fix` - finds known problems in the installed tools and applies the recorded fix.
- `/preferred-tools:update` - brings installed plugins, pinned servers and language servers up to date when they are
  behind, offering only releases at least 7 days old.

## Install

```bash
claude plugin marketplace add envoydev/alfred-code
claude plugin install preferred-tools@envoydev
```

The plugin is listed in the `envoydev` marketplace (the alfred-code repo, `.claude-plugin/marketplace.json`). Run the
commands from the project you want the tools in, not from this repo. Updates are pulled: run
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
- No token is written to any file. Remote routes prefer OAuth; token routes register `${VAR}` references.
- A new package is downloaded right after its registration is written, and the server is started once, in the
  background, so the first session start answers inside Claude Code's 30-second limit (memory's first start downloads
  an embedding model for about 2 minutes). Restart Claude Code once that reports. If it fails, nothing is undone and
  the first session start does it instead.

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
