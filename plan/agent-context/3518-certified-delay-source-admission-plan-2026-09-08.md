# Certified Promise delay source admission

Astra High source-grounded prerequisite specification, recorded by the parent.
Implementation and acceptance remain pending. This complements, and does not
replace, full native async-family preparation and physical runtime materialization.

## Observed blockers

At physical checkpoint `0194b64c246d2b5beab2db00af33a73498e2eb6e`, actual
`prepareWholeIrProgram` on the unchanged `EXACT_DELAY` template from
`tests/issue-4573-standalone-native-promise-delay.test.ts` refuses with
`unknown-class-construction`, detail `unknown class "Promise" in delay`.
Source SHA256: `3339bafcba469f92760d6661a4b1f0fddede19013ceaaeacc088e4b9c9e60002`.
The complete native async fixture independently refuses earlier on the
`fetchAllSequential` signature with `type-resolution-unsupported`.
Neither refusal is runtime acceptance or a reason to reduce the fixture family.

## Source-owned implementation

In `src/ir/program-source.ts`, create `makeIrPromiseDelayResolver(input.checker)`
once per preparation. Collect owners per authoritative source with
`collectIrPromiseDelayOwners`, using that source's actual eligible terminal IDs.
Build the linked maps with `buildIrPromiseDelayLoweringPlans`, then pass those
exact maps through the existing `lowerFunctionAstToIr` `promiseDelays` option.
Do not import context-bearing overlay preparation.

For certified owners only, correct both body-result and direct-call signatures
to the semantic `{ kind: "extern", className: "Promise" }` contract. The current
raw `val.externref` regular-Promise special case is not that contract.

Keep certification separate from native projection selection. Runtime manifest
policy does not encode all public eligibility switches (fast mode, native-first
selection, and module-binding resolution). Resolve any necessary projection
choice explicitly at the source-input boundary; standalone target alone does
not establish public-route eligibility.

## Preserve the complete inventory

The executor and timer arrows are nonterminal support units. The executor's
lexical owner is delay; the timer callback's lexical owner is executor. Both
terminal owners are delay. Join their exact declarations through
`identity.unitIdByDeclaration`, and validate reverse declaration, source, spans,
and ownership. Certification preorder lift ordinals are not inventory ordinals.

Retain both original `allUnits` records unchanged. Emit the owner's certified
runtime call without fabricated executor/timer bodies or derived-unit records.
Require no remaining unit reference or `closure.new` targeting either elided
closure. Existing population rules require bodies for terminals and declared
derived units, not every nonterminal support record; do not weaken those rules.

Before elision, verify all three site maps reference the same plan and all five
certified AST sites belong to the exact owner/source. Preserve the pure checks
currently performed by `ir-overlay-finalize.ts`; bypassing the overlay must not
lose validation. Prefer reusing existing certification and lowering unchanged.

## Required acceptance

- Use the unchanged `EXACT_DELAY` source, retaining its full original inventory,
  including both arrows, through original and decoded capture.
- Require one certified owner call, two numeric operands, and semantic Promise
  result; no fabricated lifted bodies, dangling references, or extra closure
  allocations.
- Reject near-miss syntax, shadowed bindings, wrong captures, cross-owner maps,
  and missing support records as evidence for certification/elision.
- Verify same-name owners in two sources remain independently identified.
- Retain the actual next refusal: missing canonical declaration/provider must
  not become fabricated preparation success.

Minimal initial scope is `program-source.ts` and focused source/capture tests.
Any extraction of pure validation needs separate review. Runtime declarations,
physical runtime resources, and prepared-frame execution remain subsequent
required work, not implied by admission.

## Independent full-family dependency

The unchanged fixture's `fetchAllSequential(ids: number[]): Promise<number>`
first fails on its array parameter, not an array return. Both sequential and
parallel owners return numeric Promises. Parallel additionally needs the local
`Promise<number>[]` vector and the `number[]` result of `await Promise.all(pending)`.
These require logical vector typing for signatures and await/body typing.
The current `checkerScalar` await resolver is insufficient. Do not reuse
public `resolvePositionType` wholesale: some branches allocate physical vector
types through compiler context. Complete logical vector/async preparation stays
in scope alongside certified-delay admission and the frame-body implementation.
