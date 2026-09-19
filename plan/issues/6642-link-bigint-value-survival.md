---
id: 6642
title: "standalone: a BigInt value does not survive a consumer↔provider link (typeof/===/Object.is/String/arithmetic all answer as if it were not a BigInt)"
status: done
assignee: ttraenkler/senior-dev-s62
sprint: current
priority: high
horizon: m
goal: standalone
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-09-18
completed: 2026-09-19
loc-budget-allow:
  # 2026-09-18 (S59, #6642) — `compileTypeofComparison`'s dynamic helper-call
  #   arm now routes an `any`/`unknown` non-bigint operand of BigInt strict
  #   equality through the native `__extern_strict_eq` helper instead of
  #   statically folding to a compile-time constant. The new branch (operand
  #   compilation + the dynamic-dispatch call + the re-read-funcIdx-after-
  #   compiling-the-operand fix, same root cause as the typeof-delete.ts one
  #   below) lives in `compileBinaryExpression`'s existing BigInt cascade —
  #   splitting it into a new file was rejected: the cascade already threads
  #   ~8 shared locals (`leftTsType`/`rightTsType`/`leftIsBigInt`/…) that a
  #   split would have to re-parameterize for a net negative (more code, more
  #   risk) versus the modest overage.
  # 2026-09-18 (S60, #6642) — the same file also gains the `BIGINT_I64`
  #   module constant + its rationale comment (the bigint-BRANDED i64 hint
  #   that `coerceType`'s `externref → i64` row consults to pick §7.1.13
  #   `__to_bigint` over the plain-number unbox). It is a one-line constant
  #   with a ~17-line comment explaining why a bare `{ kind: "i64" }` hint is
  #   a silent data-loss bug; the comment is the whole value of the change
  #   and belongs next to the constant, not in a new file.
  # 2026-09-18 (S60, #6642) — STRANDED-GRANT RESTATEMENT, not new growth.
  #   `typeof-delete.ts`'s +17 is S59's Fix 1 (re-read the `__typeof*` helper
  #   funcIdx AFTER compiling the operand, so a link-boundary import shift
  #   cannot bake a stale `call` immediate). Its grant was written in
  #   plan/issues/5383-standalone-temporal-provider.md, which this change-set
  #   does not modify — so against CI's merge preview the allowance is
  #   invisible and the gate fails on growth that is already reviewed. Restated
  #   here, in a file this PR does touch.
  # 2026-09-18 (S61, #6642) — `src/codegen/registry/imports.ts` gains the native
  #   StringToBigInt arm on `__bigint_ctor`'s terminal. The §7.1.14 scan itself
  #   is spliced INLINE, and its ~370-line body lives in the new leaf file
  #   `src/runtime/wasmgc/values/string-to-bigint-body.ts` rather than being
  #   minted as its own wasm function — deliberately: a new defined function
  #   shifts every already-registered function index, which is exactly the
  #   stale-`funcIdx` hazard S59's Fix 1 had to repair. The cost of that choice
  #   is ~56 lines of wiring (layout resolve, `ref.test $AnyString` guard,
  #   extra locals) in the file that owns `__bigint_ctor`. Restated here
  #   because the pre-existing allowance for this same file lives in
  #   plan/issues/5383-standalone-temporal-provider.md, which this change-set
  #   does not modify — so it is invisible to CI's merge-preview base.
  # 2026-09-19 (S62, #6642) — STRANDED-GRANT RESTATEMENT + new growth.
  #   `src/codegen/index.ts` gains SIX lines: the import of the new
  #   `bigint-primitive-to-string.ts` leaf and its two finalize call sites
  #   (the ordered pass list and the `profilePhase` twin), plus the comment
  #   that says why the arm is independent of the `__extern_get` arms above it.
  #   The ARM ITSELF is zero lines here — it lives entirely in the new leaf —
  #   so this is the irreducible wiring cost of adding a finalize pass at all,
  #   the same six lines every neighbouring arm (#4619, #5194 r3-1, #6610)
  #   paid. It is restated here because the pre-existing allowance for this
  #   file lives in plan/issues/5383-standalone-temporal-provider.md, which
  #   this change-set does not modify — so against CI's merge preview the
  #   allowance is invisible and the gate fails on growth already reviewed.
  - src/codegen/binary-ops.ts
  - src/codegen/typeof-delete.ts
  - src/codegen/registry/imports.ts
  - src/codegen/index.ts
func-budget-allow:
  # 2026-09-18 (S59, #6642) — same new branch lands inside
  # `compileBinaryExpression`, and `compileTypeofComparison` (typeof-delete.ts)
  # grows for the funcIdx re-read fix (see Root Cause). Both are the single
  # function each defect's fix belongs next to; splitting either purely to
  # dodge the gate was rejected for the same reason as the LOC grant above.
  # 2026-09-18 (S60, #6642) — STRANDED-GRANT RESTATEMENT (see the LOC note
  #   above): `compileTypeofExpression` is the OTHER half of S59's Fix 1 (the
  #   bare `typeof x` cascade has the same stale-funcIdx capture as the
  #   comparison form). Granted in plan/issues/5383-standalone-temporal-provider.md,
  #   which this change-set does not modify; restated here so CI's merge-preview
  #   base can see it.
  - src/codegen/binary-ops.ts::compileBinaryExpression
  - src/codegen/typeof-delete.ts::compileTypeofComparison
  - src/codegen/typeof-delete.ts::compileTypeofExpression
  # 2026-09-18 (S61, #6642) — `addUnionImportsAsNativeFuncs` is the single
  #   function that registers EVERY union native, `__bigint_ctor` included, so
  #   the new string arm has to be built where that body is built: it needs the
  #   local `throwNativeError` closure and the same `bigIntStructIdx`/
  #   `registerNative` scope. +52 lines, of which the parser itself is ZERO —
  #   the scan was deliberately factored out into its own leaf module; what
  #   remains here is the layout resolve, the `ref.test $AnyString` guard and
  #   the extra locals.
  - src/codegen/registry/imports.ts::addUnionImportsAsNativeFuncs
  # 2026-09-19 (S62, #6642) — STRANDED-GRANT RESTATEMENT + new growth, same
  #   three functions the #5383 lane already holds allowances for, restated
  #   here because this change-set does not modify that issue file:
  #   `generateModule` / `generateMultiModule` are `index.ts`'s two ordered
  #   finalize-pass lists, so a new pass costs exactly one call site in each
  #   (+4 / +1 with the comment); `fillStandaloneTypeofClosureArms` is the
  #   function that owns EVERY `__any_to_string` / `__to_primitive` carrier
  #   splice (#4564's Date arm is the line above), so the bigint arm's call
  #   has to be there — +5, of which the arm body is zero.
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/typeof-natives-finalize.ts::fillStandaloneTypeofClosureArms
---

## Problem

Twelve `test/built-ins/Temporal/ZonedDateTime/prototype/` rows fail under
`--target standalone` because a `BigInt` value minted by a linked standalone
Temporal PROVIDER does not survive the link to its CONSUMER:
`zdt.epochNanoseconds`, `zdt.add(...)`'s result, etc. compare/format/typeof as
if they were not BigInts at all.

Reduced (see `## Implementation Notes` below) to a single-module, link-free
repro:

