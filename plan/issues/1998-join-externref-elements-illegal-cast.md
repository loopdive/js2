---
id: 1998
title: "join() traps 'illegal cast' on externref-element arrays — any[] numbers, undefined/null elements, holes, Array(n) results"
status: done
completed: 2026-06-15
sprint: 62
created: 2026-06-10
updated: 2026-06-15
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: array-methods
goal: core-semantics
related: [1968, 1215]
origin: "2026-06-10 spec-conformance sweep (arrays agent): verified on main"
---

# #1998 — join's elemToStr handles only f64/i32 elements

## Problem

All of these trap `RuntimeError: illegal cast` (node output in comments):

```ts
const a: any[] = [10, 9]; a.join(",")   // "10,9"
[1, undefined, 2].join("-")             // "1--2"
[1, null, 2].join("-")                  // "1--2"
Array(3).join(",")                      // ",,"
[1,,3].join(",")                        // "1,,3"
```

## Root cause

`src/codegen/array-methods.ts:4543-4556` (`compileArrayJoin` elemToStr) —
only `f64`/`i32` elements get `number_toString`; externref elements (boxed
numbers, undefined, null) flow raw into the `wasm:js-string` `concat`
builtin, which traps on any non-string. Spec §23.1.3.18 step 7.c:
undefined/null elements → "", others → ToString.

## Fix direction

For externref elements emit: null-check → "" ; else `__any_to_string`-style
host ToString before concat.

## Acceptance criteria

- All five repros match Node; numeric/string element joins unchanged

## Dupe check

#1968 covers only the empty-array `resultTmp` null init (different lines,
different symptom); #1215 (done) covered typed `number[]`. New.

---

## Resolution (2026-06-15, dev3)

**Done.** Verified on `origin/main` @ `516feec44`. By the time this was picked
up, four of the five repros (`[10,9]` any-numbers, `[1,undefined,2]`,
`[1,null,2]`, `[1,,3]`) already passed in JS-host mode — `join`'s
`__extern_join_str` path (`src/codegen/array-methods.ts`,
`src/runtime.ts:6684`) handles externref/undefined/null/hole elements and even
recurses into nested vecs (so #1997's `[[1,2],[3]].toString()` works) **as long
as the host instantiation calls `result.importObject.__setExports(instance.exports)`**.

The one genuine residual was **`Array(3).join(",")` → `"0,0,0"`** (should be
`",,"`). Root cause: the non-`new` `Array(n)` constructor
(`compileArrayConstructorCall` in `src/codegen/literals.ts`) defaulted an
**untyped** sparse array's element storage to **f64**, whose `array.new_default`
fills holes with `0`. The `new Array(n)` path (`new-super.ts`) already backs
untyped sparse arrays with **externref** (default `ref.null` → `join` renders
`""`). Fix: in `compileArrayConstructorCall`, the single-arg `Array(n)` length
form with an untyped element type now also resolves to externref, mirroring
`new Array(n)`. Dense `Array()`/`Array(a,b,c)` and typed `Array<T>(n)` keep f64.

### Verified (JS-host)

| program | before | after |
|---|---|---|
| `Array(3).join(",")` | `"0,0,0"` | `",,"` ✓ |
| `Array(0).join(",")` | `""` | `""` ✓ |
| `Array(5).length` | `5` | `5` ✓ |
| `Array(1,2,3).join(",")` | `"1,2,3"` | `"1,2,3"` ✓ (dense, unchanged) |
| `Array<number>(3)` + index assign + join | `"1,2,3"` | `"1,2,3"` ✓ (typed, unchanged) |
| `[10,9]`/`[1,undefined,2]`/`[1,null,2]`/`[1,,3]` join | pass | pass ✓ |

Regression test: `tests/issue-1997.test.ts` (11 cases, host mode), all green.

### Out-of-scope standalone residual

Under `target: standalone` the array-element/join path emits a compile error
(`local.set[0] expected type (ref null 5)`) for several of these shapes — this
pre-existed this change (same error on `origin/main`) and is part of the
broader standalone array residual (Lane B #2159 / value-rep undefined
observability), not the `Array(n)` constructor fix here.
