---
id: 7132
title: "IR: a heterogeneously assigned script var binds to legacy's externref slot (census step 3)"
status: in-review
sprint: current
created: 2026-10-22
updated: 2026-10-22
priority: high
horizon: s
feasibility: medium
reasoning_effort: max
task_type: feature
area: ir
goal: ir-full-coverage
parent: 7106
assignee: "ttraenkler/session-d"
depends_on: [7130]
# 2026-10-22 (#7132): the dynamic-home bypass of the heterogeneous-retype
# refusal, and the typed stub for an orphaned lifted-closure slot.
loc-budget-allow:
  - src/ir/module-bindings.ts
  - src/ir/integration.ts
---

# IR: a heterogeneously assigned script var binds to legacy's externref slot

Parent: [#7106](7106-ir-test262-harness-units.md). This is step 3 of the
integrated-stack census of 2026-10-22, the
`vardecl-module-storage-unrepresentable` class. It blocks the test body in 103
of the 266 sampled files, and the harness prelude in 49.

## Problem

A script `var` whose assignments disagree is refused as
`vardecl-module-storage-unrepresentable`. Examples are `var got = 0;` followed
by `got = n` from a closure parameter, and `var x = 0; x = "s"`.

The module-binding resolver rejects every heterogeneously assigned binding
(`heterogeneousAssignmentRetypesModuleBinding`, from #4204/#4206). It does this
before it consults `scriptVarSlotIsDynamicHome`, even when the slot is
already a dynamic home.

## How legacy chooses the slot (measured)

For each of these shapes, legacy allocates `(global $__mod_<name> (mut
externref) (ref.null extern))`:
- a number initializer, then a dynamic write;
- a string initializer, then a dynamic write;
- a number initializer, then a string write.

Measured on standalone and on gc via `scriptVarSlotIsDynamicHome`, which
reads the allocated global.

Off fast mode, externref is exactly the IR's dynamic carrier
(`resolveIrDynamicCarrierType`).

## Fix

**Resolver (`src/ir/module-bindings.ts`).** A script `var` whose slot codegen
reports as externref (`isScriptDynamicHome`) skips the heterogeneous-retype
refusal and resolves as `dynamic`, on the slot legacy chose.
- No other representation is picked.
- Module-goal bindings, and fast mode, are unchanged.
- The shared-realm runtime-eval mode still stands down: `scriptVarHomeSlot`
  returns nothing there, as in #6835.

**Integration (`src/ir/integration.ts`), orphaned slot.** Making more
module-inits claimable exposed a hard compile failure that was already
reachable on the stack. The failing shape:
- a `<module-init>` holds a planned member closure;
- one of its callees withdraws on ABI parity, and the cascade fails
  `<module-init>` after lowering;
- the closure's fresh slot is left with its allocation placeholder type,
  `$__vec_base`.

Program-ABI planning then rejected the whole module with "retained function
`<module-init>`__closure_0 references non-function or missing type 0". The
orphan stub now gives such a slot the signature its body was lowered against,
with an `unreachable` body.

## Measured

`tests/issue-7132-script-var-dynamic-slot.test.ts`, on standalone and gc, compares
against node and against a legacy compile (`experimentalIR: false`).

- **Three shapes now lower as IR:** number then dynamic, string then dynamic,
  and number then string. In each `<module-init>` is IR, and a wrong
  expectation throws in IR, in legacy and in node.
- **Eval stand-down.** For an eval-visible `var`, both read and write,
  `<module-init>` stays legacy and agrees with node.
- **Parity-withdrawn callee.** The cascade now compiles and runs.

## Not taken: `throw 1` (`throw-value-unsupported`)

This is not small:
- `throw 1`, `throw 1.5` and `throw true` all refuse, in a lifted closure and
  in a top-level function alike ("throw val not in slice 9").
- The f64 box arm (`numericThrow: "number-boundary"`) is only projected on the
  program-source path, and its provider admission is a separate preparation
  decision.
- Booleans have no arm.
