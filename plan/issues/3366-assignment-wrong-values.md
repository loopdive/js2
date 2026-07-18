---
id: 3366
title: "Assignment semantics: undefined/null and property descriptor write values are incorrect"
status: done
created: 2026-07-17
updated: 2026-07-17
completed: 2026-07-17
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, value-representation
language_feature: assignment, destructuring, property-descriptors
goal: test262-conformance
assignee: codex/root
related: [3362]
files:
  - src/codegen/expressions/assignment.ts
  - src/codegen/destructuring.ts
  - src/runtime.ts
---
# #3366 — assignment produces wrong values

## Problem

Three original-harness tests fail value assertions:

- `annexB/language/expressions/assignment/dstr/array-pattern-emulates-undefined.js`
- `annexB/language/expressions/assignment/dstr/object-pattern-emulates-undefined.js`
- `language/expressions/assignment/11.13.1-4-1.js`

The Annex B cases observe `null` where the emulated-undefined value should be
`undefined`. The descriptor case observes `undefined` where the assigned data
property should contain `42`.

Initial diagnosis found that the original host shim omitted `$262.IsHTMLDDA`.
Adding a callable identity sentinel removes the missing-property/null artifact
but exposes a real callable-value transport defect: array destructuring stores
`undefined` instead of the function-valued sentinel. The fix must retain the
sentinel identity through both array and object destructuring; implementing
the complete Annex B falsy/`typeof`/abstract-equality semantics is out of this
slice's scope.

## Acceptance criteria

- Fetch and cite the relevant destructuring/default and ordinary assignment
  algorithms.
- Add focused regressions for both value-representation clusters.
- Correct all three sampled values without changing nullish/default behavior
  elsewhere.

## Implementation summary

Array literals and destructuring targets can now retain callable/dynamic
values instead of collapsing them to the nullish representation. Destructured
module globals are synchronized, sloppy unresolved identifier writes are
routed to the host global object, and values written through dynamic member
sidecars are read back through the same representation. That preserves the
identity-only IsHTMLDDA sentinel and makes the implicit global data property
observable through `Object.getOwnPropertyDescriptor`.

The default branch continues to run only when the extracted value is
`undefined`, as required by
[ECMA-262 Iterator Destructuring Assignment Evaluation](https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-runtime-semantics-iteratordestructuringassignmentevaluation),
while unresolved sloppy writes follow
[`PutValue`](https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html#sec-putvalue).

### Verification

- `tests/issue-3366.test.ts`: callable destructuring, dynamic member
  round-trip, and implicit-global descriptor cases pass.
- Original harness: all three sampled wrong-value tests pass.
