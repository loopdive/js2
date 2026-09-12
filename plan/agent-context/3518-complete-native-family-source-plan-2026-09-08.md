The next checkpoint should complete **logical source preparation for all five original family functions**, including vectors and main’s operations. It should not import the public allocating type resolver or claim native execution before the remaining runtime declarations and materializers exist.

Grounding: inspected source at `1731cf377a9ae3a55af7b9d9447c3b5b2fa144fd` in the physical checkpoint; source unchanged from `0194b64c…`. Current A/B drafts were not reviewed or assumed integrated. No tests or writes performed.

## 1. Exact contracts to preserve

The unchanged [playground source](/private/tmp/js2-3518-physical-module-completion-20260908/website/playground/examples/js/async.ts) requires:

- `delay(number, number): Promise<number>`: preserve A’s certified delay contract and both support-node identities.
- `fetchUser(number): Promise<number>`: scalar fulfillment.
- Sequential and parallel: `ids: number[]`, **scalar** `Promise<number>` fulfillment.
- `pending: Promise<number>[]`: vector of the canonical async callable result carrier.
- `await Promise.all(pending)`: **logical `number[]` result**.
- `main(): Promise<void>`: two scalar awaits, retained logging/timing operations, final native `undefined`.

Keep fulfillment types separate from callable results:

- Numeric body/result: `irVal(f64)`.
- Numeric vector: `irVec(irVal(f64), nullable)`.
- Pending vector: `irVec(irVal(externref), nullable)`, admitted from the exact ambient `Promise<number>[]` declaration—not an arbitrary `unknown[]`.
- Async direct calls retain `preparedIrProgramCallableResults`’ existing `externref` result.
- Certified delay’s semantic Promise result remains distinct. Its await operand must match that actual result; do not substitute blanket `externref`.
- Main’s body remains zero-result. Do not manufacture a nullable result to represent `undefined`.

Parameters are nullable logical vectors; newly constructed literals are non-null. Preserve that distinction through assignability, capture and replay.

## 2. Reusable implementation—and the actual dependencies to remove

The canonical `irVec`, `irVal`, equality/assignability operations and `IrFunctionBuilder` vector instructions are already allocation-free. Reuse them.

Neither `buildIrUnitTypeMap`/`lowerTypeToIrType` nor `typeNodeToIr` currently supplies the complete vector contract. `closureParameterTypeToIr` also consults physical vector registration; it is not the missing pure producer.

The connected changes are:

- [program-source.ts:218](/private/tmp/js2-3518-physical-module-completion-20260908/src/ir/program-source.ts:218): replace primitive-only handling for the selected family’s signatures with exact logical source types.
- [from-ast.ts:3437](/private/tmp/js2-3518-physical-module-completion-20260908/src/ir/from-ast.ts:3437): annotated and empty vector locals must no longer require `resolveVecForElement`.
- `lowerArrayLiteral`, `lowerPropertyAccess` and `lowerElementAccess` in that file: provide logical paths for construction, `.length` and indexed reads.
- [array-element-lowering.ts:368](/private/tmp/js2-3518-physical-module-completion-20260908/src/ir/array-element-lowering.ts:368): logical `.push` must work without an `IrVecLowering` or physical indices.
- [async-from-ast.ts](/private/tmp/js2-3518-physical-module-completion-20260908/src/ir/async-from-ast.ts): reuse the existing exact await-site and one-argument native `Promise.all` interfaces.

Do not make `resolveIrVecType` return fabricated physical data. Keep its compatibility path intact.

For `.push`, preserve receiver/length/argument evaluation order, exactly-once calls, growth and return value. `pending.push(fetchUser(...))` is effectful: it must not acquire the existing pure counted-push optimization merely because the surrounding loop is recognizable.

For indexed reads, retain index conversion, proven-in-bounds checks and safe out-of-bounds behavior. Do not replace them with unchecked `vec.get`.

## 3. Shared source-to-lowerer interface

Add an explicit, transient logical-vector input to `AstToIrOptions`: a read-only AST-node-to-`IrType` map for source-validated declarations and expressions. Its presence selects the new logical path; existing callers without it retain their current behavior.

The producer must establish:

- Actual checker-bound declarations and call targets, joined to existing unit/source identities.
- Exact ambient Promise/Promise.all ownership; shadowed or unresolved bindings fail.
- Numeric element types and exact pending-vector element contract.
- Five original await sites with separately recorded operand and fulfillment types.
- No physical layouts, type indices, function indices or allocating callbacks.

These AST maps remain frontend-local. Only the resulting ordinary IR, provenance and allocation snapshots cross `captureTypedIrProgramInput`.

Use A’s explicit native delay selection as a prerequisite. Do **not** silently broaden that option into full-family selection. Add a separately explicit full-family projection request, default disabled, requiring the native delay request and compatible standalone/WasmGC policies. This is a proposed next API amendment, not an inferred meaning of `fast`, defaults or runtime policy.

Source eligibility must check the actual dependency closure through the certified delay owner, including support nodes and ambient operations. Function names and matching printed annotations alone are insufficient. This producer does not inherit or clone the legacy context’s WeakMap issuance authority.

