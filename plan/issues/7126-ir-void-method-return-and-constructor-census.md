---
id: 7126
title: "IR: value-less unannotated class methods resolve void; census of constructor/class blockers in test262 bodies"
status: done
sprint: current
created: 2026-10-22
updated: 2026-10-22
completed: 2026-10-22
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: feature
area: ir
goal: ir-full-coverage
parent: 7106
# 2026-10-22: +4 lines in resolveReturnType's void arm (methods join the function rule)
loc-budget-allow:
  - src/ir/select.ts
---

## Problem

The rc-3 task: `constructor-resolution-unsupported`, `class-member-unsupported`
and `class-projection-unsupported` were reported blocking ~18/200 test262
bodies on the IR stack. Find the largest exact cluster and make it
IR-claimable.

## Census (main `b64438ca`, standalone, N=200 SEED=7; repeated N=300 SEED=13 on #6829's head)

On main every `<module-init>` is refused at its first statement (198/200 at
the harness's `assert`), so the per-statement blockers were measured with a
local diagnostic patch (not committed) that keeps evaluating the remaining
test-body statements.

| Cluster (test bodies) | Rows | Where it belongs |
|---|---|---|
| `new Test262Error(...)` in the body / harness (`verify*`, `isConstructor`, `thrower`) | all 173 harness `constructor-resolution-unsupported` rows; 6 bodies | #6829 (S3c). On its head the harness rows are gone; bodies that use `eval` keep refusing on purpose (S3c stands down when runtime eval may share the realm). |
| `var C = class { … }; new C().method(…)` | 7 bodies (SEED 7), 7 + ~20 cascades (SEED 13) | Not reachable: the `var` is refused first (#6835 opens `var`), and **module-level class expressions are not prepared at all**. `boundedClassExpressionBindingHasOnlyStaticConstructionUses` only admits a `const` class expression inside a function body. The methods also need destructuring params and generators. |
| `class C { method([x = 23]) {…} }; new C().method(…)` (statements/class/dstr) | 3 + 3 static | The class shape (`buildIrClassShapes`) drops the whole class for a binding-pattern / initializer / any-typed parameter, and plain `function f([x = 23])` is refused too (`destructuring-param-complex`). |
| `new Temporal.X(…)`, `new ShadowRealm()` | 8–19 | Not supported on standalone; no point admitting. |

None of the constructor clusters is an exact, small, non-overlapping slice
today.

## Change

While walking the class rows, one exact blocker showed up under every class
method: an unannotated method whose body never returns a value was refused
as `return-type-not-resolvable (lattice=absent)`. The equivalent function
declaration is already resolved `void` (#7106), because legacy registers the
checker's `void` with no result. Methods never carry a lattice entry, so they
never reached that arm. `resolveReturnType` (`src/ir/select.ts`) now applies
the same value-less-body arm to `MethodDeclaration`. A method that returns a
value still has no lattice fact and stays refused.

## Measured

- Unit test `tests/issue-7126-void-method-return.test.ts`: IR body, legacy
  answer and node agree on standalone and gc (6 cases); 6/7 fail on base.
- Census N=200 SEED=7: `return-type-not-resolvable` 205 → 204. Legacy units and
  `ir_only_pass`-eligible rows are unchanged: the newly accepted methods hit
  the next gate (parameters, module-global writes).
- Conformance A/B, 40 random class tests with methods (standalone): 34 → 34
  pass, no row changed.

## What's left

1. **Class methods that write a module global** (`callCount = callCount + 1`,
   in nearly every class test) fail late with `source-global-outside-component`
   / class-layout `unplanned-abi-binding` in
   `src/ir/prepared-component-dependencies.ts`, even when `<module-init>` is IR
   and even for annotated TS methods (pre-existing). A plain function writing the
   same global is fine.
2. **Module-level class expressions** (`var/let/const C = class {…}`) need a
   preparation path. Today only function-local `const` class expressions are
   prepared.
3. **Class shape for JS methods**: any-typed and destructuring parameters drop
   the whole class descriptor.
