# Boundary-report custody repair, 2026-10-08

Original PR6593 head `7be295c0d8611882ec09492af8d29c229bb4bfba` failed real
quality job113443658866 (run37815701912) at changed-root step48. Its full raw
log remains `failed-job-113443658866.log.gz`; steps49–53 were not evaluated.
The trusted parent rejected the workflow-generated untracked root report
before spawning the append regression child. This is not a semantics failure.

The unchanged CI inventory producer was independently executed locally with
`--mode inventory --base HEAD^1`, at the same HEAD, strict exit0. Its opaque
10,924,371-byte output SHA256 is
`334f7ab83404b62659eaab5e0e06d6ec655f2e66c214742c4ed27dfab52d2cb3`.
The output reported inventory-valid/architecture-incomplete, zero errors;
neither those claims nor its embedded source data approve the append inputs.
The unchanged runner reproduced strict exit1 before child spawn in
`.tmp/6915-ci/run-H4QDf9`. Every generated original receipt/error artifact is
preserved under the `original-` prefix, without repairing that epoch.

Astra High specified the finite repair in the existing issue6915 Markdown;
Sol6.1 Medium implements only the runner's generated-report custody seam.
Exact claim `6915:ci-generated-report-custody-20261008`, unique owner
`ttraenkler/codex-linear-b-generated-report-sol61-20261008`, original write
`4156-17hxbrq8`. Source, test, fixtures, configuration pins, workflow and hook
remain outside the repair scope. All previous archives remain unchanged.

Candidate qualification and publication are not claimed by this failure record.

## Later repaired qualification (distinct epoch)

The pending runner patch executed at HEAD7be295/source tree953f74f8 with the
same independently approved source/test/fixture/config pins and producer report.
Runner SHA256 `ba0dd8a0ef4d036f70f730a31202af1879a27e273f7c3eea0e0521818de737d7`;
Node22.23.2. Sol implemented the finite seam;89 embedded controls passed in
both worker and parent execution. Astra's final read-only review found no
concrete blocker at that exact hash. No actual CI pass is inferred from review.

Actual `pnpm run test:changed-root` selected exactly the frozen append file:
36pass/0fail/0skip/0todo, strict child exit0,20,714ms and44,273,883 stdout bytes.
Raw report bytes before/after exactly equal; metadata retains the measured
10,924,371-byte population/digest independently of approved compiler inputs.
Full raw streams,38 graphs, decoded records, reporter and custody receipts are
retained. The executed runner bytes are retained, not substituted by a later
commit. A later publication hash is not the execution HEAD.

Replay from the repository root:

```text
node plan/log/6915-linear-append-20261007/ci-report-custody-20261008/compare.mjs
```

The replay requires all36 observation graphs and completion to equal repaired-v3
exactly, with no filtered graph fields; provenance remains separately retained.
It checks strict receipt/population, equal full before/after input snapshots,
raw report equality and digest/length, and exclusion from approved input files.
Original28/8 failures, original step48 failure, local failed reproduction and
every earlier fixture/archive remain unchanged. Actual repaired CI still needs
to pass. No native array/Unicode implementation, performance acceptance,
retirement, main delivery or HOLD release is credited.
