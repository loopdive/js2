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

## Round 12 (2026-09-18) — step 1: the escaping closure's type is NOT IN THE CENSUS

Measured with two temporary probes, both reverted: a debug export
`__closure_type_probe(externref) -> i32` emitted under `JS2WASM_DBG_TYPEPROBE=1`
(a `ref.test` ladder over every entry of `ctx.closureInfoByTypeIdx`,
most-derived first, answering `typeIdx*1000 + paramTypes.length`), and an
`[ARMS] admit` trace inside `emitClosureCallExportN`.

### The admitted arm set (consumer module, `await-awaits-thenable-not-callable.js`)

| `__call_fn_N` | admitted `funcTypeIdx` |
| --- | --- |
| 0 | 18, 56, 58, 74 |
| 1 | 18, 43, 47, 54, 56, 58, 74 |
| 2 | 18, 37, 43, 47, 50, 52, 54, 56, 58, 63, 74 |
| 3 | 18, 37, 40, 43, 47, 50, 52, 54, 56, 58, 60, 63, 74 |
| 4 | same as 3 |

The consumer registers 31 closure types; the provider registers exactly one
(`17`, ft 18, 0 params).

### What the runtime says about the value that misses

```
[TYPEPROBE miss] args=1 arity=1 declared=1
  | mod0:type=41,nparams=3,arms=[01234]
  | mod1:type=17,nparams=0,arms=[01234]
```

Four facts, and together they identify the defect:

1. `__is_closure` answers **1** in both modules (a base-wrapper `ref.test`).
2. `__closure_arity` answers **1** — and that is a **field read**
   (`CLOSURE_ARITY_FIELD_IDX`), not a type property, so it is authoritative
   about the value: this closure really does take one argument.
3. The census probe answers **type 41, 3 params** in the consumer and **type 17,
   0 params** in the provider — two different answers for one value, neither
   consistent with (2). A `ref.test` ladder returns the first *structurally
   compatible* type it tests, so these are **structural neighbours**, not the
   value's type.
4. Exhaustive re-dispatch — **every `__call_fn_0..4` in BOTH modules**, with
   arguments padded per arity — returns `null`. Including `__call_fn_3`, which
   does admit ft 40, the func type the probe's neighbour (type 41) is
   registered under.

So the value's own struct type is **absent from `ctx.closureInfoByTypeIdx`** in
both modules. Every consumer of the census misses it; the two helpers that do
not consult the census (the base-type test and the arity FIELD read) answer
correctly. The census probe cannot name the real type for exactly the same
reason the arms cannot dispatch it — which is why its answer disagrees with the
arity field, and that disagreement is the signature to look for.

This confirms the predicted shape: a closure kind minted by an emitter path that
never registers into `closureInfoByTypeIdx` (the async-function / trampoline
family is the prime suspect — the failing rows are all `asyncTest(foo)` over an
`async function` declaration, and the module's async lowering exports `__cb_0`/
`__cb_1` continuations directly rather than through the closure registry).

### Step 2, unchanged but now targeted

Enumerate the arm set from the registry that `__is_closure` / `__closure_arity`
are built from, not from the call-site census — or register the missing kind
into `closureInfoByTypeIdx` at mint time so all five ladders see it. The next
lane should first confirm WHICH emitter mints it (instrument the closure
allocation sites for the async/trampoline path and print the struct typeIdx),
because the type is currently unnamed — the probe above can only prove it is not
in the census, never what it is.

**A runtime-only fix is ruled out** by fact 4: no module has an arm at any
arity, so no amount of owner lookup or arity retry can help. It has to be the
emitter.

## Round 13 (2026-09-18) — correction: the type IS in the census; the STRUCT and its FUNCREF disagree

Round 12's conclusion ("the struct type is absent from
`ctx.closureInfoByTypeIdx`") was drawn from a probe that laddered only over
census types, so it could not distinguish "absent" from "present but
mis-described". Widening the probe to ladder over **every struct type in the
module** (same debug export, all of `mod.types` instead of the census, most
derived first) answers **type 41 again** — the same answer as the census-only
ladder. So:

**The value's struct type is present, and it IS in the census** (type 41,
`funcTypeIdx` 40, host arity 3). Round 12's strong form is withdrawn.

What is actually inconsistent is narrower and more interesting:

| question | answer | derived from |
| --- | --- | --- |
| struct type of the value | **41** | full-type-section `ref.test` ladder |
| census entry for type 41 | ft **40**, host arity **3** | `ctx.closureInfoByTypeIdx` |
| `__closure_arity(value)` | **1** | `ref.test` chain over **FUNC** types, `closureHostArity` |
| `__call_fn_1` admits | ft 18, 43, 47, 54, 56, 58, 74 — **not 40** | `emitClosureCallExportN` |
| `__call_fn_3` admits | ft 18, 37, **40**, 43, … | same |

`__closure_arity` and the arm admission are built from the *same* helper
(`collectClosureArityEntries` calls `closureHostArity(info)`, dedups by
`funcTypeIdx`, and `ref.test`s the extracted FUNCREF exactly as the arms do), so
their disagreement is not a units mismatch. `__closure_arity` answering 1 means
the value's **funcref** matched a host-arity-1 func type, while its **struct**
is type 41, whose census entry says its funcref should be ft 40 (host arity 3).

So the struct and the funcref it carries do not agree with the registry. A
closure struct of type 41 is holding a funcref of some other signature. Every
`__call_fn_N` arm tests the self type and then `ref.test`s the extracted funcref
against that arm's `funcTypeIdx`; with the struct saying one thing and the
funcref another, the arity chosen from `__closure_arity` (1) lands in a ladder
where ft 40 is not admitted, and the arms that DO admit ft 40 (arity 3/4) fail
their funcref test.

