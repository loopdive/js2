---
id: 7474
title: "Fold the inlined argument-vector length/element reads into argumentVectorLength / argumentVectorElement"
status: ready
sprint: Backlog
created: 2026-11-26
updated: 2026-11-26
priority: low
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: refactor
area: runtime
goal: ir-full-coverage
depends_on: [7377]
related: [7354, 7377]
origin: "2026-11-26 RV7428 review of #7377: the accessor set it added is not yet used by every body that reads the vector"
---

# #7474: one accessor set for the realm argument vector

## Problem

[#7377](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7377-prepared-for-in-over-dynamic-objects) added
`argumentVectorLength`, `argumentVectorElement` and `argumentVectorEach` to
`src/runtime/wasmgc/values/argument-vector-bodies.ts`, and moved descriptors-define and for-in-keys onto them. Three
bodies still spell the same reads inline (`struct.get` of field 0 for the length, then field 1 with `array.get` for an
element):

- `src/runtime/wasmgc/values/builtin-function-bodies.ts` ~L401: the builtin argument read;
- `src/runtime/wasmgc/values/function-prototype-invoker-bodies.ts` ~L59–109: `readArgument` and its siblings;
- `src/runtime/wasmgc/values/closure-vector-apply-body.ts` ~L159: the apply length and element reads.

## Done when

- The three bodies build their reads with the shared accessors. A nullable vector local keeps its `ref.as_non_null`
  at the call site, or the accessor takes it as an option if more than one site needs it.
- The emitted instructions are unchanged. The proof is `scripts/prepared-byte-identity.mts` (804 programs) and the
  13 playground examples × default/standalone, all byte-identical.
- No growth grant.
