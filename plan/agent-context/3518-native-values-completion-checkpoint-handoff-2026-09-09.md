# Native values completion checkpoint

This isolated checkpoint starts at published
`33954266647300786ad06875688b33bbf1196d04` and supplies producer completion
authentication, not full Promise/async materialization or retirement proof.

## Scope and provenance

The worker owns `src/backend/wasmgc/resources/native-values.ts` and
`tests/issue-3518-native-value-resources.test.ts` under verified claim
`3518:native-values-completion`, owner `ttraenkler/codex-native-values-completion`,
write `37253-cfvi49ko`, claim commit `2cf23eb56f73ea809a4ee09498626da431f7fd0c`.
Historical claims and frozen E2/B3/inliner work remain preserved.

Parent explicitly handed off the following exact integration changes:

- `src/wasm/physical/module-reservations.ts`: only the existing-map-based
  `assertCompletedReservation` method; no new registry or allocator change.
- `tests/issue-3518-reservation-completion-assertion.test.ts`: 15 ledger controls.
- `src/backend/wasmgc/program/native-string-values.ts`: only the completion
  accessor import, missing issued-plan guard, and numeric-branch call.
- `tests/issue-3518-native-scanner-value-chain.test.ts`: completion observations,
  exact returned-pack use, and four original/decoded × UTF storage cells.

No E2 output requirements/options, shared flatten restructuring, concat emitter,
generic callable admission, B3 wrappers, or mixed planner changes are included.
The numeric source fixtures use APIs already present at the pinned base.

The producer records success only after all four real fill calls. Completion
requires its exact issued plan and retained dependencies, the existing ledger's
actual function/global fill-map membership and snapshots, canonical type checks,
and real scanner completion for native-string mode. It allocates, fills, exports
and seals nothing. Missing/nonthrowing-omitted fills remain rejection controls;
no recovery after a poisoned ledger is asserted.

## Evidence and limits

Parent's broader composed tree measured session `97495` exit0: 88/88 across
native-value-resources and native-scanner-value-chain in 30.89 seconds; separate
ledger controls 15/15; source TS7 session `7411` exit0. These are PARENT results,
not proof that this extracted candidate passes. All earlier source receipts and
original test controls are retained; no donor hash reseeding.

Initial extraction left isolated validation pending. The subsequently granted
serialized slot measured formatting exit0 (all six code/test files unchanged),
source TS7 session `71740` exit0, three focused suites session `92480` exit0:
103/103 in 29.03 seconds, and inventory session `34363` exit0 with `errors: []`,
`architectureComplete: false`. Normal publication hooks follow these receipts.
No new local Test262 or broad suite is requested. Publication must be a non-draft held PR
targeting `codex/3518-number-format-consumer-20260909`, not main. Parent exact-head
review remains mandatory before any merge; no hook/signing bypass is authorized.

## Frozen extraction blob manifest

Git blob identities before isolated validation:

- `src/backend/wasmgc/resources/native-values.ts`: `4539bf5c77ab4d9fd41db188516f3a60dc0f291a`
- `tests/issue-3518-native-value-resources.test.ts`: `16a022978a737030328f9d952dc9843750eb1d59`
- `src/wasm/physical/module-reservations.ts`: `16ab305b019661a23b114e3c76ad5f6306de0d06`
- `tests/issue-3518-reservation-completion-assertion.test.ts`: `9c22aae17c0dd4fb0afdd6f6ea68edbe2c7bf857`
- `src/backend/wasmgc/program/native-string-values.ts`: `7797d7e73b932295167c8ebc142cc18bdf450cbe`
- `tests/issue-3518-native-scanner-value-chain.test.ts`: `8214fdae22d18d67d287a34a7dc9337d505913fa`

Scoped diff checking passed. An unscoped diff encountered the existing Git LFS
shared temporary-directory permission denial; no filters/configuration were
changed and no affected file was rewritten to work around it.

Reproduction commands (existing pinned dependencies; sequential execution):

```sh
NODE_OPTIONS=--max-old-space-size=2048 GOMEMLIMIT=2GiB GOMAXPROCS=1 node node_modules/typescript7/lib/tsc.js --noEmit -p tsconfig.ts7.json
NODE_OPTIONS=--max-old-space-size=2048 VITEST_FORK_MAX_OLD_SPACE_SIZE=2048 VITEST_MAX_FORKS=1 node node_modules/vitest/vitest.mjs run tests/issue-3518-native-value-resources.test.ts tests/issue-3518-native-scanner-value-chain.test.ts tests/issue-3518-reservation-completion-assertion.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
NODE_OPTIONS=--max-old-space-size=2048 node scripts/check-compiler-boundaries.mjs --mode inventory --json
```
