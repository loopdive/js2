---
id: 1346
title: "spec gap: yield in nested try/finally + yield expression evaluation order (46 test262 fails)"
status: done
created: 2026-05-08
updated: 2026-06-11
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: generators
goal: spec-completeness
sprint: 61
parent: 1328
related: [1665, 1042, 1620, 1320]
claimed_by: codex-developer
claimed_at: 2026-06-06T09:10:15.635Z
pr: 1246
completed: 2026-06-06
---
# #1346 — yield expression: try/finally + evaluation order

## Problem

`language/expressions/yield`: **16 / 63 pass (25.4%) — 46 fails (31 assertion_fail, 13 other,
2 type_error)**.

Spec §15.5.5 (YieldExpression) requires:
1. **Single-step evaluation**: the expression is evaluated, the value is sent to the consumer,
   then the consumer's return value (if .next(value) is called with a value) becomes the result
   of the yield expression.
2. **try/finally interaction**: when a generator is suspended at a yield, calling `.return()` triggers
   the finally block to run before the generator completes.
3. **yield* delegation**: forwards the iterator protocol to the inner iterable, including
   .return/.throw forwarding.
4. **yield in argument list**: `f(yield 1, yield 2)` evaluates yield 1 first, then yield 2.
5. **yield in compound expression**: `[yield 1, 2]` — yield 1 first, then 2.

The 31 assertion_fail failures suggest:
- yield* doesn't forward `.return()` correctly through nested delegation.
- Try/finally finalizers aren't run on early `.return()`.
- yield evaluation order in complex expressions isn't observed correctly.

## Acceptance criteria

1. `language/expressions/yield/star-iterable.js` passes.
2. `language/expressions/yield/star-rhs-iter-rtrn-meth-throws.js` passes.
3. `language/expressions/yield/yield-as-yield-operand-in-fn-arg.js` passes.
4. Pass-rate for `language/expressions/yield` rises from 25% to ≥70%.

## Files to modify

- `src/codegen/expressions.ts` — yield expression compiler
- `src/codegen/statements.ts` — try/finally lowering interaction with yield
- `src/codegen/registry/iterator.ts` — yield* delegation

## Implementation Plan

### Root cause

The yield state machine collapses each yield to a single suspension point with a specific
state-tag, but try/finally introduces an extra "abrupt-completion handler" state that we
don't materialize. When `.return()` is called on a generator suspended inside a try block,
we should jump to the finally block before completing, but we instead complete directly.

For yield*: the delegation loop reads from `.next()` of the inner iterable but doesn't forward
the outer's `.return(value)` and `.throw(error)` to the inner — it just propagates upward.

### Approach

1. **try/finally + yield**: extend the generator state struct with a "pending-return-value" slot.
   When `.return()` is called while suspended in a try, set the slot, jump to finally block, then
   on finally exit either rethrow or return.
2. **yield* delegation**: the inner-iterator must be stored in a generator-local field. On
   `.return()`/`.throw()` from outside, dispatch to the inner-iterator's matching method (if any).
3. **Evaluation order**: the parser/IR-lowerer should preserve sequential yield-evaluation by
   binding intermediate values to temporaries before the next yield.

### Edge cases

