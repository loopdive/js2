# Session B: Linear repeat implementation checkpoint

Branch: `codex/6892-linear-repeat-bulk-copy-20261007` on fork, based directly
on authenticated canonical main `e7760d1c2af4636ede6a352154d193b234af5fc4`.
Accepted Astra High plan commit: `6baa878005`.
Plan: `plan/issues/6892-linear-repeat-bulk-copy.md`.

The prior independent stack-admission fix is PR6561 at exact HEAD
`12defc659a8a6fd3ec1ce2f08808a47392a4f9e8`; it is not a dependency of this
branch. Session A retains shared integration/compiler/source-map ownership
and final queue submission. Neither branch retires legacy code.

## Exact ownership

Canonical claims use `CLAIM_ASSIGN_REMOTE=upstream`; implementation claims
were effect-verified before Sol6.1 Medium writers were released:

- `6892:linear-repeat-kernel-20261007`, owner
  `ttraenkler/codex-linear-b-repeat-sol61-20261007`, branch
  `codex/6892-linear-repeat-kernel-20261007`: only
  `src/codegen-linear/string-repeat.ts::addLinearStringRepeatRuntime`'s
  payload-copy region and associated local declarations/comments.
- `6892:linear-repeat-tests-20261007`, owner
  `ttraenkler/codex-linear-b-repeat-tests-sol61-20261007`, branch
  `codex/6892-linear-repeat-tests-20261007`: only the new
  `tests/issue-6892-linear-repeat-bulk-copy.test.ts`.
- Parent owns this handoff and integration of the reviewed issue plan.

No shared compiler/API/registry/preparation/legality/metadata/index/source-map
edit is released. Host JS repeat, provider-reader verification and active
Linear issue6865 scopes remain owned by their existing claimants. Existing
repeat registration, guards, allocation, ABI, reservation and receipts remain.

## Acceptance boundary

The initial bulk-only candidate is exact commit
`9544cc223f46c58bfa4f9f8bb2c00ba3d78a1d9e`. Astra reviewed source and test
instrument without finding concrete correctness blockers. Existing unchanged
repeat controls pass25/25. Four paired runs (baseline/candidate, then
candidate/baseline) each pass54/54 new tests and complete all8 bounded
measurements. All80 complete functional rows per run compare exactly equal;
batch allocation, memory-growth and checksum state also match exactly.

Evidence is in `plan/log/6892-linear-repeat-20261007/`: comparison JSON and
losslessly compressed raw logs retain every observation and seven timed samples
per case. The original source is e7760d1c2a; candidate source/test SHA256 and
Node/V8/options are recorded in the JSON. The test digest matches all runs.
Command uses `JS2WASM_BENCH_LINEAR_REPEAT=1`, the new test file, serial single
worker, and default reporter. No original failure/case was removed.

**Not accepted for landing yet:** large N=65537 cases improve 2.38–4.09x in
these samples, but short-output cases show measured slowdowns, including
two-byte N=9 at about0.30–0.33 baseline/candidate ratio in both orders.
Intermediate results are mixed, not a universal speedup. Astra is specifying
a bounded follow-up before acceptance; keep this PR on hold until that
blocker is addressed and equality/measurements rerun. The baseline remains
unchanged and all bulk-only evidence is preserved.

The remaining plan requires identical semantic/provider
tests on baseline and candidate, real source-derived IR owner/receipt/output
proof, memory-integrity and negative controls, and paired bounded performance
measurements. Full output equality is required; timing alone cannot authorize
delivery. Non-ASCII provider tests do not widen semantic IR admission.

The global IR migration remains incomplete. In particular, full end-to-end
prepared-program equality and retirement proof belong to final integration;
these independent runtime/performance slices cannot substitute for them.

Generated-evidence claim: `6892:linear-repeat-evidence-20261007`, owner
`ttraenkler/codex-linear-b-repeat-evidence-20261007`, integration branch above;
scope only this handoff and `plan/log/6892-linear-repeat-20261007/`.

## Verified Session A publication and partition

