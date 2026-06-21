---
name: feedback-standalone-rate-from-baselines-repo
description: Get the standalone (and host) test262 pass rate from the loopdive/js2wasm-baselines repo — never run test262 locally for it
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

To report the current standalone (or JS-host) test262 pass rate, read it from the **`loopdive/js2wasm-baselines`** repo — do NOT kick off a local `pnpm run test:262` (the user explicitly stopped a local standalone run: "dont do this locally" / "rather take the values from js2wasm-baselines", 2026-06-19).

**Why:** a local run is ~68 min and saturates the shared box (competes with the active dev agents). The baselines repo holds fresh per-mode results, refreshed by the `promote-baseline` job on **every push to main**, so it's always within minutes of current main — a local run buys nothing. (The main-repo committed `benchmarks/results/test262-standalone-*.json` lags — it was ~48% / 06-18 while the baselines repo showed 50.8% / same-day.)

**How to apply:**
- Headline standalone non-proposal rate lives in `test262-standalone-current.json` (field: `total` 43135 / `pass`). Host rate is in `test262-current.json` (31365/43135 = 72.7% on 2026-06-19).
- Fetch raw: `gh api repos/loopdive/js2wasm-baselines/contents/test262-standalone-current.json -H 'Accept: application/vnd.github.raw'`.
- Freshness/source commit: `gh api repos/loopdive/js2wasm-baselines/commits/main --jq '.commit.committer.date, .commit.message'` — the message even states both rates (e.g. "refresh baselines — 31365/43135 host, 21912/43135 standalone").
- Per-test detail (for failure mining) is `test262-standalone-current.jsonl` (~29 MB) there, or via `scripts/fetch-baseline-jsonl.mjs` to `.test262-cache/`.
- 2026-06-19 reading: standalone 21,912/43,135 = **50.8%** (sprint-64 start was 47.0%). Relates to [[feedback_test262_worktree]] and the baseline-files table in CLAUDE.md.
