---
id: 6866
title: "IR source maps: project authenticated source-point data to physical UTF-16 positions"
status: done
sprint: current
created: 2026-10-06
updated: 2026-10-06
assignee: ttraenkler/codex-ir-source-map-position-projection-20261006
branch: codex/6866-current-main-finally-composition-20261006
priority: high
horizon: medium
complexity: M
feasibility: hard
reasoning_effort: high
task_type: feat
area: ir, source-maps
language_feature: compiler-internals
es_edition: multi
goal: ir-full-coverage
lane: ir
model: gpt-6-astra
parent: 6865
depends_on: []
files:
  - tests/helpers/ir-position-finally-main-successor.ts
  - tests/helpers/ir-position-finally-main-successor.json
  - tests/issue-6866-finally-main-inventory-successor.test.ts
  - plan/log/ir-delivery-handoff-20261006.md
  - src/ir/program/source-map-position.ts
  - tests/issue-6866-source-map-position-projection.test.ts
  - scripts/compiler-boundaries.json
  - tests/helpers/ir-source-map-position-inventory-successor.ts
  - tests/helpers/ir-source-map-position-inventory-successor.json
  - tests/issue-6866-source-map-position-inventory-successor.test.ts
  - tests/issue-3518-canonical-3c6-inventory-successor.test.ts
  - tests/issue-3518-canonical-489d-inventory-successor.test.ts
  - tests/issue-3518-current-main-inventory-successor.test.ts
  - tests/issue-3518-lowering-analysis-preservation.test.ts
  - tests/issue-3518-nested-stackification-policy-evolution.test.ts
  - tests/issue-3518-number-prerequisite-policy-evolution.test.ts
  - tests/issue-3518-program-data-contract-boundary.test.ts
  - tests/issue-3518-program-validator-policy-evolution.test.ts
  - tests/issue-3518-runtime-data-contract-seam.test.ts
  - tests/issue-3518-runtime-program-policy-evolution.test.ts
  - tests/issue-3518-semantic-provider-boundary.test.ts
  - tests/issue-3518-validation-policy-evolution.test.ts
  - tests/issue-3518-wasmgc-helper-policy-evolution.test.ts
  - tests/issue-3518-well-known-symbol-policy-evolution.test.ts
  - tests/issue-3525-arraybuffer-isview-main-policy.test.ts
  - tests/issue-3525-main-inventory-source-successor.test.ts
  - tests/issue-3525-presentation-classification-policy.test.ts
  - tests/helpers/ir-c1-authority.json
  - tests/helpers/ir-c1-authority-root.ts
  - tests/issue-3518-c1-current-source.test.ts
  - tests/helpers/ir-position-class-fields-main-successor.ts
  - tests/helpers/ir-position-class-fields-main-successor.json
  - tests/issue-6866-class-fields-main-inventory-successor.test.ts
---

## Problem and scope

The physical source-map pipeline needs an efficient requested-only conversion from already validated original source-point data to physical SourcePos|null. This new pure program leaf resolves exact catalog IDs/map names and UTF-16 line/column coordinates. Generated origins stay null and unknown/malformed joins fail explicitly. A utility cannot authorize a public compilation or emission by accepting a catalog/owner pair; real issuance/currentness belongs to the existing private owner and stays a separate integration dependency.

## Authority and ownership

Official claim6866 is atomically allocated and verified on upstream/issue-assignments, with healthy open-PR scan. Fresh base42d289a96f2c757e4286a57e97f0bfe743b29868 is main; it adds only npm compatibility artifacts to the encoder component's6128dd8 base. The new source/test files have no existing implementation. Preserve root's separate incomplete6865 encoder worktree and the dirty primary Deno worktree. Shared PR6341 compiler/lowerer/Promise files are outside this writer scope. The source worker owns only the new leaf; an independent worker owns only the new test. Astra owns the issue implementation plan; root owns integration, actual gates/budgets/claims and publication. Writers are not alone and must not revert other edits.

## Acceptance

- Efficient source catalog/donor indexes and CR/LF/CRLF/LS/PS UTF-16 tables, allocated only for this requested conversion; no default-path work/global cache or repeated full-source scan per point.
- Exact original source filename/text association and descriptor-first primitive/range/owner/source validation before coercion or string operations. Preserve original and analyzed span data; no guessed line zero/null fallback for an invalid source point.
- Separate generated null data semantics from permission to mint an authenticated context or publish a module. Do not add an authority registry/caller callback/self-hash publication capability.
- Independent character-offset oracle, non-BMP/newline boundaries, rewritten text, multi-source donors/derived owners and generated origins; capture actual original API-absence evidence separately from candidate guards. At least one genuinely captured SourceFile/checker catalog fixture through createPreparedSourceMapProjector; DATA math alone is insufficient.
- Preserve no-map/source preparation defaults, source bodies, canonical receipts, private presentation guard and old compiler. Test actual native gates and measured finite costs; full migration/performance/physical ownership remain open.

## Implementation Plan

### Frozen API and ownership (2026-10-06)

Implement only the new `src/ir/backend/source-map-position.ts`; the independent test owner implements only `tests/issue-6866-source-map-position-projection.test.ts`. Existing contracts, validators, preparation, lowerers, codecs and public exports remain outside this component. The source owner may use private helpers in the new leaf, but must not change this API to fit a test:

```ts
export interface IrSourceMapPositionInput {
  readonly sourceMap: IrPreparedSourceMap;
  readonly inventory: Pick<IrUnitInventory, "sources" | "allUnits">;
  readonly derivedUnits: readonly ProgramAbiDerivedUnitRecord[];
}
export interface IrSourceMapPositionProjector {
  project(ownerUnitId: IrUnitId, origin: IrSourceMapOrigin): SourcePos | null;
}
export function createIrSourceMapPositionProjector(
  input: IrSourceMapPositionInput,
): IrSourceMapPositionProjector;
```

Use type-only imports from `shared/contracts/ir-unit-inventory.ts`, `shared/contracts/ir-identity.ts`, `ir/program/abi.ts` and `wasm/model/instructions.ts`. The complete existing inventory can be passed without reshaping; its `classes` and `terminalUnits` are not consumed. Runtime dependencies may be the existing pure `PreparedIrProgramInvariantError` in `ir/program/errors.ts` and canonical `createDerivedIrUnitId` in `shared/contracts/identity-values.ts`. Do not import TypeScript, the full validator, preparation, a backend emitter or an authority owner at runtime. No Wasm instructions are emitted by this utility.

Factory construction snapshots the consumed primitive data into private indexes and line tables. Calls return a fresh ordinary `{file, line, column}` record for a source origin and `null` for an admitted function-owned generated origin. No mutable input record/array is retained as lookup authority; changing input data later cannot change an existing projector's results. A new construction checks the changed data again. This is snapshot behavior, **not** stale-context detection or an emission capability. The returned object exposes only `project`; there is no global cache, registration, token, publication callback, reset or public compiler option. Construction is explicit and requested-only; this issue adds no call site to either compilation path.

Use `PreparedIrProgramInvariantError` with code `invalid-prepared-data` for the refusals specified below, with messages beginning `source map position:`. Tests bind to the type/code and relevant diagnostic category, not the exact entire prose. Do not interpolate a malformed value into an error, stringify user objects, coerce IDs/numbers, or call their methods to describe a failure.

### Precisely divided validation responsibilities

This leaf validates the **data that it consumes** and the owner/source joins used by projection. Its typed input is a catalog and population already checked by the actual preparation owner. Passing arbitrary typed-looking data to this factory does not establish those preconditions. Keep the distinction visible in its API documentation:

| Independently checked here | Remains a caller/preparation-owner precondition |
| --- | --- |
| Required consumed own data properties; primitive domains; closed source-map/origin/point records; dense consumed arrays; source population order/identity/name joins; unique original/derived IDs; explicit parent provenance and donor grants; point ranges and frame/cause joins | Actual inventory was produced from the current source/checker and agrees with the actual IR population, ABI and preparation transaction |
| Original/analyzed text are primitive strings; projection has the declared envelope and a dense `stages` array | Every stage/edit is well formed and replayed; producer admission, removed text, complete text coverage and stage composition are valid |
| Point mapping is `exact` or `rewrite`; both spans fit their respective captured texts | Reversing analyzed spans through all stages yields the declared original span and mapping; this leaf does not replay transformations or manufacture original coordinates |
| Non-module-init donor declaration containment; nonempty module-init exception described below | A module-init span outside its declaration is in an actual validated startup occurrence; complete startup plans remain with their owner |
| Generated phase/role, current owner and cause; original-unit insertion restriction | Async origins have that actual function's async plan; origins are attached to actual instructions/terminators/updates; no site has missing coverage or contradictory diagnostic coordinates |
| Structural lifting donor grant and inherited clone ancestry | Grant names one actual derived function and is used by its body; all functions/buffers are acyclic and the full source-map population passes `assertPreparedSourceMap` |
| Snapshot data consistency | Currentness, component/body slot, source-view identity, physical recipe/resource ownership, final offsets, one-shot emission and publication |

`src/ir/program/validation.ts:681` (`sourceMapPoint`), `:725` (`sourceMapGenerated`), `:769` (`assertSourceMapSite`), `:841` (`assertPreparedSourceMap`) and `:891–986` (derived donor joins) are the governing behaviors. Do not invoke the complete validator for each instruction. Do not relax it as part of this issue. In particular, acceptance of a data-only async origin by this utility is not evidence that an async function was prepared or admitted. Tests must label those cases DATA and retain genuine producer controls separately.

### Descriptor-first input and index construction

For every record this leaf examines, first require an ordinary object with `Object.prototype` or null prototype. Obtain properties via own data descriptors before reading their values. Reject accessors, missing required properties and explicit `undefined` on consumed optional fields; reject boxed primitives before arithmetic, lookup, slicing, comparison or interpolation. This is not a promise to sandbox Proxy traps. On the closed records listed below, reject unknown string keys and symbols as well. Arrays consumed here must be actual ordinary arrays with `Array.prototype`, dense own data indices and no extra own keys besides `length`; reject holes, accessor indices and extra/symbol keys before walking their values.

The factory input is closed with exactly `sourceMap`, `inventory`, `derivedUnits`. The inventory is a **projection view**, not a second closed full-inventory validator: require own data `sources` and `allUnits`; leave unrelated inventory fields unread. Inventory source and unit records likewise permit the other real contract fields, whose semantics this leaf does not use. Inspect only the fields explicitly consumed below through descriptors; an unused diagnostic/class/legacy field is not read or interpreted. This avoids incorrectly rejecting the real terminal/owned/unowned union or pretending to validate it fully.

