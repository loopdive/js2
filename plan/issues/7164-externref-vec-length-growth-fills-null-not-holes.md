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
loc-budget-allow:
  - src/codegen/literals.ts
func-budget-allow:
  - src/codegen/literals.ts::compileArrayLiteral
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

Test: `tests/equivalence/issue-7164-externref-vec-length-growth.test.ts`, run
on gc native-first, standalone and wasi against node; 573/573. It covers:

- 6 programs × 12 reads;
- 10 share-group guards;
- 35 readers after a grow;
- a generated leak sweep: 37 array-producing methods and call forms × 3
  lanes. Each case has a "no marker leaks" row with no `it.fails` escape and a
  "matches node" row.

**Shipped design (r4): grown slots hold the canonical `undefined`, not
`$Hole`.**

- Rounds 1–3 filled them with the `$Hole` marker and patched readers one by
  one. Each review then found more readers that passed the marker to user
  code:
  - call spread (r2);
  - rest parameters of every non-declaration callee, `toReversed`, `with`
    and `toSpliced` (r3);
  - a wasi `null` regression from the r3 `__extern_get_idx` patch.
- Per the stop rule, r4 switched designs: `undefined` cannot leak by
  construction. The r2/r3 reader patches are reverted, so those paths are
  byte-identical to `origin/main` again:
  - spread literal, `entries()` for-of, call/rest spread, spread arg list,
    array iterator, `__extern_get_idx`.
- The cost: a grown index is a present `undefined`, not a hole. `in`,
  `hasOwnProperty`, for-in, `Object.keys` and callback-visiting methods see
  it — the same answers as `origin/main`, whose slot held `null`. Real holes
  stay with #7170, and wasi `in` with #7171.

**Diagnosis (verified on `origin/main` 2b0565cb14):**

1. **The length store never filled a grow.** The static `arr.length = n`
   store writes only the length field, and the hole fill ran only on shrink.
   A grow exposed the backing's default `null`s, and nothing was reallocated
   past the capacity.
