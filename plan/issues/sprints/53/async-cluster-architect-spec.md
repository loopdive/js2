---
sprint: 53
status: spec
created: 2026-05-20
covers: [1042, 1116, 1151, 1373, 1373b]
goal: async-model
authors: architect
---
# Sprint 53 — Async Cluster Joint Architect Spec

**Scope**: a single, coherent strategy for five interlocking async issues that
must share one state-machine model, one Promise representation, and one
error-propagation path. Without this joint spec, three devs implementing in
parallel will build incompatible state machines and the cluster will not
converge.

The five issues:

| ID | Title | Status today |
|----|-------|--------------|
| #1373  | IR: claim async functions through IR path | **done** (Phase A+B landed PR #328 — selector bucket `async-function`, IR node types `IrInstrAwait` / `IrInstrAsyncReturn` / `IrInstrAsyncThrow`; lowering throws) |
| #1373b | IR async Phase C: CPS lowering | **blocked** on #1326c Phase 1C-B (`emitStandalonePromiseThen` standalone wiring) |
| #1042  | async/await state-machine lowering (AwaitExpression no-op) | **ready** — `await` is still `compileExpressionInner(operand)` in `expressions.ts:973` |
| #1116  | Promise resolution and async error handling (~210 FAIL) | **ready** — v2 plan in issue; combinators + chaining + `new Promise` |
| #1151  | Async function synchronous throws bypass Promise.reject | **ready** — call-site `wrapAsyncCallInTryCatch` partially closed (#1150), body-wrap still wanted; param-destructure null-guard is the real remaining gap per investigation note (2026-04-21) |

---

## 1. Status quo summary

### 1.1 #1373 — IR async-function claim (DONE, but foundational)

Phase A separated `"async-generator"` from `"async-function"` in
`src/ir/select.ts:79` and added the body-shape bucketing at lines 463-481.
Phase B added the three async IR node types in `src/ir/nodes.ts:597,615,631`.
The switch arms at `src/ir/lower.ts:1773-1778` currently `throw` on `await`,
`async.return`, `async.throw`.

The selector at `src/ir/select.ts` never lets an `async function` through, so
the throwing arms are unreachable. The legacy codegen path
(`src/codegen/expressions.ts:898-937`) handles every async function today.

**Foundational role**: #1373 defines the IR contract that #1373b implements
and that #1042 must respect when it picks its lowering strategy. Even though
the issue is closed, this spec **must** treat its node types as the canonical
IR shape for async semantics — #1042's state machine and #1373b's CPS pass
both target these nodes.

### 1.2 #1373b — IR Phase C CPS lowering (BLOCKED)

Replaces the throwing stubs in `src/ir/lower.ts:1773` with real CPS
emission: each `await` splits its function into a pre-await prefix returning
a pending `$Promise` and a post-await continuation closure scheduled via
`__microtask_enqueue`.

Dependency: needs `emitStandalonePromiseThen` (`async-scheduler.ts:203`) to
have a real body — until then standalone mode cannot chain through
`.then`-shaped continuations.

### 1.3 #1042 — `await` is currently a no-op

`src/codegen/expressions.ts:973`:

```ts
if (ts.isAwaitExpression(expr)) {
  return compileExpressionInner(ctx, fctx, expr.expression);
}
```

`await Promise.resolve(42)` returns the externref representation of the
resolved value because host promises resolve before Wasm finishes. Anything
that needs **observable suspension** (parallel `Promise.all`, real I/O,
timeouts, microtask ordering) breaks.

The issue's recommended lowering is generator-style state-machine rewrite
(option 1) over Wasm stack-switching (option 2 — unavailable). The
generator path depends on #680 (Wasm-native generators), which has shipped.

### 1.4 #1116 — Promise combinators and error handling (~210 FAIL)