## 4. Main belongs in this checkpoint

Vector support alone still leaves the original family incomplete.

Use the existing symbolic contracts in [async-semantic-runtime.ts](/private/tmp/js2-3518-physical-module-completion-20260908/src/ir/async-semantic-runtime.ts) for:

- Clock snapshots.
- Numeric string conversion.
- Console string output.
- Five-part string concatenation.
- Native Promise.all.

Produce exact source-bound targets through the existing prepared-async resolver interfaces.

Two existing lowering placements need correction:

- Prepared console targeting currently sits behind console/host availability checks.
- Prepared number-to-string targeting currently sits behind `hasHostNumberToString`.

Add narrowly validated prepared-target branches before those compatibility checks. Do not advertise nonexistent host capabilities. Retain the original branches and their diagnostics for other callers.

Keep clock operations symbolic; the frontend must not replace `Date.now()` with zero. Keep complete argument evaluation and string construction order.

## 5. Disjoint implementation map and order

### Low A — after its current source-admission freeze

Production:

- [program-source.ts](/private/tmp/js2-3518-physical-module-completion-20260908/src/ir/program-source.ts): logical signatures, node facts, exact calls/awaits and resolver integration.
- [program-preparation.ts](/private/tmp/js2-3518-physical-module-completion-20260908/src/ir/program-preparation.ts): explicit full-family request/policy validation, preserving historical defaults.
- Proposed `src/ir/program-logical-types.ts`: checker/annotation-to-logical-type producer; no physical resolver.
- Proposed `src/ir/program-native-async-source.ts`: source-bound family closure, await and builtin-site facts.

Tests:

- Proposed `tests/issue-3518-native-family-source-contract.test.ts`.
- Proposed `tests/issue-3518-native-family-source-identity.test.ts`.

The two new production modules are frontend implementation, **not clean core/program contracts by folder assertion**.

### Low B — after its current frame freeze

Production:

- [from-ast.ts](/private/tmp/js2-3518-physical-module-completion-20260908/src/ir/from-ast.ts): transient logical-vector option, construction/access paths and prepared main-operation branches.
- [array-element-lowering.ts](/private/tmp/js2-3518-physical-module-completion-20260908/src/ir/array-element-lowering.ts): logical push/element handling.

Tests:

- Proposed `tests/issue-3518-logical-vector-lowering.test.ts`.
- Proposed `tests/issue-3518-prepared-native-main-lowering.test.ts`.

Freeze the shared option first. B can then exercise it with real parsed source and `IrFunctionBuilder`, while A implements its producer independently. Parent composes B’s interface before A’s integration. No concurrent edits to A’s currently owned `program-source.ts`.

No changes are initially required to the canonical callable-result contract, allocation registry, async state producers, provider catalogs or physical layouts.

## 6. State preparation and remaining refusals

Reuse `prepareSuspendingIrFunction`, its sequential/final-main/single-await producers, and the whole-program runtime producer. Preserve every derived body, allocation record, runtime intent and post-freeze attachment.

One census caution: the legacy public suite’s concrete helper counts cannot automatically become typed-entry expectations. The typed fetchUser await can yield an already-typed scalar and permit the existing direct-identity continuation optimization. Logical state count and emitted helper-body count are different denominators. Measure both; never create a dummy continuation to match the legacy count.

Current refusal is measured at the array parameter signature. Following signature repair, source inspection predicts unresolved vector registration/access, Promise.all facts and main-operation lowering. Their exact next diagnostic ordering remains unmeasured.

Beyond source preparation:

- Real delay and Promise.all callable declarations must exist before whole-program runtime-callable validation can succeed.
- Main’s symbolic runtime calls require authentic declarations/providers.
- Numeric and Promise-vector layouts, growth, Promise.all result materialization and await frame transport remain physical obligations.
- Existing physical async refusal must stay until those resources are connected.

Do not insert placeholder declarations, invented providers or fabricated ABI entries to advance a test past these boundaries.

## 7. Acceptance and retained obligations

Immediate preparation controls:

- Both exact original source and the existing export-only runtime variant.
- Original/decoded input × GVN off/on: **eight preparation runs**, reported individually—not eight executions.
- Complete source/support-unit census; five original await sites; allocation and provenance preservation; zero physical indices in logical vector contracts.
- Fresh-process source-free preparation/replay.
- Negative controls for shadowed Promise/Promise.all/Date/console, wrong element/result types, mismatched await operands, stale source ownership and removed support nodes.
- Effectful push, empty vectors, bounds behavior and repeated-call order controls.
- Existing public family suite retained at **14 cases**, unchanged.

Final native execution remains mandatory for all eight behavioral scenarios already represented by that suite: `70`, `3e9`, sequential ordering, parallel ordering, empty inputs, sequential registration failure, parallel registration failure and main’s logs/native `undefined`. Require actual binaries, execution, scheduler observations and original/replay evidence once physical wiring exists.

This checkpoint removes real frontend-to-physical dependencies and supplies the full family’s logical IR. It does not certify missing runtime materialization, public IR-only cutover, strict closure, retirement, or the unresolved ABI 30th witness.
