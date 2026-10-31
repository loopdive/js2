---
id: 7164
title: "Native-first and standalone: growing an externref vec via `length =` fills the new slots with null instead of holes"
sprint: current
created: 2026-10-25
updated: 2026-10-31
task_type: bugfix
area: codegen
goal: correctness
parent: 6979
status: done
completed: 2026-10-28
reasoning_effort: high
priority: medium
horizon: s
feasibility: medium
language_feature: arrays
related: [7151, 7154, 7165]
# 2026-10-28 (#7164 r4/r6): `[0, ...g]` must pick the externref carrier when
# `g` is a binding #7164 moved onto it, decided in compileArrayLiteral's
# existing dynamic-element predicate (literals.ts +3 incl. import).
# 2026-10-28 (#7164 r5): the callback-method loops re-read the receiver's
# backing array each iteration (`loopExitCheck` / `loopExitCheckReverse`,
# reduceRight, both join folds) so a callback that grows the array (push or
# `length =`) is seen — array-methods.ts owns those loops.
# 2026-10-31 (#7164 r7): array-methods.ts also owns indexOf / includes /
# lastIndexOf: they re-read the backing after a growing `fromIndex`, and their
# native equality helpers register the box types they need instead of
# returning null; the loops skip the backing check for a pure inline callback.
# 2026-10-28 (#7164 r6): `arr.length++` / `--` / `+=` / `-=` on a binding
# #7164 moved onto the externref carrier route through the shared static
# length store (array-length-define.ts) from their existing entry points
# (unary-updates.ts compileMemberIncDec, operator-assignment.ts) — one guarded
# call each; every other receiver keeps origin/main's code.
# 2026-10-28 (#7164 r6): array-holes.ts +3 — the hole pre-scan (the one pass
# that arms reads and stores together) must also arm on the update forms and
# record each root for the frozen-array risk scan; the logic lives in
# statements/array-share-group.ts, array-holes.ts only calls it.
loc-budget-allow:
  - src/codegen/array-holes.ts
  - src/codegen/literals.ts
  - src/codegen/array-methods.ts
  - src/codegen/expressions/operator-assignment.ts
  - src/codegen/expressions/unary-updates.ts
func-budget-allow:
  - src/codegen/literals.ts::compileArrayLiteral
  - src/codegen/expressions/unary-updates.ts::compileMemberIncDec
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

## Resolution (2026-10-31, review round 7)

**Design: only switched bindings change.** The new length store applies to the
arrays it was built for. Every other array compiles as on `origin/main`.

- **Switched binding.** A non-escaping, string-only `any[]` built by `push`
  (not seeded by a non-empty literal) that has a growing `x.length = n`, and
  whose share group stays local: no parameter, field, container or other
  endpoint receives the vec. Example: `const g: any[] = []; g.push('y');
  g.length = 3;` — #7154 used to store `g` as a typed string vec, so the new
  slots read `null` and `sort()` trapped. #7164 moves such a group onto the
  externref carrier, and every member gets the new store:
  - a grow fills the new slots with the canonical `undefined`. Past capacity
    it reallocates to `min(max(newLen, 2·cap), 16M)`;
  - `++` / `--` (prefix and postfix) and `+= k` / `-= k` use the same store,
    with ToUint32 validation (RangeError).
- **Every other receiver** (mixed `any[]`, literal-seeded arrays, parameters,
  property chains, typed vecs) keeps `origin/main`'s shrink-only store and
  update forms, byte-identical. Round 6's "keep" grow (null → `undefined` on
  every externref vec) is gone.
- **Decline guards.** The update forms keep `origin/main`'s route in two cases:
  - the module never arms hole-aware reads;
  - the module mentions `defineProperty`, `defineProperties`, `freeze`, `seal`
    or `preventExtensions`. The carrier switch is blocked there too.
- **Pre-scan.** The hole pre-scan arms on `++` / `--` / `+=` / `-=` of
  `.length` exactly as it does on `=`.

**Other fixes.**

- **`indexOf` / `includes` / `lastIndexOf` on an externref vec.** Their native
  equality helpers need the box types. When no earlier use had registered
  them, the method returned `null` and the call silently became a constant
  (`g.indexOf('zz')` → `0`, `g.includes(undefined)` → `false`). They now
  register them (`addUnionImports`).
- `find` / `findLast` on an externref vec return the canonical `undefined`
  when nothing matches.
- **Callback loops** re-read the backing when it changes, so a callback that
  grows the array (`push` or `length =`) is seen. There is no early exit. An
  inline arrow or function expression with no call, `new`, tagged template,
  assignment, `++` / `--` or `delete` cannot replace the backing, so its loop
  skips the check.
- `indexOf` / `includes` re-read the backing after a `fromIndex` whose
  `valueOf` grows the array.
- `[0, ...g]` takes the externref carrier only when `g` is a switched binding.

