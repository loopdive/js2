---
id: 5092
title: "IR mixed-primitive conditional-expression ownership"
status: done
assignee: ttraenkler/codex
branch: codex/5092-ir-conditional-expression
created: 2026-08-27
updated: 2026-08-27
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: refactor
area: ir, codegen
language_feature: conditional-expression
goal: ir-first
depends_on: [4787]
related: [1820, 3144, 4178, 4502, 4512]
files:
  - src/codegen/ir-first-gate.ts
  - src/codegen/ir-overlay-safety.ts
  - src/ir/from-ast.ts
  - src/ir/select.ts
  - tests/issue-4178.test.ts
  - tests/issue-5092-ir-mixed-primitive-conditional.test.ts
loc-budget-allow:
  - total
  - src/codegen/ir-first-gate.ts
  - src/codegen/ir-overlay-safety.ts
  - src/ir/from-ast.ts
  - src/ir/select.ts
func-budget-allow:
  - src/codegen/ir-first-gate.ts::irFirstBodyIsProvenLowerable
  - src/codegen/ir-overlay-safety.ts::computeIrFirstSkipUnitIds
  - src/ir/from-ast.ts::lowerCall
  - src/ir/from-ast.ts::lowerConditional
  - src/ir/select.ts::buildLocalCallGraph
  - src/ir/select.ts::isPhase1Expr
---

# #5092 — IR mixed-primitive conditional-expression ownership

## Objective

Remove the remaining direct-body fallback for a bounded mixed-primitive
`ConditionalExpression` inside an otherwise Prepared single-source top-level
function. Same-representation ternaries already lower lazily through
`IrInstrIf`; this checkpoint joins exact `number`, `string`, and `boolean` arms
on the existing boxed-dynamic IR carrier while preserving one-arm-only
evaluation and honest JavaScript value tags.

This is the concrete unresolved boundary documented by #4178 and exercised by
#4502: `c ? 1 : "s"` is selected as Phase-1, then `lowerConditional` reports
`operand-coercion-unsupported` because the arm `IrType`s differ. The retained
direct body is correct, but the selected function still has `legacyBodyEmitted`
and therefore is not an IR-owned unit.

## Current implementation facts

- `src/codegen/expressions/misc.ts::compileConditionalExpression` is the direct
  AST-to-Wasm residual. It performs lazy structured `if` emission and a broad
  carrier join, including heterogeneous primitive unions through `$AnyValue`.
- `src/ir/from-ast.ts::lowerConditional` already evaluates the condition once,
  lowers each arm into a separate instruction buffer, joins branch-local
  facts, and emits `IrFunctionBuilder.emitIfElse`. #1820 removed the old eager
  `select` behavior; this checkpoint must not reintroduce it.
- The IR owner currently accepts equal scalar or equal non-scalar arm types.
  Genuinely different arm types demote at build time. #4178 pins the resulting
  hard IR-first error; #4502 pins the ordinary typed fallback.
- The IR already has boxed-dynamic values and exact tag-aware boxing for
  numbers, strings, and booleans. The missing piece is one selection/build
  contract that proves both arm families and boxes each branch before the
  `IrInstrIf` result join.

## Bounded implementation plan

1. Add one selector-side assessment for heterogeneous ternary arms. Admit only
   an already-Prepared single-source top-level function whose condition is
   Phase-1 lowerable and whose two recursively lowerable arms each have an
   exact primitive family in `{number,string,boolean}` with different families.
   Reject `any`, `unknown`, type parameters, nullable/undefined, bigint,
   object/extern/class/function values, property reads, calls, allocation,
   assignment/update, spread, `await`/`yield`, nested closures, class members,
   module init, and multi-source units before claim.
2. Keep rollout exact and reversible. The route is enabled for IR-first builds
   unless `JS2WASM_IR_MIXED_PRIMITIVE_CONDITIONAL=0`; every other value uses the
   new exact assessment. The global `JS2WASM_IR_FIRST=0` control must still
   restore the complete direct function body.
3. Extend `lowerConditional` without changing condition or branch order. Lower
   each branch into its existing isolated body, box the exact primitive result
   with its honest JS tag, and emit one lazy `IrInstrIf` whose result is the
   boxed-dynamic type. A missing selector proof, mismatched family/tag,
   unavailable dynamic carrier, arm demotion, or non-dynamic result after claim
   is a fatal selection/build invariant, never a second fallback.
4. Keep same-type ternaries byte/behavior inert and leave the direct compiler's
   broad coercive carrier join untouched for every unsupported shape. Do not
   widen call/property/object semantics or introduce an eager `IRSelect` path.
