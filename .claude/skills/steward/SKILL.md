---
name: steward
description: Repo-specific PR/CI conventions for an agent subscribed to PR activity (loopdive/js2wasm). Read this BEFORE acting on a CI or review event. Overrides the generic PR-steward defaults where this repo's merge queue, gates and hooks make them wrong — most importantly: agents NEVER enqueue, a bot `hold` is a real regression, and close+reopen is the sanctioned way to DEQUEUE for a push.
---

# /steward — acting on PR events in this repo

Read this before acting on a CI or review event on a PR you opened or drive.
It does **not** relax anything the generic rules state as "never" (no skipping
or disabling tests; no rewriting someone else's history; no approving or
merging). It states the repo conventions the generic defaults get wrong here,
and each one below has bitten a real lane.

Authoritative sources this file summarises: [`docs/ci-policy.md`](../../../docs/ci-policy.md)
and `CLAUDE.md`. Where they disagree with this file, they win — re-verify rather
than trusting this summary's dates.

## 1. NEVER enqueue. The server enqueues.

`.github/workflows/auto-enqueue.yml` is the single enqueuer (#2786), triggered
on required-check completion. A dev/agent must not enqueue, and must **never
re-enqueue**: re-adding a PR that is in the **in-flight merge group** rebuilds
that group and **cancels its run**. A re-enqueue loop on the queue head cost
~3.5h of cancellation churn on 2026-06-20.

Your job on a green PR is to make it *enqueueable* and confirm it was taken —
not to push it into the queue.

## 2. Judge readiness from the real signals, not from `mergeStateStatus`

- **A SKIPPED required check SATISFIES branch protection.** Jobs skipped by
  their own `if:`/path filter still publish a check run with conclusion
  `skipped`. On a docs-only PR `equivalence-gate` skips and the PR is still
  `CLEAN`. Do **not** decide readiness by counting six `SUCCESS` conclusions —
  you will not find them and will wrongly conclude the PR is not ready. Judge
  each REQUIRED check as green when its conclusion is `success` OR `skipped`.
- **Do not read `mergeStateStatus` as the enqueue gate at all.** Since **#4094**
  `enqueueEligibility()` in `scripts/enqueue-green-prs.mjs` decides from four
  real signals only — not draft, no hold label, `mergeable === "MERGEABLE"`
  (the field, not the status string), and `classifyChecks()` green. The
  function's own comment is explicit: *"`mergeStateStatus` is deliberately NOT
  a parameter. It cannot be consulted even by accident."* The old
  `ENQUEUEABLE = {CLEAN, HAS_HOOKS}` set is **vestigial** — read lines 631 and
  1276, both of which say "Was `!ENQUEUEABLE.has(...)`".

  Being **behind main** does not block enqueue. `mergeStateStatus` is also
  *stale* — measured on the same PR minutes apart with no push, and a PR 4
  commits behind reading `CLEAN` while one 0 commits behind read `UNSTABLE`.
  Diagnose from the check runs and `mergeable`, never from the summary string.
- **A red NON-REQUIRED check DOES block enqueue.** This file claimed the
  opposite until 2026-08-29, and it is the costlier error of the two: it tells
  you to stand down on the one signal that will strand the PR forever, because
  nothing retries a non-required lane on its own.

  `classifyChecks()` applies its **zero-FAILURE rule before** the required-name
  filter, so the required list never gets consulted for a failing row:

  ```js
  // Zero-FAILURE rule: applies to EVERY check, required or not (#3878/#3904).
  if (!PASSING_CHECK_STATES.has(state) && !PENDING_CHECK_STATES.has(state)) {
    failures.push(`${name}: ${state}`);
    continue;                       // ← returns green:false regardless of `required`
  }
  if (!required.has(name)) continue; // ← only reached by passing/pending rows
  ```

  `PASSING_CHECK_STATES` is `{pass, skipping}` and `PENDING_CHECK_STATES` is
  `{pending, queued, in_progress}` — every other state is a failure, whoever
  published it.

  Observed on PR #5260 (2026-08-29): all six required checks green or skipped,
  `mergeable: true`, no `hold` — and the `auto-enqueue` run logged
  `- #5260 skip (failing-checks: quickjs eval-engine lane (non-required): fail)`
  on every sweep. Read the `auto-enqueue` run's own log when a PR looks ready
  and is not moving; it names the reason verbatim.

  So a red non-required lane is **work**, not noise. Treat it like any other CI
  red under §CI red: rule out that it is not this PR's, re-run once if you have
  the means, and if you do not, say so and keep the PR watched — it will not
  clear itself.
- **`BEHIND` → do NOTHING. Let the PR's CI finish.** This is the one that looks
  most like a call to action and is not. Behind-ness does **not** block enqueue:
  `scripts/enqueue-green-prs.mjs` derives eligibility from checks + draft +
  hold-labels and says so outright — *"`mergeStateStatus` is deliberately NOT a
  parameter. It cannot be consulted."* (#4094) — and the merge queue builds the
  group against main anyway.

  Merging main into a `BEHIND` PR **restarts its ~10-minute PR CI from zero**.
  On a busy day main merges faster than that, so the checks never complete and
  the PR becomes permanently un-enqueueable. #4520 cycled 70+ minutes this way,
  and `auto-refresh-prs.yml` skips in-flight heads specifically to avoid it.
  A steward that "helpfully" merges main on every `BEHIND` check-in **is** the
  livelock. If a refresh is genuinely wanted, that cron owns it — it runs every
  20 min and already knows when to hold off.
- `DIRTY` → a real conflict; resolve it (see §5). On a PR whose own files
  conflict, first suspect a **duplicate merge** — another lane landing the same
  mechanism — rather than ordinary drift.
- `linear-tests` is **not** a required check (#3934), despite older docs.

Verify the required list rather than trusting any doc:

```bash
gh api repos/loopdive/js2wasm/rules/branches/main \
  --jq '[.[]|select(.type=="required_status_checks")|.parameters.required_status_checks[].context]'
```

Enforcement is a repo **ruleset**, not classic branch protection — the classic
endpoint answers `404 Branch not protected`.

## 3. Two required checks are DESIGNED green no-ops at PR level

`check for test262 regressions` and `merge shard reports` green-skip on
`pull_request` (`SHARDS_RAN: false`) — the heavy shard matrix is
`merge_group`-only. **Green there is not conformance evidence.** The real
regression gates run in the `merge_group` re-validation on the merged state,
which is why a fully-green PR can still fail the queue.

## 4. A bot `hold` label is a REAL regression, not noise

When `github-actions[bot]` adds `hold` plus an
`auto-park-bot:merge-group-failure` comment (#2547), it caught a merged-baseline
regression that PR-level checks **cannot** catch.

- **Never remove a bot park-hold without first diagnosing the cited run.**
- A bot park-hold is not your own manual `hold`. Confusing the two re-admits a
  regressing PR — a dev did exactly this on #1960.
- Re-enqueue at most **once**, and only after a confirmed fix or a confirmed
  flake established from the regressed-test delta.
- A held PR is **skipped** by the auto-enqueue backstop, so it strands until
  someone resolves it. The cron will not rescue it.

## 5. The merge queue LOCKS the branch — close+reopen is how you dequeue

A queued PR rejects pushes with `GH006: … queued for merging cannot be updated`.
**Draft does not dequeue.** Closing and reopening the PR does.

The generic rule "never close and reopen the PR to kick CI" still stands and is
not what this is. Kicking CI is forbidden; **dequeuing so you can push a real
change is the sanctioned mechanism**, and it is the only one. State plainly in
your report that you dequeued and why, so it is not mistaken for a CI kick.

`git merge` is blocked in the repo root by `.claude/hooks/check-cwd.sh` for
non-tech-lead agents. `git pull --no-rebase --no-edit origin main` is not
blocked and does the same job. Server-side, the
`update_pull_request_branch` API also works and avoids the hook entirely.

**Never rebase and never force-push.** Public `main` is append-only; fix bad
commits forward with a revert PR.

## 6. Gates and hooks that will reject your push

- **Never pass `--no-verify`** to `git commit` or `git push` (project-lead
  order, 2026-08-22). If a hook is slow use `SKIP_SLOW_PRECOMMIT=1`, which
  still runs the fast checks, and run the heavy gates by hand.
- Run all five source-ratchet gates **before** committing, chained so a failure
  blocks:
  ```bash
  node scripts/check-loc-budget.mjs && node scripts/check-func-budget.mjs \
    && node scripts/check-coercion-sites.mjs && npm run -s check:oracle-ratchet \
    && npm run -s check:dead-exports
  ```
  **Never pipe a gate whose exit status you need** — `gate | tail` reports
  `tail`'s status, so a red gate reads as green.
- CI diffs the **merge preview**, not your fork point, so a gate can pass
  locally and still fail `quality`. Simulate it:
  `LOC_GATE_BASE=$(git rev-parse <upstream-main-tip>) node scripts/check-loc-budget.mjs`
- Growth allowances go in the PR's own `plan/issues/*.md` YAML frontmatter with
  a dated rationale. **Never edit `scripts/*-baseline.json`** — main is its sole
  writer.
- Your commit message **must end with a line containing just `✓`** — the
  pre-commit hook requires that checklist sign-off.
- The commit **author must not match `claude|anthropic`**
  (`.husky/commit-msg`, project-lead order 2026-08-09). Claude belongs only in a
  `Co-Authored-By:` trailer. If your harness asks you to set
  `user.email noreply@anthropic.com`, that conflicts with this hook: do **not**
  bypass it — report the conflict.
- New codegen needing type info must use `ctx.oracle`, not the raw
  `ts.TypeChecker` — raw `checker.getTypeAtLocation`/`ctx.checker` trips the
  oracle-ratchet gate.

## 7. Conventions for what you write

- **PR bodies link issues to the website page, never bare `#NNNN`** — PR and
  issue numbers share one sequence, so a bare `#NNNN` autolinks to an unrelated
  PR. Use
  `[#NNNN](https://js2wasm.loopdive.com/dashboard/issue.html?slug=<file-basename-without-.md>)`.
  Commit messages keep plain `#NNNN` (tooling greps them).
- **Docs-only changes go in ONE open PR.** Push docs commits onto the open docs
  PR's branch instead of opening a second. An implementation PR still carries
  its own issue-file status edit.
- Ad-hoc probe/debug/repro files go in `.tmp/` — gitignored, invisible to
  vitest.

## 8. Verifying a test262 claim before you assert it

Judging a row by "it compiled" is how #4764 shipped a regression. Use the
runner's own verdict:

```bash
npx tsx scripts/run-test262-paths.mts <file-of-paths> --isolate
```

**`--isolate` is mandatory for any family that mutates a shared intrinsic.**
Every row otherwise runs in one realm, and the `class/dstr/*-array-prototype.js`
group replaces `Array.prototype[Symbol.iterator]`, which breaks `for…of` inside
the runner itself — the run dies *after* doing all the work and every row past
the first poisoner is meaningless. Measured difference on one 8-row slice:
in-process `pass 1, error 7`; `--isolate` `pass 6, fail 1, error 1`.

Keep slices small. Devs do **not** run full local test262; CI validates
conformance.

## 9. Related skills

Prefer these over improvising: [`/dev-self-merge`](../dev-self-merge/SKILL.md)
(green-PR self-check), [`/test-and-merge`](../test-and-merge/SKILL.md),
[`/analyze-regression`](../analyze-regression/SKILL.md) (diff two runs),
[`/handle-regression`](../handle-regression/SKILL.md) (single fix),
[`/regression-triage`](../regression-triage/SKILL.md) (bulk-classify),
[`/pr-conflict-refresh`](../pr-conflict-refresh/SKILL.md).
