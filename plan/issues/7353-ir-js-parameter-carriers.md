---
id: 7353
title: "IR: JavaScript parameter carriers — one family and one carrier for an untyped parameter"
status: ready
sprint: current
created: 2026-11-16
updated: 2026-11-16
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: []
related: [7349, 7350, 7352, 7342]
loc-budget-allow:
  # 2026-11-19 (slice 3, WIP): the storage rule for a JSDoc type literal sits
  # beside `parameterMayBeOmitted`, the sibling rule `lowerParamType` asks.
  - src/codegen/declarations.ts
---

# #7353 — IR: JavaScript parameter carriers

## Problem

Program goal: every ES5 test262 file compiles on `--target standalone` with
zero legacy units ("IR-only").

An untyped JavaScript parameter is a dynamic value, but four places disagree
about that. Found 2026-11-16 while measuring why the `propertyHelper.js`
harness stays on the legacy compiler (main `8045884222`, standalone; each
reproduced with a small program except the last):

1. **A member read on a dynamic parameter has the operand family `unknown`,
   not `dynamic`.** `function f(d, o) { if (d.e !== g(o)) … }` is refused as
   `expr-binary-operand-families` (`verifyProperty`, line 106 of the harness:
   `desc.enumerable !== isEnumerable(obj, name)`).
2. **The move-only scan refuses a dynamic parameter inside `&&` / `||` next
   to a function value** (`options && options.verifyProperty ||
   verifyProperty`).
3. **A JSDoc type literal (`@param {{…}} desc`) types the parameter for the
   checker, and the IR has no type for it** (`param-type-unresolved`).
   Admitted, it fails at resolve with `JSDocTypeLiteral`.
4. **Legacy gives a parameter a type refined from its call sites**, so the
   IR's dynamic carrier does not match
   (`param-dynamic-carrier-diverges-from-legacy`). Admitted, the unit is
   withdrawn after the claim on a function-type parity mismatch.

## Measured

- In the `propertyHelper.js` harness (compiled with `assert.js` and `sta.js`
  and an empty test body), 7 of 25 units are legacy; four of them carry one
  of the refusals above.
- 905 ES5 test262 files include that harness. With this issue, #7350 G1+G4,
  #7349 S1a and #7352 (object literals as open objects, an empty array
  escaping into a bound built-in call) all in place, 151 of them become
  IR-only; the other 748 have refusals of their own (first label:
  `vardecl-module-storage-unrepresentable` 194, `expr-ident-not-in-scope`
  138, a non-identifier callee 110, move-only 115, `vardecl-let-closure` 67,
  `expr-object-static-descriptor` 56).
- **Not measured:** how many files outside this harness each of the four
  points blocks. On its own this issue is estimated to free 0 files, because
  the harness needs every leg.

## Implementation Plan

### Step 0: measure before slicing

From a fresh full ES5 census on current main, count per point the files that
carry it and the files where it is the only remaining family
(`expr-binary-operand-families` with a member read on a dynamic value,
`move-only[…]`, `param-type-unresolved`, `param-dynamic-carrier-diverges-from-legacy`).
The slices below are ordered by that result; a point with no yield outside
the harness waits until the other harness legs have landed.

### Target structure

- **One answer to "what family is this operand".** The family of a member or
  element read on a dynamic value is `dynamic`, decided in the one place
  that decides operand families (`provenIrFamily` / `binaryOperandFamily`
  with the operand-admissibility tables). No per-operator exception.
- **One carrier for an unannotated JavaScript parameter.** On standalone,
  legacy stores it as the dynamic carrier too, instead of a call-site-refined
  type. This follows #7349's "one representation" and removes the
  divergence check rather than widening it. JSDoc types do not type a
  JavaScript parameter for storage on either side.
- **What duplicate it removes.** The divergence probe for parameters
  (`param-dynamic-carrier-diverges-from-legacy`) and the parity withdrawal
  that follows it.

### Slices

1. Operand family of a member read on a dynamic value (selector and
   from-ast ask the same function).
2. The move-only scan and dynamic values in `&&` / `||`.
3. JSDoc-typed JavaScript parameters are dynamic on both sides.
4. One parameter carrier on standalone; lands with or after #7349 S1b.

### Constraints

- Standalone only; JS-environment output byte-identical.
- No test verdict regresses in any edition (slice 4 changes what legacy
  stores: verdicts across all editions for every file whose standalone
  binary changes, with QuickJS and the Temporal provider built locally).
- No unit that main lowers on IR is lost; refuse at select, never claim and
  then withdraw.

## Acceptance criteria

1. Step 0 table, dated, with the head it ran on.
2. Per slice: census (gained, lost 0, units newly legacy 0, post-claim
   errors not increased), all-edition verdicts of routing-changed files, a
   probe matrix against node, JS-environment bytes identical.
3. After slice 4 the parameter divergence check is gone.
4. A fresh-context adversarial review per slice records its verdict in the
   PR body.
