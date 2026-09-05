---
id: 4659
title: "Standalone: 10 asyncTest-using failures un-hidden by the #4630 catch-var widening"
status: ready
sprint: Backlog
created: 2026-08-23
priority: medium
horizon: l
feasibility: hard
task_type: bug
area: codegen
goal: test262-conformance
lane: B
files:
  - src/codegen/async-scheduler.ts
  - src/codegen/async-frame.ts
---

# #4659 — the ten standalone `asyncTest(` failures #4630 stopped hiding

## Why this exists

`#4630` widened the catch-clause param-narrowing withdrawal from
native-string-only to every GC-`ref` agreement, which is what let
`asyncHelpers-asyncTest-return-not-thenable` pass and took the standalone
harness category to 116/116.

Before that widening, `$DONE`'s parameter was narrowed by call-site agreement
to `(ref null $Test262Error)`. The ABI boundary for a ref narrowing
**guard-casts** a violating value to null rather than trapping, so **any error
handed to `$DONE` from `asyncTest`'s `catch (syncError)` arrived as null** and
`doneprintHandle`'s `if (error)` printed `Test262:AsyncTestComplete`. Every
`flags: [async]` test whose failure travelled that path reported PASS.

**None of the ten below is caused by #4630.** Measured on that branch
(2026-08-23): with the declaration-substrate change applied but the widening
reverted, all ten pass; with the widening, all ten fail. They were false
passes, and each now reports the pre-existing defect it always had.

## Scope: STANDALONE ONLY — the CI baseline is unaffected

Re-run in the runner's DEFAULT (js-host) mode, which is the mode
`test262-current.jsonl` records: **nine of the ten already fail**, and the one
that does not (`Array/fromAsync/this-non-constructor.js`, baseline `pass`)
**still passes**. So every one of the ten keeps its baseline status in CI's
mode; the accounting change is confined to the standalone lane.

## The ten, by root cause

| # | root cause | files |
| --- | --- | --- |
| 4 | `Array.fromAsync` is not implemented under `--target standalone` (the compiler throws that exact message) | `built-ins/Array/fromAsync/this-constructor{,-operations,-with-readonly-elements}.js`, `.../this-non-constructor.js` |
| 2 | `Promise.allKeyed` / `Promise.allSettledKeyed` (the `await-dictionary` proposal) are absent standalone, so `resultCapability.[[Resolve]]` reads undefined — "Cannot read properties of undefined (reading 'call')" | `built-ins/Promise/allKeyed/capability-resolve-throws-reject.js`, `built-ins/Promise/allSettledKeyed/capability-resolve-throws-reject.js` |
| 1 | standalone dynamic `import()` needs a module loader — a deliberate non-feature, tracked as **#3494** | `language/expressions/dynamic-import/assignment-expression/await-identifier.js` |
| 1 | `for await`: "iteration limit exceeded (async carrier cannot observe promise …)" — the async carrier cannot observe settlement of the awaited value | `language/expressions/optional-chaining/iteration-statement-for-await-of.js` |
| 1 | `await using`: "Cannot access property on null or undefined" | `language/statements/await-using/fn-name-class.js` (also `compile_error` in the js-host baseline) |
| 1 | for-await-of iterator close with a null `return` method: "value is not iterable" | `language/statements/for-await-of/iterator-close-non-throw-get-method-is-null.js` |

## Acceptance

Each row fixed or explicitly declined. The first two rows are feature gaps
(implement the intrinsic standalone, or accept the gap); the last three are
async-carrier substrate gaps in the same family #4630 worked in and are the
ones worth attacking first — they are single tests each but the substrate they
exercise (settlement observation, `await using` disposal, async iterator close)
is shared by much larger buckets.

`#3494` already owns the dynamic-import row; do not duplicate it here.

## How to reproduce

```
npx tsx .tmp/run-standalone-list.mts   # LIST=<the ten paths>
```
with `scripts/build-quickjs-eval-provider.mjs` built first, or the four
provider-dependent harness tests fail spuriously.

## Permanent repro

Representative test262 paths, standalone lane
(`tests/test262-runner.ts` `runTest262File(..., "standalone")`):

- `test262/test/built-ins/Array/fromAsync/this-non-constructor.js` —
  `Array.fromAsync` unimplemented in `--target standalone` (4 of the ten).
- `test262/test/built-ins/Promise/allSettled/resolve-element-function-name.js` —
  the `Promise.{all,allSettled}` keyed-combinator gap (2 of the ten).
- `test262/test/language/expressions/dynamic-import/assignment-expression/import-meta.js` —
  standalone dynamic import, already owned by #3494 (1 of the ten).
- `test262/test/language/statements/for-await-of/head-lhs-async-of.js` —
  the async-carrier substrate group: `for await` settlement observation,
  `await using`, async-iterator close (3 of the ten).

All ten pass again if the `param-return-inference.ts` catch-var widening alone
is reverted, which is the evidence that none is caused by #4630.
