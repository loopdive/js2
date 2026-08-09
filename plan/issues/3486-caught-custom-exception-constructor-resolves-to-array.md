---
id: 3486
title: "Host: caught custom-exception instance's .constructor resolves to Array, not its real constructor"
status: done
completed: 2026-07-25
assignee: ttraenkler/opus-3486
sprint: 77
created: 2026-07-20
updated: 2026-07-30
priority: high
horizon: l
feasibility: hard
task_type: bug
area: codegen
language_feature: error-constructors, exceptions
es_edition: multi
goal: test262-conformance
related: [3429, 3430, 3628, 3614, 3617, 3618, 2666, 2836, 1712, 1057]
origin: "Found while implementing #3429 (assert.throws expected-constructor name-mangling fix) — isolated repro traced to a separate, deeper bug unrelated to the #3429 fix."
# Both defects are IN-PLACE corrections to arms that already live in these two
# files, and neither is separable: (1) the vacuous vec test is one condition
# inside `extern_get`'s existing `constructor` arm in runtime.ts, sitting between
# the sidecar/`__sget_` fallbacks and the `prototype` vivify arm — moving it out
# would split one key's resolution across two modules; (2) the registration
# operand is emitted in the synthesized ctor's PROLOGUE in new-super.ts, which is
# where the #1712 registration already lives and the only point where `selfLocal`
# and the ctor's own FunctionContext are in scope. Net +103 lines across both, of
# which ~75 are the comments recording the disproven hypothesis, the vacuity
# proof, and the raw-struct-vs-wrapper measurement.
loc-budget-allow:
  - src/runtime.ts
  - src/codegen/expressions/new-super.ts
# The codegen half WAS extracted rather than allowed: the prologue block now
# lives in `emitCtorPrologueFnctorRegistration`, sibling of the existing
# `emitCallSiteFnctorRegistration`, which took `compileNewFunctionDeclaration`
# back under the 300-LOC threshold. Only `resolveImport` needs an allowance —
# it is a 7,142-line import-name dispatch switch whose `constructor` arm is the
# defect site; splitting it is #3399's job, not this bug fix's, and the +44 is
# almost entirely the comment recording the vacuity proof.
func-budget-allow:
  - src/runtime.ts::resolveImport
---

# #3486 — caught custom-exception `.constructor` resolves to `Array`, not the real constructor

> ## HEADLINE — 28 fixed / 0 regressed; ES3 slice is 11 of 41, NOT 41
>
> The pre-fix attribution in this file (and in #3628) said "expect the fix to
> flip all 41 at once." **That was wrong, and it is corrected rather than
> quietly dropped.** Measured: **11**. The other 30 carry a second, independent
> blocker in the same files → routed to **#2666**.
>
> This is the **fourth** independent confirmation on 2026-07-25 that **a cluster
> sharing one root cause is a population, not a forecast** — alongside a
> 627-test cluster that yielded 14 %, a "pervasive" bug that was 34 files, and a
> trap census off by 280. The common failure mode is identical every time:
> tests were grouped by a shared _symptom_ (here, one error message), and a
> shared symptom does not imply a single blocker. A test file can hold two
> independent failures; fixing one just reveals the next.
>
> The gross result is nonetheless real and larger than the ES3 slice:
> **28 tests fixed, 0 regressed**, spanning eight top-level areas well beyond
> ≤ES3. Report the two numbers separately; neither buries the other.

## Problem

Any user-defined function used as a constructor (`function MyError(msg) {
this.message = msg; }`), when instantiated with `new`, thrown, and caught on
the JS-host side, presents `.constructor` as a function whose `.name` is
`"Array"` — not the real declaring function. This is unrelated to the
`wasmClosureDynamicBridge` argument-identity bug fixed in #3429 (which is
about the _expected_-constructor argument passed _into_ a host-delegated
call); this bug is about the _actual thrown value's_ constructor identity
once it round-trips through a `try`/`catch` on the host side.

## Isolated repro (zero interaction with #3429's fix — pure try/catch)

```js
function MyError(message) {
  this.message = message;
}
var caught;
try {
  throw new MyError("boom");
} catch (e) {
  caught = e;
}
caught.constructor.name; // === "Array" (WRONG — should be "MyError")
caught.constructor === MyError; // === false (WRONG — should be true)
```

