---
id: 7353
title: "IR: JavaScript parameter carriers — one family and one carrier for an untyped parameter"
status: in-progress
sprint: current
created: 2026-11-16
updated: 2026-11-19
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
  # 2026-11-19 (slice 1): +6 lines in select.ts, the call of the shared
  # `familyBesideCarrier` (analysis/carrier-expression.ts) and the subject's
  # dynamic-parameter predicate, which reads selector state and cannot move.
  - src/ir/select.ts
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

## Plan amendment (2026-11-19, measured on main `ee3fcdd610`)

### Step 0 (measured)

Method: `.tmp` census script, compiled exactly as `ir-claim-ledger --wrapped`
(`assembleOriginalHarness` primary + `originalHarnessCompileOptions(meta,
"standalone")`, `JS2WASM_IR_SHAPE_DIAG=1 JS2WASM_IR_MODULE_INIT_ALL_REJECTS=1`),
then `runTest262File(..., "standalone")` for the verdict. Population: the 9,174
ES5 files (edition classifier, `_FIXTURE` excluded, the census count), seeded
shuffle (seed 7353), first 1,200 files. A sample, not the full census.

| | count |
|---|---|
| files | 1,200 |
| skipped (negative, raw, module, runner skip) | 65 |
| compiled | 1,114 |
| IR-only | 237 |
| IR-only and pass | 236 |
| legacy units | 2,048 |
| files with `propertyHelper.js` | 99 |

| point | label | files carrying | only family left |
|---|---|---|---|
| 1 | `expr-binary-operand-families` | 103 | 14 |
| 2 | `expr-logical-value-family` or `move-only[…]` | 124 | 7 |
| 3 | `param-type-unresolved` | 88 | 0 |
| 4 | `param-dynamic-carrier-diverges-from-legacy` | 98 | 0 |

- **Point 1 outside the harness is a different shape.** Of the 103, 88 are
  `verifyProperty` in `propertyHelper.js`. The other 15 are `<module-init>`
  test bodies (`1 + null`, `{} ^ function(){}`, `{valueOf…} < 1`, …): no
  parameter is involved, so slice 1 does not reach them. The 14 "only family
  left" files are all of that kind.
- **Point 2 has changed label.** `options && options.verifyProperty ||
  verifyProperty` is now refused as `expr-logical-value-family` (98 files,
  `verifyCallableProperty`), not by the move-only scan. Its right operand is a
  top-level function used as a value: that is #7354 slice Fa / #7349 (lane S4),
  not a parameter question. It leaves this issue.
- **Points 3 and 4 never occur outside the harness** in the sample.
- **After slice 1, `verifyProperty`'s next refusal is the move-only scan**
  (`assert.notSameValue(desc, null, …)`: a dynamic argument to a harness
  object's method), which #7342 already lists as the longest tail. So slice 1
  frees no file and no census unit on its own; it is one leg.

### Slices, re-cut

1. **Slice 1 (this PR).** A dynamic parameter, or a member or element read
   through one, beside a carrier operand is the carrier
   (`familyBesideCarrier` in `analysis/carrier-expression.ts`, over the same
   `producesCarrier` from-ast's `expressionProducesDynamic` uses).
   - Measured against the alternative: answering `dynamic` for every such read
     in `provenIrFamily` adds refusals, because the other operand is often
     still `unknown` (`x === name`, `i < a.length`, `message || ""` in
     `assert.js` / `propertyHelper.js`). A pair of two `unknown`s is not
     judged today; a `dynamic` beside an `unknown` is refused. So the
     refinement only fires beside a carrier operand, where the pair is
     already judged and already refused.
   - Reuses `producesCarrier`; removes nothing (no duplicate predicate was
     found for this question). Quality criterion: one helper next to its
     sibling in `carrier-expression.ts`, select.ts grows by the call only.
2. **Point 2 moves to lane S4** (function values), see above.
3. **Slice 3 (next).** `@param {object} desc` plus nested `@param [desc.x]`
   tags make TypeScript build a `JSDocTypeLiteral`; legacy stores a struct for
   it and the IR refuses. Plain `@param {object}` already lowers as externref
   and the IR claims it (`jsDocParamLowersAsExternref`). Target: on
   standalone, legacy's `lowerParamType` stores a JSDoc type literal as
   externref (one rule beside `parameterMayBeOmitted`), so the existing
   selector arm answers `dynamic`. JS-environment bytes unchanged. Needs the
   all-edition verdict check, since every `propertyHelper.js` binary changes.
4. **Slice 4** waits for #7349 S1b, as planned. Per #7342 the Primordial
   pair's divergent slots come from `@type {typeof …}` JSDoc, not call sites;
   re-measure after slice 3.

## Acceptance criteria

1. Step 0 table, dated, with the head it ran on.
2. Per slice: census (gained, lost 0, units newly legacy 0, post-claim
   errors not increased), all-edition verdicts of routing-changed files, a
   probe matrix against node, JS-environment bytes identical.
3. After slice 4 the parameter divergence check is gone.
4. A fresh-context adversarial review per slice records its verdict in the
   PR body.
