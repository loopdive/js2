---
id: 7468
title: "`byteLength` on an `any`-typed ArrayBuffer/TypedArray gives NaN (all lanes)"
status: ready
sprint: Backlog
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
goal: value-rep
related: [7435, 7467]
---

# #7468: dynamic `byteLength` reads give NaN

## Problem

```js
const b: any = new ArrayBuffer(8);
b.byteLength; // node: 8
const f: any = new Float64Array(2);
f.byteLength; // node: 16
```

- **gc, standalone and wasi:** both reads give `NaN`. Main was the same before and after PR #7426 ([#7435](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7435-optional-chain-arraybuffer-typedarray-length-reads)).
- **Cause, as traced while fixing #7435:**
  - the dynamic member read gets only the value, so it must recognise the buffer kind at run time;
  - a `Float64Array` and a `number[]` share the same WasmGC array type, so the read cannot tell them apart.

This is a representation issue, not an optional-chain one.

## Acceptance criteria

- The dynamic `byteLength`, `byteOffset` and `length` reads on ArrayBuffer and TypedArray values match node on all three lanes.
- Dynamic reads on plain arrays are unchanged.
- The plan names the run-time tag the fix relies on. It either reuses an existing brand or explains why a new one is needed.
