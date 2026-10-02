---
id: 6804
title: "codegen-linear: `arr.push(a, b)` appends each argument right after evaluating it, so a later argument that mutates the receiver interleaves with the append"
status: ready
sprint: Backlog
created: 2026-10-01
updated: 2026-10-01
priority: low
horizon: s
feasibility: easy
reasoning_effort: low
task_type: bug
area: codegen-linear
language_feature: arrays
goal: core-semantics
related: [6787, 3332, 1938]
requested_by: ttraenkler/claude-review
origin: "noted by inspection in the #6787 implementation (2026-10-01); linear lane not run"
---

# #6804 — linear `push` ordering (by inspection; verify first)

`src/codegen-linear/index.ts:3701-3725`: the `push` lowering evaluates the
receiver once into a local, then for **each** argument emits
`local.get arr; <arg>; call __arr_push`. §23.1.3.23 evaluates all arguments
before the first `Set`: for `a.push(1, (a.push(9), 2))` JS evaluates `1` and
`(a.push(9), 2)` first, so the receiver is `[…, 9]` when the outer push starts
and the result is `[…, 9, 1, 2]`. The linear lowering appends `1`, then runs
the second argument (appending `9`), then appends `2` → `[…, 1, 9, 2]`.

Unverified (the #6787 agent did not run the linear lane): confirm with the
linear harness (`tests/linear-*.test.ts` show how to instantiate a WASI/linear
module) before fixing.

## Correction

Evaluate every effectful argument into a local first (the same
`planCallArgs` discipline as #6787, ported or re-implemented on the linear
side), then emit the appends. Pure arguments (literals, locals) keep the
current single-pass shape.

## Acceptance

- `a.push(1, (a.push(9), 2))` → `[…, 9, 1, 2]` on the linear lane; returned
  length matches.
- A linear-lane row in `tests/equivalence/array-push-reentrancy.test.ts` or a
  new `tests/linear-push-arg-order.test.ts`.
