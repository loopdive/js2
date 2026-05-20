# CI Policy: branch protection and required status checks on `main`

This document is the source of truth for the GitHub branch-protection ruleset
applied to `main`. It exists so the configuration is **auditable in version
control** rather than buried in repo settings UI.

Changes to this file MUST be paired with a corresponding settings change in
GitHub (via the admin script in `scripts/enable-branch-protection.sh`, or
manually in the Settings → Rules → Rulesets UI). The script reads its payload
from this file's spec and is the supported way to apply the ruleset.

Related issues:

- #1525 — this policy and the admin script.
- #1391, #1393 — staleness / drift escalation history.
- #1246 — `test262-differential.yml` (the authoritative test262 gate).
- #1214, #1216 — `benchmark-refresh.yml` PR-gate history.

---

## 1. Required status checks on `main`

A PR cannot merge until every check listed here reports `success` for the
PR's head SHA.

### Required-checks list (paste into GitHub UI verbatim)

The string in the left column is the **exact** GitHub check name that must
appear in the branch-protection "Required status checks" list. Names are
case-sensitive and whitespace-sensitive.

| Check name | Workflow file | What it gates |
|---|---|---|
| `quality` | `.github/workflows/ci.yml` | lint, format check, typecheck, IR fallback budget (#1376) |
| `differential gate (branch vs main)` | `.github/workflows/test262-differential.yml` | test262 conformance — branch vs. main HEAD with no baseline-drift |
| `refresh-benchmarks` | `.github/workflows/benchmark-refresh.yml` | playground benchmark regression gate (fail-on-regression for PRs — see §6) |

### Optional / informational checks (NOT required to merge)

These run on PRs for visibility but are not in the required-checks list.
A failure here surfaces in the PR Checks tab but does not block merge.

| Check name | Workflow file | Why it isn't required |
|---|---|---|
| `test262 shard 1..16` (16 matrix jobs) | `.github/workflows/test262-sharded.yml` | Superseded for PR gating by `test262-differential.yml` (#1246). Still runs on push-to-main for baseline promotion to `js2wasm-baselines` (see §3). |
| `check for test262 regressions` | `.github/workflows/test262-sharded.yml` | Used a stale rolling baseline that produced drift-induced false-positives — see PR #142/#143/#151 retros. Replaced by the differential gate. Kept around as a redundant signal during the transition window. |
| `CLA check` | `.github/workflows/cla-check.yml` | Currently informational; promote to required once the CLA flow is stable. |
| `Test262 Canary` | `.github/workflows/test262-canary.yml` | Smoke check on a small slice of test262 — fast feedback, not authoritative. |

---

## 2. Reviewer policy

- **At least one approving review from a CODEOWNER** is required before a PR
  can merge. The CODEOWNERS file at the repo root maps paths to required
  reviewers.
- **Stale reviews are dismissed** when new commits are pushed to the PR
  branch. This prevents an approval given against an earlier diff from
  silently authorising later changes.
- **The PR author cannot approve their own PR**, including admins.
- **Code-owner review is required for every protected path** — the CODEOWNERS
  entry is treated as authoritative, not advisory.

### `[skip-review]` label exception class

Two narrow classes of commit may bypass the human-review requirement when
labelled `[skip-review]`. The label is enforced at the policy level (in
this doc), not at the GitHub API level, so reviewers should still spot-check
labelled PRs for misuse.

Permitted bypass scopes:

1. **`ci-status` bot commits** — automated SHA-correlation feed writes
   under `.claude/ci-status/`. See `.github/workflows/ci-status-feed.yml`.
2. **Planning artifact regen** — paths under `dashboard/data*`,
   `dashboard/data.js`, `public/graph-data.json`, and `plan/goals/`,
   `plan/issues/sprints/**` when the only diff is the output of
   `pnpm run build:planning-artifacts`. Cf. `ci.yml`'s
   `Commit regenerated planning artifacts` step.

Bypass MUST NOT be used for `src/**`, `tests/**`, `scripts/**`,
`.github/workflows/**`, `docs/**`, `CLAUDE.md`, `CODEOWNERS`, or
`package.json`. If a `[skip-review]` PR touches any of those paths the
reviewer should require a normal CODEOWNER approval before merging.

---

## 3. Test262 gate decision (dual-gate rationale)

Both `test262-sharded.yml` and `test262-differential.yml` currently run on
PRs. The decision recorded here:

- **`test262-differential.yml` is the authoritative PR gate** and the only
  one in the required-checks list above.
  - Compares branch tip vs. main HEAD in the same workflow run.
  - No baseline-drift false positives (the historical pattern that caused
    PR #142, #143, #151, #294 to mis-report ~hundreds of regressions).
  - Bake-in window from #1246's original "≥3 PRs" target has long since
    elapsed (as of 2026-05); the workflow has been the canonical gate in
    practice for multiple sprints.
- **`test262-sharded.yml` is retained on `push: main` ONLY**, because:
  - Its `promote-baseline` job is the canonical writer for
    `benchmarks/results/test262-current.json` (landing-page summary) and
    for the `js2wasm-baselines` repo's `test262-current.jsonl`
    (history feed for the trend chart).
  - The `refresh-committed-baseline.yml` workflow consumes the sharded
    artifact to sync the committed JSONL.
- **PR-side runs of `test262-sharded.yml` should be disabled**. The
  `regression-gate` job there used the rolling-baseline approach that this
  policy supersedes; keeping it active wastes CI minutes and creates
  confusing duplicate signal. See the workflow edit in #1525 for the
  `paths:` / `if:` change.

If we ever need the sharded matrix on a PR again (e.g. for a one-off
investigation), `workflow_dispatch` is the supported entry point.

---

## 4. Linear history and merge mode

- **`merge` (merge commit) is allowed** — preserves the full branch graph;
  enables a clean revert path.
- **`squash` is allowed** — used for small fixup PRs where the branch
  history is noise.
- **`rebase` is disabled** — rebase-merging rewrites the PR commit SHAs at
  merge time, which breaks `.claude/ci-status/pr-<N>.json` (the file keys on
  the head SHA) and makes the per-commit CI history harder to follow.

Concretely: in the GitHub repo Settings → General → Pull Requests:

- [x] Allow merge commits
- [x] Allow squash merging
- [ ] Allow rebase merging (DISABLED)

The "Default merge mode" for repos without explicit `gh pr merge`
arguments is **merge commit**, matching what `dev-self-merge` invokes
(`gh pr merge <N> --admin --merge`).

---

## 5. Force-push policy

- **Force-pushes to `main` are blocked** for all users.
- **Admins included**: the branch-protection ruleset is configured with
  `enforce_admins: true`. This prevents accidental destructive pushes from
  maintainer accounts.
- **Override path**: if a force-push is genuinely necessary (e.g. to expunge
  leaked secrets), the admin temporarily disables the ruleset, performs the
  push, and re-enables. The disable/re-enable is logged in the repo audit
  log.
- **Branch deletion is blocked**: `main` cannot be deleted via API or UI.

---

## 6. Benchmark regression gate (PRs)

The playground benchmark workflow (`benchmark-refresh.yml`) historically
emitted regression diffs but did not fail PRs — the rationale in #1214 was
that CI-runner noise made the wasm/js ratio drift in a way that didn't
reflect a real compiler regression.

With #1216 the baseline auto-commits on push-to-main from the same CI
runner pool, so the baseline now reflects CI characteristics rather than
a local dev machine. The remaining noise is small enough to gate against.

**Policy (effective with #1525):**

- On `pull_request`: regression detection **fails the workflow** (gate is
  hard, not informational). Threshold values stay at the existing
  `--max-relative-regression 0.50` and `--max-wasm-slowdown 0.40` until
  we have a longer signal window to tighten them.
- On `push: main`: regression detection is logged but does **not** fail
  the workflow — the auto-commit step skips the baseline refresh in this
  case (already implemented), which is the right outcome.
- On `workflow_dispatch`: behaviour unchanged
  (`allow_performance_regressions=false` enforces; `true` permits).

The PR-fail mode is gated by a `--strict` env var (`BENCHMARK_STRICT=1`)
in `scripts/diff-playground-benchmarks.mjs`-equivalent shell logic, so the
behaviour can be flipped without touching the JS script.

---

## 7. Mapping: required check → workflow → why

| Required check | Workflow | What it protects against |
|---|---|---|
| `quality` | `ci.yml` | source quality regressions: lint, formatting, typecheck failures, IR fallback budget exceeded (#1376). Also runs the "origin/main is merged into branch" pre-check that catches stale PR branches. |
| `differential gate (branch vs main)` | `test262-differential.yml` | semantic conformance regressions vs. the exact main HEAD the branch will merge into; no rolling-baseline drift. |
| `refresh-benchmarks` | `benchmark-refresh.yml` | playground compile/runtime perf regressions vs. the committed baseline (with the #1216 CI-runner baseline). |

The CODEOWNERS file gates **who** can approve. The required checks gate
**what** must pass. Both must clear for a PR to merge.

---

## 8. How an admin applies this policy

The script `scripts/enable-branch-protection.sh` PATCHes the GitHub branch
protection API with the JSON payload corresponding to the rules above.
Usage:

```sh
# Dry run — print the payload and curl command, no changes.
./scripts/enable-branch-protection.sh --check

# Apply (requires repo-admin token in GH_TOKEN or `gh auth login`).
./scripts/enable-branch-protection.sh
```

The script is idempotent: re-running it re-applies the canonical state.
Drift between repo settings and this file should be reconciled by running
the script, not by editing settings manually.

---

## 9. Relationship to the `dev-self-merge` skill

`.claude/skills/dev-self-merge.md` defines a hook-based gate that reads
`.claude/ci-status/pr-<N>.json` and decides whether an agent invokes
`gh pr merge <N> --admin --merge`.

Once GitHub enforces the required checks listed in §1, the dev-self-merge
gate becomes a **UX layer**, not the merge authority:

- The skill still inspects per-PR ci-status JSON for agent-friendly
  summaries (net per-test deltas, bucket counts, regressions vs.
  improvements).
- The skill still escalates to the tech lead on bucket >50 / ratio >10% /
  catastrophic regressions.
- The skill no longer bears the responsibility of being the only hard
  block — GitHub's branch protection does that.

See #1391 (staleness escalation) for the prior state where the skill was
the sole hard-block path.
