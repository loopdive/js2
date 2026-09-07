# Handoff — package C (backend consumption and replay) of the #3518 whole-program cutover

**Agent**: `ttraenkler/claude-fable-ir-backend-c-20260906` (Claude Fable 5.1, Default effort).
**Claim**: `3518:backend-consumption-replay` on `origin/issue-assignments` — still HELD; release
only when the Codex lead acknowledges integration.
**Owning issues**: [#3518](https://js2wasm.loopdive.com/dashboard/issue.html?slug=3518-ir-only-default-and-direct-frontend-retirement)
(IR-only default and direct front-end retirement — package C row of the whole-program plan) and
[#3528](https://js2wasm.loopdive.com/dashboard/issue.html?slug=3528-ir-r8-shared-linear-prepared-program)
(IR-only R8: linear consumes the shared Prepared IR program — four dated implementation records
plus the correction plan are appended there; read them first).
**Worktree**: `.claude/worktrees/claude-3518-whole-program-c-20260906`
**Branch**: `claude/3518-whole-program-c-20260906`, head `fdeb628d` (increment 4).
**Base lineage**: A's typed handoff `8e89954c` → integration `7b2e8b03` → `2e68ccfe` → runtime leaf
`5c9fd95d`, all merged in with attributed merge commits. The branch therefore carries the whole
Codex integration lineage that is not yet on `main` (A's preparation driver, B's producers, root's
consolidation) — a PR from this branch is a stacked PR on that work, not a C-only diff.

## What C owns (files)

| File | Role |
| --- | --- |
| `src/ir/program-codec.ts` | lossless canonical codec for A's `prepared-ir-program-v1`; data-level decode; re-authenticating decode |
| `src/ir/program-physical-plan.ts` | pure, deep-frozen physical setup plan derived at acceptance; every unmaterializable resource is a located typed `unsupported` |
| `src/ir/program-consumer.ts` | `acceptPreparedIrProgram`, one-argument `emitAcceptedIrProgram`, `isAuthenticAcceptedIrProgram`, `acceptedPhysicalSetupPlan`, `emittedStartupAdapterIndex`; module-private acceptance/emission authority; C's three observation phases |
| `scripts/ir-whole-program-replay.mjs` | fail-closed fresh-process replay with pinned oracle, schema validation, synchronous module census |
| `tests/helpers/ir-whole-program-codec-fixture.ts` | synthetic COMPLETE program (6 bodies, 6 ABI export aliases, NaN/-0/Infinity/bigint constants) |
| `tests/helpers/ir-whole-program-replay.ts` | accept→emit→instantiate→compare helper, oracle value domain |
| `tests/issue-3518-program-codec-replay.test.ts` | 27 tests: codec, probes, re-authentication, consumer, A-produced programs, child replay |

Not C's: `src/ir/backend/linear-integration.ts` edits are allowed under the R8 grant but were not
needed; `src/codegen/program-abi-session.ts` and the scoped-seal test are protected; A owns
`program.ts`/preparation/validation/wiring; B owns runtime producers; D owns application fixtures.

## The contract, as landed

1. Bytes are accepted only if `encode(decode(text)) === text`; data domain = exactly what A's
   `freezePreparedIrValue` preserves (records incl. `__proto__`/integer keys, holes vs undefined vs
   null, Map/Set, bigint, -0/NaN/±Infinity, branded recursive class shapes).
2. `decodePreparedIrProgram` regenerates every persisted runtime projection through the pure
   `prepareWholeProgramRuntimeManifest`, refuses any `preparedIrDataMismatch`, freezes the regenerated
   joins in place (WeakMap plan/manifest authority) and runs A's `assertPreparedIrProgram`.
3. Acceptance = A's validator → exact backend/target projection → unit-body closure on the PHYSICAL
   functions → backend legality → physical plan. Gaps never become a smaller module.
4. Emission reserves tag/imports/globals/slots, freezes the index space, plans+seals A's
   `ProgramAbiMap` and binds reserved indices, lowers all bodies or nothing, materializes
   `wasm-start`/`__module_init` and ABI export aliases by index space, and derives receipts from the
   module's functions.

## Measured state (2026-09-06)

- 27/27 tests; typecheck 0; LOC/function/coercion/oracle/dead-exports gates OK; hooks run without
  bypass on increments 3–4 (the changed-root lane self-skips at >20 inherited root-test changes; the
  C suite was run directly).
- Runs on both backends via codec + internal emission: synthetic fixture; A-produced two-source
  subset (`main()=42`); `export let answer = 42` (global export + start adapter); `fail()` throw
  (local and shared `__exn`); user body named `__module_init`.
- Original mixed application (D's exact sources, digest `236fa7d9…` = `sha256(JSON.stringify(files))`):
  codec-identical and mismatch-free, but wasmgc:host is `unsupported` at acceptance with ONE gap —
  `async body run needs scheduler/promise runtime materialization`; the linear projection is refused
  at preparation (`promise.capability.create has no linear adapter`). Incomplete by design.
- Three-source common fixture `594eaf3f…` (initial 24 / result 27.605551275463988) not yet
  attempted through C: needs the runtime-callable `__new_ReferenceError` provider physically
  materialized (A has declared it; no emitter/provider body exists yet).

## Next steps, in order

1. Runtime-callable provider materialization (self-hosted / runtime-callable / host-callable
   providers) in the physical plan + emission, so `594eaf3f…` and then the mixed app can emit —
   needs B/A's provider bodies; do not invent them in C.
2. Non-scalar carriers (string/vec/object/class layouts) and reference-typed global initializers.
3. Linear memory plan materialization for programs with allocation sites.
4. Route `compileLinearIrFunctions` onto `acceptPreparedIrProgram`/`emitAcceptedIrProgram` once
   A's public wrapper hands the linear driver a `PreparedIrProgram` (A owns WasmGC wiring).
5. Consume D's signed fixture manifests read-only (`8024ccc5`) once integrated; never adopt an
   unsigned runner.

## Traps hit (so you don't)

- `preparedIrProgramAbiLookup(program)` runs A's FULL validator; use `preparedIrDraftAbiLookup(entries)`
  for construction-time lookups.
- Async runtime attachments carry WeakMap authority that clones lose — regenerate, never copy.
- `JSON.stringify` orders integer-like keys numerically and cannot spell `-0`; the codec writes its own JSON.
- `identity.ts` imports TypeScript at runtime; use `identity-values.ts` in anything the replay child loads.
- `check:dead-exports` on this machine needs root's spaced-path fix (in `2e68ccfe` lineage).
- Load gate: launch tests/typecheck only when 1-minute load < cores − 2 (10 cores here).
