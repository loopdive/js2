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

## Resolution (2026-10-28, review round 6)

**Design: conservative by default.** The new length store applies only to the
receivers it was built for. Everything else compiles as on `origin/main`.

- **Who gets the new behaviour.** A binding #7164 moves onto the externref
  carrier: a non-escaping, string-only `any[]` that has a growing
  `x.length = n` somewhere. Example: `const g: any[] = []; g.push('y');
  g.length = 3;` — #7154 used to store `g` as a typed string vec, so the new
  slots read `null` and `sort()` trapped.
  - A grow fills the new slots with the canonical `undefined`. Past capacity
    it reallocates to `min(max(newLen, 2·cap), 16M)`.
  - `++` / `--` (prefix and postfix) and `+= k` / `-= k` on such a binding use
    the same store, with ToUint32 validation (RangeError).
- **Other externref vecs** (mixed `any[]`, parameters, property chains). A
  `length = n` grow only replaces `null` slots with `undefined` ("keep" mode).
  A `$Hole` left by an earlier shrink stays, as on `origin/main`. The update
  forms keep `origin/main`'s code.
- **Typed vecs** (`string[]`, `number[]`, `boolean[]`, objects) keep
  `origin/main`'s code.
- **Decline guards.** The update forms keep `origin/main`'s descriptor-aware
  route in two cases:
  - the module never arms hole-aware reads;
  - the module mentions `defineProperty`, `defineProperties`, `freeze`, `seal`
    or `preventExtensions`, since a non-writable length or a non-configurable
    element cannot be ruled out. The carrier switch is blocked there too.
- **Pre-scan.** The hole pre-scan now arms on `++` / `--` / `+=` / `-=` of
  `.length` exactly as it does on `=`.

**Other fixes.**

- `find` / `findLast` on an externref vec return the canonical `undefined`
  when nothing matches (they returned `null`).
- Callback loops re-read the backing when it changes, so a callback that grows
  the array (`push` or `length =`) is seen. The common path costs one field
  read and a `ref.eq`. There is no early exit: the find family keeps calling
  the callback up to the original length.
- `indexOf` / `includes` re-read the backing after a `fromIndex` whose
  `valueOf` grows the array. `lastIndexOf` already read it afterwards.
- `[0, ...g]` takes the externref carrier only when `g` is a switched binding.

**Structure.** `array-length-update.ts` is folded into `array-length-define.ts`
and its `compiler-boundaries.json` entry is gone. Import cycles: largest SCC
724, unchanged. The risk scan, switched-binding set and pre-scan hooks live in
`statements/array-share-group.ts`, outside the SCC. No host imports and no new
raw checker calls.

**Tests.** `tests/equivalence/issue-7164-externref-vec-length-growth.test.ts`
runs gc native-first, standalone and wasi against node: 744 rows by default,
all green. 98 of them are `it.fails` known gaps, each named.

| Block | Rows |
|---|---|
| Programs × reads | 6 × 12 × 3 |
| Share-group and length-update guards | 23 × 3 |
| Readers after a grow | 35 × 3 |
| Generated "matches node" sweep | 37 × 3 |
| Marker-leak detector | 9 setups × 3 lanes (37 cases each) |
| Callbacks that grow the array | 14 methods × 2 × 3 |
| Length-update sweep, head never worse than `origin/main` | 44 of 1,008 rows × 3 (all with `JS2WASM_FULL_SWEEP=1`) |

- **Length-update sweep** (`issue-7164-length-update-sweep-cases.ts`).
  - Dimensions: form (`= 4`, `++`, `--`, `++x`, `--x`, `+= 2`, `-= 1`) ×
    element (`any[]` string-only, `any[]` mixed, `string[]`, `number[]`,
    `boolean[]`, objects) × setup (plain, after `push`, after `pop`, after a
    shrink) × a plain `length =` elsewhere or not × receiver (local,
    parameter, `o.p.arr`).
  - `issue-7164-length-update-sweep-base.json` records each cell where
    `origin/main` (2b0565cb14) differs from node.
  - Rule: where `origin/main` matched node, head must match node. Where it did
    not, head must not trap or fail to compile.
