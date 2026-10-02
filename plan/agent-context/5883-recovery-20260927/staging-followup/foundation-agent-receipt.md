# Frozen staging foundation: authorized execution receipt

2026-09-27. Explicit serialized-slot grant after Singer's two saved-binary runs were terminal. Both were reported Liftoff; this receipt makes no tier-difference claim. Read the FULL Hume `5883-staging-foundation-source-review-20260927.md` before execution. Ran the frozen pure staging tests followed by repository typecheck sequentially, exactly once each. No kills, restarts, imposed timeout, integration, wiring, source edits, ownership changes, commits or pushes.

Working directory: `/Users/thomas/Code/js2/.codex-worktrees/codex-5883-protocol-get-20260927`.

## Terminal results

1. `npm test -- tests/issue-5883-staging-foundation.test.ts`
   - Vitest 3.2.4: **21 passed / 21**, **1 passed / 1 file**, **0 failures**.
   - Reported start 06:36:30, duration 317ms, tests 8ms.
   - Terminal handle `028544`, exit **0**, no running session.
2. `npm run typecheck`
   - Exact package command: `node node_modules/typescript7/lib/tsc.js --noEmit -p tsconfig.ts7.json`.
   - Initial handle `6713fb`, session **70176**; interim poll `eb43f9`; terminal handle **`c80f06`**, exit **0**, **0 diagnostics**.
   - Config includes `src/**/*.ts` and excludes tests. This measures the new staging source modules and current tree source, NOT the `@ts-expect-error` assertions in the test file. Vitest's pass does not substitute for test-file typechecking.

**Both processes are terminal. Execution slot explicitly returned to parent.** No further execution without a new grant.

## Frozen SHA-256 before = after

- `src/codegen/staging-instr.ts`: `3deaa2901a28cb51874d8435a45e4c8ae73f5241c34db52bf6b8324b7a648176`
- `src/codegen/staging-census.ts`: `2b0c36d6a1c7039aead39a535e7bfcf924a29e6ff49438b97f84001a4b5369ed`
- `tests/issue-5883-staging-foundation.test.ts`: `70d9dd3d965672595ea514f1068cd08b03367b1f6f4bd101ff849a12d13d0e0d`
- `src/codegen/context/emission-ownership.ts`: `264db2d47c2f592d222f670cf9abe4b8263f8ed3e6e8b50b0fef56bbfdd702be`

The unchanged exact additive patch remains `5883-staging-foundation-20260927.patch`, SHA-256 `8bc59bd242c16c259eb1d7853737b3385ff5dd853ba4879879dc0f43c13a7846`. Historical source-only handoff retained as-is; this receipt supplies its subsequent measurements.

## Hume boundaries retained

Acceptance is only for the unwired materialized-tree/census foundation. Both independent expected placement comparison and authenticated manifest completion/seal are mandatory at a future adapter barrier. Region declarations do not authenticate ownership. Layout is not an operand/binding fingerprint: same-layout local/call/type changes remain outside its guarantee. Leaf identity retention is not container identity preservation; containers/catch records are structural copies and frozen, requiring a coherent replacement/remap policy before relocation wiring.

One-body checks do not find cross-body leaf sharing, omitted selected roots, or resolve physical orphan disposition. Any new recursive Instr variant requires atomic staging/walker/exclusion/slot updates; today's default-true leaf guard is not future-proof closure. Suggested later limitation controls remain separate, not silently added to this frozen21 run.

Provider-owned closed recipe schemas, edit correspondence, bound-reference relocation, projection stack/control/effects, and once-only operand consumption remain unresolved. No opaque payload/callback/fake-op escape hatch, pending operation, mutable projection, lowering, activation, compiler integration or old-compiler retirement is authorized by these results.
