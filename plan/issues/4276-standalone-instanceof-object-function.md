---
id: 4276
title: "fix(codegen): `x instanceof Object` / `instanceof Function` answer a hard `false` in standalone"
status: in-progress
sprint: current
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
goal: standalone-gap
assignee: ttraenkler/senior-dev
created: 2026-08-09
related: [2916, 3962, 1896, 2175, 4120, 1472]
# +12 lines on identifiers.ts, all of it at the DISPATCH site: a five-line
# `isObjectFamilyCtorName` branch, its import, and a three-line comment on the
# `Boolean` case recording why the wrapper arm was reverted. Every line of new
# logic (both classifier arms, the null guard, the symbol subtraction, the
# safety argument, the reverted-arm record) lives in the NEW subsystem module
# `src/codegen/native-object-family-instanceof.ts`. Choosing which lowering a
# builtin RHS takes is by definition a dispatch-site decision.
# The 2026-08-12 wrapper follow-up likewise keeps its semantic predicate in the
# NEW `standalone-wrapper-instanceof.ts` subsystem. The additional allowances
# below are the narrow selector, lowering, and allocator-owned resolver seams
# required to make the operation genuinely IR-emitted rather than legacy-only.
loc-budget-allow:
  - src/codegen/expressions/identifiers.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/select.ts
func-budget-allow:
  - src/ir/integration.ts::makeFromAstResolver
  - src/ir/select.ts::dynamicUsesAreMoveOnly
  - src/ir/select.ts::scanExpr
  - src/ir/select.ts::isPhase1Expr
---

# #4276 — host-free `instanceof Object` / `instanceof Function` in standalone

## Problem

