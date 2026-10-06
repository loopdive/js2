# Intl prelude / IR source-origin coordination

Read-only Sol-6.1 Medium audit; no implementation or ownership clearance.

## Scope and evidence limits

The proposed Intl canonicalization prelude can use existing compiler staging,
PositionMap composition and exact declaration identity. It needs no new shared
context field or IR builder. The generated-producer literal union in
`src/shared/contracts/source-origin.ts` lacks `intl-canonicalization-prelude`.
Adding that literal changes an authenticated C1 authority input; a composition
edit alone is not sufficient acceptance.

The audit inspected compiler/plan source at
47f186384c99840a11dc035b92d2f5b73ee708f5, not today's entire main composition.
The parent subsequently fetched main at
5f953c8e05919a304d5d3b8e3811e882962a9f33. Revalidate exact hunks before editing.

Live issue-assignments ledger records name these held slices:

- `6809.json`: ttraenkler/codex-intl-locale-parser, branch
  codex/6809-intl-locale-canonicalization. PR6436 inspected head
  256c6845ba8227f95dbafe4241a897b8255898b2; its four-file diff excludes compiler.ts
  and source-origin.ts. Current author activity and artifact agreement unknown.
- `3525-c1-source-origin-{proof,tests}-20261005.json`: separate proof/test owners.
- `3525-source-map-source-capture{,-tests}-20261006.json`: capture/test owners.
- `3525-source-map-plan-20261005.json`: source-map plan owner.
- `3518-ir-source-positions.json`: ttraenkler/astra-ir-program-a-20260905.
- `3518-program-abi-seam.json`: ttraenkler/codex-astra-program-abi-20260908.

A held ledger record is not live consent. Released whole-issue records do not
release slices. The old local origin/issue-assignments snapshot is unsuitable
for clearance. No active session identity for the parser author was established.

## Integration contract for the eventual implementation plan

1. Add the truthful producer literal and stable producer-owned declaration roles
   through existing PositionMap machinery. Never label Intl as ListFormat.
2. Stage before parsing and CJS/import processing beside existing preludes;
   preserve directives, shadowing and no-injection identity behavior. Compose
   output-to-input maps in reverse transformation order.
3. Preserve JavaScript leniency with the necessary injected-source grammar.
   Prove provenance in both single and multi-source entry paths; projecting only
   `.source` is not proof of retained origins or positions.
4. Resolve inventory origin through declarationByUnitId/unitByUnitId, the exact
   original parsed declaration, sourceFunctionHandleForDeclaration, definedFuncAt
   and funcSignatureOf. No reparsed-node/name fallback or index arithmetic.
5. Origin tagging grants no Prepared admission. Preserve ABI/provider/verifier
   rules, preparation-before-emission and Unsupported/Invariant distinctions.
6. Coordinate an authenticated C1 successor with the proof/test owners. Retain
   original pins and reconstruction/replay evidence. Test directives, diagnostics,
   composed origins, exact declaration/handle/signature identity, shadowing,
   collisions, target gating and multi-source behavior.

Plan references at the inspected revision: issue3525 lines4522 (SourceOrigin
epoch) and4938 (root compiler/driver/presentation source-map ownership);
issue3520 line2345 (compiler-origin synthetic-support identities).

No shared seam edits, parser copying, PR takeover or source-origin proof changes
were performed by this audit. This document does not authorize them.
