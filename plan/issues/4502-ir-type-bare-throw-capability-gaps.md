---
id: 4502
title: "ir: sweep from-ast bare `throw new Error` — type every capability gap as an IrUnsupportedError demote"
status: done
sprint: 78
created: 2026-08-15
updated: 2026-08-18
completed: 2026-08-15
assignee: ttraenkler/opus-4502
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: ir
goal: ir-full-coverage
related: [4578, 4486, 4487, 4035, 3784, 3565, 3341]
loc-budget-allow:
  - src/ir/from-ast.ts
func-budget-allow:
  - src/ir/from-ast.ts::lowerMethodCall
  - src/ir/from-ast.ts::lowerFunctionAstToIr
  - src/ir/from-ast.ts::lowerBinary
  - src/ir/from-ast.ts::lowerExpr
---

# #4502 — retire the bare-throw fallout class in `from-ast` wholesale

## Problem

A bare `throw new Error(...)` reached from a **claimed** unit is classified by
`classifyIrFailure` as `invariant` / `unexpected-internal-throw`, which
#3341/#3519 turn into a **hard compile failure** — even when `legacyBodyEmitted:
true` is sitting right there and the legacy backend lowers the shape fine.

This is not a hypothetical. The same defect fired **four times on 2026-08-15
alone**, each time found only because an adoption WIDENED the selector's claim
set and made a previously-unreachable arm reachable:

- #4578 — the string slice-1 arms
- #4486 — the prepared-vec element allowlist
- #4487 — three `lowerArrayLiteral` shapes
- two further sites recorded as observations in #4486's file
  (`mixed-type array literal not in #1804 scope`,
  `direct call to "f" has no exact AST-site plan`)

Fixing them one at a time guarantees a fifth, sixth and seventh. #4502 sweeps
the whole surface instead.

**The distinction that decides each site:**

| | verdict | mechanism |
| --- | --- | --- |
| **capability gap** — legit JS the IR cannot lower *yet* | typed `IrUnsupportedError` demote | function keeps its legacy body, compiles, runs |
| **producer promise** — a plan/helper/selector contract violated | stays a bare `Error` (`invariant`) | hard error, as intended |

## Scope

Swept: `src/ir/from-ast.ts` plus the **build-stage** lowering helpers it
dispatches into — `src/ir/array-element-lowering.ts`,
`src/ir/promise-delay-lowering.ts`.

Deliberately NOT swept:

- `src/ir/lower.ts` and `src/ir/backend/**` — the `lower` /
  `backend-legality` stages cannot express `unsupported` at all (see the
  `POSTCLAIM` note in `scripts/gen-ir-adoption.mjs`).
- `src/ir/builder.ts` — the IR builder's own API contract; structural
  invariants by construction.
- `src/ir/prepared-vector-support.ts` — **#4486's active file**, claimed by
  another lane. Its `prepared vec element vec<externref> is not supported`
  arm is still a hard failure after this change (verified below); #4486 owns
  it.

## Classification

358 sites. Every one was assigned by an ordered, hand-reviewed rule on the
enclosing lowering function + the message idiom, then the whole diff was
reviewed. Four sites were reclassified by hand after reading them in context
(recorded under "Hand overrides" below).

### Capability gaps → typed demote

