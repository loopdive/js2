---
id: 4071
title: "Own-property ENUMERATION is dead in standalone for array indices and function own properties — Object.keys returns [] while writes round-trip"
status: done
sprint: 78
assignee: ttraenkler/L-enum
created: 2026-08-02
updated: 2026-08-18
completed: 2026-08-02
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: standalone
language_feature: object-enumeration
goal: standalone-mode
related: [4055, 4061, 4062]
# The fix EXTENDS two existing fills in this file in place
# (`fillClosedStructOwnPropertyNamesArms`, `fillDynamicForinVecArms`) so that
# `__object_keys` shares them. Moving them to a subsystem module would separate
# them from the sibling arms they are defined against; adding a fifth
# hand-maintained copy elsewhere is the very pattern that caused this defect.
loc-budget-allow:
  - src/codegen/object-runtime.ts
---

# Own-property enumeration is dead in standalone for array indices and function own properties

> Filed 2026-08-02 from a measured finding reported by the `H-descriptor` agent
> while it was working the descriptor-shape family. It is **not** part of that
> family and was explicitly handed over rather than folded in.

## Defect

In **standalone** mode, own-property **enumeration** is dead for two carrier
kinds, while the underlying writes round-trip correctly:

```js
Object.keys([10, 20, 30]).length; // 0   — expected 3
Object.keys(fnWithOwnProp).length; // 0   — expected 1
```

Array **index keys are not enumerated at all**. Reads and writes work in both
cases — only enumeration is missing. So this is a **silent wrong answer**, not a
refusal: nothing downstream can detect it, and no host-import leak names it.

## Why it is filed separately, and why it may be the bigger lever

The reporting agent surfaced this while decomposing a **50-file** goal-scope
bucket (the `Object.defineProperties`/`create` receiver-representation ceiling,
tracked separately). Its assessment, which this issue adopts:

> "That is almost certainly a bigger lever than my 50."

`Object.keys` is not a leaf builtin — it shares the own-property enumeration
substrate with **`for-in`, `Object.getOwnPropertyNames`, object spread, and
`JSON.stringify`**. If enumeration is dead for vec carriers and closure
carriers, every one of those surfaces is wrong on the same inputs.

## ⚠ Blast radius — read before starting

The reporting agent **deliberately did not touch** `__object_keys` /
`__hasOwnProperty`, and gave the reason: the blast radius is for-in /
`Object.keys` / spread / `JSON.stringify`, and **the at-risk set is not
enumerable cheaply**. Treat that as a live warning, not a formality:

- Do **not** size this from the two repro lines. Enumerate the affected
  population against the standalone baseline JSONL first, and state the
  denominator.
- A fix here can regress passing tests in four surfaces at once. Establish the
  before-state per surface, then re-measure per surface.

## Relationship to the descriptor family

Adjacent but **distinct** from the receiver-representation refusals in
`Object.defineProperties`/`Object.create` (the two-disjoint-side-tables
substrate — `src/codegen/vec-props.ts` #3537 expando bag,
`src/codegen/vec-overlay.ts` #3251 descriptor overlay, each scoping the other
out in its own header comment). Those are **refusals**; this is **silent wrong
enumeration**. They plausibly share the substrate — confirm that before
assuming either subsumes the other.

## Acceptance criteria

1. `Object.keys([10,20,30])` returns `["0","1","2"]` in standalone.
2. `Object.keys(fn)` includes the function's own properties.
3. The same population is checked through `for-in`, `getOwnPropertyNames`,
   spread and `JSON.stringify` — with per-surface before/after counts.
4. Net flips reported against a force-refreshed standalone baseline, with the
   denominator stated. **Report flips, not file counts.**

---

## Test Results (2026-08-02, `ttraenkler/L-enum`)

Instrument: 10-carrier × 5-surface probe matrix, scored **in-Wasm** against a
**plain-JS oracle** (`new Function`), with the compiler's **`gc` lane as a
control**. Baselines force-refreshed (`--force`): host 48,340 rows, standalone
48,619 rows.

### Root cause

