---
id: 7260
title: "IR move-only scan: statement-position element store on a dynamic local receiver (#7250 rule a)"
status: in-progress
sprint: current
created: 2026-11-06
updated: 2026-11-06
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
parent: 7250
depends_on: [7258]
related: [2949, 3795, 3797, 7106]
assignee: "ttraenkler/c-r7"
loc-budget-allow:
  # 2026-11-06 (#7258, restated so the grant does not strand once #7104 lands):
  # one `concreteResultRecoversDynamic` helper plus a `coerceReturnValue` arm.
  - src/ir/select.ts
  - src/ir/from-ast.ts
  # 2026-11-06 (#7260): one selection option and one lowering option, which
  # carry the function-code strictness fact. Both have to sit next to their
  # siblings in the two option lists; they cannot move to another module.
  - src/ir/integration.ts
  - src/codegen/index.ts
func-budget-allow:
  # 2026-11-06 (#7260): +1 line in each option-list literal (same reason).
  - src/ir/integration.ts::compileIrPathFunctions
  - src/codegen/index.ts::planIrOverlay
---

# IR move-only scan: statement-position element store on a dynamic local receiver

## Problem

Rule (a) of [#7250](7250-ir-property-helper-dynamic-carrier-locals.md):
propertyHelper.js's `isWritable` stores `obj[name] = newValue` (inside `try`)
and `obj[name] = oldValue`, where `obj` and `name` are dynamic parameters and
`newValue`/`oldValue` are dynamic locals. The move-only scan admitted a
dynamic store only for two narrow families:

- #3797 needs ambient `this` and a stable-call root;
- #3795 needs a dynamic receiver and key, with the RHS a widened string local
  or `"true"`.

## Measurements (step 1, before code; base = #7258 head `ed947526`)

Probe (standalone, `JS2WASM_IR_SHAPE_DIAG=1`). Every dynamic-receiver store
was refused with `move-only[concrete]` on the LHS:

| shape | base |
| --- | --- |
| `obj[name] = v` (dyn key, dyn value) | refused |
| `obj[name] = 1` / `= "x"` (concrete value) | refused |
| `obj["k"] = v`, `obj[0] = v` (literal key) | refused |
| `try { obj[name] = v } catch (e) {}` | refused |
| `obj.k = v` (dot store) | refused |
| `return obj[name] = v` / `obj[name] += v` | refused (`expr-binary-op-*`, shape rule) |

Lowering contract:
- The canonical provider already exists: `dyn.member_set`, whose `sloppy`
  flag matches legacy's `__extern_set` (sloppy) vs `__extern_set_strict`.
  Legacy picks one from `isStrictContext` (`compileElementAssignment`).
- The only missing input was the function code's strictness. The lowering
  knew it only for self-guarded constructors (`ambientThisStrict`).

So (a) is an admission under the existing contract, plus one fact plumbed
through. Neither a new instruction nor a new import is needed.

## Implementation Plan

- `src/codegen/ir-dynamic-construct.ts`: `irFunctionCodeStrictness(ctx, fn)`
  (`isStrictFunction`). `irFunctionThisStrictness` now reuses it.
- `src/ir/integration.ts`:
  - the lowering gets `functionCodeStrict` for every top-level function;
  - both selection-option lists (with `src/codegen/index.ts`) set
    `lowersFunctionCodeStrictness: true`.
- `src/ir/from-ast.ts`:
  - `cx.functionCodeStrict` comes from the new `functionCodeStrict` option,
    not from `ambientThisStrict` (the same value where both are set);
  - one `lowerDynamicStoreOperand` boxes a concrete key or value onto the
    carrier (`boxConcreteToDynamic`). It replaces the element store's
    `"true"`-only arm and the property-write arm's copy of the same boxing;
  - the element store passes `sloppy = functionCodeStrict === false`.
- `src/ir/select.ts`: the #3797 statement-store arm also admits
  `dynamicLocalElementStoreIsLowerable`: an element store whose receiver is
  an identifier, in a top-level function declaration, when the lowering is
  told its strictness. The arm's existing key check (literal or dynamic
  name) and value check (dynamic or boxable) apply unchanged.
- Out of scope, still refused: dot stores on a dynamic local, assignment as a
  value, compound stores, optional stores.

Code-quality acceptance: one shared boxing helper (two copies removed); the
strictness fact has one source (`irFunctionCodeStrictness`); the store reuses
the existing arm, with no sibling arm added.

## Acceptance criteria

- `tests/issue-7260-ir-move-only-dynamic-key-store.test.ts`: `put` is
  IR-emitted, and the sloppy (frozen store ignored) and strict (TypeError)
  fixtures pass through the test262 runner. Dot, value and compound stores
  stay refused.
- Typed corpus byte-identical on gc/standalone/wasi.
- Wrapped ledger: 0 invariants, compileOk not lower.
- Standalone test262 A/B on route-changed files plus 300 random: no
  pass→fail, no new trap.
