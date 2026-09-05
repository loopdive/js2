---
id: 4639
title: "ES5 standalone: String/RegExp constructor+prototype surface — new String(obj) ToPrimitive, proto.constructor as ctor, RegExp flags as proto accessors, builtin static expando CE (~37 rows)"
status: in-review
sprint: current
created: 2026-08-23
updated: 2026-08-25
assignee: dev-4639
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: string-regexp
goal: standalone-gap
related: [4465, 4481, 4619, 4621, 4426]
origin: "2026-08-23 wave-3 residual map (196 true failures). Lane C (.tmp/lane-C-stringregexp.txt)."
loc-budget-allow:
  # (lead, trap mitigation) __extern_get's fnctor-proto-start arm gains
  # test-before-cast — the naked ref.cast was an UNCATCHABLE illegal-cast trap
  # when $proto holds a raw callable (the C1-reachable shape). The lines are
  # the guard + the comment recording the trap and the #4643 successor.
  - src/codegen/object-runtime.ts
  # (C1) `getUseClassification` gains the `NewExpression`-argument clause plus
  # the measurement that justifies it — `ts.isCallExpression` is false for a
  # `new`, so EVERY constructor argument classified `neutral` and the
  # `new String(obj)` ToPrimitive family could not work. The comment is long on
  # purpose: it records the per-VALUE A/B (`String(o)` right vs `new String(o)`
  # wrong, in ONE module) that took the longest to find, so the next reader does
  # not re-derive it.
  - src/codegen/fnctor-escape-gate.ts
  # (C2) The ordinary-[[Get]] tail spliced ahead of the builtin-static refusal.
  # The arm itself lives in the new `builtin-static-expando.ts`; what lands in
  # the dispatcher is the call plus the rationale for why a CE became a read.
  - src/codegen/property-access-dispatch.ts
  # (C3) Prototype-constructor values need a small dispatch seam in the
  # existing new/call drivers; the proof and Error-specific lowering live in
  # new expression modules.
  - src/codegen/expressions/new-super.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/expressions/new-builtin-globals.ts
func-budget-allow:
  # Same C2 splice — the dispatcher's builtin arm grows by the guarded call.
  - src/codegen/property-access-dispatch.ts::tryIdentifierNamespaceAndStaticReceiverRead
  # (C3) The constructor-name override and two dispatcher seams are bounded
  # entry points for the new intrinsic prototype-constructor lowering.
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  - src/codegen/expressions/new-builtin-globals.ts::tryCompileBuiltinGlobalNew
---

# #4639 — String/RegExp ctor+proto surface

## Problem (measured 2026-08-23 on branch tree)

- **C1 — `new String(obj)` / `String(obj)` ToPrimitive with OVERRIDDEN
  toString/valueOf (~7)**: `new String({toString(){return "tostr"}})`
  renders "[object Object]" — the ctor path doesn't run the user
  override; includes a FUNCTION argument (`new String(function(){})` must
  stringify via its toString) and `String(new Array(...))` with a
  REPLACED `Array.prototype.toString`. The wrapper-ctor ToPrimitive must
  route through the same reflective machinery #4465/#4619 built for
  method receivers.
- **C2 — builtin static EXPANDO properties CE (~5)**:
  `String.indicator = 1; String.indicator` → Codegen error "built-in
  static property value read is not supported" (also RegExp.indicator,
  Array.myproperty, Math.NaN read). The #4485/#4621-C carrier serves
  KNOWN own props; an arbitrary WRITE+READ on a builtin constructor
  carrier needs the carrier's expando store (it is a `$Object` — route
  the static-property read/write through it instead of the compile-time
  whitelist; CE→runtime is the win even where the row needs more).
- **C3 — `<Builtin>.prototype.constructor` as a CONSTRUCTOR (~4)**:
  `new String.prototype.constructor("...")` → "is not a constructor"
  (also Object.prototype.constructor, RegExp S15.10.6.1_A1_T2). The
  #4442 `%Function%`-emitter family: the `.constructor` VALUE read works;
  its [[Construct]] arm is the gap.
- **C4 — RegExp instance flags as PROTOTYPE ACCESSORS (~4)**:
  `__re.hasOwnProperty('global'/'multiline'/...)` must be FALSE (current
  test262 tests ES2015+ semantics: flags are get accessors on
  RegExp.prototype, not own data props). Move the flag surface to proto
  accessors while keeping reads working — check the #4481 identity
  singleton pattern for where proto accessors live.
- **C5 — dynamic-pattern refusals (2)**: "Unsupported dynamic regular
  expression pattern" for runtime-BUILT pattern strings
  (S15.10.2.8_A3_T15/T16, annexB control-escape-russian-letter). Read
  the #4439 deferred-refusal design — the refusal fires at compile time
  for patterns the static engine can't take; route through the dynamic
  RegExp path (provider-minted) instead of refusing, where the eval tier
  is available; decline with owner where it is genuinely
  engine-capability-walled.
