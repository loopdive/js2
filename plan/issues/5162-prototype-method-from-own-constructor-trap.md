---
id: 5162
title: "A prototype method called from its own constructor traps at runtime — plain numeric callee, all five boolean-ABI lanes, pre-existing"
status: ready
sprint: current
created: 2026-08-28
updated: 2026-08-28
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
goal: core-semantics
related: [4406, 4405]
---

# Constructor → own prototype method call traps

Found as a control during #4406 Phase 4 (PR #5171) and verified **unrelated to
that issue**: the failing callee is a plain numeric method, and the trap
reproduces identically on base in all five boolean-ABI lanes
(`JS2WASM_RET_UNBOX_ABI` on/off, `NUMERIC_TWINS=0`, `DIRECT_CALLS=0`,
`NUMERIC_OPERANDS=0`), so no #4406 switch reaches it.

Shape (from the Phase 4 probe set):

```js
function PP(x) { this.v = this.twice(x); }   // calls own prototype method
PP.prototype.twice = function (x) { return x + x; };
new PP(5);                                    // traps at runtime
```

The likely mechanism (unverified — the dispatched fix must establish it): at
the point the constructor body compiles, the prototype assignment has not been
processed, so the method-call lowering resolves against an incomplete
class/prototype view — the same family as #5096's scope-blind `ctx.classSet`,
but for compile-order rather than scope.

First step is a minimal repro matrix: method defined before vs after the
constructor in source order, `class` syntax vs prototype-assignment syntax,
gc vs standalone. That decides whether this is an ordering bug (fixable) or a
structural gap in the fnctor model (then route to the #3521/codex lane and
record — check the ledger before dispatch).

## Acceptance criteria

- The repro matrix measured and recorded; the shape above returns `10` via
  `new PP(5).v`, or the structural verdict is recorded with the owning issue
  cited.
- Byte-identity for constructors that do not call own prototype methods.
- Pinned tests red on base; equivalence shards clean by name.
