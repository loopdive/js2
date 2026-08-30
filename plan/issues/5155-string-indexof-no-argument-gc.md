---
id: 5155
title: "String.prototype.indexOf() with no argument answers -1 in the gc lane where the spec requires searching the string \"undefined\""
status: done
sprint: current
created: 2026-08-28
updated: 2026-08-28
completed: 2026-08-28
priority: low
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: string-methods
goal: core-semantics
related: [3763, 5095, 5121]
# loc-budget-allow / func-budget-allow justification (2026-08-28): the
# executable change is ONE list entry — `method === "indexOf"` added to the
# `padsUndefined` set inside `compileReceiverMethodCall` — which the gate scores
# as +19 ins/−1 del (net +18) only because the existing 4-condition `||` had to
# be reflowed onto
# one condition per line and because 14 of the 19 lines are comment. Those
# comments are the load-bearing part: they record (a) why `lastIndexOf` was
# already correct and `indexOf` was not, so the next reader does not "simplify"
# the entry back out, (b) that this is the ABSENT-argument spelling and #3763
# fixed the explicit undefined-VALUED one, and (c) that `includes`/`startsWith`/
# `search` have the identical defect from this same list and are deliberately
# left for a follow-up. Net non-comment source delta is +4 lines. The fix cannot
# move to a subsystem module: the set it edits is a local inside the pad loop of
# the host-import call path, and extracting it would be a larger change to a
# god-function than the one-cell bug warrants.
loc-budget-allow:
  - src/codegen/expressions/call-receiver-method.ts
func-budget-allow:
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
---

# One wrong cell: gc-lane `String.prototype.indexOf()` zero-arg

Found during #5121-S1 (PR #5153), measured 2026-08-28 on the #5121 branch's
base (`origin/main` @ `30a3335b80`) — the four `String.prototype` shapes were
byte-identical across that fix, so this is pre-existing and untouched by it:

| expression | gc | standalone | spec |
| --- | --- | --- | --- |
| `"aundefinedb".indexOf()` | **-1** ⚠ | `1` | `1` |
| `"aundefinedb".indexOf(undefined)` | `1` | `1` | `1` |
| `"aundefinedb".lastIndexOf()` | `1` | `1` | `1` |

Per §22.1.3.9, `indexOf(searchString)` runs `ToString(searchString)` — absent
argument becomes the string `"undefined"`, which occurs at position 1 in the
probe. Exactly one cell is wrong: the gc lane's zero-argument `indexOf`. The
standalone lane, the explicit-`undefined` spelling, and `lastIndexOf` in both
lanes are all correct, so this is the same missing-argument-default shape as
the Array-side family (#5095 `at()`, #5121 `indexOf`/`lastIndexOf`), one
lowering over — in `string-ops.ts`, not `array-methods.ts`.

**Not a duplicate of #3763** (checked against the codex lane's claim ledger
2026-08-28 before filing): #3763 is `done` (2026-07-28) and fixed the
*explicit-argument* spelling — an undefined-**valued** variable collapsing to
`ref.null.extern` so the host searched `"null"`. This issue is the
**absent-argument** spelling (`arguments.length === 0`), still wrong on the
2026-08-28 base after #3763's fix, and only in the gc lane. The fix likely
lands next to #3763's `string-indexof-undefined` subsystem module. Distinct
from #5121 because the default here is `ToString` (a string search value),
not a strict-equality element search — no S2-style value-representation limit
applies, so this should be a small self-contained fix.

## Acceptance criteria

- `"aundefinedb".indexOf()` answers `1` in both lanes; byte-identity for
  `indexOf(x)`, `lastIndexOf()`/`lastIndexOf(x)`, and the Array-side family.