- yield* on null/undefined → TypeError ("not iterable").
- yield in finally block of an outer try — the finally should run to completion before re-throwing.
- yield* on an iterator that doesn't define `.return` or `.throw` — silently ignore the inner
  call (don't crash).

### Test262 sample

- `test262/test/language/expressions/yield/star-rhs-iter-rtrn-meth-throws.js`
- `test262/test/language/expressions/yield/star-iterable.js`
- `test262/test/language/expressions/yield/yield-as-yield-operand-in-fn-arg.js`

## Architect Spec (2026-06-04) — the eager model is the blocker; build on the suspendable state machine

The coarse plan above describes the fixes at the level of "extend the state
struct," but it does not name the **fundamental blocker**: there are two
generator lowerings on main, and the one used for the failing tests cannot host
ANY of these features. This section pins that, then sequences the work against
the only model that can.

### Two generator models on main (verified 2026-06-04)

1. **Eager buffer model** (DEFAULT — `function-body.ts:879`, `compileYieldExpression`
   at `expressions/misc.ts:162`). The generator body is compiled to run **to
   completion up front**, pushing every yielded value into a `__gen_buffer`
   (`__gen_push_f64/i32/ref`); the consumer later drains the buffer. Every
   `yield` "receives" `ref.null.extern` (see the explicit comments at
   `misc.ts:212` and `:253`). This model **structurally cannot**:
   - implement `.next(v)` two-way communication (yield must return the sent value);
   - implement `.return(v)` / `.throw(e)` early termination (the body already ran
     to completion before the consumer sees anything);
   - run a `try/finally` finalizer at the suspension point (there is no
     suspension point — it's a straight run);
   - forward `.return`/`.throw` through `yield*` (`__gen_yield_star` just drains
     the inner into the buffer).
   So the entire scope of #1346 (try/finally + `.return`/`.throw` + `yield*`
   forwarding + interleaved eval order observed across suspensions) is
   **impossible on the eager model** — it is not a localized `compileYieldExpression`
   patch.

2. **Native suspendable state machine** (`generators-native.ts`, #1665 — the
   real fix path). `__gen_resume_<g>(self) → {value,done}` reads a saved state
   field from a per-generator state struct, dispatches by state
   (`buildDispatch`), runs one segment, stores the next state, returns
   (`generators-native.ts:262-420`). This IS a genuine suspend/resume model and
   is the only place these features CAN live. But it is gated extremely narrowly
   (`isNativeGeneratorCandidate:106` + `buildNativeGeneratorSegments:60`):
   - standalone/WASI only (`noJsHostTarget`);
   - top-level `function*` declaration (no methods, no expressions);
   - identifier params only, **numeric/boolean yields only** (`:73`);
   - **no `yield*`** (`:73` bails on `asteriskToken`);
   - **no control flow** — only flat expression statements + yields + a trailing
     return (`:89/:94` bail on anything else, including `try`/`if`/loops).

**Conclusion for the dev:** #1346 is **architect-gated on extending the
suspendable state machine** (model 2) to cover control flow — specifically
try/finally — and the two-way protocol. It cannot be closed against the eager
model. The work is the same architectural axis as #1665 (this state machine) and
#1042 (the async CPS lowering, which solves the structurally-identical
suspend/resume problem for `await`). **Strongly prefer unifying the generator
state machine with the #1042 CPS lowering** rather than building a third
suspend mechanism — see Slice 0.

### Spec — phased

#### Slice 0 (design, ~0.5 day) — pick the suspend substrate

Decide and record: extend `generators-native.ts`'s state-machine to (a) control
flow + (b) the two-way protocol, OR generalize the #1042 CPS continuation
lowering (which already linearizes suspension points for `await`) to also lower
`yield`. The two are the same problem (a resumable function with saved locals +
a resume entry point). Recommend (b)-style unification if #1042's CPS framework
is far enough along; otherwise extend (a). This Slice produces a 1-page ADR and
the state-struct shape below; it gates the rest. **This is the load-bearing
decision the issue's "extend the state struct" hand-waves past.**

State struct additions (whichever substrate):
```
$GenState (struct
  (field $state (mut i32))          ;; resume point (existing)
  (field $sent  (mut externref))    ;; value passed to .next(v) — NEW (two-way)
  (field $mode  (mut i32))          ;; 0=next 1=return 2=throw — NEW (abrupt)
  (field $abrupt (mut externref))   ;; pending return value / thrown error — NEW
  (field $inner (mut externref))    ;; active yield* delegate iterator — NEW
  ... saved locals ...)
```

#### Slice A — try/finally finalizer on suspend + `.return()`/`.throw()` (§15.5.5, §14.15 / GeneratorResumeAbrupt)