Under `--target standalone` / `--target wasi` (`noJsHost`), a builtin RHS is
answered by `nativeBuiltinInstanceOfTypeIdxs` (#2916), which ORs `ref.test` over
the backing-struct types that builtin can produce. Two RHS names cannot be
answered that way, and both were silently wrong rather than refused:

- **`Object`** — #2916 returns `undefined` for it, so the dispatch site falls
  through to a conservative `i32.const 0`. Every `x instanceof Object` in a
  standalone module answered **`false`**, for every `x`.
- **`Function`** — the list is `closureRootTypeIdxsFor(ctx)`, a **snapshot taken
  at expression-lowering time**. Closures enter `ctx.closureInfoByTypeIdx` as
  their bodies compile, so a site lowered before the relevant closure is
  registered gets `[]` — which the #2916 return contract reads as "no value can
  be an instance ⇒ definite `0`". The answer was position-dependent: the same
  `f instanceof Function` was `true` or `false` depending on where in the module
  it appeared.

The statically-typed LHS cases were masked: `tryStaticInstanceOf` folds
`({}) instanceof Object` to `true` before the builtin dispatch is consulted. So
the bug only surfaces when the LHS is dynamic (`any`) — which is the normal case
in test262, and is why adding a `typeof object` use ahead of the `instanceof`
flips `S11.1.5_A1.1` CHECK#2 from pass to fail.

## Population — MEASURED, and much smaller than the estimate it came from

This was dispatched on an estimate of **~105** suite-wide tests. That figure does
not survive measurement; the honest number is **an ES5-scope bound of 22 and a
causal count of 13**.

Enumeration (`instanceof {Object,String,Number,Boolean,Function}`, textual, over
the whole corpus — complete for direct use; only `harness/deepEqual.js` uses any
of these forms indirectly, and no ≤ES5 test includes it):

| scope | files mentioning a form | failing on the 2026-08-09 standalone baseline |
| --- | ---: | ---: |
| ≤ES5 (`es5id:`, denominator 8,115) | **40** | **22** (21 `fail` + 1 `compile_error`) |
| whole corpus | 148 | 101 (92 `fail` + 9 `compile_error`) |

Of the 22 ≤ES5 failures, **9 fail for reasons that have nothing to do with
`instanceof`** and would still fail with a perfect implementation:

- 5 × `built-ins/Function/S15.3.*` — the dynamic `Function(…)` constructor
  (runtime-eval), which merely *mentions* `instanceof Function` in a later check;
- 3 × `language/expressions/object/S11.1.5_A1.{2,3,4}` — CHECK#3
  (`object.toString === Object.prototype.toString`) is `undefined`;
- 1 × `S11.8.6_A7_T3` — `new Function`, same runtime-eval gap.

`S11.1.5_A1.1` **is** an instanceof failure (CHECK#2) but is blocked behind the
same CHECK#3 defect as its three siblings, so fixing instanceof moves its
failure from #2 to #3 and flips nothing. That leaves **13 causally-instanceof
≤ES5 tests**, of which this change lands **5** (see Measurement).

The all-scope 101 is where a "~105" signature match plausibly comes from. It is
not a lever: the largest sub-bucket is `Array.prototype.<m> is not yet callable
as a value in --target standalone` (~20 rows) — files that mention
`instanceof Boolean` in an unrelated assertion.

## Root causes (evidence)

Both reproduced through the `runTest262File(…, "standalone")` seam, sequentially,
Node 25, runtime-eval tier REFUSAL, on `upstream/main` @ `7a8972f3a`:

| probe | base | fixed |
| --- | --- | --- |
| `var object = {}; typeof object; object instanceof Object` | **fail** | pass |
| `Object.create({}, undefined) instanceof Object` | **fail** | pass |
| `Object.getOwnPropertyDescriptor(o,"a") instanceof Object` | **fail** | pass |
| `function f(){}; f instanceof Function` | **fail** | pass |
| `this instanceof Object` inside an accessor invoked by `Object.create` | **fail** | pass |
| `null instanceof Object`, `1 instanceof Object`, `"s" instanceof String`, `({}) instanceof String`, `({}) instanceof Function`, `new Number(1) instanceof String` | pass | pass |

The negatives matter: a naive always-true predicate passes every positive above
and fails all six.

## Implementation

`src/codegen/native-object-family-instanceof.ts` (new). Over the value
representations this backend can produce, `x instanceof Object` is exactly "`x`
is neither null/undefined nor a primitive" — i.e. `typeof x === "object"
(x !== null) || typeof x === "function"`. Both halves already exist as
standalone natives with **complete, finalize-corrected** classifiers
(`__typeof_object` / `__typeof_function`, `registry/imports.ts` +
`typeof-natives-finalize.ts`). Reusing them:

- fixes the snapshot hazard for free — `fillStandaloneTypeofClosureArms`
  (#1896/#2175/#4120) rewrites those helper BODIES at finalize, after every
  closure is registered, so a `call` is position-independent where a `ref.test`
  list is not;
- keeps ONE classifier for the backend instead of a second, silently-diverging
  copy.

`ensureLateImport` routes both names through `addUnionImportsViaRegistry` under
`noJsHost`, registering them as DEFINED functions — no `env::` import, so the
module stays host-free and no index shift is required (#1471).

Extras the plain typeof union gets wrong, handled explicitly:

- a **null externref** must answer `0`; under the #2106-S1 regime
  `__typeof_object(null)` is `1` (`typeof null === "object"`), so the null test
  comes first and separately;
- a **symbol** is a primitive but `__typeof_object` does not subtract the
  `$Symbol` carrier, so we do (`ref.test ctx.symbolTypeIdx`, when registered).

For `Function` the caller passes the old membership list in and the emitter ORs
it, so the emitted predicate is pointwise **≥** the one it replaces.

### Deliberately NOT done (mechanism named)

1. **Null-prototype objects.** `Object.create(null) instanceof Object` is `false`
   per §7.3.20 but `true` under this predicate. The correct answer needs the
   prototype-chain walk against a runtime handle on `Object.prototype`, which the
   standalone object model does not expose — the same gap
   `native-ordinary-instanceof.ts` records for `FACTORY.prototype`. No test in the
   148-file candidate set asserts it (verified by the A/B: zero regressions).
2. **Force-registering the wrapper structs.** `Number`/`String`/`Boolean` have the
   identical snapshot hazard (`ctx.wrapper*TypeIdx` is `-1` until
   `ensureWrapperTypes` runs). Implemented, measured, **reverted**: over the ≤ES5
   population it flipped **0 → pass and 1 → fail**. The failure is
   `built-ins/Function/prototype/call/15.3.4.4-3-s.js`
   (`onlyStrict`, `fun.call(false)` with `return this instanceof Boolean`). The
   registration does not cause it — it *unmasks* a separate defect:
   `Function.prototype.call` boxes a primitive `this` into a `$WrapperBoolean`
   even in strict mode, where §10.4.3 passes the primitive through. With the
   wrapper type unregistered the membership list was empty, so the wrong `true`
   could not be observed. Re-land with the strict-mode this-binding fix, never
   before.
3. **The `this instanceof <wrapper>` accessor family** (`Object/create/15.2.3.5-4-{5,7,8,9}`,
   `Object/defineProperties/15.2.3.7-2-{4,6,8,9}` — 8 tests, the single largest
   remaining ≤ES5 sub-bucket). The accessor IS invoked (probe: a getter setting
   `result = true` passes) and `this instanceof Object` now passes, so the
   residue is the wrapper/`Function` RHS specifically — i.e. blocked on (2) plus
   the `this`-binding representation of the `props` receiver.
4. **`e instanceof <user fnctor>` still leaking `env::__instanceof_check`**
   (#4262's filed defect). Left alone: it is the `Function(…)`-valued and
   `this`-valued RHS shapes that `native-user-instanceof.ts` explicitly declines,
   a different mechanism (runtime `.prototype` read) from this one.

## 2026-08-12 follow-up — wrapper accessor subcluster (+6)

Fresh standalone-baseline clustering put Object/property semantics first at
188 ≤ES5 failures. The largest unowned repeated subcluster inside it was the
eight accessor files that assert `this instanceof Function|String|Number|Boolean`
while `Object.create` / `Object.defineProperties` reads a descriptor.

The old note above blamed strict `.call` for blocking wrapper registration.
That diagnosis was incomplete. Current runtime evidence shows:

- `new Number` / `new String` / `new Boolean` allocate an ordinary `$Object`
  with a FLAG_INTERNAL `[[PrimitiveValue]]` slot;
- strict primitive `this` is carried through externref by the native primitive
  box structs;
- the obsolete `$Wrapper*` structs are structurally equivalent to those
  one-field primitive carriers, so force-registering them makes
  `false instanceof Boolean` spuriously true while still missing real wrapper
  objects.

The follow-up replaces wrapper membership with one demand-gated native
predicate per constructor. It requires the real `$Object`, requires the genuine
internal-slot flag, then classifies the stored native primitive value. It also
normalizes both tag-6 and legacy-overloaded tag-5 fast `$AnyValue` object
carriers, so wrapper identity survives an `any` call boundary. No phantom
wrapper type is registered.

This semantic operation is also routed through IR: the selector admits only
fast standalone and an exact unshadowed ambient `Number` / `String` / `Boolean`
RHS; from-ast tag-tests and unwraps the dynamic Object partition and calls the
same runtime predicate. Focused compile telemetry records `kind=emitted` with
zero post-claim errors for all three constructors. Other backends, non-fast
standalone, and source-shadowed constructors remain unclaimed.

Focused A/B result on the measured main base (`d5ccbf2723633f`):

| file family | before | after | delta |
| --- | ---: | ---: | ---: |
| String/Number/Boolean accessor files | 0/6 | 6/6 | **+6** |
| strict `Function.prototype.call` regression | pass | pass | 0 |

The two Function-receiver files remain separate. With the pinned QuickJS
runtime-eval provider present, both still fail: closure own properties live in
an auxiliary `$Object` bag, and the bag read currently binds an accessor's
`this` to that bag instead of to the original function. A direct probe observes
the getter running with `this instanceof Object`, but not `this === props`,
`typeof this === "function"`, or `this instanceof Function`. Repairing that
receiver-preserving bag read is a separate carrier-MOP change; it is not claimed
by this wrapper-brand slice.

## Measurement

`runTest262File(abs, tag, 60_000, "standalone")`, **sequential**, Node
v25.7.0, runtime-eval provider prebuilt, tier **REFUSAL** on both arms, A/B by
file copy (never `git stash`). Compared by failing-test NAME, not by count.

| bucket | files | base pass | fixed pass | Δ |
| --- | ---: | ---: | ---: | ---: |
| ≤ES5 wrapper-instanceof candidates | 40 | 16 | **21** | **+5 / −0** |
| broad prefix (see below) | 841 | 672 | **675** | **+3 / −0** |
| affected files outside that prefix | 113 | 37 | **40** | **+3 / −0** |

The broad arm is **exhaustive over the plausibly-affected population and sampled
on the rest**: every file in `built-ins/{Object,Function,String,Number,Boolean}`,
`language/expressions/{instanceof,object}` and `language/types/object` that
mentions `instanceof <builtin>` (141 in the prefix + 113 outside it), plus a
deterministic 700-file random sample of the remaining ≤ES5 files in those
buckets. The sample is compared by **sha256 of the emitted binary** as well as by
verdict, so collateral codegen change is visible even where the verdict does not
move.

**Byte-identity result over the 841-file overlap: 825 binaries identical, 14
different — and every one of the 14 literally contains `instanceof Object` or
`instanceof Function`.** No collateral effect at scale.

**Union of gains — 6 files, 0 regressions:**

| file | form |
| --- | --- |
| `built-ins/Object/create/15.2.3.5-2-2` | `newObj instanceof Object` |
| `built-ins/Object/create/15.2.3.5-4-2` | `newObj instanceof Object` |
| `built-ins/Object/create/15.2.3.5-4-4` | `this instanceof Object` in an accessor |
| `built-ins/Object/getOwnPropertyDescriptor/15.2.3.3-4-247` | `desc instanceof Object` |
| `language/expressions/instanceof/S11.8.6_A6_T3` | `MyFunct instanceof Function` |
| `language/statements/async-function/syntax-declaration-line-terminators-allowed` | `foo instanceof Function` (async fn) |

The last one is not a flake and not in the enumeration's ≤ES5 scope: its base
row is `assert(foo instanceof Function)` failing with a different binary sha. It
is the closure-snapshot half of the fix paying out where the enumeration did not
predict it.

**Focused byte-identity A/B (8 sources × 2 lanes, sha256):** all four
no-`instanceof` sources identical in BOTH lanes; the **gc/JS-host lane identical
for all eight**; in standalone only `instanceof Object` and `instanceof Function`
differ — `instanceof Date` and `instanceof Number` are byte-identical. The
lowering is demand-gated to exactly the two forms it claims.

**Test suite:** `tests/issue-4276-instanceof-object-family.test.ts`, 42 cases.
**20 are RED on `upstream/main`** (15 unit + the 5 upstream files above); all 42
green with the fix.

**Neighbouring suites, both arms:** `tests/es5-standalone-instanceof.test.ts`
(green), `tests/equivalence/{struct-field-index,destructuring-require-object-coercible}`
— the only two equivalence files that use `instanceof` at all — 14/14 green,
`tests/es5-standalone-harness-selftests.test.ts` 19/19 with **no ratchet entry
flipping** (nothing to promote to `"pass"`). `tests/issue-2984.test.ts` fails 3
**host-lane** cases — verified failing IDENTICALLY on `upstream/main` with the
change reverted by file copy, so pre-existing and unrelated. The full
`tests/equivalence` run OOMs in this container (a documented local limitation);
CI's `equivalence-gate` covers it, and the gc-lane byte-identity result bounds
the risk to zero for that lane.

## Acceptance criteria

- [x] `x instanceof Object` answers `true` for a dynamic object/array/function/
      wrapper/Date/RegExp/Error LHS, host-free, with no `env::` import
- [x] `null`, an unboxed number, a primitive string and cross-constructor misses
      still answer `false` (a naive always-true predicate fails these)
- [x] `f instanceof Function` is position-independent (finalize-corrected
      classifier, not a lowering-time snapshot)
- [x] A module with no `instanceof` is byte-identical (sha256 A/B, both lanes)
- [x] The gc/JS-host lane is byte-identical
- [x] Population measured with denominators; the dispatch estimate corrected
- [x] Regressions reported by test NAME; the one measured regression traced to
      its real cause and the arm that unmasked it reverted

Tests: `tests/issue-4276-instanceof-object-family.test.ts`.
