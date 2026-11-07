---
id: 7265
title: "IR move-only scan: local boolean call result into a dynamic var; dynamic computed element key (#7250 rule b)"
status: done
completed: 2026-11-06
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
depends_on: [7258, 7260]
related: [2949, 7106, 7261, 7270]
assignee: "ttraenkler/c-r7"
loc-budget-allow:
  # 2026-11-06: one `calleeReturnKind` helper (the existing
  # `calleeReturnIsDynamic` now reads it) and two scan admissions. The scan's
  # closure state lives in select.ts.
  - src/ir/select.ts
func-budget-allow:
  # 2026-11-06: scanExprInner measures +10 against origin/main `8b349439`
  # (the gate's figure, not a hand count): the bool-call operand in the
  # dynamic-local assignment arm, and the dynamic-key read arm with its #7261
  # flag. Each sits next to its sibling key and operand checks.
  # dynamicUsesAreMoveOnly restates #7258/#7260's #7261-guard grant.
  - src/ir/select.ts::scanExprInner
  - src/ir/select.ts::dynamicUsesAreMoveOnly
---

# IR move-only scan: boolean call result into a dynamic var; dynamic computed element key

## Problem

Rule (b) of [#7250](7250-ir-property-helper-dynamic-carrier-locals.md):
propertyHelper.js's `isWritable` does
`writeSucceeded = isSameValue(obj[verifyProp || name], newValue);`, where
`var writeSucceeded;` is the dynamic carrier's undefined (#7106 Stage 4).
Stacked on #7258 (rule c) and #7260 (rule a).

## Measurements (step 1, before code; base = #7260 head `73ea42c2`)

All on a copy of `isWritable` with #7250 step 1 stubbed
(`var unlikelyValue = "unlikelyValue"`, the `new Test262Error` throw reduced
to `throw e`), standalone, `JS2WASM_IR_SHAPE_DIAG=1`:

| variant | base refusal |
| --- | --- |
| as written | `move-only[concrete]` on `writeSucceeded = isSameValue(obj[verifyProp \|\| name], newValue)` |
| key aliased (`var k = verifyProp \|\| name`) | the same row (b1) |
| `isSameValue(obj[name], …)` | the same row (b1) |
| `var r = obj[verifyProp \|\| name]; writeSucceeded = r === newValue` | `move-only[dyn]` on `obj[verifyProp \|\| name]` (b2) |

So (b) is two admissions:
- **(b1)** the plain-assignment arm boxes only syntactic concretes
  (`concreteDynamicAssignmentOperandIsBuildable`), never a call. Here the
  call is a direct call to a local function whose return resolves `bool`.
- **(b2)** the dynamic element-read arm takes only a literal, a dynamic
  identifier or a proven-number key, never a dynamic expression such as
  `verifyProp || name` (#7106 S3b, `dyn.truthy` select).

Both producers already exist. from-ast boxes a concrete assignment value
with `boxConcreteToDynamic`, a bool → tag-boolean box, and its dynamic
element-read arm uses any dynamic key as-is (`lowerElementAccess`,
`emitDynMemberGet`). So this is an admission under the existing contract.

## Implementation Plan

- `src/ir/select.ts`:
  - `calleeReturnKind(name, typeMap)`: the resolved return of a local
    function. `calleeReturnIsDynamic` now reads it (one source).
  - The plain assignment to a dynamic local also admits a direct local call
    whose return is `bool`.
  - The dynamic element read also admits a dynamic-shaped key. A key other
    than a plain dynamic identifier sets the scan's #7261 flag
    (`needsNoDynamicMethodCall`), so a body that also calls through a member
    access stays refused (a dynamic key could itself be such a call).
- No from-ast change, no new instruction, no new import.

Code-quality acceptance: the callee-return lookup has one source, and each
admission sits next to its sibling checks in the same arm.

## Acceptance criteria

- `tests/issue-7265-ir-move-only-bool-call-into-dynamic.test.ts`: the
  stubbed isWritable is IR-emitted and passes through the test262 runner in
  sloppy mode. In strict mode it stays legacy and passes, because #7260's
  store is sloppy-only until
  [#7270](7270-ir-strict-dyn-member-set-exotic-receivers.md).
- Typed corpus byte-identical on gc/standalone/wasi.
- Wrapped ledger: 0 invariants, compileOk not lower.
- Standalone test262 A/B on propertyHelper includers plus 300 random: no
  pass→fail, no new trap.

## Results (2026-11-06; measured at `4bdbc499` against #7260 `217cbd51`, corpus at `30856ab9`; the review-fix head `e76868b6` re-checked below)

- **isWritable:** in the real harness it still stops first at #7250 step 1
  (`vardecl-module-binding-alias`, the `__isArray(obj) && …` conditional),
  then at the second alias `var hadValue = __hasOwnProperty(obj, name)`.
  With both stubbed inside the assembled harness
  (`built-ins/Boolean/prop-desc.js`, sloppy):
  - head emits isWritable, verifyWritable and verifyNotWritable as whole IR
    units;
  - base refuses isWritable at (b), and the other two through call-graph
    closure;
  - verifyProperty stays blocked by its own alias
    (`__getOwnPropertyDescriptor(obj, name)`).

  The next lever for the propertyHelper files is therefore #7250 steps 1–2.
  Whole units freed by #7265 alone: 0.
- **Wrapped ledger** (stride 40, standalone, SHAPE_DIAG): identical, with
  compileOk 1118 → 1118, invariants `{}`, routes `both 8531 / legacy 4780 /
  ir 1137`, and 0 `unsupportedDetails` rows changed.
- **Route diff:** stride-40 plus 300 seeded random, kept where the
  assembled source has a `[… || …]` key or a `var x;` later assigned a
  call. 208 files, 0 changes.
- **Standalone test262 A/B:** 300 random + the 208 candidates + every 20th
  propertyHelper includer (263), 721 distinct files. `{ pass: 506, fail: 161,
  compile_error: 43, skip: 11 }` on both sides, with the same non-pass set.
- **Typed corpus:** 264/264 byte-identical (gc/standalone/wasi).
- **Tests:** 13/13 (#7265, #7260, #7258). Gates bare green.

## Review fix (2026-11-06, PR #7120 review 5798191801)

**Finding (P2): annotated Boolean calls were claimed, then demoted.**
`resolvePositionType(BooleanKeyword)` (`src/codegen/index.ts`) returned a
bare `i32`, while `typeNodeToIr` and the inferred lattice producer keep the
Boolean brand. A callee annotated `(): boolean` therefore reached the new
(b1) arm as an unbranded i32, which `boxConcreteToDynamic` cannot box as a
Boolean.

Reproduced before the fix: `function b(): boolean { return true; }` and
`function use(seed: any): any { var r; r = b(); return r; }`, standalone and
gc. `use` was claimed, then fell back with "assignment to "r" (dynamic) got
i32". The inferred `function bi() { return 1 === 1; }` was emitted fine.

The fix is at the canonical annotation producer: `BooleanKeyword` now
returns `irVal({ kind: "i32", boolean: true })`. The physical ABI is still
i32. The producer also serves Boolean parameters, so both projections were
re-checked:

- **Typed corpus** (88 files × gc/standalone/wasi): 264/264 byte-identical
  to current main `8b349439`.
- **Boolean parameter/return probe** (string concat, template, ternary,
  `+ 1`, `!b`, `===`, `x > 1` return; 13 functions, all IR-emitted on both
  sides): identical values on gc, standalone and wasi, and byte-identical
  binaries on all three.
- **Test:** annotated and inferred true/false callees assigned into a
  dynamic local. All four carriers are IR-emitted on head (legacy on main),
  and each yields a JS Boolean with the right value (`typeof === "boolean"`,
  `=== true` / `=== false`), on standalone and gc.
