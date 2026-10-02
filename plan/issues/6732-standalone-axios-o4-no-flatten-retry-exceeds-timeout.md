---
id: 6732
title: "standalone axios: the #4586 O4 `--skip-pass=flatten` retry runs far past wasm-opt's 600 s timeout, and the retry's failure text is truncated away"
status: ready
sprint: current
created: 2026-09-28
updated: 2026-09-28
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [1032, 4157, 4586, 6714]
---

# #6732 — axios standalone-dynamic: O4 retry without Flatten times out

## What you will see

After [#6714](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6714-standalone-textencoder-encode-f64-vec-vs-uint8array),
this command still reports `optimization-error`:

```
npx tsx scripts/generate-npm-compat-report.mjs --only axios --no-write --perf-only --lane standalone-dynamic
```

The diagnostic, verbatim (measured 2026-09-28 on `2e23e49fb1` + #6714):

```
wasm-opt -O4 did not produce the measured artifact: wasm-opt -O4 failed: unexpected expr type
UNREACHABLE executed at /home/runner/work/binaryen.js/binaryen.js/binaryen/src/passes/Flatten.cpp:231!
```

The raw module now validates in V8: 9,216,193 B, 62 imports. It uses
`try_table` (209 sites), and Binaryen's O4-only Flatten pass aborts on
`try_table`. #4586 handles this abort by re-running O4 with
`--skip-pass=flatten`.

## What the retry actually does

Run by hand with the flags `src/optimize.ts` uses:

```
wasm-opt axios.wasm -O4 --all-features --disable-custom-descriptors --disable-compact-imports --skip-pass=flatten
```

It succeeds and yields a valid 3,820,273 B module with 24 imports. It took
about 38 min wall-clock on a loaded box. `optimizeWithSystemBinary` gives each
`execFileSync` a `timeout: 600_000`. The lane's `compileDurationMs` was
695,725 / 703,353 ms (two runs), which is consistent with the retry being
killed at 600 s.

The lane never shows the retry's error. `text` is the first run's stderr,
which includes Binaryen.js's whole minified source dump. The retry reason is
appended after it, and `warning` keeps only `text.slice(0, 800)`, so the retry
reason is cut off.

## Fix direction

1. Diagnostics: put the retry's failure first, or strip the Binaryen.js
   source dump from `text`, so a timed-out retry reads as a timeout.
2. Time: work out why O4 over this module is so slow. Candidates are the
   #4157 inline-cache hints and the module size (9.2 MB raw). Either bring it
   under the budget, or give the standalone-dynamic lane a documented O4 → O3
   fallback on timeout. O3 does not run Flatten.
