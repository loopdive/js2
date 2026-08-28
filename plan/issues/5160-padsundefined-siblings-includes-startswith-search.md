---
id: 5160
title: "includes()/startsWith()/search() with no argument are wrong in the gc lane — the same padsUndefined omission #5155 fixed for indexOf"
status: done
sprint: current
created: 2026-08-28
updated: 2026-08-28
completed: 2026-08-28
priority: low
horizon: s
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: string-methods
goal: core-semantics
related: [5155, 3763]
# loc-budget-allow / func-budget-allow justification (2026-08-28): the
# executable change is THREE list entries — `includes`, `search` and
# `startsWith` added to the `padsUndefined` set inside
# `compileReceiverMethodCall` — which the gate scores as +13 lines only because
# 10 of the 13 are comment. Non-comment source delta is +3 lines, one per
# method. The comments are the load-bearing part: they record (a) that `search`
# is NOT a ToString case (§22.1.3.19 goes through `RegExp(undefined)`, the empty
# regexp) so the next reader does not "correct" it toward the includes/
# startsWith story, (b) the two base measurements that established the one-entry
# fix is sufficient for `search` anyway, and (c) that the f64 position slot of
# includes/startsWith is deliberately untouched and keeps its #2002 NaN
# sentinel, so the entry is not later widened into that arm.
#
# This restates the same grant #5155 carried for this file rather than relying
# on it: #5155's issue file is not modified by this PR, so its allowance would
# be a stranded grant that CI's merge-preview base cannot see.
#
# The fix cannot move to a subsystem module: the set it edits is a local inside
# the pad loop of the host-import call path, and extracting it would be a far
# larger change to a god-function than three one-cell bugs warrant.
loc-budget-allow:
  - src/codegen/expressions/call-receiver-method.ts
func-budget-allow:
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
---

# Three more one-entry fixes in the `padsUndefined` set

Found during #5155 (PR #5168), which surveyed the zero-argument form of the
whole `String.prototype` family (15 methods, both lanes). Three more methods
carry the identical defect — the omitted externref argument slot reaches the
host as `ref.null.extern` (JS `null`) instead of `undefined`, so the host
coerces the wrong search value. All gc-lane-only; standalone is correct:

| shape | gc (measured) | standalone | spec |
| --- | --- | --- | --- |
| `"aundefinedb".includes()` | **false** | `true` | `true` |
| `"undefinedb".startsWith()` | **false** | `true` | `true` |
| `"aundefinedb".search()` | **-1** | `0` | `0` |

Each fix is one more entry in the `padsUndefined` set inside
`compileReceiverMethodCall` (`src/codegen/expressions/call-receiver-method.ts`)
— the exact change PR #5168 made for `indexOf`, whose record documents the
mechanism and the evidence pattern to reuse.

**The current wrong values are PINNED as tests** in
`tests/issue-5155-string-indexof-no-argument.test.ts` (with the spec answers in
comments) so the behavior cannot drift silently — the fix MUST update those
pins to the spec values.

Note for `search()`: §22.1.3.19 routes through `RegExp(undefined)` = an empty
regexp matching at 0, not `ToString`; verify the host arm actually receives
`undefined` and produces `0` before assuming the same one-entry shape suffices.

## Acceptance criteria

