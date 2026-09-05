---
id: 4718
title: "ES2015 for-of closes generators on abrupt throw"
status: in-review
created: 2026-08-25
updated: 2026-08-25
depends_on:
  - 4937
loc-budget-allow:
  - src/codegen/generators-native.ts
  - src/codegen/generators-native-consumer.ts
  - src/codegen/statements/loops.ts
func-budget-allow:
  - src/codegen/generators-native.ts::hostLaneGeneratorUsesAreSafe
  - src/codegen/generators-native-consumer.ts::tryCompileNativeGeneratorForOf
  - src/codegen/statements/loops.ts::compileForOfIterator
priority: medium
feasibility: medium
goal: iterator-protocol
sprint: current
es_edition: es2015
language_feature: for-of-generator-close-throw
task_type: bug
---
# #4718 — ES2015 for-of generator close via throw

## Scope

Complete the residual native-generator `IteratorClose` case left explicitly
out of upstream PR #4937: `language/statements/for-of/generator-close-via-throw.js`.
The implementation must preserve the #4937 break/return/continue generator-close
behavior and the generic non-generator IteratorClose controls in both the JS-host
and standalone lanes. This issue depends on #4937 and does not broaden into the
remaining iterator method/accessor representation work.

## Live baseline (2026-08-25)

Measured from the exact #4937 head `1184de4701d9522cf1a19e16bd5a41cdc94e3a5e`
(dependency commit `e71a5d2e128898c75051ce3c7efd08dcfbd3573c`) with pnpm
10.30.2 and the repository's Test262 runner. The target fails in both lanes,
while every listed control passes:

| Test262 file | JS-host | standalone |
| --- | --- | --- |
| `generator-close-via-throw.js` | fail — generator is not initially suspended (`startedCount` is 1 instead of 0) | fail — generator `finally` is skipped (`finallyCount` is 0 instead of 1) |
| `generator-close-via-break.js` | pass | pass |
| `generator-close-via-return.js` | pass | pass |
| `generator-close-via-continue.js` | pass | pass |
| `iterator-close-via-break.js` | pass | pass |
| `iterator-close-via-return.js` | pass | pass |
| `iterator-close-via-throw.js` | pass | pass |

The host failure is the eager-host-generator path selected when the for-of body
contains a throw. The standalone failure is the native state-machine path: the
body throw reaches the close machinery, but it does not resume the generator with
the abrupt `return(undefined)` needed to execute its `finally` block.

## Spec basis

ECMAScript §14.7.5.7 requires an abrupt for-of completion to perform
[IteratorClose](https://tc39.es/ecma262/2025/multipage/ecmascript-language-statements-and-declarations.html#sec-for-in-of-body-evaluation).
For a throw completion, §7.4.11 preserves the original throw if closing itself
abrupts. For generators, §27.5.3.3
[GeneratorResumeAbrupt](https://tc39.es/ecma262/2025/multipage/control-abstraction-objects.html#sec-generatorresumeabrupt)
models the close as `generator.return(undefined)`; the native lowering must run
that resume before rethrowing the body exception.

## Implementation plan

1. Trace #4937's native for-of close sequence and host-lane safety gate against
   emitted Wasm/WAT for the throw target. Identify the narrowest distinction
   between body `throw` and the already passing break/return/continue exits.
2. Implement only the throw-abrupt generator close: retain the suspended host
   generator observable and resume the standalone native generator with implicit
   `undefined` before preserving the original throw. Keep generic iterators and
   all #4937 controls unchanged.
3. Add a focused regression test covering the target plus the passing controls in
   both lanes. Re-run the exact Test262 files, then TS5/TS7/typecheck/lint/format
   and pre-push checks. Keep the incremental source delta at or below 180 LOC
   beyond the #4937 dependency.

## Test Results

Implementation uses 77 incremental source LOC beyond #4937: the host safety gate
admits throw-containing for-of bodies, and the native driver wraps its loop in a
throw-catching IteratorClose scaffold. The catch path resumes with implicit
`return(undefined)`, suppresses close-time exceptions, and rethrows the original
body exception. It uses the same tagged-try shape as the generic iterator driver
in standalone/WASI and legacy `try/catch_all` in the JS-host lane.

Exact Test262 runner results (`runTest262File`, pnpm 10.30.2), host and standalone:

| File | Host | Standalone |
| --- | --- | --- |
| `generator-close-via-throw.js` | pass | pass |
| `generator-close-via-break.js` | pass | pass |
| `generator-close-via-return.js` | pass | pass |
| `generator-close-via-continue.js` | pass | pass |
| `iterator-close-via-break.js` | pass | pass |
| `iterator-close-via-return.js` | pass | pass |
| `iterator-close-via-throw.js` | pass | pass |

Focused regression `tests/issue-4718.test.ts`: 14/14 tests passed (7 files × 2
lanes). TypeScript 5 and TypeScript 7 typechecks passed; full lint and Prettier
format checks passed, and the touched-file lint check was clean.