`__object_keys` (`src/codegen/object-runtime-enumeration.ts:91`) treats a
non-`$Object` receiver as "no properties". In standalone an array is a
`__vec_<k>` struct subtyping `$__vec_base` (#2186) and a class instance is a
closed nominal struct — neither is a `$Object`, so both enumerated ZERO.

**Both halves of the treatment already existed for SIBLING helpers**; this one
consumer was never wired to either:
- #3183's `fillDynamicForinVecArms` → `$__vec_base` arms for
  `__object_keys_forin` / `__extern_has` / `__extern_get`.
- `fillClosedStructOwnPropertyNamesArms` → closed-struct arms for
  `__getOwnPropertyNames`.

### Probe matrix (INSTRUMENT — NOT a population, NOT a flip forecast)

50 constructed (carrier, surface) cells. `gc`-wrong is constant at 7/50 across
all arms — no host-lane movement.

| arm | standalone-wrong cells |
| --- | --- |
| base (kill switch OFF) | 30 / 50 |
| vec arm only (**shipped**) | 28 / 50 |

### Funnel (test262, standalone lane)

| stage | `Object.keys` | `getOwnPropertyNames` | `JSON.stringify` |
| --- | --- | --- | --- |
| 1 population (corpus mentions) | 255 | 203 | 155 |
| 2a present in standalone baseline | 234 (unopenable 21) | 138 (unopenable 65) | 84 (unopenable 71) |
| 2b not passing today | 140 | 92 | 62 |
| 3 swept before+after | **234** | — | — |
| 4 flips | **+3 / −2 = net +1** | — | — |

**Instrument validation before reading any delta:** local sweep vs published CI
baseline over the same 234 rows — 217/234 exact-status agreement (92.7%); the 17
disagreements are 15 `compile_error→fail`, 1 `fail→skip`, 1 `compile_error→pass`,
i.e. the known `runTest262File`-is-not-the-CI-path artifact. At **pass /
not-pass** granularity — the only granularity the flip count uses — agreement is
**233/234 = 99.6%**.

**Attribution** proved by kill-switch REMOVAL (file-copy revert of
`object-runtime.ts` to the merge-base version, never `git stash`), re-measured
end-to-end, not by reasoning.

### Per-surface before/after (probe matrix, standalone)

| surface | before | after | note |
| --- | --- | --- | --- |
| `Object.keys` | array 0, class 0 | **array 3 ✓**, class 0 | fixed for arrays |
| `for-in` | array 3 ✓ | array 3 ✓ | unchanged (had the arm since #3183) |
| `getOwnPropertyNames` | array 0 ✗ | array 0 ✗ | untouched — no vec arm |
| spread | array 0 ✗ | array 0 ✗ | **does not route through `__object_keys`** |
| `JSON.stringify` | array `"null"` ✗ | array `"null"` ✗ | **does not route through `__object_keys`** → #4085 |

### What this REFUTES

- **The shared-substrate premise in this issue is wrong.** Spread and
  `JSON.stringify` did **not** move when `__object_keys` was fixed. They are
  independent helpers, not consumers of one enumeration substrate. Only
  `Object.keys` and `for-in` are siblings, and `for-in` was already fixed.
- **Acceptance criterion 2 (`Object.keys(fn)`) is NOT a standalone-only defect.**
  The `gc` lane gets it wrong too (`gc=0`, spec `1`). It is a compiler-wide
  gap, so it is out of scope for a standalone carrier fix.
- **The sparse-array component of the residual is not lane-specific.** `gc` and
  standalone BOTH report 6 for `for-in`, `hasOwnProperty` and `Object.keys` on
  `[1,2,,4,,6]` (spec: 4). There is no hole representation in either lane.

### What was deliberately NOT shipped

- **The closed-struct half — measured at +5 additional net flips (+8/−3 vs
  +3/−2), then REVERTED.** It made `Object.keys(new Date(0))` answer
  `["timestamp"]` and `Object.keys(/ab/)` answer 7 internal RegExp fields, both
  correctly `[]` before. A number bought with a new silent wrong answer on two
  very common spellings is negative value. Both are now explicit regression
  guards in `tests/issue-4071.test.ts`. Root cause + fix direction filed as
  **#4086** (needs a user-declared-vs-builtin struct predicate, which does not
  exist today).
- **`JSON.stringify` → `"null"` for every non-empty array / class instance /
  object-holding-an-array.** Distinct helper (`json-codec-native.ts` dispatches
  on `$Object`/`$ObjVec` and never `$__vec_base`; `$ObjVec` is the
  enumeration-RESULT vector, not a user array). Filed as **#4085**.
- **Vec expando properties.** `Object.keys([10,20].concat with .z=9)` yields the
  index keys only, matching what `for-in` already does. The expando bag (#3537)
  and the index keys remain disjoint side tables — #4010 territory.

### The 2 apparent regressions are DE-VACUIFICATIONS, not regressions

Both re-run **SOLO** (per the ~79% inflation lesson): both reproduce, so they
are real status changes, not flake. But both were **vacuous passes**:

`15.2.3.14-6-1` / `-6-2` do `for (var index in returnedArray) assert.sameValue(...)`
where `returnedArray = Object.keys(denseArray)`. Before the fix `Object.keys`
returned `[]` (measured 0 → 3), so the loop ran **zero iterations and executed
zero assertions** — the tests passed while verifying nothing. They now execute
and fail against a *separate* pre-existing defect (`tempArray[index]` reads
`undefined` under the real harness; the same shape scored in-Wasm both at module
top level and inside a function gives 3 comparisons / 0 mismatches, so it is not
reproducible outside the harness and was not chased here).

Net honest effect on this population: +3 real passes, −2 passes that were never
verifying anything.

---

## The user-declared-vs-builtin predicate this issue was blocked on DOES exist (2026-08-03, #4098 G1)

`fillClosedStructOwnPropertyNamesArms`'s header records that re-sharing its arms
with `__object_keys` was measured at **−5** and reverted (`Object.keys(new Date(0))`
answered `["timestamp"]`, `Object.keys(/ab/)` answered 7 internal RegExp fields),
and that a proper fix "needs a principled user-declared-vs-builtin struct
predicate, which does not exist yet".

**It exists: `ctx.classDeclarationMap`** (`codegen/context/types.ts`). It is
written *only* by `collectClassDeclaration` (`class-bodies.ts:609`), keyed by
class name — the same key space as `ctx.structFields` — so
`ctx.classDeclarationMap.has(structName)` is true exactly for structs originating
in a user-source `class` declaration or class expression. Builtin carriers (Date,
RegExp, Error) are never registered there.

That is a **structural** screen, not a name-shape heuristic — which is precisely
the property #4086 records `startsWith("__")` as lacking. It removes the stated
blocker for the deferred `Object.keys` re-share.

Pointer only — no arm built here. Found while scoping #4098 (whose stage 4 needs
the same screen); see that issue's G1 handoff for the measured context.
