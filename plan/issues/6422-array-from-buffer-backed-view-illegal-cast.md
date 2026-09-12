---
id: 6422
title: "`Array.from(new Uint8Array(<host ArrayBuffer>))` traps with `illegal cast`"
status: ready
sprint: current
created: 2026-09-12
updated: 2026-09-12
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

```js
// untyped .js half; `buf` is a host ArrayBuffer (crypto.subtle.sign's result)
export function arrayFromView(buf) {
  return Array.from(new Uint8Array(buf)).length;
}
```

Compiled code **traps**: `illegal cast`. Node answers 32.

A trap is worse than a wrong answer — it takes the whole module down, and an
unobserved one inside a host promise zeroes an entire dogfood file.

## What is and is not implicated

Measured in one run on `cf82f78d6d` (2026-09-12), all through the same untyped
two-file fixture:

| form                                                   | result         |
| ------------------------------------------------------ | -------------- |
| `new Uint8Array(hostAb).length`                        | 32 — correct   |
| reading the view's bytes by index                       | correct        |
| `Math.max(...new Uint8Array(hostAb))`                   | correct        |
| `Array.from(new Uint8Array(hostAb))`                    | **illegal cast** |

So the buffer-backed view is built correctly and is indexable; it is
`Array.from` over it that casts to the wrong carrier. `new Uint8Array(buffer)`
produces a shared-backing `$__ta_view` STRUCT rather than one of the plain
`$Vec`s (the distinction #5150 had to add to `isViewRefTestInstrs`), and the
`Array.from` lowering most likely `ref.cast`s its argument to a `$Vec`
unconditionally. That is the first thing to check.

## Acceptance criteria

1. `Array.from(new Uint8Array(hostAb))` answers the buffer's byte length with
   equal contents, and does not trap.
2. Anti-vacuity: `Array.from` over a plain array, over a compiled
   `new Uint8Array([…])` carrier, and over a host typed array all keep working.
3. Regression test under `tests/`, untyped `.js` two-file fixture, failing on
   the parent (as a TRAP, so assert the trap) and passing with the fix.
4. A/B over the 17 dogfood suites at one HEAD.
5. Standalone lane status recorded — the `$__ta_view` carrier exists there too,
   so check whether the trap reproduces without a JS host.

## Provenance

Found while closing
[#5370](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5370-typed-array-carrier-host-boundary-fidelity),
in the probe that also produced
[#6421](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6421-spread-into-static-builtin-drops-arguments).
Neither #5370 nor #6421 touches this path.

## Dispatch

Model: **opus**. One trap, one likely cast site, but the fix has to distinguish
the two TypedArray carriers rather than widening the cast.