**Structure.** `array-length-update.ts` is folded into `array-length-define.ts`
and its `compiler-boundaries.json` entry is gone. The import-cycle ratchet
passes (largest SCC equal to `origin/main`'s). No host imports and no new raw
checker calls.

**Fixtures and how to regenerate them.**
`scripts/record-7164-bases.mts` records both `origin/main` fixtures, or checks
them:

```bash
node --import ./scripts/record-7164-bases-loader.mjs --import tsx \
  scripts/record-7164-bases.mts [--base <rev>] (--write | --check)
```

- `issue-7164-length-update-sweep-base.json`: every sweep cell where
  `origin/main` differs from node ("wrong", or "trap" for a trap or compile
  error).
- `issue-7164-leak-base.json`: per leak setup / case / lane, the leaks head
  still shares with `origin/main`. Recording refuses when head has a leak
  `origin/main` lacks.
- `--check` recomputes both and fails when either differs from the committed
  file, so a stale entry cannot widen what the test allows. It takes about
  26 minutes.
- Recorded against `origin/main` 51040d3a01 (unchanged from b6250f09f8 and
  e4f9da2ed6).

**Tests.** `tests/equivalence/issue-7164-externref-vec-length-growth.test.ts`
runs gc native-first, standalone and wasi against node, all green; known gaps
are named `it.fails` rows.

| Block | Rows |
|---|---|
| Programs × reads | 6 × 12 × 3 |
| Share-group and length-update guards | 30 × 3 |
| Readers after a grow | 35 × 3 |
| Generated "matches node" sweep | 37 × 3 |
| Marker-leak detector, relative to `origin/main` | 9 setups × 3 lanes (37 cases each) |
| Callbacks that grow the array | 14 methods × 2 × 3 |
| Length-update sweep, head never worse than `origin/main` | 44 of 1,008 rows × 3 (all with `JS2WASM_FULL_SWEEP=1`) |

Round 7 added guard rows for the mixed-array, parameter and literal-seeded
grows ("same as `origin/main`"), and for the folded searches.

**Results against `origin/main`.**

- **Full length-update sweep** (3,024 cells): **0 worse**, 58 better, 824 both
  match node, 2,142 both wrong.
- **Leak detector:** 0 leaks head adds; 576 leaks shared with `origin/main`.
  Mutant check (round 6): filling the grow with `null` again fails 18 of the
  27 detector rows.
- **Review probe sets r1–r6** (old0–5, U, V, W, X, L, L2, DB, A, B2, C, D, E,
  E2, E3, F, G, H, I: 1,478 programs × 3 lanes, head vs `origin/main`):
  193 improved, 337 both match node, 862 both wrong identically, 78 both wrong
  differently, **8 regressed**, 0 new traps or compile errors. All 8 are the
  #7170 class below: 4 in L, 1 in L2, 3 in A. Set B's first 33 rows were not
  re-run (row 34 hangs on wasi on both trees, see Left out); round 6 found no
  regression among them.

**Known regressions (gc and standalone; tied to #7170).** On a switched
binding a grown slot is a present `undefined`. `origin/main`'s `null` slot
happened to give node's answer for a search for `undefined`:

- `indexOf(undefined)` / `lastIndexOf(undefined)` after a grow, directly or
  inside a `fromIndex` `valueOf`;
- `some(v => v === undefined)` / `every(v => v !== undefined)`.

**Timing** (n = 100,000, 50 reps, best of 3 runs):

| | gc main → head | standalone main → head |
|---|---|---|
| `any[]` `findIndex` | 37.5 → 37.2 ms | 38.1 → 38.4 ms |
| `number[]` `findLastIndex` | 6.1 → 6.1 ms | 6.1 → 6.3 ms |
| `any[]` `forEach` (mutating callback) | 107.4 → 107.6 ms | 105.7 → 110.0 ms |
| `any[]` `reduce` | 217.4 → 207.2 ms | 208.5 → 221.0 ms |

The round-6 `findLastIndex` cost is gone: a pure inline callback skips the
backing check.

**A large grow allocates eagerly** on a switched binding:
`g.length = 5e6` costs tens of milliseconds where `origin/main` did nothing,
and then trapped on any read past the backing. The cost is linear.

**Left out.**

- **#7170 (holes):** a grown index is present. `in`, `hasOwnProperty`,
  for-in, `Object.keys`, callbacks, `indexOf` and copies see it.
- **#7171 (wasi):** `in` answers wrongly on dense and grown arrays.
- **Number-holding arrays:** an f64 carrier grows with `0`s, as on
  `origin/main`.
- **Same as `origin/main`, kept as `it.fails` rows:**
  - update forms on a string-only `any[]` with no growing `length =` (still a
    #7154 string vec) emit invalid wasm;
  - `pop()` then `length++` brings the popped value back;
  - wasi `length++` on a dense `any[]` is lost, so
    `while (g.length < 5) g.length++` never terminates;
  - a literal-seeded string vec's grown slots read `null`, so
    `includes(undefined)` is false;
  - `apply` and dynamic reads through `any` read `null`;
  - `super(...r)` from a rest constructor forwards nothing.
- **Pre-existing, not fixed here:** `[0, ...g]` with a literal-seeded string
  `any[]` reads the strings as `NaN`.

**Bytes** (unoptimized, `origin/main` vs head). Corpus: 306 programs per
lane — 13 playground examples, 4 benchmark suites and 289 array-using sources
extracted from `tests/equivalence`. No program changed compile status.

| Lane | Playground | Benchmark suites | Equivalence sources |
|---|---|---|---|
| gc | 0 changed | 3 changed, +137 B | 17 changed, +610 B |
| standalone | 0 changed | 3 changed, +137 B | 17 changed, +610 B |
| wasi | 0 changed | 3 changed, +172 B | 16 changed, +575 B |

Most of it is the callback loops' backing check (a mutating callback). The
other sources: `find` / `findLast` and a two-argument `indexOf` / `includes`
on an externref vec, and the length stores of a switched binding.
