---
id: 7106
title: "IR: ship the six test262 harness units (assert.js + sta.js) so a fallback-free pass is possible"
status: ready
sprint: current
created: 2026-10-20
updated: 2026-10-21
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: implementation
area: ir
goal: ir-full-coverage
parent: 6920
assignee: ""
---

## Problem

The fallback-free test262 metric (#6806, `ir_only_pass`) counts a pass only
when the compile emitted **zero** legacy bodies. Every test262 test links
`assert.js` + `sta.js`, and on the stacked state of #6806 + #6807 + #6809
(standalone, 2026-10-20 21:13Z) **every** test still carries exactly the same
six legacy units:

| unit | file | reject | what it needs |
|---|---|---|---|
| `assert` | assert.js | `expr-ident-not-in-scope` on `assert` | the function read **as a value** (`assert._toString(...)`, `assert.sameValue = …`) — a function object |
| `compareArray` | compareArray.js (included by most) | same, on `assert` | same |
| `formatIdentityFreeValue` | assert.js | `expr-ident-not-in-scope` on `JSON` | `typeof JSON !== "undefined"`, `JSON.stringify(v)`, `String(v)`, `isNegativeZero(v)` |
| `formatSimpleValue` | assert.js | `expr-ident-not-in-scope` on `Object` | `Object.prototype.toString.call(v)`, `String(v)`, `try/catch` with `err.name === 'TypeError'` |
| `Test262Error` | sta.js | `return-type-not-resolvable` | a **constructor function** (`this instanceof F`, `this.message = …`, `return new F(m)`, `F.prototype.toString = …`, `F.thrower = …`) |
| `<module-init>` | (test) | `body-shape-rejected` | script top-level: `assert.sameValue(...)` calls, `var` initialisers, `Test262Error` prototype/static writes |

Until all six ship IR bodies the metric is 0 by construction, whatever the
test's own code does (addition slice: 45/48 pass, 3 of 9 units IR, 0
fallback-free). Items 2–5 of the #6583 plan are these six units.

## Measured legacy facts (standalone, probes 2026-10-20)

- `assert` as a value: legacy builds a **lazy `$FnObject` global** on first
  use (`global.get N; ref.is_null; if … struct.new $FnObject(ref.func, arity,
  …); global.set N`) plus a property table for `assert.sameValue` etc.; a
  call `assert.sameValue(a, b)` becomes `__extern_method_call(fnObject,
  __new_String("sameValue"), argv)`.
