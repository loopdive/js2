---
id: 4120
title: "`typeof <builtin method>` does not answer \"function\" — 119 standalone + 43 host tests die in the harness before testing anything (SILENT WRONG ANSWER)"
status: done
completed: 2026-08-03
assignee: ttraenkler/dev-4120-typeof
sprint: 78
created: 2026-08-03
updated: 2026-08-18
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: ES5
language_feature: typeof
goal: standalone-mode
umbrella: 2860
related: [3571, 1888, 4119, 1732, 2378]
test262_fail: 162
origin: "2026-08-03 harvest of loopdive/js2wasm-baselines, commit 8dac2d70 (2026-08-02T23:08:27Z) = js2 main c480fb66; both lanes"
---

# #4120 — `typeof` of a builtin method is not `"function"`

## TL;DR — this is a silent wrong answer, not a refusal

`typeof` is one of the few operators that **cannot throw**. When it returns the
wrong string the program keeps running on a wrong premise. This is filed
regardless of count for that reason; the count happens to be large anyway.

**162 official failing tests** (119 standalone + 43 default/host) report exactly:

```
Test262Error: isConstructor invoked with a non-function value
```

That string comes from `test262/harness/isConstructor.js`, whose **first
statement** is:

```js
function isConstructor(f) {
    if (typeof f !== "function") {
      throw new Test262Error("isConstructor invoked with a non-function value");
    }
    ...
}
```

So the harness never reaches `Reflect.construct`. The tests are the
`not-a-constructor.js` / `is-a-constructor.js` family — they assert that a
builtin method is *not* a constructor. We fail them not because we get
constructor-ness wrong, but because `typeof <the builtin>` is not `"function"`.

## Denominators

| lane | matching rows | non-pass official rows | share |
| --- | ---: | ---: | ---: |
| standalone | **119** | 16,746 | 0.71 % |
| default (host) | **43** | 12,711 | 0.34 % |

Populations: 43,486 official standalone files / 43,489 official host files.
The two lanes' file sets for this signature are **not** summed — they are
reported separately throughout.

**0 overlap** with the #4119 `not yet callable as a value` bucket (checked
file-by-file: 0 of 119 standalone files appear in that 265-file set). The two
are adjacent mechanisms with disjoint evidence.

## Standalone distribution (119)

```
 31  test/built-ins/TypedArray/prototype
 13  test/annexB/built-ins/String
  6  test/built-ins/Array/prototype
  5  test/built-ins/RegExp/prototype
  4  test/built-ins/Uint8Array/prototype
  2  test/annexB/built-ins/Date  |  test/built-ins/ArrayBuffer/prototype  |  test/built-ins/Error/prototype
  1  test/built-ins/Map/prototype, test/built-ins/isNaN, test/built-ins/DataView, ...
```

Samples:

```
test/built-ins/RegExp/prototype/Symbol.match/not-a-constructor.js
test/annexB/built-ins/Date/prototype/setYear/not-a-constructor.js
test/built-ins/Map/prototype/Symbol.iterator/not-a-constructor.js
test/built-ins/isNaN/not-a-constructor.js
test/built-ins/DataView/is-a-constructor.js
```

`isNaN` and `DataView` are load-bearing samples: both are **implemented**, so
"the builtin doesn't exist" does not explain the bucket.

## Host distribution (43) — READ THIS BEFORE SCOPING

```
test/annexB/built-ins/escape/not-a-constructor.js
test/built-ins/ArrayBuffer/prototype/sliceToImmutable/not-a-constructor.js
test/built-ins/Promise/allKeyed/not-a-constructor.js
test/built-ins/Map/prototype/getOrInsert/not-a-constructor.js
test/built-ins/GeneratorPrototype/throw/not-a-constructor.js
```

Several of the host 43 name builtins we simply **do not implement**
(`Promise.allKeyed`, `Map.prototype.getOrInsert`, `ArrayBuffer.prototype.sliceToImmutable`
are recent proposals-turned-standard). For those, `typeof undefined !==
"function"` is *arguably correct behaviour on a missing builtin*, and the test
is failing for a legitimate reason. **Do not treat the host 43 as one
mechanism.** Triage it before spending: the honest scoped bucket is probably
smaller than 43. The standalone 119 is the real target.

## MECHANISM — measured live, standalone lane, main `33b9d5fb`

The trigger is **reification into a value**, not `typeof` itself. Probe
(`.tmp/probe-typeof2.ts`, `--target standalone`, WasmGC, no host imports):

```ts
function typeofIsFunction(f: any): number {
  return typeof f === "function" ? 1 : 0;   // INDIRECT — builtin arrives as a param
}
export function test(): number {
  const a: any = (Array as any).prototype;
  let n = 0;
  if (typeof isNaN === "function")   n += 1;   // static, in place
  if (typeof DataView === "function") n += 2;  // static, in place
  if (typeof a.map === "function")    n += 4;  // static, in place
  n += typeofIsFunction(isNaN)    * 8;
  n += typeofIsFunction(DataView) * 16;
  n += typeofIsFunction(a.map)    * 32;
  return n;
}
```

