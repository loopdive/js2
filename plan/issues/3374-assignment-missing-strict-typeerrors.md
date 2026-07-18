---
id: 3374
title: "Assignment semantics: strict invalid writes fail to throw TypeError"
status: done
created: 2026-07-17
updated: 2026-07-17
completed: 2026-07-17
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: assignment, strict-mode, property-descriptors
goal: test262-conformance
assignee: codex/root
related: [3362, 3365]
files:
  - src/codegen/expressions/assignment.ts
  - src/runtime.ts
oracle-ratchet-allow:
  # Binding-identity scans are outside TypeOracle's type-query boundary.
  - src/codegen/expressions/assignment.ts
  - src/codegen/property-access.ts
---

# #3374 — strict assignment writes do not throw

## Problem

Seven tests in the original-harness assignment sample reach the real upstream
`assert.throws(TypeError, ...)` but no exception is thrown:

- `language/expressions/assignment/11.13.1-1-s.js`
- `language/expressions/assignment/11.13.1-2-s.js`
- `language/expressions/assignment/11.13.1-3-s.js`
- `language/expressions/assignment/11.13.1-4-14-s.js`
- `language/expressions/assignment/11.13.1-4-28gs.js`
- `language/expressions/assignment/11.13.1-4-29gs.js`
- `language/expressions/assignment/11.13.1-4-6-s.js`

## Acceptance criteria

- Fetch and cite the relevant `PutValue` / property `[[Set]]` strict-mode
  steps for each addressed receiver class.
- Add minimal regressions that distinguish strict throws from sloppy no-ops.
- Move the sampled missing-throw cases without changing successful writable
  assignments.

## Implementation summary

Assignment lowering now carries the actual source strictness into static and
dynamic property writes. The host bridge has an explicit strict setter path,
and native property lowering checks failed writes to read-only data
properties, getter-only accessors, and non-extensible objects. Strict writes
throw a branded `TypeError`; the corresponding sloppy writes remain no-ops.

This implements the failure handling required by
[ECMA-262 `PutValue`](https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html#sec-putvalue)
and the receiver/property rules in
[`OrdinarySetWithOwnDescriptor`](https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-ordinarysetwithowndescriptor).

### Verification

- `tests/issue-3374.test.ts`: strict/sloppy coverage for dot, bracket,
  descriptor, accessor, and non-extensible writes passes.
- Original harness: all seven sampled missing-throw tests pass.