1. Catalog: closed `schema`, `sources`, optional `derivedSources`; schema exactly `prepared-ir-source-map-v1`. Catalog source rows are closed `sourceId`, `sourceKey`, `originalFileName`, `mapName`, `projection`. IDs must be nonempty primitive strings. Source keys, original filenames and map names must be primitive strings (do not invent a nonempty filename rule absent from the source contract). Require the same count and order as `inventory.sources`; corresponding own data `id`, `sourceKey`, `originalFileName` must equal the catalog fields, and `mapName === sourceKey`. Reject duplicate source IDs or map names, even for unused rows. Never derive a source ID from a display name or path substring.
2. Projection envelope: closed `originalText`, `analyzedText`, `stages`; both texts primitive strings; `stages` dense as above. **Do not inspect stage element payloads** or copy/replay stage text here. Their complete validation is an explicit precondition above. Snapshot original text (or its line starts and length), analyzed length, map name and identity. Never substitute analyzed text or `originalFileName` for the map name/content association.
3. Original units: consume own data `id`, `sourceId`, `kind`, `lexicalOwnerId`, `terminalOwnerId`, `terminal`, `declarationStart`, `declarationEnd`, and optional `syntheticRole`. IDs/source IDs are nonempty strings; owner IDs are null or nonempty strings; `terminal` is boolean; kind is a current `IrUnitKind` literal. Optional synthetic role is a nonempty primitive string; actual synthetic-role admission remains upstream. Declaration endpoints are safe integers with `0 <= start <= end <= analyzedText.length`. Index all units once; reject duplicate IDs and unknown sources. A terminal unit has its own ID as terminalOwnerId; non-null terminal owners resolve to an original terminal unit in the same source. Lexical IDs may name actual classes outside this projected inventory; do not globally require every lexical ID to resolve as a unit. The lifting-grant walk below requires the specific unit chain it uses to resolve.
4. Derived units: closed `id`, `parentId`, `terminalOwnerId`, `sourceId`, `role`, `ordinal`; primitive nonempty IDs/role, null-or-nonempty terminal ID and nonnegative safe-integer ordinal. Check canonical ID against `createDerivedIrUnitId` **after** primitive guards. Do not parse an ID to infer provenance. Reject duplicate/colliding IDs, missing parents and parent cycles using an indexed traversal. Require known source, parent's source and terminal owner equality, and any non-null terminal owner to name an original terminal unit. This follows `ProgramAbiMap.registerDerivedUnits` (`src/ir/program/abi.ts:580–660`); semantic role admission and actual body population remain upstream. A clone may parent another clone or a lifted derived unit; preserve the whole explicit chain.
5. Optional `derivedSources`: if present, nonempty dense array of closed `{unitId, donorUnitId}` rows; unique derived unit key and a resolvable original donor. Require the target derived record's role `lifted-closure`, donor kind in `arrow-function`, `function-expression`, `object-method`, `object-getter`, `object-setter`, and equal source and terminal owner. Follow the donor's original lexical unit chain until it intersects the target's explicit derived-owner ancestry (target plus derived parents); every intervening node must be unique, present, same source/terminal owner, and noncyclic. Reject an unresolved/class-only or null-ended chain that never joins. Require rows in the order of their target records in `derivedUnits`. Distinct lifting targets may legitimately grant the same donor; do not make donor IDs globally unique. Actual function existence and non-unused grants remain upstream checks.

Empty valid populations are permitted and produce a projector that rejects every owner lookup; they are not positive coverage. No constructor output may be published until all consumed rows have passed these checks. A bad late unused row cannot be hidden by an earlier successful lookup.

### Exact per-origin projection

Validate the primitive nonempty `ownerUnitId` and resolve it uniquely in the original/derived index before selecting any origin branch. Its allowed donor chain is the owner itself and its explicit derived-parent ancestry only; an original unit's lexical parent is **not** automatically an allowed source donor. A donor is allowed if it is one of those IDs or is the original donor granted by `derivedSources` at one of those IDs. This preserves a clone of a lifted function without minting a new grant or changing its primary source point.

Source origin is closed `{kind: "source", point, inlinedAt?, contributors?}`. Point is closed `{sourceId, donorUnitId, analyzed, original, mapping}`; each span is closed `{start,end}`. IDs are nonempty primitive strings and resolve to the catalog and an **original** donor unit whose source matches. Both spans have safe integer bounds `0 <= start <= end <= correspondingText.length`; zero-width/EOF points are legal when otherwise valid. Mapping is exactly `exact` or `rewrite`. For ordinary donors, the analyzed span must fit declarationStart/end. For `module-init`, permit an out-of-declaration span only when nonempty; its exact startup-occurrence proof is the previously stated caller obligation, not something inferred from source membership. Do not extend that exception to other donor kinds.

Validate every supplied primary, inline and contributor point, even though only the primary produces a position. Optional chains must be nonempty dense arrays. Reject repeated point values within either chain or a point equal to the primary, using a key constructed only from validated primitive fields (source ID, donor ID, both spans, mapping). As in the current validator, the two optional chains have separate duplicate sets; a contributor may also occur in `inlinedAt`. Across primary plus inline frames, donor IDs must be distinct (no cyclic inline chain). Contributors need valid source/donor/range data but need not belong to the emitting owner's ancestry.

For an inline origin, require the **last, outermost** inline frame's donor to be allowed for the emitting owner; without inline frames require the primary donor to be allowed. Do not reject legitimate cross-source inlining merely because the callee-primary donor differs from the emitting owner. Return the position of `point.original.start` in **that primary point's source**, never of the outer call frame, a contributor, the analyzed span, or the emitting function's source. Keep all input points/spans/mapping values untouched.

Function-owned generated origin is closed `{kind: "generated", phase, role, ownerUnitId, cause?}` with exact phase roles:

| phase | roles |
| --- | --- |
| frontend | insertion, implicit-return, binding-scaffold, control-scaffold |
| middleend | cfg-scaffold, representation-scaffold |
| async | state-dispatch, frame-access, capability, continuation |
| backend | control-scaffold, abi-scaffold |

Its owner must exactly equal the current project argument and be indexed. Frontend insertion additionally requires that owner to be an **original** unit with a present nonempty syntheticRole, retaining the actual existing restriction: a derived descendant is not made eligible by its parent's role. If cause exists, validate its whole point and allowed donor join before returning null. A malformed or unrelated cause cannot disappear behind an early null return. Do not use cause as a physical mapping. Unknown variants/phases/roles, extra fields, missing owner, or explicit undefined fail. `support` and `startup` origins fail explicitly as requiring their actual physical ownership issuer; this function-owned API has no recipe binding or startup-plan input and must not return null for them. Their later integration is retained in the parent DAG, not a reason to stall this complete leaf.

### UTF-16 coordinates and finite costs

Construct line starts from each original text exactly once per projector: initial start 0; CRLF is one terminator with the next line starting **after LF**; lone CR, LF, U+2028 and U+2029 each start a new line after themselves. All offsets and columns count JavaScript UTF-16 code units, including each surrogate unit; do not use code-point iteration. A point at CR or at the LF inside CRLF still belongs to the preceding line (LF's column is one larger than CR's); a point after LF belongs to the next line at column zero. EOF after a final terminator belongs to its empty final line. Empty text has line 0 column 0 at offset 0. Select the greatest line start <= original.start by binary search; return zero-based line and `start - lineStart`. No repeated prefix slicing/splitting.

Use source/unit/derived/grant Maps built once, with iterative or bounded indexed graph traversal that explicitly detects cycles. Target construction cost is O(total original text length + source/unit/derived rows), plus the necessary explicit ancestor/lexical walks for donor grants; document that additional depth cost rather than claiming linear work if ancestry is copied quadratically. Per projection is O(number of supplied points + chain lengths + owner depth + log(original line count)), with no whole inventory/text scan. Compute the emitting owner's ancestry once per projection, not for every contributor. A private request-local memo may be used if it does not retain mutable caller objects or impose an unbounded all-pairs ancestry table. Do not cache by filename globally. No implicit construction is added to sourceMap:false/default code paths.

### Independent test contract and release sequence

Root captures the actual missing-module/API baseline before source creation. Missing API is a recorded failing original expectation, not a skipped body or a swallowed import. Source and independent test writers then work from this frozen API in parallel and own separate new files. Neither writer changes contracts, tests owned by the other, source preparation or private guards to make their implementation pass.

Required decisive test families in the new file:

1. **Genuine source capture:** use the actual checker/SourceFile fixture, `buildIrUnitInventory`, `buildIrPlanningIdentityContext`, and `createPreparedSourceMapProjector` from `src/ir/program-source.ts`, following `tests/issue-3525-source-map-source-capture.test.ts:46–85`. Select an actual expression node inside a function, require the producer returns `kind: source`, and pass its real catalog, inventory and site origin to this utility. Assert exact map name and independently counted original UTF-16 position with nonzero line/column. Include two actual sources with distinct text/paths and same display-name functions. Report observed source-point count with a positive floor. Do not invent a catalog row and call it frontend capture.
2. **Rewritten genuine point:** retain the real define-substitution capture pattern and actual stage data from the existing source-capture tests; select a captured source point whose analyzed and original offsets differ, require the producer's genuine rewrite/exact classification, and assert the original coordinate and exact original source association. If a specific expression projects as generated/unmapped, preserve that result and choose an actual admitted source expression; never relabel it. Data-only text math cases supplement this producer control.
3. **Independent coordinate oracle:** expected offsets from explicit literal indices and a small character-by-character oracle independent of the production table/binary search. Exercise LF, CR, CRLF (both internal offsets), LS, PS, empty text, trailing newline, zero-width EOF, non-BMP characters and offsets on either surrogate code unit. Validate ranges against both texts. Use genuine inventory donors that cover each chosen test span or explicit DATA fixtures; do not hide invalid donor containment.
4. **Owner joins:** original owner, canonical one/multi-level monomorphization-derived owner, lifted donor grant then derived clone of it, duplicate/unknown/cyclic/cross-source/terminal-mismatched provenance, invalid grant order/role/lexical join. Canonical IDs in healthy DATA fixtures come from the real identity constructor. Include a healthy restore after malformed variants and ensure no inputs are mutated.
5. **Inlining and causes:** legitimate cross-source callee primary with outer frame belonging to emitter maps to callee; reject unrelated final donor, cyclic inline donor chain, empty/sparse/accessor chains, repeated point, bad later frame or contributor. Confirm valid contributors do not replace primary. Each admitted generated phase returns null; frontend insertion retains original synthetic restriction. Valid generated cause still returns null; malformed or unrelated cause refuses. Reject startup/support, missing owner and extra outer line/column. Async cases here are DATA, not evidence of an actual asyncPlan.
6. **Descriptor/numeric refusal:** constructor late-row and per-call cases for boxed string/number, accessor required field/index, inherited required field, null/primitive record, foreign prototype, sparse/extra-key array, symbol/unknown key on a closed record, unknown source/donor, duplicate source/map name/unit, NaN/infinity/fraction/unsafe/negative/out-of-bounds/reversed spans, wrong map/schema/mapping/role. Getter/valueOf/toString sentinels remain uncalled for ordinary objects. Do not demand Proxy trap invisibility or full stage/body validation from this leaf. Confirm genuine full inventory's unrelated fields are not read.
7. **Snapshot and cost controls:** alter caller source strings/rows after a healthy construction and show the old projector retains its original snapshot while a new projector observes/refuses the altered input. Fresh returned position objects cannot corrupt later calls. Exercise repeated points in a realistically long multiline original source and a multi-source population; report factory vs repeated-projection timings/counts without a fragile wall-clock threshold or fabricated speedup. Static inspection plus repeated-coordinate correctness must confirm no per-point text split/full-population scan.

