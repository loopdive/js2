# Conversion boundary and construction ownership checkpoint

2026-09-27. Data-only continuation of held PR 5883. No old compiler retirement,
production staging activation, acceptance-floor change or new allowance.

## Recovery and source changes

Active integration tree remains `/private/tmp/js2-5883-main-688-20260927`, branch
`codex/5883-main-688-20260927`, HEAD
`a7c550e38b57b8e5ff8c0f06840d4f12b13a5d4e` plus the preserved dirty repairs.
Restore the preceding `main-688-followup` snapshot first, then apply the two
incremental patches here once. Both reverse-applicability checks against the
actual integrated files passed. Do not overlay them on an already patched tree.

- `coercion-increment.patch.txt` SHA-256
  `cdbcedf96468a9a64609f9a20138bd829f66617383b66cc264bf5547ee35d63e`.
  Four production files and one new 16-case test. The engine owns prepared
  truthiness/Number-to-string calls, and the consumers preserve their former
  provider-registration sequence and instruction ABI. No token hiding or
  permissive fallback. `architecture-review.md` is the reviewed specification.
- `construction-lease-increment.patch.txt` SHA-256
  `2140fab0b57385f688c8a1e496c6c63f32d0d9af9596820f1449a9c39300b810`.
  Body ownership and staging editor authenticate an exclusive construction
  lease before mutation or closure. Wrong-body, foreign, stale and raw tokens
  cannot close or edit a claimed construction. Still not wired into production.
  The one existing editor fault-injection setup is moved before its exclusive
  claim; its assertions and denominator remain. No fixture was removed.

## Measured results

- Ownership suites: **128/128 pass**, all seven files, no skipped tests, both
  in the implementing agent's tree and in the parent integration tree. See
  `lease-agent-execution.md`. Parent report `.tmp/construction-lease-parent.json`
  SHA-256 `916c593ae1658bdfeb6c294702ac190f227545f39a270f39fe96024553467d4e`.
- Prepared conversion API tests: **16/16 pass** on their first execution.
  Parent corrected only a mock field spelling (`funcs` to the actual
  `functions`) and formatting before that first execution. Report
  `.tmp/prepared-coercion-unit-first.json` SHA-256
  `1e1a4d0aca981855ddb47075ada66c242ef734a856f3d3eb3e91f7e98b760ea8`.
- Full four-file runtime population before and after: **113/136 pass, 23/136
  fail on each arm**, zero changed per-test records. No test or expectation
  edits, exclusions, retries or timeout changes. `runtime-pair.json` preserves
  all 136 rows, fixture hashes, report hashes and available failure detail.
  Four failures per arm have null exception detail; this is not equality proof
  of those exception values. The raw JSON reports remain in the active tree.
- Actual registration observation: all **seven named helpers** present and
  nonempty across three fresh standalone/native-string contexts. Complete
  generated modules, ordered function maps, struct maps, field registries,
  helper definitions and caller-state hashes match exactly before and after.
  The contexts contain respectively 308/300/419 functions and 124/120/208
  types. See both `registration-*.json` and the unchanged observer source.
  This proves bounded preservation, not complete program/IR equivalence.
- Full source TypeScript 7 plus the eight ownership/editor/conversion test
  files: pass, including negative type assertions. Exact config is active-tree
  `.tmp/tsconfig-coercion-lease.json`.
- File/function size gates against upstream `688eb4de`: pass. Conversion
  vocabulary gate: **now pass**, no new allowance or baseline edits.
  Checker-query gate: pass (`getTypeAtLocation -2`, `ctx.checker -2`).
- Inventory: valid, zero inventory errors; architecture incomplete, graph
  incomplete, four unknown edges. All staging migration debt remains explicit.

## What remains blocked

The production reachability audit still reports the same 16 newly unreferenced
functions, mostly unwired staging helpers, and two nonliteral dynamic-import
sites. Core observations pass (12/12 callers, 10/10 type references), but these
do not certify closure or retirement. Original 23 runtime failures remain real
failures. Do not refresh a baseline, delete required work or add dummy callers
to turn this into a passing acceptance result.

Audit log: active tree `.tmp/coercion-lease-dead-exports.log`. Review the real
production integration plan next, then preserve exact behavior while connecting
the ownership/editor foundation to pending operations and provider closure.
The old compiler remains until the new path is complete and equivalent.

## Queue and continuation

PR 6182 (wide BigInt String conversion) is **on main** at
`89bd4bd78ae83a34d8e17255a85e35b6b8b171c9`. Ancestry to fetched upstream main
was checked, and all three production file blobs match its reviewed head
`6670264762a294f502753c67e318edde38dc10ef` exactly. The integration tree has not
yet merged this newest main commit; do not mistake an archived snapshot for a
new main merge.

PR 6183 is next in the protected queue. Its exact group commit is
`6eac568d412537091ca6201878fbc492deab3631`; CI, CLA and differential runs passed.
Test262 run `36299231652` remains live, watched by parent session `34093`, log
active-tree `.tmp/queue-6183-test262.log`. Reuse that live handle; do not restart
on observation timeout or refresh its queued head. PRs 6180 and 6184 follow.

All local validation processes above are terminal. No subagent holds the local
compiler slot. The network-only queue watcher does not occupy it. Original
worktrees and shared root are preserved; checkpoint publishing uses normal
hooks to the existing held PR only.
