---
id: 3416
title: "Literal TypedArray factory flow loses callable and dynamic-value identity"
status: done
created: 2026-07-18
updated: 2026-07-18
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler, codegen, runtime
language_feature: function-bind, closures
goal: test262-conformance
assignee: codex/root
related: [3140, 3088, 3412]
files:
  - src/codegen/statements/variables.ts
  - src/codegen/expressions/new-super.ts
  - src/runtime.ts
  - tests/issue-3416.test.ts
---

# #3416 — preserve dynamic factory values through host interop

## Problem

In the literal TypedArray harness, `argFactory` is a compiled function loaded
from a heterogeneous array and then bound to a constructor. The compiler tried
to recast that externref to the first structurally compatible closure layout;
another valid layout became null, so host `bind` reported a non-callable value.

After preserving ambiguous values as externref, later factories exposed two
more premature static decisions: JSDoc types the callback constructor as broad
`Function`, and untyped helper parameters may contain an ArrayBuffer, iterable,
array-like object, or numeric length. The host lane must use the runtime
constructor value and overload rather than inventing an extern class or a
zero-length native view. Compiled array-like object literals must also cross as
live property proxies, not be mistaken for empty vecs.

## Acceptance criteria

- Heterogeneous factory-array reads retain the actual callable layout.
- A broad `Function` constructor parameter uses the runtime constructor value.
- Host TypedArray construction over `any`/`unknown` selects its overload from
  the runtime value and preserves ArrayBuffer byte sharing.
- Compiled array-like objects retain `length` and indexed properties at the
  host constructor boundary.
- The literal `subarray/minus-zero.js` factory matrix passes unchanged.

## Resolution

Ambiguous closure recasts now remain externref, dynamic constructors recognize
the broad `Function` interface, and JS-host TypedArray construction defers
`any`/`unknown` overload selection to the host. Runtime marshalling positively
identifies vecs and proxies data structs as array-like objects.

Verified by four focused interop tests plus the exact literal Test262 file. The
five-file maintained-runner batch and the FYI original-harness lane both pass
5/5 (up from 2/5).