Confirmed via `runTest262File` (host lane): `typeof caught.constructor ===
"function"` (so SOME function is resolved), but it is not `MyError`, and its
`.name` is literally `"Array"`.

## Impact

Potentially high — any test262 test that:

- catches a custom/local error constructor instance and reads
  `.constructor`/`.constructor.name`, or
- uses the extremely common test262 idiom `assert.throws(MyError, fn)` /
  `assert.throws(Test262Error, fn)` (constructor-identity check inside
  `test262/harness/assert.js`'s `assert.throws`),

will still fail even after #3429's expected-constructor-name fix, just with a
different (correct-shaped) message: `"Expected a MyError but got a different
error constructor with the same name"` (when actualName happens to coincide)
or `"Expected a MyError but got a Array"` (the common case, since the actual
resolved name is unconditionally "Array").

This is likely the dominant reason #3429's practical flip count (tests that
go from FAIL to PASS) is much smaller than the raw 544-record count it
originally targeted — most of those records use a custom local error
constructor and will still fail here, just reclassified with the corrected
(non-bridge) constructor name in the message.

## Root cause — PROVED 2026-07-25 (the hypothesis below it was WRONG)

**The exception path is not involved at all.** The first probe run disproved
the recorded hypothesis: a plain `var inst = new MyError("x")` that is _never
thrown_ reports `inst.constructor.name === "Array"` identically. `throw` /
`catch` / exception marshaling play no part. This is the ORDINARY property-read
path on a fnctor instance, and it is **two independent defects stacked**:

### (1) The vec discriminator in `extern_get`'s `constructor` arm was VACUOUS

`src/runtime.ts`, the `#1057` arm of the `extern_get` intent handler, answered
the `constructor` key like this:

```ts
const len = vecLen(obj);
if (typeof len === "number") return globalSandbox?.Array ?? Array;
```

Its comment asserted "`__vec_len` … returns a number for vecs and **throws** for
non-vecs". That premise is false. `__vec_len` is a `ref.test`/`ref.cast`
dispatch chain whose **not-a-vec default is `i32.const 0`** (see
`src/codegen/vec-access-exports.ts`) — it returns `0`, it does not throw. And
`typeof 0 === "number"`. So the test was **vacuously true for every WasmGC
struct that reached the arm**, and `.constructor` unconditionally answered
`Array`: for fnctor instances, for plain object structs, for everything.

This exact vacuity is documented elsewhere in the tree — `#2836` replaced it
with the **positive `__is_vec` discriminator** at seven other `__vec_len` call
sites (`_convertIterableForHost`, `__make_iterable`'s `convertToJS`, and five
more). The `.constructor` arm was simply missed by that sweep.

### A fix applied everywhere-but-one is its own hazard class — TWO further sites found

A migration with no exhaustiveness check leaves survivors, and "seven of eight"
is invisible precisely because the eighth still _looks_ guarded. Auditing every
`__vec_len` mention in `runtime.ts` for the defective **discriminator** shape
(`typeof len === "number"` / `len >= 0` used to DECIDE vec-ness, as opposed to a
length read after vec-ness is already established) found the `.constructor` arm
fixed here **plus two more survivors**:

| site                                         | shape                                 | status            |
| -------------------------------------------- | ------------------------------------- | ----------------- |
| `extern_get`'s `constructor` arm (~14015)    | `typeof len === "number"`             | **fixed here**    |
| `_liveIsArray` (~3080)                       | `typeof len === "number" && len >= 0` | **still vacuous** |
| `looksMarshalable` in `wrapExports` (~14915) | `typeof n === "number" && n >= 0`     | **still vacuous** |

Both survivors are _partially_ masked by a preceding filter — `_liveIsArray`
first rejects anything with named struct fields, and `looksMarshalable` first
rejects closures and accepts named structs — which is why neither has produced
an obvious bug. But the guard itself still never guards: any WasmGC struct that
slips past the preceding filter is reported as an array/marshalable.

**Deliberately NOT fixed here**: different surface (live-array probing and
export marshaling, not `.constructor`), and — the discipline this issue's own
measurement exists to enforce — **unmeasured**. Neither is asserted to be a live
bug; they are asserted to be the same _shape_, which is what warrants a
measured follow-up rather than a speculative fix bundled into this PR. One more
`__vec_len` site (~12228) uses the identical raw call but is genuinely correct:
it explicitly documents the `0` default and discriminates with `len > 0` plus a
`Symbol.iterator` probe.

