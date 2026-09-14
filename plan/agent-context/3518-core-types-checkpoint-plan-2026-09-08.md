# Core type construction checkpoint — Astra High implementation contract

Base: `25b9a41c3828dfb403797003dc6b66c72a2547ba` from `loopdive/js2/main`.
Before publication the branch was fast-forwarded to metadata-only refresh
`16498efb481cb022ee5c4dcc9bb137b6d4c91a50`; its compiler source is identical.
This implements the next-core plan published in PR 5741. It does not depend
on the held lowering, ABI or startup source changes. All older drafts and
claims remain preserved under the user's explicit migration takeover.

Claim: `3518:core-type-separation`,
`ttraenkler/codex-astra-core-types-20260908`, worker branch
`codex/3518-core-types-worker-20260908`. The live ledger was reconciled before
dispatch; no existing owner was displaced. Astra Low native workers own
disjoint source and kind-evidence files. Astra High owns specifications,
caller/boundary integration and independent review. Fast-mode settings remain
inherited; no standalone tasks or global configuration changes.

## Source boundary

Move unchanged declarations and implementations with explicit compatibility
imports/re-exports, never forwarding wrappers:

- `ir/nodes.ts` to `ir/core/types.ts`: ten type/shape declarations,
  `IR_CLASS_SHAPE_CELL`, nine public constructors/equality helpers, three
  private equality helpers and the single `activeFnctorPairs` recursion guard.
- `ir/fnctor-abi.ts` to `ir/core/fnctor-shapes.ts`: exactly three shape types;
  validators/resolvers stay and import the canonical types/equality helpers.
- `ir/value-references.ts` to `ir/core/value-references.ts`: four declarations.
- `ir/capability-provenance.ts` to `ir/core/capability-provenance.ts`: three
  declarations using canonical F0 identity brands.
- `ir/tag-domain.ts` to `ir/core/tag-refinement.ts`: `TAG_ID_BRAND`, `TagId`,
  and `tagRefinementEquals`. Domain construction/minting stays in place.

`IrInstr`, `IrFunction`, async attachments, dialect assembly and traversal stay
in old nodes. `irValSigned` and `isDynamic` also stay: they do not have proved
production callers. The full `ir/core/nodes.ts` destination is explicitly
unfinished. Preserve every equality body, signedness/nullability/default
semantics, brand identity, runtime symbol identity and attachment reference.

## Additive caller contract

`check:dead-exports` must explicitly include `--require-core-types`; the command
itself is pinned by a regression test. The ten targets are fixed canonical
functions, not discovered from surviving files. Deleting all destinations,
renaming consumers, or substituting old implementations cannot deactivate the
obligation. Both strict and preservation verdicts conjoin this new result.

N1 keeps its separate six-target denominator, two reviewed open-import
receipts and unchanged historical dead-export baseline. Running the historical
auditor without the new flag reports the core group as not assessed, never
as ten-function success. Strict closure and retirement remain unproved.

The core-only reference graph excludes every class owner and every reference
originating inside a class declaration/expression, including nested classes.
This avoids counting unused methods as callers. N1's graph and diagnostic
collection are unchanged. A separately eligible reference must remain an edge
even when the same owner also contains an ineligible class-body reference.
An independent High review additionally found wrapped function initializers
could be mistaken for eagerly initialized values. The core-only initialization
classification unwraps parentheses, assertions, satisfies and non-null wrappers;
their deferred bodies require a genuine reference. N1 classification stays
unchanged. Six negative/positive wrapper pairs pin this correction.
The High source inspection found class-free full/cut candidates through
`planIrOverlay`, position-type resolution and fnctor preselection. Actual
auditor execution, not this inspection, must prove all ten.

## Boundary and evidence integration

Activate all five core destinations and preserve the previous activation
history. Allow only core, foundation and the pure Wasm model; no frontend,
backend, physical allocator, provider implementation or legacy back edge.
Keep full-node migration debt explicit and include adversarial boundary tests.

The kind-neutrality gate must scan both canonical reference files plus the old
facades and dialect, retaining all instructions and three excluded reference
declarations. Only the two `IrObjectShape` / `IrClassShape` citation file
prefixes change in the baseline. Quote hashes, all verdicts, counters and all
other baseline bytes remain fixed; reversing those two prefixes must recover
blob `905b33823e259908f964bbaa47c0c8177c256e4f` exactly. No budget baseline edits.

## Publication and acceptance

Require source/declaration-body equivalence, focused seam and existing consumer
tests, both old auditor fixture suites, new adversarial caller/boundary/kind
tests, typecheck, actual inventory/complete reports, and explicit pinned
base/candidate standalone WasmGC binary/order/value comparison. Serialize
heavy checks at 2 GiB. No local Test262 campaign.

Use normal commit/push hooks and user author attribution. Publish non-draft to
`loopdive/js2` with `hold` while the inherited N1 merge-group incident and queue
safety decision remain open. Green PR-head checks are not permission to remove
that hold. ABI getter acceptance is a separate unanswered user decision.
