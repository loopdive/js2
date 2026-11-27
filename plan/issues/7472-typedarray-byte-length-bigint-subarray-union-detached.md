---
id: 7472
title: "TypedArray byteLength wrong on BigInt64Array, subarray and TypedArray unions; ?.length on a detached TypedArray reads 8 (legacy)"
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
related: [7435, 7467, 7468]
---

# #7472: TypedArray byteLength gaps outside the optional chain

## Problem

RV7426 found these while reviewing PR #7426
([#7435](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7435-optional-chain-arraybuffer-typedarray-length-reads)).
Each one fails the same way on main without that PR, and each is a plain
read, not an optional chain:

- `byteLength` is wrong (node's value differs) on:
  - a `BigInt64Array`;
  - a view from `subarray(...)`;
  - a value typed as a TypedArray union (`Uint8Array | Float64Array`).
- `?.length` on a detached TypedArray reads `8`; node reads `0`.

The `any`-typed case is #7468 and is not part of this issue.

## Acceptance criteria

- A pin test checks each case on gc, standalone and wasi against node's answer
  and fails on main.
- The fix extends the existing buffer-view attribute arm
  (`tryBufferViewAttributeReads`, `src/codegen/property-access.ts`) and adds
  no second arm.
- Output bytes are unchanged for programs without these reads.