Root runs the new test and relevant existing source-capture/frontend-origin/validation tests with explicit Node25 and captures file/commit/runtime pins. Native compiler controls remain genuine unchanged existing fixtures using their emitted import object. This leaf neither changes generated Wasm bytes nor fixes the parent public compile fixture failures; do not claim otherwise from DATA joins or isolated native controls. Original absent-API evidence and candidate guard results have separate denominators.

### Dependencies and retained migration gates

This child is independently implementable now: it does not edit PR6341's `lower-contracts.ts`, `wasmgc-emitter.ts`, `lower-generic.ts`, `integration.ts`, compiler/context/index/async-frame files or the primary dirty files. No lowerer authority ownership release is inferred. The parent issue6865 frozen physical plan remains governing for the next steps: genuine source/preprocessing catalog handoff; authenticated current function/slot context issuance by the existing preparation owner; support/startup and both backend/async producers with actual ownership; source-to-physical scopes and masking; final original-content association; real complete offset/content/ABI/materializer/acceptance receipts. Merge/composition of the delivered PR6341 branch belongs to root after its owner's handoff, not a duplicate implementation here.

This new leaf's measured intersection is limited to its direct contract/type imports and existing invariant error/identity primitives; it adds no existing runtime caller. No blanket reseal of unrelated public/backend authorities or future hash is justified by a plan. Root determines the actual changed-file gate consequences after source freeze. Preserve the private Prepared source-map presentation guard, all original public missing-source failures, default routing, old/public paths and semantic/artifact/performance equality requirements until the full genuine producer and physical pipeline closes them. Completion of this issue authorizes only this data projector's tested implementation.


## Publication metadata and exact inventory successor (2026-10-06)

Root reports the frozen source `9ce746c9` and test `872b6201` passing 104/104 plus five native source gates and core/dead preservation. Retirement remains strictly OPEN. The boundary checker reports one actual inventory error, `unclassified-module: src/ir/backend/source-map-position.ts`: 1,838 discovered modules versus 1,837 registered rows. Root preserves the raw report and runs inventory mode. These are component results, not public source-map completeness or retirement evidence.

### One classification row, no activation change

The new leaf has two value imports: foundation `shared/contracts/identity-values.ts` and ir-program `program/errors.ts`. Its catalog/identity, program ABI and Wasm SourcePos imports are type-only. It has no concrete backend choice, AST/checker access, emission or public preparation authority. Its canonical destination is therefore **ir-program**, whose existing allowed edges cover foundation, ir-program and wasm-model. `ir-core` would not permit the real program/errors value dependency. A backend-wasmgc destination would incorrectly assign backend-neutral prepared-source data projection to a concrete backend.

At its frozen `src/ir/backend/` path it is outside active ir-program roots (`src/ir/program`). `check-compiler-boundaries.mjs:442–452` requires every clean row to be inside its declared active root. Do not label it clean or extend roots/entries/activation merely to make this component gate pass. Add exactly this inventory row adjacent to the existing backend rows, at a measured stable position:

```json
{
  "path": "src/ir/backend/source-map-position.ts",
  "state": "unmigrated",
  "layer": "mixed-needs-split",
  "destination": "ir-program",
  "owner": "3518-coordinator",
  "nextBoundary": "Place backend-neutral prepared-source position projection under the canonical ir-program owner; preserve the frozen data-only API and both backend consumers. This inventory row does not authorize context issuance or physical emission."
}
```

This records pending canonical placement, not a newly alleged semantic defect or an exemption from current guards. Preserve every existing row and order, all layer roots/status/entries/minModules, allowedEdges, activationHistory, evidence, moves, frontend wrappers and eligibility. The expected inventory delta is exactly one new module/row; no source move or source/test modification is authorized here. Keep the actual full raw policy predecessor before editing.

### Grounded predecessor chain and finite proof component

The current policy is 588,351 bytes, SHA256 `4b442f641a2a99fd4abffc5ef85271858f4a3ae2337fcde8c380fba076a22d05`, Git blob `c5da824f89dded25e85e7e315825d2d61d97f906`, with 1,837 rows. It is already bound by **`tests/helpers/ir-main-inventory-source-successor.ts` and `.json`**, not directly by the October 2 receipt. This newer helper proves eleven additions in eight source spans back to 1,826 rows. Its current complete helper is independently pinned in `tests/issue-3525-main-inventory-source-successor.test.ts:301–319`; preserve that helper and receipt exactly.

`ir-runtime-program-policy-main-inventory-20261002.json` is an older fixed four-row epoch within the downstream chain (1,780 to 1,782 rows), implemented in `ir-runtime-program-policy-evolution.ts:2140+`. Preserve it and all its historical pins, declarations, helper prefixes and semantic algorithms. Updating that receipt to describe today's 1,838 rows would conflate epochs and invalidate its evidence.

Use a **new one-row test-only successor**, not a general normalization or multi-hash allowance:

- `tests/helpers/ir-source-map-position-inventory-successor.ts`
- `tests/helpers/ir-source-map-position-inventory-successor.json`
- `tests/issue-6866-source-map-position-inventory-successor.test.ts`

The helper exposes raw and semantic entry points `captureSourceMapPositionInventoryPredecessorPolicySource(raw, readAuthority?)` and `captureSourceMapPositionInventoryPredecessorPolicy(value, readAuthority?)`, returning exactly the preceding 4b442f64 policy text/data. It accepts only the one newly measured current epoch. The old epoch is an output, never an alternative accepted current input. Keep these functions separate from the existing eleven-row helper and from production source code.

Root freezes the policy row first, then independently measures current raw bytes/SHA/blob, parsed whole-data digest, files digest/count, exact inserted row index/neighbors and UTF-8 span coordinates. Record the complete old/current profiles and unchanged non-files profile in the new receipt and independently fixed helper/test literals. No future pin is supplied by this plan. Prove exactly one row addition and raw forward/inverse whole-file replay, semantic removal/reinsertion and agreement between parsed raw predecessor and semantic predecessor. Reject unknown/missing/reordered/duplicated row, changed retained field, altered activation/edge/eligibility, wrong raw bytes and wrong receipt. Authenticate authority fresh on every operation; validate primitive inputs/descriptor-safe semantic data before coercion, retain raw supplied operands, and preserve ordinary nested record prototypes required by the existing downstream semantic adapters. Do not regenerate JSON as a substitute for the exact old raw policy.

The independent new proof obtains actual current policy bytes and uses separately fixed insertion coordinates/row/profile expectations, never the helper's output or receipt contents as its oracle. Include healthy→mutated→restored raw and semantic inputs, changed/missing authority, boxed/accessor inputs with untouched coercion sentinels, altered retained rows/non-files fields, duplicate row, shifted/reordered insertion and old-as-current refusal. Preserve complete old/current custody and positive row floors. The test-only helper/receipt require no compiler module row.

### Reader adaptation: actual dependencies, not assumed eleven-file scope

Source census finds **17 candidate test readers** containing the actual policy read plus a predecessor chain. This is a static reachability list, not proof that all 17 need edits or that all were previously green:

- issue-3518-canonical-3c6-inventory-successor.test.ts
- issue-3518-canonical-489d-inventory-successor.test.ts
- issue-3518-current-main-inventory-successor.test.ts
- issue-3518-lowering-analysis-preservation.test.ts
- issue-3518-nested-stackification-policy-evolution.test.ts
- issue-3518-number-prerequisite-policy-evolution.test.ts
- issue-3518-program-data-contract-boundary.test.ts
- issue-3518-program-validator-policy-evolution.test.ts
- issue-3518-runtime-data-contract-seam.test.ts
- issue-3518-runtime-program-policy-evolution.test.ts
- issue-3518-semantic-provider-boundary.test.ts
- issue-3518-validation-policy-evolution.test.ts
- issue-3518-wasmgc-helper-policy-evolution.test.ts
- issue-3518-well-known-symbol-policy-evolution.test.ts
- issue-3525-arraybuffer-isview-main-policy.test.ts
- issue-3525-main-inventory-source-successor.test.ts
- issue-3525-presentation-classification-policy.test.ts

Root's previously identified eleven readers must be reconciled with this census using actual source read paths and before/after rows; do not quietly broaden a reported denominator. Existing examples such as `issue-3518-current-main-inventory-successor.test.ts:44–56` read current policy directly into the older isView chain and already lack the eleven-row outer adapter. Record any such pre-existing failure separately. The new row alone cannot be credited with causing or fixing it.

At every actually affected **initial healthy capture**, wrap the actual source/data with the new one-row inverse before the existing eleven-row inverse, then retain the existing historical chain. Where the latter is already present, add only the new outer call. Where a reader is demonstrably missing the existing eleven-row step, that reader adaptation must explicitly add that already-delivered proof step as a prerequisite and retain its original failing baseline. Do not edit the old inverse algorithms or receipts. The eleven-row helper's own independent test should use the new authenticated one-row predecessor only for its initial historical fixture capture; keep its eight spans, eleven rows, helper/receipt pins, all historical guards and original failure codes unchanged. New proof tests separately mutate the true current1838 inputs.

Preserve raw filesystem reads for authority checks and fresh-current corruption tests. Inject old semantic/recipe mutations **after** the complete initial projection, into the exact epoch their immutable expected coordinates/pins describe. Do not send those mutants through a healthy normalizer again. Every old negative keeps its paired healthy prerequisite and intended guard; an earlier new-epoch refusal is not credit for a later historical guard. Count exact actual read channels and retain all original test names/denominators. Test owners require explicit root scope before changing any existing reader; this plan does not transfer ownership of the frozen6866 source/test.

### Measured authority intersections and publication gates

Among those 17 candidates, current `ir-c1-authority.json` binds exactly four as current instruments and existing edit recipes: number-prerequisite-policy-evolution, program-data-contract-boundary, runtime-program-policy-evolution, and well-known-symbol-policy-evolution (all issue3518 test files above). If an actually required reader edit touches one of them, root updates only that measured current-instrument pin and its existing immutable-artifact→live recipe, proving exact full inverse/replay. Unedited candidates require no pin change. Preserve all historical artifacts and before pins, all non-target manifest fields and unrelated authority. Finish with the actual new manifest digest/anchor and independently fixed external scalar observation using the reviewed finite successor procedure. Compose with any separately delivered6865 initial-graph instrument successor; never overwrite that peer's final recipe. No implementation or source-map source leaf is added to C1 historical population by this registration.

Additional authority readers are expanded only upon a concrete direct read/pin intersection. The new helper/proof is not a pretext to reseal program ABI, source-map schema, runtime policy history, compiler emitter artifacts or Deno integration. Root owns metadata/receipts/manifest publication; source and original104-test files remain frozen.

