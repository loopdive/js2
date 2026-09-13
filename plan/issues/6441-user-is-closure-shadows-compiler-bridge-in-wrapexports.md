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
