---
id: 1392
sprint: 52
title: "infra: refresh:benchmarks hangs in browser runtime Playwright eval"
status: done
created: 2026-05-08
priority: high
feasibility: medium
reasoning_effort: medium
task_type: infra
area: benchmarks
goal: developer-experience
---
# #1392 — refresh:benchmarks hangs in browser runtime Playwright eval

## Problem

`pnpm run refresh:benchmarks` can hang indefinitely in the browser runtime benchmark
stage:

```bash
node scripts/generate-browser-runtime-benchmarks.mjs
```

The script opens `http://127.0.0.1:4174/benchmarks/runtime-benchmark.html` and then
executes:

```js
window.__ts2wasmRunBrowserRuntimeBenchmarks().then((rows) => {
  document.getElementById("result").textContent = JSON.stringify(rows);
  return document.getElementById("result").textContent;
})
```

During the 2026-05-08 labs benchmark refresh, this Playwright `eval` stayed idle
for more than an hour with no output and no timeout. The parent process and
Playwright eval process were sleeping with 0% CPU while the browser process stayed
open. The earlier benchmark stages had already completed and written updated
suite, playground, and size artifacts, but the browser-runtime stage never
returned.

## Reproduction

```bash
pnpm run refresh:benchmarks
```

or, after `benchmarks/results/playground-benchmark-sidebar.json` exists:

```bash
node scripts/generate-browser-runtime-benchmarks.mjs
```

Observed stuck processes:

```text
node scripts/generate-browser-runtime-benchmarks.mjs
npm exec playwright-cli eval window.__ts2wasmRunBrowserRuntimeBenchmarks()...
node .../playwright-cli eval window.__ts2wasmRunBrowserRuntimeBenchmarks()...
```

## Likely failure mode

`scripts/generate-browser-runtime-benchmarks.mjs` wraps the Playwright call in
`execFileSync` without a timeout. If the page-side benchmark promise never
settles, the whole refresh command hangs forever. There is also no per-benchmark
progress log from the browser page, so the failing benchmark cannot be identified
from terminal output.

## Acceptance criteria

1. `generate-browser-runtime-benchmarks.mjs` has a bounded timeout for the
   Playwright `eval` step.
2. The browser benchmark page logs or returns per-benchmark progress so the
   hanging benchmark can be identified.
3. On timeout, the script closes the Playwright/browser session and exits with a
   clear error, or skips browser-runtime artifacts while preserving the already
   generated Node/size benchmark artifacts.
4. `pnpm run refresh:benchmarks` cannot hang indefinitely on the browser-runtime
   stage.
5. The generated artifacts remain consistent: no partially written
   `browser-runtime-benchmarks.json` is committed after a timeout.

## Notes

- This is separate from benchmark correctness. The immediate bug is the missing
  timeout and observability around the browser-runtime stage.
- The 2026-05-08 labs refresh was manually aborted after user confirmation.
