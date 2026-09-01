---
id: 5177
title: "Map.prototype.forEach silently corrupts non-numeric keys to NaN when the entries literal infers Map<number, number>"
status: ready
sprint: current
created: 2026-08-29
updated: 2026-08-29
priority: medium
horizon: l
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [3481, 2949]
---

# Silent key corruption — the loud Symbol throw is the visible tip

Found and measured during the #3481 Map-sub-family re-diagnosis (PR #5198),
where the filed "statically-symbol keys" cause was refuted. The real mechanism,
measured on base:

- `new Map([[4, 4], ['foo3', 3], [s, 2]])` is inferred **by TypeScript
  itself** as `Map<number, number>` (heterogeneous entries literal).
- The `forEach` callback's parameters therefore lower to `f64`, and the
  WebAssembly JS API's own argument coercion applies ToNumber to whatever the
  host passes: a **Symbol key throws** (the loud case #3481 tracked), a
  **string key silently becomes `NaN`** — `'foo3'` reads back as `NaN`, no
  throw, no diagnostic.
- Control: binding the callback to a `var` first makes all three test262 rows
  pass; `Map<any, any>` annotation also works (union lowers to `externref`).

**A representation-only fix was built, measured, and REVERTED in PR #5198**:
widening the callback's parameter representation to `externref` for `Map`/`Set`
`forEach` fixed shapes where the parameter is never stored, but flipped zero
test262 rows — the row bodies do `results.push({value, key})` and the object
literal's field types re-narrow to `f64` from the same TS types (confirmed in
WAT: `struct.new` with `__unbox_number` on both fields). What it actually
needs: the parameters must be `any` in the **type system** — a node-level
dynamic-parameter override consulted by every site deriving a representation
from `getTypeAtLocation`. That is design-adjacent to #2949 (dynamic value
representation) but is not the same work; do not fold it in without measuring.

Full evidence: PR #5198's "Map rows — re-diagnosed" section and the #3481
issue file's updated record.

## Acceptance criteria

- `new Map([[4,4],['foo3',3]]).forEach((v,k) => …)` observes the string key
  `'foo3'` (not `NaN`), and the Symbol-key case stops throwing, in the gc
  lane; the three #3481 Map test262 rows flip or their residual is re-measured
  and recorded.
- No blast-radius regression: the reverted-fix lesson means the change must be
  validated on shapes that STORE the callback parameters, not only pass-through
  shapes; byte-identity for programs without `Map`/`Set` `forEach`.
- Pinned tests red on base; equivalence shards clean by name.