Instrumentation that proved it: wrapping every host import showed exactly
`__extern_get(<struct>, "constructor") -> fn(Array)`, and `13986` is the only
line in `runtime.ts` that ever answers `Array` for this key.

### (2) With (1) fixed, the answer was `undefined` — the #1712 link never existed

`_fnctorInstanceCtor` (the instance → ctor-closure WeakMap) is populated by the
`__register_fnctor_instance` import, emitted in the synthesized ctor's prologue
— but **only when a closure global for the ctor already exists at the moment
the ctor is synthesized**:

```ts
const ctorGlobalIdx = ctx.moduleGlobals.get(funcName) ?? ctx.funcClosureGlobals.get(funcName);
if (ctorGlobalIdx !== undefined) {
  /* emit registration */
}
```

Both sources are created **lazily, by an earlier identifier-as-VALUE read**. In
the shape test262 actually uses,

```js
function DummyError() {}
var prop = function () {
  throw new DummyError();
};
assert.throws(DummyError, function () {
  base[prop()] *= expr();
});
```

the `new DummyError()` inside the callback compiles **before** the `DummyError`
argument does, so no global existed, the gate missed — and because the
synthesized ctor is built exactly once and cached in `funcConstructorMap`, the
link was **permanently** absent. Measured directly: the import was not even
present in the module (`register_fnctor IMPORTED: false`).

## Fix

Two changes, one per defect:

1. **`src/runtime.ts`** — gate the `Array` answer on the positive `__is_vec`
   discriminator (the #2836 pattern), and add a fnctor-instance arm ahead of it
   that answers `.constructor` from `_fnctorInstanceCtor`.

2. **`src/codegen/expressions/new-super.ts`** — emit the identifier's own
   `emitCachedFuncClosureAccess` for the registration operand instead of
   requiring a pre-existing global. Same helper and same `constructible` flag
   `identifiers.ts` uses for a bare `DummyError` mention (that flag is
   unconditionally `false` in the host lane — `isOrdinaryFunctionDecl` is gated
   on `noJsHost`), so the registered value is reference-identical to the one
   every later mention yields. This removes the compile-order dependency **and**
   the runtime-null one (the lazy cache is evaluated here, so the value is never
   the `null` the global holds before its first value read).

### Why the RAW closure struct, not a `_wrapCallableForHost` wrapper

Returning the identity-stable host wrapper was tried first and is **not**
sufficient. Compiled `===` on two externrefs reaches `__host_eq` in some shapes
(which unwraps a wrapper via `_wasmClosureWrapperTargets`) but `ref.eq` in
others. Measured with the wrapper: the through-a-parameter comparison passed
(`1`) while the direct `caught.constructor === MyError` still returned `0`.
The raw struct satisfies both, and `typeof` still reports `"function"`.

### Relationship to #3614's mechanism — the lanes do NOT share one

#3614 (standalone) answers from the `__fn_closure_<Name>` global **read-only**,
deliberately never materialising it, because materialising at _finalize_ would
mint a `ref.func` trampoline late. That constraint does not apply here: the host
fix materialises the singleton during ordinary body compilation of the ctor, not
at finalize, so it can be strictly stronger than #3614's — no "declines when the
identifier was never evaluated as a value" caveat. The substrates differ as
#3617 predicted (host: the `_fnctorInstanceCtor` WeakMap; standalone: WasmGC
globals/fields), so the two remain separate mechanisms answering the same
question.

## Acceptance criteria

- [x] The isolated repro passes: `caught.constructor === MyError` is `true`.
- [ ] `caught.constructor.name === "MyError"` — **NOT met, and deliberately
      out of scope.** Reading `.name` DYNAMICALLY off a compiled closure struct
      is a pre-existing host-lane gap independent of this issue: measured on
      unmodified `main`, a bare `MyError.name` folds statically and yields
      `"MyError"`, but `f(MyError)` → `c.name` through a parameter already
      yields `undefined`. This is the host-lane analogue of **#3618** (the same
      gap in standalone). `.constructor.name` therefore moves from a WRONG
      `"Array"` to a WRONG `undefined`; it flips no verdicts either way, and the
      41-test cluster this issue targets is gated on the IDENTITY check
      (`thrown.constructor !== expectedErrorConstructor`), not on the name — the
      name is only read to compose the failure MESSAGE. Widening scope to stamp
      function names onto closure sidecars is a separate change.
