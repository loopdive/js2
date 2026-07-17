---
id: 3389
title: "standalone: `return` completion in driven async-gen bodies (settleReturn terminator) + AsyncGeneratorPrototype.return/.throw residual (~300 rows)"
status: ready
sprint: current
created: 2026-07-17
updated: 2026-07-17
priority: medium
horizon: m
feasibility: hard
model: opus
reasoning_effort: high
task_type: feature
area: codegen, standalone
language_feature: async-generators
goal: standalone-mode
umbrella: 3178
related: [3132, 3387, 3388, 2865, 2906]
origin: "2026-07-17 fable-3178 umbrella decomposition — #3132 S4 banked slice, re-grounded: __gen_set_return 268 / __gen_return (async combos) / __gen_throw 80 rows."
---

# #3389 — async-gen `return`/`throw` completion for the driven lane

## Problem

Async-gen bodies containing an own-scope `return` are non-drivable, so they
fall to the legacy host buffer (and force the module's carrier OFF — the
`Promise_*` co-leak). Measured 2026-07-17: `__gen_set_return` appears in 268
official-scope leak rows, `__gen_throw` in 80; the class/elements 126-row combo
(`…__gen_result_*,__gen_set_return,__get_caught_exception` + `Promise_*`) and
the corpus `has-return` decomposition (#3132: 172 method + 5 fn files) are the
targets, plus `built-ins/AsyncGeneratorPrototype/{return,throw}` (14+11 rows).

Probe matrix (2026-07-17): `async function* g() { yield 1; return 42; }` is
HOST-FREE at module scope but **LEAKS**
(`__gen_set_return,__gen_push_f64,__create_async_generator,…`) when wrapped in
the test262 `export function test(){}` wrapper — the same nesting seam as
#3387/#3388 (all corpus files are wrapped).

## Root cause

- `analyzeAsyncGen` (`src/codegen/async-cps.ts:2240`) rejects any lead
  statement containing an own-scope `return`: `containsOwnScopeReturn`
  (async-cps.ts:2118, applied at ~2311). The doc comment on it names the gap:
  a lead `return v` would settle the pending `next()` promise with the RAW
  value via the `asyncDriveReturn` hook instead of the §27.6-required
  IteratorResult `{value, done: true}` — "bodies with returns stay on the
  legacy path until a settleReturn terminator exists (3d-iii)".
- The async-gen CFG has only `settleUndefined` (fall-through ⇒
  `{value: undefined, done: true}`) and `settleYield` terminators.

## Implementation Plan

### Slice 1 — `settleReturn` terminator (top-level `return E`)

**Files: `src/codegen/async-cps.ts` (analyzer + CFG plan),
`src/codegen/async-frame.ts` (emitters).**

1. Admit a top-level `return E` / bare `return` in `analyzeAsyncGen`: a
   trailing tail segment, or a mid-body return that terminates the CFG (a
   `return` after which no further segments execute). Relax
   `containsOwnScopeReturn` only for DIRECT top-level return statements —
   returns nested in control flow stay bailed (correct-or-legacy) until the
   general CFG generalization.
2. Add a `settleReturn(E)` CFG terminator + emitter: evaluate `E` in the
   resume scope, settle the frame's pending result promise with the
   IteratorResult struct `{value: E, done: true}` (§27.6.3.8
   AsyncGeneratorCompleteStep with a return completion — NOT the same as
   fall-through, which must keep `value: undefined`). Mint the
   `$IteratorResult` via the same struct the `settleYield` emitter uses.
   Subsequent `next()` calls on a completed frame return
   `{value: undefined, done: true}` — verify the frame's done-state guard
   already does this (the state machine's terminal state).
3. `return E` where `E` is Promise-typed: §27.6.3.8 awaits the return value
   under a return completion. On the carrier lane assimilate the native
   `$Promise` before settling (reuse the awaited-yield assimilation arm);
   carrier-off lane: keep Promise-typed `E` bailed (same policy as
   `yield await` — correct-or-legacy).
4. Lockstep is automatic through the single analyzer
   (`isBoundedAsyncGenBody`/`isAsyncGenDriveCandidate`/import-collector) —
   verify with wrapped leak probes and a mixed-module carrier probe.

### Slice 2 — consumer `.return()` / `.throw()` on DRIVEN frames

`AsyncGeneratorPrototype/{return,throw}` rows (25) + `__gen_throw` combos:
the driven frame's `.return(v)`/`.throw(e)` methods must:

- `.return(v)`: if suspended-at-yield → settle `{value: v, done: true}` and
  mark the frame done (no finally support in slice 2 — bodies with
  try/finally across a yield stay legacy); if completed → same result promise.
- `.throw(e)`: if suspended-at-yield → reject the pending promise with `e`
  and complete the frame; if completed → rejected promise per §27.6.3.9.
- Wire through the SAME dispatch registry the `.next()` driver uses
  (`__async_gen_next_<stem>`, `ctx.asyncGenProducers`) — add
  `__async_gen_return_<stem>`/`__async_gen_throw_<stem>` siblings, or a
  completion-kind param on the existing driver (prefer the param — one
  function, no registry key churn; check `resolveAsyncGenNextHelperName`
  (#3001) consumers for where the dispatch happens).

## Edge cases

- `return` inside try/finally must run the finally on the return path — OUT
  of scope for both slices (stay bailed; note residual count).
- Distinguish body fall-through (`value: undefined`) from `return;`
  (also `value: undefined` but via return completion — observable only with
  finally, so slice 1 treats them identically; document this).
- yield\* interaction (delegate return forwarding, §27.6.3.7 step 7.b) belongs
  to #3388/#3389 jointly — only needed once BOTH land; keep bailed with a
  cross-reference note.

## Test plan

- Executed wrapped probes: `{value: 42, done: true}` on the settling `next()`,
  subsequent `next()` gives undefined/done, `.return`/`.throw` on suspended
  and completed frames, rejection identity.
- Construct-sample the `has-return` method corpus + AsyncGeneratorPrototype
  return/throw dirs; zero pass→fail on issue-3132\* suites.
- Host lane SHA-identical.

## Regression risks

- Same `analyzeAsyncGen` conflict surface as #3387/#3388 — sequence PRs.
- The driver-signature change (completion-kind param) touches every driven
  consumer call site — grep `__async_gen_next_` emitters before choosing the
  param vs sibling-function shape.