Result: **`3`** — i.e. bits 1 and 2 only.

| expression | answers `"function"`? |
| --- | --- |
| `typeof isNaN` (in place) | **yes** |
| `typeof DataView` (in place) | **yes** |
| `typeof Array.prototype.map` (in place) | **no** |
| `typeof f` where `f` is a **parameter** holding `isNaN` | **no** |
| `typeof f` where `f` is a **parameter** holding `DataView` | **no** |
| `typeof f` where `f` is a **parameter** holding `Array.prototype.map` | **no** |

So there are **two** modes, and the second is the dominant one:

1. **Prototype-method reads** (`Array.prototype.map`) are already wrong even in
   place — same substrate as #4119 / #3571.
2. **Every builtin, including ones that are correct in place, loses its
   function-ness the moment it is passed as a value.** `isNaN` and `DataView`
   are the proof: correct statically, wrong through one parameter hop.

Mode 2 is what the harness hits: `isConstructor(f)` typeof-checks a
**parameter**. That is why the bucket contains builtins we implement perfectly
well.

### Methodological note — the naive probe would have mis-scoped this

The first probe used only the in-place form and returned `6`
(`isNaN` ✓, `DataView` ✓, `map` ✗), which reads as "only prototype methods are
affected" and would have scoped this to ~64 of the 119 files. The static
`typeof` is answered at compile time and never exercises the value carrier —
the same trap as
[[reference_constant_folded_probe_tests_the_static_path]]. **Any A/B on this
issue must go through an indirection.**

## Acceptance criteria

- [x] A live probe records what `typeof <builtin>` answers, in place and
      through a parameter, for `Array.prototype.map`, `isNaN`, `DataView`.
      *(done above; standalone lane only — the host lane needs its `env`
      import object and was NOT probed, so the host 43 remains unconfirmed.)*
- [ ] `typeof f === "function"` holds when `f` is a parameter/local holding any
      implemented builtin, in standalone. This is the primary fix.
- [ ] `typeof Array.prototype.<m>` answers `"function"` in place (mode 1) —
      may land with #4119 instead; if so, record that and drop it here.
- [ ] The standalone `isConstructor invoked with a non-function value` bucket
      goes to 0 for implemented builtins; residual rows are re-attributed to
      "builtin not implemented" and counted separately.
- [x] Host-lane 43 is probed and triaged into implemented vs unimplemented
      before any host-side work; the unimplemented arm is closed as out of
      scope here. *(triage below; 12 unimplemented, 31 real — and a DIFFERENT
      mechanism, so no host-side work was done here.)*

## Population re-measure — 2026-08-03, baselines refreshed

Re-harvested with `--force` (`loopdive/js2wasm-baselines` @ `2026-08-03 13:19`,
= js2 main `609c995ce`; the overnight interpreter work had moved them):

| lane | matching rows | non-pass official rows |
| --- | ---: | ---: |
| standalone | **118** (was 119) | 16,232 |
| default (host) | **43** (unchanged) | 12,509 |

Populations 43,505 official standalone / 43,488 official host.

### Standalone 118 bucketed by CARRIER KIND

The issue predicted the carrier representation differs by kind. It does — into
three kinds, not two, and only ONE of them is what this fix addresses:

