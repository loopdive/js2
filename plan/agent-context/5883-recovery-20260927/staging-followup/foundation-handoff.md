# Shared typed staging: isolated identity / physical census foundation

2026-09-27. Source-only in `codex-5883-protocol-get-20260927`; no caller wiring, compiler, tests, typecheck, commits, push, or parent edits. Singer owns the execution slot. Read full Huygens `5883-staged-instr-api-handoff-20260927.md` and full `5883-emission-ownership-staging-handshake-20260927.md`, repository AGENTS/memories, concrete Instr union and recursive walker. Earlier accepted ownership/demand measurements were reported by parent; they are not staging measurements.

## Exact increment and status

New files only:

- `src/codegen/staging-instr.ts` (183 lines), SHA-256 `3deaa2901a28cb51874d8435a45e4c8ae73f5241c34db52bf6b8324b7a648176`.
- `src/codegen/staging-census.ts` (181 lines), SHA-256 `2b0c36d6a1c7039aead39a535e7bfcf924a29e6ff49438b97f84001a4b5369ed`.
- `tests/issue-5883-staging-foundation.test.ts` (346 lines), SHA-256 `70d9dd3d965672595ea514f1068cd08b03367b1f6f4bd101ff849a12d13d0e0d`.

Exact additive source/test diff: `5883-staging-foundation-20260927.patch` beside this handoff. Formatting and patch applicability checks only. **21 authored test cases, 0 executed; typecheck unmeasured.** This is a materialized-tree / independent-census slice, not full pending staging or integration acceptance.

Frozen ownership source hash remains `264db2d47c2f592d222f670cf9abe4b8263f8ed3e6e8b50b0fef56bbfdd702be`; original21/review19/authenticated6 hashes still match prior receipts. Executable Instr source untouched, SHA-256 `b305b96583e473272f26032cd1e4ad4653a32d4f56db74df50dac7f1c2461b6d`. No change to frozen B, slot-encapsulation, or earlier ownership patches.

## Concrete architecture question to Hume / parent BEFORE the pending portion

The current handoff does not define the closed data schema consumed by a captured-vector-drive/protocol-choice/prototype-seed lowering. Specifically, a future pending variant in `StageNode` needs:

1. Exact provider-owned recipe discriminants and immutable semantic fields, distinguishing materialized operands from evaluated-storage bindings and future symbolic obligations. Which existing receiver/argument/local/function/global/type references are bound now, and who remaps each? No second evaluation of materialized children.
2. A correspondence for mutations through a legacy projection: tail-call conversion, last-call drop decisions, string caching/local allocation, local dedup, and source-time inlining. Which edits are projection-independent, or what explicit data edit will the active expansion interpret equivalently? Carrying only stack/effects summaries cannot establish this.
3. Concrete stack/flow/effects contracts for the two projections, including unknown/refusal rather than fabricated zero-effect semantics, plus the expansion owner and consumption order.

**No pending variant, generic RecipeId/opaque payload, callback recipe, fake Wasm op, placeholder lowering, activation or legacy projection was coded in place of those decisions.** The narrow question is the data union and edit/relocation contract at the `StageNode` extension seam. Please resolve/review that seam with the provider owners before authorizing its implementation. The five existing recursive Instr variants have a settled exhaustive representation from Huygens's proposal; no executable union change was needed for this portion.

The current region/node constructors are immutable structural snapshots. A later mutable legacy cursor and transaction-aware editor must agree how to replace these snapshots while retaining/reminting exact identities and journaling physical + ledger changes together. This patch does not silently pick a mutation/callback escape hatch or claim those editing operations exist.

## Implemented API and ownership

`StageRegion` holds the existing `BodyEpoch`, existing `EmissionRegion`, and a typed ordered node sequence. `StageBody` carries the exact existing body/binding version identities. `StageNodeIdentity` carries the actual node identity and optional occurrence/use-site annotations. No global state, id counter, context allocator, metadata graph, or alternate ownership arena is introduced. These modules use only ownership types; they do not call ownership APIs or allocate compiler semantic state. Caller/body owners supply the existing ledger handles under the existing explicit body-content transaction contract.

`StageNode` is a closed union for the implemented materialized subset:

- leaf: `ExecutableStageLeaf`, which excludes block/loop/if/try/try_table;
- container: explicit recursive replacements of those five variants, with `StageRegion` children, including every try catch body and catchAll. try_table clauses remain label records, not child arrays.

This representation is codegen-only and not assignable to executable `Instr`. There are no `Instr[]` assertion casts. The negative compile-time controls are authored but unmeasured. Current source positions and leaf instruction object identities are retained, not rebuilt. The root is an explicit ledger region attached by the caller to the body; all node occurrences/use edges have their immediate physical region as owner.

