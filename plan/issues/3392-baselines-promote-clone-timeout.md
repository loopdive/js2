---
id: 3392
title: "promote-baseline dies at the baselines-repo clone — runs/ cache growth pushed full-blob clone past the 10-min step timeout"
status: done
completed: 2026-07-24
task_type: infrastructure
sprint: 76
priority: high
goal: standalone-mode
feasibility: easy
horizon: s
related: [3380, 3381, 3382, 2942, 1081]
created: 2026-07-17
---

> **DONE (2026-07-24, status reconcile).** Fix `fix(#3392): blob-less sparse
> clone in baseline promote/refresh — runs/ growth broke the 10-min clone`
> merged to `main` (commit `ed37396`); the `--filter=blob:none --no-checkout` +
> sparse-checkout pattern is present at all clone sites in
> `.github/workflows/test262-sharded.yml` (10 occurrences). Left at
> `status: ready` after the merge; reconciled to `done` here. `task_type:
> infrastructure` set (was unset) — this is a pure CI-workflow clone fix with no
> compiler/runtime repro, matching the #2093 gate's infra exemption. The
> unbounded-`runs/`-growth follow-up (retention policy) remains PO-owned and
> out of scope for this issue.

## Problem

Every `promote merged report to main baseline` job on main failed on
2026-07-17 (runs 29610221883, 29610687707, 29611576884, …): the job log shows
`Cloning into '/tmp/js2wasm-baselines'...` and then **nothing for 10 minutes**
until the step timeout kills it (orphaned `git`/`ssh` processes terminated).
Shards and `merge shard reports` were green — only the promote died.

Root cause: the promote step (and `refresh-baseline.yml`'s deploy step) cloned
with `git clone --depth=1` but **no blob filter**. `--depth=1` still downloads
every blob reachable from the HEAD tree — which includes the entire `runs/`
per-SHA result cache (#1081): ~1,000 entries, tens of MB each. High merge
velocity grew that past what a runner can fetch in 10 minutes, so every
promote now times out at the clone. Consequences:

- baseline stranded stale → every PR's regression gate diffs a stale floor →
  phantom regressions / bot park-holds on innocent PRs (#3273 parked 4× today)
- the **standalone** lane had no other refresh path at all (#3381), so it
  stranded at 11:33Z while host limped along via FORCED `refresh-baseline`
  runs (which use the same clone and are at the same cliff).

## Fix (this PR)

Same pattern already used at three other clone sites in
`test262-sharded.yml` (lines ~717/811/1088): metadata-only partial clone +
sparse materialization of only the files the step touches:

```bash
git clone --depth=1 --filter=blob:none --no-checkout git@github.com:loopdive/js2wasm-baselines.git /tmp/js2wasm-baselines
git -C /tmp/js2wasm-baselines sparse-checkout set --no-cone '/*' '!/runs/*' '/runs/index.json'
git -C /tmp/js2wasm-baselines checkout main
```

`'!/runs/*'` excludes only the directory *contents* (not the dir itself), so
re-including `runs/index.json` is legal gitignore semantics. Unmaterialized
`runs/<sha>` entries are skip-worktree — `git add -A` cannot stage them as
deletions — and the NEW `runs/<sha>.json[l]` cache files written by
`write-run-cache.mjs` are staged via `git add -A --sparse` (git ≥2.35; runner
has 2.54). Applied to both `test262-sharded.yml` (promote + re-anchor loop)
and `refresh-baseline.yml` (deploy + re-anchor loop).

## Verification

- Next push to main: `promote merged report to main baseline` completes and
  the baselines repo receives a fresh commit touching both host AND standalone
  files. (Manual surgical promote of run 29610687707 artifacts bridged the gap
  meanwhile — host 32176 / standalone 24723 @ cc79b99945.)

## Follow-up (not this PR)

`runs/` grows without bound (~2 files per merge). Even metadata-only clones
and the baselines repo itself will eventually hurt. Needs a retention policy
(e.g. prune entries older than N days / keep last M SHAs) — PO to file.
