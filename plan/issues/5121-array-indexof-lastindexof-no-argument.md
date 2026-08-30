---
id: 5121
title: "Array.prototype.indexOf()/lastIndexOf() with NO argument return 0, not -1 (same degraded-fallback collapse as #5095)"
status: in-progress
sprint: current
created: 2026-08-28
updated: 2026-08-28
# S1 landed 2026-08-28; S2 (below) stays open, so this issue is NOT done.
# +44 lines in src/codegen/array-includes-search-value.ts, +42/-20 in
# src/codegen/array-methods.ts (2026-08-28). The executable change is small: two
# 4-line hard rejects are REPLACED by a 5-line absent-argument arm each, plus one
# 15-line helper whose body is 10 lines. The rest is comment recording (a) why the
# zero-argument form must not be rejected, so the next reader does not restore the
# reject, (b) why this is a strict-equality sibling of `emitIncludesSearchValue`
# rather than a call to it, and (c) why the now-stale `shouldWrapDynViewTwoArm`
# clause is kept anyway. Net non-comment source delta is ~+15 lines.
loc-budget-allow:
  - src/codegen/array-methods.ts
  - src/codegen/array-includes-search-value.ts
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: array-indexof
goal: test262-conformance
origin: 5095
# Id 5121 was reserved on the `issue-assignments` ref for ttraenkler/opus-5095.
# `claim-issue.mjs --allocate` ran with a DEGRADED open-PR scan (`gh` is absent
# in the authoring container, exit 6), so the reservation was cross-checked by
# hand via MCP against all 24 open PRs' tracking files — no `5121-*.md` is in
# flight anywhere. Note that PR **number** 5121 also exists; that is fine and
# expected, because plan-file ids and PR numbers are separate sequences (the
# slug-link convention in CLAUDE.md exists precisely to disambiguate them).
---

# #5121 — `[10,20,30].indexOf()` answers `0`, spec says `-1`

