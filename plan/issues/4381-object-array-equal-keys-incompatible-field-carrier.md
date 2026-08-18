---
id: 4381
title: "Object arrays with equal keys reuse an incompatible nested-field carrier"
status: done
sprint: 78
created: 2026-08-12
updated: 2026-08-18
completed: 2026-08-12
priority: high
horizon: s
feasibility: high
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: arrays, object-literals
goal: npm-library-support
assignee: ttraenkler/codex
related: [3995, 4289]
files:
  - src/codegen/literals.ts
  - tests/issue-4289-heterogeneous-object-array-carrier.test.ts
---

# Object arrays with equal keys reuse an incompatible nested-field carrier

## Problem

The #4289 selector widened object-literal arrays only when the objects have
different property names. It still selects the first object's closed WasmGC
struct when every outer object has the same names but a field has a different
representation, for example:

```js
[
  { type: "text/plain", params: {}, q: 1 },
  { type: "text/html", params: { charset: "utf-8" }, q: 0.9 },
]
```

The second `params` object cannot inhabit the first element's `params` field
carrier. A dynamic numeric read of element 1 therefore loses that nested value.
Hono's original `parseAccept` tests expose this through their recursive deep
equality comparison: each result object is correct when read at a statically
known position, while the same values fail through the generic array index.

## Measured baseline

- Hono original selected suite: **25/31 Wasm, 31/31 Node**.
- Three failures are `utils/accept.test.ts` cases whose direct parser output is
  correct but whose generic recursive comparison observes the corrupted nested
  `params` value.
- The other three Hono failures are MIME/undefined and dynamic-object-read gaps
  and are not claimed by this issue.

## Acceptance criteria

- [x] Object-literal arrays select the first closed struct only when every
      element can inhabit that exact field carrier, not merely when keys match.
- [x] A reduced dynamic-index regression preserves a later element's nested
      object value.
- [x] The existing heterogeneous and homogeneous #4289 controls keep passing.
- [x] The unchanged Hono original upstream suite improves from 25/31 to 28/31,
      with all three `parseAccept` cases passing and no withdrawals.

## Result

The carrier fix produced the expected 25/31 to 28/31 improvement. Two adjacent
generic fixes then made JavaScript closure fallthrough return real `undefined`
and kept untyped object-default parameters structurally open. The unchanged
selected Hono suite now passes **31/31** in Wasm and **31/31** in Node.
