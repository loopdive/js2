---
id: 4119
title: "standalone: `Array.prototype.<m>` refuses in value position (265) and `Object.prototype.toString` is unimplemented (76) — 341 files behind two adjacent refusal sites in array-object-proto.ts"
status: in-progress
sprint: current
created: 2026-08-03
updated: 2026-08-04
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: conformance
area: codegen
es_edition: ES5
language_feature: array-methods
goal: standalone-mode
umbrella: 2860
related: [3571, 1888, 3180, 3170, 3169, 2860, 2501]
test262_fail: 341
origin: "2026-08-03 harvest of loopdive/js2wasm-baselines test262-standalone-current.jsonl, commit 8dac2d70 (2026-08-02T23:08:27Z) = js2 main c480fb66, 30759/43489 host"
---

# #4119 — the standalone `Array.prototype` refusal ladder: 341 files, two emitter lines

## TL;DR

Two **loud, explicit** `emitThrowTypeError` refusals that sit 16 lines apart in
`src/codegen/array-object-proto.ts` account for **341 official standalone
failures**. Neither is sized or owned by any existing issue — the exact strings
appear **zero** times across all 3,467 files in `plan/issues/`.

| refusal | emitter | files | dominant member |
| --- | --- | ---: | --- |
| `<X>.prototype.<m> is not yet callable as a value in --target standalone` | `src/codegen/array-object-proto.ts:715` | **265** | `Array.prototype.map` = 144 |
| `<X>.prototype.<m> is not yet implemented in --target standalone` | `src/codegen/array-object-proto.ts:699` | **76** | `Object.prototype.toString` = 76 |

Denominator: 16,746 non-pass official standalone rows (43,486 official files,
26,740 pass). 341 / 16,746 = **2.0 %** of the standalone failure mass.

## Bucket 1 — method reference in value position (265)

Every one of the 265 has receiver prototype `Array.prototype`; 35 distinct
methods. `map` alone is 144, i.e. **54 %** of the bucket.

```
144  Array.prototype.map
 12  Array.prototype.lastIndexOf
 11  Array.prototype.indexOf
  7  Array.prototype.splice
  6  Array.prototype.toSpliced / forEach / some / every  (6 each)
  5  Array.prototype.toReversed / concat
  4  Array.prototype.push / reduce / toSorted / filter
 ... 21 more methods, ≤4 each
```

Sample paths:

```
test/built-ins/Array/prototype/sort/call-with-primitive.js
test/built-ins/Array/prototype/toSpliced/this-value-boolean.js
test/built-ins/Array/prototype/forEach/15.4.4.18-1-3.js
test/built-ins/Array/prototype/map/15.4.4.19-1-5.js
test/built-ins/Array/prototype/with/length-decreased-while-iterating.js
```

The refusal fires when the method is **named without being immediately
called** — `Array.prototype.map` as an operand (passed, stored, `.call`-ed
through a saved reference, or compared). The direct-call form
`arr.map(cb)` is already lowered natively; only reification is missing.

## Bucket 2 — `Object.prototype.toString` unimplemented (76)

72 of 76 sit under `test/built-ins/Array/prototype/` — the ES5
`S15.4.4.10_A*` (`slice`) and `S15.4.4.12_A*` (`splice`) families, which do
`Object.prototype.toString.call(x)` to assert the result is `[object Array]`.

```
test/built-ins/Array/prototype/splice/S15.4.4.12_A2.1_T5.js
test/built-ins/Array/prototype/slice/S15.4.4.10_A2_T6.js
test/built-ins/Array/prototype/slice/S15.4.4.10_A1.2_T4.js
```

**#2501 is `done`** and claimed `Object.prototype.toString [object X]` including
"standalone CE (~151 test262)". This 76 is a *different mode* — not a compile
error and not a wrong tag, but an explicit runtime refusal from the
`array-object-proto` ladder. Either #2501's fix does not reach this call shape
or it regressed; **verify against #2501's own repro before scoping**.

## Why this is not #3571 / #1888 / #3180

- **#3571** (`ready`, "builtin objects not reified as values") was re-scoped on
  2026-08-01 to **217 files** and its measured mechanism is
  `Function.prototype.call/apply/bind` re-dispatch surfacing as
  `Cannot convert undefined or null to object`. That signature is a **separate
  312-row bucket** in this same baseline. Disjoint signature, disjoint size.
- **#1888** is the prototype-vtable / built-ins-as-static-globals substrate —
  the *enabler*, not this refusal's sizing.
