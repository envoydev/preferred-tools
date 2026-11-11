---
description: "Detect known problems in the installed tools and apply the recorded fix for each"
argument-hint: "[tool, registration name or fix id]"
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/fix.js" --detect), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/fix.js" --detect *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/fix.js" --questions), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/fix.js" --questions *)
---

Find the known problems in what is installed and apply the recorded fix for each one the user picks. Every fix row is
in `catalog/fixes.json`; the detectors are in `scripts/fixes/`. A row whose detector finds nothing is not shown. The
argument, when given, narrows everything below to one fix id, tool or registration name: `$ARGUMENTS`.

## 1. Detect

Run, adding `--only "$ARGUMENTS"` when there is an argument:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/fix.js" --detect --data "${CLAUDE_PLUGIN_DATA}"
```

Paste its output verbatim in a fenced block. It lists each problem found - the fix id, the tool by its registration
name and scope, what was found - and any note. A line ending 'NOT APPLICABLE' has a reason and is never applied. A
server left on its own at install is listed as 'on its own - not checked'; `/preferred-tools:configure` hands it back.
A `note:` line (a Project-scope key helper waiting for the trust prompt, say) is advice, not a fix: relay it. A row
named 'Held' is an open decision, not a problem; mention it in one line and leave it.

Three rows look after what 0.2.0 wrote at Project scope:

- `project-relative-path` - a data folder or the key helper named relative, or through `${HOME}` / `${USERPROFILE}`, in
  this folder's `.mcp.json`. The fix writes those paths absolute, from the entry as read; it moves no data, and names
  any old folder left behind (serena's on Windows, with its one-time download of about 327MB).
- `mcp-order` - the catalog servers in `.mcp.json` out of the user's order. The fix puts them in order, the user's own
  servers after them, and changes no value.
- `helper-child-folder` - advice only: a hosted server inherited from a parent folder's `.mcp.json` connects here
  without its key, since Claude Code does not run a parent folder's key helper in a child folder.

A finding about a parent folder's `.mcp.json` ends 'NOT APPLICABLE: run /preferred-tools:fix in <folder>': that file
is the parent's, and fix run there repairs it. `data-folder-ignore` also finds a 0.2.0 copy a session made in this
folder (`.alfred/playwright-chrome`, say) that no server uses any more: its fix writes the copy's `.gitignore`, and its
data is left, never moved or deleted.

If it says 'No known problem found.', say so in one line and stop.

## 2. Ask

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/fix.js" --questions --data "${CLAUDE_PLUGIN_DATA}"` (with the same `--only`). It prints the asks as data:
`choose` and, for 'Pick which', `pick` - a list of calls, each at most four questions of at most four options.

When `choose` is null, nothing found can be applied: every line is NOT APPLICABLE, and its reason is the advice. Say
that nothing was changed and stop - there is nothing to ask.

Ask `choose` as one AskUserQuestion, exactly as printed:

- 'Apply all found (Recommended)' - every fix that can be applied. Go to step 3 with `all`.
- 'Pick which' - ask each call of `pick` as printed, one AskUserQuestion per call, and collect the labels picked
  (a label is a fix id). Go to step 3 with those ids. Nothing picked means 'Skip'.
- 'Skip' - say nothing was changed and stop.

A finding that needs a folder from the user (the detect output says 'needs a folder from you') gets one more
AskUserQuestion before it is applied: the suggested folder as '(Recommended)' listed first, and 'Skip this fix'. A
folder the user typed as the Other answer is taken the same way. Pass the answer as `--input serenaHome=<folder>`. Never
guess a folder.

## 3. Apply

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/fix.js" --apply <id,id | all> --data "${CLAUDE_PLUGIN_DATA}" [--only "$ARGUMENTS"] [--input key=value]
```

Claude Code asks permission for this call itself - `--apply` is deliberately not in `allowed-tools`. It rewrites each registration through the `claude` CLI (remove, then add with the same name and scope) from the entry as
it is now, so the user's pin, cut-off and added args stay. Several fixes on one registration are one rewrite. A key moved out of
a registration (`key-to-helper`) first writes the root's files - its `.gitignore`, `mcp-headers.js` - then rewrites the
registration to read its key through the helper. After a rewrite of a hosted server that takes a key, the script prints
how it connects - with its key at the next session start, or 'fill <NAME> in <file>' first - relay it. A machine fix (a global npm install, a data folder's or a root's
`.gitignore`, the key helper written or brought current, or a broken npx cache folder removed - also for a server a
parent folder's `.mcp.json` gives this folder, since that cache is the machine's) runs after. Each fix is read back by running its detector again.

Run it with the Bash tool's `timeout: 600000` (10 minutes, the most it allows by default); a global npm install is the slow part.
Paste the output verbatim. Report each fix as 'fixed' or 'STILL FOUND', each skipped one with its reason, and a failure
with the line it printed - a failed rewrite prints a `RESTORE BY HAND` line, give it to the user as written.
A key in it shows as `${PREFERRED_TOOLS_KEPT}`, never its value: the user puts their key back there.

A fix that changes what a server launches (a python request, a cut-off), or removes a broken npx cache folder
(`npx-cache-entry`), prints `Fetch next, in the background (...):
<file>`. Run, with the Bash tool's `run_in_background`, `node "${CLAUDE_PLUGIN_ROOT}/scripts/fetch.js" "<file>"`: it
downloads the new launch into the runtime's cache and starts the server once with no 30-second limit, one at a time, so
the next session's start answers inside Claude Code's 30 seconds, then prints each repaired server's status (`claude mcp
get`). Claude Code asks permission for it. Tell the user
to restart only once it reports, and paste its output when it finishes; a `warn` line changes nothing. When background
runs are turned off, run it in the foreground with `timeout: 600000`, and again if the limit stops it.

End with the restart line when the script prints one: the repaired registrations load on the next session start. A run
whose only fixes wrote a `.gitignore` or a hosted server's key helper prints none, since that helper runs at each
connect; one that wrote a bridge (`mcp-bridge.js`) or the helper beside it prints it, since that server did not start.

## Rules

- Nothing is applied before step 2's answer. A fix that was not picked is never run.
- A registration that matches no catalog row is the user's and is never touched.
- Keys live in `.mcps-secrets` in the root folder, filled by the user. A key is written into a registration only by
  `token-sync`, for a local route; `key-to-helper` moves a hosted key out of a registration once its name is filled
  there. This command never asks for, prints or edits a key or a value; a finding names the key and the file.
- Do not repeat a fix 'STILL FOUND' in a loop. Show it and stop; the finding's note says what is left to do.
