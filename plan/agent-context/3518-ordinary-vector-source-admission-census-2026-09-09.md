# Ordinary numeric-vector source admission — read-only census and proposal

Status: investigation only, for High to specify and the coordinator to dispatch.
No implementation, new claim, test execution or vector capability acceptance is
recorded here. This does not block the native string checkpoint.

The input contract remains robust compilation of JavaScript/TypeScript source
into internal IR, not a security API for intentionally fabricated live objects.
All IR identity, allocation, semantic and refusal invariants remain required.

## Inspected source and provenance

Read-only integration tree:
`/private/tmp/js2-3518-native-string-value-consumer-20260909`.
Observed HEAD: `428e5b4b2e7645593681a998df42f5d769c53300`.
This is an active composed tree, not a claim that every inspected byte is HEAD.
Observed working-file Git blobs:

- `src/ir/program-source.ts`: `b764c114903425af35371c0bec4a7877891900f9`.
- `src/ir/program-preparation.ts`: `3e6e01e4e1a7d030b9566b5a16c085e654fe93ea`.
- `src/ir/program-logical-types.ts`: `c83f256be045dbe97062508850c0493b1a18eb9a`.
- `src/ir/from-ast.ts`: `e473f9fe60242a4f55ae39c048cbe8a750aa6ad6`.
- `src/ir/builder.ts`: `f443143a4fdfc36f37c06e0172bd762183cd143e`.
- `src/ir/program/native-vector-resources.ts`: `f5e3bffee0783838aa3a77ceff16bf2c666ef78b`.
- `src/ir/runtime/vector-callables.ts`: `63c5ed3eeb7f0dd0fd9ac50ee3dc110b87566113`.

Line references below identify those working sources; recheck at dispatch.
No old P/C worktree was modified or newly reconciled by this investigation.

## Concrete current constraints

1. `program-source.ts:437`, `prepareSourceFunctionSignatures`, resolves ordinary
   annotated parameters/results through `typeNodeToIr`. That function at
   `from-ast.ts:3902` accepts only number/boolean/string keyword types. Therefore
   `number[]` parameter/result admission needs signature work, not merely a
   literal-lowering switch. Inferred signatures must likewise be checked as
   canonical logical contracts, not accepted because propagation returned a
   representation.
2. The ordinary resolver at `program-source.ts:673` supplies module bindings
   and prepared awaits, but no `resolveVec*` registration. Only an authenticated
   async-family owner receives `logicalVectorTypes` at line 704. Historical
   annotated/inferred-empty and ordinary literal paths still request physical
   registration (`from-ast.ts:3531`, `4759` and following legacy arms).
3. The layout-free lowerer already exists: parameter fact/override equality,
   declaration/initializer assignability (`from-ast.ts:3384`, `3405`), owned keys
   (`4119`), complete consumption (`4167`), and actual expression type equality
   (`4250`). Literal emission (`4759`), length and indexed reads have logical
   branches. Missing facts do not authorize a physical-resolver fallback.
4. `program-logical-types.ts:109` builds family maps, but its initializer
   boundary is literal/await, its type resolver also admits certified Promise
   elements, and the enclosing family planner requires its special connected
   delay family. Calling that certifier with fabricated family owners is not
   ordinary-array admission. Keep that existing family contract unchanged.
5. Allocation authority is already canonical: `program-source.ts:509` creates
   the module registry and forwards it to the lowerer. `builder.ts:1571`
   emits `vec.new_fixed` and obtains an array allocation ID through that same
   registry. `program-allocations.ts:13` reconstructs and checks final allocation
   provenance/types/metadata. No source helper should mint independent IDs,
   inject physical indices, or replace the registry with a test builder.
6. Logical support is not complete runtime support. General logical `.push`
   emits `irVecElemSetSymbol(elementType)` at `array-element-lowering.ts:469`;
   the current canonical declaration at `runtime/vector-callables.ts:23` is
   only `js.vector.elem-set.externref`. A numeric grow/store symbol is not
   admitted just because the low-level donor body exists. `for-of` still uses
   the legacy physical-vector resolver. Neither belongs in the minimal slice.
7. `program/native-vector-resources.ts:50` already discovers layout-free f64
   vectors across functions, nested instruction buffers and ABI contracts.
   Actual execution must still pass `acceptPreparedIrProgram` and
   `emitAcceptedIrProgram` in `program-consumer.ts:155` and `314`. Resource
   discovery is not acceptance or proof that an emitted module executes.

## Proposed semantic source contract — not yet frozen by High

Add `logicalVectorProjection?: "standalone-native"` to `IrProgramSourceInput`.
Omission keeps historical source lowering unchanged. Explicit selection
requires source policy WasmGC/standalone and every requested runtime projection
to be WasmGC/standalone. Reject unknown option values and conflicting policies
before lowering, using the existing invalid-prepared-data invariant convention;
preserve duplicate-policy and missing-source-policy validation/order.

