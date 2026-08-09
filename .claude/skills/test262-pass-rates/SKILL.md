---
name: test262-pass-rates
description: Show current test262 pass rates for both the js-host (gc) and standalone targets side by side, from committed baseline summaries — no network fetch, no compile. Use for a quick conformance status check.
---

# Test262 Pass Rates (js-host vs standalone)

Prints the current committed test262 conformance numbers for both compile targets side by side. Reads two committed, CI-refreshed summary files directly — no test run, no network fetch, near-instant.

## Data sources

- **js-host (gc target)**: `benchmarks/results/test262-current.json` — refreshed by the `promote-baseline` job in `test262-sharded.yml` on every push to main. Use `.summary` (or `.official_summary` if present) for `pass`/`total`, and `.summary.host_free_pass` for the narrower "passes with zero host imports" count (not the same as a standalone-target run — see below).
- **standalone target**: `benchmarks/results/test262-standalone-highwater.json` — refreshed alongside the js-host baseline (same `sha`/`generated_at`). Use `.official_pass` / `.official_total` for the genuine standalone-target compile+run pass rate.

Both files are committed to the repo (small, ~KB-scale) and always reflect the last successful push-to-main run — check `.timestamp`/`.generated_at` and `.sha` against `git -C /workspace log -1 --format=%H` to confirm freshness; if the sha doesn't match current main, note that the numbers are as-of the last CI run, not live.

## Steps

1. Read both files:

```bash
node -e "
const host = require('/workspace/benchmarks/results/test262-current.json');
const sa = require('/workspace/benchmarks/results/test262-standalone-highwater.json');
const h = host.official_summary ?? host.summary;
const hostPct = (100 * h.pass / h.total).toFixed(1);
const saPct = (100 * sa.official_pass / sa.official_total).toFixed(1);
const gap = h.pass - sa.official_pass;
console.log('js-host (gc):   ' + h.pass + ' / ' + h.total + '  (' + hostPct + '%)');
console.log('standalone:     ' + sa.official_pass + ' / ' + sa.official_total + '  (' + saPct + '%)');
console.log('honest gap:     ' + gap + ' tests pass under js-host but not standalone');
console.log('baseline sha:   ' + host.baseline_sha);
console.log('generated at:   ' + host.timestamp);
"
```

2. Report the three lines (js-host, standalone, gap) plus the baseline sha/timestamp so the user knows how fresh the numbers are.
3. If the user wants a live/fresh recompute instead of the committed baseline (e.g. mid-session after several merges), note that `pnpm run test:262` produces a new `test262-current.json` locally, and the standalone-highwater file is only refreshed by CI's `promote-baseline` job — a local standalone re-run needs `--target standalone`/`--target wasi` on the relevant runner, which is a much heavier operation than this quick check.

## Output format

```
js-host (gc):   31874 / 43106  (73.9%)
standalone:     18415 / 43106  (42.7%)
honest gap:     13459 tests pass under js-host but not standalone
baseline sha:   b71bea94d97021c21cb61ef2e0b553ad78916da9
generated at:   2026-07-03T07:31:22.294Z
```