- **#3180** (`ready`) enumerates six residual Array-HOF mechanisms, all
  **receiver-shape** mechanisms (array-like receivers, expando receivers,
  `arguments` fidelity, thisArg, ToPrimitive lengths). None is
  "method-as-value"; the string does not appear in it.
- **#3170** (`done`) did land method-as-value for `indexOf`/`lastIndexOf`/
  `includes` — yet 23 `indexOf`/`lastIndexOf` rows still refuse here, so
  either the fix is partial or a second site was missed. That is the cheapest
  entry point into this issue.

## Acceptance criteria

- [ ] `Array.prototype.<m>` in value position lowers to a callable value in
      `--target standalone` for the closed set the direct-call path already
      supports; the `array-object-proto.ts:715` refusal is unreachable for
      those members.
- [ ] `Object.prototype.toString.call(x)` returns the correct `[object X]` tag
      in standalone for arrays and array-likes; the `:699` refusal no longer
      fires for `Object.prototype.toString`.
- [ ] Re-measure both signatures against a fresh
      `test262-standalone-current.jsonl`; report the delta with denominators.
      Target: both buckets → 0 refusals (the tests may still fail for other
      reasons; count refusals, not passes).
- [x] If any sub-bucket turns out to be owned by #3170 or #2501, close it here
      and record which, rather than double-fixing. *(done 2026-08-03 — the 24
      `indexOf`/`lastIndexOf`/`includes` rows are #3170's own known-blocked
      residual, dropped from this issue; #2501's fix is a compile-time static
      fold that cannot reach the reflective-closure shape, so the 76 stay
      here. See the re-scope section above.)*

## Re-measure + re-scope — 2026-08-03, `ttraenkler/dev-4120-typeof`

Baselines re-fetched with `--force` (`test262-standalone-current.jsonl` @
`2026-08-03 19:17`, main ≈ `e9f8bfaf3`). Denominator: **43,505 official
standalone files, 16,240 non-pass**.

| signature | issue said | fresh |
| --- | ---: | ---: |
| `… is not yet callable as a value in --target standalone` | 265 | **271** |
| `… is not yet implemented in --target standalone` (ALL members) | — | **136** |
| …of which `Object.prototype.toString` | 76 | **76** |

The `not yet implemented` bucket is **136**, not 76 — the issue counted only the
`Object.prototype.toString` slice of it. The other 60 are different members
(`String.prototype.split` 12, `Promise.resolve` 9, `Array.from` 7, `Array.of` 6,
`String.prototype.slice` 5, …) and are NOT in this issue's scope.

Bucket 1 is **entirely** receiver `Array` (271/271).

### The cheapest entry is SETTLED — and it is a third answer

The issue asks whether the 23 (now 24, incl. `includes`) `indexOf`/`lastIndexOf`
rows mean #3170's fix was **partial** or a **second site was missed**. Measured
from the test files themselves, not from prose: **neither.**

```
15.4.4.14-1-3   Array.prototype.indexOf applied to boolean primitive
15.4.4.14-1-5   Array.prototype.indexOf applied to number primitive
15.4.4.14-1-7   Array.prototype.indexOf applied to string primitive
15.4.4.14-1-9   Array.prototype.indexOf applied to Function object
call-with-boolean.js  (indexOf / lastIndexOf / includes)
```

Every one is a **primitive or exotic-host receiver**. #3170's own write-up
already names them as its residual buckets 1 and 2 — "Primitive receivers
(~11) … Reflective closure body (`emitArrayProtoMemberBody`,
array-object-proto.ts) still refuses everything but `slice`" and "Exotic
host-object receivers (~10)" — and its re-scope decision explicitly left both
as known-blocked, needing `ToObject(primitive)` and host-object dynamic
length/index reads.

**Decision: these 24 rows are DROPPED from #4119** and stay attributed to
#3170's known-blocked residual. They are not a cheap entry point; they are the
most expensive rows in the bucket.

### What the bucket actually is

- **`Array.prototype.map` = 147 of 271 (54 %).** Most of those rows are **not**
  `Array/prototype/map` tests — they come from the test262 **harness**:
  `deepEqual.js` calls `.map(…)` on array-likes, so any test that pulls in
  `assert.deepEqual` hits the refusal. That is why the bucket spans `Promise/`,
  `TypedArray/`, `language/expressions/await/`, `Object/`. Large lane-wide
  leverage — but mostly OUTSIDE the ES5 goal scope, so it must not displace the
  `Object.prototype.toString` arm, which carries the 72 ES5 slice/splice rows.
  **Hazard when building it:** with the harness as the caller, a `map` that only
  satisfies `deepEqual`'s usage would green rows without being correct. Build a
  real §15.4.4.19 body (callback, `thisArg`, holes, array-like receivers) and
  verify with direct-value probes; the harness passing is the outcome, never the
  test.
