---
id: 7558
title: "Merge queue is the only authoritative gate: almost nothing runs on pull_request, pre-push runs the changed root tests"
status: done
completed: 2026-11-27
created: 2026-11-27
updated: 2026-11-27
assignee: ttraenkler/ci-slim
priority: high
feasibility: medium
reasoning_effort: high
task_type: ci
area: ci
goal: ci-hardening
sprint: current
horizon: m
related: [7551, 7556, 2786, 2519]
---

# #7558 — merge queue is the only authoritative gate

## Problem

Owner decision (2026-11-27, "Ja bau es so"):

1. The merge queue (`merge_group`) is the single gate that matters.
2. On `pull_request` only `cla-check` and a quick test of one to two minutes
   run. The other required checks report at once as skipped or green.
3. The pre-push hook keeps lint, typecheck and the size gates, and also runs
   the root test files the push modifies, each alone.

Accepted price: a faulty PR is found only in the queue. It costs one queue run
and is auto-parked with `hold`.

## Step 0 — measurement (REST, 2026-11-27)

Source: the last 150 completed non-cancelled `pull_request` runs of every
PR-triggered workflow (`pull_request_target` for `cla-check`), all jobs
(`filter=latest`), plus the last 40 `merge_group` runs of `ci.yml` and
`test262-sharded.yml` including cancelled ones. Runner-min = the sum of job
durations over the 150 runs.

| Workflow / job | PR runs | ran | fail | median | runner-min (150 runs) | class |
| --- | --- | --- | --- | --- | --- | --- |
| ci `issue-tests-shard` (8×, root suite, seed mode) | 150 | 1072 jobs | 0 (advisory) | 66.6 min | 71,660 | b — runs in merge_group, cancelled there in 252/285 jobs when the group merges first |
| ci `equivalence-shard` (8×) | 150 | 1072 jobs | 0 | 4.4 min | 5,223 | a (feeds required `equivalence-gate`) |
| ci `quality` **required** | 150 | 150 | 23 | 13.4 min | 1,934 | a, except two PR-only steps (below) |
| ci `issue-tests-changed` / `-pinned` / `-select` / `issue-tests` / `issue-tests-gate` | 150 | 134 | 0 | 1–2.5 min | 1,164 | b |
| ci `linear-tests` | 150 | 134 | 0 | 1.2 min | 158 | b |
| ci `changes` | 150 | 150 | 0 | 1.2 min | 170 | b |
| ci `equivalence-gate` **required** | 150 | 134 | 0 | 7 s | 17 | a |
| test262-sharded `cheap gate` **required** | 150 | 150 | 0 | 71 s | 177 | a |
| test262-sharded `merge shard reports`, `check for test262 regressions` **required** | 150 | 150 | 0 | 4 s | 20 | a (designed PR no-ops) |
| test262-sharded `detect…`, `admit-measurement-baseline` | 150 | 150 | 0 | 3 s | 16 | b |
| test262-pr-stub (detect + 3 stubs + guard) | 150 | 150 | 0 | 16 s | 57 | c (PR-only by design) |
| cla-check **required** | 150 | 150 | 0 | 19 s | 50 | a |
| cross-backend-parity | 150 | 150 | 0 | 55 s | 136 | c (also push) |
| native-messaging-smoke | 150 | 150 | 0 | 10.8 min | 1,755 | c (also push) |
| landing-four-lane-backend `correctness-support-sanitizers` | 150 | 150 | 0 | 5.6 min | 872 | c (PR + dispatch only) |
| porffor-direct-ab `semantic-sanitizers` | 150 | 150 | 0 | 2.0 min | 288 | c (PR + dispatch only) |
| porffor-source-canary | 150 | 150 | 0 | 1.0 min | 150 | c (PR + dispatch only) |
| quickjs-wasi-artifact (build + eval lane) | 150 | 150 | 29 | 0.7 + 3.0 min | 520 | c (PR + dispatch only) |
| issue-tests.yml (PR path filter on its own scripts) | 6 in 41 days | 6 | 0 | 32 min | 2,887 | c (also push + 6-hourly schedule) |

Rates: `ci.yml` alone costs **535 runner-min per PR push** (9.2 PR runs/hour,
~4,900 runner-min/hour); 89 % of it is the advisory root-suite shard matrix.
Everything else on a PR push adds about 3 runner-min on average.

