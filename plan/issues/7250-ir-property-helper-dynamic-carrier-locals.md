---
id: 7250
title: "IR: dynamic-carrier locals for propertyHelper.js (isWritable, verifyProperty)"
status: blocked
sprint: current
created: 2026-11-05
updated: 2026-11-05
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
parent: 7190
related: [7106, 2949, 7119, 7240]
assignee: "ttraenkler/c-lead"
---

# IR: dynamic-carrier locals for propertyHelper.js

## Problem

`ir_only_pass` counts standalone test262 passes with zero legacy units,
harness included. It is 1088 / 48232 and flat. About 12 % of test262 includes
`harness/propertyHelper.js`, and one legacy helper keeps the whole file out of
the count.

This issue is the "Plan for the next slice" in
[#7190](7190-ir-property-helper-harness-units.md): dynamic-carrier locals for
isWritable and verifyProperty. Rows in the wrapped ledger (stride 40,
standalone, main 2026-11-05):

- `vardecl-module-binding-alias` on `__getOwnPropertyDescriptor(obj, name)`: ×128
- `vardecl-module-binding-alias` on `__isArray(obj) && name === "length" ? … : …`: ×128
- verifyNotWritable and verifyWritable refused by call-graph closure: ×126 / ×123

## Census on main (2026-11-05, `e73e190c`)

Measured on `built-ins/Boolean/prop-desc.js`, compiled the way
`scripts/ir-claim-ledger.mts --wrapped` does: `assembleOriginalHarness`
primary, `originalHarnessCompileOptions(meta, "standalone")`,
`trackIrOutcomes`, `JS2WASM_IR_SHAPE_DIAG=1`. 10 propertyHelper units are
legacy (one fewer than #7190's 2026-10-29 count, which also listed
`<module-init>`; that one now stops on `Function`):

| unit | first refusal |
| --- | --- |
| verifyProperty | `vardecl-module-binding-alias` on `__getOwnPropertyDescriptor(obj, name)` |
| isWritable | `vardecl-module-binding-alias` on `__isArray(obj) && name === "length" ? nonIndexNumericPropertyName : "unlikelyValue"` |
| verifyCallableProperty | `expr-logical-value-family` on `options && options.verifyProperty \|\| verifyProperty` |
| verifyAccessorProperty | `param-type-unresolved(desc)` |
| verifyEqualTo | `abi-signature-parity`: IR=161 (`$__closure_prop_set_type`), legacy=86 |
| verifyWritable | `call-graph-closure` (calls isWritable) |
| verifyNotWritable | `call-graph-closure` (calls isWritable) |
| verifyPrimordialCallableProperty | `param-dynamic-carrier-diverges-from-legacy(options)` |
| verifyPrimordialAccessorProperty | `param-dynamic-carrier-diverges-from-legacy(desc)` |
| `<module-init>` | `expr-ident-not-in-scope` on `Function` |

isConfigurable, isEnumerable, isSameValue, verifyEnumerable,
verifyNotEnumerable, verifyConfigurable and verifyNotConfigurable ship IR
bodies.

## Implementation Plan

1. Exempt a local whose initializer is a certified alias call from
   `vardecl-module-binding-alias`. That covers isWritable step 2 and
   verifyProperty step 1.
   - Module: `src/ir/select.ts` (`isPhase1VarDecl`).
   - Predicate: `isCertifiedObjectAliasCall`, a new one in
     `uncurried-object-alias.ts` that joins the uncurried and stored-static
     forms.
   - Reads of such a local join the move-only scan's dynamic names
     (`dynNames`).
2. Certify `Array.isArray` as a stored static, and give the conditional a
   carrier type (isWritable step 1).
3. Stop and report when a step needs a file from the Shepherd's getter repair,
   or a change to `dynamicUsesAreMoveOnly`'s rules.

## Result: stopped at step 3 (rule change needed)

### Step 1, the alias-call exemption: measured, not shipped

The arm is small: one predicate in `uncurried-object-alias.ts`, and one
`isFreshObjectAliasResult` guard in `isPhase1VarDecl` that also refuses a
module value among the operands. On the census file it clears verifyProperty
step 1 and isWritable step 2, with no post-claim error.

- verifyProperty moves on to `vardecl-module-binding-alias` on
  `__getOwnPropertyNames(desc)`.
- isWritable stays on its step-1 conditional.

It ships no unit. #7190's owner already measured the same arm on 2026-10-29
and decided it "waits to land with the next blocker of either chain".
Neither chain can now finish without the rule changes below, so the arm is
not in this PR.

### Dynamic-carrier locals already work in the move-only scan

`dynamicUsesAreMoveOnly`'s `VariableStatement` arm already adds a `var`
whose initializer is dynamic to `dynNames` (`initIsDyn`). This was measured
with a local debug log in isWritable; all four parameters resolve `dynamic`:

| local | initializer | joins `dynNames` |
| --- | --- | --- |
| `newValue` | `value \|\| unlikelyValue` | yes |
| `hadValue` | `__hasOwnProperty(obj, name)` | no (exact boolean, as from-ast lowers it) |
| `oldValue` | `obj[name]` | yes |

So #7190's isWritable step 3 (`var oldValue = obj[name]`, `move-only[concrete]`)
was misattributed. The `move-only[concrete]` row on `obj[name]` comes from the
store `obj[name] = newValue` inside `try`, not from the read. Once the scan's
inputs are right, `newValue === oldValue` and `newValue + "2"` already pass.

### isWritable: what remains is scan rules

The census harness was stubbed locally, one blocker at a time (not shipped).
With step 1 stubbed (`var unlikelyValue = "unlikelyValue"`) and step 2
cleared, the refusals in order are:

| # | construct | why it is a rule change |
| --- | --- | --- |
| a | `obj[name] = newValue` (in `try`), `obj[name] = oldValue` | the scan admits a dynamic element store with a dynamic key only for two narrow shapes: #3797 (needs ambient `this` and an admitted root) and #3795 (RHS must be a widened string local or `"true"`). A general `dyn[dynKey] = dyn` store is a new admission |
| b | `writeSucceeded = isSameValue(obj[verifyProp \|\| name], newValue)` | `var writeSucceeded;` is the dynamic undefined (#7106 Stage 4). Assigning a local call's boolean result to it needs a box, and `concreteDynamicAssignmentOperandIsBuildable` does not admit calls. The key `verifyProp \|\| name` is not one of the element-read key shapes either |
| c | `if (writeSucceeded)` / `return writeSucceeded` | still refused (`move-only[concrete]` on `writeSucceeded`) after (a)–(b) are stubbed. A dynamic local in test or boolean-return position needs a truthiness or unbox admission |
| d | not yet peeled | `delete obj[name]`, the `instanceof TypeError` catch, `new Test262Error(...)` |

So isWritable cannot ship without changing `dynamicUsesAreMoveOnly`'s rules,
which this issue's ownership clause excludes. verifyWritable and
verifyNotWritable follow it through the call graph. So does verifyProperty,
which also calls isWritable, after its own chain: `__getOwnPropertyNames`
certification, `names.length` / `names[i]`, `__push`, `__join`,
`__defineProperty`.

Step 2 (`Array.isArray` certification and a carrier-typed conditional) was
not started. On its own it would only move isWritable's first refusal onto (a).

No file from the Shepherd's getter repair was needed.

## Next slice (needs the rules owner, #2949)

- One arm, "dynamic element store": statement-position `dyn[k] = v` with a
  dynamic receiver, a dynamic or literal key, and a dynamic or boxable value.
  It lowers through the existing dynamic member-set producer, like #3797 but
  without the ambient-`this` gate.
- A concrete-to-dynamic local assignment from an exactly boolean local call,
  plus `if (dyn)` and `return dyn` into a boolean result.
- Then re-measure isWritable's tail (d), and this issue's steps 1–2 land with
  it.

## Acceptance (unchanged, for the slice that ships)

- Wrapped-ledger A/B (`--wrapped --stride 40 --target standalone --jobs 2`):
  - harness-origin legacy units fall, and so do the
    `vardecl-module-binding-alias` rows;
  - 0 invariants, and compileOk is not lower.
- The raw ledger is byte-identical apart from timing.
- The typed corpus is byte-identical on 3 lanes, or every diff is explained.
- Standalone test262 A/B over the files that include propertyHelper: no
  pass→fail.
- `tests/equivalence/issue-7250-property-helper-dynamic-carrier-locals.test.ts`.