Also measured, and NOT explained by the above — worth re-checking before
building on this: dispatching the same value through **every** `__call_fn_0..4`
in **both** modules still returns null (round 12, re-confirmed in round 13),
including arity 3 where ft 40 is admitted. If the funcref were simply a
host-arity-1 signature, one of the arity-1 arms should have matched it. Either
the per-shape funcref extraction (`buildFuncrefExtraction`, keyed on the arm's
self type) reads the wrong field for this struct's layout, or the funcref slot
is null. **That is the next probe**: export the extracted funcref's own type
(and null-ness) for the value, rather than inferring it from `__closure_arity`.

Ruled out this round: a census **overwrite** at the two
`createSignatureWrapperType` writers in `closures/funcref-wrapper-types.ts` —
instrumented for a later `set` replacing an entry with a different
`funcTypeIdx`, zero hits on the repro.

### Consequence for step 2

The fix is still emitter-side, but it is **not** "register a missing kind". It
is: make the struct type, its census entry and the funcref actually stored in it
agree — or make the arms dispatch on the funcref's own type rather than on a
struct-type-derived expectation. Until the funcref's real type is named (next
probe above), do not start the edit: this round already withdrew one conclusion
that was drawn from a probe too narrow to see the alternative.

## Round 14 (2026-09-18) — the probe answers state (ii), and the null is a VOID RETURN

The two debug exports asked for — deepest matching STRUCT type over the whole
type section, and the extracted funcref's own FUNC type plus null-ness, the
extraction copied from `buildFuncrefExtraction`'s root-collapse arm — answer:

```
[TYPEPROBE] root: 36 | 36:__fn_wrap_0_struct(super=-1,CENSUS ft=37,np=2)
                     | 39:__fn_wrap_3_struct(super=36,CENSUS ft=40,np=3)
                     | 40:func(ref,externref,externref,externref)->externref
                     | 41:__constructible_fn_wrap_4_struct(super=39,CENSUS ft=40,np=3)
                     | 42:__fn_wrap_6_struct(super=36,CENSUS ft=43,np=1)
                     | 43:func(ref,externref)->            <-- NO RESULT
[TYPEPROBE miss] args=1 arity=1 declared=1
   | mod0:struct=41,funcref=43 | mod1:struct=17,funcref=-1
```

**State (ii), with a twist that changes the diagnosis.** The funcref is not
null, and it is **ft 43**, not the ft 40 the census records for struct type 41.
`__closure_arity` answering 1 is therefore *correct* — it reads the funcref, and
ft 43 takes one argument.

The twist: **ft 43 returns NOTHING.** `func(ref, externref) -> ` is a void
closure. A void arm cannot answer the ABI's externref with a value, so
`buildClosureResultBoxing` gives it the canonical `undefined` — and, when
`__get_undefined` is not registered, its documented fallback
`ref.null.extern`, i.e. JS **`null`**.

So the `null` this issue was opened about is very likely **not a dispatch miss
at all**: the arm matched, the closure ran, and a void return surfaced as null.
That also explains, for the first time, why every `__call_fn_0..4` in both
modules "missed" (a void function answers nothing at any arity) and why round
11's loud terminal broke exactly four rows (their nulls were legitimate void
returns, not misses).

### Measured fix attempt — and it reproduces round 11's +9 / −4 exactly

Nothing in `emitClosureCallExportN` registers `__get_undefined`, so a unit that
never needs one on its own — the linked CONSUMER being the ordinary case, its
body a bare test fragment — emits `ref.null.extern` for every void closure. This
is the #6419 fallback in a second emitter (the first was `coerceType`'s f64 arm,
#6492 round 6). Registering the producer with this emitter's other late imports:

| | result |
| --- | --- |
| `ensureCanonicalUndefinedExtern(ctx, null)` in `emitClosureCallExportN` | 44 → **49: +9, −4** |

**The same nine gains and the same four losses as round 11's loud terminal**, a
completely different change. Same errors, verbatim
(`trap getPrototypeOf is not a function`; `asyncTest called $DONE with a
synchronously thrown error`; two rows collapsing to `Actual []`). Two
independent changes that both stop a void closure answering `null` produce an
identical delta, which says the +9 and the −4 share one cause: **four call sites
read a void closure's `null` as load-bearing**, and nine read it as a corrupt
value.

Not shipped: the trade is the same one refused in round 11, and the correct
change (a void closure MUST answer `undefined` — `buildClosureResultBoxing`'s
own comment says so) should not regress four rows. The next lane's target is
therefore narrow and concrete: **find the four readers.** Instrument the runtime
for a void-closure result being compared against `null`
(`_wrapWasmClosureUnknownArity`'s callers, the proxy trap reader, the
`asyncTest`/`$DONE` path) on `harness/proxytrapshelper-default.js` — one row,
one call site, and the whole +9 lands for free.

### Revised framing for this issue

The title's "returns null" is right; "dispatch" is not. The defect is that the
host bridge cannot distinguish three states that all arrive as `null`:

1. a ladder MISS,
2. a VOID closure's return,
3. a closure that genuinely returned `null`.

Round 11 tried to separate (1); this round shows (2) is the more common one in
this corpus. Separating them is still the fix — but by giving (2) the
`undefined` it is owed, then (1) the loud terminal, and only after the four
readers of (2)'s null are corrected.
