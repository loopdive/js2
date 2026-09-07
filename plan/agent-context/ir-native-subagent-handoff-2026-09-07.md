# Native subagent handoff for the IR migration

The user requested native subagents instead of separate work sessions on
2026-09-07, retaining Astra High planning and Astra Low implementation.
Existing app sessions were independently checked idle before replacement;
their worktrees and drafts remain intact. No historical work is replayed
merely because its old claim is still held.

## Active ownership and publication

Updated 2026-09-08: the entries below preserve initial dispatch provenance.
F0 `a877767aa16406e945ce9fed0742fb1907ec18f2` landed in PR 5733 at
`fa9e1ea0c7986b53f290e88822b262ab10ca62f4`; parent fetched upstream/main
and verified ancestry and identical checkpoint content.
N1 is composed in the parent's isolated checkpoint, with 34/34 tests,
typecheck, inventory and exact paired byte/order evidence. Its gate is now
composed: preservation exits 0 with 6/6 canonical full/cut witnesses, strict
exits 1 on both unchanged imports, and the old ratchet remains 25/25. Normal
hooks and ready publication are parent-owned; final status lives on the PR.

Maxwell's same native context completed the seven-file canonical ABI draft
in `/private/tmp/js2-3518-program-abi-seam-20260908`, preserving the original N1
draft. Its 59 tests and typecheck passed; parent artifact pairing and integration
remain pending. Boyle's same context completed the user-approved two-verdict extension:
exact open-site provenance and additive controls, with strict unknown failures
retained, passing all 105 controls. The expanded map and approval are in the
[two-verdict contract](./3518-open-import-preservation-contract-2026-09-08.md).
The parent owns policy/package integration, serial validation and every PR.
Huygens's Astra High native plan is complete; no standalone app task was added.

See the [current validation/handoff](./3518-native-foundation-validation-2026-09-08.md)
and [ABI implementation plan](./3518-program-abi-seam-dispatch-2026-09-08.md).
The [later lowering-cycle proposal](./3518-lowering-cycle-plan-2026-09-08.md)
is preserved but not dispatched or accepted as implemented.

### Initial dispatch record

- Coordinator: integrate and publish the boundary/identity checkpoint from
  `codex/3518-ir-foundation-checkpoint-20260907`. D0 commit
  `57aa0d73025526812d06a3863d63552929618288` is pushed and its upstream SHA
  verified in ready PR #5733. F0 and later documentation form the next
  checkpoint, with its publication state recorded by the PR rather than this
  pre-commit handoff.
- Maxwell, native agent `01a07dc6-8ad5-7e72-a010-f877ea37c701`: N1 native queue,
  instruction-model and physical-primitives extraction. Branch
  `codex/3518-n1-native-foundation`, worktree
  `/private/tmp/js2-3518-n1-native-foundation-20260907`, base D0. Ten-file draft
  completed; execution tests, typecheck and composition remain unrun.
- Boyle, native agent `01a07dc6-8bfd-7991-be8d-a7b3e3105aa1`: moved-function
  production reachability gate. Branch `codex/3518-moved-runtime-gate`, worktree
  `/private/tmp/js2-3518-moved-runtime-gate-20260907`, base D0. Owns only
  `scripts/audit-legacy-reachability.mjs` and its new regression test.
- The coordinator owns the boundary manifest and the shared local validation
  slot. Follow the exact map in
  [the native extraction dispatch](./3518-native-wasm-foundation-next-dispatch-2026-09-07.md).

All retained implementation and planning changes must go through ready,
non-draft PRs in `loopdive/js2`; no direct-to-main pushes. A completed worker
message is not acceptance: compose, test, inspect the actual CI/review state,
and shepherd the PR. Do not merge known failing checkpoints or weaken gates
to satisfy publication. Intermediate extractions do not complete #3518.

## Preserved former sessions and work

- `Spec remaining direct-codegen to IR…`
  (`01a07bdd-1e0d-7731-8dbe-1529e04de34f`): Astra High specifications in
  `/private/tmp/js2-ir-recovery-docs-20260907`. Initial plan PR #5730 merged;
  subsequent approved refinements and N1 dispatch are copied into the
  coordinator's follow-up checkout for publication.
- `Refresh IR evidence checkpoint #5717`
  (`01a07c8d-fecf-76e1-80c9-a811c6227419`): frozen D0 source in
  `/private/tmp/js2-3518-boundary-d0-20260907`, independently composed and
  validated by the coordinator in D0. The older evidence PR #5717 remains
  held; D0 does not settle its missing prepared-phase evidence.
- `Lane A prepared driver forward continuation`
  (`01a07bf6-3518-7103-a705-3ef1e980d145`): F0 source in
  `/private/tmp/js2-3518-foundations-f0-20260907`, copied into integration.
  Separate producer/schema draft at
  `/private/tmp/js2-3527-p-async-resources-20260907` remains preserved and
  paused, not accepted or claimed as published.
- `Implement R7 prepared async consumer…`
  (`01a07d40-3d39-7532-9d3d-0f0c956d8bb8`): five-file consumer draft in
  `/Users/thomas/.codex/worktrees/e042/js2` remains preserved and paused.
  Its tests are unrun. Do not introduce new host implementation while
  adapting retained work to the standalone WasmGC priority.
- `Extract native async resource closure`
  (`01a07d4d-64ac-75e1-90c5-345296826880`): PR #5727 merged. Preserve
  `/Users/thomas/.codex/worktrees/642d/js2`; N1 continues from the merged
  source in a new isolated worktree, not by replaying that commit.
- Cloud `Dependency Audit Handoff`
  (`6a9f1bf0-1a48-83eb-8b57-d534639c3870`) and `Verify Wasm Regression`
  (`6a9f1c0e-f6c0-83eb-af85-24893f498119`): completed read-only evidence,
  no implementation writes. Retain revision attribution and evidence gaps;
  the native queue's historical CI failure remains unexplained, and matching
  short hash prefixes are not a full byte-identity proof.

The unrelated `Shepherd stuck PRs` peer was not retired or reassigned.
Older held B PR #5716 and all its ten unresolved findings remain preserved.

## Validation and operating notes

- D0's 42 controls pass. Complete architecture mode intentionally fails;
  valid inventory alone is not full separation.
- The F0 composition initially passed 112/113 tests; the single existing
  export-assignment identity expectation also fails on unchanged main
  `95186a4835a1fe7a024172a61be94781c7995670` (31/32). The #5332 module-init
  contract explains the additional terminal; do not silently weaken the test.
- Normal push typecheck detected a missing F0 `IrBindingId` type import.
  The coordinator restored it; the subsequent normal typecheck passed.
- The coordinator reconciled the stale identity expectation with #5332:
  both export-default and export-equals own a module-init terminal, while
  their support units still have no terminal owner. The four-file focused
  identity/foundation/export-default cohort now passes 45/45 tests.
- Use one local test fork: `VITEST_MAX_FORKS=1`, 2 GiB, explicit single-fork
  and no-file-parallelism flags. `--maxWorkers=1` alone does not override
  this repository's explicit fork configuration.
- The claim helper hardcodes a push bypass. N1 reported that its original
  claim used that helper; do not repeat it. Subsequent claim operations must
  retain all atomicity/verification guards while using normal Git push hooks.
  Existing claims are not erased or rewritten to conceal the deviation.
- Cross-task disclosure restrictions remain in force. The coordinator used
  independent source validation for D0, not a withheld worker report.