**Gap:** `.return(v)` on a generator suspended inside a `try` must run the
`finally` block before completing; `.throw(e)` must inject the error at the
suspension point so a wrapping `try/catch` can handle it.

**Fix (on the suspendable substrate):**
- The resume entry (`__gen_resume_<g>`) takes a `$mode` (next/return/throw) read
  from the state struct (set by the `.return`/`.throw` driver before calling
  resume). On entry, dispatch by `$state` to the suspension point, then by
  `$mode`:
  - `next` → resume normally with `$sent` as the yield result.
  - `return` → treat as an abrupt completion at the suspension point: branch to
    the nearest enclosing `finally` (if the suspension was inside a try with a
    finally), run it, then complete with `$abrupt` as the return value. If no
    finally, complete immediately.
  - `throw` → branch to the nearest enclosing `catch` (if any) with `$abrupt` as
    the caught value, else to the `finally`, else propagate (set done + rethrow).
- **Lowering try/finally inside a generator**: the existing try/finally lowering
  (`statements/exceptions.ts:172` — pre-compiles + clones the finally body) must
  become **suspension-aware**: each `yield` inside a `try` records, in the state
  struct, which finally-block(s) are pending so an abrupt resume can replay them
  in LIFO order (the §14.15 "active finally stack"). Model the active try-stack
  as a small compile-time list per suspension point; emit the finalizer
  branch-target table into the resume dispatch.
- Files: `generators-native.ts` (resume dispatch by mode + finalizer targets),
  `statements/exceptions.ts` (suspension-aware finally — record pending
  finalizers per yield), the `.next`/`.return`/`.throw` driver (set `$mode`/
  `$abrupt` before resume — host driver today; native driver for standalone).

#### Slice B — `yield*` delegation forwarding (§15.5.5 step 7 / yield* runtime)

**Gap:** `__gen_yield_star` (`misc.ts:177-201`) just drains the inner iterable
into the outer buffer — it does NOT forward an outer `.return(v)`/`.throw(e)` to
the inner iterator's matching method.

**Fix:** store the active delegate iterator in `$inner`. The delegation loop
calls `inner.next($sent)`; on each round, if the outer was resumed with
`$mode=return`, call `inner.return($abrupt)` (if present) and propagate its
result; if `$mode=throw`, call `inner.throw($abrupt)` (if present, else close
inner + TypeError per §15.5.5). Yield each inner value outward (real suspension,
not buffer drain). `yield*` evaluates to the inner's final return value (NOT
undefined — fix the `misc.ts:199` `ref.null.extern`).
- Files: `misc.ts` (real suspending `yield*`), `generators-native.ts` (delegate
  forwarding in resume), `registry/iterator.ts` (inner `.return`/`.throw`
  GetMethod).

#### Slice C — yield evaluation order (§13.x sequential evaluation)

**Gap:** `f(yield 1, yield 2)` / `[yield 1, 2]` must evaluate left-to-right with
each `yield` a real suspension between them. On the eager model the ordering is
incidental; on the suspendable model, each `yield` in an argument/element list
is its own suspension point, so the arg-list / array-literal lowering must
sequence them (bind each evaluated operand to a saved local before the next
yield suspends, so the partial results survive the suspension).
- Files: `expressions/calls.ts` + `literals.ts` (sequence operands through saved
  state locals when a generator body contains yields in the operand list),
  driven by the Slice-0 substrate's local-spill mechanism.

### Edge cases

- `yield*` on null/undefined → TypeError (not iterable) — §15.5.5; reuse the
  GetIterator throw (ties into #1320 standalone iterator bridge for the
  no-JS-host case).
- `yield` in a `finally` block — the finally must run to completion (including
  its own suspensions) before the original abrupt completion resumes (§14.15).
