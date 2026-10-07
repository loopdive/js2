# Session B: Linear string-slice bounds normalization

## Frozen coordination epoch

- Issue: 6899, **Linear string-slice bounds normalization**.
- Integration branch: `codex/6899-linear-string-slice-20261007`.
- Starting HEAD and verified canonical main: `8f3b70b37a37d5f475f759d155391621d79ffc92`.
- This is a planning checkpoint. No implementation or executed regression result
  is asserted here. Publication HEAD and PR must be recorded after normal hooks.
- Session A's published coordination branch was verified at
  `5a4b64e1d637ab253c2d2107d45142f021c217c4`; its document is
  `plan/log/ir-coordination-session-a.md`, already available on canonical main.

## Exact ownership

Canonical claims use `CLAIM_ASSIGN_REMOTE=upstream`:

- `6899:linear-slice-plan-20261007`:
  `ttraenkler/codex-linear-b-slice-astra-20261007`, integration branch above;
  writes only `plan/issues/6899-linear-string-slice-bounds.md`.
- `6899:linear-slice-source-20261007`:
  `ttraenkler/codex-linear-b-slice-sol61-20261007`,
  `codex/6899-linear-slice-source-20261007`; parent reviewed Astra's plan and
  released its finite K scope. Existing seam is only
  `src/codegen-linear/runtime.ts::addStringRuntime`'s `__str_slice` registration,
  body and local count, plus one import and the used target leaf
  `src/codegen-linear/runtime/string-slice.ts::linearStringSliceBoundInstrs`.
- `6899:linear-slice-tests-20261007`:
  `ttraenkler/codex-linear-b-slice-tests-sol61-20261007`,
  `codex/6899-linear-slice-tests-20261007`; writes only the new
  `tests/issue-6899-linear-string-slice-bounds.test.ts`; parent released the
  plan's finite T scope. Existing test files remain unchanged.
- Parent owns this handoff, composed validation, signed commits and PR publication.

Session A retains compiler entry points, shared emitters/integration, preparation,
provenance and source-map files. This task does not edit those files, the
allocator, runtime registry, array helpers, or existing fixtures.

## Acceptance and dependencies

This is a target runtime correctness prerequisite, not an expansion of shared
`PreparedIrProgram` coverage. The published shared consumer still refuses Linear
allocation materialization. A owns that interface and final integration/queue.

The proposed defect is source-derived: `__str_slice` subtracts and copies raw
signed bounds instead of normalizing them first. Preserve that qualification
until a frozen baseline reproduction runs. Tests must compare bounded original
failures, complete output payloads and unchanged source memory, with actual
overlay admission distinguished from the direct control. Preserve the existing
Unicode, numeric-conversion and shared-consumer limitations separately.

Do not retire legacy code, alter protections, claim performance, or submit to the
queue from this checkpoint. All subsequent evidence belongs with the issue and
must identify exact source/test epochs and actual denominators.
