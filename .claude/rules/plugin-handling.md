---
paths:
  - ".claude-plugin/**"
  - "commands/**"
  - "scripts/**"
  - "catalog/**"
  - "package.json"
---

# Plugin handling

Adding, changing, renaming or removing anything the plugin ships. `.claude/CLAUDE.md` holds the why; this is the order of work.

## One home per item

- A command is `commands/<name>.md`, manual (`disable-model-invocation: true`); its work is a script in `scripts/`, called as `node "${CLAUDE_PLUGIN_ROOT}/scripts/<file>"`. `allowed-tools` lists read-only calls only.
- A tool is one row in `catalog/tools.json`, a known problem one row in `catalog/fixes.json` with its code under `scripts/fixes/`. Every outside fact a row rests on goes into `docs/sources.md` with its URL and date.
- The repo root is the plugin root, and Claude Code scans its default folders whatever the manifest says: never add `skills/`, `agents/`, `hooks/`, `bin/`, `.mcp.json` or another default component path unless the plugin ships it.

## One version

- The version lives in `.claude-plugin/plugin.json` and is mirrored in `package.json`; `npm run lint` fails on drift. Bump both on every user-visible change: a change without a bump is not delivered.
- Never rename or drop the id `preferred-tools`: every install goes silent.
- The `envoydev` marketplace in alfred-code lists the plugin with a GitHub source on `main`, so a merge to `main` with a new version is the release. A change to that entry follows alfred-code's own CLAUDE.md.

## Release

- `main` is the default branch and work lands on a branch. Commit, push or merge only on the user's word, after the proof below, and report what was not run.

## Proof

- Per batch: the tests that cover the change and `npm run lint`. Once after the change: the full `npm test`, then `npm run validate`; `npm run matrix` (minutes, isolated home and account) after any change to install, configure, update or fix.
- Read the written `.mcp.json`, account file and settings, not the exit code. A case not run is NOT RUN.
- The repo is public: no private project names or absolute local paths in a tracked file (`npm run lint` checks the paths).
