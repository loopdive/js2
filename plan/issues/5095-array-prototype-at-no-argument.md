---
id: 5095
title: "Array.prototype.at() with NO argument returns the index, not the element (native vec lowering only)"
status: ready
sprint: current
created: 2026-08-27
updated: 2026-08-27
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
