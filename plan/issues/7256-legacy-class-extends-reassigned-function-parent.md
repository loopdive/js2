---
id: 7256
title: "Legacy miscompile: a class extending a function constructor that is later reassigned (`F = G`) gives NaN"
status: ready
sprint: Backlog
created: 2026-11-06
updated: 2026-11-06
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: correctness
related: [7244, 7092, 3123]
---

# #7256: `class X extends F` with `F = G` reassigned later

Found in the #7244 review (PR #7092, comment 6672047766). Same on base and
head on all 3 lanes, so #7244 does not change it; it is a legacy (fnctor
subclass, #3123) miscompile.

```js
function F() { this.a = 70; }
function G() { this.a = 1; }
class X extends F { m() { return this.a + 2; } }
F = G;
export function test() { return new X().m(); }   // node: 3 (X was bound to F's value at class evaluation: 72)
```

Node gives 72 (the class captured the original `F`); js2 gives NaN on gc,
standalone and wasi. Legacy resolves the parent by name at every `super()` /
field lookup instead of binding the parent value once at class evaluation.

**Fix direction:** bind the heritage value at class-evaluation time (a hidden
module global holding the parent's function value), the way the `extends`
expression semantics require; or refuse (compile error) when the parent
identifier has a write anywhere in the file, which is what the IR shape
predicate (#7244, `irClassHeritageIsRootStruct`) should also check.

**Test:** `tests/equivalence/issue-7256-*.test.ts` on 3 lanes asserting node's
value or a compile-time refusal, never NaN.