Found while fixing
[#5095](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5095-array-prototype-at-no-argument)
(`Array.prototype.at()` with no argument answering the index instead of the
element). Not a guess by analogy — **found by hash**: on `origin/main`, the
broken `at()` compiled to the *byte-identical module* as `indexOf()` and
`lastIndexOf()`, which is what identified them as the same defect rather than
three similar-looking ones.

## Repro

```ts
const arr = [10, 20, 30];
arr.indexOf();      // → 0    spec: -1
arr.lastIndexOf();  // → 0    spec: -1
```

§23.1.3.13 `Array.prototype.indexOf(searchElement)` (and §23.1.3.20
`lastIndexOf`) take `searchElement` as an ordinary parameter, so the
zero-argument form is legal and searches for `undefined`.

## Root cause — same shape as #5095, one method over

`compileArrayIndexOf` and `compileArrayLastIndexOf`
(`src/codegen/array-methods.ts`) each open with a hard reject:

```ts
if (callExpr.arguments.length < 1) {
  reportError(ctx, callExpr, "indexOf requires 1 argument");
  return null;
}
```

The caller **swallows** that diagnostic — `compile()` reports `success: true`
with an **empty** `errors` array — and collapses the call into its degraded
fallback, which evaluates to `0`. This is exactly the mechanism #5095 fixed in
`compileArrayAt`; the two survivors are these.

`Array.prototype.includes` already models an absent `searchElement` correctly
(`emitIncludesSearchValue`, `src/codegen/array-includes-search-value.ts`, from
#2872) and is the template.

## Measured on `origin/main` @ `b1cc63d1b1`

Values, and sha256 of the emitted module (first 12 hex), gc/host lane:

| shape | observed | spec | hash |
| --- | --- | --- | --- |
| `[10,20,30].indexOf()` | **`0`** | `-1` | `0f1e06b6d00d` |
| `[10,20,30].lastIndexOf()` | **`0`** | `-1` | `0f1e06b6d00d` |
| `[10,20,30].at()` (fixed by #5095) | `0` | `10` | `0f1e06b6d00d` |
| `[10,undefined,30].indexOf()` | **`0`** | `1` | `c38059959819` |
| `[10,undefined,30].lastIndexOf()` | **`0`** | `1` | `c38059959819` |
| `["x","y"].indexOf()` | **`0`** | `-1` | `f576c114b1a3` |
| `[].indexOf()` | **`0`** | `-1` | `de7073206594` |
| `["x",undefined,"z"].indexOf()` | **`0`** | `1` | — |
| `(["1",undefined,3] as any[]).indexOf()` | **`0`** | `1` | — |

The three top rows sharing one hash is the collapse, seen directly. The rows
below it differ from each other only because the *array literal* differs — each
still collapses to the same fallback for its own receiver.

## Why this is NOT just "copy the #5095 one-liner"

#5095's fix was `i32.const 0` — a defaulted **index**. Here the absent argument
is a defaulted **search value**, compared with a different operator, and the
measurements split the work into two very different slices.

**S1 — the missing-argument default (small, the actual #5095 analog).** The
explicit spelling `indexOf(undefined)` is **already correct wherever the element
type can represent `undefined`**, which is the evidence that the gap is the
default and nothing else:

| shape | `indexOf(undefined)` | `indexOf()` | verdict |
| --- | --- | --- | --- |
| `["x",undefined,"z"]` (externref vec) | `1` ✅ | `0` ❌ | default only |
| `[1,undefined,3]` as `any[]` (externref vec) | `1` ✅ | `0` ❌ | default only |
| `[10,20,30]` (f64 vec) | `-1` ✅ | `0` ❌ | default only |
| `["x","y"]` | `-1` ✅ | `0` ❌ | default only |
| `[]` | `-1` ✅ | `0` ❌ | default only |

So S1 is: emit the absent `searchElement` as whatever an explicit `undefined`
would produce for this element type, exactly as `emitIncludesSearchValue` does,
and drop the reject. That fixes every row above.

**S2 — a value-representation limit, probably defer.** One row is wrong even
with the argument written out:

| shape | `indexOf(undefined)` | spec |
| --- | --- | --- |
| `[10,undefined,30]` (f64 vec) | `-1` | `1` |

In an f64 vec both a hole and `undefined` read as NaN, and `indexOf` uses
**strict equality** (§23.1.3.13 step 6b), under which `NaN !== NaN`. The
compiler answers `-1`, which is *correct* for `[NaN].indexOf(NaN)` (verified:
answers `-1`, as the spec requires) and *wrong* for `[undefined].indexOf(undefined)`
— the two are indistinguishable in that encoding. This is the same imprecision
already documented in the `NEVER_A_NUMBER` comment in
`src/codegen/array-includes-search-value.ts`, resolved the *other* way there
because `includes` uses SameValueZero, under which NaN does match. It needs a
tagged element representation, not an argument default, so it should not block
S1.

Note also that `indexOf` reads with **HasProperty** semantics for holes (a hole
is skipped, not compared as `undefined`), unlike `includes`, which reads with
Get. Whoever takes S2 should not copy `includes`'s hole handling wholesale.

## Acceptance

- `[10,20,30].indexOf()` and `.lastIndexOf()` return `-1`.
- `["x",undefined,"z"].indexOf()` returns `1`; the `any[]` spelling likewise.
- Every explicit-argument form stays byte-identical (`indexOf(20)`,
  `lastIndexOf(20)`, `indexOf(undefined)`, `includes()` — the last already
  correct via #2872 and must not regress).
- Zero pass→fail on `built-ins/Array/prototype/indexOf/` and
  `built-ins/Array/prototype/lastIndexOf/`.
- S2 (f64-vec `indexOf(undefined)` finding a real `undefined`) is explicitly out
  of scope; if it is left open, say so in the PR rather than pinning `-1` as a
  fixture.

## Notes for the implementer

- `shouldWrapDynViewTwoArm` (`src/codegen/array-methods.ts`) skips the #2872
  dyn-view two-arm for zero-argument calls precisely *because* these two impls
  hard-require their argument (`(callExpr.arguments.length >= 1 || methodName === "toLocaleString")`).
  Once the reject is gone, revisit that clause — #5095 deliberately left it
  alone to keep its blast radius at one method.
- `tests/equivalence/array-includes-no-arg.test.ts` and
  `tests/equivalence/array-at-no-arg.test.ts` are the two existing files this
  should be modelled on; both were written for this same defect shape.

## S1 — Resolution (2026-08-28)

**S1 is complete. S2 below is NOT, so this issue stays open** — see
"S2 — still open" for the re-scoped remainder.

### What changed

`compileArrayIndexOf` / `compileArrayLastIndexOf` (`src/codegen/array-methods.ts`)
no longer reject the zero-argument call. The absent `searchElement` is emitted as
whatever an explicit `undefined` would produce for the element type, via a new
`emitIndexOfAbsentSearchValue` in `src/codegen/array-includes-search-value.ts` —
a **sibling** of `emitIncludesSearchValue`, not a call to it, because `indexOf`
compares with strict equality where `includes` uses SameValueZero:

| element vec | absent `searchElement` becomes | why |
| --- | --- | --- |
| externref | a real `undefined` | an element that IS `undefined` (or a hole mapped to one) matches — this is the row that proves the default is a search VALUE |
| f64 | NaN, exactly what `indexOf(undefined)` already emits | `f64.eq` is false when either side is NaN, so the scan runs and finds nothing. `includes` resolves this the OTHER way (its SameValueZero arm makes NaN match NaN, which is how it finds a hole) — copying that would wrongly match `[NaN].indexOf()` |
| anything else (i32, native-string / object refs) | nothing; the caller answers `-1` with no scan | no value of that type is `undefined`. Load-bearing: leaving the value local at its zero default would compare against `0` and make `[false,true].indexOf()` answer `0` |

### Measured before/after

A/B by file copy (both source files reverted, same probe, same worktree), base
`origin/main` @ `30a3335b80`. Values are gc → gc and standalone → standalone:

| shape | before (gc / sa) | after (gc / sa) | spec |
| --- | --- | --- | --- |
| `[10,20,30].indexOf()` | `0` / `0` | **`-1`** / **`-1`** | `-1` |
| `[10,20,30].lastIndexOf()` | `0` / `0` | **`-1`** / **`-1`** | `-1` |
| `["x","y"].indexOf()` | `0` / `0` | **`-1`** / **`-1`** | `-1` |
| `[].indexOf()` / `.lastIndexOf()` | `0` / `0` | **`-1`** / **`-1`** | `-1` |
| `[false,true].indexOf()` | `0` / `0` | **`-1`** / **`-1`** | `-1` |
| `["x",undefined,"z"].indexOf()` | `0` / `0` | **`1`** / `-1` ⚠ | `1` |
| `(["1",undefined,3] as any[]).indexOf()` | `0` / `0` | **`1`** / **`1`** | `1` |
| `new Int32Array(3).indexOf()` / `.lastIndexOf()` | `0` / `0` | **`-1`** / **`-1`** | `-1` |
| `new Float64Array(2).indexOf()` | `0` / `0` | **`-1`** / **`-1`** | `-1` |
| `[10,undefined,30].indexOf()` | `0` / `0` | `-1` / `-1` (S2) | `1` |

⚠ the one lane divergence is recorded under "S2 — still open" below.

The **hash collapse is gone.** The issue's `0f1e06b6d00d` reproduced exactly on
this base: `[10,20,30].indexOf()`, `.lastIndexOf()` and (pre-#5095) `.at()` were
one binary. After the fix all three hashes differ, asserted as a test.

**Byte-identity sweep — every neighbouring shape that must not move did not**, in
both lanes: `indexOf(20)`, `lastIndexOf(20)`, `indexOf(20,1)`,
`lastIndexOf(20,2)`, `indexOf(undefined)` / `lastIndexOf(undefined)` on all four
receiver shapes, `["x","y"].indexOf("y")`, `[1,NaN,3].indexOf(NaN)`,
`Int32Array.indexOf(7)`, `Float64Array.indexOf(7)`, `Int8Array.indexOf(-1)`
(#2648 packed signedness), `includes()` / `includes(20)`, `at()` / `at(0)`,
`slice(1)`, and all four `String.prototype.indexOf/lastIndexOf` shapes. Of the 47
probed shapes, **30 are byte-identical and the 17 that moved are exactly the
defect rows** — same split in both lanes, counted by script over the two hash
tables rather than by eye.

On an **externref** vec the no-argument form is byte-identical to the explicit
`indexOf(undefined)` — pinned as a test, so the two spellings cannot drift apart.
On an **f64** vec it is not: it is 3 bytes SHORTER (1395 vs 1398, the same size as
`indexOf(20)`), because the `undefined` identifier lowering emits slightly more
than a bare `f64.const NaN`. Behaviour is identical, byte-identity is not claimed.

### test262 sizing — measured, +2 fail→pass, 0 pass→fail

`built-ins/Array/prototype/indexOf/` and `lastIndexOf/` hold 201 and 198 files,
and **exactly one each asserts a zero-argument result**
(`15.4.4.14-9-b-ii-2.js` / `15.4.4.15-8-b-ii-2.js`: `[undefined].indexOf()` must
be `0`). Both **flip fail→pass** — on base they report
`Expected SameValue(«undefined», «0»)`, the fallback's value-position spelling.
The only other files writing the zero-argument form are the two
`not-a-constructor.js`, where it sits inside a `new` that must throw; those pass
before and after, as do `TypedArray/prototype/{indexOf,lastIndexOf}/no-arg.js`
(already passing — test262's untyped arrays do not take the static-vec path that
carried the defect), both `length-zero-returns-minus-one.js` and
`includes/no-arg.js`. Nine files run A/B, 0 pass→fail. The win is small; stating
it plainly is the point.

### Tests

- `tests/issue-5121-array-indexof-no-argument.test.ts` — 13 tests: the headline
  rows in both lanes, the externref rows that prove a search VALUE, the i32 and
  TypedArray receivers, the collapse-is-gone hash assertion, the externref
  byte-identity pin, the S2 equality, and the explicit-argument /
  `includes()` / `at()` / `String.prototype` regression guards.
- `tests/equivalence/array-indexof-no-arg.test.ts` — 10 rows against real JS
  execution, modelled on `array-includes-no-arg.test.ts` (#2872) and
  `array-at-no-arg.test.ts` (#5095).

Equivalence gate run as **8 shards, all green**: 24 failing / 1,695 passing
against 24 known-failures in the baseline — the failing NAME set is exactly the
baseline (every shard reports "No new equivalence regressions"), and the passing
count grew by exactly the 10 rows this PR adds (1,685 → 1,695).

**Non-vacuity, measured:** with both source files reverted to base, 19 of the 23
new tests FAIL, and the 4 that pass are exactly the intended regression guards
(explicit arguments, `includes()`/`at()`, `String.prototype`).

`tests/issue-2872.test.ts > non-TA dynamic callee still constructs through the
class dispatch` fails — **pre-existing, verified by the same A/B revert** (it
fails identically on base and contains no `indexOf`).

### `shouldWrapDynViewTwoArm` — deliberately unchanged

Its zero-argument clause cites the three rejects that no longer exist
(`includes` #2872, `at` #5095, `indexOf`/`lastIndexOf` here). It is **kept** and
its comment corrected: `DYN_VIEW_READ_METHODS` also holds the callback methods
(`reduce`, `reduceRight`, `find`, …) whose typed impls still hard-require their
callback, and narrowing the clause would move `ta.indexOf()` onto a different
lowering — a lowering change with its own blast radius and no defect behind it.
Same call #5095 made.

## S2 — still open (value representation, not argument count)

Unchanged by S1 and still the reason this issue is not `done`:

1. **f64 vec, hole vs `undefined`.** `[10,undefined,30].indexOf()` answers `-1`;
   spec says `1`. Both read as NaN, and `===` matches neither. Equally wrong for
   the explicit `indexOf(undefined)` spelling, so the test pins the two spellings
   as EQUAL rather than blessing `-1` as a fixture. Needs a tagged element
   representation.
2. **Native-string (`ref_null`) vec, standalone lane, NEW finding.**
   `["x",undefined,"z"].indexOf()` answers `1` in gc (correct) but `-1` in
   standalone. Measured cause: in that lane the encoding does not distinguish
   `undefined` from `null` — on base, with explicit arguments,
   `["x",undefined,"z"].indexOf(null)` already answers `1` (spec `-1`), and every
   `["x",null,"z"]` spelling answers `0`. S1 therefore chose "no match" for that
   element type, matching the existing `includes` precedent
   (`["x",undefined,"z"].includes()` is likewise `1` in gc and `0` in standalone
   on base): inventing a match the encoding cannot justify would make
   `["x",null,"z"].indexOf()` wrongly answer `0`. Same S2 class as (1), one
   encoding over.

Both need a tagged element representation, so neither blocked S1.

## Follow-up found while measuring (separate issue, NOT this one)

**`String.prototype.indexOf()` with no argument, gc lane only**, answers `-1`
where the spec says `1`: `"aundefinedb".indexOf()` is `-1` in gc but `1` in
standalone, while `"aundefinedb".indexOf(undefined)` is `1` in **both** and
`"aundefinedb".lastIndexOf()` is `1` in both. So exactly one cell is wrong — the
same missing-argument-default shape, in the `string-ops` lowering rather than the
array one. Untouched by this change (all four String shapes are byte-identical
across it) and out of scope for §23.1.3.13. Adjacent to #3763, which fixed the
explicit-`undefined` search coercion for the same method.
