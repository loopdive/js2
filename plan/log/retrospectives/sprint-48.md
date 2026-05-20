---
sprint: 48
written: 2026-05-20
written_by: project-review
retroactive: true
---

# Sprint 48 Retrospective

**Sprint**: 48
**Dates**: 2026-05-03 (single-day sprint, drained into S49)
**Theme**: lodash Tier 2 + Hono Tier 4 + IR Phase 4 Slice 13
**Baseline at start**: inherited from S47 close

> Written retroactively from the sprint.md content and the merged-PR
> table embedded in that file. The `retro_written: true` flag in sprint
> 48's frontmatter was set without a `## Retrospective` section actually
> existing — this file fixes that gap.

---

## What landed (13 merged)

| Issue | Title |
|-------|-------|
| #1200 | LICM pass — hoist `arr.length` out of loop conditions |
| #1233 | IR Phase 4 Slice 13d — Array per-element-type methods |
| #1236 | i32-specialisation overflow saturation fix on accumulators |
| #1269 | struct-field inference Phase 3 (consumer-side) |
| #1270 | struct-field Phase 3b (peephole null-check elimination) |
| #1280 | IR selector — claim while/for loops with typed state |
| #1282 | ESLint Tier 1 stress test |
| #1291 | lodash Tier 1b — execution-level assertions |
| #1292 | lodash Tier 2 — memoize / flow / partial |
| #1293 | Hono Tier 4 — `string[][]` array-of-arrays |
| #1294 | test262 worker — `WebAssembly.Exception` classification |
| #1295 | compiler — re-throw `WebAssembly.Exception` from internal catch |

## What carried over to S49

- #1199 (linear-memory backing for typed numeric arrays)
- #1223 (closure-bridge follow-up)
- #1241 (related triage)
- Stage 3 of #1126 (max-effort int32 inference)

## What worked

- **Single-day intensive worked** — 13 issues drained in one push.
  Demonstrated the batch dispatch + dev self-merge pattern at compressed
  scale.
- Hono and lodash tier tracking gave concrete real-world signal that
  test262-only metrics miss.

## What didn't

- **Retro flag set without retro content** — frontmatter said
  `retro_written: true`; the file had only dispatch notes. Discovered
  during project review and the gap is now codified in #1523 as a CI
  check.
- The carry-overs (#1199, #1223, #1241) were not bundled into a clearly
  scoped follow-up — they leaked into S49 planning rather than landing
  there with a deliberate plan.

## Process notes

- Single-day sprints are fine when the issue queue is well-scoped and
  parallelisable. They break down when carry-overs are not
  pre-categorised.
- The `retro_written` frontmatter flag is only meaningful if checked
  against actual content. #1523 will add that check.

## Pointers

- Sprint file: `plan/issues/sprints/48/sprint.md`
- Issue files: `plan/issues/sprints/48/*.md`
