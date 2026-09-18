---
id: 6502
title: "A compiled closure called across the linked seam returns null — `__closure_arity` knows it, the `__call_fn_N` ladder does not"
status: ready
sprint: current
created: 2026-09-17
updated: 2026-09-17
priority: high
horizon: m
feasibility: hard
task_type: bug
area: codegen
language_feature: linked-modules
goal: test262-conformance
related: [6492, 6491, 3451, 5225, 4648]
---

# #6502 — a cross-module closure call answers `null`

## Symptom

Three `language/expressions/await/**` rows fail on the linked lane only, all with
the same host error:

```
Test262:AsyncTestFailure:TypeError: Cannot read properties of null (reading 'then')
```

- `await-awaits-thenable-not-callable.js`
- `await-throws-rejections.js`
- `syntax-await-has-UnaryExpression.js`

All three are `asyncTest(foo)` over an `async function foo` **declaration**. The
`.then` being read is `asyncHelpers.js`'s own
`testFunc().then(onFulfilled, onRejected)`, so `foo()` — called by the
provider-side harness — returned **`null`** instead of a promise.

## Measured (2026-09-17, real runner, `TEST262_ORACLE_MODE=linked`)

Instrumenting the runtime on `await-awaits-thenable-not-callable.js`:

```
[DBG prom]      Promise_new_pending   -> object
[DBG prom]      Promise_settle_resolve -> undefined
[DBG hostcall]  wasmClosureDynamicBridge nargs=1 result=null out=null
[DBG dispatch]  args=1 dispatchArity=1 declared=1 maxArity=4 -> NULL
```

Three facts fall out, and the third is the defect:

1. The consumer's async machinery works — it mints a pending promise and settles
   it. Nothing is wrong inside the module.
2. The failing call is dispatched at the closure's **own declared arity**
   (`declared=1`, `dispatchArity=1`), so this is **not** the under-application
   hazard #6491 fixed in the same bridge, nor the #2664 method-arity omission.
3. `__closure_arity` **recognises** the closure (answers 1) while
   `__call_fn_1`'s `ref.test` ladder **does not match it** and the wasm arm
   falls through to `ref.null.extern` — which surfaces in JS as `null`.

So two exports of the same module disagree about the same closure: one can name
its arity, the other has no dispatch arm for it. A closure that is only ever
called *in-module* needs no arm — the call is compiled directly — so the gap is
invisible until a **different module** calls it, which is exactly the #3451
linked lane (harness provider calls the test body's functions).

## Why `null` and not an error

`wasmClosureDynamicDispatch` returns whatever the ladder returns. A miss is
indistinguishable from "the function returned null", so the caller gets a
plausible value instead of a failure, and the error surfaces far away — here as
a `.then` read inside the harness. Any fix should also consider making a ladder
MISS unambiguous (trap or throw), because the silent-null shape is what made
this take a full instrumentation pass to locate.

## Fix direction (not yet implemented)

Emit a `__call_fn_N` arm for every closure that can **escape** the module —
exported, passed as a value to a host/foreign callee, or reachable from one —
rather than only for closures the module itself dispatches dynamically. The
escape set is the same one `#4648`'s async-closure wrapper reasons about.

A cheaper interim: when the ladder misses but `__closure_arity` recognised the
closure, consult the #5225 cross-module owner registry for a module whose
`__call_fn_N` does match (the `decoderFor` / `bufferDecoderFor` pattern), and
dispatch there. That only helps when some module has the arm; it does not help
when nobody emitted one.

## Acceptance criteria

- The three `await/**` rows pass on the linked lane with no honest-lane flips.
- A ladder MISS is distinguishable from a genuine `null` return.
- A test asserts a closure passed out of a module and called back at its
  declared arity runs its body (not merely that it returns non-null).

## Measured attempt (2026-09-18, round 11) — loudness alone is +9 / −4, do not ship it first

The "make a MISS loud" half of the fix direction above was implemented and
measured end to end on the linked 138-row #6492 set (baseline 44 / 138). Three
variants, all reverted:

| variant | result |
| --- | --- |
| terminal throws `__throw_type_error` instead of `ref.null.extern` (host lane only) | 44 → **49**: **+9, −4** |
| same, gated on `ref.test` of this module's base wrapper (only OUR closure shape is loud) | identical, **+9 −4** |
| same, plus a runtime peer-module re-dispatch on the miss marker (`peerDispatch`) | identical, **+9 −4** |
| loud for `__call_fn_0` only | identical, **+9 −4** |

**Gained (9)** — every `Symbol.species` / `Symbol.toStringTag` descriptor row in
the set: `{RegExp,Map,Array,Set,ArrayBuffer,Promise}/Symbol.species/*`,
`TypedArray/prototype/Symbol.toStringTag/{,BigInt/}prop-desc.js`,
`Promise/Symbol.species/prop-desc.js`. A silent miss was being read as a
legitimate descriptor value there.

**Lost (4)** — `harness/asyncHelpers-asyncTest-{func-throws-sync,
rejects-non-callable,return-not-thenable}.js` and
`harness/proxytrapshelper-default.js`. Their call sites **depend** on the null:
the runtime dispatches speculatively and reads `null` as "this value is not my
closure / there is no trap here". Made loud, `proxytrapshelper-default` reports
`trap getPrototypeOf is not a function` and two asyncHelpers rows collapse to
`Actual [] and expected [true,true,true,true,true,true]`.

Three things this rules out, each with a run behind it:

1. **`ref.test` cannot separate the two groups.** Both modules' base wrapper
   types are structurally identical, so each module's `__is_closure` claims the
   other's closures; the gate measured identically to no gate.
2. **A peer re-dispatch does not recover the 4.** Instrumented directly: for the
   failing closure **every** `__call_fn_0..4` in **both** modules answers null,
   while both modules' `__is_closure` answer 1 and both `__closure_arity` answer
   1. Nothing in the project has an arm for it — which is the arm-set gap this
   issue is about, not an ownership question.
3. **It is not an arity band.** The +9 and the −4 are both arity 0.

**Conclusion: (b) must land after (a), not before.** Closing the arm-set gap
makes the loudness free; shipping loudness first trades four rows that are green
today (three of them #6492 round 9's own gains) for nine, and leaves the real
defect in place. The +9 is, separately, evidence that the silent null is
corrupting descriptor reads elsewhere in the corpus — so (a) is worth more than
the three `await` rows it was filed for.
