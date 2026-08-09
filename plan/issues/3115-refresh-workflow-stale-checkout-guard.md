---
id: 3115
title: "Refresh workflow stale-checkout guard: recompute source-derived baselines after re-anchor"
status: ready
sprint: current
created: 2026-07-09
updated: 2026-07-09
priority: high
horizon: m
feasibility: medium
model: opus
reasoning_effort: medium
task_type: infrastructure
area: ci
language_feature: compiler-internals
goal: maintainability
related: [2108, 2178, 2942, 1861, 2812]
---

# Refresh workflow stale-checkout guard

## Problem

On 2026-07-09 the whole merge queue wedged: the required `check:coercion-sites`
gate (part of the `quality` job) went RED on `main`. The committed
`scripts/coercion-sites-baseline.json` said `codegen/property-access.ts: 16`
while the merged source tree had **17** coercion sites — an internally
inconsistent pair that fails the gate on every PR.

Root cause — a **stale-checkout / moved-base race** in the post-merge
baseline-refresh jobs (same class as the "banking whole-tree state computed on a
base that moved under it" hazard):

1. A push to `main` at commit **T** triggers `test262-sharded.yml`. Its
   `promote-baseline` job checks out **T** (`actions/checkout@v5`,
   `fetch-depth: 1` → `github.sha`).
2. The job runs `node scripts/check-coercion-sites.mjs --update`, which
   recomputes the coercion-site baseline from T's `src/codegen` source (a pure
   grep — it has no dependency on the test262 run). At T the source had 16
   sites, so `--update` banks **16**.
3. By the time the job reaches the push step, `main` has advanced to **T+k**
   because PR **#2812** merged in between (it bumped
   `codegen/property-access.ts` 16 → 17 and, at PR time, correctly bumped the
   committed baseline to 17). The push loop **re-anchors** onto the fresh tip:
   `git checkout -f -B _promote_tmp deploykey/main` replaces the working tree
   (including `src/codegen/**`, now 17 sites) with T+k, then re-applies the
   **T-snapshot** baseline files (baseline = 16) wholesale and commits.
4. Result on `main`: source = 17, committed baseline = 16 → the reviewed 17 is
   **clobbered back to 16**, `check:coercion-sites` RED, queue wedged.

`check-coercion-sites.mjs` is the **only** promote file derived from the
**source tree**; every other refreshed artifact (test262 summary JSON,
hard-error baseline, feature badges, standalone high-water) is derived from
**this run's test262 report**, which is correctly the same regardless of which
main tip it lands on. So the source-derived baseline is uniquely sensitive to
the re-anchor moving the tree under it.

The incident itself was unblocked separately (commit `d3b3f2cfba7` restored the
baseline to 17, bundled into PR #2814). This issue is the **root-cause guard**
so it cannot recur.

## Affected jobs

- `.github/workflows/test262-sharded.yml` → job **`promote-baseline`**, step
  _"Commit refreshed summary JSON to main repo"_ — pre-loop
  `check-coercion-sites.mjs --update` (against the T checkout) + re-anchor push
  loop (`_promote_tmp`). **BUG.**
- `.github/workflows/baseline-summary-sync.yml` — the hourly fallback; same
  shape: pre-loop `--update` + re-anchor push loop (`_summary_sync_tmp`).
  **BUG.**
- `.github/workflows/refresh-baseline.yml` — already regenerates its
  source-derived derivations (`sync-conformance-numbers.mjs`) **inside** the
  loop after the re-anchor. This is the **correct template** the fix mirrors;
  it does not refresh the coercion baseline, so it needed no change.

## Fix (the guard)

Enforce the invariant: **never commit a source-derived baseline computed on a
base that is no longer main's tip.** The push loop already re-checks-out the
fresh tip (`git checkout -f -B <tmp> deploykey/main`) on every attempt — the
minimal robust fix (option (b) from the task: "re-checkout current main and
recompute before committing") is to move the coercion recompute **into** that
loop, after the re-anchor and before the commit:

```sh
reapply_promote_files                         # (or the snapshot re-apply loop)
node scripts/check-coercion-sites.mjs --update || echo "WARN: ... (non-fatal)"
git add -f scripts/coercion-sites-baseline.json 2>/dev/null || true
if git diff --cached --quiet; then ... ; fi   # no-op guard unchanged
git commit ...
git push deploykey HEAD:main
```

Because `--update` reads `src/codegen/**` from the freshly re-anchored working
tree, the banked baseline is **correct-by-construction for the exact tree being
pushed**:

- **main stable** (T == T+k): recompute yields the same value → no-op, legit
  refresh path unaffected.
- **main advanced** (a PR moved the count): recompute yields the tip's actual
  count → committed pair is consistent; also **self-heals** a baseline that is
  already drifted on the tip.

Kept **non-fatal** (`|| echo WARN`), matching the surrounding style, so a
transient grep failure can never strand the summary commit.

## Validation

- `tests/issue-3115-refresh-stale-checkout-guard.test.ts` — dependency-free
  structural test pinning the ordering invariant in **both** refresh jobs: a
  coercion `--update` recompute + re-stage must appear **after** the re-anchor
  checkout and **before** the push commit. Fails if a refactor moves the
  recompute back before the re-anchor (reintroducing the wedge).
- Both edited workflows parse as valid YAML (the edits live entirely inside
  `run: |` block scalars at the existing 12-space shell indentation, so YAML
  structure is untouched).
- No test262 conformance impact (CI/tooling only).