5. Add a focused #5092 matrix and flip only the #4178 expectation this exact
   slice retires. Update issue status/results after focused tests, typecheck,
   formatting, LOC/function budgets, fallback audit, and pre-push checks pass.

## Acceptance matrix

- Non-vacuous exact denominator: number/string, boolean/string, and
  number/boolean ternaries all record `kind: emitted`,
  `legacyBodyEmitted: false`, `irBodyEmitted: true`, and zero post-claim errors.
- Runtime parity covers both condition values, `typeof`, string concatenation,
  `String`, `Number`, and nested arithmetic/return consumers so an always-box-
  as-string or always-box-as-number implementation cannot pass.
- Structural IR evidence shows one `if` with separately buffered arms and
  exact per-arm box tags; no eager `select` is emitted.
- Direct-body poison succeeds for every eligible function. The route kill
  switch and global IR-first kill switch both reach the poisoned direct body.
- Negative controls remain direct-owned with typed Unsupported outcomes:
  nullable, bigint, any/unknown/generic, object/property, call/effectful arm,
  nested closure, class member, module init, and multi-source shapes.
- A test-only mismatched-tag/result seam proves post-claim drift is fatal and
  produces no publishable binary.

## Non-goals and sequencing

- This does not replace `compileConditionalExpression` for the general
  JavaScript coercion surface. It retires one exact Prepared-function slice.
- It does not change conditional callees, optional chaining, logical/nullish
  operators, object/extern unions, or arbitrary union ABI design.
- #4787 lands first because both checkpoints touch `src/ir/from-ast.ts` and
  `src/ir/select.ts`. To parallelize review without duplicating that diff,
  #5092 is stacked on the narrow prepared-call safety follow-up; its PR base is
  retargeted to current `main` after the dependency lands.

## Implementation outcome

- Selection and lowering share one checker-backed primitive-family grammar.
  Exact mixed `number`/`string`/`boolean` arms lower into separately buffered
  branches, receive honest boxed-dynamic tags, and join through one lazy IR
  `if`; every mismatch after claim is an invariant.
- Exact dynamic `typeof` dispatches on the two proven runtime tag families.
  Direct ambient `String(c ? a : b)` and `Number(c ? a : b)` convert each
  concrete arm inside that same lazy branch. General wrapper calls, aliases,
  and shadowed bindings remain direct-owned.
- The compile-once gate now models string and this bounded dynamic primitive
  domain, so accepted functions publish only the IR body. The focused #4178
  expectation is updated from retained-direct fallback to IR ownership.
- Rollback remains available through
  `JS2WASM_IR_MIXED_PRIMITIVE_CONDITIONAL=0` and the global
  `JS2WASM_IR_FIRST=0` switch. Test-only tag/result drift proves fail-closed
  behavior after claim.

## Validation

- `tests/issue-5092-ir-mixed-primitive-conditional.test.ts`: 17/17 passed.
- `tests/issue-4178.test.ts`: 14/14 passed.
- `tests/issue-3143.test.ts` + `tests/issue-3203.test.ts`: 45/45 passed.
- After stacking the #4787 prepared-call guard, focused #4787 + #5092 + #4178
  coverage passed 48/48 and TypeScript 7 typecheck remained clean.
- TypeScript 7 project typecheck passed with zero diagnostics.
- Targeted Biome lint, Prettier formatting, `git diff --check`, IR fallback,
  IR dialect/layering, oracle, coercion-site, LOC, function, issue, and done-
  status gates passed.

## 2026-08-28 — repair of two independent-review HOLDs

Independent review of PR #5102 raised two HOLDs. Both reproduced against the
PR head (`b354381`); both are fixed here.

### HOLD 1 — forged-assertion `typeof` gave a WRONG ANSWER (not a demote)

`exactDynamicPrimitiveTypeofFamilies` read `checker.getTypeAtLocation` at the
operand's syntactic location, which reports the **asserted** type. So a mixed
conditional selected through its real arms was interrogated with a family pair
taken from an `as` clause that disagreed with them.

Reproduced by compiling and executing (standalone, `experimentalIR`), comparing
against Node:

| source                                                       | Node               | PR head            |
| ------------------------------------------------------------ | ------------------ | ------------------ |
| `typeof ((c ? 7 : "s") as number \| boolean)`                 | `number` / `string` | `number` / **`boolean`** |
| `const v = c ? 7 : "s"; typeof (v as number \| boolean)`      | `number` / `string` | `number` / **`boolean`** |
| `const v = c ? 7 : "s"; const w = v as number \| boolean; typeof w` | `number` / `string` | `number` / **`boolean`** |
| `typeof ((c ? true : "s") as number \| string)`               | `boolean` / `string` | **`number`** / `string` |