- **The mechanism is ONE site.** `emitArrayProtoMemberBody`
  (`array-object-proto.ts`) implements **only `slice`**; every other member
  falls to `emitThrowTypeError`. There is exactly **one**
  `compileArray*FromVecLocal` core in the tree
  (`compileArraySliceFromVecLocal`), so each further member needs its own
  AST-free core — that, not the ladder wiring, is the cost.

### A second defect sits on top of the refusal (measured)

`typeof` of a reified `Array.prototype` method, through a parameter hop
(standalone, `e9f8bfaf3`):

| expression | `typeof` |
| --- | --- |
| `Array.prototype.slice` (member body IS implemented) | `"undefined"` |
| `Array.prototype.map` (member body refuses) | `"undefined"` |

`slice` is the control that matters: **implementing the member body does not
make the reified value a function.** So a #4119 fix must ALSO produce a genuine
callable carrier, not just a working body — and it must be a **closure-wrapper
struct** (which the `typeof` natives already `ref.test`), *not* the
`OBJ_FLAG_CALLABLE`-branded `$Object` added for #4120: that brand is for the
reified builtin CONSTRUCTOR carriers and does not apply here. This is the
6-row overlap #4120 recorded as its "mode 1".

### Suggested ordering for whoever builds this

1. `Object.prototype.toString` reflective body (**76**, of which 72 ES5) — the
   bounded, goal-scoped arm. Note that #2501's fix is a **compile-time static
   fold** keyed on the receiver's TS type and fires only for the syntactic
   `Object.prototype.toString.call(v)` form, so it cannot serve a reflective
   closure whose `this` is a runtime externref. #3201 solved the very same
   `arr.getClass = Object.prototype.toString; arr.getClass()` idiom but **host
   lane only** (`if (!ctx.standalone && !ctx.wasi)`), and its own comment calls
   the native dispatcher's coverage "a follow-up" — this bucket is that
   follow-up. It needs a RUNTIME `[object X]` classifier (chained `ref.test`
   over vec / closure-wrapper / `$Object` / boxed-primitive types), the same
   shape as the `__typeof` native.
2. `Array.prototype.map` (**147**) — highest leverage, mostly out of ES5 scope.
3. The 100-odd remaining bucket-1 members, ≤7 rows each.

## BUILD — arm 1 (`Object.prototype.toString`) LANDED, 2026-08-04, `ttraenkler/dev-4119-g4`

Base `44bc97680` (upstream/main). Arm 2 (`map`) is **not** built — budget receipt
in the handoff section below.

### Populations re-verified before building (fresh `--force` standalone baseline)

Denominator: **43,505 official standalone files, 16,166 non-pass.**

| signature | re-scope said (08-03) | measured 08-04 |
| --- | ---: | ---: |
| `Object.prototype.toString is not yet implemented` | 76 | **76** ✓ |
| `… is not yet callable as a value` (bucket 1) | 271 | **270** |
| …of which `Array.prototype.map` | 147 | **146** |

The 76 break down as 37 `Array/prototype/slice` + 34 `Array/prototype/splice`
(= 71 ES5 goal-scope) + 5 scattered. **0 of the 76 include `propertyHelper`**, so
the #4147 local-standalone measurement blindness does not touch this arm — local
statuses here are trustworthy.

### Result — same-instrument A/B over the 76

`runTest262File` in `--target standalone`. This is **not** the CI shard path, so
it is read **differentially only**; its "before" side reproduces the CI baseline
exactly (76/76 refusing), which is the positive control that validates it.

| | before (`44bc97680`) | after |
| --- | ---: | ---: |
| pass | 0 / 76 | **75 / 76** |
| carrying the arm-1 refusal | **76 / 76** | **0 / 76** |

The single non-pass is `String/prototype/split/checking-by-using-eval.js`, which
now fails on `String.prototype.split is not yet implemented` — a *different*
refusal, owned by **#4095**, not by this issue.

### Regression sweep — 0 regressions

82 currently-PASSING official standalone consumers (selected from all 27,339
passing rows: everything under `Object/prototype/toString/` and
`Array/prototype/{slice,splice}`, plus every passing file whose source mentions
`Object.prototype.toString`). Same instrument, before vs after:

