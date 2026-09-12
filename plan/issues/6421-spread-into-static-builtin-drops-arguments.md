---
id: 6421
title: "A spread argument to a STATIC BUILTIN method contributes exactly ONE element — `String.fromCharCode(...bytes)` yields one char, which is why hono signs every cookie as `AA==`"
status: ready
sprint: current
created: 2026-09-12
updated: 2026-09-12
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

```js
String.fromCharCode(...[65, 66, 67]).length; // node 3, compiled 1
Array.of(...[1, 2, 3]).length; //               node 3, compiled 1
String.fromCharCode(48, ...[65, 66, 67]).length; // node 4, compiled 2
```

A spread argument to a **static builtin method** call expands to exactly one
element. Fixed arguments before it survive (the third line proves the spread
itself is the part that collapses, not the whole call).

This is NOT about what is being spread. Measured on the same run, all five
sources collapse identically: a plain array literal, `new Uint8Array([…])`,
`new Uint8Array(n)`, `new Uint8Array(<host typed array>)`, and a host typed
array handed in directly.

Nor is it spread in general. These are all CORRECT on the same build:

| form                                          | result  |
| --------------------------------------------- | ------- |
| `String.fromCharCode(65, 66, 67)` (no spread) | correct |
| `f(...[1,2,3])` into a user rest function      | correct |
| `String.fromCharCode.apply(null, [65,66,67])`  | correct |
| `Math.max(...new Uint8Array(hostAb))`          | correct |

So the defect sits in the argument lowering for the STATIC-BUILTIN call arm
specifically — `Math.max` takes a different (already-correct) route, which is
the useful contrast for whoever picks this up.

**This is the THIRD site of one known idiom, not a new class.** #5361 built the
shared spread-expanding argument-list builder (`src/codegen/spread-arg-list.ts`)
and converted `splice` / `push` / `Math.min`-`max` / the generic
`__extern_method_call` bridge; #6411 (merged 2026-09-12, `e1ce335402`)
converted the two host-Array argument builders in
`src/codegen/array-method-host.ts`. Both replaced the same wrong pattern: build
the argument list with ONE push per AST node, which is exact only while every
argument is a single value. The static-builtin call arm still does that.
Reading those two diffs first is likely the whole job.

## Why it matters — it is hono's cookie blocker

hono `src/utils/cookie.ts:48`:

```js
return btoa(String.fromCharCode(...new Uint8Array(signature)));
```

`crypto.subtle.sign` answers a 32-byte host ArrayBuffer. Every step on that
line is already correct on current main — measured:
`byteLength` reads 32, `new Uint8Array(hostAb).length` is 32, and the bytes
match. Only the spread collapses, so the signature serializes as `AA==`
(base64 of a single zero byte) instead of the real 44-character digest.

That one line accounts for **9 of the 11** remaining
`src/utils/cookie.test.ts` failures (24/35 on the branch that closed
[#5370](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5370-typed-array-carrier-host-boundary-fidelity)):
four "Should parse signed cookies…" cases, four more verify-side cases that
answer `false` where a value was expected, and "Should serialize signed cookie
with all options". The verify side fails for the same reason —
`verifySignature` (cookie.ts:58-62) cannot match a signature produced from a
truncated buffer.

A tenth, "Should serialize a signed cookie", fails on this AND on a second,
unrelated defect; the eleventh, "Should serialize cookie", fails on that second
defect ALONE — a spurious `Max-Age=0` emitted for an ABSENT `maxAge` option
([#6423](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6423-absent-number-property-stringifies-as-nan)).
So the expected mover for this issue by itself is **24/35 → 33/35**, not 34 and
not 35; the last two need #6423 as well.

## Acceptance criteria

1. `String.fromCharCode(...xs)`, `Array.of(...xs)` and a fixed-arg-plus-spread
   call all expand every element, for a plain array, a compiled TypedArray
   carrier, a buffer-backed view and a host typed array.
2. Anti-vacuity: the no-spread, `.apply`, user-rest-function and `Math.max`
   forms above stay correct (they are correct today — a fix that reroutes
   everything through one path must not regress them).
3. Regression test under `tests/`, untyped `.js` two-file fixture, failing on
   the parent and passing with the fix, exact counts both ways.
4. A/B over the 17 dogfood suites at one HEAD. hono `src/utils/cookie.test.ts`
   24/35 → 33/35 is the expected mover if the attribution above holds.
5. Standalone lane status recorded.

## Dispatch

Model: **opus**. The failing and working forms are both located and contrast
cleanly, so the diagnosis is cheap; the care is in not regressing the four
forms that already work.
