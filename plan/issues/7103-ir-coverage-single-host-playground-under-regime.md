---
id: 7103
title: "IR coverage gap: 12 playground units fall back to the legacy body under the native regime in a JS environment (the `check:ir-only` single-host lane was measured under `host-assisted`)"
status: ready
created: 2026-10-20
updated: 2026-10-20
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: feature
area: ir, compiler
language_feature: compiler-internals
goal: backend-agnostic-ir
sprint: current
parent: 5385
related: [6979, 7091, 3519, 3214]
---

# #7103 — the single-host IR-only lane under the regime

Found by the S7-a landing (2026-10-20). `scripts/check-ir-only.ts` compiles
its `single-host` lane (the 5 JS-environment playground entries) with
`semanticProviders: "host-assisted"`, and the committed floor in
`scripts/ir-only-baseline.json` (38 emitted / 0 legacy / 0 unsupported) was
measured under that profile. S7-a (#6979, PR 6701) deletes the profile, so
the lane measures the regime, where 12 of the 38 units are declined by the
IR selector and compile through the legacy body:

| Entry | Unit | Rejection |
| --- | --- | --- |
| `dom/calendar.ts` | `el`, `onDay` | `select/call-graph-closure` |
| `dom/calendar.ts` | `main`, `renderCal`, `updFoot` | `select/body-shape-rejected` |
| `dom/calendar.ts` | module init | `select/date-constructor-unsupported` (`new Date` at module scope) |
| `js/async.ts` | `fetchAllParallel`, `fetchAllSequential`, `fetchUser` | `select/call-graph-closure` (async closures) |
| `js/async.ts` | `main` | `select/host-surface-unavailable` |
| `js/algorithms.ts`, `js/classes.ts` | `main` | `select/host-surface-unavailable` (`new <ExternClass>` / host globals the #7091 predicate does not admit) |

Verified on main's own tree with only the `host-assisted` line removed from
the script: identical 26 < 38 and the same 12 units, so this is a
measurement-basis change, not an S7-a code regression. It is the same shape
as #7091 (the IR-fallback gate's `#3214 A+B1` invariant), one level up:
#7091 admitted DOM calls with string/closure arguments; these units need
`new <ExternClass>` and host-global reads in `main`, async closures through
the call-graph, `new Date` in module init, and the calendar body shapes.

## Plan

1. Measure: `trackIrOutcomes` per unit for the five entries on the default
   profile; for each of the four rejection codes, the exact selector site and
   the smallest program that reproduces it.
2. Lower, in the IR producer/lowerers (allowed under the direct-AST freeze):
   `new <ExternClass>` and host-global reads under the #7091 platform-extern
   predicate; async closures in the call-graph admission (the #7094/#7096
   async-CPS planner is the legacy twin — the IR path must either claim the
   whole async component or decline it cleanly); `new Date` in module init
   via the native Date provider; the two calendar body shapes. Byte identity
   for every program that does not touch these constructs.
3. Gate: `pnpm run check:ir-only -- --policy=hybrid` READY with the single-host
   lane back at 38 emitted / 0 legacy under the regime; `check:ir-fallbacks`
   green; equivalence "No new equivalence regressions".
4. Until this lands, S7-a cannot keep the 38/0 floor: the stakeholder decides
   whether the lane is re-banked at 26/12 under the regime (reviewed
   `--update` with a dated note naming this issue, then ratcheted back up
   here) or whether this issue lands first.
