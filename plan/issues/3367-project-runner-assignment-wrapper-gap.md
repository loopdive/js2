---
id: 3367
title: "Test262 project runner: assignment wrapper trails the original harness by five tests"
status: done
created: 2026-07-17
updated: 2026-07-17
completed: 2026-07-17
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: test262-runner
language_feature: assignment, script-this, IsHTMLDDA
goal: test262-conformance
assignee: codex/root
related: [3362, 3365, 3366]
files:
  - src/codegen/expressions/calls.ts
  - tests/test262-runner.ts
  - tests/issue-3367.test.ts
---
# #3367 — project-runner assignment wrapper gap

## Problem

After the original-harness assignment sample reached 20/20, the project
runner passed only 15/20 on the identical paths. Its five false negatives are:

- the two Annex B IsHTMLDDA assignment-destructuring tests;
- the sloppy implicit-global descriptor test;
- the two strict writes through `var global = this`.

The compiler semantics pass under the literal harness. The remaining gap is
introduced by `wrapTest`: its `$262.IsHTMLDDA` stub is `undefined`, and moving
Script body code into `export function test()` changes top-level Script `this`
into function `this`.

## Acceptance criteria

- Give project-runner IsHTMLDDA tests a non-undefined host-object identity
  sentinel without claiming the full Annex B falsy/equality behavior.
- Preserve top-level Script `this` as `globalThis` when wrapping while leaving
  ordinary function/class `this` and Module-goal top-level `this` unchanged.
- The same deterministic 20 paths pass 20/20 in both runners.

## Implementation summary

The project runner now preserves Script-goal top-level `this` when moving a
test into its synthetic function, without rewriting ordinary function or
class `this`. Its sandbox installs the standard immutable descriptors for
`undefined`, `Infinity`, and `NaN`, and IsHTMLDDA tests receive a host-object
identity sentinel without claiming the feature's full falsy/equality
semantics.

The last malformed-Wasm result exposed a compiler bug rather than another
wrapper difference: a zero-overflow indirect call created `__extras_argv`
during cleanup, shifting a captured `__argc` module-global index. Cleanup now
clears `__extras_argv` only when that global already exists.

The Script/Module distinction follows
[ECMA-262 Global Environment Records](https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-global-environment-records)
and [Module Environment Records](https://tc39.es/ecma262/multipage/executable-code-and-execution-contexts.html#sec-module-environment-records).

### Verification

- Before: original harness 20/20; project runner 15/20 (five-test gap).
- After: original harness 20/20; project runner 20/20 (zero gap).
- `tests/issue-3367.test.ts` permanently exercises the identical 20 paths.
