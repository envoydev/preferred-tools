# preferred-tools

The tools I have tested and like to use - MCP servers and Claude Code plugins - packaged as one Claude Code plugin. The
plugin carries each tool's install, update, rename, relocation and fix procedure, so a new machine or a new project is
a short walk instead of a hunt through old notes.

It installs nothing by itself. You drive it through two manual commands and one skill:

- `/preferred-tools:install` - pick tools, then per tool the route (remote or local, where the tool has both), the
  scope, the registration name and the data location. It shows one plan, applies it after one confirmation, reads the
  result back, and can change or remove what an earlier run installed.
- `/preferred-tools:fix` - finds known problems in the installed tools and applies the recorded fix.
- the `update-tools` skill - brings installed plugins and registered catalog servers up to date when they are behind.

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

Requires Node 22 for the scripts (built-ins only, no dependencies) and the `claude` CLI on PATH. The design record is
`docs/build-prompt.md`; this repo's own rules are in `CLAUDE.md` (not loaded by installs).

## Development

```bash
npm test          # node:test, one file per script
npm run lint      # catalog and manifest shape checks
npm run validate  # claude plugin validate, allowing only the known CLAUDE.md warning
```
