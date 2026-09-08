Use an explicit, default-off **source-lowering request**, not another `RuntimeManifestPolicy` field. No fast/default equivalence is needed.

Inspected HEAD `1731cf377a9ae3a55af7b9d9447c3b5b2fa144fd`; its `src` is unchanged from published physical checkpoint `0194b64c`.

## API and caller contract

Add to `IrProgramSourceInput` in [program-source.ts:35](/private/tmp/js2-3518-physical-module-completion-20260908/src/ir/program-source.ts:35):

```ts
/**
 * Explicit frontend lowering selection; not provider availability or
 * permission to emit. Omission preserves historical source lowering.
 */
readonly promiseDelayProjection?: "disabled" | "standalone-native";
```

Resolve once before source planning:

- Omitted/`"disabled"`: existing behavior unchanged; no native-delay certification, signature override or support-unit elision.
- `"standalone-native"`: require `policy.backend === "wasmgc"` and `policy.target === "standalone"`.
- Other values or conflicting policy: `PreparedIrProgramInvariantError("invalid-prepared-data", …)`, not fallback to another projection.
- In `prepareWholeIrProgram`, an explicit native request must also reject any requested runtime projection outside that same backend/target. Preserve existing duplicate-policy/source-policy checks.

This is an explicit request to the existing f64, identity-resolved whole-source producer. It does **not** assert equivalence with legacy fast mode, native strings or native-first selection.

No new fields in `TypedIrProgramOptions`, runtime policy, prepared contracts or transport: selection is consumed during AST lowering. The resulting structural runtime reference survives capture/replay; downstream declaration/provider checks remain independent.

Actual caller facts:

- [prepareWholeIrProgram:32](/private/tmp/js2-3518-physical-module-completion-20260908/src/ir/program-preparation.ts:32) already passes the input to source preparation.
- [runIrProgramDriver:22](/private/tmp/js2-3518-physical-module-completion-20260908/src/compiler/ir-program-driver.ts:22) already forwards it through its input spread; **no driver production edit required**.
- There is presently no public compile caller of this driver. Do not invent one for this slice.
- Leave [the public selector’s existing predicate](/private/tmp/js2-3518-physical-module-completion-20260908/src/codegen/index.ts:2947) unchanged. A later public cutover must explicitly resolve its actual switches; it must not derive this request from manifest target alone.

## Source admission and pure validation

Before the signature loop, for an enabled request:

1. Create `makeIrPromiseDelayResolver(checker)` once.
2. Per authoritative source, select only its eligible executable top-level terminal function IDs—not module-init, methods or all support records.
3. Reuse `collectIrPromiseDelayOwners` and `buildIrPromiseDelayLoweringPlans(..., "standalone-native")`.
4. Validate before using certification for either signatures or elision.
5. For certified owners only, set both body result and direct-call result to `{ kind: "extern", className: "Promise" }`. Pass that source’s exact plans to `lowerFunctionAstToIr`.

Near-miss source stays on existing lowering/refusal behavior; a matching function name is never certification.

For validation ownership, use this bounded shared extraction:

- New `src/ir/planning-sites.ts`: relocate the existing `requireExactSourceFunctionOwner`, `exactNodeIsReachableFrom` and `requireExactPlanSiteOwner` from the overlay finalizer. Preserve checks, error class/codes/messages and bodies; export the two required entry points.
- Existing `src/ir/promise-delay-lowering.ts`: relocate/export `validatePromiseDelayPlansByIdentity`, using the shared site validator.
- Existing overlay finalizer imports these implementations instead of retaining duplicates. Its allocation/provider checks stay where they are.

These are **frontend AST-validation modules**, not clean IR-core or runtime contracts.

Add native-only support validation beside the delay-plan validator. It must establish:

- All three site maps contain the same exact plan objects.
- All five certified sites belong to the exact current source/owner body.
- Executor and timer declarations resolve forward and backward through the existing inventory identity maps.
- Both are original nonterminal arrow records with exact source and spans.
- Executor lexical owner is delay; timer lexical owner is executor; both terminal owners are delay.
- Certification preorder ordinals are **not** compared to inventory-local ordinals or used to fabricate inventory IDs.

Keep these checks separate from the shared legacy validator so this change does not newly impose native-elision requirements on host-executor callers.

After lowering, retain both original support records unchanged. Check the produced semantic graph for any reference to either elided support unit—including nested instruction/provider references—and reject dangling references or fabricated derived bodies. Keep existing population validation unchanged; its current call/`closure.new` checks alone should not be described as an exhaustive reference scan.

## Exact bounded write map

Five production paths:

- [program-source.ts](/private/tmp/js2-3518-physical-module-completion-20260908/src/ir/program-source.ts): option, certification integration, certified signatures, native support/post-lowering validation.
- [program-preparation.ts](/private/tmp/js2-3518-physical-module-completion-20260908/src/ir/program-preparation.ts): explicit-request/runtime-projection compatibility check.
- [promise-delay-lowering.ts](/private/tmp/js2-3518-physical-module-completion-20260908/src/ir/promise-delay-lowering.ts): shared plan validator and native support validation.
- New `/private/tmp/js2-3518-physical-module-completion-20260908/src/ir/planning-sites.ts`: relocated shared site checks.
- [ir-overlay-finalize.ts](/private/tmp/js2-3518-physical-module-completion-20260908/src/codegen/ir-overlay-finalize.ts): downward imports replacing the relocated implementations.

Two new focused tests:

- `tests/issue-3518-certified-delay-source-admission.test.ts`
- `tests/issue-3518-certified-delay-source-identity.test.ts`

Reuse unchanged `issue-3520-promise-plan-identity`, `issue-4102-ir-promise-delay-closure-compile-once`, `issue-4573-standalone-native-promise-delay`, typed capture/transport and internal-driver controls. Preserve relocation receipts rather than reseeding them.

Required new controls: default-off versus explicit-on; invalid/cross-policy requests; unchanged EXACT_DELAY source; original/decoded full inventory; same-name owners across two sources and reversed order; missing/swapped support records; stale maps/sites/spans; shadowed bindings/near misses; no fabricated bodies or residual support references.

The immediate expected progress is **source preparation and typed capture**, not successful whole preparation: the canonical runtime catalog currently lacks `__ir_promise_delay_native`, so retain the located `unknown-function-ref`/`resolve` failure until its separate declaration/provider implementation lands.

Full-family `Promise<number[]>` signature and await/vector preparation remain distinct mandatory prerequisites. This contract neither substitutes scalar delay for that family nor changes ABI30, physical acceptance or retirement criteria.
