# Plugin CLI evidence - what Claude Code does with a renamed, dropped or re-installed plugin

Copied on 2026-10-27 from alfred-code's `docs/plugin-cli-evidence.md`, the spikes this repo's installer relies on.
Measured against Claude Code 2.1.281 (S11-S25), 2.1.282 (S28) and 2.1.300 (S29), macOS, with an isolated `HOME` /
`CLAUDE_CONFIG_DIR` per case, a local git marketplace served over smart HTTP, and sessions against a Messages API
stub, so no model was billed. `old-core` / `old-hooks` stand for two v1 plugin ids and `new-core` for the v2 id. The
full spike log is in alfred-code's git history (`docs/rebrand-evidence.md`, deleted 2026-10-07). Re-measure a row
before relying on it on a much newer Claude Code.

| Spike | What was run | Finding |
|---|---|---|
| S11 | v1 marketplace with `old-core` and `old-hooks` installed, then v2 pushed with a top-level `renames` map folding both into `new-core`; `marketplace update`, then sessions. | **A rename leaves a session with no hooks, and it does not self-heal.** `enabledPlugins` points at an id that `installed_plugins.json` / `plugin update` never installs. Every session in between runs with zero hooks from either generation until an explicit `claude plugin install <new-id>@<key> -s <scope> -y` repairs it. `plugin list --json` read `enabled: false` for the broken row. |
| S13 | The S11 sequence with the second id dropped (no rename entry at all). | **Dropping an id fails the same way.** The dropped id stays enabled in `settings.json` with nowhere to load from and never fires. A row the catalog no longer lists shows its failure only in `plugin list --json`'s `errors` field. |
| S16 | v1 = one root-sourced plugin (an inline `SessionStart` hook plus one skill), v2 = the same plugin renamed 1:1, at project and at user scope; three sessions each. | **A plain 1:1 rename breaks too.** No hook and no skill content reaches any session at either scope, even at user scope where `enabledPlugins`, `installed_plugins.json` and `plugin list --json` all look correct. |
| S22 | `claude plugin install new-core@<key> --scope project -y`, then `uninstall` of both old ids, then three sessions. | Each session fires exactly one `SessionStart` hook and lists one skill. **`plugin list --json` shows the row `"enabled": false` while the plugin visibly runs every session** - the listing's flag is no evidence of whether a plugin runs. |
| S25 | A catalog under the same key that lists only `new-core`, pushed to a project still enabled on an old id; `marketplace update`, then sessions. | **An id the catalog drops stops loading at once, silently**, with no warning beyond an unread `plugin list --json` error field. |
| S28 | A plugin installed first, then `claude plugin install` over it from a project: (a) user scope, disabled; (b) user scope, enabled; (c) project scope, disabled; (d) project scope, enabled. Then `enable` on an enabled one, `disable` on a disabled one, `update` on a disabled one, `uninstall` on a disabled one and on one not installed. | **`install` is not a no-op over an installed plugin.** (a), (b): a second, enabled project-scope install beside the user row. (c): project `enabledPlugins` flips from `false` to `true`. (d): `already installed`, exit 0, nothing changed. Every case prints `Successfully installed`, so the output cannot tell a new install from an existing one. `enable` over enabled and `disable` over disabled exit 1 (`is already enabled/disabled at project scope`). `update` over a disabled plugin exits 0 with the flag left `false`. `uninstall` of a disabled plugin exits 0 and drops its row and its `enabledPlugins` key; `uninstall` of one not installed exits 1. A project `uninstall` leaves the user-scope row alone. |
| S29 | A directory marketplace with one plugin, `source: "./pp"`, whose `SessionStart` hook touches a marker; a project's `settings.json` enables it. (a) the marketplace declared only in that file's `extraKnownMarketplaces`; (b) `claude plugin marketplace add` on the account, no install; (c) installed at project scope in project A, enabled in project B; (d) B with the setting removed. | **A relative-path plugin loads from a REGISTERED marketplace with no install record.** (a) no marker; (b) the marker, with `plugin list --json` reading `[]`; (c) the marker in B; (d) no marker. A marketplace declared in project settings alone serves nothing to a non-interactive start. |

## What this means for preferred-tools

- **Never rename the plugin id `preferred-tools`, and never drop it from the `envoydev` marketplace** (S11, S13, S16,
  S25): every install would go silent.
- **Never run `install` over a plugin the inventory already shows** (S28). Run `update` at that plugin's own scope.
  Skip an `enable` / `disable` the settings file shows already made, because the no-op exits 1.
- **Read a plugin's enabled state from the settings file at its scope**, not from `plugin list --json`'s `enabled`
  flag (S22). Report its `errors` field: that is the only place a plugin that cannot load says so (S13, S25).
- **Never trust `Successfully installed`** as proof of a change (S28). Read the plugin list and the settings file
  back after the call.