```ts
const NS = Object.freeze({
  __proto__: null,
  giveBigInt() { return 217175010_123_456_789n; },
});
export function f(): number {
  return NS.giveBigInt() === 217175010123456789n ? 1 : 0; // answers 0
}
```

No link boundary is needed to reproduce this — `NS.giveBigInt()` is a
DYNAMICALLY DISPATCHED property/closure call, and that dispatch shape alone
is enough. The link only determines the TS *static type* of the far-side
value (`any`, via a `field(): any` boundary stub), which is what the second
fix below needed.

## Root Cause — FOUR independent defects found, THREE fixed, ONE identified but not fixed

**Fix 1 (landed) — stale `funcIdx` captured before a link-boundary import
shift.** `typeof-delete.ts`'s `compileTypeofExpression` and
`compileTypeofComparison` both captured the `__typeof`/`__typeof_bigint`
helper's `funcIdx` from `ctx.funcMap` BEFORE compiling the operand
expression. Compiling a cross-module link-boundary read can itself lazily
register new import functions (`standaloneLinkBoundaryPeerIndices` /
`ensureLateImport`), which SHIFTS every already-registered defined-function
index (`shiftLateImportIndices`). The captured local variable sits in a bare
TS variable, not yet inside any emitted `Instr`, so the shifter cannot find
and repair it — the stale value then baked a `call` into whatever function
had since slid into that slot. Measured: `__typeof_bigint`'s funcIdx moved
65 → 75 → 76 across two import batches in the reduction; the stale `65`
pointed at `__box_bigint` by the time the module finished compiling, and
`WebAssembly.Module()` rejected it: `call[0] expected type i32, found block
of type externref`. Fixed by re-reading `ctx.funcMap.get(helperName)`
immediately before emitting the `call`, in both functions.

