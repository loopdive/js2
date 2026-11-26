---
id: 7467
title: "`a?.buffer.byteLength` on a TypedArray gives NaN (legacy, all lanes)"
status: ready
sprint: Backlog
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7435]
---

# #7467: `a?.buffer.byteLength` gives NaN

## Problem

```js
var a = new Float64Array(2);
a?.buffer.byteLength; // node: 16
```

- **Legacy, gc, standalone and wasi:** gives `NaN`. Before PR #7426 ([#7435](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7435-optional-chain-arraybuffer-typedarray-length-reads)) it threw.
- **Cause, as traced while fixing #7435:**
  - the `.byteLength` read after `?.` sees the checker type `ArrayBuffer | undefined`;
  - the buffer-view attribute arms (`tryBufferViewAttributeReads` in `src/codegen/property-access.ts`) key on a non-union type name;
  - so the read falls through to the dynamic member read, which cannot see the computed accessor.

## Acceptance criteria

- `a?.buffer.byteLength` matches node on gc, standalone and wasi. The pin test fails on main.
- The fix strips the optional chain's `undefined` from the receiver type in the existing arm. It adds no second, union-aware arm.
