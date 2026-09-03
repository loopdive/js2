---
id: 5281
title: "cheap gate: refuse committed conflict markers in any tracked file"
status: ready
created: 2026-09-02
updated: 2026-09-02
sprint: current
priority: high
horizon: s
feasibility: easy
task_type: infrastructure
area: tooling
goal: ci-infrastructure
requested_by: claude/fable-ir-takeover
related: [3526, 5487, 5504, 3597]
---

## Problem

`b16a68d06f` on `claude/issue-3526-f3s1-host-callback-maker` (PR #5487)
committed literal conflict markers into
`plan/issues/3526-ir-r6-semantic-runtime-contract.md`:

```
9551:<<<<<<< HEAD
9583:=======
9608:>>>>>>> origin/claude/issue-3526-f3s1-host-callback-maker
```

The commit was a merge reconciling two concurrent appends to the same file
tail. **Its own message states the resolution it never performed** — "Both
kept: the lane's re-measurement first, then the review findings" — so the
record reads as if the conflict was resolved.

It passed every gate this repo runs, reached the merge queue, and was found
only because the F3-S2 lane happened to read that file to append its own
checkpoint. By then the branch was queued and could no longer be pushed to
(`GH006: Branches that are queued for merging cannot be updated`), so the fix
had to go forward through a separate docs PR.

**Nothing in CI reads issue-file prose**, so a marker in `plan/`, `docs/` or
any other non-compiled file is invisible to `quality`, `equivalence-gate`,
the test262 jobs and the ratchets alike. A marker inside `src/` would break
`typecheck`, but only by accident — no check states the rule.

## Implementation Plan

1. Add a check to the **cheap gate** (`cheap gate (main-ancestor + lint)` in
   `.github/workflows/`; it is already required, already fast, and already
   runs on every PR) that fails when any tracked file added or modified by the
   PR contains a line matching `^(<{7}|={7}|>{7})(\s|$)`.
   - Scan the PR's changed files only, not the whole tree — a full-tree scan
     would flag fixtures and this repo's own documentation of the markers
     (this issue file included, if written literally; write the check so its
     own tests are not self-defeating — put the fixture strings in a test
     resource the scan excludes by path, or build them at runtime).
   - `=======` alone is a legitimate markdown setext heading underline, so
     require it only in combination: a `=======` line flags only when a
     `<<<<<<<` line appears earlier in the same file.
2. Pin it: a fixture file containing markers fails the check; a markdown file
   with a genuine `=======` setext underline and no `<<<<<<<` passes.
3. Mention it in `docs/ci-policy.md` §7 alongside the other cheap-gate checks.

## Acceptance criteria

1. A PR that adds a conflict marker to any tracked file fails the cheap gate
   with a message naming the file and line.
2. A markdown file using `=======` as a setext underline does not trip it.
3. The check adds no measurable time to the cheap gate (it is a grep over the
   changed-file list).
