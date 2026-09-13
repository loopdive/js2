# Startup data contract extraction — Astra High implementation spec

Scope: #3518, one intermediate step toward the approved standalone WasmGC
architecture. Source base is current upstream main `25b9a41c38` (the complete
SHA must be recorded by the implementer). It differs from the N1 source only
in published artifact refreshes. Neither held PR #5738 nor #5739 is a dependency.

## Decision and exact Low write set

1. New `src/ir/program/startup.ts`: move, byte-for-byte, the twelve type/interface
   declarations at `src/ir/module-init-plan.ts:9–94`, including their comments.
   Import the four ID types from `src/shared/contracts/ir-identity.ts` using a
   type-only relative import. There are no runtime exports or dependencies.
   Keep all fields, unions, readonly qualifiers, nullability, legacy observation
   keys and target variants. Do not turn the plan into a backend-specific type.
2. `src/ir/module-init-plan.ts`: import the moved type names and explicitly
   re-export all twelve from their one canonical declaration. Remove the original
   declarations. Preserve every runtime statement, function/class body, AST input,
   invariant error, observer type and source range behavior. Remove an old brand
   import only if it becomes unused; retain `createIrBindingId` and any brand still
   used by the builder. Do not move or rewrite the builder or validation.
3. `src/ir/program.ts`: change only the `IrModuleInitPlan` type import to
   `./program/startup.js`. The original complete startup population remains in
   `PreparedIrProgram.startup`. No schema/producer/ABI/backend edits.
4. New `tests/issue-3518-startup-contract.test.ts`: cover the exact twelve-name
   type surface, canonical imports/re-exports, no value-bearing canonical
   declarations, real nonempty source planning and exactly-once invocation
   policy, source identity/ranges/order and explicit empty/type-only sources.
   Preserve the actual declaration/consumer denominator; use the original
   builder, no alternate producer or fabricated runtime caller.

The canonical closure is startup -> shared identity -> shared source origin;
all edges are type-only. The current builder stays mixed. The complete program
still has other legacy/frontend dependencies, so this is not whole-program
closure or direct-codegen retirement. Existing host/linear target variants are
preserved, but no new backend implementation is authorized.

## Parent-owned integration and proof

Parent alone updates `scripts/compiler-boundaries.json` and issue #3518, and
publishes this plan with measured evidence. Activate the ir-program layer with
the actual new startup entry, retain the future required `program/index.ts`
obligation as explicit debt, and preserve all prior activations and overrides.
Do not edit any baseline, gate implementation, package command or CI workflow.

Verify the normal TypeScript compiler erases these changes: transpile each
changed pre-existing source file at exact base and candidate with identical
options and require full emitted JavaScript equality. Enumerate all twelve
declaration names and compare exact AST declaration text, not just counts.
Run typecheck and existing focused startup/module-init/codec controls plus the
new tests in one fork with a 2 GiB heap. Compare standalone public module-startup
execution, binary bytes, imports/exports and original source census against
the explicit source-equivalent base; do not claim full conformance.

Run the actual complete boundary inventory and its existing 42 detector tests.
Inventory must pass; complete mode must continue failing for retained migration
debt. Record module/edge/unknown counts and content hashes. Preserve N1's strict
closure failure and approved six-caller preservation distinction; this type-only
move does not resolve the pending ABI getter compatibility decision.

## Ownership and preservation

Live ledger read at `a33322db73e98549972ac3154f9693d643c70c64` contains
the historical A `authoritative-preparation`, `module-init-source-audit`,
`wasi-startup-handoff` and parent integration claims. The user explicitly
transferred the suspended migration to this coordinator. Keep those records;
do not release or force-steal them. Record a new exact startup-contract slice
before writing and verify sole ownership again before commit.

The preserved P draft `/private/tmp/js2-3527-p-async-resources-20260907` has
ten changed lines in `program.ts`: async-resource imports, two ABI union arms,
one resource field and the v2 schema. None overlaps the startup type import.
It has no changes to `module-init-plan.ts`. C's preserved draft has changes
in neither file. Neither draft is edited or implicitly accepted by this move.
The dirty root checkout remains untouched. Parent alone composes/publishes the
frozen Low result into a separate non-draft held PR with normal hooks.