The wrong answer is attributable to this route: the same four sources answer
correctly with `JS2WASM_IR_MIXED_PRIMITIVE_CONDITIONAL=0`.

**Fix mechanism** — derive the families from the proof, never from the asserted
union. `exactDynamicPrimitiveTypeofFamilies` now strips the type-erased
assertion wrappers (`unwrapMixedPrimitiveProjection`), follows a local `const`
to its initializer (the provenance rule `makeIrPrimitiveExpressionClassifier`
already applies), and reads `[whenTrue, whenFalse]` off
`proveMixedPrimitiveConditional` — the same proof the carrier's box tags were
emitted from — so the emitted `tag.test` interrogates the then-arm's honest tag.
An operand not backed by that proof returns null and demotes as before. All four
forged spellings now answer exactly what Node answers; the honest spellings
(`typeof (c ? 7 : "s")`, `const v = …; typeof v`, number/boolean, boolean/string)
are unchanged.

### HOLD 2 — a lost proof DEMOTED instead of failing closed

With the prepared proof removed after selection, a selector-claimed function
silently fell back to the legacy compiler instead of raising the promised
`selection-preparation-mismatch` invariant. Measured on the PR head with
`proveMixedPrimitiveConditional` forced to return null (file-copy A/B) and
`JS2WASM_IR_FIRST=0` so a legacy body exists: **`success: true`, a 122 KB binary,
`kind: "unsupported"`, `stage: "build"`, `legacyBodyEmitted: true`** — for the
conditional and for BOTH wrapper consumers.

**Analogous-wrapper audit result: the hole was present, identically.**
`proveExactMixedPrimitiveWrapperCall` returned `null` on a null mixed proof,
which dropped `String(c ? 7 : "s")` / `Number(c ? 7 : true)` into the generic
call path and demoted the whole function with an untyped
`direct call to "String" has no exact AST-site plan` message. It now gets the
same fail-closed treatment.

**Fix mechanism** — split claim from proof. `mixedPrimitiveConditionalClaim` is
the selector's `expr-mixed-conditional-proof` gate restated at build (the
predicate that means "selection already committed this function");
`proveMixedPrimitiveConditional` is the prepared artifact it hands the lowering.
`requireMixedPrimitiveConditionalProof` consumes the proof and, when the proof
is gone while the claim still holds, throws
`IrInvariantError("selection-preparation-mismatch", "build", …)` per the
`STRICT_IR_POSTCLAIM_CODES` doctrine. Both consumption sites — `lowerConditional`
and `proveExactMixedPrimitiveWrapperCall` — go through it. Production behaviour
is unchanged (claim and proof are the same computation); the injection point is
the new `JS2WASM_TEST_TAMPER_IR_MIXED_PRIMITIVE_CONDITIONAL=proof` value, which
models the proof going missing.

### Tests added (both red on the PR head)

- `answers typeof from the arms' real kinds, not a forged assertion` — compiles
  and executes the four forged spellings plus an honest control. Red on head:
  `forgedInline(false): expected 3 to be 2` (it answered `boolean` for the
  string arm).
- `fails closed when the {conditional, String wrapper, Number wrapper} consumer
  loses its prepared proof` — three cases. Red on head: `expected true to be
  false` (the compile succeeded and demoted instead of failing closed).

### Gates re-run for the repair

`tests/issue-5092-…` 21/21 · `#4178` + `#3143` + `#3203` + both `#4787` suites
79/79 · `ir-ternary/if-else/numeric-bool/let-const-equivalence` 73/73 ·
`check:ir-fallbacks` OK · `check:ir-kind-neutrality` OK ·
`check-loc-budget` / `check-func-budget` / `check-coercion-sites` /
`check:oracle-ratchet` / `check:dead-exports` all exit 0, also with
`LOC_GATE_BASE=origin/main` · TypeScript 7 typecheck clean.

`scripts/ir-kind-neutrality-baseline.json` is relocked (two evidence line
numbers in `src/ir/from-ast.ts`, `4502 → 4508` and `380 → 386`) via the script's
documented `--update-on-decrease`. That drift came from this branch's own import
block and was already failing the gate before this repair.

Pre-existing failures observed and confirmed NOT caused by this work (identical
on the PR head and with the route disabled): `tests/issue-1472-es5-getprototypeof`
and `tests/issue-3037-cs1c-getprototypeof-carrier` (4), plus 5 in
`ir-frontend-widening` / `ir-scaffold` / `ir-bytecode-*` — byte-identical
pass/fail sets before and after.