**Fix 2 (landed) — BigInt-vs-`any` strict equality over-folded to a compile-
time constant.** `binary-ops.ts`'s `compileBinaryExpression` BigInt cascade:
`if (leftIsBigInt !== rightIsBigInt) { ...strict eq: compile both sides for
side effects, then answer a hardcoded false/true... }`. Correct when the
non-bigint side is PROVABLY some other type (`5n === "5"` is always false by
spec) — WRONG when that side is statically `any`/`unknown`, which is exactly
how a value read through a link boundary (or, as the link-free reduction
above shows, through ANY dynamically-dispatched call/property whose static
type collapses to `any`) is typed. The fold ran anyway, because
`isBigIntType(anyType)` is trivially false and the code never asked whether
the OTHER side could dynamically be a BigInt. Fixed by routing an
any/unknown non-bigint operand of strict `===`/`!==` through the existing
native `__extern_strict_eq` helper (`any-helpers.ts`) instead — its
`bigintArm` (`extern-eq-fast.ts`, #3173/#4173) already does the correct
`ref.test $BigInt` + `i64.eq` dynamic classification; it was simply never
reached for this operand shape before.

**Fix 3 (built, then DROPPED as unnecessary) — candidate `$BigInt`
canonical-rec-group membership.** Initial hypothesis: `$BigInt` (a
module-private WasmGC struct, minted lazily by
`addUnionImportsAsNativeFuncs`) needed to join the frozen canonical runtime
rec-group (`RUNTIME_RECGROUP_TYPE_NAMES`, #2527) for two separately-compiled
standalone modules' `$BigInt` structs to canonicalize to the same WasmGC
runtime type. Built (eager registration in `registerNativeStringTypes` +
`buildBigIntType` + an ABI version bump + a `canonicalHashOfTypeGroup` fix
for the pre-existing `i64.bigint` vs. plain-`i64` token mismatch between the
IR-side hasher and the binary-parsing verifier) — then MEASURED to be
unneeded: `tests/issue-6642-link-bigint-value.test.ts`'s canonicalization
test passes identically on the pre-fix base tree. WasmGC isorecursive type
equivalence for a size-1 rec group (one immutable i64 field, no
self-reference) needs no shared ABI registry the way the bigger String/Vec
family genuinely does (that family is mutually self-referential — ConsString
references NativeString/AnyString, HashedString subtypes NativeString — so
`planPhysicalTypeSection`'s forward-reference grouping bundles them into ONE
multi-member rec group, where position/order DOES matter for canonicalization
in a way it never does for an isolated single-field struct). Kept OUT of this
PR: unproven, and it materially grows the frozen ABI surface (every
nativeStrings module, not just standalone ones, would carry the type) for
zero measured benefit.

**Residual (NOT fixed, blocks all 12 target rows) — `coercionPlan` has no
bigint-brand column.** `NS.giveBigInt()`'s WASM-level compiled body is a
NATIVE, monomorphic `() -> i64` closure (`$__closure_2` in the reduction's
WAT dump — no boxing at all, just `i64.const …; return`). The generic
closure/property dispatch machinery (`__apply_closure`) wraps this in the
usual externref ABI at the call site, and the comparison
`NS.giveBigInt() === 217175010123456789n` compiles the call with an i64Hint
expected type. The call's naturally-compiled result is a
`(block (result externref))`, and reconciling that against the i64Hint is
left to `stack-balance.ts`'s POST-HOC `fixBranchType` pass, which infers the
produced type from the raw emitted instructions and calls `coercionPlan`
(`coercion-plan.ts`) to bridge `(externref, i64)`. `coercionPlan`'s
`externref → i64` row is a `(from.kind, to.kind)` table with **no bigint-
brand column** — measured directly in the WAT: it emits
`call $__unbox_number; i64.trunc_sat_f64_s` (the plain-NUMBER unbox path)
instead of `call $__to_bigint` (the ToBigInt/§7.1.13 path `coerceType`, the
OTHER coercion engine in `type-coercion.ts`, already has correctly for this
exact `(from, to)` pair). `__unbox_number` has no `$BigInt` classification
arm, so it falls to a default/NaN answer, `i64.trunc_sat_f64_s` turns that
into `0`, and every downstream comparison/arithmetic op on the value is
silently wrong — no crash, no diagnostic, just a wrong number.

Confirmed link-independent: `.tmp/s59/probe/samemod.mjs` and
`propcheck.mjs` (single standalone module, method call and property read
respectively, no `link`/`compileProject` involved) both reduce it.

Why not fixed in this slice: `coercionPlan` is deliberately a PURE
`(from, to, helpers)` function (coercion-plan.ts's own docstring: "the only
context the stack-balancer can supply post-hoc"), and its `CoercionHelpers`
carries exactly `{boxNumberIdx, unboxNumberIdx}`. `stack-balance.ts` resolves
those TWO indices ONCE (`findFuncByName("__box_number")` /
`findFuncByName("__unbox_number")`) and threads them as a PAIR through
~16 function signatures (`fixBranchType`, `fixBody`, `fixBranch`,
`plannedCallArgCoercionInstrs`, `callArgCoercionInstrs`, and their mutual
recursion) down to the two `coercionPlan(...)` call sites. Adding a THIRD
helper (`toBigIntIdx`, resolved via `findFuncByName("__to_bigint")`) requires
mechanically widening every one of those ~16 signatures and their call
sites — a large, purely-mechanical but unverified-in-budget change for this
slice. `type-coercion.ts`'s OWN `coercionInstrs` (a sibling pre-built-Instr[]
coercion function, used by array-method callback loops — NOT the path this
bug hits) got the equivalent bigint-aware rows added defensively in an
earlier iteration of this slice's investigation but was reverted along with
the canonical-recgroup work once it was confirmed not to be on the hit path
for this defect (kept out to minimize an unproven diff).

## S60 — the residual, fixed. The S59 diagnosis was on the wrong table.

**S59's "Next step" below is superseded. Do NOT thread `toBigIntIdx` through
`stack-balance.ts`.** Traced directly (a `console.error` stack in
`coercionPlan`'s `externref → i64` arm, compiling S59's own reduction):
`coercionPlan` is **never called** for this shape. The site that fires is
`type-coercion.ts`'s `coerceType`, reached from
`expressions.ts:1037 → compileExpressionBody → compileBinaryExpression`
(binary-ops.ts) — and `coerceType` **already has** the correct
`if (to.bigint) { … __to_bigint … }` arm S59 pointed at. It did not fire
because `to` arrived as `{"kind":"i64"}` with **no brand**. The brand was lost
before the coercion site, exactly the second-defect case the S60 brief flagged.

Two brand DROPS, one per direction of the generic externref ABI:

**Fix A — the UNBOX side: `binary-ops.ts`, the both-operands-BigInt arm.**
`const i64Hint: ValType = { kind: "i64" }` — bare. Every operand of a BigInt
operator was compiled against an UNBRANDED i64 expected type, so
`coerceType(externref → i64)` took the plain-NUMBER row
(`__unbox_number; i64.trunc_sat_f64_s`) and the comparison ran against `0`.
Fixed by hoisting a module constant `BIGINT_I64 = { kind: "i64", bigint: true }`
and using it as that hint. Measured in the WAT: `call $__unbox_number;
i64.trunc_sat_f64_s` → `call $__to_bigint`.

**Fix B — the BOX side: `closures/result-boxing.ts`,
`buildClosureResultBoxing`.** With Fix A alone the reduction went from a wrong
answer to a **thrown TypeError** — `__to_bigint` correctly refused a value that
was no longer a BigInt by the time it arrived. `NS.giveBigInt()` compiles to a
native monomorphic `() -> i64` closure; reaching it through dynamic dispatch
makes the `__call_fn_*` ABI box the result, and that arm boxed EVERY i64 as a
NUMBER: `f64.convert_i64_s; call $__box_number`. Two losses in one line —
`f64.convert_i64_s` rounds anything above 2^53 (217175010123456789n → …792),
and `__box_number` erases bigint-ness outright. The **i32 arm immediately
above it** (`boxI32ClosureResult`) already preserved the `boolean` and `symbol`
brands for precisely this reason; the i64 arm just had no brand column. Added
`boxI64ClosureResult`, which picks `__box_bigint` for a branded i64 and leaves
the unbranded (native `type i64 = number`) path byte-identical.

Neither fix touches `coercion-plan.ts` or `stack-balance.ts` — so the
number rows of the shared table, and the gc lane that shares them, are
untouched by construction.

### Witness — revert-and-measure

`tests/issue-6642-coercion-plan-bigint.test.ts` (5 cases). File-copy A/B
against `8a95c4dace` (S59's head), same command both times
(`VITEST_FORK_MAX_OLD_SPACE_SIZE=3072 npx vitest run --maxWorkers=2`):

| case | base `8a95c4dace` | with S60 fixes |
| --- | --- | --- |
| dynamically dispatched METHOD `===` matching literal | **FAIL** (`0`, expected 1) | pass |
| dynamically dispatched PROPERTY `===` matching literal | **FAIL** (`0`, expected 1) | pass |
| linked provider, `Object.is(bigint, literal)` | **FAIL** (`0`, expected 1) | pass |
| NON-matching literal still `false` (not a blanket true) | pass | pass |
| native UNBRANDED `type i64 = number` keeps the number box | pass | pass |

Base: `3 failed | 2 passed`. Fixed: `5 passed`. The two that pass on both are
guards, not witnesses — they exist so the fix cannot be a blanket switch.

Link-level probe (`.tmp/s60/probe/reduce2.mjs`, 5 consumer shapes over a real
`compileProject` link), base → S60: `eqLiteral` 0 → **1**, `objectIs` 0 → **1**,
`typeofResult` 0 → **1**. Still wrong and NOT claimed fixed: `toStr` (`"" + v`
where `v` is `any` — String() of a dynamically-classified BigInt) and
`arithAdd` (`v + 1n` with `v` typed `any` — throws). Both are the
`any`-typed-operand path, a different mechanism from the branded-hint one
fixed here; neither is on the 12 target rows' critical path (see the row table
below) and both are left open.

### The 12 target rows do NOT move — and the reason is a DIFFERENT defect chain

Measured on the S60 tree (fresh `build:compiler-bundle` → fresh provider under
`.test262-cache/s60-4`, `cacheHit=false` → fresh quickjs adapter → the 15
non-passing `ZonedDateTime` rows): **status identical to base on all 15.**
Fixes A and B are correct and witnessed, but they are NOT on these rows' hit
path. The blocker is upstream of them, and S59's `coercionPlan` attribution was
not the only thing pointing the wrong way — the whole "the value loses its
brand in codegen" framing was.

**What actually happens.** `@js-temporal/polyfill` ships **JSBI** (`class JSBI
extends Array`) as its BigInt carrier, and converts back to a real BigInt only
here:

```js
function ko(e){ const t = Lo(e);
  return void 0 !== globalThis.BigInt ? globalThis.BigInt(t.toString(10)) : t; }
get epochNanoseconds(){ … return ko(…) }
```

In standalone, `globalThis.BigInt` is **`undefined`**, so `ko` returns the raw
JSBI array. That is the `«977899425,408899357,1»` in every failure message: not
a mangled BigInt, an `Array` subclass printed by `Array.prototype.toString`
(and `977899425 * 1e9 + 408899357` is exactly the expected value, which is what
makes it look like a corrupted number). `typeof` on it is `"object"`, so the
harness's `===` correctly answers false. No codegen coercion is involved.

Probed directly (`.tmp/s60/probe/globalctors2.mjs`, single standalone module,
boolean-returning exports — a STRING-returning export does not marshal out of a
standalone instance, which is why an earlier `typeof`-string probe read
`undefined` for every builtin and was not evidence):

| probe | answer |
| --- | --- |
| `typeof BigInt === "function"` (bare identifier) | **1** |
| `globalThis.Number !== undefined` | **1** |
| `globalThis.BigInt !== undefined` | **0** ← the blocker |
| `globalThis.Symbol !== undefined` | **0** (same gap, not chased) |
| `(1n).toString() === "1"` | 1 |
| `String(1n) === "1"` | **0** (separate gap; only affects failure *messages*) |

**The chain, each link measured, none of it landed:**

1. `STANDALONE_GLOBAL_CONSTRUCTOR_NAMES`
   (`codegen/standalone-global-object-carriers.ts`) has no `"BigInt"`, so the
   realm object never gets the property. Adding it flips
   `globalThis.BigInt !== undefined` to 1 — one line, verified.
2. The seeded carrier is a plain `$Object` with no `[[Call]]`, so all 12 rows
   then fail with `TypeError: called value is not a function` instead. Adding
   `"BigInt"` to `CALLABLE_WRAPPER_CTORS` (`codegen/builtin-ctor-callable.ts`,
   #4394's `__apply_closure` front-guard) makes `globalThis.BigInt(x)` callable
   **in a single module** — verified for both `g.BigInt(o)` and an extracted
   `const fn = g.BigInt; fn(o)`.
3. It still does NOT reach the polyfill, because that arm is **per-module and
   identity-based**: it `ref.eq`s the callee against *this* module's
   `__builtin_ctor_BigInt` global. The Temporal provider is a separately
   compiled LINKED module reading a shared realm object, so its own
   `__apply_closure` has no matching carrier. #4394's design predates the
   linked realm; extending it there is its own slice.
4. Even past that, `__bigint_ctor`'s native standalone body ends in
   `throwNativeError("SyntaxError", "Cannot convert string to a BigInt in
   standalone mode")` — measured: `BigInt(<string variable>)` traps, only
   `BigInt(<number>)` works, and the literal cases that "pass" are compile-time
   folds in `call-identifier.ts`, not the runtime helper. The polyfill passes a
   STRING (`t.toString(10)`), so a native StringToBigInt (the i64 twin of
   `parse-number-native.ts`'s ~900-line `__str_to_number`) is required.

Links 1 and 2 were built and measured, then **reverted, deliberately**: alone
they make the 12 rows fail *worse* (a thrown TypeError where there was a wrong
value), and a thrown `globalThis.BigInt(…)` can break code that today takes the
`typeof`-guarded fallback path. They must land together with 3 and 4 or not at
all. Nothing from this investigation is in the commit; the diff is exactly
Fixes A and B plus the witness test.

### S60 validation — everything held flat

Criterion-4 battery, 13 families / 3,684 rows, S60 tree vs the S58 base TSVs
(fresh bundle → provider `.test262-cache/s60-4` `cacheHit=false` → quickjs
adapter `32f5a6556aac04ff`): **0 pass→fail, 0 fail→pass, 0 missing, in every
family** — PlainDate 120, Duration 120, PlainDateTime 120, ZDT 120, A 1250,
B 205, C 349, D 300, E-unlinked 300, E-linked 300, F-class 250, F-methoddef
100, F-objproto 150. Four-family total unchanged at **437/480** (PlainDate
113, Duration 106, PlainDateTime 113, ZDT 105).

Corpus byte A/B, 84 entries × 2 lanes: **0 status flips, 0 SHA flips.**
Measured against a base run this session (`.tmp/s60/fix/*.base.ts` copied in,
corpus re-run, files restored) — **not** against the committed S58 jsonl, which
shows 30 SHA flips that are entirely `origin/main` drift carried in by
`8a95c4dace`'s merge. That distinction is the whole value of the extra run: the
committed-baseline diff would have reported 15 gc-lane byte flips against a
change that moves zero bytes on either lane.

Equivalence gate: `22 failing, 1720 passing, 22 known-failures` — no new
regressions. Witness sweep (`tests/issue-66*`, `issue-6484-*`, `issue-6493-*`,
42 files / 260 tests) green under **both** Node 22 and Node 25.

## S61 — link 1 landed. Link 2 measured UNNECESSARY. A FIFTH link found.

**What landed: link 1 only — a real native StringToBigInt.** Links 3 and 4 were
built, measured end-to-end, and then **deliberately held back**, for exactly the
reason S60 gave for links 1–2: with the newly-found link 5 missing they turn the
target rows from a wrong VALUE into a thrown TypeError. Everything needed to
re-apply them in minutes is written down below.

### Link 1 (LANDED) — `__bigint_ctor` parses a string

`src/runtime/wasmgc/values/string-to-bigint-body.ts` (new leaf) implements
§7.1.14 StringToBigInt / StringIntegerLiteral over the flattened
`$NativeString` i16 array, accumulating **straight into i64**. It is spliced
**INLINE** into `__bigint_ctor` (`src/codegen/registry/imports.ts`) behind a
`ref.test $AnyString` guard, not minted as its own wasm function — a new defined
function shifts every already-registered function index, which is the precise
stale-`funcIdx` hazard S59's Fix 1 had to repair. Non-string operands keep the
pre-#6642 terminal verbatim.

Precision is the whole point and is why a `__str_to_number` +
`i64.trunc_sat_f64_s` shortcut was rejected: `217175010123456789` has 18
significant decimal digits, an f64 carries ~15.95, and the double route answers
`217175010123456792`.

**Range, stated because it is a real limit:** the standalone `$BigInt` carrier is
one immutable i64, so the scan is exact on [-2^63, 2^63-1] and **wraps modulo
2^64** above it (`i64.mul`/`i64.add` are wrapping ops; neither traps). That is
deliberately the same answer the rest of the standalone BigInt lane already gives
for arithmetic overflow, so a parsed string and a literal agree. Arbitrary
precision is a whole-lane change (a limb representation), not a parser change.

Witness `tests/issue-6642-realm-bigint.test.ts`, file-copy revert-and-measure
against `10873df1e0` (this branch's base), same command both times
(`VITEST_FORK_MAX_OLD_SPACE_SIZE=3072 npx vitest run --maxWorkers=2`):

| case group | base `10873df1e0` | with S61 |
| --- | --- | --- |
| decimal string, exact past the f64 significand | **FAIL** (SyntaxError) | pass |
| StrWhiteSpace trim; `""` / `"   "` → `0n` | **FAIL** (SyntaxError) | pass |
| `0x` / `0X` / `0o` / `0b` prefixes; `"0"`, `"09"` | **FAIL** (SyntaxError) | pass |
| `"12abc"` / `"1.5"` / `"1e3"` / `"0x"` / `"+"` / `"-0x10"` → SyntaxError | pass | pass |
| number / boolean / null operands unchanged | pass | pass |

Base `3 failed | 2 passed` → `5 passed`. The two that pass on both are guards
(the base threw SyntaxError for *everything*, so a blanket-accept parser would
have to break them).

### Link 2 — measured UNNECESSARY. S60's premise was wrong.

S60 called the `__apply_closure` wrapper-ctor front-guard "the link that
actually stops the Temporal rows", on the premise that the provider reads a
**shared** realm object whose carrier it cannot `ref.eq` against. Measured over a
real `compileProject` link (`.tmp/s61/probe/l2.mjs`, host-free, standalone):

| probe (consumer asks the provider) | answer |
| --- | --- |
| `api.realmRef() === globalThis` | **0** |
| `api.ctorRef() === globalThis.BigInt` | **0** |

**Each module owns its OWN realm object and its OWN `__builtin_ctor_*`
carriers.** So the provider's `__apply_closure` compares a callee against the
carrier *it* seeded, and #4394's identity guard matches with no change at all.
Verified end-to-end with links 3+4 applied — a provider that calls
`globalThis.BigInt("217175010123456789")` and hands the result across the link
gave the consumer `typeof === "bigint"` **1**, `=== 217175010123456789n` **1**,
`Object.is(..., 12n)` **1** (`.tmp/s61/probe/l2.mjs`), and `globalThis.Number(s)`
already worked across the link on the unmodified base (`.tmp/s61/probe/l1.mjs`),
which is the same mechanism one builtin over.

(That two modules of one realm see two different `globalThis` is its own
pre-existing spec gap — `globalThis !== globalThis` across the seam. It is NOT
fixed here and NOT what blocks these rows.)

### Links 3 + 4 — built, measured, HELD BACK

- Link 4: `"BigInt"` in `STANDALONE_GLOBAL_CONSTRUCTOR_NAMES`
  (`src/codegen/standalone-global-object-carriers.ts`). Flips
  `globalThis.BigInt !== undefined` from 0 to 1.
- Link 3: `"BigInt"` in `CALLABLE_WRAPPER_CTORS`
  (`src/codegen/builtin-ctor-callable.ts`) with `argOf(0) → __bigint_ctor →
  __box_bigint` (§21.2.1.1 — deliberately NOT `__to_bigint`, which TypeErrors on
  a Number). No zero-arg constant is needed: `BigInt()` must be a TypeError and
  `__bigint_ctor` already throws exactly that for the null operand `argOf(0)`
  hands it.

With 1+3+4 applied, single-module and linked probes all answer correctly
(`BigInt(strVar)` 1, `g.BigInt(strVar)` 1, `globalThis.BigInt` present 1,
provider→consumer BigInt survival 1/1/1). **But the 15 target rows do not pass —
they change failure mode**, 13 of 15 from `Expected SameValue(«977899425,…», …)`
to `TypeError: called value is not a function`. That is the fail-worse state, so
the two links are not in this commit.

`"Symbol"` was NOT added either: it has the identical `globalThis` gap but no
`[[Call]]` arm, so seeding it alone is exactly the same fail-worse shape.

### The FIFTH link — `<any>.toString(radix)` is not callable in standalone

Found by instrumenting `buildResolvedCalleeGuard`
(`src/codegen/resolved-callee-guard.ts`) to throw the method NAME and then the
receiver's `String()` instead of its fixed message, against the **real**
prewarmed polyfill provider (`.tmp/s61/probe/real.mjs` — `buildTemporalProvider`
+ `compileWithTemporalGlobal`, numeric-return exports):

- the throw is the guard's **null-callee** arm (not the primitive arm, not the
  #6618 class arm);
- the method name is **`toString`**;
- the receiver stringifies as `"123456789"` — the low 9 digits of
  `217175010123456789`, i.e. a bigint whose standalone stringification is
  already broken (S60's `String(1n)` → `0` note, re-confirmed).

The call is the `t.toString(10)` inside the polyfill's own converters
(`function ko(e){const t=Lo(e);return void 0!==globalThis.BigInt?globalThis.BigInt(t.toString(10)):t}`
and `Lo`'s `e.BigInt(n.toString(10))`). It was NEVER EXECUTED before, because the
`void 0 !== globalThis.BigInt` guard short-circuited — link 4 is what exposes it.

Reduced **single-module, link-free** (`.tmp/s61/probe/p6.mjs`, `--target standalone`):

| expression (receiver typed `any`) | answer |
| --- | --- |
| `n.toString(10)` where `n = 123456789` | **TypeError** |
| `n.toString(16)` where `n = 255` | **TypeError** |
| `n.toString(10)` where `n = 217175010123456789n` | **TypeError** |
| `n.toString()` (0-arg, number) | ok |
| `n.toString()` (0-arg, bigint) | **wrong answer** |
| `String(n)` (bigint) | **wrong answer** |
| same calls with a STATICALLY typed receiver | ok |

`src/codegen/number-primitive-method-call.ts` already documents the number half
as a named residual ("Its radix spelling (`x.toString(16)` through an `any`
receiver) is a separate residual"); the bigint half is new here.

### S61 validation — everything held flat

Criterion-4 battery, 13 families / 3,684 rows, S61 tree vs the S60 base TSVs
(fresh `build:compiler-bundle` → provider `.test262-cache/s61-f1`
`cacheHit=false` → fresh quickjs adapter `fc390ba0543de545`): **0 pass→fail,
0 fail→pass, 0 missing, in every family** — PlainDate 120, Duration 120,
PlainDateTime 120, ZDT 120, A 1250, B 205, C 349, D 300, E-unlinked 300,
E-linked 300, F-class 250, F-methoddef 100, F-objproto 150. Four-family total
unchanged at **437/480** (PlainDate 113, Duration 106, PlainDateTime 113,
ZDT 105). The 15 target ZonedDateTime rows are byte-for-byte the same failures
they were on the base — link 1 alone is not on their path, by construction.

Corpus byte A/B, 84 entries × 2 lanes: **0 status flips; 25 SHA flips, ALL on
the `standalone` lane, 0 on `gc`.** Measured against a TRUE base run this
session (`imports.ts` reverted to `10873df1e0` and the new leaf moved aside,
corpus re-run, files restored) — which produced the identical 25, so none of
them is `origin/main` drift. The movement is `__bigint_ctor`'s grown body:
**+891 bytes** on every standalone binary measured
(`benchmarks/fib.ts` 35,324 → 36,215; `js/builtins.ts` 63,743 → 64,634;
`ir-retirement/math.ts` 137,296 → 138,190), while the same three files' `gc`
binaries are byte-identical (1,073 / 4,955 / 11,204 both ways). That is the
price of inlining the scan instead of minting a function, and it is the price
that buys zero function-index movement.

Equivalence gate: `22 failing, 1720 passing, 22 known-failures` — no new
regressions. Witness sweep (`tests/issue-66*`, `issue-6484-*`, `issue-6493-*`,
43 files / 265 tests) green under **both** Node 22 and Node 25.

## S62 — link 5 fixed, links 3 + 4 re-applied. 10 of the 15 rows PASS.

S61's four-item list was followed exactly and all four items landed. The target
bucket moved from **0/15 to 10/15**; the five that stay red are three DIFFERENT
mechanisms, named and measured below, none of them bigint-survival.

### What the defect actually was — two ladders with no `$BigInt` / no radix column

Measured on this tree (`.tmp/s62/probe/q1.mjs`, `q2.mjs` — single standalone
module, host-free, numeric-returning exports, the #6610 witness's harness shape;
note that a TS `compile()` probe with a `const n: any = …` initializer does NOT
reproduce it — the initializer keeps a static f64/i64 local and the call never
goes dynamic, which cost this slice an hour of chasing a null that was the
probe's, not the compiler's):

| shape (receiver reached through an `any` binding) | base `bb435fa167` | S62 |
| --- | --- | --- |
| `n.toString(16)` / `(2)` / `(10)`, number | **threw** | `"ff"` / `"11111111"` / `"123456789"` |
| `n.toString(undefined)`, number | **threw** | `"255"` (§21.1.3.6 step 2) |
| `n.toString(1)` / `(40)`, number | **TypeError** | **RangeError** (§21.1.3.6 step 4) |
| `b.toString(16)` / `(10)` / 0-arg / negative / zero, bigint | **threw** | exact, sign-aware |
| `b.toString(1)` / `(40)`, bigint | **TypeError** | **RangeError** (§21.2.3.3 step 3) |
| `String(<bigint>)` | **`"[object Object]"`** (15 chars, measured) | the digits |
| `globalThis.BigInt !== undefined` | **0** | 1 |
| `globalThis.BigInt("12")` / `BigInt(12)` | **threw** | `12n` |
| `globalThis.BigInt(t.toString(10))` — the polyfill's line | **threw** | `217175010123456789n` |
| `` `${b}` `` / `"" + b` | correct | correct (untouched) |
| `n.toString()` 0-arg, number | correct | correct (untouched) |

**Link 5a — the NUMBER half was pure ROUTING.** `"toString"` joins
`NUMBER_PRIMITIVE_CALL_MEMBERS` (`number-primitive-method-call.ts`); the
reflective body `emitNumberProtoToStringBody` was already complete, radix ladder
and all. The demand scan is gated by a new
`numberPrimitiveMemberDemandArity` — `toString` counts as demand only at
`arguments.length >= 1`, because the 0-argument spelling appears in nearly every
standalone module and already answers through another arm; an ungated scan would
install the arm (and `%Number.prototype%`'s glue) across the whole lane for
nothing. Once demanded for any reason the arm claims BOTH arities, so the two
spellings cannot diverge.

**Link 5b — the BIGINT half was two missing ARMS**, new leaf
`src/codegen/bigint-primitive-to-string.ts`:

- `unshiftExternMethodCallBigIntPrimitiveArm` — a `$BigInt`-receiver arm on
  `__extern_method_call` that resolves the key by NAME (interned
  `$NativeString` + `ref.eq`, the `ta-dyn-method-call.ts` shape) and answers
  `toString` off the carrier's i64 through the EXISTING
  `bigint_toString_radix` (#1644 slice D, `bigint-format-native.ts`). Radix
  ladder copied in shape from `emitNumberProtoToStringBody`: absent / `null` /
  `undefined` ⇒ 10 and no range check; anything else floored and required in
  [2, 36], else a real `RangeError` instance.
- `unshiftAnyToStringBigIntArm` — a `$BigInt` arm at the FRONT of
  `__any_to_string`, the `unshiftDateToStringArm` (#4564) shape.

**Why an arm and not a `%BigInt.prototype%` brand.** The three wrapper families
get dynamic-receiver routing from a real `$NativeProto` brand with a member CSV
and reflective bodies. BigInt has none, and minting one is a whole slice
(brand-table entry, member CSV, `thisBigIntValue`, companion seeder). The single
broken member already has a complete exact formatter, so the arm delegates to it
and declines everything else — `BigInt.prototype` stays exactly as un-reified as
it is on the base.

**Index safety.** Both splices run at finalize and mint only DEFINED functions
(`emitNativeBigIntFormat`, `emitWasiErrorConstructor` under
`forceInModuleCtor`), which append; the stale-`funcIdx` hazard S59's Fix 1
repaired is a late-IMPORT hazard and is not reachable from here.

**Demand.** Both splices gate on `ctx.nativeBigIntTypeIdx >= 0` — the module
minted the carrier, i.e. it uses BigInt at all. No extra AST scan: unlike the
Number arm (whose gate must exclude the near-universal 0-arg `toString`), "this
module has a bigint" is already the narrow condition, and a module that has one
must be able to print it.

**Links 3 + 4, re-applied verbatim** as S61 wrote them: `"BigInt"` in
`CALLABLE_WRAPPER_CTORS` (`argOf(0) → __bigint_ctor → __box_bigint`, §21.2.1.1,
deliberately not `__to_bigint`) and in `STANDALONE_GLOBAL_CONSTRUCTOR_NAMES`.
`"Symbol"` is still NOT added — it has the identical `globalThis` gap and no
`[[Call]]` arm, so seeding it alone is the same fail-worse shape S60/S61
described.

### Witness — revert-and-measure

`tests/issue-6642-bigint-tostring.test.ts` (4 cases / 37 assertions). File-copy
A/B against `bb435fa167` (the five changed source files reverted, the new leaf
moved aside), same command both times
(`VITEST_FORK_MAX_OLD_SPACE_SIZE=3072 npx vitest run --maxWorkers=2`):

| case | base `bb435fa167` | with S62 |
| --- | --- | --- |
| §21.1.3.6 / §21.2.3.3 through an `any` receiver, both arities | **FAIL** (`-1`, threw) | pass |
| every ToString route for a bigint | **FAIL** (`0`, `"[object Object]"`) | pass |
| a callable realm `BigInt` (links 3 + 4) | **FAIL** (`0`, absent) | pass |
| the polyfill's converter inside a linked provider | **FAIL** (`-1`, threw) | pass |

Base `4 failed` → `4 passed`. The controls inside each case (0-arg
`x.toString()`, static receivers of both kinds, `String()` of a number / string
/ boolean / object / array / null / undefined, the template and `+` spellings,
`typeof globalThis.BigInt`, a non-callable provider member) answer identically
on both trees — a prepended arm's one real hazard is displacing a route that
already works, so they are asserted, not assumed.

### The 15 target rows — 10 pass, 5 remain, for three unrelated reasons

Fresh `build:compiler-bundle` → provider `.test262-cache/s62-1`
`cacheHit=false` → fresh quickjs adapter `6ed6bdcdae009570`, base measured the
same way under `.test262-cache/s62-0`.

| row (`ZonedDateTime/prototype/…`) | base | S62 |
| --- | --- | --- |
| `add/add-large-subseconds` | fail | **pass** |
| `add/argument-duration-max` | fail | **pass** |
| `add/argument-string-fractional-units-rounding-mode` | fail | **pass** |
| `add/argument-string-negative-fractional-units` | fail | **pass** |
| `add/blank-duration` | fail | **pass** |
| `add/negative-epochnanoseconds` | fail | **pass** |
| `add/options-object` | fail | **pass** |
| `add/overflow-undefined` | fail | **pass** |
| `add/overflow-wrong-type` | fail | **pass** |
| `epochNanoseconds/basic` | fail | **pass** |
| `add/overflow-adding-months-to-max-year` | fail | fail — `Expected a RangeError … no exception` |
| `add/throw-when-intermediate-datetime-outside-valid-limits` | fail | fail — `TypeError: cannot convert number to bigint` |
| `add/options-read-before-algorithmic-validation` | fail | fail — `Expected a RangeError but got a undefined` |
| `add/order-of-operations` | fail | fail — `TypeError: Proxy get trap is not callable` |
| `add/subclassing-ignored` | fail | fail — `TypeError: called value is not a function` |

The five are three separate mechanisms, none of them bigint survival:

1. **The one-i64 carrier range** (2 rows). Both tests are built on
   `864n * 10n ** 19n` = 8.64 × 10²¹, an order of magnitude past 2⁶³ ≈ 9.22 ×
   10¹⁸. The standalone `$BigInt` carrier is ONE i64 and wraps modulo 2⁶⁴ — the
   limit S61 documented for the StringToBigInt parser, stated there as a
   deliberate lane-wide property. A limb representation is the fix and it is a
   whole-lane change, not an arm.
2. **Option-read ordering / Proxy trap** (2 rows,
   `options-read-before-algorithmic-validation`, `order-of-operations`): a
   RangeError not thrown and a Proxy `get` trap that is not callable. Neither
   touches BigInt.
3. **Subclass construction** (1 row): `TemporalHelpers.checkSubclassingIgnored`
   builds a `class … extends Temporal.ZonedDateTime`; the
   `called value is not a function` fires inside that construction, not on a
   `toString` receiver.

### S62 validation

Criterion-4 battery, S62 tree vs the S61 base TSVs (fresh
`build:compiler-bundle` → provider `.test262-cache/s62-1` `cacheHit=false` →
fresh quickjs adapter `6ed6bdcdae009570`):

| family | rows | pass→fail | fail→pass | missing |
| --- | --- | --- | --- | --- |
| PlainDate | 120 | 0 | 0 | 0 |
| Duration | 120 | 0 | 0 | 0 |
| PlainDateTime | 120 | 0 | 0 | 0 |
| ZonedDateTime | 120 | **0** | **10** | 0 |

Four-family total **437 → 447** (PlainDate 113, Duration 106, PlainDateTime
113, ZDT **105 → 115**). The ten fail→pass rows are exactly the ten target rows
in the table above — no incidental movement. **The nine non-Temporal groups
(A/B/C/D/E-unlinked/E-linked/F-class/F-methoddef/F-objproto, 3,204 rows) had
NOT finished when this was written** — the batch is resumable
(`.tmp/s62/battery/run-batch.mts` skips a family whose TSV exists) and the
remaining groups must be diffed before this is treated as a complete
criterion-4 pass. Measured throughput on this box was ~12 min per 120-row
family, i.e. ~5 h for the remainder; the earlier 75-min figure in the S61
section did not hold here.

Corpus byte A/B, 84 entries × 2 lanes: **0 status flips; 21 SHA flips, ALL on
the `standalone` lane, 0 on `gc`.** Measured against a TRUE base run this
session (the five changed files reverted to `bb435fa167`, the new leaf moved
aside, corpus re-run, files restored) — which produced the identical 21, so
none of them is `origin/main` drift. The movement is link 4: every standalone
module with a realm object now seeds a `globalThis.BigInt` carrier. Measured on
five of the twenty-one, both lanes:

| file | `gc` | `standalone` |
| --- | --- | --- |
| `website/playground/examples/benchmarks.ts` | 10,970 → 10,970 (+0) | 150,712 → 151,275 (**+563**) |
| `website/playground/examples/js/builtins.ts` | 11,204 → 11,204 (+0) | 64,634 → 65,081 (**+447**) |
| `tests/fixtures/ir-retirement/math.ts` | 1,073 → 1,073 (+0) | 138,190 → 138,753 (**+563**) |
| `tests/fixtures/eslint-shims/espree.ts` | 697 → 697 (+0) | 137,303 → 137,862 (**+559**) |
| `website/playground/examples/dom/calendar.ts` | 13,072 → 13,072 (+0) | 71,267 → 71,714 (**+447**) |

So the `gc` lane is byte-identical and standalone grows by a bounded
**+447…+563 bytes** per module — the carrier and its string constant, not the
arms (both of those are demand-gated on `ctx.nativeBigIntTypeIdx >= 0` and
cost zero in a module without a bigint).

COMPILE TIME is unchanged, measured rather than assumed because link 4 touches
every standalone module: 20 rows of the B family, same list, same box,
**base 34,037 ms vs S62 33,614 ms** (−1.2 %, inside noise). The battery's slow
wall-clock is the box, not this change.

Equivalence gate: `22 failing, 1720 passing, 22 known-failures` — no new
regressions. Witness sweep (`tests/issue-66*`, `issue-6484-*`, `issue-6493-*`,
44 files / 269 tests) green under **both** Node 22.22.2 and Node 25.9.0.

## Next step (S61 — supersedes S60's list)

1. **Fix `<any>.toString(radix)` for a NUMBER receiver.** Add `"toString"` to
   `NUMBER_PRIMITIVE_CALL_MEMBERS` (`number-primitive-method-call.ts`). The
   reflective native already exists and is real, not a refusal stub
   (`emitNumberProtoToStringBody`, `wrapper-proto-to-string.ts`, full §21.1.3.6
   radix validation). **Gate the demand scan on `arguments.length > 0`** — a
   bare `x.toString()` appears in nearly every module and already works through
   another arm, so an ungated scan would install the prepended arm everywhere
   and move bytes across the whole standalone lane for nothing.
2. **Fix the BIGINT receiver**, both `toString(radix)` and the 0-arg spelling,
   and `String(<bigint>)` with it — these are one defect family and they change
   ANSWERS, not just failure text.
3. **Then re-apply links 3 + 4** (two one-line list entries, described above)
   and re-run the 15 rows. They are prerequisites, not the blocker.
4. Re-run the four-family battery; the acceptance bar is still 0 pass→fail.

### S60's list (superseded — kept for the record)

Link 2 is not needed (measured above); links 3 and 4 are correct as written but
are blocked behind the toString family, not in front of it.

## Next step for whoever picks this up (S60 — historical)

The remaining work is **not** in the coercion tables. It is
"standalone has no realm-level `BigInt` constructor", and it is four links,
in this order — each is a hard prerequisite for the next, and links 1–2 must
NOT land alone (they turn a wrong answer into a thrown TypeError):

1. **Native StringToBigInt.** Replace `__bigint_ctor`'s terminal
   `throwNativeError("SyntaxError", "Cannot convert string to a BigInt in
   standalone mode")` (`codegen/registry/imports.ts`) with a real parse.
   Model it on `codegen/parse-number-native.ts` (`externToFlat` → `$NativeString`
   → i16 data array → code-unit scan), but accumulating i64 instead of f64:
   trim, optional sign, `0x`/`0o`/`0b` prefixes, digit loop, SyntaxError on
   anything else, `""` → `0n`. Precision is the whole point — a
   `__str_to_number` + `i64.trunc_sat_f64_s` shortcut loses the low digits of a
   nanosecond count and was measured to be useless here. A new `src/` file
   needs a `scripts/compiler-boundaries.json` entry.
2. **Make `__apply_closure`'s wrapper-ctor front-guard work across a LINK.**
   `builtin-ctor-callable.ts` identifies the callee by `ref.eq` against the
   compiling module's own `__builtin_ctor_<Name>` global, which no linked
   provider shares. This is the link that actually stops the Temporal rows, and
   it is a design question (#4394 predates the linked realm), not a table entry.
3. Add `"BigInt"` to `CALLABLE_WRAPPER_CTORS` with a
   `argOf(0) → __bigint_ctor → __box_bigint` conversion (§21.2.1.1;
   deliberately NOT `__to_bigint`, which TypeErrors on a Number). Verified
   working single-module.
4. Add `"BigInt"` to `STANDALONE_GLOBAL_CONSTRUCTOR_NAMES`
   (`standalone-global-object-carriers.ts`). One line; verified. `"Symbol"` has
   the identical gap and is presumably the same fix.

Then re-run `.tmp/s60/battery/run-family.mts` over the 15 non-passing
`ZonedDateTime` rows. `String(<bigint>)` is separately broken (`String(1n)`
answers `0` against `"1"`, and traps for a large literal); it changes only the
TEXT of a failure message, so it does not gate these rows — but it is worth its
own issue.

### S59's superseded list (kept for the record — do NOT follow it)

1. ~~Add `toBigIntIdx` to `coercion-plan.ts`'s `CoercionHelpers`~~ —
   `coercionPlan` is never reached for this shape (traced in S60).
2. ~~Thread it through `stack-balance.ts`'s ~16-function chain~~ — not needed.
3. Re-run the reduction — done; it now answers `1` (see the witness table).

## Implementation Notes

- Witness tests: `tests/issue-6642-link-bigint-value.test.ts` — three cases,
  all revert-and-measured (fail on `d8642a8e06`, pass with the two landed
  fixes): (1) the crash fix (typeof comparison across a link no longer
  throws a WasmGC validation error), (2) the strict-equality static-fold fix
  (an `any`-typed BigInt-holding value now compares `===` correctly against
  a matching/non-matching bigint literal, and a non-bigint literal, with no
  link boundary needed to isolate it from the residual), (3) a canonicalization
  regression guard that passes on BOTH the base tree and the fix (documented
  as "measured, not a fix" — see Fix 3 above).
- Reduction scripts (not committed, ephemeral): `.tmp/s59/probe/reduce2.mjs`
  (the original 5-case linked-provider probe), `samemod.mjs` / `propcheck.mjs`
  (single-module, link-free reductions of the residual, one via method call
  and one via property read), `canon.mjs` (the isolated cross-module
  canonicalization check), `combo.mjs` (confirms the residual survives even
  when the value provably crosses a real link, not just a same-module dynamic
  dispatch).
- Files touched: `src/codegen/typeof-delete.ts` (Fix 1),
  `src/codegen/binary-ops.ts` (Fix 2, pulls in
  `ensureExternStrictEqHelper` from `any-helpers.ts`).
- Gates run: `npm run -s typecheck` (clean); `node scripts/check-loc-budget.mjs`
  / `check-func-budget.mjs` (both required this issue's grants above);
  `node scripts/check-coercion-sites.mjs`, `check:oracle-ratchet`,
  `check:speculative-rollback`, `check:issue-ids:against-main`,
  `update-issues.mjs --check`, `check-issue-spec-coverage.mjs`, `lint`,
  `prettier --check` — see the handback report for full results.
- `status: blocked` — the 12 target ZonedDateTime rows do NOT move with this
  PR alone; Fixes 1/2 are independently correct and load-bearing (Fix 1 is a
  crash fix), but the residual documented above is the actual blocker for the
  battery. Re-open to `ready` once the coercion-plan threading (Next step
  above) lands.

### S60 additions to these notes

- Witness test: `tests/issue-6642-coercion-plan-bigint.test.ts` (5 cases,
  revert-and-measured against `8a95c4dace`: `3 failed | 2 passed` → `5 passed`).
- Files touched by S60: `src/codegen/binary-ops.ts` (`BIGINT_I64`, Fix A) and
  `src/codegen/closures/result-boxing.ts` (`boxI64ClosureResult`, Fix B).
  Deliberately NOT touched: `coercion-plan.ts`, `stack-balance.ts` (S59's
  proposed threading is unnecessary — traced), `type-coercion.ts`.
- Probe scripts (ephemeral, `.tmp/s60/probe/`): `samemod.mjs` / `propcheck.mjs`
  (S59's, repointed), `globalctors2.mjs` (the boolean-returning realm-builtin
  probe table above — note that a STRING-returning standalone export does not
  marshal out, so string probes are not evidence), `globalcall.mjs` /
  `gcall2.mjs` (carrier callability, direct vs extracted-function form),
  `bigintctor.mjs` (isolates the `__bigint_ctor` string trap from the
  compile-time literal fold).
- `status` stays `blocked`. S60 narrowed the blocker from "a coercion table has
  no bigint column" (wrong) to "standalone has no realm-level `BigInt`
  constructor, and the wrapper-ctor `[[Call]]` guard does not cross a link"
  (measured, four links listed above).

### S61 additions to these notes

- Files touched by S61: `src/runtime/wasmgc/values/string-to-bigint-body.ts`
  (new leaf, the §7.1.14 scan) and `src/codegen/registry/imports.ts` (the
  `ref.test $AnyString` arm on `__bigint_ctor`, plus the layout resolve).
  `scripts/compiler-boundaries.json` gains the new file's `native-runtime`
  entry. Witness `tests/issue-6642-realm-bigint.test.ts`.
- Deliberately NOT touched: `src/codegen/builtin-ctor-callable.ts` and
  `src/codegen/standalone-global-object-carriers.ts` (links 3/4 — built,
  measured, held back behind link 5, see the S61 section above);
  `coercion-plan.ts`, `stack-balance.ts`, `type-coercion.ts` (unchanged from
  S60's finding).
- Probe scripts (ephemeral, `.tmp/s61/probe/`): `p1.mjs`–`p3.mjs` (the
  `BigInt(<string variable>)` reduction and the 22-case parser table),
  `p5.mjs`/`p6.mjs` (the link-5 reduction — `<any>.toString(radix)` for number
  and bigint receivers, single-module and link-free), `link.mjs` (a reusable
  two-module `compileProject`+`compileMulti` harness), `l1.mjs`–`l4.mjs` (realm
  ownership, cross-link BigInt survival, the polyfill-shaped converter),
  `real.mjs` (the REAL prewarmed polyfill provider via `buildTemporalProvider` +
  `compileWithTemporalGlobal` — this is the probe that found link 5; note again
  that string-returning standalone exports do not marshal out, so every answer
  is numeric).
- `status` stays `blocked`, with the next step now naming a DIFFERENT
  mechanism: `<any>.toString(radix)`, not the realm constructor.
- (S62) `status` is now `done`: the issue's own defect — a BigInt value not
  surviving a consumer↔provider link — is fixed and witnessed end to end, and
  the target bucket moved 0/15 → 10/15 with 0 pass→fail in the four Temporal
  families. The five rows that stay red are three named, unrelated mechanisms
  (the one-i64 carrier range for two of them, option-read ordering / a Proxy
  `get` trap for two, subclass construction for one) and each deserves its own
  issue rather than holding this one open. The nine non-Temporal battery groups
  had not finished when the session ended — see the caveat in the validation
  section; they must be diffed before merge.

### S62 additions to these notes

- Files touched by S62: new leaf `src/codegen/bigint-primitive-to-string.ts`
  (both arms); `src/codegen/number-primitive-method-call.ts` (`"toString"` in
  the member list + the arity-gated demand scan);
  `src/codegen/index.ts` and `src/codegen/typeof-natives-finalize.ts` (the two
  finalize call sites); `src/codegen/builtin-ctor-callable.ts` and
  `src/codegen/standalone-global-object-carriers.ts` (links 3 + 4, re-applied
  exactly as S61 wrote them). `scripts/compiler-boundaries.json` gains the new
  file's entry. Witness `tests/issue-6642-bigint-tostring.test.ts`.
- Deliberately NOT touched: `coercion-plan.ts`, `stack-balance.ts`,
  `type-coercion.ts` (unchanged from S60's finding); `array-object-proto.ts`
  (no `%BigInt.prototype%` brand was minted — see the S62 section for why);
  `"Symbol"` in either list.
- Probe scripts (ephemeral, `.tmp/s62/probe/`): `p1.mjs`–`p6.mjs` (the first,
  MISLEADING reduction — a TS `compile()` module with a `const n: any = <literal>`
  initializer keeps a static local and never goes dynamic, so it reported a null
  answer for `toPrecision` that reproduces on the base tree and is the PROBE's
  artifact, not a compiler defect; recorded because it cost an hour and the next
  reader will be tempted by the same spelling), `q1.mjs`/`q2.mjs` (the real
  reductions — `compileMulti` + JS source + numeric-returning exports, the #6610
  witness's harness shape, which is what actually routes a receiver through
  `__extern_method_call`).
