---
id: 7164
title: "Native-first and standalone: growing an externref vec via `length =` fills the new slots with null instead of holes"
sprint: current
created: 2026-10-25
updated: 2026-10-28
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
# 2026-10-28 (#7164 r4): `[0, ...anyArr]` must pick the externref carrier
# (the grown array now lives in it), decided in compileArrayLiteral's existing
# dynamic-element predicate (literals.ts +2).
# 2026-10-28 (#7164 r5): the callback-method loops re-read the receiver's
# backing array each iteration (`loopExitCheck` / `loopExitCheckReverse`,
# reduceRight, both join folds) so a callback that grows the array (push or
# `length =`) is seen — array-methods.ts owns those loops. `arr.length++` /
# `--` / `+=` / `-=` route through the shared static length store
# (array-length-update.ts) from their existing entry points
# (unary-updates.ts compileMemberIncDec, operator-assignment.ts) — one guarded
# call each.
loc-budget-allow:
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

## Resolution (2026-10-28)

**Test.** `tests/equivalence/issue-7164-externref-vec-length-growth.test.ts`
runs gc native-first, standalone and wasi against node: 579/579.

| Block | Size |
|---|---|
| Programs × reads | 6 × 12 |
| Share-group and length-update guards | 14 |
| Readers after a grow | 35 |
| Generated "matches node" sweep | 37 array-producing methods and call forms |
| Generated marker-leak detector | 37 cases × 7 grow setups |
| Callbacks that grow the array | 14 methods × {`length =`, `push`} |

The 7 grow setups are:

- growing within capacity;
- growing past capacity (reallocation);
- shrinking, then `length++`, `++length`, `+= 2` or `= n`;
- clearing, then `+= 3`.

**Design: grown slots hold the canonical `undefined`, not `$Hole`.** Rounds
1–3 filled grown slots with the `$Hole` marker and patched readers one at a
time. Each review then found another reader that handed the marker to user
code. Round 4 switched to `undefined`, which cannot leak by construction, and
reverted the reader patches.

The cost: a grown index is a present `undefined`, not a hole. `in`,
`hasOwnProperty`, for-in, `Object.keys` and the callback methods see it — the
same answers as `origin/main`, whose slot held `null`. Real holes are #7170;
wasi `in` is #7171.

**Diagnosis (verified on `origin/main` 2b0565cb14).**

1. **The static `arr.length = n` store never filled a grow.** It writes only
   the length field, and its fill ran only on shrink. A grow exposed the
   backing's default `null`s, and nothing was reallocated past the capacity.
2. **The update forms bypassed that store.** `length++` / `--` went through
   the dynamic `__extern_set` arm, which fills a grow with `$Hole` and is
   quadratic in a loop (40k one-step grows took 4.1 s). `length += k` /
   `-= k` wrote field 0 directly, with no fill at all.
