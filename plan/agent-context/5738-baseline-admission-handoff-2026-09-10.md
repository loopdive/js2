# #5738 measurement baseline admission checkpoint

## Scope and landing hold

User approved a fail-closed baseline-admission repair on existing PR #5738.
Stack refreshes remain paused. This checkpoint does not change compiler code,
comparator rules, oracle versions, baseline contents, or promotion conditions.
Do not enqueue on the strength of synthetic tests or the offline comparison.
Protected merge-group validation is still required before landing.

## Preserved original evidence

- PR head measured: `ea21d583a0e69e9db75255672c87d6b4440d4e50`.
- Failed measurement: https://github.com/loopdive/js2/actions/runs/34459540170.
- Both lanes had 48,735 unique verdicts, all 114 shard jobs completed, and both
  promotion jobs skipped. The fine regression gate failed with 2,889 reported
  regressions against the committed, unstamped May JSONL. Its adjacent metadata
  described a different September population; that mismatch is not evidence of
  2,889 compiler regressions and is not a waived failure.
- Authenticated historical producer run `34368952422`, compiler
  `129e3efd4530ae1be56dbf5fdea54ddbbd87443e`, artifact `10112017687`, archive digest
  `64b24dff0073e087e2c8d3f2d8ce6ccef5131bd916eb3162076397d32c94a324`.
- Offline full-path-set status comparison against that producer: host zero
  regressions/one improvement; standalone two fail-to-compile_timeout changes.
  Not full-row equality, causal attribution, or protected-queue clearance.
- Raw evidence remains at `/private/tmp/js2-5738-conformance-audit.bNAYXXiI`.

## Implementation

`skip_promote=true` dispatches now require `baseline_commit`, a full immutable
commit in `loopdive/js2wasm-baselines`. A single acquisition job retrieves the
pair, authenticates producer run/artifact metadata, verifies archive SHA-256,
and checks that both baseline files are the original artifact members. It
records the ancestor relationship as a cumulative comparison. Shards depend on
successful admission. Both consumers download the same current-run artifact and
revalidate it, including exact candidate path sets, before report guards.

The legacy PR/merge-group resolver is unchanged. Missing evidence never falls
back to committed JSONL, a moving repository head, or count-only standalone
comparison on this measurement path. No automatic rebaseline is introduced.

Required producer file: `test262-baseline-pair.json`, schema 1:

- `compiler_sha`, `corpus_sha`, `oracle_version`.
- `producer`: repository `loopdive/js2`, integer `run_id` and `artifact_id`,
  `artifact_sha256`, and original workflow path.
- `settings`: explicit `include_proposals`, `semantic_providers`, `eval_engine`,
  `compiler_pool_size`, `ir_first`, `layout_emit`, `native_first`.
- `lanes.host` and `lanes.standalone`: matching `lane`, fixed `file`
  (`test262-current.jsonl` / `test262-standalone-current.jsonl`), `sha256`,
  full-population `total`, producer `registered`, `verdicts`, `excluded: 0`,
  and exact counts for pass/fail/compile_error/compile_timeout/skip.

Every field must be recovered from original producer evidence. Never synthesize
missing settings or registration counts from candidate expectations. Ordinary
report `summary.total` can exclude proposals and is NOT this full population.

## Verification and remaining blocker

- Initial seven-file cohort: 120/128 passed; eight oracle CLI cases failed
  because sandbox denied tsx's local IPC socket (EPERM), not comparator verdicts.
- Same cohort outside sandbox, Node 25 on PATH: 128/128 passed.
- Two additional admission controls then passed: 30/30 admission tests total.
  They preserve a legitimate regression through admission and prove the
  unchanged comparator still fails it; missing producer evidence fails even
  with a plausible fallback JSONL present.
- Unresolved review threads: zero, fully paginated at implementation time.
- Broader workflow cohort initially 43/44: the per-lane test expected two
  merge-group dependencies, but the pre-repair `ea21d583` workflow already has
  three (`changes`, `runtime-eval-provider`, `temporal-provider`). Updated only
  that exact expectation; the merge-group job and skip-safety assertions remain
  unchanged. Normal initial commit hooks passed 106/106 changed-root tests.
- Native subagent resume/spawn refused by service task limit; no sidebar task
  was created as a workaround.

**Not yet runnable against a real admitted pair:** the baselines repository
returned HTTP 404 for `test262-baseline-pair.json` on 2026-09-10. This is an
intentional admission refusal, not a green result. The API identity of the
historical artifact is verified; all original settings and registration evidence
still need assembling and independent review. A producer receipt must be
published at an immutable baselines commit before another measurement run.
This checkpoint does not publish anything to that separate repository.

Next: recover complete original producer evidence, review the receipt, arrange
metadata-only publication (no baseline promotion/replacement), then run one
skip-promote measurement pinned to that commit. Preserve any new failures and
only enqueue #5738 once evidence and protected checks justify it. Do not resume
#5756 or the rest of the stack until #5738's landing decision is resolved.
