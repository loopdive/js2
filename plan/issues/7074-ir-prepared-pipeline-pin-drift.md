---
id: 7074
title: "issue-tests: ~80 IR Prepared-pipeline ownership/cutover pins drifted while the detector was blind (2856, 3522, 3527, 3529, 3288, 4486/5166, 4577, 4590/4591, 2972, 3744, 4110, 3995, 1004)"
status: ready
sprint: Backlog
created: 2026-10-18
updated: 2026-10-18
priority: medium
horizon: l
feasibility: hard
reasoning_effort: high
task_type: test-maintenance
area: ir
language_feature: n/a
goal: ci-hardening
related: [7014, 7072, 7073, 2856, 3522, 3527, 3529, 3288, 4486, 5166, 4577, 4590, 4591]
requested_by: ttraenkler/wave15-grep-other-sentinels
---

# #7074 — IR Prepared-pipeline pins drifted (owner decision per suite)

Found by the #7014 follow-up (wave 15, grep/other slice). These suites pin the
INTERNALS of the IR Prepared pipeline — which functions an owner claims
(`expected [ 'writer', … ] to not include 'writer'`), exact postclaim/demote
diagnostics (`expected [ { kind: 'build' … } ] to deeply equal []`), exact
funcIdx/support-binding slots (`{ space: 'function', index: 66 }` vs `76`),
exact census sizes (`to have a length of 38 but got 41`), and WAT shapes of
prepared bodies (`to contain 'struct.new 55'`). All went red between July and
2026-10-15 with no observable wrong JS value in the failure lines. Deciding
whether each drift is an intended pipeline change (re-pin) or a lost claim (fix)
needs the IR lane's context; a wave-15 agent cannot tell from outside.

Measured red on upstream/main e8699e30ee (2026-10-17), one file at a time:

| file | red | first error |
|---|---|---|
| issue-2856-calendar-residuals | 16 | `expected [] to include 'install'`; host Date ABI rows empty |
| issue-2856-module-bindings | 10 | legacy writer/reader now IR-claimed (`to not include 'writer'`); strict-no-host `error.reference.construct` unavailable |
| issue-2856-inline-small-buffer-caller | 1 | inlined result no longer `call`s |
| issue-2972 | 3 | IR-first claimed functions now demote (`to not include 'f'`) |
| issue-3288 | 4 | P1 lowering metadata: no locals materialized, legality op list differs |
| issue-3522-ir-class-compile-once | 2 | `struct.new 55`; gc lane fails validation in `__fn_tramp_Holder_keep_1` (**real invalid Wasm**) |
| issue-3522-ir-cross-owner-free-function | 5 | Mid_init/Base_init shapes, withdraw diagnostics |
| issue-3522-ir-nested-class-expression-ownership | 2 | prepared method has no `struct.get` |
| issue-3522-ir-nested-class-ownership | 3 | field family length 5 vs 4 |
| issue-3527-async-call-closure | 6 | Promise-owner R3 rejections no longer fire; IrInvariantError "lost its source pr…" |
| issue-3527-settled-owner-runtime | 3 | `{ kind: 'emitted' }` expected |
| issue-3529-dataflow-outcomes | 1 | `{ kind: 'unsupported' }` expected |
| issue-3744-ir-owned-append-string-builder | 1 | `run` not on the owned-append path |
| issue-4110-ir-fetch-all-parallel | 1 | owner/helper call shape |
| issue-4486 / issue-5166 | 1 / 3 | `boolean[][]` IR body not emitted; #5166 D short row reads `3` where legacy gives `NaN` (**value**) |
| issue-4577-dom-interaction-bridge / -standalone-calendar-retirement | 1 / 3 | Calendar census 41 vs 38; 37 redundant module TDZ guards |
| issue-4590-bench-loop-prepared-cutover / issue-4591-fib-pair-prepared-cutover | 3 / 3 | 13 vs 14 rows; support binding slot 66 vs 76 |
| issue-1004 | 3 | counted-append aggregate not routed through Prepared IR |
| issue-3995-hono-class-boundary | 1 | `__async_resume_fanon_` continuation present |

## Plan

1. For each suite, bisect the first red commit (the issue-tests partials from
   run 38851065732 carry the first error line per test).
2. Two rows look like real defects, not drift — do them first:
   `issue-3522-ir-class-compile-once` (gc lane emits INVALID Wasm in a
   trampoline) and `issue-5166` D (a short boolean row reads `3`, not the
   legacy `NaN`).
3. Re-pin the rest against the pipeline as it now is, citing the commit that
   moved each claim, or retire the suite if its owner issue is closed.