| Code | Sites | Arms (enclosing lowering fn × count) |
| --- | --- | --- |
| `body-shape-rejected` | 73 | `lowerObjectLiteral`×8, `lowerExpr`×7, `lowerVarDecl`×7, `liftClosureBody`×6, `lowerStatementList`×4, `lowerTail`×4, `lowerClosureExpression`×3, `lowerClosureExpressionWithSignature`×3, `lowerForOfStatement`×3, `lowerFunctionAstToIr`×3, `lowerNestedFunctionDeclaration`×3, `analyseCaptures`×2, `closureDefaultParamStart`×2, `liftNestedFunction`×2, `lowerOrdinaryToPrimitiveObjectLiteral`×2, `lowerPreparedAsyncConcat`×2, `lowerStmt`×2, `lowerYield`×2, `requireSuperParentShape`×2, `emitDefaultExternArg`, `lowerConstructorFieldInitializers`, `lowerSwitchStatement`, `lowerTryStatement`, `lowerWithStatement`, `requireThisValue` |
| `method-call-unsupported` | 26 | `lowerMethodCall`×19, `lowerStringMethodCall`×4, `tryLowerVecPush`×3 |
| `operand-coercion-unsupported` | 20 | `lowerInstanceOf`×4, `lowerBinary`×3, `lowerConditional`×2, `lowerPrefixUnary`×2, `lowerResolveCall`×2, `tryLowerPrimitiveWrapperLooseEquality`×2, `coerceLoopCondToBool`, `lowerDiscardedExpression`, `lowerTimerCall`, `lowerTypeOf`, `requireF64` |
| `array-representation-unsupported` | 19 | `lowerArrayLiteral`×7, `lowerArrayPattern`×5, `lowerForOfVec`×4, `annotatedArrayElementValType`, `emitSafeVecGet`, `lowerForOfString` |
| `property-write-unsupported` | 15 | `lowerIdentifierAssignment`×7, `lowerPropertyAssignment`×6, `lowerCheckedClassFieldSet`×2 |
| `property-access-unsupported` | 13 | `lowerPropertyAccess`×9, `lowerOptionalExternPropertyAccess`×4 |
| `call-resolution-unsupported` | 11 | `lowerCall`×4, `lowerNestedFuncCall`×4, `expandStaticSpreadArgs`×2, `lowerClosureCall` |
| `type-resolution-unsupported` | 9 | `closureParameterTypeToIr`×5, `resolveIrType`×2, `typeNodeToIr`×2 |
| `destructuring-param-complex` | 7 | `lowerObjectPattern`×7 |
| `unknown-class-construction` | 7 | `lowerNewExpression`×4, `lowerPrimitiveWrapperConstruction`×3 |
| `compound-assign-unsupported` | 6 | `lowerCompoundAssignment`×4, `lowerIncrementDecrement`×2 |
| `element-store-unsupported` | 6 | `lowerElementStore`×6 |
| `module-init-legacy-coupling` | 6 | `lowerVarDecl`×4, `lowerFunctionAstToIr`×2 |
| `element-access-unsupported` | 5 | `lowerElementAccess`×5 |
| `return-type-legacy-coupling` | 5 | `lowerEarlyReturn`×3, `coerceReturnValue`×2 |
| `call-arity-unsupported` | 4 | `lowerCall`×2, `lowerClosureCall`, `lowerNestedFuncCall` |
| `param-shape-rejected` | 4 | `lowerFunctionAstToIr`×3, `emitExpressionDefaultMissingF64` |
| `logical-value-unsupported` | 3 | `lowerLogicalAndOr`×3 |
| `constructor-arity-unsupported` | 2 | `lowerNewExpression`×2 |
| `imported-call-planning-unsupported` | 2 | `importedMissingArgument`, `lowerImportedCall` |
| `nullish-value-unsupported` | 2 | `lowerNullish`×2 |
| `call-graph-closure` | 1 | `lowerCall` — the named `direct call to "f" has no exact AST-site plan` observation |
| `string-evidence-unsupported` | 1 | `lowerStringMethodCall` |

