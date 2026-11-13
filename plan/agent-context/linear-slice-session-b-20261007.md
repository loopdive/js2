# Session B: Linear string-slice bounds normalization

## Frozen coordination epoch

- Issue: 6899, **Linear string-slice bounds normalization**.
- Integration branch: `codex/6899-linear-string-slice-20261007`.
- Starting HEAD and verified canonical main: `8f3b70b37a37d5f475f759d155391621d79ffc92`.
- Initial publication was a planning checkpoint. The tested implementation
  packet below records later evidence; verify its latest publication separately.
- Published plan/handoff checkpoint: `519b45f5e24898a0eaed0fd34a470a7f4e775c6d`,
  [PR #6575](https://github.com/loopdive/js2/pull/6575), non-draft and held.
- Reviewed source implementation: `beda2d0c15db4027b7407d3b0382fd31323fb394`,
  composed with the identical regression instrument in candidate
  `899883bec7874bc438fe0955d2094d67bb04abc0`. Astra static review found no
  actionable defect. Candidate passed 47/47 versus baseline 22 pass / 25 fail.
- Signing correction: these new commits have no `gpgsig`. This host has no
  configured `commit.gpgsign` or `gpg.format`; signing was not disabled or
  bypassed. Earlier references to signed commits were assumptions, not evidence.
  Normal commit/push hooks did run; the plan push's numeric control passed 18/18.
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

The original source-derived prediction was confirmed by the frozen baseline:
`__str_slice` subtracted and copied raw signed bounds instead of normalizing
them first. Tests compare bounded original
failures, complete output payloads and unchanged source memory, with actual
overlay admission distinguished from the direct control. Preserve the existing
Unicode, numeric-conversion and shared-consumer limitations separately.

Do not retire legacy code, alter protections, claim performance, or submit to the
queue from this checkpoint. All subsequent evidence belongs with the issue and
must identify exact source/test epochs and actual denominators.

## Tested implementation packet

Baseline and candidate used identical test SHA256
`d808dc5b064c536f7e94576325fab46dc6ec489aeb453d8936fa60058097252b`
for final V2 candidate `cfbfe60ce1`; runtime/leaf bytes are unchanged from the
source epoch above. V1 test/logs are archived, and V2 changes only two host
WebAssembly buffer typing sites. All raw row records match V1 exactly on each
arm, with no excluded fields. Strict test-inclusive TS7 finished exit 0.
All 45 semantic rows and two allocator-instrument controls ran without skips;
12 unmodified-allocator transparency comparisons are separate. All 22 baseline
passing rows match exactly except for the two binary digest fields. Nine public
overlay owners prove real admission, binding and installed calls; no shared
PreparedIR expansion is asserted. Direct-mode global reports may be stale and
are not ownership evidence.

The combined three-file control population measured 45 pass / 3 fail out of 48
on each revision.
All original failure identities remain: fixed vector admission, core string
admission, and UTF-16/omitted charCodeAt capability. No fixture or expectation
changed. Lossless raw logs and comparison are published alongside the issue in
`plan/log/6899-linear-string-slice-20261007/`. See the issue for exact source,
test, runtime/leaf and raw-log hashes, watchdogs and qualifications.

A may integrate this bounded correctness packet after reviewing its evidence;
it does not release B into A's shared files or authorize queue submission.
