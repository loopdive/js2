---
id: 5095
title: "Array.prototype.at() with NO argument returns the index, not the element (native vec lowering only)"
status: done
completed: 2026-08-28
sprint: current
created: 2026-08-27
updated: 2026-08-28
# +4 lines in src/codegen/array-methods.ts (2026-08-28). The fix itself is a
# 3-line arm that REPLACES a 4-line hard reject; the growth is the comment that
# records why the zero-argument form must not be rejected, so the next reader
# does not restore the reject. Net source delta excluding comments is negative.
loc-budget-allow:
  - src/codegen/array-methods.ts
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: array-at
goal: test262-conformance
origin: 3481
---

# #5095 — `[].at()` with no argument answers `0` instead of the element

Split out of [#3481](https://js2wasm.loopdive.com/dashboard/issue.html?slug=3481-bigint-symbol-coercion-value-rep)
step 2 (PR #5101), where it was found while writing a regression guard for the
`Array.prototype.at` Symbol-index guard: the guard keys off `arguments[0]`, so
the test needed to assert what an ABSENT argument does — and that turned out to
be wrong on its own.

**This is PRE-EXISTING and unrelated to #3481's fix.** It reproduces identically
on `origin/main` and on the #3481 step-2 branch (A/B below), and #5101's
byte-identity sweep shows the `at` lowering is untouched for a call with no
argument. It is recorded here as its own issue so a picker can surface it —
inside #3481's file it was only a footnote.

## Repro

```ts
const arr = [10, 20, 30];
arr.at();        // → 0          spec: 10
```

§23.1.3.1 `Array.prototype.at(index)`: step 3 is
`relativeIndex = ? ToIntegerOrInfinity(index)`, and `ToIntegerOrInfinity(undefined)`
is `+0`, so `at()` is `at(0)` and must return the **element** `10`.

The wrong value has two spellings depending on how the result is consumed —
same defect, two coercion paths:

| consumption | observed | spec |
| --- | --- | --- |
| `"" + arr.at()` (string context) | `0` | `10` |
| `return arr.at()` (value position) | `undefined` | `10` |

## What is NOT broken — this is narrow

Measured in the same module, so the comparison is like-for-like:

| shape | observed | verdict |
| --- | --- | --- |
| `arr.at()` — statically-typed array, native vec lowering | **`0`** | **wrong** |
| `arr.at(0)` | `10` | ok |
| `arr.at(undefined)` | `10` | ok |
| `arr.at(NaN)` | `10` | ok |
| `arr.at(-1)` | `30` | ok |
| `(dyn as any).at()` — dynamic receiver, host fallback | `10` | ok |
| `new Int32Array(3).at()` — TypedArray lowering | `10` | ok |
| `"abc".at()` — `String.prototype.at` | `"a"` | ok |

So it is **only** the zero-argument case of the **native WasmGC vec** lowering.
The host fallback and the TypedArray path both already default the index
correctly, and `at(undefined)` proves `ToIntegerOrInfinity` itself is fine — the
gap is the missing-argument default, not the coercion.

That triple (host ok, TypedArray ok, `at(undefined)` ok) points at
`compileArrayAt` in `src/codegen/array-methods.ts`: the no-argument branch
appears to leave the default index on the stack as the result instead of
indexing with it. `Array.prototype.at` is dispatched from
`compileArrayMethodCall`'s `case "at"`, which chooses between
`compileArrayMethodExtern` (correct) and `compileArrayAt` (wrong here).

## A/B evidence

Both sides run from the same probe, in the same worktree, one `git checkout`
apart:

| side | commit | `arr.at()` |
| --- | --- | --- |
| `origin/main` | `220ce6c491` | `0` |
| #3481 step-2 branch | `923a35fe59` | `0` |

Identical, so #5101 neither caused nor masks it.

## Acceptance

- `[10, 20, 30].at()` returns `10` in both value and string-coercion position.
- `at(0)` / `at(undefined)` / `at(NaN)` / `at(-1)` keep their current (correct)
  answers, and the dynamic-receiver and TypedArray paths are unchanged.
- Zero pass→fail on the `built-ins/Array/prototype/at/` and
  `built-ins/TypedArray/prototype/at/` cohorts.

## Notes for the implementer

`tests/issue-3481-step2-symbol-arg-revalidation.test.ts` has a case named
"`[].at()` with no argument does not reach the guard" that deliberately asserts
only "does not throw", with a comment pointing here — it refuses to pin the
wrong value as a fixture. When this lands, that case can be tightened to
`toBe(10)`.

## Resolution (2026-08-28)

### Root cause

`compileArrayAt` (`src/codegen/array-methods.ts`) opened with a hard reject:

```ts
if (callExpr.arguments.length < 1) {
  reportError(ctx, callExpr, "at() requires 1 argument");
  return null;
}
```

`index` is an ordinary parameter, so `arr.at()` is legal JS and is exactly
`arr.at(0)` (`ToIntegerOrInfinity(undefined)` = `+0`). The reject returned
`null`, whose diagnostic the caller **swallows** — `compile()` reports
`success: true` with an EMPTY `errors` array — and the call collapses into the
caller's degraded fallback, which evaluates to the relative index rather than
the element.

Fix: replace the reject with an `i32.const 0` index arm, exactly the shape
`Array.prototype.includes` already uses for its absent `searchElement`
(`emitIncludesSearchValue`, #2872).

**The filer's diagnosis of the mechanism was right, its blast radius was not** —
see the TypedArray row below.

### Measured before/after

A/B on `src/codegen/array-methods.ts` alone (file-copy revert, same probe, same
worktree), sha256 of the emitted module, first 12 hex:

| shape | gc before → after | standalone before → after |
| --- | --- | --- |
| `a.at()` | `0f1e06b6d00d` → **`f3eea868812c`** | `75fba8273386` → **`b6ffb5d6d279`** |
| every other row below | unchanged | unchanged |

17 of the 18 probed shapes are **byte-identical** across the fix: `at(0)`,
`at(undefined)`, `at(NaN)`, `at(-1)`, `at("1")`, `at(i)`, `ta.at(0)`,
`ta.at(-1)`, `"abc".at()`, `"abc".at(1)`, `indexOf(20)`, `indexOf()`,
`includes(20)`, `includes()`, `lastIndexOf()`, `slice(1)`, externref-vec
`at(0)`. Only the `at()` row moved.

Two things fall out of the hashes:

- After the fix, gc-mode `a.at()` is byte-identical to `a.at(0)` **and**
  `a.at(undefined)` (all `f3eea868812c`), so the three spellings of index 0
  cannot drift apart. Pinned as a test.
- Before the fix, `a.at()` had the SAME hash as `a.indexOf()` and
  `a.lastIndexOf()` (`0f1e06b6d00d`). That is the shared degraded-fallback
  collapse, identified by hash rather than inferred — and it is what points at
  the sibling defect below.

Values (gc mode) before → after: `[10,20,30].at()` `0` → **`10`** in value
position, `"0"` → **`"10"`** in string position.

### Sibling probes — verdicts

| sibling | verdict |
| --- | --- |
| `[10,20,30].at()` on an **empty** array | Now byte-for-byte the same lowering as `at(0)`. Both render the out-of-bounds read as `NaN` (f64 vec) / `null` (externref vec) rather than `undefined` — **pre-existing** and general (`[10].at(5)` does the same), NOT a no-argument defect. Pinned as an equality against `at(0)`, deliberately not as a literal. |
| negative index | Unchanged, byte-identical (`at(-1)`, `at(-3)`). |
| `includes()` zero-arg | **Already correct** — #2872 fixed exactly this defect there, and `emitIncludesSearchValue` is the model this fix copies. Guarded so it stays correct. |
| `indexOf()` / `lastIndexOf()` zero-arg | **BROKEN, same collapse** (identical pre-fix hash). `[10,20,30].indexOf()` answers `0`; §23.1.3.13 requires `-1` (searches `undefined`, strict equality, holes skipped via HasProperty). `[10,undefined,30].indexOf()` answers `0`, should be `1`. **Not fixed here** — the correct answer is not a defaulted index but a different search value with different comparison semantics, so it is a separate change with its own test262 blast radius. Follow-up needed. |
| `new Int32Array(3).at()` (TypedArray) | **Was BROKEN too** — the issue's table above lists it as correct, which was wrong. It shares `compileArrayAt`, so it answered `0` instead of element 0. Fixed by this same change and pinned in both lanes. |
| `"abc".at()` (String.prototype.at) | Correct, and byte-identical — a different lowering (`string-ops.ts`), untouched. |

### Follow-up

`indexOf()` / `lastIndexOf()` with no argument (the row above) still answer `0`
where the spec requires `-1`. Filed as #5121 (2026-08-28, allocated by the
orchestrator once an id could be reserved; split there into S1
missing-argument default vs S2 f64-vec hole/undefined value-representation
limit).

## Test Results

`tests/issue-5095-array-at-no-argument.test.ts` — 13 tests, all pass. Covers the
no-argument case in value and string position on a non-empty array (gc +
standalone), the empty-array equality against `at(0)`, the TypedArray receiver
in both lanes, the gc byte-identity of `at()` / `at(0)` / `at(undefined)`, and
the already-correct forms as regression guards.

`tests/equivalence/array-at-no-arg.test.ts` — 5 rows, all pass. Modelled on the
sibling `array-includes-no-arg.test.ts` (#2872, the same defect shape one method
over): numeric array, agreement with the `at(0)` spelling, string array,
TypedArray receiver, and the explicit-index forms. The empty-array row is
deliberately absent — see the sibling table above for why.

Also re-run green: `tests/issue-2644-array-at-index-tointeger.test.ts` (14) and
`tests/issue-3481-step2-symbol-arg-revalidation.test.ts` (36) — the latter's
`[].at()` case is tightened from "does not throw" to `toBe(10)`, as this file
anticipated.

Gates: `typecheck` 0, `lint` 0, `format:check` 0, `check:func-budget` 0,
`check:coercion-sites` 0, `check:oracle-ratchet` 0, `check:dead-exports` 0,
`check:issue-ids` 0, `check:done-status-integrity` 0,
`check:issue-spec-coverage` 0, `check:test-vacuity-shapes` 0,
`check:ir-fallbacks` unchanged, `check:loc-budget` 0 with the grant above.
Equivalence gate run as **8 shards**, all green: 24 failing / 1,685 passing
against 24 known-failures in the baseline — i.e. zero new regressions and the
failure count is exactly the baseline.

### Acceptance

- [x] `[10, 20, 30].at()` returns `10` in both value and string-coercion position.
- [x] `at(0)` / `at(undefined)` / `at(NaN)` / `at(-1)` keep their answers — proven
      byte-identical, not just behaviourally equal.
- [x] TypedArray path unchanged *in the sense that matters*: it was broken the
      same way and is now correct; `at(0)` / `at(-1)` on it are byte-identical.
- [ ] Dynamic-receiver host fallback: `compileArrayMethodExtern` is not touched
      by this change (no diff reaches it), so it is unchanged by construction.
      Not re-measured end-to-end — the probe receiver for `const a: any = [...]`
      is a WasmGC vec, not a JS array, so it throws in the harness for reasons
      unrelated to this issue.
- [ ] test262 `built-ins/Array/prototype/at/` + `built-ins/TypedArray/prototype/at/`
      cohorts: not run locally (devs do not run test262 locally); CI's
      `merge_group` re-validation is the gate.
