# Next clean IR-core type slice — Astra High advisory plan

This is the next dependency-cohesive implementation plan for #3518, not a
dispatch or completion claim. Astra High inspected lowering checkpoint
`c257b46620fb4996bf5233763b80298c1fd03dc6`, ABI checkpoint
`c3afa4389469e55d434c0715698dc59c6caa9120` and the preserved P/C drafts.
The startup-contract source map is disjoint. All implementation must use a
reconciled Astra Low native worker and be published through a checkpoint PR.

## Why full nodes cannot move yet

`src/ir/nodes.ts` imports async-plan, whose graph reaches AST-bearing identity.
Dialect types reach counted-string provenance and AST lowering plans. Fnctor
shapes and capability provenance also reach mixed identity modules.

`PreparedIrAsyncRuntime` in `async-plan.ts` carries exact manifest/provider
objects, backend requirements, layouts and selected capability records.
Moving only its outer interfaces preserves the wrong dependency. The later
full-node split must extract the transitive manifest/intrinsic/capability data
schemas from selection, validation and construction. Preserve
`preparedManifestByPlan`, currentness guards, provider identity/order and codec
reauthentication. Do not substitute `unknown` or weaker structural attachments.

Do not create a partial `core/nodes.ts`: that would risk falsely satisfying
the explicitly unfinished whole-node destination. The next coherent slice is
actual IR type construction and equality in `core/types.ts`.

## Exact next source map: ten files

Five canonical extractions, each with explicit old-path compatibility imports
and re-exports. Preserve runtime object identity, not forwarding wrappers.

1. `src/ir/nodes.ts` -> new `src/ir/core/types.ts`: the ten type/shape
   declarations through `IrType`; `IR_CLASS_SHAPE_CELL`; nine functions
   `irVal`, `irVec`, `irFnctor`, `asVal`, `irDynamic`, `irTypeEquals`,
   `classShapeEquals`, `closureSignatureEquals`, `objectShapeEquals`; their
   three private equality helpers and `activeFnctorPairs`. Keep one shared
   recursion guard and one canonical symbol, without eager old-path imports.
2. `src/ir/fnctor-abi.ts` -> new `src/ir/core/fnctor-shapes.ts`: exactly
   `IrFnctorField`, `IrFnctorCapture`, `IrFnctorShape`. Keep validators and
   resolvers in place, redirecting their existing equality/type imports to core.
3. `src/ir/value-references.ts` -> new `src/ir/core/value-references.ts`:
   all four declarations, preserving their types and nominal identity.
4. `src/ir/capability-provenance.ts` -> new
   `src/ir/core/capability-provenance.ts`: all three declarations, importing
   the canonical F0 brand types rather than AST-bearing identity.
5. `src/ir/tag-domain.ts` -> new `src/ir/core/tag-refinement.ts`: only
   `TAG_ID_BRAND`, `TagId`, `tagRefinementEquals`, with one brand declaration.

Leave `IrInstr`, `IrFunction`, async attachments, dialect assembly and traversal
in the old nodes module. Leave `irValSigned` and `isDynamic` unchanged: the
High inspection found no production calls. An unused import is not liveness
evidence; moving those exports would create unresolved caller obligations.

The High in-memory projection resolved 8 modules / 12 edges / zero unresolved
imports. Its only runtime import is tag-refinement equality; shape recursion
is type-only. No frontend, provider implementation or compatibility facade was
reachable in that projection. This is not executed candidate validation.

## Parent integration and acceptance

- Require all five destinations in `scripts/compiler-boundaries.json` while
  preserving any already-landed ABI/startup activation entries. Keep the
  unfinished `core/nodes.ts` destination explicit. The approved standalone
  layering plan permits pure Wasm-model imports; the current `ir-core` matrix
  omits that edge. Reconcile this precise policy discrepancy without allowing
  backend, physical, frontend or legacy imports.
- `scripts/check-ir-kind-neutrality.mjs` must retain its existing instruction
  population and three excluded references, following canonical declarations.
  Relocate the two evidence citations for `IrObjectShape` / `IrClassShape`.
  Do not reduce the verdict or denominator.
- Extend the existing moved-reference auditor additively for the ten moved
  functions. Missing destinations or removed/renamed real consumers must not
  deactivate obligations. Preserve all N1 strict unknowns and approved
  preservation-versus-retirement distinctions. Do not count class/declaration
  visitation as real public-root reachability.
- Add `tests/issue-3518-core-type-seam.test.ts` and focused boundary and
  kind-neutrality evidence controls. Prove actual old/new function and symbol
  identity, opaque brands, recursive equality, signedness and default-argument
  semantics. Preserve attachment references and builder/verifier/fnctor calls.
- Run focused standalone byte/order/value parity on explicit base/candidate
  source revisions. Inspect actual LOC/function deltas; transfer an allowance
  only if necessary and with exact body/span receipts. No budget baseline
  edits, growth credit or duplicate implementation.

The ten source paths do not intersect the inspected P twelve-file draft, C's
dirty consumer/planner, the published lowering/ABI maps or the startup source
map. This is not claim clearance: fetch the live assignment ledger, reconcile
historical owners and exact paths, and retain all drafts before dispatch.
Shared policy/gate edits remain serialized by the coordinator. No new host or
linear implementation, public cutover or direct-handler deletion is included.