```
BEFORE  { pass: 62, fail: 20 }
AFTER   { pass: 62, fail: 20 }
regressions (pass → not pass): 0        improvements: 0
```

(The 20 that fail on both sides are instrument artifacts — 17 are
`Import #0 "js2wasm:runtime-eval": module is not an object or function`, which is
the in-process runner lacking an import the CI path supplies. They are identical
on both sides, so they cancel.)

### The 27-regression detour, and why the fix moved to a different file

The first cut took **27 passing rows down**, every one the *direct*
`Object.prototype.toString.call(v)` form, and one of them
(`toString.call-arguments.js`) came back **mis-tagged** `[object Array]` — the
vec arm claiming an `arguments` exotic. Confirmed **solo, one process per file**
before being believed (an 82-file single-process sweep accumulates state).

Mechanism: `tryEmitNativeProtoReflectiveCall` (`expressions/calls.ts`) intercepts
`<Builtin>.prototype.<m>.call(…)` *before* the #2501 fold. It had always
intercepted `Object.prototype.toString` — but with a refusal-only body the
closure yielded nothing and it silently declined, so the fold won **by accident**.
Wiring a real body made the interception succeed and took the fold's 27 rows.
The fix is therefore in `calls.ts`, not in the classifier: the direct syntactic
form declines to the #2501 fold (which keys on the receiver ARGUMENT's static
type and so tags Date/RegExp/Error/`arguments` precisely — strictly more than a
bare externref can prove), while the value-erased forms keep the reflective path.
This is the "wire it at the NARROWEST site" lever; widening the classifier
instead would have meant re-deriving four nominal-struct carriers.

### What arm 1 deliberately leaves REFUSING (the ladder's next rung)

Loud-stays-loud residual, measured through a runtime hop so nothing is
constant-folded. `-1` = threw, which is the intended outcome:

| receiver | reflective `.call` | why it is refused, not tagged |
| --- | --- | --- |
| `new Date(0)` | loud | nominal Date carrier, not `$Object`/vec |
| `new Error("x")` | loud | `ctx.errorStructTypeIdx`, its own struct |
| `/a/` | loud | nominal RegExp carrier |
| `class K{}; new K()` | loud | nominal class struct — "neither `$Object` nor `$Vec`" |
| `new Proxy([], {})` | loud | `$Proxy` **subtypes `$Object`**, so it matches `ref.test $Object`; its tag resolves through IsArray and a *revoked* proxy must throw (§7.2.2 step 3a). Explicitly excluded — a constant `[object Object]` can do neither. |
| Symbol / BigInt wrapper | loud | `[[PrimitiveValue]]` slot present but matching no primitive predicate |

