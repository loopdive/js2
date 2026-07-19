---
id: 3470
title: "Host Iterator helpers must drive native generator frames"
status: done
created: 2026-07-19
updated: 2026-07-19
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, runtime, test262
language_feature: Iterator helpers, generators, destructuring
goal: test262-conformance
related: [713, 1367, 1665, 2903, 3049]
---
# #3470 — Host Iterator helpers must drive native generator frames

## Problem

The literal Test262 FYI harness exposed eleven Iterator-helper failures that
the project runner's transformed source did not. A statically typed generator
is represented as an opaque native Wasm state struct, while Node's original
`Iterator.prototype` methods require a JavaScript IteratorRecord with a
callable `next` method. Calls therefore failed as “not a function”. Four lazy
`drop` tests additionally failed compilation because their dynamic
`IteratorResult` was carried as an abstract `anyref` that object destructuring
did not accept.

The native-generator host fallback also treated an own `value: undefined` as a
missing property and replaced it with the Wasm shape-miss value `null`.

## Resolution

- Export the existing native generator iterator steppers on demand and adapt
  them to a spec-shaped host IteratorRecord.
- Resolve the real host Iterator helper from `%Iterator.prototype%`; do not
  replace the helper algorithm or modify Test262.
- Route abstract `anyref`/`eqref` object-destructuring sources through the
  established externref property path.
- Use property presence when reading host IteratorResult values so an explicit
  `undefined` remains distinct from a missing Wasm field.

`test262-fyi/data` and the Test262 corpus remain unchanged.

## Acceptance criteria

- The eleven FYI-only Iterator helper failures pass with the original harness.
- Native generator frames are stepped through the shared generator resume
  machinery while Node executes the actual Iterator-helper algorithm.
- Lazy helper results can be object-destructured without a compile error.
- An exhausted helper result preserves `value: undefined`, not `null`.

## Validation

- `pnpm exec vitest run tests/issue-3470.test.ts tests/issue-713.test.ts tests/issue-3049.test.ts tests/issue-1367.test.ts tests/issue-1665.test.ts`
- `pnpm run build:test262-bundles`
- `node scripts/run-test262-fyi.mjs --paths-file /private/tmp/iterator-3470-paths.txt --workers 1`

The exact original-harness Iterator batch passes 11/11.
