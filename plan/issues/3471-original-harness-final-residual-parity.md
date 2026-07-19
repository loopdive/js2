---
id: 3471
title: "Close final original-harness residuals in the FYI disagreement batch"
status: done
created: 2026-07-19
updated: 2026-07-19
completed: 2026-07-19
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen, runtime, testing
language_feature: javascript-inference, generators, regexp, property-descriptors
goal: test262-conformance
related: [2035, 3051, 3374, 3434, 3468, 3469, 3470]
---

# #3471 — close the final original-harness residuals

## Problem

After the systemic strict-delete, `Object.create`, and native-generator iterator
bridge fixes, four tests still failed only when compiled from test262.fyi's
literal source assembly:

- `built-ins/DataView/prototype/byteLength/name.js`
- `built-ins/GeneratorPrototype/return/from-state-completed.js`
- `built-ins/Object/isSealed/name.js`
- `built-ins/RegExp/prototype/Symbol.replace/get-unicode-error.js`

The first three exposed compiler assumptions hidden by the project's rewritten
harness. The RegExp case exposed a host-version protocol difference: current
Test262 expects `@@replace` to derive its mode from `Get(rx, "flags")`, while
Node 24's native implementation reads `global` and conditionally `unicode`.
The FYI data and tests must remain unchanged.

## Resolution

- Unannotated JavaScript parameters no longer infer a concrete type from one
  numeric-looking body branch. Call-site specialization is retained when all
  observed JavaScript arguments are concrete and agree. This keeps generic
  `propertyHelper` SameValue checks dynamic without disabling ordinary numeric
  JS specialization.
- Native generator-result `.value` reads preserve the completed-result
  `undefined` sentinel for unannotated JavaScript. Explicitly numeric TypeScript
  iterator consumers retain the f64 fast path.
- `RegExp.prototype[Symbol.replace]` is capability-gated. Current hosts use the
  native algorithm unchanged; older hosts pre-coerce the input/replacement,
  read `flags` once, and temporarily provide the derived legacy
  `global`/`unicode` values so user accessors are not read twice.

No source, metadata, harness, or test under `test262-fyi/data` is modified.

## Validation

- Focused Vitest suites: 46/46 pass (`issue-3374`, `issue-3032-w6`, `issue-3051`).
- TypeScript no-emit check passes.
- Exact original-harness residual rerun: 4/4 pass, up from 0/4.
- Full historical FYI-only disagreement sample: 929/1026 pass directly on the
  local Node 24 / Unicode 16 host. All 97 non-passes are host capability gaps:
  84 Unicode 17 RegExp-data cases and 13 newer `Uint8Array` base64/hex API
  cases. After separating those host-version cases, the compiler/harness gap is
  0/1026.