### What the failures were

- `quality`, 23 failures: import-cycle ratchet 6, compiler boundaries 9,
  issue→probe coverage 4, IR layering 1 — all steps that ALSO run in
  `merge_group` (class a) — and **changed root test files (#3008) 3**, which
  is PR-only. The 3 sampled logs are real defects in the PR's own tests
  (`issue-3632-eval-early-errors`, `issue-7489-function-caller` twice).
- quickjs eval lane, 29 failures (Oct 19 – Nov 7; none in the last 20 days):
  sampled 5 logs — 4 real test failures in `issue-1102` / `issue-2960` /
  `issue-4013` under the kept interpreter engine during eval-engine PRs, 1
  build-order defect (`no usable compiler … build compiler-bundle first`).
  Real defects; the same root files also run in the root suite on push.
- Every other class-(c) job: 0 failures in 150 runs. What would be lost by not
  running them on the PR is the *pre-merge* signal for their own narrow area
  (cross-backend parity, the native-messaging example, Porffor A/B and canary
  sanitizers, the landing benchmark sanitizers): a regression there would
  first show up after merge instead.

PR-only *steps* inside `quality`: changed root tests (#3008) + its test262
harness preparation, the open-PR issue-id collision scan (#3598) and the
merged-main issue integrity check (#2530). In `merge_group` the last one is
redundant by construction (`check:issues` and `check:issue-ids:against-main`
run on the merged tree).

## Implementation Plan

### One mechanism

`ci.yml`'s two root jobs, `changes` and `quality`, get the same job-level
condition (literal, not a YAML anchor, so the text-reading workflow tests
see the expression itself):

```yaml
if: github.event_name != 'pull_request'
```

Every other job in `ci.yml` needs `changes`, so on a PR it is skipped by the
`needs` cascade and still publishes a `skipped` check run; a skipped required
check satisfies the ruleset. The one `always()` aggregator that would turn a
skipped `changes` into a failure (`issue-tests`) gets `needs.changes.result !=
'skipped'` added. No job body is duplicated, no stub is added; `merge_group`
and `push` are untouched (`changes`/`quality` run exactly as before there).

test262-sharded.yml and test262-pr-stub.yml are unchanged: their PR behaviour
already is the pattern the owner asked for (`cheap gate` real, the two test262
contexts designed no-ops; the stub covers path-excluded PRs).

### Per PR-triggered job

| Job | New behaviour on PR | Reason / home |
| --- | --- | --- |
| `quality` (required) | skipped, check run published | full gate stays in merge_group |
| `equivalence-gate` (required) + `equivalence-shard` | skipped (cascade) | merge_group |
| `changes`, `linear-tests`, `issue-tests*` | skipped (cascade) | merge_group + push, as today |
| `cheap gate (main-ancestor + lint)` (required) | **runs** — this is the quick test (typecheck + lint, 71 s median job) | unchanged |
| `merge shard reports`, `check for test262 regressions` (required) | green no-op, as today | unchanged |
| `cla-check` (required) | runs | unchanged |
| test262-pr-stub | runs, as today (16 s) | needed so path-excluded PRs publish the three test262 contexts |
| quality step "changed root test files" (#3008) + harness prep | moves to `merge_group` (fatal) | the only PR-only step with real defects; also the only home that covers forks without hooks; ~5 min inside `quality`, off the critical path (merge-group test262 median 25 min for code PRs). Local twin: pre-push |
| quality step open-PR issue-id collision (#3598) | moves to pre-push | fail-open network scan; the merge_group duplicate-id gate stays the hard backstop |
| quality step merged-main issue integrity (#2530) | moves to pre-push | redundant in merge_group by construction |
| cross-backend-parity, native-messaging-smoke | PR trigger removed, push trigger kept | post-merge detector; 0 failures in 150 PR runs |
| landing-four-lane-backend, porffor-direct-ab, porffor-source-canary, quickjs-wasi-artifact | `pull_request` → `push: main` (same paths) | post-merge detector instead of pre-merge. A non-required workflow in merge_group would not block either, so push is equivalent to adding it there |
| issue-tests.yml | **kept** (PR trigger on its own 5 machinery files only) | 6 runs in 41 days; its read-only PR path is the only safe pre-merge proof of a detector change — a `workflow_dispatch` run writes the baseline back |

Format check is not added to the quick test: pre-commit's lint-staged and the
pre-push changed-files prettier gate cover it, and `quality` checks the whole
tree in the queue.

### Drafts, forks, docs-only

- Drafts: unchanged — never auto-enqueued; the quick test still runs on them.
- Forks / external contributors (no hooks): the PR gets only `cla-check` and
  the quick test. Real validation happens in the queue, which runs every
  required check on the merged tree. `auto-enqueue`'s author-trust gate
  (OWNER/MEMBER/COLLABORATOR, `TRUSTED_FORK_OWNERS`) is unchanged, so an
  external PR still needs a deliberate maintainer enqueue.
- Docs-only: same as any PR; test262 contexts from the stub, `quality` and
  `equivalence-gate` skipped.

### Pre-push hook

After the existing fast gates, the hook runs, in this order:

1. `check:loc-budget` + `check:func-budget` (the size gates, ~5 s; pre-commit
   has them too, but a merge commit or a hook-less commit skips pre-commit);
2. the issue-id gates the PR no longer runs: `check:issue-ids:against-main`,
   `check-merged-issue-integrity.mjs <main> HEAD`, and
   `check:issue-ids:against-open-prs` (fail-open);
3. `pnpm run test:changed-root` — the existing selector
   (`scripts/hooks/changed-root-tests.sh`), which already runs each changed
   root test file alone and stops at the first failure — under a 20-minute
   bound (`timeout`, when installed). Expiry is a failure with a message, not a
   skip. No escape flag: none exists for pre-push.

### auto-enqueue interplay

`enqueueEligibility` still requires not-draft, no hold label, `mergeable ==
MERGEABLE`, zero failing checks and every required context present and passing
or skipped (`PASSING_CHECK_STATES = pass, skipping`). With the slim PR, a PR is
eligible as soon as `cla-check` and the cheap gate finish. Nothing can know
whether the author's pre-push ran; the accepted risk is the owner's: a broken
PR costs one queue run and is parked.

### Rollback

One `git revert` of the implementation commit.

### Quality criterion

One mechanism (the same `if:` on the two root jobs; everything else via
the `needs` cascade); no copied job bodies; no step left that can never run
(the PR-only `quality` steps are moved, not left dead).

### Validation

- `tests/issue-7551-job-skip-propagation.test.ts` extended: for
  `pull_request` and `merge_group` every required context has a producer that
  triggers on the event; on a PR `quality`/`equivalence-gate` are skipped and
  the quick test runs; in `merge_group` no required context is skipped.
- Every root test that reads `.github/workflows/*.yml` run alone.
- The pre-push hook run for real on this branch.

## Results (2026-11-27)

- Runner-minutes per PR push: ~540 before (ci.yml 535, the rest ~3) → ~2
  after (cla-check 0.3, cheap gate 1.2 or the stub 0.4, `ci.yml` all
  `skipped`). Jobs that really execute per PR: ~30 before (ci.yml alone runs
  8 + 8 shards plus up to 15 changed-file jobs) → 2–3 after.
- Pre-push, measured on the 4-core box at load ~5.9: size budgets 2 s,
  issue-id gates 18 s (the open-PR scan degrades and passes when GraphQL is
  unreachable, as designed), changed root tests ~49 s per file (5 files from
  PR #7507 run alone: 244 s).
- Tests: the extended `tests/issue-7551-job-skip-propagation.test.ts` (24
  pass) and every test that reads a workflow or `.husky/pre-push` (54 files),
  each run alone. Updated for this change: `issue-4242-eval-engine-parity`
  (QuickJS lane now on push), `scripts/select-changed-issue-tests.test.mjs`
  (`issue-tests` aggregator condition), `tests/hooks/pre-push-format-gate`
  (the no-watchdog rule now scopes to the format gate; the root-test bound
  must fail, never skip). Five failures are pre-existing and touch no file
  this change edits: `issue-3344`, `issue-3426`,
  `issue-3451-linked-harness-lane`, `dogfood/npm-compat-upstream-sources`,
  and `issue-4130-npm-compat-promotion-fast-path` (reproduced with main's
  `ci.yml` restored).
- Only the PR's own run can prove that the PR-level contexts really publish
  as `skipped`/green within minutes and that the next `merge_group` run is
  complete (`quality` including the changed-root step).