After the exact row and proof freeze, required evidence for a ready component PR is: native `check:compiler-boundaries` and `check:compiler-boundaries:inventory` with 1,838 registered/discovered modules and no inventory/edge/activation regression; the new independent policy proof plus actually affected reader suites and any measured C1 successor suite; the original104 projector tests and existing relevant source-capture/validation controls; standard source gates (`check:import-cycles`, `check:flat-dir-budget`, `check:loc-budget`, `check:func-budget`, formatting/lint/type checks as actually required by hooks); preserved core/dead-export gates; and the normal production `pnpm run build` (Vite library build, declaration pruning, test262 CLI build). Use explicit Node25, actual command exit codes and retained row counts; existing completed gates need repeat only when their inputs changed. Native value controls continue using genuine compiler output/importObject, not DATA projection as a compilation substitute. Record strict retirement as OPEN rather than suppressing its failure or changing its baseline. No package publication is implied by preparing the PR.

The five public IR source-map gaps, full physical coverage, context issuance and old/public path retirement remain separate. Root reports the Deno owner has now released nine files with conflict review; root's isolated PR6341 refresh/composition can proceed independently and does not expand this metadata writer's scope.


### Canonical placement amendment — supersedes the unmigrated-row proposal

Root subsequently authorized considering a canonical move of this new, unpublished leaf instead of retaining the originally assigned backend path. **Use `src/ir/program/source-map-position.ts` and a clean ir-program row. The earlier backend-path unmigrated row is withdrawn and must not be installed.** No public compatibility path exists, and the frozen module has no production caller; the source census found only the two module lookup strings in its independent test.

This is the correct existing architectural domain: the implementation projects prepared source-catalog/owner data, joins `ProgramAbiDerivedUnitRecord` lineage and reports `PreparedIrProgramInvariantError`. It does not analyze optimization facts, execute an IR pass, select a backend or emit instructions. The active ir-program root already includes `src/ir/program`; its existing allowed edges include foundation, ir-program and wasm-model. All actual value and erased type imports fit those edges. The alternative analysis location is not appropriate: ir-analysis permits foundation/ir-core/wasm-model, but not the actual program error or ABI dependency; its existing roots also do not include this new file. Do not create new allowances to fit it there.

Root may release exactly this transport to the owners, preserving the preceding frozen source/test as immutable local evidence:

1. Source owner moves the new file from `src/ir/backend/source-map-position.ts` to `src/ir/program/source-map-position.ts`, changing exactly two import literals: `../program/abi.js` to `./abi.js`, and `../program/errors.js` to `./errors.js`. The other four imports have the same relative depth and remain byte-identical. Preserve every implementation declaration and API export. No old-path re-export, barrel change, compatibility adapter, new registration or behavior edit.
2. Independent test owner changes exactly the two occurrences of `../src/ir/backend/source-map-position.ts` to `../src/ir/program/source-map-position.ts` (current lines11 and13: eager import.meta.glob argument and lookup key). Retain all104 test cases, assertions, inputs, names and oracles. Preserve the original absent-API run as evidence for the initial path; do not rewrite its historical logs.
3. Root verifies byte-for-byte inverse transport against the frozen source/test pins, exactly two substitutions in each file, old source path absent/new source present, unchanged module export/API shape, then records actual new pins and repeats the104 native tests and relevant gates. Update this issue's owned-file metadata and writer grants to the canonical path before publication. The move is authorized only after root dispatch, not by this architect performing filesystem changes.
4. Register exactly `{"path":"src/ir/program/source-map-position.ts","state":"clean","layer":"ir-program"}` in the existing files list. Leave roots, entries, minModules48, activationHistory and allowedEdges unchanged. The already-active directory governs all its modules; adding an entry/activation record is unnecessary. The inventory remains one net new module/row (1,838), with no stale backend-path row.

The new one-row successor/proof recipe above now binds this clean canonical row and its actual insertion position, not the withdrawn backend row. All historical1837/1826/October2 receipts and fields remain unchanged. The same reader census, actual-before/after failure attribution, finite current-instrument intersections, source gates and production-build requirements apply. Canonical placement eliminates this new path debt; it still conveys no public source-map coverage, context issuance or retirement credit.


### Integration checkpoint before final runtime delivery

The canonical transport is complete: exactly two source import literals and two test lookup literals changed, with byte-for-byte inverse equality to the original frozen files. All104 original cases pass unchanged. The normal production build passes, including declaration pruning and both test262 CLI outputs. The one-row inventory registers1,838 modules and passes the required inventory mode with errors=[]; strict complete architecture remains explicitly open. Historical1837/1826 policy receipts are unchanged.

The metadata adapter preserves all17 original test ASTs except initial epoch captures/imports, across24 measured initial read channels. Its actual original baseline is889pass/1,544fail out of2,433, with failures in10 suites; these are recorded original failures rather than candidate regressions. The new independent proof ran23cases successfully before its equivalent lint correction and is being rerun after the final seal. Root installed the independently Astra-reviewed finite C1 successor with only four current-instrument pins and their existing recipes changed. All10 full inverses/replays,12 current pins,11 immutable authority files and7 historical artifacts were verified; the existing independent scalar changed only its manifest/anchor observations. The final manifest is405,820 bytes/SHA25651ae067a17aeaad95417c8fbb3b7443c2a0952cd35a568934e55cec1755328f0. No6865 unmerged model/initial-graph authority was copied into this worktree.

The post-seal17-reader, new-proof and C1 runtime is still active; no final pass count, commit, PR or main delivery is claimed at this checkpoint. Source/projector tests and all physical fault operands remain held for exact custody verification. Full public source-map coverage, emission context issuance, mapped-path performance equality and old compiler retirement remain open.


## 2026-10-06 actual semantic-provider fixture closure prerequisite

### Attribution, ownership and measured inputs

Root's completed postseal run remains2797/2799, including C1343/343, new inventory proof23/23 and17 policy readers2431/2433. All889 originally passing reader cases remain passing;1542 formerly failing rows now pass. The remaining two rows were originally blocked at the earlier isView epoch and now reach a latent healthy fixture defect. Do not label them as producer/projector regressions on the strength of the newly visible diagnostic.

Both failing rows are in `tests/issue-3518-semantic-provider-boundary.test.ts`: `loads the complete actual canonical type-and-value closure` and `rejects a backend implementation dependency from the frontend formatter contract`. The file's actual population is352 cases (350 pass/2 fail). The second fails at its healthy `f.run()` prerequisite before the intended backend dependency mutation. Its negative guard therefore has not yet been exercised in this postseal run.

**Implementation ownership is this one test file only.** Its measured before pin is66877 bytes/SHA256 `9a7628225ec1a2a09ed422a534b978ee8b064ac5365e2aebd47980c5171db49e`. Do not edit program/input, validation, producer, projector, policy, classifier, schema, C1 helpers/manifest or any original receipt. The semantic-provider test is outside the current12-instrument C1 population; current path census finds no C1 recipe/authority intersection. This one-file repair needs no C1 reseal. Preserve root's allModelFrozen and postseal custody evidence; do not rerun the full2799 population without an actual new input intersection.

The architect inspected and copied actual sources into ignored `.tmp/6866-semantic-closure-spec` fixtures and invoked the real Node25 boundary CLI. No tracked test/source/policy was altered. The original test's exact policy() composition, layer projection, tsconfig, resolver, source bytes and CLI flags were retained; only the local fixture's declared source population differs between checkpoints. Original policy/C1 receipt readers were consumed read-only. A preliminary VM attempt was refused for foreign prototypes; the recorded successful measurements use same-realm authenticated policy values, not a relaxed descriptor checker.

### Actual cause and finite source closure

`fixture()` around920 copies the174 paths in liveRequired into a fresh filesystem root and declares only those paths clean. The actual `src/ir/program/input.ts` line7 has the value import `assertPreparedSourceMap` from `./validation.js` and calls it before allocation restoration. validation.ts is absent from the fixture. The ordinary checker correctly reports unresolved-module and forbidden-transitive-path. This case claims **actual** canonical source closure; projecting input.ts to an older source epoch or erasing its value import would falsify that claim.

Using the detector's own reference parser for both type and value references, followed by actual native CLI runs, gives:

| actual copied population | modules | resolved edges | type-only | runtime | actual result |
| --- | ---: | ---: | ---: | ---: | --- |
| existing live fixture | 174 | 783 | 404 | 379 | exit1: unresolved input→validation and its transitive violation |
| add validation.ts only | 175 | 802 | 411 | 391 | exit1: nine further direct missing validator dependencies plus transitive paths |
| complete bounded validator closure | 205 | 977 | 476 | 501 | exit0, errors[], all edges resolved/allowed |

Full reports and commands are `old174.stdout`, `validator-only.stdout`, `complete205.stdout`, `cli-review.json`; `closure.json` records all reference paths and actual31 source hashes. The added dependencies use five already-existing clean layers and existing rules. No new allowed edge/root/activation rule is required. The exact31 additions are:

- **ir-program** (10): `src/ir/program/validation.ts`, `src/ir/program/runtime-abi.ts`, `src/ir/program/class-layouts.ts`, `src/ir/program/allocations.ts`, `src/ir/program/runtime-support-dependencies.ts`, `src/ir/program/runtime-validation.ts`, `src/ir/program/owner.ts`, `src/ir/program/draft-abi-lookup.ts`, `src/ir/program/runtime-demands.ts`, `src/ir/program/runtime-manifest.ts`.
- **ir-core** (7): `src/ir/core/global-binding-keys.ts`, `src/ir/core/type-binding-keys.ts`, `src/ir/core/declared-types.ts`, `src/ir/core/tag-domain.ts`, `src/ir/core/fnctor-abi.ts`, `src/ir/core/string-runtime.ts`, `src/ir/core/runtime-symbols.ts`.
- **ir-runtime** (5): `src/ir/runtime/verify.ts`, `src/ir/runtime/producer.ts`, `src/ir/runtime/js-tag-domain.ts`, `src/ir/runtime/generator-support.ts`, `src/ir/runtime/intrinsic-preparation.ts`.
- **foundation** (3): `src/shared/contracts/ir-counted-string-site-id.ts`, `src/shared/contracts/ir-preparation-errors.ts`, `src/shared/contracts/string-surrogate.ts`.
- **ir-analysis** (6): `src/ir/analysis/dominance.ts`, `src/ir/analysis/ownership.ts`, `src/ir/analysis/escape.ts`, `src/ir/analysis/encoding.ts`, `src/ir/analysis/alloc-verification.ts`, `src/ir/analysis/lattice.ts`.

This is10 ir-program,7 ir-core,5 ir-runtime,3 foundation and6 ir-analysis modules. Their respective fixture populations change32→42,21→28,15→20,6→9 and5→11. Other layers are unchanged. The independent recursive census had no unresolved remainder; the real complete205 CLI passed. These are necessary dependencies reachable through the validator from the existing174 roots, not a copy of every program/runtime/analysis module. Do not make the permanent fixture discover its expected population dynamically from imports or policy; keep an explicit independently reviewed31-path table.

### Exact test-only implementation and retained old counts

Preserve `historicalGroups`, `groups`, `required` and their106-entry assertions/digests/history checks byte-for-byte. Preserve the current174-entry table as an explicitly named prior live fixture population (for example `priorLiveFixtureGroups` and `priorLiveRequired`). Add one fixed `sourceMapValidatorFixtureAdditions` table with the31 paths above, then construct the complete liveFixtureGroups by appending each layer's exact addition list. Check the prior list has174 unique paths, additions have31 unique disjoint paths, final list has205 unique paths, and final minus additions equals the complete prior ordered per-layer population. No population floor or `.toBeGreaterThan` replaces exact counts.