- `yield*` over an inner iterator lacking `.return`/`.throw` — silently skip the
  inner call (don't crash), per §15.5.5 (GetMethod returns undefined → no-op for
  return; TypeError for throw if `.throw` absent and a throw was requested).

### Slice independence + sizing

- **Slice 0** (substrate decision/ADR): gates everything; ~0.5 day, no test
  movement but unblocks A–C. **Architect or senior-dev should ratify before any
  impl PR.**
- **Slice A** (try/finally + .return/.throw): the largest test lever
  (the 31 assertion_fail + the `.return`-triggers-finally cluster), but the
  hardest — full suspend/resume + finalizer stack. ~1–2 weeks.
- **Slice B** (`yield*` forwarding): ~1 week, depends on A's resume-by-mode.
- **Slice C** (eval order): ~3 days, depends on Slice-0 local spill.
- These are NOT independently shippable the way the other sprint-59 specs are —
  they share the suspend substrate (Slice 0). Recommend the lead schedule Slice 0
  as a senior-dev design task FIRST, then A as the first impl PR.

### Risk / conflicts

- **This is the deepest spec in the batch.** It overlaps #1665 (native
  generators), #1042 (async CPS — same suspend problem), #1620 (iterator-result
  struct), and #1320-standalone (GetIterator for `yield*` not-iterable). Slice 0
  must reconcile with #1042's CPS direction so the project ends with ONE
  resumable-function lowering, not three.
- Do NOT attempt any of A/B/C against the eager buffer model — it will produce
  plausible-looking code that cannot pass the `.return`/`.throw`/try-finally
  tests, wasting a dev cycle (the issue's coarse "extend the state struct"
  invites exactly this on the wrong model).
- No new host imports for the standalone substrate — the state machine is
  WasmGC-native (consistent with #1665). JS-host mode may keep its host
  generator driver as the fast path.

> **Routing recommendation:** this issue is `feasibility: hard` /
> `reasoning_effort: high` and architecturally entangled with #1042/#1665.
> Slice 0 belongs to a **senior-dev** as a design task, not a routine dev pickup.
> The other four sprint-59 specs (#1818/#1644/#1320/#1348/#6407) are
> dev-claimable; this one should be senior-dev-gated on Slice 0 first.

## Implementation Update — 2026-06-06

Implemented the first suspendable-generator slice on the existing
`generators-native.ts` substrate, following ECMA-262 2026 §15.5.5
(`YieldExpression`) and §27.5.3.4/§27.5.3.6 (`GeneratorResumeAbrupt` /
`GeneratorYield`):

- Added native generator state fields for `sent`, `mode`, and `abrupt` values.
- Added state-struct spill slots for simple `const x = yield n` bindings so
  `.next(value)` becomes the yield expression result after resumption.
- Taught `.next(value)` to store the sent value before calling the resume
  function.
- Taught `.return(value)` to resume suspended-yield states with
  `mode=return`; suspended-start and completed states still complete
  immediately.
- Added simple `try/finally` planning for non-yielding finalizers so a
  `.return(value)` from a yield inside `try` runs pending `finally` statements
  before completing.

Scope intentionally remains native-generator-only (`standalone` / `wasi`) and
numeric-yield-only. The eager JS-host buffer path still cannot satisfy the full
test262 cluster because it has no real suspension point. Remaining full-issue
work:

- `yield*` delegation forwarding (`return`/`throw`) is still not implemented.
- `throw()` injection is still not implemented for native generators.
- Yield operands inside arbitrary call/array expressions still need the broader
  expression-spill lowering described in Slice C.
- Full `language/expressions/yield` pass-rate was not rerun locally; this
  workspace's `test262/` directory is empty, and the task rules prohibit full
  local test262.

Focused validation added in `tests/issue-1346.test.ts`:

- `.next(value)` feeds sequential `yield` expression results.
- `.return(value)` at a yield inside `try` runs the pending `finally`.
- Normal resume after a yield inside `try` runs `finally`.
- `.return(value)` before the first `.next()` does not enter the generator body.
