# Commit-hash-indexed test262 run cache (#1081)

> **Where the data lives:** the `<sha>.{json,jsonl}` files described here are
> stored in the **`loopdive/js2wasm-baselines`** repo under `runs/`, *not* in
> this main repo. This directory holds only the docs. Keeping the cache out of
> the main repo avoids bloating every clone (each run is ~1.5 MB; ~150 retained
> ≈ 225 MB). See [`CLAUDE.md` → Baseline files](../../CLAUDE.md) for how the
> baselines repo is wired.

## Why this exists

A PR's regression-gate must compare its test262 results against **main at the
PR's merge-base commit** — not against a moving "latest main" pointer. When the
single `test262-current.jsonl` baseline drifts between its last refresh and a
PR's CI run, tests that flipped on main since then show up as PR-caused
regressions even though the PR didn't touch them.

This cache eliminates that drift: every push to main writes the run's results
keyed by the commit SHA they were produced against, so a PR can load the exact
baseline for its merge-base. Reported regressions become precisely
`results(merge-base) → results(HEAD)`.

## Layout

```
runs/index.json            — overall pass-rate trend-graph history (unchanged; never pruned)
runs/editions-index.json   — per-ES-edition pass-rate trend history, for the landing-page mini edition graphs (never pruned)
runs/standalone-index.json — standalone-target pass-rate trend history, for the landing-page primary graph's standalone scope (never pruned)
runs/<commit-sha>.json     — summary: pass/fail/CE counts, run metadata, per-category breakdown
runs/<commit-sha>.jsonl    — per-test results for that commit
```

`<commit-sha>` is `github.sha` of main at the time the sharded run ran.

### `<sha>.json` schema

```jsonc
{
  "sha": "ef179253b...",
  "ref": "refs/heads/main",
  "pass": 30214, "fail": 11775, "compile_error": 1124,
  "compile_timeout": 4, "skip": 18, "total": 43135,
  "strict_pass": 9000, "strict_total": 12000,
  "run_id": "24289351335",
  "run_started_at": null,
  "run_duration_seconds": null,
  "test262_version": "<test262-submodule-sha>",  // guards against stale-corpus cache hits
  "categories": { "language/statements/for-of": { "pass": 134, "fail": 12, "compile_error": 0, "total": 146 }, ... }
}
```

The per-category breakdown enables fast diff queries without loading the 1.5 MB
jsonl.

## How it flows

1. **Write** — `promote-baseline` (`.github/workflows/test262-sharded.yml`)
   calls `scripts/write-run-cache.mjs` after refreshing the latest-main
   baseline, writing `runs/<github.sha>.{json,jsonl}` into the baselines repo.
   Corrupt reports (pass < 1000 or total < 40000) are declined, never written.
2. **Read** — the PR `regression-gate` job calls
   `scripts/resolve-merge-base-baseline.mjs`: it computes
   `git merge-base origin/main HEAD`, and if `runs/<merge-base>.jsonl` exists
   **and** its `test262_version` matches the PR's test262 submodule, it uses
   that as the diff baseline. Otherwise it warns (cache MISS) and falls back to
   the latest-main `test262-current.jsonl`. A miss never fails the build.
3. **Prune** — `.github/workflows/test262-cache-prune.yml` runs weekly:
   sprint-tagged commits are kept forever; entries older than 30 days are
   evicted; once total exceeds 500 MB the oldest survivors are LRU-evicted.

## Non-goals

- This cache is **main-only** — PR-branch runs are ephemeral and never cached.
- It is **not required for correctness**: a miss falls back to the prior
  behavior. The cache is a performance + drift-elimination enhancement.
- `test262-current.jsonl` stays as the human-readable "latest main" pointer; the
  hash-indexed files are authoritative for merge-base diffs.

## Scripts

| Script | Role |
|--------|------|
| `scripts/write-run-cache.mjs` | Build `<sha>.json` + copy `<sha>.jsonl` (promote-baseline). |
| `scripts/resolve-merge-base-baseline.mjs` | Pick merge-base cache entry vs. latest-main fallback (PR gate). |
| `scripts/prune-run-cache.mjs` | Apply retention policy (weekly prune); only matches `<sha>.{json,jsonl}`, never touches `index.json`/`editions-index.json`/`standalone-index.json`. |
| `scripts/append-run-history.mjs` | Append a snapshot to `editions-index.json` / `standalone-index.json` (promote-baseline / write-run-cache-bot / refresh-baseline.yml). |

Unit tests: `tests/issue-1081.test.ts`.
