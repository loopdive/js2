---
id: 4716
title: "ES2015 for-of closes generators on abrupt break and return"
status: done
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25
loc-budget-allow:
  - src/codegen/statements/loops.ts
  - src/codegen/generators-native.ts
func-budget-allow:
  - src/codegen/statements/loops.ts::compileForOfIterator
priority: medium
feasibility: medium
goal: iterator-protocol
sprint: current
---
# #4716 — ES2015 for-of generator close via break/return

## Scope

Repair the bounded ES2015 Test262 cluster
`language/statements/for-of/generator-close-via-break.js` and
`language/statements/for-of/generator-close-via-return.js`, while preserving the
nearby generic IteratorClose controls. The implementation must cover the
native/standalone generator representation and must not regress the existing
host generator path.

## Live baseline (2026-08-25)

Baseline was measured against `upstream/main` at `598cb2f22` with the pinned
pnpm 10.30.2 toolchain. The exact Test262 files were run through
`runTest262File` in both lanes, with `generator-close-via-continue.js` as an
adjacent generator control and the three generic IteratorClose abrupt-exit
tests as controls:

| Test262 file | JS-host | standalone |
| --- | --- | --- |
| `generator-close-via-break.js` | fail — `startedCount` is 1 before the first loop | fail — `finallyCount` remains 0 after `break` |
| `generator-close-via-return.js` | fail — `startedCount` is 1 before the first loop | fail — `finallyCount` remains 0 after `return` |
| `generator-close-via-continue.js` | fail — `startedCount` is 1 before the first loop | fail — `finallyCount` remains 0 after `continue` |
| `iterator-close-via-break.js` | pass | pass |
| `iterator-close-via-return.js` | pass | pass |
| `iterator-close-via-throw.js` | pass | pass |

The host failures show the eager generator path violates the suspended-start
observable. The standalone failures isolate the requested close behavior:
the native generator yields successfully, but the abrupt for-of exit does not
resume/close it, so its `finally` body is skipped. Generic iterator closing is
already passing in both lanes.

## Spec basis

ECMAScript §14.7.5.7 requires an abrupt loop completion (including `break`,
`return`, and a labelled outer `continue`) to call
[IteratorClose](https://tc39.es/ecma262/2025/multipage/ecmascript-language-statements-and-declarations.html#sec-for-in-of-body-evaluation).
§7.4.11 specifies that close operation as `iterator.return()` and preserves a
throwing outer completion, while §27.5.3.3
[GeneratorResumeAbrupt](https://tc39.es/ecma262/2025/multipage/control-abstraction-objects.html#sec-generatorresumeabrupt)
is the generator state-machine equivalent used by this native lowering.

## Implementation plan

1. Trace the standalone `for-of` lowering and native generator state-machine
   close/return ABI, then trace the host generator path separately. Confirm the
   exact generated Wasm/WAT and identify the narrowest missing close operation.
2. Implement spec-correct IteratorClose for an abrupt `break`/`return` from a
   for-of over a native generator, keeping generic iterator controls unchanged.
   Add a regression test covering both requested files and the continue control.
3. Re-run the exact two files in host and standalone lanes plus all six controls,
   then run the focused regression tests and the requested TS5/TS7/typecheck,
   lint, format, and pre-push checks.

## Test Results

Implementation complete. The native for-of driver now tracks normal completion,
sets the frame's abrupt carrier to the implicit `undefined`, resumes with
return mode on abrupt exits, and uses `finallyStack` for outer
break/return/continue targets. Host-lane bindings whose initializer is a
generator call recover the underlying state ref before selecting this driver.

Exact Test262 runner results (`runTest262File`, pinned pnpm 10.30.2), host and
standalone:

| File | Host | Standalone |
| --- | --- | --- |
| `generator-close-via-break.js` | pass | pass |
| `generator-close-via-return.js` | pass | pass |
| `generator-close-via-continue.js` | pass | pass |
| `iterator-close-via-break.js` | pass | pass |
| `iterator-close-via-return.js` | pass | pass |
| `iterator-close-via-throw.js` | pass | pass |

Focused regression: `tests/issue-4716.test.ts` covers the two requested files
and all six host/standalone controls above.

After merging current main, #4696's native binding-slot and IteratorClose
implementation subsumed this branch's overlapping compiler changes. The
duplicate lowering was dropped; the stronger 12-case host/standalone Test262
pin suite remains and passes against the shared implementation.
