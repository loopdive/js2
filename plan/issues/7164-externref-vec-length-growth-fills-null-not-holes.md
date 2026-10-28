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
# 2026-10-27 (#7164 r2): spread `[...g]` and for-of `g.entries()` must read a
# grown hole as `undefined` — one guarded `holeToUndefinedInstrs` at the
# existing element read in each (literals.ts +5, loops.ts +2). The read sites
# live in these functions; a helper elsewhere would not shrink them.
# 2026-10-28 (#7164 r3): the dynamic element read `__extern_get_idx` maps an
# externref vec's `$Hole` to its existing index miss (object-runtime.ts +6, in
# the carrier loop that owns the read); `[0, ...anyArr]` picks the externref
# carrier (literals.ts +2 more).
loc-budget-allow:
  - src/codegen/literals.ts
  - src/codegen/statements/loops.ts
  - src/codegen/object-runtime.ts
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

## Resolution (2026-10-27)

Test: `tests/equivalence/issue-7164-externref-vec-length-growth.test.ts`, run
on 3 lanes (gc native-first, standalone, wasi) against node. Result: 351/351.

- 6 programs × 12 reads.
- 10 share-group guards.
- r3: 35 readers after a grow (the audit below).

**Diagnosis (verified on `origin/main` 2b0565cb14).** Two causes:

1. **The length store never filled a grow.** The static `arr.length = n` store
   (`expressions/assignment.ts`) writes only the length field, and its hole fill
   (`vec-length-hole-fill.ts`) ran only on shrink. So a grow exposed the `null`s
   that `array.new_default` and every capacity grow leave in an externref vec:
   `g[1]` read `null`, `1 in g` was true, and `sort()` moved those slots first.
   Past the capacity, nothing was reallocated at all.