- [x] `assert.throws(MyError, () => { throw new MyError(); })` (test262-harness
      style) passes end-to-end — verified in the exact `assert.throws` shape
      (comparison through a function parameter).
- [x] Genuine, not vacuous: the same comparison against a DIFFERENT compiled
      constructor stays `false`.
- [x] No regression to `vec.constructor === Array` (split / map / literal).
- [x] No regression to `assert.throws(TypeError, ...)` / native-builtin
      constructor identity checks.

## Measured result (2026-07-25) — report gross fixed and regressions separately

Measured on the CI-equivalent path (`assembleOriginalHarness` →
`CompilerPool(4, "unified")` → `scripts/test262-worker.mjs`), host `gc` lane,
before vs. after, over the **83** currently-failing tests whose recorded baseline
message matches this defect's signature (`… but got a Array`) — a
force-refreshed baseline (`fetch-baseline-jsonl.mjs --force`, 47,850 entries):

| outcome                   |  count |
| ------------------------- | -----: |
| **fixed** (fail→pass)     | **28** |
| **regressed** (pass→fail) |  **0** |
| still failing             |     55 |

**≤ES3 metadata bucket: 11 of the 41, not 41.** The 41 shared one _message_, but
only 11 were blocked _solely_ by this defect. Each of these files contains TWO
`assert.throws` calls; this issue was the first one's blocker, and the remaining
30 now fail on the SECOND with `Expected a TypeError but got a Test262Error` —
a genuinely different root cause (`RequireObjectCoercible(base)` must precede
`ToPropertyKey(key)` in the read-modify-write member paths). That is **#2666**,
which now carries the measured 30-test attribution. So ≤ES3 goes 230/273 →
**241/273**, and #2666 is what closes the rest.

This is the "a cluster sharing one root cause is a population, not a forecast"
lesson landing again: the pre-fix estimate was 41, the measured flip is 11.

### Blast radius beyond ES3

The 28 fixes span well past ≤ES3 — `built-ins/RegExp/prototype`,
`built-ins/String/prototype`, `built-ins/Iterator`, `built-ins/Array/prototype`,
`built-ins/TypedArray/prototype`, `built-ins/GeneratorPrototype`,
`language/expressions/assignment`, `language/expressions/logical-assignment`,
`language/statements/for-of`. The **83** message-signature candidates are a
LOWER bound on reach, not an upper one: a test that reads `.constructor` on a
fnctor instance without routing through `assert.throws` produces no
`… but got a Array` message and so is not in the candidate set at all.

### Regression evidence

- `tests/issue-3486-fnctor-constructor-identity.test.ts` — 6 cases, all on
  observable values; **5 of 6 verified RED against unmodified main** (the 6th is
  the vec-preservation control, which must stay green both ways by design).
- 0 pass→fail across the 83-test candidate run.
- **No large local sweep — deliberately, and this is NOT an evidence gap.** A
  536-test sample of currently-passing tests on the widened surface was
  attempted and returned **all `compile_timeout (30s)`** at box load average
  14–20 (other agents active). That measures the container, not the change, so
  it was discarded rather than reported, and NOT re-run: repeating it costs an
  hour and reproduces the same garbage. **The `merge_group` re-validation is the
  regression measurement** — it runs the full test262 matrix on the merged state,
  which is exactly the gate PR-level checks cannot provide (PR-level
  `check for test262 regressions` and `merge shard reports` are designed green
  no-ops). The 83-test CI-equivalent run plus the adjacent suites is the
  appropriate PR-level evidence.
- `tests/equivalence/**`, plus the fnctor/host-import gate suites
  (`host-import-allowlist-{budget,gate}`, `issue-2608`, `issue-2660-*`,
  `issue-2674`, `issue-3123`). The two failures observed there
  (`issue-3123` @@iterator, `issue-2660-s3` struct-binding guard) were
  **confirmed pre-existing on clean `upstream/main`**.

### Known behaviour widening (intentional, recorded not glossed)