- The zero-argument form compiles byte-identical to `indexOf(undefined)` in
  the gc lane (the #5121 pin pattern), or the divergence is measured and
  explained.
- A/B per the #5095/#5121 method: base copy at first edit, pinned tests red
  on base, equivalence shards clean by name.

## Resolution (2026-08-28) — one list entry

### Root cause, found exactly where the issue predicted the fix would land

Not in `string-ops.ts` after all — that is the **standalone** lowering, and it
was already correct (`compileStringValueToLocal(expr.arguments[0], "undefined", …)`
defaults an absent search argument to the string `"undefined"`). The defect is
in the **gc/JS-host** path, `compileReceiverMethodCall`
(`src/codegen/expressions/call-receiver-method.ts`), in the loop that pads a
host import's missing optional arguments.

That loop keeps a `padsUndefined` set naming the methods whose omitted
**externref** slots must carry JS `undefined` (via the `__get_undefined` import)
instead of `ref.null.extern`:

```ts
const padsUndefined =
  method === "endsWith" || method === "lastIndexOf" || method === "padStart" || method === "padEnd";
```

`lastIndexOf` is in it; `indexOf` was not. So `"aundefinedb".indexOf()` reached
the host as `s.indexOf(null)`, which per §22.1.3.9 step 3 runs
`ToString(null)` and searches for `"null"` — absent from the probe — giving
`-1`. **That asymmetry is the whole bug**, and it also explains the issue's
matrix directly: `lastIndexOf()` answered `1` on the same probe *because* it was
already listed. The fix is to add `indexOf` to the set.

`indexOf` was measurably searching for `"null"`, not merely failing:
`"anullb".indexOf()` answered `1` on the base. That row is pinned as a test.

**Non-duplication with #3763 confirmed at the code level.** #3763's hook
`tryCompileIndexOfHoistedUndefinedSearch` is invoked as
`if (method === "indexOf" && ai === 0 && …)` from inside the *argument* loop, so
it only ever fires when `args[0]` exists. A zero-argument call never reached it.

### Measured before/after

A/B by file copy (`.tmp/base-call-receiver-method.ts` captured at first edit),
same probe, same worktree, base `origin/main` @ `f727d529ab`. Values are
gc → gc and standalone → standalone; hashes are sha256 of the emitted module,
first 12 hex, gc lane:

| shape | before (gc / sa) | after (gc / sa) | spec |
| --- | --- | --- | --- |
| `"aundefinedb".indexOf()` | **`-1`** / `1` | **`1`** / `1` | `1` |
| `"aundefinedb".indexOf(undefined)` | `1` / `1` | `1` / `1` | `1` |
| `"aundefinedb".lastIndexOf()` | `1` / `1` | `1` / `1` | `1` |
| `"abc".indexOf()` | `-1` / `-1` | `-1` / `-1` | `-1` |
| `"".indexOf()` | `-1` / `-1` | `-1` / `-1` | `-1` |
| `"aundefinedb".indexOf()` literal recv | **`-1`** / `1` | **`1`** / `1` | `1` |
| `a[0]!.indexOf()` dynamic recv | **`-1`** / `1` | **`1`** / `1` | `1` |
| `"anullb".indexOf(null)` | `1` / `1` | `1` / `1` | `1` |

### Byte-identity — the zero-arg form IS `indexOf(undefined)`

The preferred acceptance outcome, achieved rather than explained away: after the
fix `"aundefinedb".indexOf()` and `"aundefinedb".indexOf(undefined)` compile to
**one binary** (`28219ba63051`), where on base they differed
(`d7b4210a1a5d` vs `9c69a8971f06`). Pinned as a test so the two spellings cannot
drift apart. This mirrors `lastIndexOf`, whose two spellings were already one
binary (`18b1d8a8a29f`) — further evidence the fix is the same mechanism.

**Sweep: 43 shapes × 2 lanes = 86 cells, 80 byte-identical.** The 6 that moved
are all gc-lane and all `indexOf`:

| moved cell | before | after |
| --- | --- | --- |
| `indexOf()` | `-1` `d7b4210a1a5d` | `1` `28219ba63051` |
| `indexOf()` no match | `-1` `53f064ee096f` | `-1` `49bd0dd2a352` |
| `"aundefinedb".indexOf()` literal | `-1` `bd7f8069a380` | `1` `6732afe6563d` |
| `indexOf()` empty receiver | `-1` `5be0626a961e` | `-1` `dc2da42a001d` |
| `indexOf()` dynamic receiver | `-1` `8b3025d3b0ed` | `1` `5c52283715a7` |
| `indexOf(undefined)` | `1` `9c69a8971f06` | `1` `28219ba63051` |

Everything the acceptance criteria named is byte-identical in **both** lanes:
`indexOf("b")`, `indexOf("undefined")`, `indexOf("n",5)`, `indexOf("b",0)`,
`indexOf(undefined,0)`, `lastIndexOf()` / `lastIndexOf(undefined)` /
`lastIndexOf("b")` / `lastIndexOf("n",5)`, `includes()` / `includes("b")`,
`startsWith()` / `startsWith("u")`, `endsWith()` / `endsWith("b")`, `search()` /
`search(/b/)`, `padStart()` / `padStart(5)` / `padEnd(5)`, `substring()` /
`substring(1)`, `slice()` / `slice(1)`, `split()`, `charAt()`, `concat()`,
`repeat()`, `at()`, `replace()`, and the whole Array-side family
(`arr.indexOf()`, `arr.indexOf(20)`, `arr.lastIndexOf()`, `arr.includes()`,
`arr.at()`, `["x",undefined,"z"].indexOf()`).

### The one divergence worth naming: the omitted fromIndex

`indexOf(x)` with an omitted second argument also moves bytes, because the
legacy `string_indexOf` host ABI carries its optional `fromIndex` as a **boxed
externref** (see the comment at `src/ir/from-ast.ts` ~L8437), so it is padded by
this same loop — now with `__get_undefined` instead of `ref.null.extern`.

This is **spec-equivalent**: §22.1.3.9 step 4 applies
`ToIntegerOrInfinity(position)`, and that is `+0` for both `null` and
`undefined`. Verified by value rather than by argument, over 10 shapes with
genuinely dynamic (non-fold-able) needles — every value identical across the
A/B: `10 → 10`, `1 → 1`, `-1 → -1`, `7 → 7`. Four of those shapes moved bytes
with no value change; `indexOf(needle, 0)` and `indexOf(needle, 5)` did not move
at all (nothing to pad). Pinned as tests in both the unit and equivalence files.

The static-needle fold (`tryEmitStaticNeedleIndexOf`) means literal-needle calls
like `indexOf("b")` bypass the pad loop entirely and are byte-identical.

### test262 sizing — 0 flips, and that is the honest number

`built-ins/String/prototype/indexOf/` holds 47 files, and **exactly two** write
the zero-argument form — the only two in the entire `String/prototype` tree:

- `S15.5.4.7_A1_T4.js` asserts `"".indexOf() === -1`. That is `-1` before **and**
  after (searching for `"undefined"` in `""` misses just as searching for
  `"null"` did), so it passes either way. Note the test's own comment
  ("since ToString() evaluates to \"\"") is wrong about the mechanism while its
  assertion is right — which is precisely why this defect could survive in a
  directory that looks well covered.
- `not-a-constructor.js` writes `new String.prototype.indexOf()`, where the
  zero-argument call sits inside a `new` that must throw. Unaffected.

So the conformance win is **zero tests**. The value here is correctness of a
shape test262 happens not to probe, and closing the last cell of the
#5095 → #5121 → #5155 missing-argument-default chain.

### Follow-up found while measuring — three siblings, NOT fixed here

Surveying the zero-argument form of the whole `String.prototype` search family
(15 methods, both lanes) found the **identical defect in three more methods**,
all from this same `padsUndefined` omission, all gc-lane-only:

| shape | gc | standalone | spec |
| --- | --- | --- | --- |
| `"aundefinedb".includes()` | **`false`** ⚠ | `true` | `true` |
| `"undefinedb".startsWith()` | **`false`** ⚠ | `true` | `true` |
| `"aundefinedb".search()` | **`-1`** ⚠ | `0` | `0` |

(`search()` is `search(undefined)` → `RegExp(undefined)` → `/(?:)/`, which
matches at 0; the gc lane searched for `/null/` instead.) `endsWith`,
`padStart`, `padEnd`, `substring`, `slice`, `split`, `charAt`, `concat`,
`repeat`, `at` and `lastIndexOf` are all correct in both lanes.

Each is one more entry in the same list. They are **deliberately left out** so
this change keeps the blast radius at the single cell this issue pins — widening
it would move the `includes`/`startsWith`/`search` bytes that the acceptance
criteria require to stay identical. Their current wrong values are pinned as
tests (with the spec answer named in a comment) so whoever fixes them is forced
to update this file rather than diverge silently. **A follow-up issue should be
allocated for them** — same relationship #5155 has to #5121.

### Tests

- `tests/issue-5155-string-indexof-no-argument.test.ts` — 12 tests: both lanes,
  the no-match and empty-receiver guards, literal and dynamic receivers, the
  "was searching for null" evidence row, the byte-identity pin against
  `indexOf(undefined)`, the `lastIndexOf` and explicit-argument regression
  guards, the omitted-fromIndex value pins, the Array-family guard, the three
  unfixed siblings, and the other `padsUndefined` members.
- `tests/equivalence/string-indexof-no-arg.test.ts` — 10 rows against real JS
  execution, modelled on `array-at-no-arg.test.ts` (#5095) and
  `array-indexof-no-arg.test.ts` (#5121).

**Non-vacuity, measured:** with the source file reverted to base, **10 of the 22
new tests FAIL**, and the 12 that pass are exactly the intended regression
guards (standalone lane, no-match, null spelling, `lastIndexOf`,
explicit-argument, fromIndex, Array family, unfixed siblings,
`endsWith`/`padStart`/`padEnd`).
