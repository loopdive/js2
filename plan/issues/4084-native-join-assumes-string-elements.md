---
id: 4084
title: "native-string `join` lane assumes any non-numeric element is a string ref — an object element emits an INVALID module"
status: ready
sprint: current
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
goal: standalone-gap
created: 2026-08-02
---

## Problem

`Array.prototype.toString` / `join` on an array whose elements are a
**non-string GC ref** emits a module that **fails Wasm validation**:

```
type error in fallthru[0] (expected (ref null 6), got (ref 43))
```

`(ref null 6)` is `$AnyString`; `(ref 43)` is the element's object struct. The
module never instantiates, so the whole file's assertions are lost.

Repro — 7 lines, standalone target:

```js
var object = {
  toString() {
    return {};
  },
};
var x = new Array(object);
var s = x.toString();
```

Goal-scope population: **2** files (baseline row `2.8.2026, 03:32`) — these are
also the permanent conformance repros (#2093):

- `test262/test/built-ins/Array/prototype/toString/S15.4.4.2_A1_T4.js`
- `test262/test/built-ins/Array/prototype/toLocaleString/S15.4.4.3_A3_T1.js`

Whoever lands the fix should add a `tests/issue-4084.test.ts` carrying the
7-line repro above, asserting `WebAssembly.validate(...) === true` **and** that
the spec `TypeError` is thrown — validation alone would not catch a wrong
value.

## Root cause

`compileArrayJoinNative` (`src/codegen/array-methods.ts`) builds `elemToStr`
as a four-way decision:

| arm | handling |
| --- | --- |
| `elemIsBoolean` | `"true"` / `"false"` literal |
| `isNumeric` | `number_toString` |
| `externref` | `__extern_toString` |
| **else** | **assume a string ref → `ref.as_non_null`** |

That last arm is an **assumption, not a check** — its own comment says
*"String element: a (ref null $NativeString) — non-null cast up to
$AnyString."* For an object element it produces `(ref $Obj)` where the concat
fold's block type is `(ref $AnyString)`.

Fifth instance of #4080 in this cluster (after #3989, #4077, #4079, #4082),
and the same sub-shape as #4082: the invariant is written as a comment in the
arm that does not enforce it.

## Fix (implemented and measured, then deliberately NOT shipped — see below)

The **generic** join lane a few lines below already stringifies `ref` /
`ref_null` elements correctly (`needsExternJoinStr` → `__extern_join_str`), so
the fix is to state the native lane's precondition instead of assuming it and
let a non-string ref fall through:

```ts
// gate at the native-lane branch in compileArrayJoin
function nativeJoinHandlesElement(ctx, elemType): boolean {
  if (elemType.kind !== "ref" && elemType.kind !== "ref_null") return true;
  const typeIdx = elemType.typeIdx;
  return (
    typeIdx === ctx.anyStrTypeIdx ||
    typeIdx === ctx.nativeStrTypeIdx ||
    typeIdx === ctx.consStrTypeIdx ||
    typeIdx === ctx.hashedStrTypeIdx
  );
}
```

Do **not** make `compileArrayJoinNative` `return null` instead — its callers
treat `null` as a reported compile error, not as a fallback, so bailing there
converts the crash into a compile error rather than into working code. The
gate has to sit at the lane choice.

## Measurements — the fix is safe but buys ZERO flips

| check | result |
| --- | --- |
| repro | base: module invalid · with fix: **valid**, and the spec `TypeError` is thrown correctly |
| the 2 goal-scope files | **0 flips** — both still fail |
| regression control, 500 baseline-`pass` goal-scope files | **496 pass / 4 fail**; those 4 fail identically on base ⇒ **0 attributable regressions** |
| host-import leak (see caveat) | **none** — `imports=NONE` for `string[] join`, `string[] toString`, `number[] join`, `any[] join`, `object[] join` |

What the 2 files do after the fix is still instructive — the whole-module
crash becomes two *specific* failures:

- `S15.4.4.2_A1_T4` → `RuntimeError: array element access out of bounds in
  __str_to_number()` (a deeper, separate bug)
- `S15.4.4.3_A3_T1` → a real assertion: `n === 2. Actual: 0` (a genuine
  `toLocaleString` semantics gap)

So this is a **quiet→loud** change — the opposite direction from #4083 — but
it is not a conformance win on its own.

**Measurement caveat that matters for whoever picks this up:**
`runTest262File` does **not** apply the #2961 host-import refusal, so a
regression that pushed joins from the native lane onto a host-import lane
would be **invisible** in that 500-file control. That is why the import-leak
row above was measured separately, by compiling five array shapes in
standalone and listing `WebAssembly.Module.imports`. Re-do that check, not
just the runner control, if you change which lane handles joins.

## Why it was not shipped

The change is +4 LOC in `src/codegen/array-methods.ts`, a god-file already at
its `check:loc-budget` ceiling (8388). Landing it needs either a
`loc-budget-allow:` or shrinking unrelated lines. For a change with **0
measured flips** neither is a good trade, and gaming the gate to fit is worse.

Land it **for free** when someone is next editing `array-methods.ts` anyway,
or as part of a god-file split. The predicate's natural home is
`src/codegen/array-element-typing.ts` (which costs the one import line).

## Acceptance criteria

- The repro above compiles to a **valid** module.
- `["x","y"].join(",")` and `["x","y"].toString()` still compile with
  `imports=NONE` in standalone — i.e. string arrays keep the native lane.
- No `loc-budget-allow:` is taken for `src/codegen/array-methods.ts`.