- `Test262Error`: legacy lowers it as a **fnctor** — `$Test262Error (param
  externref) (result (ref null $Inst))` reads `__current_this`, `ref.test
  (ref $Inst)` for `this instanceof Test262Error`, and the caller's `new
  Test262Error(m)` materialises the fnctor's `$FnObject` lazily and calls the
  ctor value. The IR has only planning seams: `IrFnctorAdmission` is pinned to
  the single Acorn shape `fields: [{ input: string }]` (`src/ir/propagate.ts`),
  `phase1FnctorNewExpression` admits exactly that, `src/ir/core/fnctor-abi.ts`
  carries `IrFnctorShape`/`IrFnctorResolution`, and `new F()` on any other
  user function is `constructor-resolution-unsupported` (`expr-new-ctor-unknown`).
- `String(v)`, `JSON.stringify(v)`, `typeof`, `Object.prototype.toString.call(v)`
  are **already host-free** on standalone: legacy calls `__any_to_string`,
  `__json_stringify_root`, `__any_typeof`, `__extern_toString`,
  `__wrap_ctor_String`, `__builtin_static_JSON_parse`… (no imports in the
  compiled assert.js). The IR needs a way to *name* those helpers, not new
  runtime.

## Implementation Plan

Order is by payoff per unit of work; each stage is its own PR, held and
released in order, each measured with `TEST262_PATH_FILTER=language/expressions/addition/`
(48 tests, `ir_only_pass` is the acceptance number).

### Stage 1 — builtin-global reads and calls (items 2; `formatIdentityFreeValue`, `formatSimpleValue`)

1. `src/ir/select.ts` identifier arm (`expr-ident-not-in-scope`): admit an
   unshadowed ambient `JSON` / `Object` / `String` **only** as the receiver of
   the call shapes below (never as a bare value). Reuse the
   `namesHostFreeConsoleSurface` pattern (#4462) — a per-name predicate over
   the parent node.
2. `src/ir/from-ast.ts`: lower `String(v)` → `dyn.to_string` (new dialect
   kind, lowered to `__any_to_string`); `JSON.stringify(v)` (one argument) →
   intrinsic call `json.stringify` → `__json_stringify_root`;
   `Object.prototype.toString.call(v)` → intrinsic `object.to_string_tag` →
   `__extern_toString`; `typeof JSON !== "undefined"` → constant `true`
   (the global exists on every lane; fold at selection like the
   `Infinity`/`NaN` arm of #7104).
3. `switch (typeof v)` with string cases: already Phase-1 shapes
   (`isPhase1SwitchStatement`) once `typeof` is `dyn.typeof` (#7104) — verify
   on the probe, no new work expected.
4. `try { … } catch (err) { if (err.name === 'TypeError') … throw err; }`:
   `isPhase1TryStatement` + `dyn.member_get` on the catch binding; expected to
   pass once `err` is a dynamic binding — verify.
5. Register every new kind in `scripts/check-ir-kind-neutrality.mjs`
   (verdict `js`) and `scripts/lib/check-canonical-ir-dialect.mjs`
   (count + tests `tests/issue-3518-core-nodes-dialect.test.ts`) — #6807 hit
   both gates.

Acceptance: `formatIdentityFreeValue` and `formatSimpleValue` are
IR-emitted in the addition slice (currently 48/48 legacy each).

### Stage 2 — function objects (item 4; `assert`, `compareArray`, `<module-init>` calls)

1. New dialect kind `fn.object{funcRef}` — "the function object for this
   declared function", lowered to legacy's lazy `$FnObject` global (reuse the
   allocator: `ensureFnObjectGlobal`-style helper extracted from the legacy
   materialisation site so both frontends share ONE global per function).
2. `assert.sameValue(a, b)` where `assert` is a top-level function:
   `dyn.member_call(fn.object(assert), "sameValue", args)` → the same
   `__extern_method_call` legacy emits. Property writes
   `assert.sameValue = function (…) {…}` at top level are `<module-init>`
   work: `dyn.member_set(fn.object(assert), "sameValue", closure)`.
3. `assert._toString(x)` inside `assert` is the same read.
4. Selector: an identifier naming a top-level `function` declaration is
   admitted as a VALUE when the enclosing expression is a member call or a
   member write on it (not when passed as an argument — that stays item 4b,
   callback bridging).

Acceptance: `assert`, `compareArray`, `assert._isSameValue`,
`assert.sameValue`, `assert.throws` IR-emitted; `<module-init>` of a test
that only calls `assert.sameValue` IR-emitted.

### Stage 3 — constructor functions (item 3; `Test262Error`)

1. Generalise `IrFnctorAdmission.shape` from the single `[{ input: string }]`
   to `fields: readonly IrFnctorField[]` with `dynamic` field kinds; the
   proof block stays literal-`true` per field.
2. Constructor body lowering: `this` is the instance (reserved struct from
   `IrFnctorShape`), `this.message = message || ""` → `object.set` with a
   `dynamic` field; `if (!(this instanceof Test262Error)) return new
   Test262Error(message)` → `class.instanceof` against the reserved struct +
   fnctor `new` (the `phase1FnctorNewExpression` arm, arguments Phase-1).
3. Prototype method `Test262Error.prototype.toString = function () {…}` and
   static `Test262Error.thrower = function (m) {…}`: Stage-2 `fn.object` +
   `dyn.member_set`; the method body itself is an ordinary function
   expression with dynamic `this`.
4. `throw new Test262Error(m)` in test bodies: fnctor `new` + the existing
   throw lowering.

Acceptance: `Test262Error` and `$DONOTEVALUATE` IR-emitted; first
**non-zero `ir_only_pass`** on the addition slice.

### Stage 4 — script top-level residue (item 5; `<module-init>`)

Whatever `<module-init>` still rejects after Stages 1–3 (probe with
`JS2WASM_IR_SHAPE_DIAG=1` on the slice); expected: `var` initialisers with
object literals (`var obj = {5: kValue, length: 100}`), `Math.length = 1`
style builtin writes, and non-scalar script `var`s (extend
`scriptVarSlotIsSoleHome` from #7105 to `externref` slots on the
compatibility lane, where legacy's widened carrier equals the IR dynamic
carrier).

## Ownership

Per the #6583 plan: Stage 1 and 3 → B (items 2/3), Stage 2 and 4 → Shepherd
(items 4/5). C takes any stage whose owner has not replied by the next
check-in after this file lands, starting with Stage 3 (announced 21:30Z).

## Non-goals

- No JS-host IR paths (standalone + Linear only, per CLAUDE.md 2026-10-10).
- No new runtime helpers: every lowering targets a helper legacy already
  emits on standalone.


## Stage 2 receiving implementation checkpoint

The paragraphs below record the historical core receiving checkpoint, before the bounded RHS and receiver work described in the current qualification update. Their counts, remaining gaps and provider status are historical observations.

Status: core slice passes 94 local controls and current-base quality checks; original harness acceptance remains incomplete.

This slice reuses the exact checker-backed same-source function-binding resolver and its whole-source write census. It admits a stable top-level function identifier only as a property-call or property-write receiver. Local shadowing and reassigned bindings do not authorize a named singleton substitution; general function-identifier arguments remain outside the slice.

A prepared, unit-owned accessor runs the existing canonical lazy singleton allocation kernel, including constructibility, rest and function metadata. IR and direct callers share the same cache and trampoline. The accessor has a distinct Program ABI role; no generic closure allocation or fabricated function-object instruction stands in for this contract.

Calls emit one effectful property Get before the argument list, construct the existing native ObjVec left to right, perform the real IsCallable check after the arguments, then call the existing closure dispatcher with the captured callee and original receiver. Projection adapters change the carrier representation only and do not repeat Get or dispatch a call. The compatibility host path is unchanged.

## Planned validation

- Normal formatting, type checking, inventory, cycle/layer, LOC/function, coercion/oracle checks.
- Whole `tests/issue-7106-stage2-function-objects.test.ts`, existing callable ABI and dynamic member controls.
- The plan's exact 48-file addition sample using `TEST262_TARGET=standalone TEST262_PATH_FILTER=language/expressions/addition/ COMPILER_POOL_SIZE=2 TEST262_WORKERS=2 pnpm run test:262`, after current-main census integration and normal provider readiness. Compare actual per-unit `irBodyEmitted` outcomes for the six harness units and relevant module init; a selector claim or IR label is not a completed body.
- Preserve current protected Test262 population, floors, expected failures and normal CI/queue requirements.

The core slice passes normal type checking, all seven focused cases with genuine prepared-component ownership and no legacy bodies or R2 withdrawals, and 64 additional controls across component dependencies, function metadata, source identity and singleton behavior. Another 23 unchanged controls cover the extracted type-erased-wrapper and super-method operations, for 94 local passes across seven whole test files, without skips or an unhandled-error waiver. These are local controls, not Test262 conformance counts.

Before the structural extractions, a compile-only probe of the unchanged original assert.js, sta.js, compareArray.js and one addition test found nine units, of which only $DONOTEVALUATE was genuinely prepared. The module-init refusal exposes a remaining Stage 2 gap: an untyped FunctionExpression on a certified function-object property assignment needs an exact source-bound canonical closure-signature plan. Stage 1, constructor and parameter-signature dependencies remain separately recorded. The 48-file maintained addition measurement has not run; no 9/6-to-9/4 histogram improvement or fallback-free pass is claimed.

Formatting, lint, type checking, current-base file/function budgets, import cycles and IR layering pass after cohesive extraction into subsystem modules. Dialect, kind-neutrality, oracle, coercion, issue and compiler-boundary inventory checks also passed during qualification; the repository architecture remains incomplete. Normal commit/push hooks remain required. No LOC/function exemption or baseline change is part of this slice. The maintained original-test diagnostic has not run: normal provider preflight rejects the missing QuickJS artifact (37c98432bd22e81a); no substitute provider is selected. No complete IR coverage, Linear backend implementation or full conformance result is claimed.


### Current bounded receiving qualification

The bounded receiving work now includes exact same-source Boolean FunctionExpression RHS plans for stable function-object members, canonical physical signatures and wrapper metadata, prepared dependency evidence, and a narrowly certified member-only initializer. Property writes reuse the existing strict setter only at an authenticated function-object receiver with the genuine non-fast externref carrier. Missing parameter or result evidence declines receiver planning before allocating support; it does not invent a dynamic signature or change generic callback admission. Unsupported, stale, shadowed, reassigned and FAST cases retain their refusal boundaries.

Current focused qualification records 193 passes across 18 whole test files, with nine separate canonical ToNumber controls passing. All 12 scoped quality gates pass. The seven-case HOF/metadata file passed, including the real opposite-body filter/map results, primitive Boolean boundary checks and the independent direct-initializer marker. Its same-module output uses the public compiler's canonical defaultability finalization, retaining the actual source-unit/session allocator lineage, shared wrapper types and final ABI indices. These are bounded local controls, not Test262 conformance or protected-floor counts.

The unchanged four-input original compile-only probe still exposes nine units: only `$DONOTEVALUATE` is genuinely prepared. `isNegativeZero` and `isPrimitive` remain dual with `param-signature-unstable`; six units remain legacy: `formatIdentityFreeValue`, `formatSimpleValue`, `assert` (constructor resolution), `compareArray` (parameter type), `Test262Error` (return type), and module initialization (`closure-return-type`). This does not establish whole-harness ownership, Stage 2 completion, or a 9/6-to-9/4 coverage gain.

The latest maintained addition slice registered all 48 distinct original cases and produced 48 verdicts: 45 pass and the same three BigInt failures, with no compile errors, timeouts, skips or explicit exclusions. All 48 verdicts and unit censuses match the earlier public-core measurement; 44 programs retain the dominant nine-unit/six-legacy/two-dual census. Host-free passes are 45 and IR-only passes remain zero. The scoped run did not promote the historical baseline.

A transparent exact-input selector observation records the original `assert._isSameValue` closure accepted with its real source plan, followed by `assert.sameValue` rejected without one. The observer forwards both original calls and restores the export; its consumer binary and full outcome report match the unobserved probe. This is subexpression-selection evidence; module initialization remains unsupported.

Three unchanged initializer/timer suites produce 53 passes and six failures on both the final candidate and the clean main-based apply-repair control. Those failures and all assertions are retained for CI and owner disposition.

The receiving PR remains held for lead C's dependency and admission order, including the separately qualified apply-preparation prerequisite in #6814. Normal hooks, protected CI and existing floors remain required. No full Stage 2, Linear backend or full conformance qualification is claimed, and no baseline, allowance or architectural exemption is part of this work.
