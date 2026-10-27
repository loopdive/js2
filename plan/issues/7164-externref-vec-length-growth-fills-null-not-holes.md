---
id: 7164
title: "Native-first and standalone: growing an externref vec via `length =` fills the new slots with null instead of holes"
sprint: current
created: 2026-10-25
updated: 2026-10-27
task_type: bugfix
area: codegen
goal: correctness
parent: 6979
status: done
completed: 2026-10-27
reasoning_effort: high
priority: medium
horizon: s
feasibility: medium
language_feature: arrays
related: [7151, 7154, 7165]
---

# #7164 — `g.length = 3` on an externref vec creates null elements

Found while implementing #7151 (PR #6918). Pre-existing on `origin/main`, gc
native-first and standalone (host-assisted correct):

```js
const g: any[] = []; g.push("y"); g.length = 3;
console.log(1 in g);          // true    (node: false)
console.log(String(g[1]));    // "null"  (node: "undefined")
g.sort(); console.log(g.join("|"));   // traps on the native lanes   (node: "y||")
```

## Cause (as diagnosed; verify before fixing)

The `length` setter growth path on `$__vec_externref` (`grep -rn "length" src/codegen/array-length*.ts src/codegen/array/`) extends storage with wasm null, and the element read / `in` / enumeration paths treat null as a present JS `null` instead of the `$Hole` sentinel the vec uses elsewhere (#7151 sorts holes last by testing `$Hole`). Typed numeric vecs have their own hole encoding; the externref vec must use `$Hole`.

## Implementation Plan (Fable, 2026-10-25; implement on Opus)

1. Reproduce the program plus `g.length = 0; g.length = 2`, `delete g[0]`, and `new Array(3)` on gc native-first and standalone; list which reads (index, `in`, `hasOwnProperty`, for-in, `join`, `sort`, `forEach` skip) are wrong.
2. Fill grown slots with the vec's `$Hole` sentinel (the same value `delete` and `new Array(n)` must produce — unify on one constructor helper); make `join` and `sort` treat a hole as empty / last as they already do for `$Hole`. Do not add host imports; host-assisted gc bytes unchanged.
3. Tests: `tests/issue-7164-externref-vec-length-growth.test.ts` with the programs from step 1 on gc native-first and standalone vs node.

Acceptance: node's output for all programs; no trap in `join` after `sort`; host-assisted gc bytes unchanged; equivalence gate no new regressions.

## Resolution (2026-10-27)

Test: `tests/equivalence/issue-7164-externref-vec-length-growth.test.ts` (gc
native-first, standalone, wasi vs node; 6 programs × 11 reads × 3 lanes).

**Diagnosis (verified).** Two causes, both on `origin/main` 2b0565cb14:

1. The static `arr.length = n` store (`expressions/assignment.ts`) wrote only
   the length field. Its hole fill (`vec-length-hole-fill.ts`) was
   `shrink-only`, so a grow exposed whatever the backing held: the `null`s
   `array.new_default` and every capacity grow leave in an externref vec
   (`g[1]` read `null`, `1 in g` true, `sort()` moved them first), and past the
   capacity nothing was reallocated at all.
2. When the binding does not escape, `inferArrayVecType`
   (`statements/array-vec-inference.ts`, #7154) re-types `const g: any[] = []`
   with only string pushes as a typed string vec, which has no hole
   representation at all — so even a correct fill had nothing to write.

**Fix.**

- New fill mode `length-store` for the static store: f64 carriers keep the
  `shrink-only` fill unchanged; an externref carrier also grows — the backing
  is reallocated to `newLen` when `cap < newLen <= 16M` (the guard the
  defineProperty and `__extern_set` length paths already use) and
  `[min(old, new), cap)` is filled with `$Hole`. The `arr[len] = v;
  arr.length = len + 1` append shape stores an unchanged length (the element
  write already bumped it), so nothing it wrote is overwritten; the test has an
  `append` row for it.
- `inferArrayVecType`: a growing length store (`x.length = n` with `n` not the
  literal `0`, `x.length += n`, `x.length++`) forces the dynamic carrier
  unless the inferred element is f64 — the same rule #7154 applies to a hole in
  a seed literal. Clearing with `length = 0` keeps the inferred kind.

No host imports; no new raw checker calls. Programs without a growing
`length` store on an inferred array, and without a static `length` store on an
externref vec in a hole-armed module, compile byte-identically.

**Now correct after `length` growth (gc + standalone):** index read, `in`,
for-in, `join`, `forEach` skip, `Object.keys`, `JSON.stringify`, `sort`
(holes last, no trap). wasi: index, `join`, `forEach`, `JSON.stringify`, `sort`.

**Left out** (rows are `it.fails` in the test with the owning issue, so a fix
flips them):

- `hasOwnProperty` (gc/standalone) and `map` (all lanes) do not recognise
  `$Hole` on an externref vec — #7170.
- wasi `in` and for-in report holes as present — #7171.
- `delete g[i]` keeps the value in the slot (`join` / `forEach` / `map` /
  spread / `sort` see it) — #7169 / #7170; wasi delete reads — #7171.
- `new Array(3)` on gc native-first (`in`, `hasOwnProperty`, for-in,
  `forEach`, `map`, `Object.keys`) — #7170. Not fixed here as a side effect:
  #7170's `d[4] = "a"; 2 in d` gap-fill row, #7169 and #7180 are untouched.
- Untracked, found here: `[...g]` copies a hole as a hole (should read as a
  present `undefined`) on gc/standalone for any holey externref vec; wasi
  `Object.keys` / `hasOwnProperty` on an `any[]` are wrong even when dense.
- Typed vecs other than externref are out of scope: a declared
  `number[]` grow still answers `1 in a` true (the f64 marker is written only
  on shrink), and a declared `const s: string[] = ["a"]; s.length = 3; s[1]`
  traps "array element access out of bounds" on all three lanes (same on
  `origin/main`; untracked).

**Bytes** (unoptimized; 13 playground examples + 1,690 sources extracted from
`tests/equivalence/*.test.ts` + this issue's 6 programs; base `origin/main`
2b0565cb14 vs head): playground examples unchanged on every lane. Changed: the
three `array-push-pop.test.ts` programs with a `length` store (+84 B each, all
lanes) and the four growth programs here (gc +629..+882, standalone
+537..+807, wasi +105..+321). Totals: gc +3,193, standalone +2,842,
wasi +1,060 over 1,709 programs.
