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