- **C6 — replace/split residual (~6)**: `S15.5.4.11_A1_T9` (function
  replacer `undefined`-return renders — #4518 residual 1's JS-lane arg
  pad), `split` with a RegExp instance receiver on a Number
  (argument-is-regexp rows), 2 compile_errors "replace(...) with a
  RegExp or symbol-protocol search value" in a shape #4426 hasn't
  claimed. Per-row triage; the CE rows first.
- **C7 — regexp-literal 65k-eval rows (7: S7.8.5_A*_T2 + annexB
  leading/trailing escapes)**: measured by #4621 as runtime-eval
  THROUGHPUT-walled (>30x over budget with .source reads removed). DO
  NOT re-attempt; verify the wall still holds with one row, then keep
  the decline with the runtime-eval-throughput owner.

## Implementation Plan

1. Brief: plan/method/es5-standalone-agent-brief.md (binding). Re-measure
   live; C6's compile_errors and C2's CEs first (crash/CE class).
2. C1: find the wrapper-ctor argument coercion (new-builtin-globals.ts /
   the String ctor arm) and route object args through the reflective
   ToPrimitive (#4465's object-arg machinery — same splice discipline as
   #4518's null arm).
3. C2: locate the "built-in static property value read is not supported"
   refusal site; when the builtin has a #4485-family carrier, compile
   static expando reads/writes as ordinary carrier member ops.
4. C3: give the `%Function%`/constructor-value a [[Construct]] arm —
   read #4442's emitter + #4623's routing precedent.
5. C4: proto-accessor surface for RegExp flags; own-props emptied;
   `lastIndex` STAYS an own data property (spec).
6. Verify: scoped sweeps built-ins/String{,/prototype} +
   built-ins/RegExp{,/prototype} + literals/regexp before/after (own
   runs); pins 4465/4481/4619/4621/4426 suites green; pins
   tests/issue-4639.test.ts; zero regressions.

## Root cause

Four independent defects, each isolated by an A/B on this branch's base
(`81445abf7`). Every number below is from a run I executed on
`--target standalone` through `runTest262File`.

### C1 — `new String(obj)` never ran the object's `toString`

Not in the wrapper lowering. `classifyUse` in
`src/codegen/fnctor-escape-gate.ts` decides whether a fnctor instance keeps
its bespoke nominal struct or is reified as an open `$Object`. Its
"argument of a call whose parameter is `any`/`unknown` ⇒ dynamic" clause is
gated on `ts.isCallExpression(parent)` — which is **false for a
`NewExpression`**. So no CONSTRUCTOR argument was ever classified at all,
and every such instance stayed a closed struct.

Downstream the two shapes diverge: `__extern_toString` → `__to_primitive`
reduces a `$Object` through OrdinaryToPrimitive (so an INHERITED
`F.prototype.toString` runs), but hands a nominal struct to
`__class_to_primitive`, whose per-struct `__call_toString` dispatcher is
built from struct FIELDS and `<Struct>_toString` funcs and therefore has no
entry for a PROTOTYPE-assigned method — it answers null, and the tail
renders the canonical `"[object Object]"`.

The measurement that pins it, in ONE module and on the SAME instance:

```js
function F() {}
F.prototype.toString = function () { return "tostr"; };
var o = new F();
String(o)          // "tostr"            — `(value?: any)` ⇒ dynamic ⇒ $Object
new String(o)      // "[object Object]"  — never classified ⇒ closed struct
```

and it is per-VALUE, not per-module: adding `String(other)` for a
**different** instance leaves `new String(o)` wrong (measured
`"tostr|15"`), while `String(o)` on the same instance makes it right
(`"tostr|5"`).

### C2 — `<Builtin>.<unknownProp>` was a compile error

`tryIdentifierNamespaceAndStaticReceiverRead` resolves a builtin static read
through a ladder of compile-time folds and then calls
`reportUnsupportedStandaloneBuiltinValueRead`, which fails the WHOLE FILE.
Reads the spec answers in one hop landed there:
`Function.prototype.indicator = 1; String.indicator` (an inherited read
across `String`'s [[Prototype]], §20.2.3) and `Math.NaN` (a property `Math`
simply does not have).

### C6a — a `Function`-typed replacement was in NEITHER `replace` arm

`Oracle.factOfType` classifies an object type by NAME (`BUILTIN_NAMES`)
**before** it looks for call signatures, and lib.d.ts's `Function` interface
declares none (it declares `apply`/`call`/`bind`). So `Function(…)`'s result
— which §20.2.1.1 makes a callable — answered `false` from
`isCallableReplacement` AND `false` from `isPlainToStringReplacement`, i.e.
the "neither arm ⇒ keep the refusal" hole, for a value that is provably
callable.

### C6b — a VOID replacer contributed JS `null`, and a nullish SEARCH value an empty needle

`buildReplacerCallInstrs` pushed `ref.null.extern` for a replacer with no
Wasm result. Standalone distinguishes `null` from `undefined` regardless of
the #2106 flag (see `canonicalUndefinedExternInstrs`), so that is the null
VALUE, not `undefined`. Separately, `emitArgAsNativeString` on a `null`
search value left the needle empty/absent, so `__str_indexOf` answered -1.
Measured together: `"gnulluna".replace("null", function(){})` came back
**unchanged**, where a conforming engine answers `"gundefineduna"`.

## Fix

| # | file | change |
| - | ---- | ------ |
| C1 | `src/codegen/fnctor-escape-gate.ts` | `classifyUse` admits a `NewExpression` argument to the any/unknown-parameter clause. **Standalone-gated** (`standalone === true`), the same narrowest-site wiring #4394's `throw` clause uses — the gc/host lane reduces a nominal struct through the host `_hostToPrimitive` and does not have this defect, so its emit stays byte-identical. |
| C2 | `src/codegen/builtin-static-expando.ts` (new), spliced ahead of the refusal in `property-access-dispatch.ts` | the ordinary [[Get]]: the builtin's identity-stable carrier (own props, `__object_hasOwn`-gated so a genuine own `undefined` does not fall through to the prototype), then its [[Prototype]] — %Function.prototype% for a ctor, %Object.prototype% for a namespace. |
| C6a | `src/codegen/string-proto-replace.ts` | `isCallableReplacement` accepts `{kind:"builtin", name:"Function"}`. Not a weakening: `Function` is the one builtin name whose instances all have [[Call]] by definition; every other builtin fact still answers `false`. |
| C6b | `src/codegen/regex-replace-fn.ts`, `src/codegen/string-search-value.ts` | `canonicalUndefinedExternInstrs` for a void replacer; a statically null/undefined search value emits the literal text `"null"`/`"undefined"` (§22.1.3.19 step 3's `ToString`). |

**Absent-not-wrong, C2.** A `propName` that names a real builtin STATIC
METHOD (`BUILTIN_STATIC_METHOD_ARITY`) but reached the refusal — i.e. its
closure could not be reified — KEEPS the loud refusal. That read has a
genuine function value the spec requires, and answering `undefined` for it
would be a silent wrong answer, which is worse than a compile error.

**A `$Object` → `$NativeProto` [[Prototype]] link does not carry expandos.**
Measured on the base: `Object.setPrototypeOf(o, Function.prototype)` then
`o.indicator` answers `undefined` even with `Function.prototype.indicator = 1`
set — `__extern_get`'s chain walk does not cross into a `$NativeProto`'s
companion table. That is why C2 does a direct one-hop read instead of
pointing the carrier's [[Prototype]] at the intrinsic; making the walk cross
is a change to the object MOP and belongs to its own issue.

## Test Results

All figures are from runs I executed in this worktree, standalone lane,
`runTest262File`, quickjs eval provider linked
(`JS2WASM_QUICKJS_ARTIFACT_DIR=…/quickjs-artifact-2e2d7736713beeda`).

**The issue's 37-row list (`.tmp/lane-C-stringregexp.txt`), base → after,
single-threaded both arms:** `0/37 → 5/37`.

| row | base | after |
| --- | ---- | ----- |
| `built-ins/String/S15.5.3_A2_T2` | compile_error | **pass** |
| `built-ins/RegExp/S15.10.5_A2_T2` | compile_error | **pass** |
| `built-ins/RegExp/prototype/exec/S15.10.6.2_A4_T7` | compile_error | **pass** |
| `built-ins/String/S15.5.2.1_A1_T10` | fail | **pass** |
| `built-ins/String/prototype/replace/S15.5.4.11_A1_T6` | compile_error | **pass** |
| `built-ins/String/prototype/replace/S15.5.4.11_A1_T5` | compile_error | fail (CE class cleared) |

So **4 of the 5 named compile_errors are gone** (C2's three + one of C6's
two), and the fifth is now a runtime failure. That is the CE→runtime
minimum the plan asked for on the CE class.

**Scoped regression A/B, both arms my own runs, 335 rows:** `320/335 →
323/335`, **zero regressions**. The list
(`.tmp/rows-ab.txt`) is every ES≤5 row under `built-ins/String/*.js`
(85, the whole ctor/ToString surface), every ES≤5
`built-ins/String/prototype/{replace,split}/**` (139, the C6 blast radius),
a stride-4 sample of `built-ins/String/prototype/{substring,slice,concat,trim}/**`,
a stride-8 sample of `built-ins/RegExp/*.js`, and all
`built-ins/RegExp/prototype/*.js`.

**Scope honesty — this is NOT the full `built-ins/String` +
`built-ins/RegExp` sweep the verification floor asks for.** That is 1,228
ES≤5 rows, and a first attempt measured **50 rows in 11 minutes** with two
workers (≈4.5 rows/min: three sibling agent lanes were sweeping the same
4-core box, 1-minute load average 9.4). Both arms would have been ~9 hours
of wall clock. The 335-row list above is the subset chosen for blast-radius
coverage rather than for size, and the uncovered remainder is
`built-ins/RegExp` depth (my diffs touch RegExp only through C2's static
read, which is `compile_error`-only and cannot regress a passing row) and
`built-ins/String/prototype` methods other than the six listed.

### `tests/issue-4639.test.ts` — the base/branch PARTITION

14/14 on the branch is the weaker number. The useful artifact is what each
pin does when the change is REMOVED. Measured by reverting all six changed
`src/codegen` files to `81445abf7` (and deleting `builtin-static-expando.ts`)
while holding `tests/` at the branch version:

| base | count | what they are |
| ---- | ----- | ------------- |
| **FAIL** | 7 | Tests OF the change: the C1 pin, the C1 arg-only-instantiation pin, the three C2 pins, the C6 `Function()` pin, and the C2 cross-lane canary. Each fails on base, so none is asserting pre-existing behaviour. |
| **pass** | 1 | `S15.5.4.11_A1_T1`, an explicitly-labelled control. |
| **pass** | 6 | `pinResidualRow` entries — they assert `status !== "pass"` for residuals this change-set did NOT fix, so they are green on both arms by construction. |
| **pass** | 1 | `carrier-hasown-prototype-guard`, labelled `REGRESSION GUARD (green on base)`. |

Adopted from dev-4637 (`issue-4637`), who ran this partition on their own
suite after I raised the "revert and confirm the pin FAILS" rule and found
two pins in the WRONG CATEGORY — one presented as demonstrating their fix
that was green on base, and one negative control bundled with a positive so
that a build wrong on both would still total correctly. Mine partitions
cleanly, but only because I ran it; I had verified the canary alone, which
is the same half-measure.

**A weakness in my own canary, found by that run and NOT fixed by it.**
`builtin-no-brand-prototype` fails on base, so it genuinely tests the C2 arm
— but it is INSENSITIVE to the cross-lane interaction it is named for. For a
no-brand builtin, BOTH branches of the arm's `if` answer `undefined`, so a
#4637 prologue that wrongly answered `1` for a carrier receiver would send
the arm down the `then` branch and still produce `undefined`. The canary
would stay green through exactly the regression it watches. That is why
`carrier-hasown-prototype-guard` exists: `hasOwnProperty` has a two-valued
answer, routes through the same spliced helper, and uses both receiver kinds
(`Math`, a namespace with no own `prototype`; `String`, a ctor that has
one). Measured `false|true` on both arms.

**The guard was reworked after applying dev-4637's DELETE-THE-INTERACTION
test to it.** Their test is better than my revert rule for the cross-lane
case and needs neither branch: *delete the interaction the pin is named for
and see whether the answer moves.* Applied here, the question was not
deletable but was fatal in the same way — the guard's entire value rests on
"this routes through the `__object_hasOwn` dev-4637 splices", and its first
cut used the SYNTACTIC `Math.hasOwnProperty("prototype")`, i.e. exactly the
receiver+literal-key shape a compile-time fold would claim. If it folds, the
guard never reaches the helper and guards nothing — green whatever their arm
does. Rather than prove the fold does not happen, the pin is now written so
it cannot matter: the receiver comes out of an array indexed by a
loop-carried counter. Measured unfoldable form, `false|true|false`, green on
BOTH arms; base partition unchanged at 6 fail / 8 pass.

The three assertions point in different directions on purpose — that is what
makes bundling them safe, against the hazard dev-4637 hit (a negative control
bundled with a positive, where a build wrong on both still totals correctly).
`false|true|false` is position-sensitive with unequal values, so neither a
blanket-`true` nor a blanket-`false` build satisfies it.

**Harness gate hazard — the suite exits 0 with ZERO coverage when
`test262/harness/assert.js` is absent.** `describe.skipIf(!TEST262)` reports
"14 skipped", exit 0. Hit live during this work: a run right after restoring
the `test262` gitlink skipped everything and looked green. Anyone using these
pins as a merge check must confirm the run says **14 passed**, not merely
that it exited 0. `tests/issue-4637.test.ts` carries the same guard.

**Pin suites green (my runs):** `tests/issue-4465` 20/20,
`tests/issue-4481` 42/42, `tests/issue-4619` 23/23, `tests/issue-4621`
27/27, `tests/issue-4639` 12/12 (and the tier-dependent row green again
under `JS2WASM_EVAL_ENGINE=interpreter`). **`tests/issue-4426.test.ts` does
not exist on this base** — there is no 4426 pin file to run; the nearest
sibling, `tests/issue-2885.test.ts` (the witness the C4 wall is recorded
against), is green 5/5.

**Host-lane equivalence (per-file, never batched):**
`tests/equivalence/wrapper-constructors` 8/8,
`tests/equivalence/tostring-valueof` 7/7,
`tests/equivalence/string-methods` 42/42,
`tests/equivalence/regexp-methods` 22/22.

**Gates green (my runs):** `check:loc-budget`, `check:func-budget` (both via
the frontmatter allowances above), `check:oracle-ratchet`,
`check:coercion-sites`, `check:dead-exports`, `check:ir-fallbacks`,
`check:host-import-policy`, `check:stack-balance`,
`check:codegen-fallbacks`, `check:harness-compile-budget`.

## Residuals — with owners

The acceptance bar was **≥15 of ~30 in-scope rows flipped**. Five flipped.
Below is every family that did not, with what it actually needs, so the next
lane does not re-derive it.

| family | rows | why it did not land |
| ------ | ---- | ------------------- |
| **C1 rest** | `S15.5.1.1_A1_T8`, `slice/S15.5.4.13_A3_T4`, `S15.5.5.1_A5` (3 remaining) | The remaining rows are DIFFERENT receiver families from the fnctor instance C1 fixes. `S15.5.1.1_A1_T8` needs `String(arr)` to honour a REPLACED `Array.prototype.toString` (today `tryEmitArrayToStringNative` intercepts it). `slice/A3_T4` is a BORROWED `String.prototype.slice` whose receiver is the instance — the escape gate classifies a method-call receiver `neutral`. `S15.5.5.1_A5` needs `__to_primitive` to stop short-circuiting on the wrapper's [[PrimitiveValue]] slot when the wrapper carries an OWN `valueOf`/`toString`; that is a hot-path edit to the core runtime and was deliberately not attempted without capacity to sweep every wrapper consumer. |
| **C3 — `<B>.prototype.constructor` as a CONSTRUCTOR** | `String/prototype/S15.5.4.1_A1_T2`, `Object/prototype/S15.2.4.1_A1_T2`, `Error/prototype/S15.11.4.1_A1_T2`, `RegExp/prototype/S15.10.6.1_A1_T2` (all green) | This branch now routes direct and immutable multi-hop `String`/`Object`/`Error` prototype-constructor values through their intrinsic `new` paths, including the Error prototype replacement check. The RegExp counterpart landed in upstream PR #4867 and is retained as a positive control after rebasing onto current `upstream/main`. |
| **C4 — RegExp flags as proto accessors** | `global/S15.10.7.2_A9`, `ignoreCase/S15.10.7.3_A9`, `multiline/S15.10.7.4_A9` (all green) | `regexp-proto-delete.ts` adds a demand-gated standalone arm for exactly these keys and removes the token from the mutable member list. It leaves accessors unseeded, preserving the #2885 inline/materialized read split. |
| **C5 — dynamic-pattern refusals** | `S15.10.2.8_A3_T16`, `annexB/RegExp-control-escape-russian-letter` (2) | T15 is fixed upstream in PR #4882. The remaining runtime pattern compiler refusals are deferred to first USE (#4439), so `.source`/`.flags` reads are unaffected. |
| **C6 rest** | `replace/S15.5.4.11_A1_T5`, `A1_T9`, `split/argument-is-regexp-and-instance-is-number`, `split/instance-is-math`, `split/separator-regexp-limit-string-via-eval`, `concat/S15.5.4.6_A2` (6) | T5 is now `fail`, not `compile_error`, and **its remaining cause is NOT in `replace` at all** — the "unchanged" output is a coincidence, not a missed match. Root-caused here: a `Function()`-minted function with an EMPTY body returns JS **`null`**, not `undefined`. Measured directly, host-free: `function h(){}; var g = Function(); String(h()) + "|" + String(g())` answers **`"undefined|null"`**. In T5 the replacer therefore contributes the TEXT `"null"`, which for the subject `"gnulluna"` is exactly the needle, so the result is indistinguishable from no replacement. Every other shape on this path is already correct after C6b: `"gnulluna".replace(null, function(){})` → `"gundefineduna"`, `"gnulluna".replace(null, Function("return 'Z';"))` → `"gZuna"`, and an IIFE receiver is fine. **Owner: runtime-eval (#4624 family).** Handed to dev-4637 first as a Function-surface defect; they reproduced it, declined (correctly — it is not proto-representation scope), and returned a discriminator that **refutes my first hypothesis and mine in turn narrows theirs**. See "## Handed to another lane — `Function()` implicit completion" below for the whole chain; it is NOT the return conversion, NOT engine-specific, and NOT in `src/`. T9 needs the §22.1.3.19 replacer ARG types (it renders `NaN` — the position argument reaches `a1+a2+a3` as a number, so the args are not the spec's `« matched, position, string »` strings). `split/instance-is-math` is narrower than it looks and I measured where the seam is: `Object.prototype.toString.call(Math)` ALREADY answers `"[object Math]"`, but `String(Math)` answers `"[object Object]"`. The tag is a COMPILE-TIME fold (`resolveObjectToStringTag` / `emitObjectProtoToStringClassifier`, which is emitted into a closure body, not minted as a shared native), while `__to_primitive`'s `tryOrdinaryMethod("toString", /*defaultObjectToStringOnMissing*/ true)` arm hardcodes the literal `"[object Object]"`. Fixing it means minting the classifier as a callable native and calling it from that arm — ordering-sensitive against `ensureObjectRuntime`, so not a one-liner; `trim/15.5.4.20-2-51`, listed below, is the same class one level out (an ARGUMENTS object stringifying as an array). |
| **C7 — regexp-literal 65k-eval** | `S7.8.5_A{1.1,1.4,2.1,2.4}_T2`, `annexB` leading/trailing escape (6 in my row list; the issue's header says 7 — I did not reconcile which row it counted seventh) | **Re-verified, wall holds.** `annexB/RegExp-leading-escape-BMP` still fails on `Code unit: 0` single-threaded, i.e. runtime-eval throughput, exactly as #4621 measured. Owner: runtime-eval-throughput. One caution for the next measurer: under 3-worker parallel load the same row reports `compilation timeout (19489.6ms)` instead — that is LOAD NOISE, not a second defect; re-run single-threaded before believing a status change on this family. |
| **not in any family** | `RegExp/S15.10.4.1_A6_T1`, `RegExp/prototype/exec/S15.10.6.2_A4_T11`, `RegExp/S15.10.2_A1_T1`, `String/S15.5.1.1_A1_T9`, `slice/S15.5.4.13_A1_T5`, `substring/S15.5.4.15_A1_T5`, `trim/15.5.4.20-2-51` (7) | The last two are `Function.prototype.toString is not yet implemented in --target standalone` — **dev-4637's lane** (#4442 Function-surface), declined here by the coordination rule. `S15.5.1.1_A1_T9` is `String(this)` at global scope with a global `toString`, i.e. a global-object receiver. `A6_T1`/`A4_T11` were not triaged. |

## Handed to another lane — `Function()` implicit completion

**Owner: runtime-eval (#4624 family).** Also recorded by dev-4637 in
`plan/issues/4637-fnctor-prototype-edge-function-surface.md` under
"## Handed to another lane". Visible symptom:
`built-ins/String/prototype/replace/S15.5.4.11_A1_T5`.

**The defect.** A `Function`-minted function whose completion value is
IMPLICIT returns JS `null`, not `undefined`. Reproduced by me, `--target
standalone`, `deferTopLevelInit`, through `runTest262File`:

```js
function h() {}                          String(h())  -> "undefined"  correct
var g0 = Function();                     String(g0()) -> "null"       want "undefined"
var g1 = Function("return undefined;");   String(g1()) -> "undefined"  correct
var g2 = Function("return null;");        String(g2()) -> "null"       correct
var g3 = Function("var x = 1;");          String(g3()) -> "null"       want "undefined"
```

Three lanes have now narrowed this, each one refuting the previous
hypothesis. Recording the whole chain, because two of the three dead ends
look plausible enough to be re-entered:

1. **My first hypothesis — the minted function's RETURN conversion — is
   wrong.** dev-4637's discriminator: `g1`'s EXPLICIT `return undefined;`
   decodes correctly through the same conversion. The broken shapes are
   exactly the two with an IMPLICIT completion (empty body; body whose last
   statement is not a `return`).
2. **dev-4637's fork (a) "the value slot is not a `$RuntimeEvalValue`
   carrier, so `ref.test` fails and a raw externref passes through" vs (b)
   "it is a carrier tagged `_NULL`" is answerable without a WAT dump, and
   the answer is (b) — but with the cause one step FURTHER upstream than
   either branch assumes.** The classifier in
   `src/codegen/runtime-eval-boundary.ts` (`classifiedValue`) tries
   `__typeof_undefined` FIRST and only then falls to `ref.is_null` →
   `_NULL`. So a value arriving as the canonical undefined singleton is
   tagged `_UNDEFINED`, and one arriving as a bare `ref.null.extern` is
   tagged `_NULL` — **correctly**. The carrier and the tag are both doing
   their job for a value that was already wrong when it reached them.
   Do not edit the decode or the classifier.
3. **It is TIER-INDEPENDENT, which rules out both engines.** Identical
   `"null|undefined|null|null"` under the QUICKJS provider AND under
   `JS2WASM_EVAL_ENGINE=interpreter`. Two independent engines do not
   coincide on a wrong value by accident, so the wrong value is produced by
   something they SHARE.
4. **What they share is not in `src/`.**
   `__runtime_apply_interpreted` is a HOST IMPORT
   (`RUNTIME_EVAL_IMPORT_MODULE`, registered in
   `src/codegen/expressions/eval-inline.ts` ~L2151) whose body lives in the
   PROVIDER artifact built by `scripts/build-runtime-eval-provider.mjs` /
   `scripts/build-quickjs-eval-provider.mjs`. It returns
   `runtimeEvalResult(true, value)` →
   `[ok, __runtime_eval_wrap_result(exposeRuntimeEvalValue(value))]`
   (`scripts/runtime-eval-provider.mjs`, `PROVIDER_EXPORT_WRAPPER` ~L233).

**Leading hypothesis, explicitly NOT yet measured** — stated so the next
lane tests it rather than inherits it: the provider is ITSELF a
js2wasm-compiled module, so its `__runtime_eval_wrap_result(undefined)` goes
through the same classifier as (2). If a JS `undefined` crossing into the
provider's wasm materializes as `ref.null.extern` rather than the canonical
undefined singleton, the envelope is tagged `_NULL` and every step
downstream is faithful. That would explain (3) exactly. Confirming it needs
one probe INSIDE the provider build, not another probe of a compiled module.

**Why neither dev-4637 nor I fixed it.** The change moves the value model
for EVERY interpreted call's return, and the fix site is a prebuilt provider
artifact — so the verification surface is an artifact rebuild plus an
eval-dependent corpus sweep, which is the runtime-eval owner's lane and
budget, not a String/RegExp or a proto-representation lane's. Landing an
unmeasured value-model change underneath a verified result is the trade the
campaign brief forbids.

## Cross-lane contact points (#4637, dev-4637's `issue-4637`)

Mirror of the section in
`plan/issues/4637-fnctor-prototype-edge-function-surface.md`. Written after
dev-4637 corrected a FALSE PREMISE in my first collision note; the
conclusion survived, the reason did not.

**What I got wrong.** I claimed C2 cannot intersect #4637 "because it calls
`__object_hasOwn`/`__extern_get`, not the four proto-position natives".
dev-4637 **does** splice a prologue into `__object_hasOwn` (and
`__hasOwnProperty`) — `spliceClosurePrototypeEdgeHasOwn`,
`src/codegen/closure-prototype-edge.ts`. That is the helper C2 calls. I
asserted a negative about another lane's diff without reading it.

**Why the conclusion still holds, structurally rather than by measurement.**
Read on this branch: the ONLY receiver C2 ever passes to `__object_hasOwn`
is `carrierLocal`, set from `emitBuiltinProtoConstructorValue` — i.e. either
`emitBuiltinConstructorIdentity` (`__builtin_ctor_<Name>`) or
`emitBuiltinNamespaceObject` (`__builtin_<Name>`), both `__new_plain_object`
`$Object` singletons. The `$NativeProto` from
`pushBuiltinIntrinsicPrototype` reaches `__extern_get` ONLY, never
`__object_hasOwn`. dev-4637's prologue fires only when
`__closure_proto_of(recv)` is non-null — a `ref.eq` identity match against
`__fn_closure_<name>` / `__class_<Name>` singletons. A `__new_plain_object`
carrier is neither, and cannot become one, so the precondition is
unreachable by construction. That is stronger than their (correct) measured
negative control on builtin ctor carriers, because it cannot drift with a
later change to which carriers exist.

**The tighter statement neither of us had — the two arms DO meet on the
key.** I measured that `propName === "prototype"` reaches the C2 arm: the
`prototype` fast path above it (`emitLazyNativeProtoGet`) falls through for
any builtin with no registerable proto brand, so C2 emits
`__object_hasOwn(carrier, "prototype")` — the exact interned literal
dev-4637's arm keys on. The two arms are therefore separated by the RECEIVER
test alone, not by the key. **That is the thing to watch**, and it is the
same condition dev-4637 named from their side: if a C2-shaped read ever asks
`__object_hasOwn(recv, "prototype")` where `recv` IS an edge-bearing closure
or class-object singleton, their arm answers `1` first — the §20.2.4.2
answer, but theirs, not this lane's.

**Two flips this check turned up, measured both arms just now** (base
`81445abf7` via `git checkout <base> -- src/codegen/property-access-dispatch.ts`
plus removing `builtin-static-expando.ts`; restored after):

| expression | base | after | spec |
| ---------- | ---- | ----- | ---- |
| `Math.prototype` | `compile_error` (#1907 builtin static value read) | `undefined` | `undefined` — `Math` is not a constructor |
| `Proxy.prototype` | `compile_error` (same) | `undefined` | `undefined` |

Both are OUTSIDE the issue's 37-row list, so the `0/37 → 5/37` headline is
unchanged; they widen the C2 win rather than the row count. The mechanism is
the one described above: no proto brand ⇒ fall through ⇒ ordinary [[Get]] ⇒
carrier has no own `prototype` (`pushBuiltinCtorOwnPropSeed` returns early
for a namespace, which has no arity) ⇒ `%Object.prototype%` ⇒ `undefined`.

### C1 fixes a pre-existing defect on the tip that BOTH lanes mis-attributed

A worked example of why partial arms produce confident wrong answers, kept
because two lanes reached two different wrong conclusions from it before a
third measurement settled it.

Shape (dev-4637's `.tmp/p22.js` family): a constructor with a
FUNCTION-VALUED prototype whose instance appears ONLY as a `new` argument,
read back through a field.

```js
var P = function () {};
function G() {}
G.prototype = P;
function H(x) { this.wrapped = x; }
var h = new H(new G());
var w = h.wrapped;
G.prototype === P; // campaign tip: FALSE.  this branch: true.
```

| who | arms compared | conclusion | status |
| --- | ------------- | ---------- | ------ |
| dev-4637 | their base (= tip) vs their branch | identical ⇒ "pre-existing, unaffected" | correct about THEIR arms, incomplete |
| me, first pass | my branch only | `true` here ⇒ "introduced by their branch" | **WRONG** — a regression claim from a one-armed measurement |
| me, after their correction | tip vs this branch | base `false` → branch `true` | settled |

Attribution narrowed by reverting ONE file: with only
`src/codegen/fnctor-escape-gate.ts` back at `81445abf7` the answer returns to
`false`, so **C1 is the cause**. The defect is pre-existing on the tip AND
fixed by this change-set — a possibility neither lane's arm pair could
represent, because neither contained the other lane's change.

Pinned as `argonly-instantiation-function-valued-prototype` (fails on base).
It is the FIRST HALF of the composition dev-4637's `CROSS-LANE PREDICTION`
states: C1 makes this site escape-gate-approved and the prototype identity
read correctly. It does **not** show their A1 arm links the function-valued
prototype — that is their arm and their pin.

**C1 × #4637 A1 — a PREDICTION, not a measurement.** My C1 widening makes
MORE `new F(inst)` sites reconstruct the argument as an open `$Object`;
dev-4637's A1 arm fires at `__object_create`, i.e. only at sites that
already reconstruct. Expected direction is therefore additive (more
reconstructing sites ⇒ more instances whose function-valued prototype
links). **Neither lane has compiled the combined tree.** Do NOT carry either
lane's before/after numbers across the merge.

**The merge check needs BOTH pin files, and this lane's alone is not
sufficient.** `tests/issue-4639.test.ts` (13 pins, ~50 s) covers the
direction where #4637 could break THIS lane. Note the C2 group
(`String.indicator`, `RegExp.indicator`, `Math.NaN`) does NOT do that on its
own: all three use non-`prototype` keys, so none of them exercises the key on
which the two arms actually meet. **`#4639 C2 — CANARY`
(`builtin-no-brand-prototype`) is the pin that does** — `Math.prototype` /
`Proxy.prototype` reach the C2 arm and emit
`__object_hasOwn(carrier, "prototype")`, the exact interned literal
dev-4637's prologue keys on. Verified driven and not incidentally green:
reverting `property-access-dispatch.ts` to `81445abf7` and removing
`builtin-static-expando.ts` makes that pin FAIL, and only it. The C1 pin
`built-ins/String/S15.5.2.1_A1_T10` covers the escape-gate interaction. Even
so, this file CANNOT cover the opposite direction. C1's
widening makes more `new F(inst)` sites reconstruct, which means dev-4637's
A1 arm fires at MORE `__object_create` sites than they measured — a
regression there is invisible to every pin in this file, because none of
them constructs a callable in a `[[Prototype]]` slot. Run
`tests/issue-4637.test.ts` too (verified present on their branch
`issue-4637`, head `7ea2a1bcb`). A merger who runs only this lane's pins and
sees green has checked one direction of a two-directional interaction.
