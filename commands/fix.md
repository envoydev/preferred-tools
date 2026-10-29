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
node "${CLAUDE_PLUGIN_ROOT}/scripts/fix.js" --detect
```

Paste its output verbatim in a fenced block. It lists each problem found - the fix id, the tool by its registration
name and scope, what was found - and any note. A line ending 'NOT APPLICABLE' has a reason and is never applied. A row
named 'Held' is an open decision, not a problem; mention it in one line and leave it.

If it says 'No known problem found.', say so in one line and stop.

## 2. Ask

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/fix.js" --questions` (with the same `--only`). It prints the asks as data:
`choose` and, for 'Pick which', `pick` - a list of calls, each at most four questions of at most four options.

Ask `choose` as one AskUserQuestion, exactly as printed:

- 'Apply all found (Recommended)' - every fix that can be applied. Go to step 3 with `all`.
- 'Pick which' - ask each call of `pick` as printed, one AskUserQuestion per call, and collect the labels picked
  (a label is a fix id). Go to step 3 with those ids. Nothing picked means 'Skip'.
- 'Skip' - say nothing was changed and stop.

A finding that needs a folder from the user (the detect output says 'needs a folder from you') gets one more
AskUserQuestion before it is applied: the suggested folder as '(Recommended)' listed first, and 'Skip this fix'. The
user types their own through 'Other'. Pass the answer as `--input serenaHome=<folder>`. Never guess a folder.

## 3. Apply

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/fix.js" --apply <id,id | all> [--only "$ARGUMENTS"] [--input key=value]
```

Claude Code asks permission for this call itself - `--apply` is deliberately not in `allowed-tools`. It rewrites each registration through the `claude` CLI (remove, then add with the same name and scope) from the entry as
it is now, so the user's pin, cut-off and added args stay. Several fixes on one registration are one rewrite. A machine
fix (a global npm install) runs after. Each fix is read back by running its detector again.

Run it with the Bash tool's `timeout: 600000` (10 minutes, the most it allows by default); a global npm install is the slow part.
Paste the output verbatim. Report each fix as 'fixed' or 'STILL FOUND', each skipped one with its reason, and a failure
with the line it printed - a failed rewrite prints a `RESTORE BY HAND` line, give it to the user as written.
A key in it shows as `${PREFERRED_TOOLS_KEPT}`, never its value: the user puts their key back there.

A fix that changes what a server launches (a python request, a cut-off) prints `Fetch next, in the background (...):
<file>`. Run, with the Bash tool's `run_in_background`, `node "${CLAUDE_PLUGIN_ROOT}/scripts/fetch.js" "<file>"`: it
downloads the new launch into the runtime's cache and starts the server once with no 30-second limit, one at a time, so
the next session's start answers inside Claude Code's 30 seconds, then prints each repaired server's status (`claude mcp
get`). Claude Code asks permission for it. Tell the user
to restart only once it reports, and paste its output when it finishes; a `warn` line changes nothing. When background
runs are turned off, run it in the foreground with `timeout: 600000`, and again if the limit stops it.

End with the restart line the script prints: the repaired registrations load on the next session start.

## Rules

- Nothing is applied before step 2's answer. A fix that was not picked is never run.
- A registration that matches no catalog row is the user's and is never touched.
- A secret is never written. This command writes no token and no key.
- Do not repeat a fix 'STILL FOUND' in a loop. Show it and stop; the finding's note says what is left to do.