A v2 work-item list (WI1-WI8) is already in the issue file. It is a
**Promise-API completeness** spec: `Promise.allSettled` / `any` / `finally`,
`new Promise(executor)`, two-callback `.then(cb1, cb2)`, variable-typing
hygiene for `Promise.resolve(...)` initializers, plus runtime
`Promise_*` import handlers.

Critical detail buried in the issue: v1 of this work was **reverted** because
its type-inference overrides cascaded through generators and produced ~828
new compile errors. v2 limits type overrides to expression-level (not
hoisting) and adds a receiver type guard before routing `.then` through the
Promise host import. This spec adopts v2 verbatim for the JS-host mode.

### 1.5 #1151 — Sync throws bypass `Promise.reject`

`src/codegen/expressions.ts:236` (`wrapAsyncCallInTryCatch`, introduced for
#1150) **already** wraps every async-call site in a try/catch that converts
synchronous throws into rejected promises. Per the 2026-04-21 investigation
note inside the issue, this closed all 11 sampled for-await-of async-func
destructure tests.

The **remaining** gap is narrower than the issue title suggests: it is a
binding-pattern parameter inference bug in `closures.ts:875-886`. When an
async function (or generator, or arrow) takes a destructuring parameter like
`function*([[x]]) { }` and the TS checker infers `f64` for the param, the
externref destructure path (which contains the spec-required null guard) is
silently skipped and the body becomes a no-op. The investigation note's
narrow fix is: if `p.name` is an `ArrayBindingPattern` or
`ObjectBindingPattern`, override `wasmType` to `externref` unless it's
already a ref type.

Option 1 (full body-wrap in Wasm try/catch with return type changed to
externref) is **declined by the issue's own update note** — too much rework,
no clear added benefit over the call-site wrap that already shipped.

---

## 2. Unified architecture

### 2.1 The single state machine

Both #1042 (the AST-level no-op fix) and #1373b (the IR-level CPS pass)
target the **same** state-machine shape. We do not build two state machines.

**Canonical model**: each async function is split into N+1 segments at its N
`await` points. Each segment compiles to a Wasm function whose signature is

```
(externref capturedState) → externref   ;; the result-or-pending Promise
```

The first segment is the original async function's entry; segments 2..N+1
are synthetic continuation closures. Each segment ends in one of:

- `return value`                  → settle the outer `$Promise` to FULFILLED with `value` and return it
- `throw reason`                  → settle the outer `$Promise` to REJECTED with `reason` and return it
- `await expr`                    → register the next segment as `expr.then(nextSegment)`, return the outer pending `$Promise`

This is exactly the shape #1373's IR node definitions already encode:
`IrInstrAsyncReturn`, `IrInstrAsyncThrow`, `IrInstrAwait`. **The IR is
authoritative.** Any AST-level work in #1042 lowers AST nodes to these IR
nodes; it does not invent a parallel state-machine representation.

### 2.2 Capture shape — uniform-arity continuations

Continuations are uniformly `(externref) → externref` — value goes in,
value-or-pending-promise goes out. Captures (the rest of the async
function's locals as of the await point) ride **inside** the closure struct
(`__fn_wrap_N_struct`), not as extra Wasm parameters. This matches:

- `#1326c` "Approach (a)" from its constraint analysis (issue file lines
  64-75): unify all continuations to one funcref signature so the microtask
  drain loop can `call_ref` uniformly.
- The existing `__make_callback` shape used by JS-host `.then` callbacks.

Per-segment captures form a fresh closure struct generated by the codegen
closure pipeline (`src/codegen/closures.ts`). Locals referenced after the
await are auto-detected by a live-variables pass; locals only used before
the await stay scoped to the prefix segment and don't get captured.

### 2.3 The single Promise — hybrid representation

**Decision: hybrid, mode-determined at compile time.**

- **JS-host mode** (default): Promises are real host `Promise` objects
  carried as `externref`. `.then`, `.resolve`, `.reject`, combinators all
  flow through `Promise_*` host imports. This is what #1116 spec'd in
  WI1-WI8.
- **Standalone (WASI) mode**: Promises are WasmGC `$Promise` structs
  (registry already exists from #1326 Phase 1B). `.resolve` / `.reject`
  already lower to `struct.new`; `.then` and the microtask drain are
  scheduled via the `__microtask_enqueue` queue once #1326c Phase 1C lands.

Both modes settle through the **same IR** — only the lowering of
`IrInstrAsyncReturn` / `IrInstrAsyncThrow` / `IrInstrAwait` differs by mode.
The decision point is the existing `isStandalonePromiseActive(ctx)`
predicate in `async-scheduler.ts`; #1373b's CPS pass dispatches off it.

**Do not add a third representation.** No async function should ever return
a "bare T but with `Promise<T>` type". The current call-site wrap
(`wrapAsyncReturn` at `expressions.ts:184`) is a transitional shim and goes
away when #1042 lands — see §3.

### 2.4 Synchronous-throw lowering (#1151)

Two layers, kept in this order:

1. **Body layer** (#1373b CPS pass): every `throw` inside an async function
   body lowers to `IrInstrAsyncThrow` instead of `IrInstrThrow`. The Phase C
   lowerer settles the outer Promise to REJECTED. **No Wasm
   exception-handling at the function edge** — the IR-level transform
   handles it structurally.

2. **Call-site layer** (already shipped — `wrapAsyncCallInTryCatch`,
   `expressions.ts:236`): for async functions still on the legacy codegen
   path (i.e. not IR-claimed), the existing try/catch wrap stays in place.
   This is the safety net while #1042/#1373b roll out incrementally.

The legacy call-site wrap is the migration scaffolding. Once IR claims all
async functions and the body-layer wrap is universal, the call-site wrap
becomes a no-op and can be deleted. **Do not delete it before #1373b ships.**

**The remaining real gap for #1151** is the destructuring-param null-guard
bug in `closures.ts:875-886`. This is a one-line fix and lives in the
legacy path. It must be applied regardless of which lowering strategy wins
for `await`, because it affects function entry before the IR ever sees the
body. **Land this independently and first.** See Phase 1 below.

---

## 3. Implementation phases

The cluster has one critical dependency edge — #1373b is blocked on #1326c
Phase 1C — that pins the standalone path. We sequence around it.

### Phase 1 — Foundation (parallel-safe, two devs)

Goal: close every async-cluster fix that does **not** depend on the state
machine. These all live in the legacy codegen path and can land in any
order. They establish the baseline that #1042 / #1373b iterate on.

**1A. #1151 destructure-param null-guard** — `closures.ts:875-886` (and
sibling fixes in `class-bodies.ts`, `literals.ts` if regressions surface).
One-line `wasmType` override when `p.name` is a binding pattern. Unblocks
the 6 remaining async-gen-dstr tests called out in the 2026-04-21
investigation note.

**1B. #1116 Promise-API completeness (v2 plan)** — WI1 through WI8 from
the issue file, **applied verbatim**. The receiver type guard in WI3 is
load-bearing; do not skip it. Variable-typing hygiene (WI5) limits the
override surface to `Promise.resolve/reject/all/race/allSettled/any` and
`new Promise()` — **not** instance methods. This is the rule that prevents
the v1 cascading regression.

Phase 1 makes the legacy async path **spec-correct for completion handling
and Promise API**, but `await` is still a no-op (sync passthrough). That
limitation moves to Phase 2.

### Phase 2 — State machine (sequential, one dev)

Goal: real `await` semantics. This is the gate flip from "async functions
are sync functions wearing a Promise costume" to "async functions are state
machines settled through `$Promise`."

**2A. #1042 AST → IR routing for `await`** — replace the no-op at
`expressions.ts:973` with one of two routes:

- If the enclosing function is IR-claimed (the selector chose
  `"async-function"` → claimed), emit nothing here — the IR lowering owns
  the `await`. The AST-level handler becomes unreachable for IR-claimed
  functions.
- If the enclosing function is on the legacy path (IR rejected for any
  reason — closures, try/catch, generator overlap), emit a legacy CPS
  transform AT THE AST LEVEL using the same model as the IR pass. This is
  the larger half of #1042's work.

The IR path is the long-term answer; the legacy AST path exists so async
functions that the IR cannot claim (e.g. nested in a closure shape the IR
rejects) still get correct semantics during the long IR rollout.

**Decision: write the CPS transform once, in a shared module
`src/codegen/async-cps.ts`, that consumes either AST or IR input and emits
the segment-split + continuation-closure machinery.** Both #1042 and #1373b
call into it. **Do not duplicate the transform.** This is the single most
important coordination decision in this spec.

**2B. #1373b CPS lowering** — once #1326c Phase 1C-B (`emitStandalonePromiseThen`)
has a real body, replace the three throwing arms in `lower.ts:1773` with
calls into `async-cps.ts`. Flip the selector's `supportsAsyncIr` flag from
default-off to default-on after equivalence parity is confirmed (per the
#1373b "1373b-claim" sub-slice).

### Phase 3 — Correctness (sequential, one dev, after Phase 2)

Goal: error-propagation paths that the state machine must respect.

**3A. async.throw lowering** — `throw` inside an async function body
becomes `IrInstrAsyncThrow` in `from-ast.ts`; Phase C lowering settles the
outer `$Promise` to REJECTED. Test coverage: every throwing built-in
(`__throw_type_error`, `__throw_range_error`, etc.) inside an async body
must surface as a rejection, not a trap. The existing call-site wrap stays
as a safety net for functions still on legacy.

**3B. try/catch across await** — a `try` block that spans an `await` point
splits across two segments. The catch handler attaches to **both** the
pre-await prefix (catches synchronous throws via the existing Wasm EH) AND
the post-await continuation (catches rejection of the awaited Promise via
the `.then` onRejected slot). The #1373b file flags this as a separate
sub-slice if it becomes a long pole — **make it a separate slice**, not a
blocker for the initial CPS land.

**3C. Promise rejection vs caller `await`** — when a caller awaits a
rejecting promise, the rejection must re-throw inside the caller's
continuation (so the caller's try/catch around the await can catch it).
This is handled by giving `IrInstrAwait` an internal branch on the awaited
Promise's `state` field: REJECTED → `throw` (which the surrounding try/catch
or outer async throw handles structurally). FULFILLED → continue with value.

---

## 4. File map and conflict matrix

### 4.1 Files each issue touches

| File | #1042 | #1116 | #1151 | #1373b |
|------|:-----:|:-----:|:-----:|:------:|
| `src/codegen/expressions.ts` (or `expressions/`) | **YES** (line 973 `AwaitExpression`; line 898 `isAsyncCallExpression` wrap; line 184 `wrapAsyncReturn`) | **YES** (call dispatch for `.then`/`.catch`/`.finally`/`new Promise`/combinators) | NO (already done — `wrapAsyncCallInTryCatch` is in place) | indirect (via `async-cps.ts`) |
| `src/codegen/closures.ts` | YES (continuation closures piggyback on closure pipeline) | NO | **YES** (line 875-886 binding-pattern param override) | YES (closure-struct shape for continuations) |
| `src/codegen/function-body.ts` | YES (line 567 `isAsync` / `effectiveRetType`) | NO | NO (Option 1 declined) | YES (signature determination for IR-claimed async) |
| `src/codegen/async-scheduler.ts` | NO | NO | NO | **YES** (Phase 1C stubs) |
| `src/codegen/async-cps.ts` (NEW) | **YES** (creates) | NO | NO | **YES** (consumes) |
| `src/codegen/statements.ts` | YES (return/throw inside async) | YES (WI5 variable typing) | NO | indirect |
| `src/codegen/index.ts` | indirect | YES (WI1 `collectPromiseImports`) | NO | indirect |
| `src/ir/select.ts` | NO | NO | NO | **YES** (flip `supportsAsyncIr`) |
| `src/ir/from-ast.ts` | NO | NO | NO | **YES** (emit `IrInstrAwait` etc.) |
| `src/ir/lower.ts` | NO | NO | NO | **YES** (line 1773 throwing arms) |
| `src/ir/nodes.ts` | NO | NO | NO | already shipped (Phase B) |
| `src/runtime.ts` | NO | **YES** (WI8 `Promise_*` host handlers) | NO | NO |
| `src/codegen/class-bodies.ts` / `literals.ts` | YES (async methods parity) | NO | YES (binding-pattern param parity if regressions surface) | YES (async methods parity) |

### 4.2 Conflict warnings (read before parallelising work)

- **#1042 and #1373b both edit `src/codegen/expressions.ts` and
  `src/codegen/function-body.ts`** → sequence them. #1042 lands first; it
  introduces `async-cps.ts` and a small dispatch in `expressions.ts:973`
  that delegates to it when the function is IR-claimed. #1373b then wires
  the IR side to call the same module. **Do not start #1373b before #1042's
  `async-cps.ts` exists.**
- **#1116 WI3 (instance-method receiver guard) edits the same call
  dispatch region as #1042's `isAsyncCallExpression` block** → land #1116
  WI3 first (it's surgical and well-bounded), then #1042's larger edit.
- **#1151 binding-pattern fix and #1042 closure-pipeline edits both touch
  `closures.ts:875-1465`** → #1151 lands first; it's a one-line override
  and doesn't move surrounding lines. #1042's continuation-closure
  synthesis adds new functions elsewhere in the file.
- **#1373b depends transitively on #1326c Phase 1C-B**. If 1C-B is not
  merged when Phase 2 starts, **#1373b waits** while #1042 lands the
  legacy AST CPS transform. Do not block Phase 2 on 1C-B.

### 4.3 Single-worktree discipline

This cluster touches the closure pipeline, expression dispatcher, and IR
lowerer all at once. Per the sprint sizing note, all five issues are
`feasibility: hard` and overlap heavily. **Recommended team shape**: two
devs sharing a worktree (one drives Phase 1A+1B, the other drives Phase 2+3
once Phase 1 lands), with sequential commits in a single PR series. **Do
not dispatch five separate worktrees.** The merge cost will dwarf the
implementation cost.

---

## 5. Testing strategy

Phase 1 unblocks these test262 buckets:

- **Phase 1A (#1151 destructure-param)** — 6 async-generator destructure
  tests called out in the 2026-04-21 investigation note
  (`test/language/{expressions,statements}/async-generator/dstr/*-val-null.js`,
  `*-value-undef.js`, `*-named-ary-ptrn-elem-ary-val-null.js`) plus any
  TDZ-in-async-default-param test (count unverified but pattern is
  identical).
- **Phase 1B (#1116 Promise-API)** — 151 `built-ins/Promise` tests
  (combinators, resolution, rejection, new Promise). Issue's acceptance
  criterion: ≥100 of 210 fixed. Verify no regression in the categories the
  v1 revert hit (mostly `built-ins/Promise/all`, `language/expressions`,
  `language/module-code`).

Phase 2 unblocks:

- **Phase 2A (#1042 AST CPS)** — every test that relies on observable
  microtask suspension: `Promise.all` with mixed resolve/reject, race with
  timeouts, sequential awaits with side effects. Issue's acceptance
  criteria: simple `async f() { return await Promise.resolve(42); }`,
  try/catch around await, parallel `Promise.all`, axios real GET. Test
  count: ~210 FAIL (issue estimate).
- **Phase 2B (#1373b IR CPS)** — no new tests directly; this is a
  parity-with-Phase-2A check. The acceptance gate is **"every existing
  legacy async equivalence test passes with IR-claim flipped on"**.

Phase 3 unblocks:

- **Phase 3A (async.throw)** — language/module-code top-level-await
  rejection propagation (~17 in issue #1116 breakdown), plus any test that
  asserts `f().then(_, onRej)` reaches `onRej` for sync throws inside
  async functions.
- **Phase 3B (try/catch across await)** — try-catch-await tests (count
  unknown, but spec-required).

**Regression budget**: the v1 #1116 attempt produced 1,451 regressions on
revert and 828 new compile errors on re-land. This cluster must hold the
regression budget at ≤10 per merged PR (per the `dev-self-merge` skill's
ratio threshold). The v2 plan in #1116 specifically addresses the root
causes of v1's blowup — keep its expression-level-only discipline.

**Equivalence tests**: add `tests/async-cluster.test.ts` covering at
minimum the issue acceptance criteria from #1042, #1116, #1151. Use the
existing `tests/issue-NNN.test.ts` pattern.

---

## 6. Risk register

### 6.1 The transitional `wrapAsyncReturn` shim

`expressions.ts:184-227` wraps every async-function call result in
`Promise.resolve(...)` so it looks like a Promise to JS callers. **The
current Wasm-level return value is the unwrapped `T`** (per
`function-body.ts:567`, `effectiveRetType = unwrapPromiseType(retType)`).
The shim hides this asymmetry from JS but breaks any compiled caller that
chains `.then` on the result, because the Wasm-level value is `T`, not a
Promise. Phase 2A flips `effectiveRetType` for IR-claimed async functions
to `externref` (a real `$Promise` or host Promise). **When this flips,
`wrapAsyncReturn` must become a no-op for IR-claimed functions and stay
active for legacy functions.** The selector predicate
(`isFnIrClaimed(name)`) is the gating check. Do not delete
`wrapAsyncReturn` until 100% IR claim coverage is verified.

### 6.2 Tail-call interaction

`return await foo()` in tail position. Current codegen would like to use
`return_call`; the state-machine model cannot, because there's a settle
step between the awaited return and the outer Promise settlement.
**Resolution**: the IR lowerer detects `return await` and emits a single
`IrInstrAsyncReturn(operand: IrInstrAwait(...))` node. The Phase C lowerer
collapses the chain so the outer Promise's pending state is directly
replaced by the awaited Promise's state (Promise unwrap). Do NOT emit
`return_call` across an await — there is no caller frame to return to once
the function has suspended.

### 6.3 Generators-vs-async overlap

`async function*` (async generators) are explicitly out of scope per
#1373b. They keep the `"async-generator"` selector bucket. Watch for code
that overloads `isAsync` to include async generators — the existing
`isAsyncCallExpression` at `expressions.ts:154-172` explicitly excludes
them, and that exclusion must hold in `async-cps.ts`.

### 6.4 Host vs native Promise drift

In hybrid mode, the same `Promise<T>` TS type maps to host `externref` OR
WasmGC `$Promise` struct depending on the compile target. **Both must
be assignment-compatible at the externref boundary** — `$Promise` is
declared with `extern.convert_any` round-trips so any externref-typed
location can hold either. Risk: a function compiled in JS-host mode whose
caller is recompiled in standalone mode will see host Promise objects at
runtime in standalone mode (the JS host isn't there). The protection is
that standalone mode rejects host imports at instantiation; this is a
build-time error, not a runtime mismatch. **Document this in the migration
guide.** No code change needed.

### 6.5 v1 regression cascade

The 2026-04-05 bisect shows commit `a337c268` (v1 of #1116) introduced 828
compile errors and was eventually reverted. The root cause was variable
type overrides at hoisting cascading into unrelated code paths (generators,
mixed-type returns). **v2's discipline — never change types at
hoisting/`collectDeclarations`, only at `compileVariableStatement` —
is non-negotiable.** Every dev on this cluster must read #1116's "Why v1
failed" section before touching `index.ts` or `statements.ts`. If anyone
proposes a type override outside `compileVariableStatement`, escalate.

### 6.6 Continuation-closure live-variables analysis

The CPS pass must compute, for each await point, the set of locals live
after the await. That set becomes the continuation closure's captures.
Wrong-set → missing captures → undefined behavior or capture explosion.
**Reuse the existing IR `passes/liveness` or closures.ts live-set helper**
if one exists; if not, write the analysis once in `async-cps.ts` and
share it between the AST and IR paths.

### 6.7 Microtask drain semantics

Standalone mode needs `__drain_microtasks()` to run until the queue is
empty, including microtasks scheduled by other microtasks. The drain loop
must be a `while (head != tail)` not a single-pass. The #1326c spec calls
this out (line 130-132); do not regress it when wiring `_start` for WASI.

---

## 7. Out of scope

This cluster does **NOT** address, and any work on the following is
explicitly deferred:

- **Async iteration (`for-await-of`)** — different lowering surface; the
  6 destructure tests in Phase 1A are dstr-not-iteration tests. Real
  `for-await-of` iteration semantics tracked separately.
- **Async generators (`async function*`)** — keeps the `"async-generator"`
  selector bucket. Deferred long-term.
- **Top-level await in modules** — the test262 bucket exists (#1116 lists
  17 `language/module-code` tests) but the implementation requires module
  evaluation reordering. Capture as a follow-up issue when Phase 3 lands.
- **`await using` declarations** — ES2023 explicit-resource-management;
  separate feature, not covered.
- **Async function subclassing / `AsyncFunction` constructor** — needs
  dynamic codegen; separate feature.
- **Top-level `_start` integration for WASI standalone async** —
  scaffolded by #1326c Phase 1D, not this cluster.
- **Stack switching / JSPI** — Wasm proposal not landed in toolchains
  per #1042 issue notes.
- **Promise subclassing** — `class MyPromise extends Promise` per #1116
  edge case note. Requires prototype chain support beyond current
  capabilities.
- **Thenable coercion in standalone mode** — `Promise.resolve(thenable)`
  with user `.then` method. JS-host mode delegates to runtime; standalone
  mode would need a manual thenable check. Defer until standalone passes
  the JS-host conformance bar.

---

## 8. Quick reference for implementers

**Land order**:
1. #1151 binding-pattern null-guard (1 dev, ~30 min, one-line override in `closures.ts:875-886`)
2. #1116 WI1-WI8 (1 dev, sequential WIs, see issue's "Recommended implementation order")
3. #1042 — introduce `src/codegen/async-cps.ts`; route `AwaitExpression` through it for legacy path; flip `effectiveRetType` to externref for IR-claimed async
4. #1373b — once #1326c Phase 1C-B merges, wire `from-ast.ts` to emit IR async nodes; replace throwing arms in `lower.ts:1773` with calls into `async-cps.ts`; flip selector flag on
5. (within #1373b) Phase 3A async.throw, Phase 3B try-across-await as separate sub-slices

**Pre-merge checks** (every PR in this cluster):
- Run `tests/equivalence.test.ts` — no regressions
- Run targeted async test262: `built-ins/Promise/*`, `language/expressions/await/*`,
  `language/statements/for-await-of/*-dstr-*` if Phase 1A
- Regression ratio <10%, no single bucket >50 (`dev-self-merge` thresholds)
- If the change touches `wrapAsyncReturn` / `wrapAsyncCallInTryCatch`, manually
  verify the legacy async tests still pass before claiming IR-side flip

**Coordination contact**: this spec is the single source of truth for the
five issues. If any implementer feels the spec needs deviation, raise it
with the tech lead before diverging — incompatible state machines across
issues will produce a merge crisis worse than v1 #1116.
