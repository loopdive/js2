---
id: 6441
title: "A user-declared `__is_closure` turns a returned class instance into a callable FUNCTION through wrapExports"
status: ready
sprint: current
created: 2026-09-13
updated: 2026-09-13
priority: high
horizon: m
feasibility: medium
task_type: bug
area: runtime
goal: correctness
---

## Problem

Found while fixing
[#6419](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6419-three-closure-area-tests-red-on-main)
arm 8. It was previously unreachable: the row that exercises it bailed on an
earlier assertion, so nothing had ever run this far.

A module that declares its own `__is_closure` **and** also legitimately needs
the compiler's closure-host-bridge family hands JS a **function** where the
program returned an object:

```ts
export function __is_closure(_value: any): number { return 1; }   // user's own
export function __call_fn_0(_value: any): number { return 709; }
export function $cf(): number { return 704; }
class Empty { ping(): number { return 1; } }
export function makeEmpty(): Empty { return new Empty(); }
```

```
wrapExports(instance).makeEmpty()          →  [Function anonymous]   (expected {})
wrapExports(instance.exports).makeEmpty()  →  [Function anonymous]
```

Both overloads, so unlike
[#6438](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6438-wrapexports-raw-exports-marshals-struct-to-empty)
this is not about the data-struct authority.

## Mechanism

`looksMarshalable` in `wrapExports` consults `exportsForMarshal.__is_closure`
and treats a `1` as "this is a closure, not marshalable", then falls through to
`makeCallableClosureWrapper`. Its own comment states the intended protection —
*"Do not let a user `__is_closure` label … turn class instances into callable
wrappers"* — and that protection is written as "no compiler closure family was
discovered". Here a family IS discovered (the escaping `Empty` instance needs
the method dispatchers), so the guard does not apply and the USER's
unconditional `1` is what answers.

`_hostBridgeExportView` is supposed to override the logical `__is_closure` with
the compiler's own physical alias (`$cf$` in this module) exactly for this case.
It evidently does not, or the override resolves to something that still answers
`1`. That resolution is where to look:
`_hostBridgeExportView` → `_closureHostBridgeMetadata` →
`_terminalHostBridgeAlias` / `sameExportedFunction`.

## Why it matters

This is the shape the #3520 ownership model exists to get right, and the
failure is a silently wrong TYPE at the boundary: `typeof` flips from
`"object"` to `"function"`, so a caller's `instance.ping()` is not even the
error it looks like.

## Reproduction

`tests/issue-3520-closure-host-bridge-abi.test.ts`, the
"does not discover closure helpers from a forged closure-free name family" row.
Its trailing marshal assertions are currently marked `it.fails` and point here;
fixing this issue makes that marker fail, which is the intended ratchet — fold
the assertions back into the main row then.

## Acceptance criteria

1. `wrapExports(instance).makeEmpty()` answers an object, not a function, for
   the fixture above.
2. The compiler's own `__is_closure` is what the boundary consults whenever a
   compiler closure family is present; the user's keeps its public label and its
   own return value when called directly.
3. The `it.fails` marker in `tests/issue-3520-closure-host-bridge-abi.test.ts`
   is removed and the assertions rejoin the ownership row.

## Implementation Plan

**Measured on upstream/main 54c36a9fe3 (probe `.tmp/probe-6441b.mts`): the diagnosis in "Mechanism" is wrong — the compiler's own `__is_closure` IS what the boundary consults.** `_closureHostBridgeMetadata` authenticates the family (manifest `0x5a20c7ff`, bit 15 set, `$cu.get(15) === $cf$`), `_hostBridgeExportView` overrides `__is_closure` → `$cf$`, and `$cf$(makeEmpty())` answers `0`. The instance still comes back as a function because `looksMarshalable` (`src/runtime.ts` ~L19482–19500) then runs step 2 (`_structFieldNamesRaw` → null: the fixture exports no `__struct_field_names`/`$d1`, a field-less class mints none), step 3 (`_isWasmVec` → false: no `__is_vec`/`__vec_len`), and step 4 `return hasVecLen` → **false**, because a module with no array use never exports `__vec_len`. Evidence that the forged names are irrelevant: the same class WITHOUT the forged names also returns `function` (variant B, plain `class Empty { ping(){} }` + `makeEmpty`); adding one `number[]`-returning export flips it to `{}` (variant D). The #3637 row "a field-less instance crosses as {}" only passes because its module also has `mkVec`.

1. **Fix — `looksMarshalable`, `src/runtime.ts`.** After `_hostBridgeExportView`, `exportsForMarshal.__is_closure` is either the authenticated compiler classifier or `undefined` (the view maps a user-only label to `undefined`), so a returned `0` is authoritative "object". Replace the trailing `return hasVecLen` with: `return closureVerdictKnown ? true : hasVecLen`, where `closureVerdictKnown` is set true when `isClosureFn(val)` returned without throwing. Keep the `hasVecLen` fallback only for the throw path (keep the catch). Do NOT touch `_hostBridgeExportView`/`_closureHostBridgeMetadata`/`sameExportedFunction`; rewrite the step-4 comment (the "module too old to export `__vec_len`" clause now applies only to a throwing classifier). Order preserved: steps 1–3 unchanged, so closures (`__is_closure`→1) still reach `makeCallableClosureWrapper`, named structs/vecs still marshal first.
2. **Probe first** (write before the fix, `.tmp/` only): re-run `.tmp/probe-6441b.mts`; expect A/B/E → `object {}`, C `{"value":7}`, D `{}` after the fix, and `mkClosure` still `function`.
3. **Regression test `tests/issue-6441-fieldless-instance-marshal-without-vec-len.test.ts`** (`compile` + `buildImports` + `wrapExports`, `// @ts-nocheck` untyped source, mirror the #3637 row shape): (a) plain `class Empty { ping(){} }` + `makeEmpty` in a module with NO array/field usage → `toEqual({})`, `not.toBeTypeOf("function")` — fails on parent; (b) the forged-name fixture from this issue, both `wrapExports(instance)` and `wrapExports(instance.exports)` → `{}`, plus `exports.__is_closure(null) === 1` and `exports.$cf() === 704` (AC2, user labels untouched); (c) anti-vacuity controls that pass on parent: same module + `export function arr(){ return [1,2] }` → `{}`; a module returning `function(x){return x+1}` → typeof `function` and `(1)→2`; `marshal:false` still returns the raw struct.
4. **Fold the `it.fails` row** in `tests/issue-3520-closure-host-bridge-abi.test.ts` (L874–893): delete the marker + comment, move the two assertions into the "forged closure-free name family" row after the ownership block (AC3). Run `tests/issue-3520-*`, `issue-3637-*`, `issue-1308.test.ts`, `issue-1504.test.ts`, `issue-6419-*`, `tests/equivalence.test.ts`.
5. **Issue file**: correct "Mechanism" to the step-4 finding above, set `status: done`.

**Dogfood expectation**: no movement (webpack 16/16 · three 17/18 · clsx 32/32 · lodash 59/62 · redux 67/82 · axios 208/231 · jest 335/356 · hono ~261/324 unchanged) — every real package uses arrays, so `__vec_len` is exported and step 4 already answered true; the fix only reaches array-free modules. **Standalone lane**: untouched — `wrapExports` is JS-host only; no wasm bytes change, so `check:standalone-floor` is a no-op.

## Dispatch

**sonnet** — one measured, line-scoped runtime change with a fully specified test matrix and a marker to fold; no design choices remain.