2. **The array could lose its hole representation.** When the binding does not
   escape, `inferArrayVecType` (`statements/array-vec-inference.ts`, #7154)
   re-types `const g: any[] = []` with only string pushes as a typed string vec.
   That vec has no way to store a hole.

**Fix.**

- **New `length-store` fill mode** for the static store.
  - f64 carriers keep the shrink-only fill unchanged.
  - An externref carrier also grows. When `cap < newLen <= 16M` (the guard the
    defineProperty and `__extern_set` length paths already use), the backing
    is reallocated to `newLen`. Then `[min(old, new), cap)` is filled with
    `$Hole`.
  - The append shape `arr[len] = v; arr.length = len + 1` is safe: the element
    write has already bumped the length, so the length store changes nothing
    (the test's `append` row checks this).
- **The share group decides the carrier, not one binding** (r2: B1).
  `growingLengthStoreCarrier` in `array-share-group.ts` reuses #7154's
  share-group walk.
  - It tracks whether any member has a growing store (`x.length = n`, with `n`
    not the literal `0`).
  - Besides the uses #7154 already accepts, it also accepts pure reads that
    cannot hand the vec to another layout: `k in xs`, `String(xs)`,
    `JSON.stringify(xs)`, `Object.keys(xs)`, `Object.getOwnPropertyNames(xs)`,
    `Array.isArray(xs)`, and spread (outside container groups).
  - If the group shares and admits the dynamic carrier, every member takes it.
  - An unshared binding takes the dynamic carrier alone, unless its inferred
    element is f64.
  - Any use that may reach a typed place (a `string[]` parameter, a typed
    field or alias) keeps every member on the layout it infers. That is
    `origin/main`'s behaviour; the group is never split.
- **Compound stores are not counted as growing.** `length += n` and `length++`
  compile exactly as on `origin/main`.
- **Spread and `entries()` read holes as `undefined`** (r2: B2 and NIT).
  `[...g]` (`literals.ts`) and `for (const [i, v] of g.entries())`
  (`statements/loops.ts`) now map `$Hole` to `undefined` on externref vecs in
  hole-armed modules.
- **r3: every element reader maps `$Hole` the same way.** A grown or shrunk
  `length` writes `$Hole`, so any reader that passed the raw slot on handed the
  callee the marker object.
  - The shared helper is the existing `holeToUndefinedInstrs` (array-holes),
    used at each read site.
  - Call/`new`/method/`super` spread goes through `compileSpreadCallArgs`
    (`expressions/extern.ts`).
  - A rest parameter now receives a hole-free copy
    (`holeFreeVecCopyInstrs`, `expressions/spread-elem-extern.ts`) instead of
    aliasing the caller's vec.
  - The shared spread arg-list builder (`spread-arg-list.ts`) covers
    `Array.of(...g)`, `Math.max(...g)` and `push(...g)`.
  - The array-iterator builder (`array-methods.ts`) covers
    `[...g.entries()]` on wasi.
  - The dynamic index read `__extern_get_idx` (`object-runtime.ts`, via
    `externHoleToMiss` in `vec-externref-hole-presence.ts`) covers HOFs on an
    `any` receiver, `(a as any)[i]` and the array → primitive join behind
    `${g}` on wasi.
  - `[0, ...anyArr]` now takes the externref carrier instead of f64
    (`literals.ts`), so `'y'` is no longer coerced to `NaN`.
- **r3: the pure-read whitelist resolves symbols, not spellings.** `String`,
  `JSON`, `Object` and `Array` count only when every declaration is ambient
  library code (`ctx.oracle.declarationsOf`). A user `function String(a:
  string[])` is an ordinary typed call, so the group keeps base's layout and
  base's behaviour (a trap, the same as on `origin/main`).

No host imports and no new raw checker calls. The frontmatter has growth
grants for `literals.ts`, `loops.ts` and `object-runtime.ts`, and a function
grant for `compileArrayLiteral`.

**Reader audit after `g.push('y'); g.length = 3`** (the `readers` rows of the
test):

| Reader | gc / standalone | wasi |
|---|---|---|
| `g[i]`, `typeof`, `==`, string concat of an element | ok | ok |
| `join`, `toString`, `String(g)`, `"" + g`, `${g}` | ok | ok (`${g}` fixed in r3) |
| `JSON.stringify`, `sort`, `forEach`, `filter`, `find*`, `findLast*`, `reduce*`, `some`/`every`, `at`, `pop`, `shift` | ok | ok |
| `[...g]`, `[0, ...g, 9]` | fixed (r2/r3) | fixed |
| `f(...g)`, `new C(...g)`, `o.m(...g)`, `Math.max(...g)`, `Array.of(...g)` | fixed (r3) | fixed, except `Array.of(...g)` traps (as on main) |
| rest parameter `f(...r)` | fixed (r3) | `i in r` wrong (#7171) |
| `super(...r)` | fixed (r3) | first argument lost (as on main) |
| destructuring with defaults, array-pattern rest | ok | ok |
| for-of, `values()` / `keys()` / `entries()` (spread and for-of) | ok | ok (entries fixed r3) |
| `concat`, `slice`, `splice` result, `reverse`, `copyWithin`, `unshift` | ok | `in` wrong (#7171) |
| `indexOf` / `includes` / `lastIndexOf` | ok | indexOf finds the hole (#7171) |
| `map` | `1 in m` true (#7170) | same |
| `Object.values` / `entries` / `assign` / `{...g}` | holes listed as `null` (as on main, #7170) | same |
| `Array.from(g)` | traps "illegal cast", dense too (as on main) | same |
| `h.apply(null, g)` | hole reads `null` (as on main) | same |
| `(g as any).join("-")` | prints `undefined`/`null` elements verbatim, dense too (as on main) | same |

No row passes the `$Hole` marker to user code on any lane.

**Now correct after `length` growth:**

| Lane | Reads |
|---|---|
| gc, standalone | index, `in`, for-in, `join`, `forEach` skip, `Object.keys`, `JSON.stringify`, spread, `entries()`, `sort` (holes last, no trap), every spread and iterator reader in the audit |
| wasi | index, `join`, `forEach`, `JSON.stringify`, spread, `entries()`, `sort`, template / `String`, call spread |

**Share-group guards** (all lanes): a typed `string[]` parameter called before
or after the grow, a typed `string[]` field, a `number[][]` alias, the
`let cur = a; …; cur = b` pattern, `boolean[]` / class-typed aliases, and a
shadowing `String` (r3). Each matches `origin/main`.

**Left out.** The test marks each of these rows `it.fails` with the issue that
owns it, so a fix flips the row.

Owned by other issues:

- `hasOwnProperty` (gc/standalone), `map` and `Object.values` do not recognise
  `$Hole` on an externref vec: #7170.
- On wasi, `in`, for-in, `indexOf`, and `in` on `slice` / `concat` /
  `splice` / rest results, report holes as present: #7171.
- `delete g[i]` keeps the value in the slot, so `join` / `forEach` / `map` /
  spread / `entries` / `sort` see it: #7169 / #7170. wasi delete reads: #7171.
- `new Array(3)` reads on gc native-first (`in`, `hasOwnProperty`, for-in,
  `forEach`, `map`, `Object.keys`): #7170.
- Not fixed here as a side effect: #7170's `d[4] = "a"; 2 in d` gap-fill row,
  #7169 and #7180.

Not tracked by an issue yet (behaviour is the same on `origin/main` unless
noted):

- These fail even on dense arrays:
  - `Array.from(anyVec)` traps.
  - `t.push(...g)` pushes one element.
  - `apply` reads a hole as `null`.
  - A join through an `any` receiver prints `undefined`/`null` elements.
  - On wasi, `super(...r)` drops the first argument and `Array.of(...g)` traps.
- wasi `Object.keys` / `hasOwnProperty` on an `any[]` are wrong even when the
  array is dense.
- A group that stays on a typed vec still shows a grow as `null`s / `false`s.
  - This covers declared `string[]` / `boolean[]` arrays, `any[]` arrays
    aliased to a typed place, and the shadowed-`String` group.
  - Growing a typed string vec past its capacity traps "array element access
    out of bounds".
  - A declared `number[]` grow still answers `1 in a` true.
- Compound length stores on a typed vec (`length += n`) still fail to compile.
- Reading `p.v` through an `any[]` holding class instances gives `NaN`, even
  without a `length` store. The review's `elem_ref_pushes` row gives a
  different wrong answer than on `origin/main`.
- `Object.getOwnPropertyNames(g)` lists hole indices (`objkeys_isarray`;
  different wrong answer than on `origin/main`): #7170 family.

**Bytes.** Unoptimized; base `origin/main` 2b0565cb14 vs head.

Corpus (1,886 programs per lane):

- 13 playground examples
- 1,690 sources extracted from `tests/equivalence/*.test.ts`
- 183 review and audit probes

| Lane | Programs changed | Total delta | Playground | Equivalence sources | Probes |
|---|---|---|---|---|---|
| gc | 222 | +11,063 B | 1 (+20 B) | 48 (+1,152 B) | 173 (+9,891 B) |
| standalone | 221 | +19,702 B | 0 | 48 (+1,151 B) | 173 (+18,551 B) |
| wasi | 213 | +4,819 B | 1 (+22 B) | 40 (+1,064 B) | 172 (+3,733 B) |

- The playground change is `js/algorithms.ts`.
- The equivalence-source changes: the three `array-push-pop` length-store
  programs (+84 B each), and about +20 B in hole-armed modules (mostly the
  `defineProperty` tests). That +20 B is the `$Hole` arm in `__extern_get_idx`.

The #6937 share-group probe sets (`cases13`, `sweepdef`, `cases11`: 220
programs × 3 lanes) give byte-identical output and identical results on head
and base.