- **Marker-leak detector, now relative to `origin/main`.**
  - `issue-7164-leak-base.json` lists the leaks head still shares with
    `origin/main` (same index, same kind). Any other leak fails.
  - A cell this PR fixed is not listed, so regressing it fails. Mutant check:
    filling the grow with `null` again fails 18 of the 27 detector rows
    (298 leaks).

**Results against `origin/main` 2b0565cb14.**

- **Full length-update sweep** (1,008 rows × 3 lanes = 3,024 cells):
  - worse: 0;
  - better: 88;
  - both match node: 824;
  - both wrong, identically: 2,018 (293 differ only in `i in g`);
  - both wrong, differently: 94 (73 where head's values match node and only
    `in` differs; 6 where `origin/main` failed to compile).
- **Leak detector** (333 cases × 3 lanes): 0 new leaks, 230 fixed, 570 shared
  with `origin/main`.
- **Review probe sets r1–r5** (old0–5, U, V, W, X, L, L2, DB): 0 regressions,
  except the 4 `indexOf` rows below.

**Known regressions (gc and standalone; tied to #7170).** On a switched
binding a grown slot is a present `undefined`. `origin/main`'s slot held
`null` (wrong in other ways), so a few hole-skipping reads were right by
accident there:

- `indexOf(undefined)` after a shrink-then-grow or a grow (4 L / L2 probe rows);
- `some(v => v === undefined)` / `every(v => v !== undefined)`.

Real holes are #7170.

**findIndex timing** (`any[]`, n = 100,000, 50 reps, best of 3 runs; the box
was shared with another agent's run, so medians are noise):

| | gc | standalone |
|---|---|---|
| `any[]` `findIndex`: base → head | 42.0 → 40.7 ms | 38.3 → 40.7 ms |
| `number[]` `findLastIndex`: base → head | 6.3 → 8.2 ms | 6.6 → 8.6 ms |
| `any[]` `forEach`: base → head | 20.9 → 20.2 ms | 19.6 → 19.2 ms |

The `findLastIndex` cost is the per-iteration backing check. It is what makes
a callback that pushes past capacity visible.

**Left out.**

- **#7170 (holes):** a grown index is present. `in`, `hasOwnProperty`,
  for-in, `Object.keys`, callbacks, `indexOf` and copies see it.
- **#7171 (wasi):** `in` is false even for present indices.
- **Number-holding arrays:** an f64 carrier grows with `0`s, as on
  `origin/main`.
- **Same as `origin/main`, marked as `it.fails` rows:**
  - update forms on a string-only `any[]` with no growing `length =` (still a
    #7154 string vec) emit invalid wasm;
  - `pop()` then `length++` brings the popped value back;
  - wasi update forms on a dense `any[]` are lost, and `++o.p.arr.length`
    reads `NaN`;
  - wasi `indexOf` / `includes` miss a value written by `fromIndex`'s
    `valueOf`;
  - `apply` and dynamic reads through `any` read `null`;
  - `super(...r)` from a rest constructor forwards nothing;
  - typed-vec groups keep the `null` fill and trap past capacity.

**Bytes** (unoptimized, base 2b0565cb14 vs head). Corpus: 282 programs per
lane — 13 playground examples, 4 benchmark suites and 265 array-using sources
extracted from `tests/equivalence`. No program changed compile status.

| Lane | Playground | Benchmark suites | Equivalence sources |
|---|---|---|---|
| gc | 0 changed | 3 changed, +207 B | 23 changed, +830 B |
| standalone | 0 changed | 3 changed, +207 B | 23 changed, +830 B |
| wasi | 0 changed | 3 changed, +312 B | 22 changed, +795 B |

Almost all of it is the callback loops' backing check (a few tens of bytes
per loop). The other sources of growth: a `length =` grow on an externref vec,
`find` / `findLast` on an externref vec, a two-argument `indexOf` / `includes`
on an externref vec, and the update forms on a switched binding. A program
with none of these is byte-identical.
