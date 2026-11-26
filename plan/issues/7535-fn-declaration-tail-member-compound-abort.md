---
id: 7535
title: "A member compound as a function declaration's last statement becomes an abort body"
status: ready
sprint: Backlog
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: ir
goal: ir-full-coverage
depends_on: [7354]
related: [7492]
origin: "2026-11-26 RV7491 review of #7354 O7 (finding F5); pre-existing, not an O7 regression"
---

# #7535: a function declaration's tail member compound aborts

## Problem

On the Prepared path, a member compound or update is lowered by the statement path
(`lowerAdoptedMutatingStatement` → `lowerPropertyCompound`; O7 added the dynamic arm), unless it is the **last
statement of a function declaration**:

```js
function f(q) { q.x += 1; }   // abort body: "binary operator '+=' is capability-deferred"
function g(q) { q.x += 1; return; }   // runs
```

The tail statement goes down the void-tail path (`lowerTail`) to `lowerBinary`, which defers a member compound. So the
function's body is the run-time abort, though the same statement anywhere else lowers. A function expression takes the
statement path, so the 22 rows of #7354 O7 are not affected. This was an abort before O7 too.

## Coordination

S21's [#7492](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7492) is rewriting `lowerTail` and the void-tail
path. This issue is taken after #7492 lands, or folded into it: the tail must route an expression statement it
does not lower itself to the same mutating-statement dispatcher (`lowerAdoptedMutatingStatement`) that non-tail
positions use. It must not grow a second compound lowering.

## Done when

- `function f(q){ q.x += 1; }` and `function f(q){ q.x++; }` on the Prepared path agree with node, each with a wrong
  twin, on a dynamic receiver (O7's arm) and on a typed object receiver.
- The ordinary pipeline's output is byte-identical.