This option requests frontend semantic lowering only. It neither selects a
physical representation nor declares providers available. It is not inferred
from target, string projection, fast mode, or async-family selection. It adds
nothing to TypedIrProgramOptions, transport, prepared contracts or runtime
policy. The existing async-family path is not relaxed, repurposed or supplied
dummy owners. A source owner must not receive competing ordinary/family maps.

Proposed ordinary scope: synchronous top-level functions with required scalar
or exact numeric-array parameters/results, immutable initialized array locals,
dense numeric literals, contextually typed empty literals, length, supported
proven in-bounds integer reads, and exact direct calls between inventoried
ordinary owners. Numeric arrays may cross those internal direct-call edges;
the executable acceptance entry remains scalar-valued, so a host-supplied array
wrapper is not needed to prove the source-to-consumer route.

Use real checker types and the actual ambient Array declaration identity,
including aliases that resolve to that contract. Neither spelling `Array` nor
a type assertion supplies evidence. Require NumberLike element facts; never
replace boolean/i32, any, unknown or Promise elements with f64. Unannotated
nonempty literals can infer number elements; an empty literal needs an actual
numeric contextual/declaration contract, not inference from the first later
push. Every element expression must retain its effects and evaluate once.

The proposed new frontend producer returns per-owner signature overrides and
`AstToIrOptions.logicalVectorTypes`, plus currentness checking. It is not itself
source-free: its captured output is. Required facts cover parameter/variable
declarations, vector-producing literals and direct calls, every vector-valued
identifier read and admitted parenthesized expression. Exclude declaration
names, property names, type nodes, scalar length/index results and nested
executable scopes. Keep declared nullable contracts distinct from non-null
literal results/immutable reads; do not overwrite actual builder types.

Bind facts to exact inventory source/unit/declaration identities, checker
symbols, direct-call targets and signatures. Retain map identity/population and
the original structural operands/owner syntax; check before and after lowering.
Missing, foreign, stale, extra or contradictory facts must fail. Snapshot,
capture and canonical replay must contain only the ordinary IR, complete
inventory/callable records and existing allocation evidence, never AST/checker
objects or the fact map.

## Proposed file and ownership boundary

Source writer, after a new scoped release and claim:

- New `src/ir/program-vector-source.ts`: ordinary numeric-vector facts,
  signatures, bounded operation validation and currentness.
- Existing `src/ir/program-source.ts`: selection, preplanning, signature/map
  forwarding and diagnostic owner integration.
- Existing `src/ir/program-preparation.ts`: requested-projection validation.
- New `tests/issue-3518-ordinary-vector-source-contract.test.ts`.
- New `tests/issue-3518-ordinary-vector-source-identity.test.ts`.

No initial `from-ast.ts`, family producer, builder, allocation registry, codec,
runtime catalog, ABI, physical planner or consumer production edit is proposed.
A concrete limitation in those owners is an escalation, not permission to
expand this source slice or manufacture a resolver.

P's previous release covered additive native-string selection/forwarding in
the two source/preparation files. It is not blanket vector authorization.
Obtain a NEW explicit P release for ordinary-vector signature/fact wiring in
those exact files, preserving all paused drafts and excluded async ABI work.
The coordinator must refresh actual claims/open changes before dispatch; this
census did not acquire or clear an ownership claim. C/parent retains consumer,
physical resources, ABI and emission ownership. Their native-string release
does not authorize a vector physical expansion.

Separate coordinator acceptance lane: proposed new
`tests/issue-3518-ordinary-vector-consumer.test.ts` and
`tests/helpers/ordinary-vector-source-free.mjs`, plus coordinator-owned boundary
metadata. Reuse established normalized loader-guard/receipt mechanics, not an
unrecorded existence fallback. Existing source-free helper lacks an explicit
exclusion for the proposed new producer; add that exclusion in the new helper
and prove exact direct/query/fragment denials. Do not weaken old guards.

## Required source-to-consumer acceptance rows — all unrun

These eight semantic rows are proposed mandatory positive recipes, not claims
of current support. High should freeze exact source/options and the expanded
execution denominator before any run; no row may disappear after failure.

1. Annotated local: `const a: number[] = [20, 22]; return a.length;` -> 2.
2. Inferred local: `const a = [20, 22]; return a.length;` -> 2.
3. Typed empty: `const a: number[] = []; return a.length;` -> 0, still one
   genuine live array allocation rather than an empty allocation denominator.
4. Fixed reads: numeric literal plus proven indices 0/1 -> 42. Retain exact
   source proof; do not inject a physical bounds proof or hand-built IR.