Everything else the classifier answers is proven: Null · Undefined · Array
(`ref.test $__vec_base`, one test for every element kind) · Function
(`__typeof_function`, so it inherits the `fillStandaloneTypeofClosureArms`
finalize repair and #4120's branded carrier) · String/Number/Boolean primitives ·
primitive-WRAPPER objects via the `[[PrimitiveValue]]` slot · ordinary `$Object`.

## Adjacent PRE-EXISTING defect — the property-assign path answers a non-string (NOT arm 1)

The test262 idiom `recv.getClass = Object.prototype.toString; recv.getClass()`
**silently returns a non-string, non-`undefined` value** — instead of the tag or a
TypeError — whenever `recv` is a nominal carrier or a primitive: Date, Error,
RegExp, class instance, and string/number primitives (6 shapes measured). The
assignment appears not to install a callable on a non-`$Object`/non-vec carrier,
and the later call neither dispatches nor throws.

```ts
var r: any = new Date(0);
r.getClass = Object.prototype.toString;
r.getClass();            // → a non-string value; spec wants "[object Date]" or a TypeError
```

**Pre-existing on `44bc97680`, distinct from arm 1.** Kill-switch receipt: with
`array-object-proto.ts` reverted to HEAD and the classifier unreferenced, all six
shapes return the identical wrong value; arm 1 changes none of them (it flips
only `-1 → 1` rows). Not chased here — filed for whoever picks up the next rung,
since a silent wrong answer outranks a refusal in priority.

## HANDOFF — arm 2 (`Array.prototype.map`, 146 rows) NOT built

Budget receipt at decision time: `budget-status --pick --role developer --model
opus --as ttraenkler/dev-4119-g4` → **remaining 7%, 9 active agents, per-agent
share 1%, recommended max horizon `S`**. Arm 2 needs a §15.4.4.19 AST-free
`compileArrayMapFromVecLocal` core *plus* the closure-wrapper callable carrier
(the re-scope's "reified-method typeof" defect) — not `S`. Deferred intact.

Two things the next builder should carry over from arm 1:

1. **`tryEmitNativeProtoReflectiveCall` is the tripwire.** Any member that gains
   a real body flips that interception from declining to succeeding, and
   whatever the pre-existing static path was doing for the direct
   `.call` form silently becomes the new body's problem. Check the direct form's
   currently-passing rows BEFORE and AFTER, not just the target bucket.
2. The `map` rows mostly arrive through the harness's own `deepEqual.js`, so
   "deepEqual stopped throwing" is not a correctness signal — build to
   §15.4.4.19 and verify with direct-value probes.

## Suspended Work — 2026-08-04, budget-window wind-down

**Arm 1 is COMPLETE and PR-ready; arm 2 is untouched.** Suspended at the window
boundary, not mid-change: the tree is green, not WIP.

- **Worktree**: `/workspace/.claude/worktrees/agent-a49e3e1f2f4835cf2`
- **Branch**: `issue-4119-ladder-build`, based on `44bc97680` (upstream/main)
- **Claim**: `ttraenkler/dev-4119-g4` — **left HELD**

### Implemented

- `src/codegen/object-proto-tostring.ts` (new) — the §20.1.3.6 **runtime**
  classifier, plus the two §20.1.3.6 classifiers moved out of the god files
  (#2501's compile-time `resolveObjectToStringTag` + its `receiverMayBeProxy`).
- `src/codegen/expressions/calls.ts` — the direct `.call` form declines to the
  #2501 fold (the 27-regression fix); net **−208 LOC**.
- `src/codegen/array-object-proto.ts` — dispatch tail aliased to the shared
  helper; the duplicate local refusal helper deleted.
- `tests/issue-4119.test.ts` — 21 tests, all passing.

### Not implemented

Arm 2 (`Array.prototype.map`, 146 rows) and the ~100 remaining bucket-1 members.
Budget receipt for that decision is in the HANDOFF section above.

### Measured (denominators throughout: 43,505 official standalone, 16,166 non-pass)

| measurement | result |
| --- | --- |
| the 76 toString rows, same-instrument A/B | **0/76 → 75/76 pass**; rows still carrying the refusal **76/76 → 0/76** |
| remaining 1 of 76 | `String/prototype/split/…` — fails on `String.prototype.split`, owned by **#4095** |
| kill-switch, reflective `.call` receiver shapes | baseline **15/15 loud** → **11 correct / 4 loud / 0 wrong** |
| regression sweep, 82 currently-passing consumers | **0 regressions, 0 improvements** (identical status distribution) |

The flip measurement **did complete**. The instrument is `runTest262File`, which
is NOT the CI shard path — read differentially only; its "before" side reproduces
the CI baseline exactly (76/76 refusing), which is the control that validates it.
The 82-row regression sweep was run against the pre-restructure tree; after the
restructure the 76-row measurement was re-run identical (75/76, 0 refusals), the
10 solo regression spot-checks all pass, and `tsc`/`biome`/`prettier`/LOC-budget/
oracle-ratchet are green.

### Still loud (intended) and the separate pre-existing defect

The 4 refused shapes — `new Date(0)`, `new Error("x")`, `/a/`, nominal class
instances — plus `$Proxy` and Symbol/BigInt wrappers, are detailed in "What arm 1
deliberately leaves REFUSING" above. The 6 wrong-tag rows on the property-assign
path are a **separate pre-existing mechanism on `44bc97680`**, recorded in
"Adjacent PRE-EXISTING defect" above with its kill-switch receipt.

### Single next step for a successor

Arm 2: build `compileArrayMapFromVecLocal` to §15.4.4.19 **and** the
closure-wrapper callable carrier. Read the "tripwire" note in the HANDOFF section
first — `tryEmitNativeProtoReflectiveCall` will flip from declining to succeeding
the moment `map` gets a body, exactly as it did for `toString`.

## Reproduction

```bash
node scripts/fetch-baseline-jsonl.mjs --force
# then filter test262-standalone-current.jsonl on scope_official && status!=pass
#   /is not yet callable as a value in --target standalone/   -> 265
#   /Object\.prototype\.toString is not yet implemented/       -> 76
```
