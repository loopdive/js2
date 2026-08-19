---
id: 4380
title: "Empty-object widening skips IIFE function-expression bodies"
status: done
created: 2026-08-12
updated: 2026-08-18
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, standalone, object-representation
language_feature: object-literals, iife, arrow-functions
goal: deno-runtime
sprint: 78
es_edition: ES2015
assignee: ttraenkler/codex-v8x-js2wasm
related: [2937, 2944, 3364, 4376, 4378]
origin: "First executed runtime boundary in unchanged Deno core 00_primordials.js"
files:
  - src/codegen/declarations/object-shape-widening.ts
  - tests/issue-4380-empty-object-widening-iife-body.test.ts
loc-budget-allow:
  - src/codegen/declarations/object-shape-widening.ts
---
# #4380 — Empty-object widening skips IIFE bodies

## Defect

Deno creates its primordials object inside a top-level arrow IIFE:

```js
((globalThis) => {
  const primordials = {};
  primordials.uncurryThis = uncurryThis;
  // ...
})(globalThis);
```

The empty-object widening prepass recursively inspected named function
declarations, but skipped arrow-function and function-expression bodies nested
in ordinary statements. Codegen still inlined the IIFE body into module
initialization. A later destructuring read of the populated object made the
checker register its evolved anonymous shape, while the skipped initializer
had already selected the open-object carrier. The guarded cast stored null,
and the first property write trapped during module initialization.

This is independent of the value assigned to the property. The initially
suspected bound-function representation was a false lead: entering the IIFE
body in the existing widening analysis is sufficient to advance the unchanged
Deno bootstrap.

## Acceptance

- [x] Empty-object writes followed by Deno-shaped destructuring inside an arrow
      IIFE use a consistent representation and preserve their values.
- [x] The same shape inside a function-expression IIFE also works.
- [x] Ordinary named-function empty-object widening remains unchanged.
- [x] The standalone artifacts add no JavaScript-host imports.
- [x] The unchanged Deno primordials bootstrap advances to its next honest
      executed boundary.
