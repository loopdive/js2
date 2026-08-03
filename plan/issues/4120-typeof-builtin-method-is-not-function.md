---
id: 4120
title: "`typeof <builtin method>` does not answer \"function\" — 119 standalone + 43 host tests die in the harness before testing anything (SILENT WRONG ANSWER)"
status: ready
sprint: current
created: 2026-08-03
updated: 2026-08-03
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
- [ ] Host-lane 43 is probed and triaged into implemented vs unimplemented
      before any host-side work; the unimplemented arm is closed as out of
      scope here.
