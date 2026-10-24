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

## Current-main controlled measurement packet (2026-10-07)

Canonical main refreshed and server-verified at
`a5c5689f9c85090d44f940204ae3c65605f01ce5`. The independent stack repair
PR6561 is now a main ancestor; its runtime/test files are exactly unchanged
from12defc659a8a6fd3ec1ce2f08808a47392a4f9e8. Fresh main execution passes
23/23, retained in landed-stack-main-validation.log.gz. This is not repeat
performance or full IR acceptance.

Repeat main-sync source epoch: `6b33a4934e8f95cc2d8c788f059844ffaa5a8f7b`.
Its source tree differs from main only in string-repeat.ts; hybrid kernel
SHA5ba8a23ed459fb717864e776813d5df09c1846a060e3a3ceaa7753a05db821b1
is unchanged. Accepted Astra High measurement-plan commit
`7df397224f886c3283ecc7db8b5ab20a5179d7d0` is remotely verified on the
existing non-draft held PR6563. Normal sync push protections include18/18
numeric-local parity. Fresh unchanged repeat controls at7df pass25/25;
their raw log is retained in current-main-hybrid-controls.log.gz.

Canonical publication read9e3618fc9c5c909667739d12878ed6fe4882f11e,
951 active records, proves unique exact paired-plan/capture/replay owners:
6892:linear-repeat-paired-plan-20261007 (Astra High),
6892:linear-repeat-paired-capture-20261007 and
6892:linear-repeat-paired-replay-20261007 (Sol6.1 Medium).
Their owner suffixes are repeat-paired-astra, repeat-capture-sol61 and
repeat-replay-sol61 under ttraenkler/codex-linear-b, each dated20261007;
branches codex/6892-repeat-paired-plan-20261007,
codex/6892-repeat-capture-20261007 and codex/6892-repeat-replay-20261007.
T changes only the existing issue test; R only the new issue-local replay
runner. No shared production scope is released. Parent alone runs heavy jobs.

Reviewed capture commit: `e8741f81fdf74156605ee76c396a57e474bd2278`,
test SHA19b728dfe6941a44941e0817f70c8c2b333f63e858a85cc596814686a3763e82.
Baseline source remains exacta5; candidate source remains exact6b despite
later test/document commits. Source trees are pinned and tested for clean
tracked/untracked source before and after capture. Capture never substitutes
for the old timed instrument and rejects mutually enabled capture/benchmark
gates. All61 fixtures and prior errors/results remain; new capture/replay
outcomes are still unmeasured at the authoring point of this paragraph.

### Measured outcome and replay commands

Final replay commit `f0f801f7959b1bdaec893439c1bfefadc9588aa9`, SHA256
9fc16d53922e7fb7696dc6a2a20bead36eddad41528eb2b0cfeb76b9e958ae9a.
Baseline capture actualHEAD a5; candidate capture actualHEAD e874. Both source
epochs/trees remain the pinned a5/6b above. Both full suites exit0,61/61;
exactly90 old functional rows compare equal without exclusions. New protocol
has one start/eight artifacts/one complete footer per arm. Capture raw hashes:
4543c75489723cbeebd0555219e78e63f0781e2029514e41c59258c33b43b928
(baseline) and8e4120a2dfafae754b6d10613bf8d570a3ded5549e0ec8eebeafe4e0643cfab8
(candidate). Each uses the identical committed19b728 test bytes.

Capture command in each isolated source epoch:
`JS2WASM_LINEAR_IR=1 JS2WASM_IR_STRING_BUILDER=1
JS2WASM_CAPTURE_LINEAR_REPEAT=1 JS2WASM_REPEAT_SOURCE_EPOCH=<pinned a5 or6b>
node node_modules/vitest/dist/cli.js run
tests/issue-6892-linear-repeat-bulk-copy.test.ts --no-file-parallelism
--maxWorkers=1 --reporter=default`. Baseline carries the identical untracked
new test, candidate the committed test. No capture/benchmark dual gate.

Primary replay uses ordinary Node with empty NODE_OPTIONS/no execArgv:
`node plan/log/6892-linear-repeat-20261007/paired-artifact-replay.mjs
--baseline <baseline raw capture.log> --candidate <candidate raw capture.log>
--test-sha256 19b728dfe6941a44941e0817f70c8c2b333f63e858a85cc596814686a3763e82`.
Parent wrapped it with `python3 -c 'import subprocess,sys;
sys.exit(subprocess.run(sys.argv[1:],timeout=35).returncode)'` followed by that
Node command, because no timeout/gtimeout/project watchdog was available.
This supplies the specified external35-second watchdog without modifying the
runner or engine options; neither watchdog nor internal30-second cap fired.

The single positive replay exits0,448 batches/8 cases,2125.015458ms. Every
quartet has exact unmasked initial/final memory bytes, pointers/checksums,
headers/full output and allocation state equality. Both artifacts execute in
one process with fixed balanced order and fresh instances; no reset, pre-grow,
GC forcing or tier claim. Full raw replay is paired-replay-v1.log.gz and its
complete raw SHA isf1f1d98181cd6f772876c1b3aa81ce921676bfdd50014d1236321e167a8dc200.
Summary retains all12 ratios and24 arm samples per case. Two xy medium/large
cases consistently improve; six—including abc N1024 and all short cases—are
mixed. **No performance landing acceptance**. PR6563 remains held; no repeated
tuning is authorized by this packet. A owns final acceptance and queue action.

Negative instrument controls: replace artifact binarySha256 values in a
separate generated baseline copy with64 zeros, or supply a separate empty
capture fixture. Both exit1 with explicit incomplete rows,0 cases/0 batches;
hash mismatch and missing full-suite summary respectively. Original captures
remain intact. Their raw rejection logs are retained beside the positive run.

Publication correction: the first plan-copy command stopped at line800 and
omitted its final three custody/retention lines. They are restored verbatim
from Astra's reviewed803-line document in this packet. No fixture, assertion,
kernel or executable instrument changed from that document-transfer fix.

Final canonical claim read3e507f8e81a7e08707f58df21bc88d7ae23630d6
has955 active records and the same three sole paired-slice owners. During
measurement, main advanced to534620a636c63c257bc5afb8d543d0306b26928c
via PR6565's GC generator changes. Those bytes are not in either frozen
source epoch and receive no equality credit here. This branch's merge-base PR
source diff is still only string-repeat.ts; no peer change is reverted.
A must refresh/integrate against its chosen current main and revalidate any
affected controls. Do not relabel the frozen a5/6b results as latest-main proof.