| carrier kind | rows | what `typeof` answered (through a parameter) | why |
| --- | ---: | --- | --- |
| reified builtin **constructor** with a carrier | **16** | `"object"` | the carrier is a plain `$Object` (#3006/#2907) — **fixed here** |
| top-level global with **no carrier at all** | 29 | `"object"` (i.e. `typeof null`) | the bare identifier lowers to `ref.null.extern` |
| **prototype method** (`Array.prototype.map`, `%TypedArray%.prototype.*`) | 69 | `"undefined"` | the member READ itself does not resolve (#4119 / #3571) |
| static method on `%TypedArray%` (`of` / `from`) | 2 | — | same shape as the row above |
| local-harness instantiation failure (`Symbol`, `Proxy`) | 2 | — | not measurable in this harness (see below) |

The control that pins the mechanism: **static builtin METHODS already answered
`"function"`** — `Array.from`, `Object.keys`, `Math.max` all pass, because they
reify through `ensureStandaloneBuiltinStaticMethodClosure`, whose value IS a
closure-wrapper struct the typeof natives already `ref.test`. The constructor
carrier is the row that has no such struct.

## Fix — the narrowest site

`$Object.flags` gains two internal-slot bits, `OBJ_FLAG_CALLABLE` (0x10) and
`OBJ_FLAG_CONSTRUCTOR` (0x20), set on the reified-constructor carrier at
materialization time (`pushBuiltinCtorOwnPropSeed`, which already declines for
`Math`/`JSON`/`Reflect` — they have no spec ctor arity, and `typeof Math ===
"object"` is the correct answer). One shared predicate arm reads them in
`__typeof_function` / `__typeof_object` / `__typeof` and in
`__reflect_is_constructor`.

Why a flag and not a struct subtype: `$Object` is deliberately CLOSED — opening
it for a subtype triggered WasmGC iso-recursive canonicalization and a
wrong-arity `struct.new` (#1100/#2009). The flag leaves the carrier's
representation, identity and own properties byte-for-byte unchanged, and every
other `flags` reader masks only its own bit.

**Two bits, not one, on purpose.** Every carrier branded today is both callable
and constructible, so one bit would work *now* — but `isNaN`/`parseInt` are
callable and NOT constructible, so a later callable-only brand sharing the bit
would answer `isConstructor(isNaN) === true`: a loud `TypeError` refusal turned
into a silent wrong answer, i.e. the same defect class this issue is about.

## Flips — standalone, `runTest262File`, main `609c995ce` → `5dc3a76ea`

| | before | after |
| --- | ---: | ---: |
| pass | **0 / 118** | **16 / 118** |
| still `isConstructor invoked with a non-function value` | 118 | **100** |
| local-harness instantiation failure | 0 | 2 |

The 16 are exactly the branded set: `Set` `Map` `WeakMap` `WeakSet` `WeakRef`
`RegExp` `Array` `Object` `Error` `DisposableStack` `FinalizationRegistry`
`SuppressedError` + the six `NativeErrors/*`. The remaining 100 are the
no-carrier (29) and prototype-method (69) kinds plus the 2 `%TypedArray%`
statics — a different mechanism each, see residual below.

### Regressions: 0 measured

66-file control set drawn from currently-PASSING standalone baseline rows under
`language/expressions/typeof/`, `Reflect/construct/`, `Object/{freeze,seal,
isFrozen,isSealed,isExtensible,preventExtensions,getOwnPropertyDescriptor,
defineProperty}/`, `JSON/`, `Set/`, `Map/`, `Math/` — the areas that touch the
`flags` word, the typeof natives or `IsConstructor`.

50 pass. The other 16 fail with ONE signature,
`Import #0 "js2wasm:runtime-eval": module is not an object or function` — an
instantiation-time missing import module in this LOCAL harness, not a
regression. **Positive control:** the same 16 files, same lane (standalone),
same harness, run against `upstream/main` `609c995ce` with `src/` reverted →
**0/16, identical signature**. So the instrument, not the change. (The 2
unmeasurable rows in the bucket table above are the same defect.)

Verified separately: all three writers of `$Object.flags` are OR-only
(`object-runtime-integrity.ts`, `json-codec-native.ts`, and this brand), so no
path copies the word wholesale and the brand cannot leak to a clone.

## Residual — what is NOT fixed, and why it is a separate mechanism

- **29 top-level globals with no carrier at all** — `isNaN` `isFinite`
  `parseInt` `parseFloat`, the four URI globals, `escape`/`unescape`,
  `DataView` `ArrayBuffer` `String` `Number` `Boolean` `Date` `Promise`
  `BigInt`, and the 12 `TypedArrayConstructors/*`. Their bare identifier read
  lowers to `ref.null.extern` (verified in the disassembly), so there is no
  object to brand. Fixing them means EXTENDING the carrier set
  (`BUILTIN_CONSTRUCTOR_IDENTITY_NAMES` / `SUPPORTED_STATIC_PROPS`), which
  flips those reads from falsy-null to a truthy object — a real blast radius
  that needs its own full-lane measurement. Follow-up, not a widening of this
  PR.
- **69 prototype methods** — `typeof Array.prototype.map` answers
  `"undefined"`: the member read itself does not resolve. This is the issue's
  own "mode 1", and it belongs with #4119 / #3571, not here.

## Host-arm triage (the 43) — VERDICT: do not treat as one mechanism

Probed the named builtin's existence in the JS host itself (host mode delegates
to it), then `typeof` through a parameter for a sample.

**12 of 43 — builtin does not exist in the JS host either.** `typeof undefined
!== "function"` is the CORRECT answer and the row fails for a legitimate
missing-builtin reason. Out of scope for #4120:
`ArrayBuffer.prototype.{sliceToImmutable,transferToImmutable}`,
`Iterator.prototype.join`, `Map.prototype.{getOrInsert,getOrInsertComputed}`,
`WeakMap.prototype.{getOrInsert,getOrInsertComputed}`, `Math.sumPrecise`,
`Promise.{allKeyed,allSettledKeyed}`, `Error.prototype.stack` getter+setter.

**31 of 43 — a real gap, but a DIFFERENT mechanism from the one fixed here.**
Measured host-mode `typeof` through a parameter: `Set` and `Array` answer
`"function"` (correct), while `AggregateError` `BigInt` `WeakRef` `escape`
`eval` `parseInt` all answer `"object"`. So the host lane has its own
bare-identifier value-read gap that this standalone-gated brand cannot touch —
the honest scoped host bucket is 31, not 43, and it needs its own issue.

No host-side change was made; the host emit is byte-identical (the brand is
`ctx.standalone`-gated at `pushBuiltinCtorOwnPropSeed`).

## Test Results

`tests/issue-4120.test.ts` — 29/29 pass. Every `typeof` assertion goes through
a one-parameter indirection; the in-place spelling is asserted only as a
CONTROL that must keep working (it is constant-folded and never touches the
carrier — the trap this issue recorded, and
[[reference_constant_folded_probe_tests_the_static_path]]).
