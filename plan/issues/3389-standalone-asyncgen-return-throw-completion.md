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
# Slice 1: settleReturn terminator — analyzer admission + CFG plan (async-cps.ts)
# and the emitter arm + validateAsyncCfg (async-frame.ts).
# Slice 2a: .return()/.throw() drivers (async-frame.ts) + consumer dispatch
# (calls.ts) + recognition (call-receiver-method.ts) + producer registry
# (context/types.ts).
loc-budget-allow:
  - src/codegen/async-cps.ts
  - src/codegen/async-frame.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/context/types.ts
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

## Implementation notes (fable-dev-3, 2026-07-18) — Slice 1 in progress

STACKED on #3388's real branch (`fork/issue-3388-asyncgen-yieldstar`, PR #3332)
per the known-dependency exception — #3389's `settleReturn` sits in the same
`analyzeAsyncGen`/`planAsyncGenCfg`/`emitAsyncFrameStateMachine` surface #3388
extended (rtDelegate). PR opens only AFTER #3332 merges (then re-merge
origin/main; the stack collapses).

### Slice 1 design (top-level `return E` → settleReturn)

1. `AsyncGenShape` gains `returnExpr?: ts.Expression | null` (undefined = no
   return / fall-through `settleUndefined`+`settleDone`; null = bare `return;`;
   Expression = `return E`).
