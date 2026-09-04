---
id: 5307
title: "Standalone: an array-like hole reaching a string-typed element position traps `illegal cast` instead of throwing"
status: ready
sprint: current
created: 2026-09-03
updated: 2026-09-03
priority: medium
horizon: s
feasibility: medium
goal: standalone-mode
reasoning_effort: medium
---

## Problem

On `--target standalone`, when an `undefined` element is written into an
array whose element carrier the compiler inferred as **string**, the
carrier conversion traps (`illegal cast`) instead of producing a JS-visible
`TypeError` or a correct `undefined`. The trap is uncatchable, so the whole
program dies where node runs on.

```js
var a = Array.from({ length: 3, 1: "m" });   // holes at 0 and 2
a.length;        // node: 3   standalone: TRAP illegal cast (uncatchable)

var b = Array.from([undefined, "m"]);        // same trap on main, no Array.from change needed
```

The second form reproduces identically on `main` (measured 2026-09-03 against
a `git archive` of `origin/main` 744203f3c7), so the defect is in the
undefined-in-string-lane carrier conversion, not in `Array.from`.

## Why it is filed now

The #5268 r3 pass replaced the drain-only `Array.from` lowering with a native
§23.1.2.1 implementation that has a real array-like branch. Before it, the
first form threw a catchable `TypeError` (the array-like walk did not exist
and the value fell through to `__iterator`'s refusal); now it reaches the
carrier conversion and traps. That is a stable-throw → trap change on the
first form only — recorded in that lane's round-3 report as the single row
behind an otherwise clean "never worse than base", and confirmed not to flip
any test262 row (`built-ins/Array/{from,of}/**` 50/63 with none lost).

## Root cause

The string carrier's write path assumes every element is a native string and
casts unconditionally; `undefined` (and `null`) have no representation in
that lane, so the cast traps. The choice of a string carrier is made from the
static element type, which an array-like with holes cannot contradict at
compile time.

## Acceptance criteria

- `Array.from({ length: 3, 1: "m" })` and `Array.from([undefined, "m"])`
  answer `length 3` / `2` and index reads of `undefined` where node does, or
  at minimum throw a catchable `TypeError`; no uncatchable trap on either
  form, on `--target standalone` and `--target wasi`.
- Host-lane binaries byte-identical for programs with no `undefined` in a
  string-typed array (this is standalone carrier code).
- `built-ins/Array/from/**` and `built-ins/Array/of/**` standalone rows: none
  lost against the promoted baseline; report the count before and after.
- Any change to the carrier's element admission must be carried on the
  VALUE (widen the carrier when `undefined` can reach it), not on the
  syntactic source shape.

## Related

- #5268 — the r3 `Array.from` native whose array-like branch now reaches this
  path; its round-3 report is where this row is recorded.
- #5296 — sibling "one representation, two meanings" defect in
  `__to_primitive`, filed the same day.
