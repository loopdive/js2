---
id: 1522
title: "Use Claude Code on Web container for scoped local test262 pre-push checks (CI remains gate)"
status: backlog
created: 2026-05-20
updated: 2026-05-20
priority: medium
feasibility: medium
reasoning_effort: medium
goal: ci-cost-reduction
depends_on: []
---
# #1522 — Race local test262 vs. CI, cancel the loser

## Problem

When an agent running in Claude Code on Web opens a PR, the GitHub Actions `Test262 Sharded` workflow is the gate that feeds `.claude/ci-status/pr-<N>.json` and unblocks `dev-self-merge`. Measured baseline of this container (2026-05-20):

- **16 GB RAM, 0 swap, 4 cores** (Intel Xeon @ 2.80GHz, no SMT siblings)
- **Peak usage with `COMPILER_POOL_SIZE=4`**: ~2.8 GB used / ~13 GB available (~80% headroom)
- **Full test262 wall-clock: ~68 min** (4068s, 28006/43160 pass = 64.9% on this branch's HEAD)

CI sharded typically finishes in ~12-18 min by parallelizing across many runners, so a single local container at 4-wide is **NOT competitive with CI on wall-clock** — it's only competitive on **cost** (no Actions minutes) and on **queue avoidance** (no GH runner wait). The race-cancel design therefore only makes sense if the CI run is sitting in `queued` for >15 min, which is rare.

The headroom (~13 GB unused, 1 idle core) means the more interesting use of this container is **not** racing CI, but running scoped pre-push checks: a 1–2 min targeted slice of test262 covering the categories the PR diff touches, giving devs faster local signal before CI runs. CI remains the authoritative gate.

## Proposal

Pivoting from the original "race local vs CI" framing after the 68-min wall-clock baseline. The realistic high-value uses for this container:

### Primary: scoped pre-push pre-flight (P0)

Before `git push`, an agent on Claude Code on Web invokes a script that:
1. Reads the PR diff vs. `origin/main`
2. Maps changed source files (e.g. `src/codegen/expressions.ts`) to relevant test262 categories (e.g. `built-ins/Math`, `language/expressions`)
3. Runs a targeted ~500-test slice locally with `COMPILER_POOL_SIZE=4` (2–3 min wall-clock)
4. Reports pass/fail to the agent before push, so obviously-broken PRs never burn CI minutes

CI remains the authoritative gate. Local pre-flight is a faster-feedback loop, not a replacement.

### Secondary: queued-CI cancellation (P2, only if measured worthwhile)

If the GH Actions workflow sits in `queued` >15 min (rare but real on contended runner pools), the same in-container test262 run could finish first. In that case, cancel CI and publish local results. Only worth building once we have data on actual queue times — if CI queues are typically <5 min, this is dead weight.

## Acceptance criteria (primary)

1. New script `scripts/test262-pre-push.sh` (or similar) that:
   - Computes changed-files vs. `origin/main`
   - Maps those to a list of test262 path prefixes via a configurable rule table (e.g. JSON in `scripts/test262-pre-push-rules.json`)
   - Runs the targeted slice with `COMPILER_POOL_SIZE=4` (4-wide, full RAM headroom)
   - Reports `pass / fail / new-regressions-vs-committed-baseline` against `benchmarks/results/test262-current.jsonl`
2. Target wall-clock: **< 3 min for a typical PR diff**. If the diff is broad (e.g. touches `src/index.ts`), the script falls back to "skip pre-flight, let CI handle it" rather than burning the full 68 min locally.
3. Detection of Claude Code on Web environment so the script auto-runs in web sessions but is opt-in elsewhere. Env var TBD — check what the container actually sets (likely `CLAUDE_CODE_REMOTE` or similar).
4. Failure mode: if the slice fails locally, the agent **does not block push** (CI is still the gate) but does post a heads-up: "local pre-flight flagged N regressions, see slice/<file>". Devs read this before merging.
5. Trust validation: before this is enabled by default, run **5 PRs in shadow mode** (local runs but doesn't change agent behavior). Compare local-slice vs. CI's results for the same tests on the same SHA. Acceptable: identical pass/fail on the sliced subset. Document any flips.
6. Bail-out paths:
   - If local run OOMs or fails to start, agent proceeds without local signal (CI is still the gate)
   - If the PR diff is too broad (e.g. touches `src/index.ts`, the type system, or the codegen entry points), skip pre-flight entirely
   - If the diff touches the test262 runner itself (`tests/test262-*.ts`, `scripts/run-test262-vitest.sh`), CI is needed regardless — skip pre-flight

## Open questions

- **Rule-table maintenance**: who updates `scripts/test262-pre-push-rules.json` when a new source file maps to a new test category? Probably start with broad rules (any `src/codegen/**` change → run `language/expressions` + `language/statements`) and tighten over time.
- **Baseline freshness**: the slice diffs against `benchmarks/results/test262-current.jsonl` (~15MB committed). For an agent on a long-running branch with stale main, the baseline may be off. Acceptable for pre-flight; CI uses the fresh baseline from `loopdive/js2wasm-baselines`.
- **One container, many PRs**: if an agent opens PRs back-to-back, the local runner's flock serializes. Pre-flight queues — fine, since CI handles real validation.

## Notes from baseline run (2026-05-20)

This issue was prompted by a baseline measurement of the cloud container during a 4-wide `COMPILER_POOL_SIZE=4` test262 run.

| Metric | Value |
|---|---|
| Wall-clock | 4068.86s (~68 min) |
| Tests run | 43,160 |
| Pass | 28,006 (64.9%) |
| Fail | 18,718 (mostly Temporal, expected) |
| Peak RAM (used) | ~2.83 GB / 16 GB total (~18%) |
| Idle CPU | 1 of 4 cores (3 compiler workers + 1 vitest fork main) |
| Run timestamp | `20260520-155042` |

Raw report: `benchmarks/results/test262-report-20260520-155042.json`.
Raw results: `benchmarks/results/test262-results-20260520-155042.jsonl`.

**Key takeaway**: the container is wildly over-provisioned for any single test262 run — the bottleneck is CPU (4 cores), not RAM (~13 GB unused). Full-run wall-clock (68 min) makes "race CI" uneconomic; scoped pre-flight with the 4 cores fully utilized makes sense.