- The three shapes answer the spec values in the gc lane; standalone unchanged.
- The #5168 pins updated; byte-identity for every other `String.prototype`
  shape in both lanes (reuse the #5168 43-shape sweep).
- A/B per the established method; pinned tests red on base; equivalence shards
  clean by name.

## Resolution (2026-08-28) — three list entries, and `search` verified first

All figures below are **measured** in this worktree unless labelled *reasoned*.
The A/B artifacts are `.tmp/sweep-base.json` and `.tmp/sweep-fixed.json`,
generated 2026-08-28 by `.tmp/sweep.ts` from a base copy of the source
(`.tmp/base-call-receiver-method.ts`, captured with `git show HEAD:…` at the
first edit) against branch base `origin/main` @ `02b050f8f0`.

### The `search()` question, answered by measurement before the fix was written

The issue flagged `search` as the one that might not fit the one-entry shape,
because §22.1.3.19 does **not** run `ToString` — it builds `RegExp(searchValue)`,
and `RegExp(undefined)` is the *empty* regexp `/(?:)/`, which matches at 0 for
any receiver. Two rows of the base sweep settle it without guessing:

| base measurement | result | what it establishes |
| --- | --- | --- |
| gc `search()` sha256 = `af9af665d18f` | **identical** to gc `search(null)` `af9af665d18f` | the absent slot really was reaching the host as JS `null`, i.e. `RegExp(null)` = `/null/` |
| gc `search(undefined)` | **`0`** (already correct on base) | the host arm handles `undefined` correctly and yields the empty-regexp answer |

So passing `undefined` is sufficient for `search` too, and no larger fix was
needed. Confirmed after the fix: gc `search()` is now `417a35200518`, which is
byte-identical to `search(undefined)`, and no longer equal to `search(null)`
(still `af9af665d18f`, still `-1`).

Two consequences of `search` being a regexp case rather than a ToString case,
both measured and both pinned as tests: `"abc".search()` and `"".search()`
answer **0**, not `-1` — unlike `includes`/`startsWith`, whose zero-argument
form on a receiver without `"undefined"` stays `false`.

### The change

Three entries added to the `padsUndefined` set inside
`compileReceiverMethodCall` (`src/codegen/expressions/call-receiver-method.ts`)
— `includes`, `search`, `startsWith`, joining `endsWith`, `indexOf`,
`lastIndexOf`, `padStart`, `padEnd`. That set names the methods whose omitted
**externref** slots must be padded with JS `undefined` (via the
`__get_undefined` import) instead of `ref.null.extern`. Non-comment source
delta: **+3 lines**, one per method; +13 total with the comment.

The f64 position slot of `includes`/`startsWith` is untouched — it is padded on
a different arm with the #2002 NaN sentinel, and `padsUndefined` only rewrites
externref slots. Measured, not reasoned: every one-argument shape
(`includes("b")`, `includes(dyn)`, `startsWith("u")`, `startsWith("n",1)`, …)
is byte-identical across the A/B.

### Measured before/after — the three target shapes

Values are gc → gc and standalone → standalone; hashes are sha256 of the
emitted module, first 12 hex, gc lane.

| shape | before (gc / sa) | after (gc / sa) | spec |
| --- | --- | --- | --- |
| `"aundefinedb".includes()` | **`false`** `d042df53c6d7` / `true` | **`true`** `cd5ed9225c9a` / `true` | `true` |
| `"undefinedb".startsWith()` | **`false`** `f020a3cd1962` / `true` | **`true`** `9ad61d5833f1` / `true` | `true` |
| `"aundefinedb".search()` | **`-1`** `af9af665d18f` / `0` | **`0`** `417a35200518` / `0` | `0` |

And the receiver variants, all gc lane, all previously wrong:

| shape | before | after |
| --- | --- | --- |
| `"aundefinedb".includes()` literal recv | `false` | `true` |
| `a[0]!.includes()` dynamic recv | `false` | `true` |
| `"undefinedb".startsWith()` literal recv | `false` | `true` |
| `a[0]!.startsWith()` dynamic recv | `false` | `true` |
| `"aundefinedb".search()` literal recv | `-1` | `0` |
| `a[0]!.search()` dynamic recv | `-1` | `0` |
| `"".search()` empty recv | `-1` | `0` |

### Byte-identity — each zero-arg form IS its `undefined` spelling

The preferred acceptance outcome, achieved for all three rather than explained
away. After the fix each zero-argument form compiles to **one binary** with its
explicit-`undefined` spelling, where on base all three differed:

| pair | base | after |
| --- | --- | --- |
| `includes()` vs `includes(undefined)` | `d042df53c6d7` ≠ `cd5ed9225c9a` | both `cd5ed9225c9a` |
| `startsWith()` vs `startsWith(undefined)` | `f020a3cd1962` ≠ `9ad61d5833f1` | both `9ad61d5833f1` |
| `search()` vs `search(undefined)` | `af9af665d18f` ≠ `417a35200518` | both `417a35200518` |

Pinned as a test so the spellings cannot drift apart. This mirrors what #5155
achieved for `indexOf`.

### Sweep: 66 shapes × 2 lanes = 132 cells, 120 byte-identical

The sweep extends the #5155 43-shape one to 66 shapes so the three target
methods get the same receiver/argument coverage `indexOf` had. **The 12 cells
that moved are all gc-lane and all the zero-argument form of the three fixed
methods** — four receiver variants each:

| moved cell (gc lane) | before | after |
| --- | --- | --- |
| `includes()` | `false` `d042df53c6d7` | `true` `cd5ed9225c9a` |
| `includes()` no match | `false` `377a74a4980f` | `false` `e097b50d413e` |
| `includes()` literal recv | `false` `0e85dbb6a2c5` | `true` `64147e83f82c` |
| `includes()` dynamic recv | `false` `3853c5360ff3` | `true` `ae7906eb64b2` |
| `startsWith()` | `false` `f020a3cd1962` | `true` `9ad61d5833f1` |
| `startsWith()` no match | `false` `ddf4565b939b` | `false` `cd7da134b66b` |
| `startsWith()` literal recv | `false` `79dda4949669` | `true` `aff84cba58e8` |
| `startsWith()` dynamic recv | `false` `9f7a74e5ce4d` | `true` `7207c45fa2c5` |
| `search()` | `-1` `af9af665d18f` | `0` `417a35200518` |
| `search()` empty recv | `-1` `41cdd03e9935` | `0` `8b931949a47d` |
| `search()` literal recv | `-1` `0c2afdb10194` | `0` `d05759ca6028` |
| `search()` dynamic recv | `-1` `4894bff12da6` | `0` `f7cf81c96e87` |

Two of those twelve move bytes with **no value change** (`includes()` /
`startsWith()` on `"abc"`): the search value changed from `"null"` to
`"undefined"`, and both miss. That is the expected shape of the fix, and both
rows are pinned so a future "simplification" that returns a fixed answer fails.

**The standalone lane is 66/66 unchanged** — every cell byte-identical, which is
the evidence this was host argument padding and not a semantics gap.

Everything else is byte-identical in **both** lanes: `indexOf` in all 14 of its
sweep shapes, `lastIndexOf()`/`lastIndexOf(undefined)`/`lastIndexOf("b")`/
`lastIndexOf("n",5)`, every explicit-argument `includes`/`startsWith`/`search`
spelling (including the `null` ones and `search(/b/)`/`search(/zz/)`),
`endsWith()`/`endsWith("b")`, `padStart()`/`padStart(5)`/`padEnd(5)`,
`substring()`/`substring(1)`, `slice()`/`slice(1)`, `split()`, `charAt()`,
`concat()`, `repeat()`, `at()`, `replace()`, `codePointAt()`, and the whole
Array-side family (`arr.indexOf()`, `arr.indexOf(20)`, `arr.lastIndexOf()`,
`arr.includes()`, `arr.at()`, `["x",undefined,"z"].indexOf()`).

### Tests

- `tests/issue-5155-string-indexof-no-argument.test.ts` — the #5155 pin block
  that recorded the three wrong values (`0` / `0` / `-1`) now carries the spec
  answers (`1` / `1` / `0`). That pin existed precisely so this follow-up could
  not diverge silently, and it did its job: the block fails on base.
- `tests/issue-5160-padsundefined-siblings.test.ts` — 13 tests: both lanes per
  method, the `search`-is-a-regexp evidence (`"abc"`/`""` → 0), the no-match
  guards, literal and dynamic receivers, the "was searching for null" rows, the
  three byte-identity pins, explicit-argument regression guards, the #2002 NaN
  position-slot guard, and the `indexOf`/`endsWith`/`padStart`/`padEnd`/
  Array-family/other-String-shape guards.
- `tests/equivalence/string-search-family-no-arg.test.ts` — 13 rows against real
  JS execution, modelled on `string-indexof-no-arg.test.ts` (#5155).

**Non-vacuity, measured:** with only the source file reverted to base
(`cp .tmp/base-call-receiver-method.ts src/…`), **15 of the 48 assertions across
these three files FAIL**, including the updated #5155 pin block. The 33 that
pass are exactly the intended regression guards (standalone lane, no-match,
null spellings, explicit arguments, position slot, `indexOf`/`lastIndexOf`,
`endsWith`/`padStart`/`padEnd`, Array family, other String shapes). Restored
from `.tmp/fixed-call-receiver-method.ts` afterwards; all 48 pass.

One equivalence row had to be re-spelled: `startsWith(undefined)` does not
typecheck under the equivalence harness (it does not set
`skipSemanticDiagnostics`), so that row asserts against the explicit
`"undefined"` string instead, and the byte-identity pin against
`startsWith(undefined)` lives in the unit file.

### test262 sizing — reasoned, not measured

Not measured here (no local test262 run). By the same reasoning #5155 recorded
for `indexOf`: the zero-argument spelling is vanishingly rare in the
`String/prototype` tree, so the expected conformance delta is **0 tests**. The
value is correctness of a shape test262 happens not to probe, and closing the
`padsUndefined` list — with these three, every String method whose omitted
externref slot is spec-visible is now on it.
