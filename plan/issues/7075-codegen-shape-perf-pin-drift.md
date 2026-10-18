---
id: 7075
title: "issue-tests: WAT-shape / fast-path pins red since the blind window — lost unboxing, lost i32 paths, Proxy module slots widened (4122, 4150, 3683, 1120, 1179, identity-search, 2615, 4707, 4754)"
status: ready
sprint: Backlog
created: 2026-10-18
updated: 2026-10-18
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: performance
area: codegen
language_feature: n/a
goal: ci-hardening
related: [7014, 7072, 4122, 4150, 3683, 1120, 1179, 2615, 4707, 4754]
requested_by: ttraenkler/wave15-grep-other-sentinels
---

# #7075 — fast-path / representation pins that went red (values still right)

Found by the #7014 follow-up (wave 15). Every row below still computes the
right JS value — the failing assertion is on the emitted WAT — so each is a
lost optimisation or a deliberate representation change, and needs a measured
before/after (bench or WAT) to tell which. Standalone rows first (the host lane
is being sunset, but the host rows also share codegen).

Measured red on upstream/main e8699e30ee, one file at a time:

| file | lane | red | what changed |
|---|---|---|---|
| issue-4122-mixed-carrier-numeric | standalone | 2 | accumulator `s` stays f64 but the loop still `call $__unbox_number`s the `p.inc()` result; the `JS2WASM_MIXED_CARRIER_NUMERIC=0` kill switch no longer restores the boxed carrier (`s` is f64 either way) |
| issue-4150-fmod-integral-fast-path | standalone/linear | 1 | `guarded` body has no `call` — the AOT-proof path choice changed |
| issue-3683-direct-calls | standalone | 2 | devirtualised captured method: guard shape differs; VOID-callee bench answer `1237` vs `1230` (**value — check first**) |
| identity-array-search-fast-path | host `fast` | 1 | `const arr: number[] = []` is built as an f64 vec and copied into an i32 vec (+ `__copy_wasm_struct_sidecar` host call) at init — the search fast path itself still folds |
| issue-1120 | host | 1 | bitwise-coerced loop local no longer `(local $a i32)` |
| issue-1179-followup | host | 1 | `*` WAT no longer contains `4294967296` |
| issue-2615 | host | 1 (+1 July-baseline) | escaping struct-target Proxy local is externref |
| issue-4707 | host | 1 | module Proxy iterator carrier global is externref |
| issue-4754-module-global-proxy-escape | host | 6 | escaping `new Proxy` module globals widened to `(mut externref)` |

## Plan

1. `issue-3683` VOID-callee first: a different benchmark sum is a wrong value
   unless the test's expected constant is stale — run the source under node.
2. For each standalone row, bisect the first red commit and decide: restore the
   fast path (fix) or re-pin with the commit that changed it on purpose.
3. Host rows: same, but only fix where the change came from shared code
   (CLAUDE.md: keep gc output byte-identical where unrelated; no new host work).
