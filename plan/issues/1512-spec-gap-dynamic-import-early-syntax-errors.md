---
id: 1512
title: "spec gap: dynamic import — early SyntaxErrors for nested syntactic contexts"
status: done
completed: 2026-06-12
created: 2026-05-20
updated: 2026-05-20
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: compiler
language_feature: dynamic-import, early-errors
goal: spec-completeness
sprint: 52
related: [1315, 1390, 1435]
---
# #1512 — dynamic-import early SyntaxError detection

## Problem

`language/expressions/dynamic-import/syntax/` has **191 failing
test262 cases**, all with the identical error:

```
expected parse/early SyntaxError but compiled and instantiated successfully
```

These tests are *negative* — the input is required by §13.3.10 to
fail at parse time, and the test runner asserts the parser refuses
the source. Examples:

- `nested-async-gen-await-typeof-import-source.js` (using
  `await typeof import.source(...)` outside a valid async context).
- `nested-with-expression-import-call-unknown.js`
  (`with (import(...)) {…}` — `with` is disallowed in module code).
- `nested-async-function-await-import-source-source-text-module-record.js`.

The compiler accepts the source and emits a Wasm module, which the
runner classifies as `fail` against the test's expected SyntaxError
negative-test directive.

## Failure count

**191 fails** all sharing the same error message. Realistic target
after the stage-3 `import.source` / `import.defer` proposals are kept
filtered: **~120 flips**.

## Root cause

`src/compiler/early-errors.ts` ships with checks for the standard
ImportCall production (§13.3.10) but is missing several early-error
rules from §15.2 / §15.4 (ImportDeclaration restrictions in nested
async/generator/await positions). The Stage-3 proposal grammar
(`import.source(...)`, `import.defer(...)`) is partially recognized
by the parser but its negative-test surface area is much larger than
the positive surface.

Sister issue #1435 covers general lexical/early-error gaps; this
issue is scoped to the dynamic-import / import-call sub-grammar so it
can land in parallel.

## Files to touch

- `src/compiler/early-errors.ts` — add 6–10 missing checks for
  `ImportCall` in nested contexts.
- `src/compiler/parser.ts` — for the contexts where the parser
  already detects the syntax but doesn't emit a SyntaxError, switch
  to an `early-error` diagnostic.
- `tests/test262-runner.ts` — verify the negative-test classification
  fires when the parser reports the expected error class.

## Acceptance criteria

1. ≥ 120 of 191 in `language/expressions/dynamic-import/syntax/` flip
   from `fail` to `pass`.
2. No new false-positives — existing `language/expressions/dynamic-import/{usage,namespace,assignment-expression}/` pass-counts must not drop.
3. The same fix surface improves `language/expressions/assignmenttargettype/direct-asyncarrowfunction-1.js` and
   `direct-yieldexpression-0.js` (same root cause).

## Reference tests

- `language/expressions/dynamic-import/syntax/nested-async-gen-await-typeof-import-source.js`
- `language/expressions/dynamic-import/syntax/nested-with-expression-import-call-unknown.js`
- `language/expressions/assignmenttargettype/direct-asyncarrowfunction-1.js`