The codegen half makes the #1712 instance → ctor link fire in modules where a
compile-order accident previously suppressed it. Consequence: instances now
resolve INHERITED members through `F.prototype` in those modules where they
previously missed (`F.prototype.m = fn; new F().m()`). That is #1712's own
stated intent and the spec-correct direction (§10.2.5
OrdinaryCreateFromConstructor); it is pinned by a dedicated case in the
regression test rather than left implicit. Own fields and `Object.keys` are
byte-for-byte unchanged — the link adds no enumerable own property.

## Cross-reference

- #3429 (assert.throws expected-constructor name-mangling — the sibling bug
  on the OTHER side of the same `assert.throws` identity check; already
  fixed independently).
- #3430 (integrity-level TypeError-not-thrown triage umbrella) — same
  "oracle v8 newly honest" origin wave, same host-conformance area, may share
  a similar host-mirror-defaulting root cause worth checking together.

## ES3 edition impact — pre-fix estimate 2026-07-25 (priority raised medium → high)

> **Superseded by measurement.** The "95 % of the remaining ≤ES3 gap" figure
> below is the PRE-FIX attribution by message signature. The measured flip is
> **11 of the 41**, with the other 30 blocked by a second, independent defect
> (#2666). See "Measured result" above. Retained here because the attribution
> METHOD was sound and reproduces the published editions figure exactly — what
> it could not see is that a file can carry two independent blockers.

It contributes to **#3628 (close the ≤ES3 edition)**, which is the edition
closest to complete. Note #3628's own correction: `classifyEdition` assigns
edition 0 only as a frontmatter FALL-THROUGH, so ES3 features carrying modern
`esid:`/`es5id:` metadata (`eval`, `with`, the `Function` constructor) sort into
other buckets. Closing this bucket is "the ≤ES3 metadata bucket is closed",
never "ES3 is complete".

Host (`gc`) lane, fresh baseline, classified with the exact `classifyEdition`
rules from `scripts/generate-editions.ts` (reproduces the published editions
figure exactly — 273 scored / 43 failing, so the attribution is validated):

| ≤ES3                          |        count |
| ----------------------------- | -----------: |
| scored                        |          273 |
| passing                       | 230 (84.2 %) |
| failing                       |           43 |
| compile errors                |        **0** |
| **failing due to THIS issue** |       **41** |

The 41 are 33 × `language/expressions/compound-assignment/S11.13.2_A7.*` and
8 × prefix/postfix `++`/`--` (`S11.4.4_A6`, `S11.4.5_A6`, `S11.3.1_A6`,
`S11.3.2_A6`). All fail with the identical message:

```
Expected a DummyError but got a Array
```

Representative source — a left-to-right evaluation-order test whose property key
throws a user-defined error:

```js
function DummyError() {}
assert.throws(DummyError, function () {
  var base = null;
  var prop = function () {
    throw new DummyError();
  };
  base[prop()] *= expr();
});
```

**The correct exception is thrown; the harness cannot identify it.** So the
evaluation-order semantics these tests actually target are very likely already
correct, and are being masked. Expect the fix to flip all 41 at once — but
**measure rather than assume**, since a cluster sharing one root cause is a
population, not a forecast (proven repeatedly on 2026-07-25).

### Cross-lane note — a fix for the sibling defect already landed

**#3614** is the standalone-lane twin: `Test262Error`'s `.constructor` read
`undefined` there, for the same structural reason, and the harness's
`thrown.constructor !== expectedErrorConstructor` check therefore rejected
correct throws (up to 854 tests; fixed 2026-07-25, PR #3607).

Its remedy is worth reading before starting here: answer `.constructor` with the
same `__fn_closure_<Name>` global the bare identifier resolves to, so `===`
holds by `ref.eq` — and **only read** that global, never materialise it, which
avoids minting a `ref.func` trampoline at finalize (the late-funcidx-shift
hazard). Whether the host lane can use the same mechanism is the first question
to answer.

**#3617** tracks the standalone residual (non-`Test262Error` fnctor instances)
and is described there as the counterpart of this issue — the two are the same
defect on opposite lanes and should be kept in sync.

### Scope beyond ES3

Any test using a **custom error constructor** with `assert.throws` hits this,
so the true blast radius is larger than the ES3 number. Quantify it across all
editions when fixing, and report the ES3 subset separately so #3628 can be
closed against a measured figure.
