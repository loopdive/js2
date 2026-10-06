# Russell staging foundation: bounded source review

2026-09-27. Read the FULL handoff, both new source files, and all 346 lines of the test file in `codex-5883-protocol-get-20260927`. No execution, typecheck, implementation edits, or wiring. The 21 cases remain authored/unrun; earlier ownership passes do not measure these sources.

## Verdict

Acceptable as an unwired materialized-tree/census foundation on source review. No blocker found within that stated slice. NOT approval for pending operations, mutable projection, relocation, activation, or compiler integration. The unimplemented recipe union/edit correspondence remains a hard boundary, not an omission to fill with an opaque callback or placeholder.

## What the source establishes

- `src/codegen/staging-instr.ts` separates executable leaves from all five current recursive instructions. Containers explicitly replace recursive children, including try catch bodies/catchAll; try_table clauses remain labels. No StageNode-to-Instr cast or executable fake operation is introduced.
- Factories copy/freeze structural collections and annotation records, retaining opaque handles and leaf instruction identities. They do not allocate another ownership arena. Container instruction objects are structural copies; retained leaf identity must not be generalized into a promise that container identity remains unchanged.
- `src/codegen/staging-census.ts:inspectStageBody` derives occurrences, use edges, regions, placements and preorder from the actual supplied tree, without accepting the ledger. Immediate physical regions own annotations. It rejects repeated nodes/handles/instructions and cycles instead of silently deduplicating them.
- The stack-based traversal preserves lexical sibling/child order. Container descendants get one extra label depth; catch clauses do not add a second synthetic label. Adoption records do not recursively traverse the adopted body's content.
- `assertStageLayout` compares parent slot and sibling order against an independently supplied layout, supplementing the ledger's set census. The handoff correctly rejects an echoed current layout as an independent oracle.
- Tests separately exercise tree/ledger disagreement, parent/order changes, detached-fragment omission and duplicate use edges. Synthetic required-drive leaf annotations test census only; they implement no drive.

## Exact obligations for Russell and future integration owners

1. Keep this increment frozen and unwired until parent grants execution/integration. Do not implement a generic pending payload while waiting for provider-owned closed recipes and edit correspondence.
2. At the adapter barrier, require BOTH authenticated completion/seal from the independently traversed manifest AND expected physical placement comparison. Neither alone proves source selection, binding identity, or semantic operation correspondence. A region merely declaring the right body is not ledger authentication.
3. Preserve the stated snapshot limit: leaf operands and nested instruction payload objects are not deeply frozen; the census is not an operand/binding fingerprint. Mutating a call target, local index, opcode-compatible operand, or block type can leave layout unchanged. Future editing/relocation must validate semantic bindings and journal physical plus ledger edits together. Do not advertise assertStageLayout as detecting those mutations.
4. Before relocation wiring, provide an explicit policy for frozen containers/catch labels versus mutable leaves. A legacy in-place walker cannot silently mutate frozen container fields. The editor must replace snapshots coherently, preserve/remint node version identity by the agreed edit contract, and remap all concrete and recipe-bound references. No claim that retaining leaf identity already solves shifts.
5. A one-body census cannot reject a leaf instruction shared across TWO bodies, identify an omitted surviving body root, or dispose/remap an orphan fragment. These remain whole-root inventory and ownership-selection obligations. The detached-fragment test correctly exposes rather than solves that boundary.
6. When adding any recursive executable variant, extend the closed staging representation, walker, exclusion test and child-slot tests atomically. The current runtime leaf guard has a default true branch; it is correct for today's union, not future-proof evidence of recursive exhaustiveness.

No foundation API change is demanded before testing this isolated slice. Items 2–6 are mandatory conditions before wiring, not reasons to broaden the present patch. Suggested later additive controls should explicitly demonstrate same-layout operand changes and cross-body leaf aliasing so the adapter cannot accidentally treat the present census as their validator. They must not expect this one-body structural helper to provide guarantees it does not claim.

## Pending boundary retained

The provider owners must still supply exact recipe discriminants, bound references/evaluated storage versus materialized operands, stack/flow/effect contracts, and correspondence for tail-call changes, drop decisions, string caching, local allocation/dedup and inlining. An activation recipe must consume already-evaluated operands once. None of these semantics can be inferred from this manifest or pure tests. This review neither chooses those recipes nor authorizes pending wiring.