`stageLeaf`, `stageContainer`, and `stageRegion` construct structural snapshots, defensively copying/freeze-owning structural arrays and annotation records. They do not clone/claim semantic instruction values, remap numeric references, allocate helpers, or prove that an occurrence's semantic admission is valid. Leaf instruction operands and opaque identities are not deep-frozen. A `required-drive` annotation in a synthetic unit case is evidence for census testing, **not** a fabricated pending operation or an activation path.

`materializedStageChildren(node)` exposes immediate concrete children in lexical order with exact child slots. It has no callback/payload execution. block/loop/if/try/try_table children increase materialized label depth by one; try catches preserve clause order; try_table clauses introduce no extra child regions. There are no pending wrappers yet, so there is no claimed pending label-depth behavior.

`inspectStageBody(body)` independently traverses the actual typed materialized tree iteratively in lexical preorder. It accepts no ledger instance and cannot enumerate ownership edges to reconstruct its answer. It returns:

- `RetainedBodyManifest`, suitable for the existing authenticated `completeBodyEpoch` and later `sealWithManifest` checks;
- `StagePlacement[]`: exact region handle, physical parent node/body, child slot (including catch ordinal), and ordered node identities;
- `StageVisit[]`: exact node, containing region, sibling index, materialized label depth.

It rejects cross-body regions, cycles/multiple region parents, shared node arrays, repeated region handles/physical versions, repeated physical nodes or identity tokens, aliased concrete instruction objects, repeated occurrence ids, repeated adoption-edge ids and use-site identities. It is intentionally a uniqueness/tree check, not a deduplicating physical relocation traversal. Each traversal's sets are ephemeral; there is no registry or second graph.

`assertStageLayout(actual, independentlyExpected)` verifies physical parent slots and sibling order. A newly echoed layout is not independent evidence: expected layout must come from a retained prior version or an explicitly expected staging edit. Intentional movement needs the editor's independent expected result, not a new layout generated just to approve itself. The layout is frozen structural evidence at observation time; it is not a lock on all concrete mutable instruction operands or proof of semantic binding equivalence.

## Parent/order proof boundary

Hume's limitation remains explicit: the existing ownership manifest is a region **set** census, not a parent/order proof. This patch checks the physical tree outside that ledger. Tests retain an old physical layout, change parent slots or sibling order while leaving region/occurrence sets the same, and expect rejection by `assertStageLayout`. The scanner also rejects multiple parents/cycles instead of deduplicating them into an apparently valid census.

The body owner must require both structural/layout invariants and authenticated manifest equality at its adapter barrier. Supplying the ledger's own enumeration as a manifest, or supplying a current tree's own layout as its only order oracle, defeats independence. Shape checks alone do not establish source semantics or source-route completeness. Missing annotations must disagree with the live ledger at completion; unadmitted nodes, payload semantics and independently omitted roots remain source/provider responsibilities.

## Authored controls (21, unrun)

- Executable/staged type separation, closed recursive leaf boundary (including negative TypeScript checks).
- All five recursive variants, try catches/catchAll and try_table labels, lexical order and label depth.
- Real tree-derived manifest into authenticated completion/seal; unchanged concrete leaf/source identity; structural defensive copies.
- Physical node, node identity, and instruction alias controls (three cases).
- Shared then/else region, containment cycle, repeated region version, foreign-body child, duplicate occurrence.
- Missing physical node, removed ledger occurrence, wrong physical node identity (three cases).
- Detached fragment omission with explicit surviving physical orphan responsibility.
- Parent/slot change and sibling order change despite equal ledger sets.
- Exact child-use census without recursive body traversal; duplicate adoption refusal.

No pure foundation test is a runtime operation or full compiler admission test. Parent's prior 49 and 14 passes / combined typecheck do not measure this new file.

## Remaining implementation / review obligations

- Pending recipe and transform correspondence decisions above; no speculative.ts, emission caller, runtime, optimization or activation wiring.
- Coordinated physical/ledger editing transactions, truncation, removal, movement, and derivation-aware cross-body cloning. The current factories/census do not implement editor rollback.
- Relocation of concrete operands and future bound references, with complete physical root inventory and identity deduplication across saved bodies, live buffers and aliases. Frozen structural snapshots need an explicit update policy. Current leaf instruction identity retention does not establish remap coverage.
- Independent source selection/root closure at final prepared-overlay barriers; multiple-body physical identity checks and orphan disposal/remap are not supplied by the one-body census.
- Source-time consumers from Huygens's incomplete inventory, especially mutable projection, inlining and return-tail decisions.
- A recursive executable-only lowering/validation barrier; neither StageNode nor a manifest may be cast to Instr to bypass it.

The shared module names and representation are not Promise-specific and add no issue-specific arena, so the same physical staging/census surface can support iterator acquisition and composed-boundary repair. Their pending recipes, materialization and executable closure still require the decisions and proofs above. No acceptance/wiring claim; frozen for source review pending a later explicit execution grant.