`fixture()` continues copying every declared file from the actual repository without rewriting its contents. Its existing local policy generation already derives entries/minModules/files/activationHistory from liveFixtureGroups; reuse it. No permanent policy change or historical activation change is involved. The source content reported by the real detector must match the actual copied205 modules; a new positive control may compare each report module hash against its actual repository file. Do not classify a file as clean merely because it was discovered: use the five explicitly reviewed classifications above.

Update only the actual-complete closure assertions to205 modules and977/476/501 edges. Keep the106 specification population and174 prior live population asserted. The previous782/403/379 edge literals are not the current174 census: read-only extraction of the actual historical source tree where those literals were introduced, e4737c9f1dcb632c56f3cc3a31e3ad47cd7f848e, reproduces exactly782 edges (403 type/379 runtime). Comparing every one of those174 modules' reference lists finds precisely two added edges and no removed edges:

- `src/ir/core/nodes.ts` → `src/shared/contracts/ir-unit-inventory.ts`, type-only import; both were already in the174 list, producing the current extra resolved type edge.
- `src/ir/program/input.ts` → `src/ir/program/validation.ts`, runtime import; this is the formerly unresolved edge that opens the31-module closure.

Evidence is `old-edge-delta.json`. Retain the original782/403/379 assertion as an explicitly bounded **edge-population projection**, not an assertion that current source is historical: from the final actual report select edges whose endpoints are both in priorLiveRequired, require783/404/379, independently require exactly the new nodes→inventory type edge, remove only that unique edge from this report-derived population and require the original782/403/379. Do not rewrite either source module, its graph role, or any historical receipt. This preserves the original edge oracle and also pins the actual delivered schema dependency. Separately require the unique input→validation runtime edge in the full graph and the complete194-edge increment from783→977 (72 type/122 runtime).

Factor those exact live-closure checks into a small file-local assertion helper only if reused by the new causal control. It must assert error-free graph completion, exact module set/layer membership and exact edge counts, not just exit0. Original historical case titles and populations remain. Existing fault matrices iterate their unchanged original arrays; do not expand all their rows to205 or add31 duplicate mutation cases merely because fixture data grew.

### Required causal and old fault controls

Restore the healthy prerequisite in the existing formatter-negative case, then retain its exact original `@forbidden` type-export injection and expected frontend-ts→backend-wasmgc forbidden edge. The actual copied205 probe demonstrated healthy exit0; after this original mutation,206 modules/978 edges yield exit1 and the intended forbidden-clean-edge/transitive diagnostics; after restoring source/policy,205/977 is healthy again. Reports are `original-formatter-negative.stdout` and `restored.stdout`; no source bytes outside the ignored root were touched.

Add exactly one separately named causal case, e.g. `rejects bypass of the actual input-to-source-map-validator dependency`. Start from the complete healthy205 fixture and run the same exact closure assertion. In the **fixture copy only**, remove the actual single `import { assertPreparedSourceMap } from "./validation.js";` line; then separately try its type-only spelling, restoring between variants. Require the fixture's closure assertion to reject each variant for its actual missing runtime edge/count, and require successful full restoration. This is a graph-integrity control, not a claim that the boundary checker validates executable reference semantics. Actual measurement shows removing the import still yields checker exit0 but only976 edges (476 type/500 runtime) and no input→validation edge. Therefore exit0 alone would silently accept this bypass; the explicit source-edge and exact count guards are load-bearing. Do not count a policy/schema error as the intended refusal.

The two original failing cases must now pass under the same titles. The original352 names/registrations must be retained, with exactly one additional causal case for353 total. Preserve the former350 passing outcomes and all original targeted diagnostic assertions. No skip, expected-failure marker, early return, conditional assertion or catch-all report filtering is allowed. A healthy validator-only175 fixture still fails and is useful retained diagnosis evidence; the permanent fixture must include the complete31, not bless that incomplete checkpoint.

### Bounded acceptance and effect record

Source-copy custody confirms all205 files in the restored complete fixture equal their actual repository bytes; see `custody.json`. Implementer should freeze the changed test and compare every other previously frozen input unchanged. Run the two original failing cases plus the one new causal case first using the existing Node25/Vitest configuration; then run this one full353-case test file. Preserve its original postseal352-row record and report a name-by-name comparison. Run the normal checks applicable to this test-only edit. Do not rerun all2799 tests, rebuild production or rewrite inventory/C1 authorities merely to restate already retained evidence; revisit them only if an actual input intersection is discovered.

The final effect report must keep the prior full run's2797/2799 result as historical evidence and state this bounded successor independently (352 original cases plus one new, with the two repaired healthy prerequisites). Do not claim a newly executed2800-case full run. This closure repair grants no production eligibility, default-route, source-map completeness, private Prepared guard or retirement change.


## Fresh delivered-main 6844 row composition, fixed outer successor (2026-10-06)

Publication preflight found actual delivered main `cdc0255882d45181072342d9fd57f291aca93092`, after merge input `abb3471c46bb9e7129b28812fe16313c857cda69`. PR6524 delivered issue6844's externref-backed class field initializers. PR6521 is still not an ancestor; do not use its prepared source as main. Neither existing branch policy proof may be published pretending its synthetic merge omits the new main row. Root preserves both prepared branches; it creates the position component's fresh composition worktree from exact cdc and integrates the Deno branch through a checked checkpoint and real main merge. This appendix authorizes metadata implementation after that source composition, not a source overwrite by the metadata owner.

### Exact new main input and two candidate policies

Read-only evidence is `.tmp/pr6341-main6844-spec/review.json` and the two ignored `*-combined-policy.json` files in the PR6341 worktree. The actual abb→cdc policy diff is **one 328-byte insertion**, with all other raw bytes identical. The row is:

```json
{"path":"src/codegen/classes/externref-class-fields.ts","state":"unmigrated","layer":"mixed-needs-split","destination":"backend-wasmgc","owner":"3518-coordinator","nextBoundary":"Separate AST/context-driven generation, physical resources and generated native runtime."}
```

It sits between `src/codegen/error-subclass-proto-chain.ts` and `src/codegen/class-proto-toplevel-write.ts`; both full neighbor rows are unchanged. Original main is 1837 rows / 588351 bytes / SHA256 `4b442f641a2a99fd4abffc5ef85271858f4a3ae2337fcde8c380fba076a22d05` / blob `c5da824f89dded25e85e7e315825d2d61d97f906`. Delivered cdc policy is 1838 rows / 588679 bytes / SHA256 `e91199cafc1788a5e976e29553b0c093a28c53fd7e2dcc3d806c8559c3f9547e` / blob `6066caa751c06e8726076ee622311f509bdd5f77`. Its added row index is 1647 and raw before/after insertion offset is 542771. Preserve the exact indented insertion and trailing comma/newline from actual main; do not serialize the whole policy or sort rows.

| Lane | Own frozen policy (the output of new outer inverse) | Combined current candidate | Added-main row index / UTF-8 offset |
| --- | --- | --- | --- |
| PR6341 | 1855 rows; 594018 bytes; `59752f826a8a2298966e4bbae6ec29e15a168f7e45fb58379dbb923ccd2f2694` | 1856 rows; 594346 bytes; `4ee416b75193d78ec696ac0d21e9328cee842602f6926cf3223e6de0dc703f7a`; blob `e70ee1b32f53de5d5935aa0ac52987959effc64a` | 1664 / 548059 |
| Position component6866 | 1838 rows; 588471 bytes; `a2e9c7243c13ae37b293f02ae19eba03f072db30195ce0479f0926488fa3de98` | 1839 rows; 588799 bytes; `3d497f1ec140ecd7056155e6e0a993801e126b93304af1a581820d779a979122`; blob `9c248ee6471ee50973d5da74ba2d7d06e9eee92f` | 1648 / 542891 |

These candidate bytes were constructed and inverse-checked in ignored evidence; they are not an installed merge result. After the actual merge, independently verify the final policy equals the corresponding candidate. If it differs, stop at the measured difference rather than changing a pin to whatever happened to merge. Deno compact data/files hashes are `5f5afeb67c06edff1727dedda43820f8a66b92f8b3351b9e5a81d264822396c7` / `fb880095aab466a486a6b34d17c2f9587a89fa11c87d77f68bc25b938bf187e9`; position hashes are `8c91785b4302f8f9b88641f325643e374484b54909c3bbc086c0456b5a6bdc9a` / `7ede92f695b2c32bbc8cb5dea5e59a3e2f89a24bf37852f757866601ad01a62a`.

### Finite implementation, separate ownership per worktree

Add a **new outer one-row proof**, preserving each existing own-step helper and receipt byte-for-byte. Use distinct files to avoid sibling lane authority collisions:

- PR6341: `tests/helpers/ir-deno-class-fields-main-successor.{ts,json}`, `tests/issue-4376-class-fields-main-inventory-successor.test.ts`. Export `captureDenoClassFieldsMainPredecessorPolicySource` and `captureDenoClassFieldsMainPredecessorPolicy` (raw string / descriptor-validated data channels).
- Position component: `tests/helpers/ir-position-class-fields-main-successor.{ts,json}`, `tests/issue-6866-class-fields-main-inventory-successor.test.ts`. Export corresponding `capturePositionClassFieldsMainPredecessorPolicySource` and `capturePositionClassFieldsMainPredecessorPolicy`.

Each helper has exactly one admitted current profile and one output profile from the table, and exactly one known main row/index/neighborhood and raw span. It freshly authenticates its own independently pinned complete receipt on each operation, using the already reviewed fixed-successor descriptor-first patterns. Validate primitive raw input and plain owned dense data before coercion/getters; retain raw/data/files/full-before/full-current hashes, exact top-level keys, every non-files field, detached output, complete one-span inverse and forward replay. No generic row finder/remover, glob, optional historical success, mutable registration, accepted-hash union, or cached proof. Keep current raw corruption distinct from historical operand mutation.

The new receipt also binds the exact **delivered-main lineage witness** above (abb/cdc identities, old/main complete pins, the main index/offset and identical 328-byte insertion). Independently prove that applying that insertion at 542771 to the complete original1837 text returned by the unchanged own step yields the exact delivered cdc raw pin. Thus the outer row is demonstrated to be delivered main, not merely a convenient row omitted from a candidate. No old artifact is rewritten or added as fictional current source; no network/Git lookup is needed inside the production test helper.

The Deno own eighteen-span receipt remains 27453 bytes / `b35c6b605ea4fd36f7c5cb2a4b46aff8eee49de4cfb675aa78a0d1dc5934e7d9`. The position own one-span receipt remains 2437 bytes / `b2afd57a2583d7a103b07ce1bcc577475023ee29f54ee433f115a6fcf43572b0`. Retain their helper bytes and complete independent expected profiles/spans. The common eleven-row `ir-main-inventory-source-successor` and every earlier authority remain unchanged.