2. `analyzeAsyncGen`: a top-level `ReturnStatement` (statement position, not
   nested in control flow — `containsOwnScopeReturn` on a LEAD still bails)
   records `returnExpr` and terminates the body (trailing statements are
   unreachable). Suspend-free operand only (`!containsAwaitOrYield(E)`).
   Promise-typed `E` BAILS on the carrier lane (`implicitYieldAwait !== null &&
yieldOperandIsPromiseTyped`) — the §27.6.3.8 return-value Await is deferred
   (correct-or-legacy, same policy as `yield await` / #3120); carrier-off admits
   all suspend-free E (documented promise-return value gap, mirrors #3120).
3. `AsyncCfgTerminator` gains `{ kind: "settleReturn"; value: AsyncCfgOperand |
null; resumeState }`. `planAsyncGenCfg`: when `shape.returnExpr !== undefined`
   the tail state gets `settleReturn(value, resume→doneState)` and a TRAILING
   `settleDone` state is appended — so the first settling `next()` gives
   `{value: E, done: true}` and every SUBSEQUENT `next()` gives
   `{value: undefined, done: true}` (§27.6.3.8 completed-frame semantics).
4. `emitAsyncFrameStateMachine` (async-frame.ts): the `settleReturn` arm mirrors
   `settleYield` (compute E → externref) but builds `{value: E, done: 1}` (like
   `settleDone`'s struct but with the real value), settles the result promise,
   sets STATE=resumeState (the trailing settleDone), spills, returns.

Lockstep is automatic (single `analyzeAsyncGen` gate →
`isBoundedAsyncGenBody`/`isAsyncGenDriveCandidate`/import-collector), verified
with wrapped leak probes + a mixed-module carrier probe.

Slice 2 (consumer `.return()`/`.throw()` on driven frames) is a follow-up.
Out of scope both slices: `return` inside try/finally (finally-across-suspend),
yield\* delegate return forwarding (§27.6.3.7 7.b — needs #3388+#3389 both).

## Slice 1 landed — Documented next slices (fable-dev-3, 2026-07-18)

Slice 1 (settleReturn terminator, PR opened post-#3388-merge) admits the clean
top-level `return E` shape. Two follow-ups remain for the full ~268-row bucket:

- **Slice 2 — consumer `.return()` / `.throw()` on DRIVEN frames**
  (`AsyncGeneratorPrototype/{return,throw}` rows + `__gen_throw` combos): add
  `__async_gen_return_<stem>` / `__async_gen_throw_<stem>` siblings (or a
  completion-kind param on the existing `__async_gen_next_<stem>` driver) that
  settle/reject a suspended-at-yield or completed frame. See the Slice 2 block
  in the Implementation Plan above.
- **try-across-yield follow-up (the corpus multiplier)**: the has-return
  async-gen CORPUS files overwhelmingly wrap the `return` in `try`/`catch`/
  `finally` across a `yield` (e.g. `try { yield* x } catch(e) { } return thrown`),
  or combine it with `yield*` return-forwarding (§27.6.3.7 7.b). Those stay
  legacy after slice 1 (correct-or-legacy) and are what gates most of the 268
  rows — the return-completion handler must run the `finally` on the return
  path (out of scope for slices 1–2; needs the async-frame handler-region
  generalization, cross-ref #2906 gap-3 try/finally).

## Slice 2 — implementation-ready spec (fable-dev-3, 2026-07-18)

Full source investigation done; this is a de-risked, ground-truth spec so slice 2
can be implemented cleanly (fresh, not rushed at a deep session's tail — it
touches the shared async-gen frame state machine that 5 in-flight PRs ride).
Two independent sub-slices, ONE PR each.

### Sub-slice 2a — `.return(v)` / `.throw(e)` consumer methods (LOW RISK)

**Key simplification:** bodies with try/finally or catch ACROSS a yield stay
legacy (that's sub-slice 2b / out of scope). So for every gen the driven lane
ADMITS, a suspended-at-yield `.return(v)`/`.throw(e)` runs NO further body — it
just completes the frame. Therefore we do NOT need to kick the resume machine
or add a MODE_RETURN/MODE_THROW resume path. Just settle + mark-done.

**Mark-done WITHOUT touching the shared dispatch:** set `frame.STATE` to the
gen's existing `settleDone` state id. A subsequent `.next()` re-dispatches
there → `{value: undefined, done: true}` (settleDone is entry-independent). No
done-guard, no change to `emitAsyncFrameStateMachine`'s if-chain (zero
regression surface on the shared machine).

Steps (all in async-frame.ts + the two dispatch files):

1. `AsyncFrameInfo.settleDoneStateId?: number`. In `ensureAsyncResumeFunction`
   after `cfg` is built (async-frame.ts:1044), set it to the id of the state
   whose `terminator.kind === "settleDone"` (exactly one per gen cfg — the last
   state; for a `return E` body it's the trailing settleDone slice 1 appended).
2. `emitAsyncGenReturnThrowHelpers(ctx, info, promiseTypeIdx)` next to
   `emitAsyncGenNextHelper` (async-frame.ts:2530). Two exported funcs
   `(frame externref, arg externref) -> externref`:
   - `__async_gen_return_<stem>`: f=cast; p=fresh pending $Promise;
     f.result_promise=p; build IteratorResult `{value: arg, done: 1}`
     (`ensureNativeGeneratorResultType(ctx,{externref})`); `rt.fulfillFuncIdx(p,
result)`; `f.STATE = info.settleDoneStateId`; return p.
   - `__async_gen_throw_<stem>`: f=cast; p=fresh; f.result_promise=p;
     `rt.rejectFuncIdx(p, arg)`; `f.STATE = settleDoneStateId`; return p.
     (`rt = ensureAsyncDriveRuntime(ctx)`; `.fulfillFuncIdx`/`.rejectFuncIdx` —
     the same handles `emitAsyncFrameStateMachine` uses at async-frame.ts:1247.)
     §27.6.3.9: a completed-frame `.throw` still rejects — same code path (STATE
     already at settleDone; reject again is correct). `.return` on a completed
     frame → `{value: v, done: true}` — same path.
3. In `emitAsyncGenerator` (async-frame.ts:2457) call the new helper after
   `emitAsyncGenNextHelper`. Extend `ctx.asyncGenProducers` entry with
   `returnHelperName`/`throwHelperName` (additive — #2570/#3388 delegate
   resolution reads `nextHelperName`/`stateTypeIdx`/`decl` only, so new optional
   fields are inert there).
4. `tryEmitAsyncGenReturnThrowDispatch(ctx, fctx, receiverExpr, method, argExpr)`
   in calls.ts, modeled on `tryEmitAsyncGenNextDispatch` (calls.ts:4400) — same
   `ref.test` producer chain, but call `p.returnHelperName`/`throwHelperName`
   with (recv, arg). Miss arm: host `__gen_return`/`__gen_throw` only when
   `asyncGenLegacyBufferEmitted`, else null (host-free floor), mirroring next.
5. Recognize `.return(v)`/`.throw(e)` (arg count 0 or 1) on the
   `AsyncGenerator`/`AsyncIterableIterator`/`AsyncIterator` receiver at
   call-receiver-method.ts:337-349 (the block that today only handles `.next()`
   and comments "`.throw()`/`.return()` are 3d-iii").

- Corpus: `built-ins/AsyncGeneratorPrototype/{return,throw}` (25 rows) + the
  `__gen_throw` (80) / `__gen_set_return` combos on simple-body gens.
- Tests: `.return(v)` on a suspended-at-yield gen → `{v,true}` + subsequent
  next→`{undefined,true}`; `.throw(e)` → rejected(e) + gen done; `.return`/
  `.throw` on a completed gen; correct-or-legacy: a gen with try/finally across
  a yield keeps the legacy path (its `.return` runs finally — 2b).

### Sub-slice 2b — try-across-yield return admission (HIGHER RISK, the corpus multiplier)

WHY slice-1's corpus flip was modest: most `has-return` async-gen corpus files
wrap the `return` in `try { … yield … } finally { … }` (or catch), which
`analyzeAsyncGen` bails today (`containsAwaitOrYield` on the try lead + no
handler-region support in the GEN cfg). Admitting them needs the #2906 Gap-3
handler-region machinery (finalizer inline copy + abrupt-path catch replay,
async-frame.ts:1833-1871) EXTENDED to the async-gen settleYield/settleReturn
terminators: a `.return()`/`.throw()` or a body `return` that crosses a try must
run the `finally` on the completion path before settling. This is the genuinely
hard part (handler regions interacting with the yield suspend/resume + the
return completion) and should be its own carefully-validated PR after 2a, using
the #3132 S2 lockstep tests as the mix-safety template. Out of scope until 2a
lands and the handler-region-in-gen design gets an architect pass.