5. Counted read loop over `[20, 22]` -> 42; loop-bound proof, numeric loop state
   and source ordering remain real source-produced facts.
6. Parameter/result closure: `make(): number[]` returns a literal; an identity
   function accepts/returns that array; scalar entry reads the returned length
   -> 2. Inspect real targets, signatures, call results and retained allocation.
7. Two source modules each declare a same-named array factory; renamed imports
   produce lengths 2 and 1, scalar entry returns 3. Run dependency source order
   forward/reversed and retain exact owner/alias population.
8. Effectful literal elements: a scalar local starts at 19, the two elements
   preincrement it, and the scalar result is `n * 100 + a.length` -> 2102.
   Assert exactly two increments in original source order and one array
   allocation; do not substitute constant-folded values for the effect control.

For every positive row retain the entire chain, separately reporting each
frontier: real analyzeMultiSource -> prepareIrProgramSources -> detached typed
capture/transport -> prepareTypedIrProgram -> canonical prepared encode/decode
and re-encode -> fresh acceptance -> emission -> instantiate -> execute.
Use the real original and decoded program, GVN off/on, and both UTF storage
settings; UTF independence must not silently select a string/host provider.
For the multisource row also reverse input order. Each emitted binary needs
two fresh instances and repeated scalar export calls, with expected values.

Receipts must preserve complete inventories, zero-call owners, logical
signatures, direct-call targets, live/aliased/retired allocation population and
metadata, exact canonical serialization, full emitted binary/WAT, imports and
exports in order, emitted-unit/resource/ABI ordering, actual instantiation bytes
and execution values. Require binary equality with the bytes instantiated.
Validate real Wasm and zero imports for these standalone recipes. Original and
decoded emission must be compared independently, not by re-emission length.

Fresh typed preparation and consumer replay must deny frontend/checker/ts-api,
from-ast, both family and ordinary source producers, source/preparation wrappers,
historical middle-end/GVN compatibility and TypeScript package loads. Require a
nonempty allowed census and actual exact denied-URL records for negative probes;
an instrument's own sentinel throw is not guard proof.

An old baseline refusal is expected for newly admitted source. Record its exact
phase/code/detail/owner/location and the candidate's changed frontier; do not
call an intended admission delta byte parity. Separately keep omitted-option
historical behavior and ordinary scalar no-demand full-artifact parity. Any
candidate preparation/emission/runtime failure remains a failed mandatory row,
not a successful unsupported replay or an excuse to edit a foreign owner.

## Required denied cases and independent countermodels

- Unknown option; host/linear/strict-no-host source selection; conflicting or
  duplicate runtime projections; source policy absent from projections.
- Any/unknown/heterogeneous elements, boolean or branded integer substitution,
  string/Promise/nested arrays, tuples, readonly/null/undefined unions, custom
  Array lookalikes or shadowed constructor bindings, assertion-only evidence.
- Untyped empty literal, holes, spread, dynamic new Array construction,
  destructuring/rest/optional/default parameters, mutable array rebinding,
  module-global array storage, captured/lifted arrays and unowned external calls.
- Uncertified fractional/NaN/infinite/negative/out-of-bounds indexing, optional
  access, indexed writes/delete/length mutation, for-of and prototype methods,
  general push/growth. Do not reinterpret JS property access by truncating an
  arbitrary Number to i32. Existing counted-push optimization is not a grant
  to enlarge this initial read-only vector operation boundary.
- Positive-first fact mutations: missing parameter/local/literal/read/call or
  parentheses entries; extra foreign/unconsumed keys; copied-owner nodes;
  wrong ambient/element/nullability; replaced maps; cleared populations;
  changed source text, operands, spans, checker-bound target or signature.
- Positive-first allocation/replay mutations: missing/foreign/stale allocation,
  contradictory live type or metadata, lost aliases/undefined presence, fake
  physical typeIdx/layout fields, incomplete inventory or direct-call targets.
- Consumer countermodels must reject missing/foreign physical layout ownership
  and stale acceptance evidence without fabricating resources or admitting a
  helper by name. Preserve source-produced positive first and actual expected
  refusal codes/locations; freeze those details from real APIs, not invented
  messages in this proposal.

Run unchanged logical-vector-lowering, full-family source contract/identity,
typed preparation, allocation replay and program-codec replay regression suites
under coordinator scheduling. All proposed runs remain unexecuted here.

## Handoff limit

This is a three-production-file source proposal, not a completed implementation
or physical/public cutover. No new host/linear work, runtime catalog enlargement,
canonical async ABI change, full-family relaxation, ABI30 acceptance, strict
closure or direct-codegen retirement is authorized or claimed. The ABI worker's
existing r3 production/test/handoff and prior failure receipts remain frozen.
