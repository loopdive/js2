# Exact original176 pair: terminal, slot returned

Subjects retained unchanged:

- Main `4418cd8510877c0fd5a3aab8a543934167e95c8c` in
  `/Users/thomas/Code/js2/.codex-worktrees/codex-5753-pair-main4418-20260927`.
- Candidate `a10bf6c3d1f129604c43c834a492db54a6ec93a2` in
  `/Users/thomas/Code/js2/.codex-worktrees/codex-5753-pair-candidatea10b-20260927`.

Main build handle71358 exit0; fresh adapter cache MISS, canary-verified
`229dd26a78e7173f`, compiler bundle key `e53af2a02b435deb`.
Main run21369 exit1: 154 pass, 22 fail, 300.21s.

Candidate build87481 exit0; fresh adapter cache MISS, canary-verified
`cae9213609e20b7f`, compiler bundle key `26063fa13c77d600`.
Candidate run98617 exit1: 38 pass, 138 fail, 274.49s.

Both maintained completeness validators exit0: exact176 registered paths and
canonical verdicts, all callbacks settled, zero explicit exclusions. No live
compiler/test process remains; slot explicitly returned before row analysis.
The runner's own Map worker timeout/retry remains in the candidate log and raw
verdicts; the agent did not kill/restart any run or worker. No infrastructure
build failure occurred. No fixture, gate, floor, setting, or production change.

## Current paired result

- 129 pass-to-nonpass losses.
- 13 nonpass-to-pass gains.
- 25 pass both; 9 nonpass both.
- Exact loss paths comprise124 class fixtures,4 object-generator fixtures,
  and Error/prototype/stack/setter-non-extensible-receiver.js.

These are newly measured current-subject results, not historical counts copied
forward. Independent per-path comparison against the original main935/candidate
b212 JSONL found ZERO status-or-error-text differences in either arm, across all
176 paths. Timing/timestamp fields are not claimed identical. Raw errors and
both complete rows for every pair are preserved, including nonpass/nonpass.
Shared class-evaluation0/8 remains a different population; no reclassification.

Machine receipt: `paired-result.json`, SHA256
`1336a4f9c85610a6bf4e373538b289a1cec8d1eeb6e3126325040c3b61dc038f`.
It embeds both full row sets, both full completion manifests, environment
receipts, subject SHAs, terminal handles/status, all176 paired rows, historical
differences, and SHA256/path records for logs/builds/environments/results.
`compare-receipts.mjs` is the read-only reproducible comparison, not a compiler
or test runner. `post-run-preservation.json` checks prepared corpus fixture/
harness hashes and both subjects' selected103 harness/build file hashes again.

Each arm's `.tmp/5753-original176/` contains full compiler-build, runtime-build,
provider-build, run and completeness logs, build/environment receipts and hash
lists. Original result and completion files are in each arm's benchmarks/results:

- `test262-standalone-results-5753-main4418-original176-20260927.jsonl`
- `test262-standalone-results-5753-main4418-original176-20260927.shard-1-of-1.complete.json`
- `test262-standalone-results-5753-candidatea10b-original176-20260927.jsonl`
- `test262-standalone-results-5753-candidatea10b-original176-20260927.shard-1-of-1.complete.json`

The exact176 list/corpus/source hashes remain in `preparation.json`; invocation
and prerequisites remain in `EXECUTION-PLAN.md`. Pinned C runtime is unchanged
`073742801ba76347371be277f6d275488badce1df6bfb480741548ec2a279d45`, copied by
the provider builder; both compiler-specific adapters were freshly compiled,
not copied from historical subjects. Node22.23.2, standalone/auto, QuickJS,
one worker, original strict policy, and original b363 corpus were preserved.

No source fixes, commits, pushes, hold removal, or legacy retirement. The current
pair confirms the scoped landing regressions remain. It is not a full-floor
measurement or full-IR acceptance. Await parent attribution/next-run direction.

Tracked copy of the machine receipt:
`plan/agent-context/5753-current-original176-pair-20260927.json`.
The original receipt remains unchanged in the isolated candidate checkout.
