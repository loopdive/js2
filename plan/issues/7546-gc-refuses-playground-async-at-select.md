---
id: 7546
title: "The JS target refuses the playground `js/async.ts` owners at select, while standalone claims them"
status: ready
sprint: Backlog
created: 2026-11-26
updated: 2026-11-26
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
goal: backend-agnostic-ir
related: [7533, 6708]
---

# #7546 — gc refuses the playground `js/async.ts` owners that standalone claims

## Problem

Found while planning [#7533](7533-ir-async-native-runtime-rejected-on-js-target.md). Since the JS environment runs the
same native core as standalone (#6708), the IR selector should claim the same async owners on both. It does not for
`website/playground/examples/js/async.ts`.

## Reproduction (2026-11-26, `origin/main` `a9cdc8857a`)

`compile(src, { fileName: "async.ts", target, trackIrOutcomes: true })`, reading `irOutcomes`:

| Owner | gc (default target) | standalone |
| --- | --- | --- |
| `fetchUser` | refused, `call-graph-closure` | IR-emitted |
| `fetchAllSequential` | refused, `call-graph-closure` | IR-emitted |
| `fetchAllParallel` | refused, `call-graph-closure` | IR-emitted |
| `main` | refused, `host-surface-unavailable` | IR-emitted |

`irFirstSkipped` is `["setTimeout", "delay"]` on gc and all six owners on standalone. Both compiles succeed; gc
compiles these owners through legacy. The `call-graph-closure` refusals follow from `main`'s `host-surface-unavailable`.

## Acceptance criteria

- gc claims the same owners as standalone for this file, or each remaining gc refusal names a JS-environment
  capability that standalone genuinely lacks.
- Measure after #7533 lands; that PR does not change these outcomes (no playground file reaches its guard).