3. **A non-escaping `any[]` lost its carrier.** `inferArrayVecType` (#7154)
   re-types a string-only `const g: any[] = []` as a typed string vec. Its
   slots read `null`, and `sort()` traps.
4. **Callback loops read a stale backing.** The callback-method loops read the
   backing array they loaded before the loop. A callback that grows the array
   by `push` (on `origin/main`) or by `length =` (once growth reallocates)
   writes into a new backing the loop never sees.

**Fix.**

- **`array-length-update.ts` (new): one static length store for every form.**
  - `emitArrayLengthStore` handles `arr.length = n`, and
    `tryCompileArrayLengthUpdate` handles `++` / `--` (prefix and postfix) and
    `+= k` / `-= k` with a numeric `k`.
  - Every form is ToUint32-validated (RangeError) and goes through the same
    fill.
  - A store of the literal `0` emits no grow code: it is byte-identical to
    `origin/main`'s shrink.
- **`vec-length-hole-fill.ts`: new `length-store` mode.**
  - A shrink marks the dropped slots `$Hole`, as on `origin/main`.
  - A grow of an externref carrier reallocates when `cap < newLen <= 16M`, to
    `min(max(newLen, 2·cap), 16M)`. The doubling keeps a one-step grow loop
    amortised O(1).
  - The grow then fills only `[oldLen, min(newLen, cap))` with the canonical
    `undefined`.
- **`array-methods.ts`: callback loops re-read the backing every iteration.**
  - This covers `loopExitCheck` / `loopExitCheckReverse`, reduceRight and both
    join folds.
  - A backing that is now shorter than the index ends the loop, or clamps it
    in reverse loops.
  - This also fixes the pre-existing `push` trigger.
- **`array-share-group.ts` / `array-vec-inference.ts`: the whole share group
  decides the carrier.**
  - A growing `x.length = n` switches the group to the dynamic carrier only
    as a whole. An unshared binding switches alone, unless its vec is f64.
  - Pure reads do not count as uses that block the switch:
    - `in`;
    - `[...xs]` and spread into a library call;
    - `String`, `JSON.stringify`, `Object.keys`,
      `Object.getOwnPropertyNames` and `Array.isArray`, matched by resolved
      lib symbol.
  - A user call `f(...xs)` is not a pure read: a rest parameter receives `xs`
    itself.
- **`literals.ts`: `[0, ...anyArr]` takes the externref carrier**, so `'y'` is
  no longer coerced to `NaN`.
  - This also changes some programs that never grow an array.
  - `export function t(a: any[]) { const b = [0, ...a]; return b.length; }`
    shrinks from 104,770 B to 41,162 B on gc and from 93,617 B to 32,758 B on
    standalone; wasi is 52,318 B → 52,169 B (review r4 measurement).
  - Results are unchanged.

No host imports and no new raw checker calls. The new module is classified in
`scripts/compiler-boundaries.json`.

**Timings** (one-step grow loop, n = 40,000, unoptimized). Before = merge base;
after = this branch.

| Loop | gc before → after | standalone before → after | wasi before → after |
|---|---|---|---|
| `g.length = i + 1; g[i] = 'v'` | 1.9 → 1.2 ms | 9.1 → 1.4 ms | 1.0 → 2.0 ms |
| `g.length = g.length + 1` | 0.9 → 1.2 ms | 0.5 → 1.0 ms | 1.4 → 3.8 ms |
| `g.length++` | **4,100 → 0.5 ms** | **3,971 → 0.5 ms** | wrong result (1) → 1.5 ms |

The round-4 head took 4,655 ms on the first loop.

**Results against `origin/main`.**

- **Test rows** (144 rows × 3 lanes): 78 improved, 2 regressed. Both
  regressions are `g.some(v => v === undefined)` / `every`, explained below.
- **Review probe sets** r1–r4 (A–O, 511 programs × 3 lanes): 0 regressions.
- **#6937 share-group sets:** identical results. Their bytes differ, because
  every callback loop now re-reads the backing.

**The one known regression.** `g.some(v => v === undefined)` /
`every(v => v !== undefined)` on gc and standalone. `origin/main` got this
right only because its slot held `null`. Skipping the slot needs real holes,
so it is an `it.fails` row under #7170.

**Left out.** Each of these is an `it.fails` row with its owner, unless noted.

- **#7170 (holes):** a grown index is present. `in`, `hasOwnProperty`,
  for-in (`012` where node has `0`), `Object.keys` / `values`, callbacks,
  `indexOf`, and copies (`slice`, `concat`, `splice`, `flat`, `flatMap`) all
  see it. The `delete` and `new Array(n)` rows are also #7170.
- **#7171 (wasi):** `in` is false even for present indices.
- **#7169:** `delete` followed by `sort`.
- **Number-holding arrays are not covered.** An f64 carrier (`number[]`, or a
  number-only `any[]`) grows with the backing's `0`s: `g.length = 6;
  String(g[4])` reads `0` (node `undefined`), and `sort()` gives
  `0|0|0|1|2|3`. This is the same on `origin/main`. The f64 hole marker
  exists, but filling it on grow is not done here.
- **Untracked, identical on `origin/main`:**
  - `toSorted` and `Array.from(anyVec)` trap;
  - an object-literal method with a rest parameter emits invalid wasm;
  - `super(...r)` from a rest constructor forwards nothing;
  - `apply` and dynamic reads through `any` read `null`;
  - `push(...g)` pushes one element;
  - wasi `Array.of(...g)` needs a host import;
  - wasi `Object.keys` / `hasOwnProperty` are wrong on a dense `any[]`;
  - typed-vec groups (declared `string[]` / `boolean[]`, typed aliases) keep
    the `null` fill and trap out of bounds past capacity;
  - a comparator's writes survive `sort` (node writes the sorted copy back
    over them);
  - a class field read through an `any[]` gives `NaN`;
  - `const o = { a: g }; o.a.push('z')` leaves `g.length` at 1 (the field
    holds a copy);
  - `function grow(a: any[]) { a.length = 5 }` does not change the caller's
    array;
  - a `...r: string[]` rest parameter aliases the caller's array;
  - `g.length = 4294967295; g[5]` traps out of bounds;
  - after a `defineProperty` or dynamic `(g as any).length` shrink, the
    dropped value comes back;
  - those two dynamic paths, and the shrink fill, still write `$Hole` as on
    `origin/main`.

**Bytes** (unoptimized, base 2b0565cb14 vs head). Corpus: 1,707 programs per
lane — 13 playground examples, 4 benchmark suites and 1,690 sources extracted
from `tests/equivalence`.

| Lane | Playground | Benchmark suites | Equivalence sources | Total |
|---|---|---|---|---|
| gc | 0 changed | 3 changed, +117 B | 37 changed, +740 B | +857 B |
| standalone | 0 changed | 3 changed, +117 B | 37 changed, +740 B | +857 B |
| wasi | 0 changed | 3 changed, +168 B | 34 changed, +691 B | +859 B |

Where the bytes go:

- Each callback loop now reloads its backing on every iteration, adding about
  +20–28 B per loop. Almost all of the changes are this.
- A `length` store is byte-identical to `origin/main` in two cases: the value
  is the literal `0`, or the receiver compiles to a typed (non-externref) vec.
  Grow code is emitted only for the externref carrier. This covers the
  `array-push-pop` `number[]` length stores.
