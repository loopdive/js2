---
id: 1523
sprint: 53
title: "Phase out sprint-current.md; sprint docs generated programmatically; ID/folder consistency gate"
status: ready
created: 2026-05-20
priority: high
feasibility: medium
reasoning_effort: medium
task_type: tooling
area: planning, build
goal: maintainability
related: [1522]
---

# #1523 — Phase out sprint-current.md; sprint docs generated; ID/folder consistency gate

## Problem

Three concrete drift symptoms today:

1. **`plan/log/sprint-current.md` is two months stale.** It still references
   sprint 30, dated 2026-03-26, while sprint 53 is in planning. Anyone
   reading it for "what's happening now" plans against ancient state.

2. **Duplicate issue IDs exist on disk.** Concrete examples found
   2026-05-20:
   - `plan/issues/sprints/52/1521-test262-ci-speedup-...md`
   - `plan/issues/sprints/52/1521-wasi-native-messaging-host-example.md`
   - `plan/issues/sprints/50/1335-number-formatting-pure-wasm-standalone.md`
   - `plan/issues/sprints/50/1335-spec-gap-object-defineproperty-...md`
   - `plan/issues/sprints/50/1335-spec-gap-object-assign-getter-iteration.md`

   Two files with the same `id:` in frontmatter break every downstream
   tool that keys by issue ID (dashboards, dependency graph, retros).

3. **Folder ↔ frontmatter mismatch is not enforced.** An issue file in
   `plan/issues/sprints/53/` can have `sprint: 52` in its frontmatter and
   no tool catches it. The dashboard reads frontmatter; the merge gate
   reads folder; they can disagree silently.

## Acceptance criteria

### A. Delete `sprint-current.md`

- Remove `plan/log/sprint-current.md` entirely. Any consumers must read
  the current sprint from `plan/issues/sprints/<N>/sprint.md` where
  `<N>` is the highest sprint directory with `status: planning|active`.
- If a dashboard or skill references `sprint-current.md`, update those
  references to read the latest sprint dir instead.

### B. Sprint docs only populated programmatically

- The hand-written sprint goal / theme / risks section stays human-owned.
- The **issue tables** in `sprint.md` (between
  `<!-- GENERATED_ISSUE_TABLES_START -->` and `..._END`) must be
  regenerated only by `scripts/sync-sprint-issue-tables.mjs` (already
  exists, extend if needed).
- Sprint frontmatter (`baseline_pass`, `baseline_total`, `baseline_pct`)
  is rewritten by the script — no hand-edits.
- After a sprint closes, no further hand-edits to its `sprint.md` are
  expected; the closure flow (status, retro link, end tag) is scripted.

### C. Consistency gate

A new script `scripts/check-sprint-issue-consistency.mjs` runs in CI and
fails the build if any of the following are true:

1. **Duplicate `id:`** across all `plan/issues/**/*.md` (excluding
   `sprint.md` and `backlog.md`).
2. **`sprint:` frontmatter mismatch with folder**: an issue file under
   `plan/issues/sprints/52/` whose frontmatter says `sprint: 51` (or any
   other value) fails.
3. **`status: done` in a non-closed sprint folder** that is missing from
   the dependency graph done list (warning only, not failure).
4. **Issue file missing `id:` or `sprint:` field** in frontmatter.

The script is wired into `.github/workflows/ci.yml` and runs locally via
`pnpm run check:sprint-consistency`.

### D. Migration of existing duplicates

- Rename the duplicates listed above so each carries a unique ID. Choose
  the next free IDs (>= 1531) and update any references in dependency
  graph / dashboards.
- One-off; not part of the recurring script.

## Implementation notes

- The script can use simple `gray-matter`-style YAML frontmatter parsing
  (already used elsewhere in `scripts/`). No need for new deps.
- Run order: consistency check → table sync → conformance sync (#1522).
- CI failure mode: hard-fail with a clear message listing every offending
  file path so a fix is one `git mv` away.