For each lane's existing seventeen historical readers, wrap the **actual current operand** immediately inside the own-step inverse: `older(main11(ownStep(newMainRow(actual))))`, omitting only stages the particular independent historical proof deliberately constructs itself. The earlier exact 24-site census (19 raw, 5 semantic) governs; do not run a broad text replacement over mutation operands. The same four C1 reader files intersect. Preserve current source-reader fixture fixes, all old names, all receipts and intended guard diagnostics.

Adapt the own-step independent proof at its healthy current capture only: Deno `healthy()` currently ~737; position `independent()` currently ~117. Feed the freshly authenticated outer inverse result into all unchanged own-step profiles, original inverse/replay, authority trace and historical mutation controls. Add separate new outer tests over **actual combined raw/data**; do not make own-step tests silently accept a second epoch. Preserve Deno's 32 original proof cases and position's 23 original proof cases.

**Important physical-fault staging:** Deno's original physically-corrupted-full-policy case (~985) currently writes actual policy and invokes the own-step helper directly. Simply wrapping that faulted read in the new outer inverse would fail at the wrong guard; directly passing the combined profile to the old helper would fail even without the mutation. Preserve its old assertions and authority read counts by first obtaining the authentic own1855 operand through healthy outer capture, placing those exact full bytes in an isolated temporary policy file, then performing the same physical corruption/read/restore against that old-step operand. The own helper must see and reject the actual mutated file bytes. Preserve the original case identity; document its authentic own-step epoch. New outer proof separately performs corruption of the actual combined policy/authority after a genuine healthy capture, checks its precise failure and fresh read count, restores exact bytes, then proves healthy again. Do not project a corrupted actual current policy into a healthy old copy. Other historical semantic/raw mutants remain downstream of healthy capture, never passed through the current-only outer inverse.

The new independent proof must cover at least: exact combined→own→1837→delivered-main lineage/replay; unchanged1837 rows/non-files; missing/duplicate/renamed/moved/changed-profile main row; mutation of a retained own row; wrong-lane own-only/delivered-main-only inputs; raw prefix/tail/whitespace changes; malformed/boxed/missing fresh receipt; descriptor getter/coercion/sparse refusal; real physical current-policy and authority corruption followed by restoration. Record actual case denominators after collection; no invented future count or replacing old cases. Bind the new formatted helper completely in the independent proof.

### Actual source composition and C1 boundaries

Delivered cdc changes only two compiler source files: `class-bodies.ts` and new `classes/externref-class-fields.ts`. The new leaf is 5377 bytes / SHA256 `684aef792a744e765fbedef53131fe10b5438dcad9329cd86d148d79632ac51f`. Delivered `class-bodies.ts` is 231067 bytes / `bbe97df68729bde304d434bd76f592a6352861b0b47e6d33f8ef4051a3de9eb0`; use it as the main-side donor, not as the required composed Deno file hash. Its actual additions are the canonical leaf/type import, native string helper import, `emitExternrefFields` injecting existing operations, and once-only initialization routing for externref-backed non-collection classes. Preserve Deno callback/class state and the true before-super fix in composition. Never replace the whole composed class file with main. The position worktree starts on cdc and already owns this delivered source. The delivered five-case `issue-6844-error-subclass-field-initializers.test.ts` is 4988 bytes / `8dcc4c011175023c3d968b436fe39954a50c777f22799fb386d08b504b1cce53`; retain it unchanged and run its actual JS-host controls together with the Deno/class native preservation gates after source merge. No metadata helper may stand in for that source composition.

Neither new main compiler path belongs to the measured C1 source population/LinearOptions closure. Recompute the explicit intersection after merge; do not invent a new model/source seal. Only four existing reader instrument pins/recipes change again: data-contract-boundary, runtime-program-policy-evolution, well-known-symbol-policy-evolution, number-prerequisite-policy-evolution. Start from each lane's own current manifest: Deno now 405616 bytes / `085828915a6b2e531fcc283168bb371552df2fb025658f70065eb20d64a128df`; position 405820 bytes / `51ae067a17aeaad95417c8fbb3b7443c2a0952cd35a568934e55cec1755328f0`. Do not copy the other lane's manifest.

Root reseals only four current pins and their four existing recipes after final reader formatting, proving every unchanged immutable beforePin and all ten full inverse/replays. Keep seven artifacts, eleven immutable authorities, twelve instruments, ten recipes, all remaining fields and original declarations exact. Update anchor and external independentFreeze's manifest/anchor fields last with outside-scalar bytes exact; no source helper or old authority edits. The main eleven-row receipt, own eighteen/one-span receipts and prior full helper profiles stay immutable. New helper/proof tests are separately authenticated, not appended to a historical fixed instrument population.

### Release and validation order

1. Root completes the in-flight frozen native cohort before any source merge or physical source/policy fault. Preserve its exact inputs/results. Make the normal checked local Deno checkpoint, merge exact cdc, and resolve actual source/metadata conflicts with both old-main and Deno behavior preserved. For position, transport only its exact own component/adapters/approved fixture delta into the new cdc composition worktree; retain the old worktree as custody evidence.
2. Per-worktree Sol metadata owner installs only the combined policy/new fixed outer proof, 17 operand-site adapters and own-proof capture/fault-stage adaptations. Source remains root-owned. The candidate policy must match the measured table; no original1837 row/rule/activation change. Run new proof plus retained own-step 32/23 cases and exact real compiler-boundary inventory/normal mode. Counts are Deno1856 / position1839 classified modules, not the prior1855/1838. Do not confuse classified modules with raw discovered files/nonmodules.
3. Root prepares/reviews the four-instrument C1 successor, installs the anchor/scalar last, runs the C1 test and all17 readers with original names/statuses preserved and current fixture repair present. Actual source/policy-fault tests are serialized with native compilation and custody checked. Do not claim the new merge ready from old epoch results.
4. Run delivered6844's five real tests and the relevant final source/native preservation gates after Deno class composition. Normal changed-root hooks, budgets, import-cycle/flat-dir gates and production build use the actual fresh main as appropriate; no copied LOC baseline, allowed-edge expansion or retirement credit. Source-map public producer gaps/private Prepared guard and PR6521 remain separate.

This is a finite delivered-main prerequisite. The two lane-specific outer proofs deliberately do not claim to authenticate a future combined Deno+position merge. Re-ground that actual integration if/when both land; do not pre-authorize unseen rows or pin unions now. Architect wrote only these issue appendices and ignored candidate evidence; metadata implementation and publication are root-released work.


## Current-main complete composition terminal (2026-10-06)

The one actual Node25.9.0 serial21-file cohort completed exit0 at11:02:55UTC after3442.90 seconds:2935/2935 passed,zero failed/pending/todo. Exact collected identities are accounted for, preserving all2799 prior postseal registrations (including2433 original reader identities and duplicate ordinals), all350 originally passing semantic cases, both repaired original semantic cases, the new dependency-removal witness, and all104 original projector names/order. Own23, delivered-class-fields outer31 and C1current-source343 all pass. This is freshly executed current cdc-source composition evidence, separate from the retained older2797/2799 failed run and bounded353 fixture proof.

Complete after-body custody matches7788 declared source/tests/scripts/config/hook inputs in bytes/hash/mode/inode/device, installed runtime/library/link pins, and all53933 resolved independent pinned corpus files. Results, command/exit receipts, full ordered case comparison, custody and corpus vectors are preserved in `.tmp/6866-current-main-full-validation`. No failed samples, source faults or original registration identities were removed, and this body was not repeated.

Normal publication gates now run against this same frozen source vector. Root has freshly observed upstream main bba74cfa80aac38a3d29ba6b331d70f6bb0f9cb1 for the upcoming publication composition; no later main vector is certified by this result. Exact fresh-base delta inspection/composition, applicable checks, normal signed Thomas/Codex commit, fork push, ready PR, protected admission and main ancestry/content verification remain required. No architecture completion, public pipeline mapping coverage, full IR/legacy parity or retirement is claimed.


## Fresh delivered-main composition release (2026-10-06)

Root fetched the exact freshly observed mainbba74cfa80aac38a3d29ba6b331d70f6bb0f9cb1. PR6521 exacthead28fe57eddc496e2c63fddfa9ab6bd64f1b449ddb is delivered as9c7817882e5370127da96679c61014f5b642e50f; ancestry and entire source/test/issue blobs match freshmain. Only its three finite source/test/planning claims are completed; broader ownership/physical emission remain open.

Existing official6866 claim remains the same owner and now names isolatedbranch codex/6866-current-main-finally-composition-20261006, based on that exact freshmain. All31 prepared paths are transported without changing their bodies except the policy's exact additional318-byte deliveredfinally row. Every delivered main source blob is retained byte-exact, including checker oracle/type-mapper, exceptions/finally-private-local and monomorphize; all new regression files are retained. Candidate policy1840rows/589117bytes/SHA58ae19c3c96ecbb3ebe43ec81cfb1d244a0c15e80c7da6000becb58d44834857 is the clean three-way composition, not yet a validated authority installation.

The old cdc source vector's complete2935 tests and13 bounded gates all pass and remain preserved; complete architecture correctly remains open. Those results do not certify this new source vector. Astra is specifying only a fixed additionalfinally-row outer successor that recovers the exact already-tested1839-row prepared policy, preserves all existingclass/ownreciprocal helpers and stages original class-policy faults on their authentic historical operand. Root will release bounded targeted proof/current-source checks and C1seal, with no automatic whole2935 repeat. No new runtime feature, broad row acceptance, guard weakening or legacy retirement is authorized.


## Implementation Plan — exact finally-row preservation on delivered main

# Issue6866: exact finally-row preservation on freshly delivered main

Specification only, Astra High, 2026-10-06. Intended for a later append to existing issue6866, **IR source maps: project authenticated source-point data to physical UTF-16 positions**. Root owns the issue/claims, fresh isolated composition and publication. This work writes only this ignored evidence directory. No tracked file, test, policy, authority, source or Deno input was edited. No tests, compilation, timing, claims, network or Git mutation ran. The explicitly allowed read of already-fetched immutable cdc/bba objects used `GIT_NO_LAZY_FETCH=1 git show`; no Git state/discovery operation or lazy fetch was used.

## What remains to deliver

Preserve the new actual main row for `src/codegen/statements/finally-private-local.ts` and make the position component's historical readers consume it through **one new fixed outer finally inverse**. Do not replace or duplicate the existing class-fields bridge. The existing class-fields helper/receipt and own one-row helper/receipt stay byte-exact. Their 31 and 23 original proof cases retain identities, profiles, span assertions, mutation operands, diagnostics and authority-read counts; only initial actual-epoch capture and the class proof's physical-policy fixture staging adapt as described below.

The terminal 2935/2935 serial21-file proof on cdc composition, with7788 declared inputs and53933 pinned corpus files, stays preserved as that exact epoch. It does not certify bba. Finish its running normal gates before creating/mutating a successor vector. Root already authenticated fresh main `bba74cfa80aac38a3d29ba6b331d70f6bb0f9cb1`; delivered PR6521 head `28fe57eddc496e2c63fddfa9ab6bd64f1b449ddb` is reported ancestor through merge `9c7817882e5370127da96679c61014f5b642e50f`, with exact specialization source/test content. Retain those delivered fixes. No automatic rerun of all2935 cases or unrelated historical fault matrices is required by this finite policy insertion. Normal required hooks/checks remain required; any broader repeat must name its changed input or failing control.

