---
name: solve-task
description: "Use when solving a task in this repo end to end - '/solve-task', 'solve this', 'spec, plan and build it'. This repo's own flow, not the stack's task-solve."
---

# Solve task - this repo's own flow

One change to preferred-tools, from the request to a local commit, through the superpowers skills and this repo's
invariants (`.claude/CLAUDE.md`). Each step that names a skill loads it with the Skill tool.

## When to use

- A change to this repo that is more than one sentence: a feature, a fix, a hook, a skill, an installer step.
- Not for a release, which follows the Release section of `plugin-handling.md`, on the user's word.

## Size first

State one line before anything else: `Size: <trivial|spike|bounded|architectural> - <the signal>`.

- trivial - no behaviour a test would see: a typo, a comment, formatting, a rename inside one file. It just gets
  made (`.claude/rules/execution.md`), its covering check runs, done. Anything that adds or changes behaviour - a new
  flag, option, output or branch - is at least bounded, however short the request.
- spike, bounded, architectural - load superpowers:brainstorming next and take its path for this size: a spike has its question
  and probe approved first, then ends in an answer and keeps nothing; a bounded change gets an in-chat design whose approval is a stop, then the build; an
  architectural change takes every step below. Under `auto-run` a bounded design's approval follows the same rule
  and waiver as a graded spec's (step 3).
- A design already settled by a run order or the user's rulings skips the spec and goes to the plan.

## The steps

1. Spec - superpowers:brainstorming writes `docs/superpowers/specs/<date>-<topic>-design.md`.
2. Grade - `refining-plans` to 90, its own loop.
3. Approval - the user approves the graded spec. Under `auto-run` it stays a stop; only the waiver `auto-run`
   defines skips it, and then the score path is reported in place of the ask.
4. Plan - superpowers:writing-plans writes `docs/superpowers/plans/<date>-<topic>.md`; grade it to 90; approval as in
   step 3.
5. Build - superpowers:executing-plans by default (one context, cheapest), superpowers:subagent-driven-development
   when the user asks for a gate per task, or when all of `execution.md`'s Mode conditions hold; with
   superpowers:test-driven-development throughout. The ledger is `docs/superpowers/sdd/<plan basename>/progress.md`.
6. Checks, in the tiers of `execution.md`:
   - per batch: `npm run lint` and the tests that cover the change;
   - `npm run matrix` (real-CLI cases in a throwaway home and account) after a change to install, configure, update
     or fix, reading the written `.mcp.json`, account file and settings, never the exit code alone;
   - the full `npm test` once, in the background, its output to a log, its tail read, then `npm run validate`.

   House voice holds in every file written (single dashes, single quotes in prose). A case not run is reported NOT RUN.
7. Review - one fresh Opus review of the whole branch, one fix pass (each fix RED then GREEN), minors deferred to
   the ledger.
8. Commit - one commit per plan task as its commit step says, else one commit for the change; by pathspec, its
   message with no trace of the agent (`.claude/CLAUDE.md`). No version bump, push or merge without the user's word.

## The close

`execution.md`'s close - the mode and why, what changed, each tier's command with its result, what was not verified
and why - then 'Rulings I made' and 'Deferred minors' from the ledger, and `auto-run`'s close when it is on.

## Not here

- A change in a sibling repo (alfred-code hosts the `envoydev` marketplace), which follows that repo's own flow.
- Alfred Code's `task-solve` and its seats, stamps and stops, which serve the projects that install the stack.