2. **A non-escaping `any[]` lost its carrier.** `inferArrayVecType` (#7154)
   re-types a non-escaping, string-only `const g: any[] = []` as a typed string
   vec. Its slots read `null`, and `sort()` traps on them.

**Fix:**

- **`vec-length-hole-fill.ts`: new `length-store` mode for the static store.**
  - Every carrier keeps the shrink fill (`$Hole`, as on `origin/main`).
  - An externref carrier also grows. When `cap < newLen <= 16M`, the backing
    is reallocated to `newLen`. Then `[oldLen, cap)` is filled with
    `canonicalUndefinedExternInstrs`.
  - The append shape `arr[len] = v; arr.length = len + 1` stores an unchanged
    length, so it fills nothing.
- **`array-share-group.ts` / `array-vec-inference.ts`: the carrier is chosen
  for the whole share group, never one alias alone (r2).**
  - `growingLengthStoreCarrier` records growing `x.length = n` stores (n not
    the literal `0`) and accepts pure reads:
    - `in`;
    - spread outside container groups;
    - the lib globals `String`, `JSON.stringify`, `Object.keys`,
      `Object.getOwnPropertyNames` and `Array.isArray`. Since r3 these resolve
      to ambient library declarations, so a shadowing `String` does not count.
  - A sharing group switches to the dynamic carrier only as a whole. An
    unshared binding switches alone, unless its vec is f64. Anything else keeps
    `origin/main`'s layout.
  - Compound length stores are not counted.
- **`literals.ts`: `[0, ...anyArr]` takes the externref carrier** instead of
  f64, so `'y'` is no longer coerced to `NaN`.

No host imports and no new raw checker calls.

**Generated sweep result.** 0 marker leaks on all lanes. Against
`origin/main`, 0 regressions across all 37 cases. "Matches node" compares the
full per-index presence and value summary:

| Lane | Matches node |
|---|---|
| gc, standalone | `toReversed`, `toSpliced`, `with`, `Array.of`, `entries`, `values`, `[...g]`, `[0, ...g]`, for-of, index read, rest via declaration / arrow / function expression / method / static / closure / `new` / leading argument, positional spread into a declaration / method / `new` |
| wasi | none: wasi `in` is false even for present indices (#7171) |

The remaining "matches node" rows are `it.fails`, and none was right on
`origin/main`:

- grown index present (#7170): `self`, `map`, `filter`, `slice`, `concat`,
  `flat`, `flatMap`, `splice`, forEach and reduce collection;
- traps or compile errors (untracked): `toSorted`, `Array.from`, the
  object-literal method rest, the `super` rest;
- dynamic reads through `any` and `apply` read `null` (untracked).

**Rows that changed against `origin/main` without a leak.** Measured over the
107 main and reader rows on 3 lanes, head vs base. One row was right on base
and is wrong on head:

- `g.some(v => v === undefined)` / `every(v => v !== undefined)` on gc and
  standalone. Base answered correctly only because its slot held `null`.
- The read itself is fixed: `g[1] === undefined` is now true.
- The row is `it.fails` under #7170, since skipping a hole needs real holes.

**Now correct after `length` growth:**

| Lane | Reads |
|---|---|
| gc, standalone | `String(g[i])` / `g[i] === undefined` (was `"null"`), `sort` (no trap, `undefined` last), `join`, `JSON.stringify`, template / `String(g)`, spread / call spread / rest via every call form, `toReversed` / `with` / `toSpliced`, iterators, destructuring defaults |
| wasi | element read, `join`, `JSON.stringify`, `sort`, template |

**Left out.** The test carries each of these as an `it.fails` row with its
owner.

- **#7170 (holes):** a grown index is a present `undefined`. Affected:
  - `in`, `hasOwnProperty`, for-in, `Object.keys`, `Object.values`;
  - forEach / map / filter / reduce / some / every visit it;
  - `indexOf` finds it;
  - copies (`slice`, `concat`, `splice`, `flat`) keep it own.

  The `delete` and `new Array(n)` rows are also #7170 (`delete` additionally
  #7169).
- **#7171 (wasi `in`):** every wasi presence row.
- **Untracked, same as `origin/main`:**
  - `toSorted` and `Array.from(anyVec)` trap;
  - an object-literal method with a rest parameter emits invalid wasm;
  - `super(...r)` forwards nothing;
  - `apply` and dynamic reads through `any` read `null`;
  - `push(...g)` pushes one element;
  - wasi `Array.of(...g)` needs a host import;
  - wasi `Object.keys` / `hasOwnProperty` on a dense `any[]` are wrong;
  - typed-vec groups (declared `string[]` / `boolean[]`, typed aliases) keep
    the `null` fill and their out-of-bounds trap past capacity;
  - compound length stores on typed vecs fail to compile;
  - a class field read through an `any[]` gives `NaN`.
- **Pre-existing marker leaks from other `$Hole` writers.** The shrink fill,
  `defineProperty(length)` and the dynamic `(g as any).length = n` path still
  write `$Hole`, exactly as on `origin/main`. So shrink-then-grow without a
  static grow, spread after a shrink, and so on behave as there.

**Bytes.** Unoptimized builds, base `origin/main` 2b0565cb14 vs head, 1,979
programs per lane:

- 13 playground examples
- 1,690 sources extracted from `tests/equivalence`
- 276 review and sweep probes

| Lane | Changed | Total delta | Playground | Equivalence sources | Probes |
|---|---|---|---|---|---|
| gc | 254 | +80,113 B | 0 | 3 (+414 B) | 251 (+79,699 B) |
| standalone | 254 | +75,562 B | 0 | 3 (+423 B) | 251 (+75,139 B) |
| wasi | 253 | +59,934 B | 0 | 3 (+429 B) | 250 (+59,505 B) |

- The three changed equivalence sources are the `array-push-pop` length-store
  programs.
- Every probe has a growing `length` store. Most of their delta comes from the
  `any[]` carrier switch (typed string vec → externref vec), not from the
  fill.
- The r3 `__extern_get_idx` arm is gone, so the +20 B in modules that use holes
  without growing an array is gone too.

The #6937 share-group probe sets (`cases13`, `sweepdef`, `cases11`: 220
programs × 3 lanes) produce byte-identical output with identical results on
head and base.