## Exact current policies and raw operation

`profiles.json` contains complete literal source/data/files/non-files profiles, keys, full neighboring rows, revisions and exact insertion. `candidate-policy.json` is an ignored mechanically constructed **candidate**, not an installed/verified merge. Its reverse/replay to the old prepared source was checked statically. Compact JSON hashes use ordered `JSON.stringify`-equivalent JSON with no whitespace; raw spans use UTF-8 byte coordinates. All four policies share non-files SHA256 `3a4788461bc5c6757c931554be0ec6218711f00814f580d9bb70d26a5929c1ce` and exact top-level key order, layers, allowedEdges and activationHistory.

| Epoch | Rows / bytes | Raw SHA256 | Git blob |
| --- | --- | --- | --- |
| cdc main | 1838 /588679 | e91199cafc1788a5e976e29553b0c093a28c53fd7e2dcc3d806c8559c3f9547e | 6066caa751c06e8726076ee622311f509bdd5f77 |
| bba main | 1839 /588997 | 69eaf95c6d675c48c2bb092603c50779309976ec0373d0370a93ed7068445828 | 44a73c9b98929ae8da309cc3721a3dcf029b618a |
| Exact old prepared component, new inverse output | 1839 /588799 | 3d497f1ec140ecd7056155e6e0a993801e126b93304af1a581820d779a979122 | 9c248ee6471ee50973d5da74ba2d7d06e9eee92f |
| bba+position candidate, sole new inverse input | 1840 /589117 | 58ae19c3c96ecbb3ebe43ec81cfb1d244a0c15e80c7da6000becb58d44834857 | e775a64483ace95ca46b0d65221cff9cf84c4500 |

Candidate compact data SHA256 is `fbda107633bdaef0fbfe9775f02503c850b7ccbd21ae5872ed2b14f5c0698368`; files SHA256 `b1482d905e51a1b9836b6fa218e3ecf6dc66bb6241347400e0479e9872ce4f92`. Old prepared compact data/files are `8c91785b4302f8f9b88641f325643e374484b54909c3bbc086c0456b5a6bdc9a` / `7ede92f695b2c32bbc8cb5dea5e59a3e2f89a24bf37852f757866601ad01a62a`. Fresh bba data/files are `972ca4eca855effd6e8536e67f73b25994e0162e39519ce776f6c6d6e97512a4` / `cd57b430bf595951d2bebbac4ccb21c8a538180b4274cc62a8633bcb4207c73b`.

The sole semantic addition is zero-based index981 on main and982 in the component. Previous row: `src/codegen/statements/exceptions.ts`; next: `src/codegen/statements/finally-ran-guard.ts`. Both are unchanged full unmigrated/mixed-needs-split/backend-wasmgc rows owned by `3518-coordinator` with the same nextBoundary as below. The inserted row alone uses owner `5267`:

```json
{"path":"src/codegen/statements/finally-private-local.ts","state":"unmigrated","layer":"mixed-needs-split","destination":"backend-wasmgc","owner":"5267","nextBoundary":"Separate AST/context-driven generation, physical resources and generated native runtime."}
```

Use exactly one raw insertion span: `beforeOffset=afterOffset=363627`, `before=""`, and this **318-byte** `after` literal (including the displayed final newline):

```text
    {
      "path": "src/codegen/statements/finally-private-local.ts",
      "state": "unmigrated",
      "layer": "mixed-needs-split",
      "destination": "backend-wasmgc",
      "owner": "5267",
      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."
    },
```

The identical delivered-main insertion is at363507. All other cdc1838 rows and raw bytes are unchanged. The120-byte offset difference is the existing clean `src/ir/program/source-map-position.ts` row at82745/index85. On the final actual merge require raw equality to589117/58ae… before generating authority; a different merge result is a discrepancy to investigate, never a new pin to accept opportunistically. Preserve bba's baseline files as fresh main, never copy the older component's whole policy/baseline/manifest over them.

## Fixed test-only helper and independent proof

Prefer separate files:

- `tests/helpers/ir-position-finally-main-successor.ts`
- `tests/helpers/ir-position-finally-main-successor.json`
- `tests/issue-6866-finally-main-inventory-successor.test.ts`

Proposed exports: `positionFinallyMainSuccessorReceiptPath`, `capturePositionFinallyMainPredecessorPolicySource(raw, readAuthority?)`, `capturePositionFinallyMainPredecessorPolicy(value, readAuthority?)`. These are test-only reconstruction APIs, not production authorization. Schema: `fixed-position-finally-main-successor-v1`. The helper admits exactly the1840 candidate profile and returns exactly the1839 old prepared profile. It removes only the finally row; it does not call, copy or supersede the class-fields/own/eleven-row algorithms. Follow their descriptor-first refusal pattern: primitive raw input; plain own JSON data and dense arrays; no accessors/coercion; detached semantic output; full raw/data/files/non-files profiles; exact keys/order/neighbors; complete inverse then byte-identical/semantic forward replay. Freshly read and authenticate the full new receipt on each operation, against independently fixed helper literals. No remembered accepted flag, row-name search, general removal, alternate accepted epochs, self-derived expected hashes or broad hash union.

The new receipt additionally binds exact cdc→bba main lineage and the same318-byte insertion at363507. The new independent proof freezes the complete formatted helper and receipt and repeats literal expected profiles/spans independently of parsed receipt fields. Healthy proof obtains1840 from the actual merged policy, proves finally→1839, then calls unchanged classFields→1838 and own→1837. Preserve those exact inner outputs. Also independently remove only the literal120-byte own row at82745 from authenticated1839 to recover exact cdc1838, replay finally at363507 to recover exact bba1839, and reinsert the same own row to recover candidate1840. This is a finite main-lineage witness, not a third implementation of the class-fields bridge. Bind the own row's exact bytes/index/neighbors in the independent proof; do not read the receipt to manufacture its expected result.

Required new negatives: missing/duplicated/renamed/moved finally row; changed owner/layer/state/nextBoundary; changed retained source-position/class-fields/neighbor row; different top-level rules/keys/order; old prepared or bba-main-only offered as current; prefix/tail/whitespace raw corruption; missing/changed/boxed receipt; accessor/coercion/sparse/symbol/cycle data refusal; actual physical current-policy and receipt corruption after healthy capture, exact restoration and fresh healthy capture. Distinguish source-profile refusal from receipt-pin refusal, observe reads, and floor nonempty output/row counts. New test count is collected from actual registrations, not guessed here.

## Exact reader composition and original fault operands

`readers.json` statically confirms **17 existing historical reader files /24 initial capture calls** in this current vector. All24 currently call the raw classFields helper; some then parse for an older semantic chain. Do not confuse this current raw-call count with the earlier19-raw/5-semantic classification of older downstream channels. Add only imports and a finally wrapper to those exact initial raw operands:

```text
older(main11(own(classFields(finally(actual1840)))))
```

Keep all historical mutation application **after** this healthy projection. The four multi-capture readers are runtime-program-policy-evolution(2), number-prerequisite-policy-evolution(5), runtime-data-contract-seam(2), and main-inventory-source-successor(2); the other13 have one each. The artifact lists exact filenames and lines. No broad replacement of every policy read is authorized; raw authority/fault readers remain actual raw readers, and already historical fixture operands must not be projected again.

Adapt classFields proof `independent()` at current line204 to obtain its raw1839 via the new finally inverse, then retain the entire old classFields expected object, independent328-byte inverse/replay, old1838 output, delivered abb→cdc witness and original31 test registrations. Adapt own proof `independent()` at118 to compose finally inside its existing classFields call, retaining all23 original checks. Preserve complete old helper and receipt bytes: class helper12936/eccb82c050fcc4aaf7662d3167257fac2ada9e4d134f699ca80f97a0852659ff; receipt5558/27bfb98ed1ac7a08f285f698426ae0eb9c61ef5e6e433ff1d70288da5295a112; own helper10137/f38b30f68e7e6d4e77d60126e9fe29ef4c0c934225f02a759c41a58402a49b90; own receipt2437/b2afd57a2583d7a103b07ce1bcc577475023ee29f54ee433f115a6fcf43572b0.

**Physical classFields fault at lines467–519 needs explicit epoch staging.** First authenticate actual1840 through healthy finally capture to get witness.raw1839. Store those exact bytes in a distinct temporary file local to this test's worktree. For the original “current policy” case, apply the original newline/raw and owner/semantic mutations to that1839 file, read its actual changed bytes directly into the unchanged classFields helper, and require its original full-source/full-data errors. Restore that file exactly and require classFields success. Never run the mutated file through finally or substitute its healthy cached copy for the mutant. For the original “outer authority” case, corrupt/read/restore the **classFields receipt** as before, with authentic1839 data as the operand. Preserve four calls/authority reads in each old case; finally capture has a separate read channel outside that counter. Retain original case names and document that “current” describes the classFields proof's fixed1839 epoch. New finally proof separately mutates the actual merged1840 policy and its own receipt. Serialize these physical fault tests, with try/finally restoration and custody. The own23 proof has no analogous physical full-policy case requiring a new fault harness.

## C1 and real source intersections

Saved `c1-intersections.json` finds **zero** exact structured hits for the five fresh compiler paths across current C1 population, linear closure and resolver records. The closure includes `src/checker/oracle-backend.ts`, not changed `src/checker/oracle.ts`; do not conflate them. The source-map semantic fixture's declared file groups also contain none of the five paths; preserve its current205-file closure, repaired353-case proof and exact782→783→977 edge witnesses. Refresh this finite intersection on the actual composition, including transitive source reads if a gate reports one. A newly observed dependency is a specific additional work item, not grounds to pre-emptively reseal unrelated sources.

Main's C1 manifest is unchanged cdc→bba at402517/c0a10ae0c0bfc4d27fc24bea20401edc2cac683254fc1664781889c98f63ed66. That is **not** the prepared component's current manifest. Preserve the prepared407484-byte manifest/SHA256 `c961d4dd90b7461a54e660d7710b29067fa2bcbe6f90a2803409daf29c8fe103` as the successor's before operand. Exactly four edited reader instruments intersect its12 current pins/10 recipes:

1. `tests/issue-3518-program-data-contract-boundary.test.ts`
2. `tests/issue-3518-runtime-program-policy-evolution.test.ts`
3. `tests/issue-3518-well-known-symbol-policy-evolution.test.ts`
4. `tests/issue-3518-number-prerequisite-policy-evolution.test.ts`

Root extends only those four existing immutable-artifact→current recipes after reader formatting. Keep immutable beforePins, seven artifacts, eleven immutable authorities, other eight current instruments, other six recipes, source population and linear closure/resolver/observations exact. Prove all ten complete inverses/replays against the unchanged historical operands and all12 current pins; retain existing intermediate classFields/own adapters in those recipes. Update anchor and external independent scalar last, changing only its manifest/anchor fields with outside bytes exact. New helper/proof stays independently authenticated, not added to a historical fixed instrument population. Do not copy the main402517 manifest, the6865 manifest, Deno authority or old intermediate407k guesses into this successor.

