---
id: 3607
title: "promote-baseline writes benchmarks/results/test262-standalone-current.json but never stages it — no correct in-repo source for the CURRENT standalone rate"
status: done
completed: 2026-07-25
sprint: 77
priority: medium
horizon: s
goal: ci-infrastructure
# workflow-YAML-only fix, no runtime repro — exempt from #2093 by design.
task_type: infrastructure
feasibility: easy
created: 2026-07-25
assignee: ttraenkler/dev-guard-tests
---

# #3607 — the standalone CURRENT summary never reaches `main`

## Problem

The statusline reported standalone conformance as **56.1 %** while the real
current figure is **~63 %**. This is a **semantic** bug, not staleness.

The only standalone summary committed to `main` was
`benchmarks/results/test262-standalone-highwater.json` — a **high-water mark**
maintained by `scripts/check-standalone-highwater.mjs` for the #2097 floor gate.
It is a _best-ever_ floor that only ever ratchets **up**, deliberately never
down. It is not, and was never meant to be, a _current_ pass rate. Anything
reading it as one reads a different number.

The landing page dodged the problem entirely: `run-pages-build.mjs` fetches
`test262-standalone-current.jsonl` **fresh from the baselines repo**, so it never
consulted the committed file. That left the statusline — and any other in-repo
consumer — with no correct source.

## Root cause

`promote-baseline` in `.github/workflows/test262-sharded.yml` **already writes**
the right file. In the "Promote merged artifacts to stable baseline" step:

```yaml
cp shard-artifacts/test262-standalone-report-merged.json \
benchmarks/results/test262-standalone-current.json
```

But `stage_files()` — which decides what lands in the atomic main-repo commit —
staged `test262-current.json`, `test262-report.json`, the two `public/` reports
and `test262-standalone-highwater.json`, and **not**
`test262-standalone-current.json`. So the file was produced on every push to
main and then discarded with the runner.

The data was there the whole time; only the `git add` was missing.

## Fix

One line in `stage_files()`:

```yaml
git add -f benchmarks/results/test262-standalone-current.json 2>/dev/null || true
```

`PROMOTE_FILES` is derived from `git diff --cached --name-only`, so the
snapshot / hard-checkout / re-apply path (`reapply_promote_files`) picks the new
file up automatically — no second change needed.

The file is a copy of `test262-standalone-report-merged.json`, i.e. the **same
shape as the host `test262-current.json`**: `official_summary.pass`,
`official_summary.total`, `oracle_version`, `baseline_sha`, `summary`,
`categories`, … So consumers can read the standalone lane exactly the way they
read the host lane.

## Consumer note (statusline)

The statusline side is wired separately and needs no change from this issue. Two
properties must be preserved there:

- **`git show` costs ~13 seconds on this repo** — any lookup of a possibly-absent
  path must sit behind a cheap `[ -f … ]` stat guard. An unguarded `git show`
  blew the statusline's timeout entirely (exit 124, blank bars). The comment
  claiming `git show` "never blocks" is false.
- Falling back to the high-water file when the current file is absent is correct
  for the transition window: the first push to `main` after this lands is what
  creates `test262-standalone-current.json`, so the fallback covers every commit
  before that.

## Verification

- Confirmed `benchmarks/results/test262-standalone-current.json` is **absent**
  from `origin/main` (`git ls-tree origin/main benchmarks/results/` lists only
  `test262-standalone-highwater.json`).
- Confirmed the host twin carries the expected keys —
  `official_summary: {total: 43102, pass: 30364, …}`, `oracle_version: 10`.
- Workflow YAML re-parsed clean after the edit.

The end-to-end proof is the first `promote-baseline` run on `main` after this
merges: `benchmarks/results/test262-standalone-current.json` should appear in
that `[skip ci]` baseline commit.

## Note — renumbered from #3598

Originally filed as **#3598**, colliding with
`plan/issues/3598-issue-id-gate-should-check-open-prs.md`, which landed on `main`
via PR #3589. The merged PR keeps the id, so this branch renumbered to **#3607**
(fresh id via `claim-issue.mjs --allocate`, then independently verified free on
`main` and across every open PR). Purely mechanical: file rename plus the `id:`
frontmatter and the heading. No other file referenced this id; no workflow, test
or behaviour was touched.

This was the **seventh** duplicate-id collision of 2026-07-24/25 — see #3598 for
the evidence base and the proposed gate fix.