Read exact fork publication `5a4b64e1d637ab253c2d2107d45142f021c217c4` on
`codex/ir-session-a-coordination-20261007`, including its complete handoff,
issue6889 plan, architecture contract and referenced goal documents.
A's integration source at fab22c35ff plus45 local changed paths is explicitly
unpublished; no future source commit is assumed as a consumed dependency.
A reserves shared compiler/entry/context/proof metadata and prepared paths,
including `src/ir/backend/linear-emitter.ts` and `linear-integration.ts`.
The two B runtime files and new B tests do not overlap A's published45-path
inventory; no shared file or function handoff is inferred.

B identity is the owner of the exact6888/6891/6892 claims recorded in these
handoffs. Published stack fix: PR6561, head12defc659a8a6fd3ec1ce2f08808a47392a4f9e8.
Published repeat checkpoint: PR6563, held at b7c53b0426dad6407520de9b58c4db34b4bd6a04
pending the bounded follow-up. A alone coordinates final queue submission.
Issue6888's f32 emission remains blocked on shared semantic admission and an
explicit A file/function release; this session makes no shared wiring edit.

## Hybrid checkpoint and integration requirements

Tested hybrid runtime/test commit:
`f9800cadcb9c33f928ba9b8e96ad1a0abf1bcbc1`. It preserves the bytewise loop
through64 payload bytes and uses the bounded bulk algorithm above64. Only the
previously released function and new test changed. Astra High specified and
reviewed the adjustment; Sol6.1 Medium implemented the disjoint code/tests.
Seven new boundary cases preserve all original cases and the timed instrument.

Four paired amended runs each pass61/61. Parent verified exact deep equality
of all90 full functional rows and every batch's allocation/checksum/memory state.
The three unchanged repeat controls also pass25/25 on the hybrid candidate;
their complete generated log is retained alongside the paired evidence.
All8 measurements finish within the instrument's30-second cap. Full provenance,
seven samples/case, medians/spreads and compressed raw logs are published beside
the intact bulk-only evidence. Test digest:
`b0bb3cf778df90f3bef641f923765260bfdcbc2fd168a26a85508aacd7079898`.

Correctness/equality is bounded to these tests; **performance remains unresolved,
so PR6563 remains on hold**. Short medians match or improve in both pair orders,
and large medians improve2.09–6.30x. The `abc` N=1024 result is27.5% slower in
one pair but3.56x faster in the other, with wide spreads. Neither suppress that
regression nor claim universal improvement/tiering. No further tuning sweep is
authorized by this plan. A reviewed controlled measurement amendment is the
next performance step; it cannot replace historical failures or raw observations.

Refreshed canonical main: `8ac2ef29a37cb8edc217b11604c29bb11ef76932`.
No B kernel/test path overlaps its intervening changes. Branch retains exact
e776 experiment base; latest-main integration/equality remains A's responsibility.
PR6561 is independent and must not wait for acceptance of this optional
performance candidate. Neither PR supplies full PreparedIrProgram coverage,
end-to-end equality, failure preservation across the full compiler or retirement.

## Next allocator scope requires a real handoff

Astra's read-only follow-up to issue6891 identified unchecked unsigned endpoint
and failed-growth handling in `runtime.ts::addRuntime`'s standalone allocator.
This is source inspection, not an executed large-index admission result. No
new issue, source edit, test or claim was created for it.

Fresh upstream claims at `23bc631ba98b9188051a4f7bef800de19fbb4688` hold bare
issue4540 in-progress for `ttraenkler/claude-opus`, branch
`claude/linear-memory-quickjs-backend-gkhszu`, published upstream tip
`48360c40b32cbaa58505c189df193608d359cb1f`. The existing plan owns overlapping
`addRuntime` assembly/locals; no explicit standalone partition was found.
A's file exclusion is not a release from that claimant.

Requested release before implementation: only `addRuntime::standalonePrologue`
and standalone-only scratch-local declarations plus one new issue-specific test;
leave linked/chunked prologue, shared tail, options, globals, ABI and wiring with
their owner. The designated owner or A's explicit coordinated reassignment must
publish that partition first. Until then continue only truly independent scopes.