## Preserve exact delivered compiler fixes and select meaningful checks

`source-pins.json`, immutable `objects/` and five small `diffs/` bind the changes; root should preserve these delivered source bodies exactly where composition has no local overlap:

| Fresh source | Actual change to preserve | Fresh bytes / SHA256 |
| --- | --- | --- |
| `src/checker/oracle.ts:492` | Recognize `TypeFlags.StringLike`, including template-literal and string-mapping types |27343 /83aa8ba5ee5550eb4113425e19647d8dde6da169ee59cd3da19e350b227fd911|
| `src/checker/type-mapper.ts:77,413,444` | Same StringLike treatment in physical type, string test and union members |27321 /5816dcbd6fa6c5ce07ae9af769f094aa9ed4cda5692c87173d6f4b04dff48295|
| `src/codegen/statements/exceptions.ts:25,436` | Import/call `allocFinallyPrivateLocal` for the real finally guard |39769 /134f950290b797d53ef9cd72ce9f4d50537ec2a56b7f06788340b721671fe6f2|
| `src/codegen/statements/finally-private-local.ts` | Append private local without source-name lookup or temporary reuse |517 /60d0da5027c4f525bdd138f33b6788635966968add54b9ee8d41ef87f6240086|
| `src/ir/passes/monomorphize.ts:60,579–671` | Retarget genuine generated clone owner; fork nested allocation sites parent-first in all modes; reject malformed return before allocating |37589 /beac92656855188abf73937042194d19985decd2935391dd26138a41af86b0e5|

After isolated actual composition and metadata freeze, run this bounded validation in dependency order, retaining terminal counts and input custody:

1. New finally independent proof; existing classFields31 and own23; actual boundary normal/inventory modes requiring1840 classified modules and the exact new row, no changed edges/activation/layers. Strict full architecture remains open. Verify all17/24 adapted capture sites have their original successful healthy predecessor, original returned raw/data profile and exact read-stage channels. Reuse existing healthy case entry points; select those cases explicitly, plus representative original downstream malformed and fresh-authority controls. Preserve every other historical case in source; do not launch all17 complete fault matrices simply to reconfirm the same byte-identical predecessor. If a required hook selects an entire changed file, obey it and label that run separately.
2. After root's finite reseal, full `tests/issue-3518-c1-current-source.test.ts` **343 original cases**, plus static all-ten recipe/full-source replay and current pin equality. The manifest changed, so this actual current-authority rerun has a concrete reason. Use targeted original healthy/negative cases for the four instrument readers to verify their call-site semantics beyond the recipe; expand only upon a failure or real affected read.
3. Run the three exact newly delivered tests: `issue-5267-finally-reentry.test.ts` (GC/standalone effects, thrown-object identity, private local/dedup/rollback, eval/closure collisions and real host exception), `issue-6868-template-literal-string-types.test.ts` (three real regimes; length5/3 and concatenation where marshaled), and `issue-3525-source-map-specialization-origins.test.ts` (genuine frontend capture separately from DATA clone/allocation cases, all-mode nested forks and real Linear fact consumers). Keep their complete delivered assertions; their byte pins are in source-pins.json. Count actual registrations; this spec reports no new runtime results.
4. Position/source/IR controls: retain and run original104 `issue-6866-source-map-position-projection.test.ts`; genuine `issue-3525-source-map-source-capture.test.ts`; `issue-3520-monomorphize-identity.test.ts` and `issue-3520-monomorph-program-abi.test.ts`. For scalar/native preservation use `issue-3526-ir-math-intrinsic-integration.test.ts`, which compares actual IR-only compiled methods/native effects with the direct compiler control. These touch the changed frontend/specialization path and guard the user's IR+ES requirements; synthetic policy math alone cannot substitute. Other unrelated native/retirement suites need no automatic repeat. Keep public SourceMap gaps/legacy retirement status unchanged.
5. Run applicable formatting/lint, TS7/build, actual fresh-base LOC/function/coercion/oracle/import-cycle/dead-export/boundary gates and normal hooks. Reuse a completed gate only when every actual input it reads is unchanged; source/build inputs have changed on bba. Required validation does not imply repeating timing or the full corpus/fault suite. Preserve prior2935 names/count/custody and report new selected run denominators independently; never add counts to fabricate a newly executed total.

No Deno source, metadata, physical policy faults, active one-file353 run or2838/2841 record is touched by this plan. No compiler route/eligibility/private source-map guard changes, historical recipe replacement, broad row acceptance, retirement or additional architecture scope. Root installs an issue appendix and releases implementation only after the current vector's gates finish.


## Root implementation ownership release

Existing official6866 same-owner claim authorizes this bounded successor on isolatedbranch codex/6866-current-main-finally-composition-20261006 atfreshbba74cfa80aac38a3d29ba6b331d70f6bb0f9cb1. Sol6.1 Medium owns only the new finally helper/receipt/proof, the17 exact initial reader adapters and the existing own/class proof adaptations specified above. Root owns policy, C1seal/anchor/externalscalar, issue and publication. An independent source-control reader gets a separate regular-file worktree with exactfreshmain source and only the frozen source-projector component; no physicalmetadata/C1sourcefault run overlaps its input files. Historical/helpers/class receipts stay whole byte-exact and all original test identities/assertions remain. No2935repeat, timing, source rewrite, genericrowpermit, defaultflip or legacyretirement.


## Fresh main source-control terminal evidence (2026-10-06)

The independent regular-file source-control worktree atbba74cfa80aac38a3d29ba6b331d70f6bb0f9cb1, with only the exact source-projector leaf/test added, collected and actually ran236 cases across eight suites: projector104, finally70, sourcecapture34, specialization17, monomorphidentity4, monomorphABI1, IRmath3 and stringtypes3. Terminalexit0:236/236 passed. These execute the selected newly delivered compiler fixes and original projector/IR source/native controls without sharing source/test/helper/config/hook files with the metadata mutation worktree.

All7715 declared repository inputs (including1842 source files) and31654 installeddependency entries/runtime pins match after execution in bytes/hash/mode/inode/device, with exact original test identities. This count is separate from the preserved cdc2935 whole metadata cohort and is not a newly executed combined aggregate or complete public SourceMaps coverage. Source typecheck/production build runs separately on this same frozen actualsource vector. Evidence `.tmp/fresh-main-source-controls` in worktree codex-6866-fresh-main-source-controls-20261006. Finite finally metadata/C1assembly and normalpublication remain pending; no legacyretirement or performanceacceptance.


## Fixed finally successor and current-source proof terminal (2026-10-06)

PhaseA formatted22ownedfiles and preserved all2434 existing reader identities plus old31class/23own identities. The first broad collection usedNode24 and failed at the intentional staleC1module-load guard; preserve that error, no cases or pass credit. ExplicitNode25 proof-only collection saw39new/31class/23own registrations without execution. Root then installed only the independently reviewed successor manifest409047bytes/SHA7866e5631d0c18a1226dec77fce73733a0140253f3ee959fca45289ae6c93d00, anchor and externalthreefields. Fourexistingrecipes alone extend, alltenhistorical inverses/replays and12currentpins match; innerhelpers/receipts/historicaloperands remain exact.

Actualpostseal Node25 collection2870metadata/C1 registrations retains allold2434reader identities and54proofidentities. The serial four-file body now terminatesexit0 with436/436 passes:39newfinally,31class,23own and343C1. Source/policy/receipt mutation restoration and fullinputcustody are checked before the separate targeted83-case original-reader selection across17files/24initialsites. No all2935repeat or combined-total pass claim. Independent freshsource236/236, sourceTS7 andproductionbuild exit0 with1842source/7715repository/31654dependency inputs unchanged; its ignored223buildartifacts preserved.

The empty new-worktree test262gitlinkplaceholder was preserved in `.tmp/finally-main-composition/preserved-empty-test262`, then linked to the independently verified clean pinned corpusb363f29d3c43c626dc852744ad64a0b48a003693. PhaseA accurately recorded missingoldcorpuspaths and made no corpusclaim; PhaseB freshly captures actual64748inputfiles and53933resolvedtest/harnessfiles plus linkidentity. These are differentepochs, not a replacement for the original completed53933-file custody proof.


## Publication-ready bounded fresh-main validation (2026-10-06)

Actual Node25 PhaseB:436/436 independentfinally39/class31/own23/C1343 cases passed; separately84/84 targeted original reader cases across17files passed. A static call-path audit found that this84-case selection missed the initial lowering application capture. Preserve that discovered gap and the84-body report; root then released exactly two original policy-raw/policy-semantic application cases, each realhealthy→missingcachedimplementation→restoredhealthy, passing2/2. All24 initial capture sites are now covered by the original static call-path map plus actual selected case identities; no runtime coverage counters were added and the2350 unselected reader cases are not claimed executed.

After all physicalfault bodies,64748/64748 capturedinput files matchbytes/hash/mode/inode/device,53933 resolvedcorpusfiles/linkidentity and installedruntime anchors are exact, all1842 source files unchanged, all22 formatted ownedpins and threeinstalledC1pins exact. Twelve normal bounded publicationgates pass; completearchitecture mode correctly exits1 with1840 classified/errors[]/inventoryValidtrue/graphCompletefalse. Gate reuse after the finaltwo cases is justified by the exactfull vector restoration. SourceTS7/build and236native/sourcecontrols remain separately measured on the identicalsource vector. No whole2935/353 rerun, weakenedguard, fixturedeletion, hookbypass, retirement or performanceclaim.

Normal signedThomas/Codexcommit andforkpublication are now authorized from this exactreviewed branch, followed by readyPR andprotected exact-head admission; only verified main ancestry/content willcomplete delivery. Exactcommands/results/selection/custody/intersections andretainedstaleC1collectionfailure are in `.tmp/6866-finally-phase-b`. Issue6866 remainsin-progress until its own actualmain delivery; parent6865/IRmigration remainopen.


## Verified bounded main delivery (2026-10-06)

PR6535, “feat(ir): project prepared source points to UTF-16 positions”, delivered exact signed head46d9a47ca00e421572e8ef3a2db4a040af4b84de as merge18d8112894911b309a607a4fa98b26a306216287. Both are ancestors of freshly fetched main431aa4ed7a7be13c922332ab14a85ff05de1ac44. All33 non-policy paths match complete head bytes, including the projector, original104-case test and this issue before this completion record. Main policy preserves all1840 head rows and every non-file field, with four unrelated additional main rows; the projector's complete row is exact. Main delivery proof is retained as source-position-main-delivery.json in the replay-helper integration handoff. Normal signed commit and pre-push hooks ran without bypass, including18/18 numeric-local IR parity. Official claim6866 was completed and effect-verified on upstream/issue-assignments.

This closes only the pure data-to-UTF-16 projection leaf and its bounded preservation proofs. Genuine emission ownership/currentness and public source-map integration remain under parent6865; legacy compiler retirement and full IR equivalence remain open. Earlier pending-delivery statements are retained as historical records and superseded by this observed delivery.