**22 of the 23 codes are existing sibling codes** (the #4486 rule: one gap =
one verdict, reuse the sibling's verdict). The single new code is
`property-access-unsupported` — the READ sibling of the existing
`property-write-unsupported`. Property *write* and *method call* each already
had a code; property *read* did not, so its arms had nothing to demote to.

### Producer promises → kept `invariant`

Each of these keeps its bare `Error` and now carries an
`// invariant (producer-promise): … — #4502.` comment at the site naming the
promise, so the next sweep does not re-litigate it.

| Sites | Why it stays a hard error | Representative arms |
| --- | --- | --- |
| 63 | a compiler-support/runtime helper declared non-void returned no SSA value (`emitCall` → `null`) | `lowerMethodCall`, `lowerForInStatement`, `emitUnaryToNumber`, `lowerInstanceOf`, `coerceToExpectedExtern`, +33 more |
| 14 | the prepared plan and the lowering disagree — a plan↔builder desync | `lowerImportedCall`, `lowerHostDateGetterCall`, `lowerForInStatement`, `lowerClosureExpressionWithSignature`, +5 more |
| 6 | the resolver promised a well-formed plan | `lowerMethodCall`, `lowerHostVoidCallbackExpression`, `lowerResolveCall`, `lowerTimerCall`, `tryLowerPromiseDelayConstruction` |
| 5 | already-documented sibling arm (see "Hand overrides") | `lowerBitwiseOperand`, `lowerPrefixUnary`×3, `lowerBinary` |
| 3 | the selector's own gate already decided this predicate | `lowerBreakContinueStatement`×2, `lowerSwitchStatement` |
| 3 | the mutation pre-pass promised a slot binding here | `lowerIdentifierAssignment`, `lowerCompoundAssignment`, `lowerIncrementDecrement` |
| 3 | the carrier the producer promised was dropped | `lowerHostDateGetterCall`, `lowerForInStatement`, `annotatedArrayElementValType` |
| 3 | the lowering just invoked promised this shape | `lowerObjectLiteral`, `lowerWithStatement`, `tryLowerPrimitiveWrapperLooseEquality` |
| 2 | identity resolution promised an exact unit | `lowerTopLevelFunctionValue`, `lowerNestedFuncCall` |
| 2 | caller contract: reachable only for bitwise operators | `lowerBitwiseAsI32`, `lowerPromotedI32CompoundAssignment` |
| 7 | one-off plan/selection promises (implicit-ctor parent shape; leading `super()`; exact init shape; `__gen_create_buffer` must produce a value; compiler-support trampoline; argc-sensitive runtime global; exact capture proof) | `lowerConstructorBody`×2, `lowerFunctionAstToIr`×2, `lowerTopLevelFunctionValue`, `lowerImportedCall`, `validateExactCapturePlan` |

**Totals: 358 sites · 247 converted · 111 kept invariant.**

### Hand overrides (read in context, rule overridden)

| Site | Rule said | Verdict | Justification |
| --- | --- | --- | --- |
| `lowerElementAccess` "inferred linear vector read is not proven in bounds" | invariant | **demote** `element-access-unsupported` | Its own comment: "until shared IR has an explicit undefined carrier, only lower reads covered by the existing counted-loop bounds proof". A proof that did not succeed is a capability gap, not a broken promise. |
| `emitExpressionDefaultMissingF64` "sentinel requires an f64 parameter" | invariant | **demote** `param-shape-rejected` | Only the f64 sentinel carrier is implemented; another carrier is an unimplemented shape. |
| `tryLowerPrimitiveWrapperLooseEquality` "primitive operand was not boxable" | invariant | **demote** `operand-coercion-unsupported` | `boxConcreteToDynamic` returns `null` for types it declines to box — a declared capability decision, not a violated one. |
| `lowerFunctionAstToIr` "constructor lowering requires the exact init shape" | demote | **invariant** | The comment two lines above states "the integration walk supplies the exact init shape" — an explicit producer promise. |

## The operand-proof narrowing (the one behaviour change beyond retyping)

Five sites had already been given a two-arm treatment by #3168/#3727:

```ts
const detail = `ir/from-ast: unary '!' expects bool in ${cx.funcName}`;
if (checkerProvesUnaryCoercionGap(expr, cx)) {
  throw new IrUnsupportedError("operand-coercion-unsupported", "build", detail);
}
throw new Error(detail);           // ← hard compile failure
```

Those five were initially left alone as already-documented deliberate
invariants. **The probe sweep then measured that the gate fails OPEN in exactly
the case the checker cannot help with.** `checkerProvesUnaryCoercionGap` /
`checkerProvesBinarySourceCapabilityGap` return `false` — i.e. "not a gap, hard
error" — whenever the operand family is `no-checker` or `unknown`, which is
what ordinary untyped/`any` JS produces. Measured on this branch, before the
change, `--target standalone`:

```
export function main(s: string): number { return -(s as any); }   → empty binary
export function main(s: string): number { return !(s as any); }   → empty binary
export function main(s: string): number { return ~(s as any); }   → empty binary
```

each with `Codegen error: IR path failed for main: ir/from-ast: unary '…'
expects …`, while the legacy backend lowers all three fine.

The fix splits two conditions the helpers had collapsed:

| Family | Means | Verdict |
| --- | --- | --- |
| `no-checker` | the compiler is running without a TypeChecker at all — an **infrastructure** condition that says nothing about the source | unchanged: `false` → invariant backstop, which is #3529 P2's explicit contract |
| `unknown` | a checker IS present and cannot classify the operand — the source really is type-erased (`x as any`), a statement **about the source** | now `true` → capability gap, demote |
| a positive contradiction | the checker says both operands ARE the same already-supported family, yet a bad carrier arrived | unchanged: `false` → invariant |

The first draft collapsed `no-checker` into the demote side too, and
`tests/issue-3529-dataflow-outcomes.test.ts` caught it immediately — the P2
suite drives `lowerFunctionAstToIr` directly with a synthetic carrier
contradiction and no checker, exactly the case that must stay loud. The five
`throw new Error(detail)` lines are unchanged and still reachable.

## Two arms the sweep initially got wrong (both caught by existing tests)

Recorded because the ordered-rule method's failure mode is worth knowing:

1. **`lowerCompoundAssignment` — `checker-string RHS for "x +=" has
   contradictory carrier`.** The blanket `lowerCompoundAssignment →
   compound-assign-unsupported` rule demoted it. It is a POSITIVE contradiction
   (`checkerOperandFamily(rhs) === "string" && rhsType.kind !== "string"`) — the
   word "contradictory" in its own message is the tell. Reverted to `invariant`
   with an explicit comment so a future sweep does not re-demote it.
2. **The `no-checker` half of the proof-helper narrowing**, above.

Both were caught by `tests/issue-3529-dataflow-outcomes.test.ts`, which is why
that suite was run rather than only the new one.

## Pre-existing reds on main (NOT caused by this change)

Verified by re-running each suite with the touched files reverted to
`fce375e5`; the failures and their values are identical there.

| Test | Symptom | Status |
| --- | --- | --- |
| `issue-3529` "checker-string carrier contradiction … at the mixed-string gate" | expects `invariant/unexpected-internal-throw`; main already produces `unsupported/operand-coercion-unsupported` | **fixed here** — the gate's own comment says "Always a clean demote, never the invariant backstop", so the assertion was stale. Retargeted to the stated contract. |
| `issue-3529` "does not treat inherited String.toString / .valueOf as a method-table signature" (×2) | expects `invariant/unexpected-internal-throw`; main already produces `unsupported/method-call-unsupported` | **fixed here** — `.m(...) on <type> not in slice 4` is the exact message shape `method-call-unsupported` was introduced for (#680). The load-bearing assertion (lowering must REJECT, not resolve the inherited signature) is untouched. |
| `issue-1923` "the ratchet gate PASSES on the clean corpus" | vitest timeout at 35 s (it shells out to the full `check:ir-fallbacks` corpus run) | **left alone** — not an assertion failure, and `check:ir-fallbacks` passes when run directly. A loaded-box timeout, not a signal. |
| `issue-3521` "preserves singleton identity … in standalone" | `expected 33807 to be less than or equal to 33723` (binary-size assertion) | **left alone** — identical values on base; unrelated to #4502. Worth a separate issue. |

## Test Results

`tests/issue-4502.test.ts`. Every shape below was measured on the **unmodified**
base (`fce375e5`, via a file-copy A/B in the same worktree) and again after the
change — the "before" column is a run, not an inference.

| Shape (all parameterless — see note) | Base | After | Runtime |
| --- | --- | --- | --- |
| `const x = c ? 1 : "s"` (ternary, mixed branch types) | FAIL — `invariant/build/unexpected-internal-throw`, empty binary | OK — `unsupported/build/operand-coercion-unsupported` | 1 = node |
| `(x as any) ?? 5` on an f64 lhs | FAIL — same | OK — `unsupported/build/nullish-value-unsupported` | 3 = node |
| `!(s as any)`, `s = "a"` | FAIL — same | OK — `unsupported/build/operand-coercion-unsupported` | 0 = node |
| `!(s as any)`, `s = ""` | FAIL — same | OK — `unsupported/build/operand-coercion-unsupported` | 1 = node |
| `(n as any).foo` (property read on a number receiver) | FAIL — same | OK — `unsupported/build/property-access-unsupported` | 0 = node |
| `(o as any).a = "s"` (property write, mismatched type) | FAIL — same | OK — `unsupported/build/property-write-unsupported` | 7 = node |
| `const a = [{p:1},{p:2}]` (array literal of objects) | FAIL — same | OK — `unsupported/build/array-representation-unsupported` | 2 = node |

All seven compile to a non-empty binary on **both** `standalone` and `gc`, emit
**no** `severity: "error"` diagnostic, record the TYPED code rather than
`unexpected-internal-throw`, and return the value `node` returns.

**29 of 29 assertions fail when `src/ir/from-ast.ts` alone is reverted to
`fce375e5`** (file-copy A/B in the same worktree), so the test pins the defect
rather than merely passing.

Every shape is **parameterless on purpose**: an externref-typed parameter cannot
be supplied from the test host ("type incompatibility when transforming
from/to JS"), which would have forced the runtime assertion into a try/catch
escape hatch and quietly stopped checking the only thing that distinguishes a
working demote from a broken one. The first draft of this test had exactly that
hole — the `!` case took a `string` param and its runtime assertion never ran.

Both truthiness arms of the unary `!` site are pinned (`"a"` → 0, `""` → 1) so a
lowering that always answered one constant could not pass.

**Still failing, by design and out of scope:** the #4486 repro
(`for (const r of rows)` over `string[][]`) — that arm lives in
`src/ir/prepared-vector-support.ts`, which #4486 owns. Confirmed still
`invariant/resolve/unexpected-internal-throw` after this change, i.e. the sweep
did not blanket-demote everything it touched.

## Gates

Measured against the `fce375e5` baseline captured before any edit:

| Gate | Baseline | After |
| --- | --- | --- |
| `check:ir-fallbacks` | OK — unintended (none), **post-claim demotions (none)**, module-level (none) | identical |
| `check:ir-only` host lane | 37/37 emitted, 0 unsupported, 0 invariants, READY | identical |
| `check:ir-only` standalone lane | 19 emitted / 18 unsupported / 0 invariants / 27 legacy bodies, READY | identical |
| `gen:ir-adoption --check` | clean | clean (POSTCLAIM rows added for the newly build-reachable codes) |
| `tsc --noEmit` | 0 errors in the touched files | 0 errors in the touched files |
| `tests/issue-3529-dataflow-outcomes` | 20/23 (3 stale assertions red) | **23/23** |
| `issue-4027` / `issue-3784` / `issue-3529-selector-preclaim` / `issue-3565` / `issue-3519` | pass | pass |

The post-claim bucket does not move because the 13-file playground corpus does
not reach any converted arm — which is also why corpus-zero was never
sufficient evidence here, and why the A/B probe above is the load-bearing
measurement.

### LOC budget

`src/ir/from-ast.ts` 12,777 → 13,311 (+534), granted via `loc-budget-allow`
above. The growth is ~111 one-line `// invariant (producer-promise):` comments
plus Prettier re-wrapping call sites that gained a `"<code>", ` argument. No
logic was added.

The same accounting drives the four `func-budget-allow` grants — the throw-dense
functions absorb the comments and the re-wrapping proportionally:

| Function | Before | After | Cause |
| --- | --- | --- | --- |
| `lowerMethodCall` | 788 | 833 (+45) | 33 throw sites — the densest in the file (26 demotes + 7 invariant comments) |
| `lowerFunctionAstToIr` | 337 | 351 (+14) | 10 sites |
| `lowerExpr` | 300 (at threshold) | 314 (+14) | 8 sites; crosses the 300-LOC threshold on comments alone |
| `lowerBinary` | 435 | 441 (+6) | 5 sites |

None of these is new logic, and none is a split candidate created by this
change — the splits these budgets exist to force are #3399's, on functions
that were already far over.

## Merge with `origin/main` (#4487 landed mid-flight)

Two conflicts in `src/ir/from-ast.ts`, both in `lowerArrayLiteral`, both from
#4487's spread adoption landing while this sweep was in flight. Resolved inline
rather than routed to a `[CONFLICT]` task because the resolution is mechanical
and is precisely this issue's mandate — **flagged for review all the same**:

1. **The spread/elision guard.** #4487 split the old single arm into two
   (elision; spread with no statically provable length) and wrote both as bare
   `Error`. Kept #4487's control flow verbatim, applied #4502's typing
   (`array-representation-unsupported` for both — both are legal array
   literals `vec.new_fixed` cannot express).
2. **The non-scalar element-type arm.** No semantic conflict at all: **#4487
   and this sweep independently reached the same verdict AND the same code**
   (`array-representation-unsupported`), #4487 via
   `throw new IrUnsupportedError(...)` and #4502 via `demoteToLegacy(...)`,
   which are the same thing. Kept #4487's rationale comment (it carries a
   measurement) and routed it through the shared helper.

That independent agreement is the corroboration a rule-driven sweep most wants.

**Post-merge completeness check:** `src/ir/from-ast.ts` now holds 98 bare
`throw new Error` sites (down from 336), and a scan for sites carrying neither
the `// invariant (producer-promise):` marker nor the documented sibling-arm
shape returns **zero** — every surviving bare throw in the swept files is a
deliberate, annotated invariant. All gates re-run green after the merge.

## Acceptance criteria

1. ✅ Every bare `throw new Error` in `from-ast.ts` and its build-stage
   helpers is classified, with a recorded justification.
2. ✅ Capability gaps throw a typed `IrUnsupportedError` and demote to the
   legacy body; existing sibling codes reused wherever one exists.
3. ✅ Sites kept as invariants carry an in-code comment naming the producer
   promise.
4. ✅ `check:ir-fallbacks` shows no growth; `check:ir-only` lanes at their
   baselines; `gen:ir-adoption --check` clean.
5. ✅ A probe test pins each converted shape as compiling-via-legacy with the
   typed reason, and matching `node` at runtime.
