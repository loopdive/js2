---
id: 3904
title: "perf-bench: all four dom/* benchmarks publish a JS-only bar — the wasm lane fails silently and the page shows nothing"
status: ready
created: 2026-07-31
updated: 2026-07-31
priority: high
feasibility: medium
reasoning_effort: high
task_type: bug
area: testing
language_feature: dom
goal: performance
sprint: current
horizon: m
es_edition: n/a
related: [3902, 3903, 1009]
---

# #3904 — the `dom/*` benchmarks have no wasm lane at all on the public page

## Status: open

## Problem

`benchmarks/results/latest.json` (2026-07-31) contains **only a `js` entry**
for all four DOM benchmarks:

```
dom/create-elements    js
dom/set-attributes     js
dom/read-attributes    js
dom/modify-text        js
```

Every other benchmark in the file has 2-4 strategies. These four have one. So
on `https://js2.loopdive.com/benchmarks/performance.html` the DOM section
either renders an empty chart or a lone JS bar with nothing to compare it to.

`benchmarks/suites/dom.ts` deliberately skips `gc-native` and `linear-memory`
("DOM always needs host calls" — reasonable, DOM is inherently host interop).
That leaves **`host-call`, which is not skipped and should be running**. It is
producing no result, which means it is failing and being swallowed.

## Why it is invisible

`benchmarks/harness.ts` downgrades any strategy failure to a skip in three
places — setup (`:168-177`), calibration (`:198-202`), and mid-loop
(`:219-223`). Each writes a line to **stderr** and returns `null`. The result
never reaches `latest.json`, so the chart simply omits the bar. A reader
cannot distinguish "this lane is not applicable" from "this lane crashed".

This is the same swallowing that hides the missing `array/sort-i32` gc-native
lane (#3902) — coordinate on the harness fix rather than doing it twice.

## Reproduce

```bash
npx tsx benchmarks/run.ts --suite dom --strategy js,host-call
```

and read stderr for the `[host-call skipped: …]` line. (Note: the repo needs
`pnpm install` first — a bare `npx tsx` fails with
`Cannot find package 'typescript'`, which is not the bug being investigated.)

## Scope

1. **Get the actual error.** Do not guess. It could be the DOM stub
   `deps`/`extraEnv` wiring in `benchmarks/suites/dom.ts`, a compile failure
   on the DOM source strings, or a runtime trap on first call.
2. **Fix it** so the four DOM benchmarks publish a real `host-call` bar, or —
   if the DOM stubs are fundamentally not runnable in the Node harness —
   remove the benchmarks from the published page rather than shipping four
   meaningless single-bar charts. Either outcome is acceptable; silently
   publishing nothing is not.
3. **Surface future failures.** A failed strategy must appear in the results
   JSON with its error (e.g. `{strategy, status: "failed", error}`) so the page
   can render "lane failed" and the next person does not have to run the suite
   by hand to discover a lane has been dead for months. Coordinate with #3902,
   which needs the identical change — whoever lands first, the other rebases.
4. **Once it runs, report the numbers.** DOM is pure host interop, so expect
   this lane to be slow; that is fine and expected. The point is publishing an
   honest bar, not winning. If it is catastrophically slow in the way #3903
   describes, cross-reference it there.

## Acceptance criteria

1. The `[host-call skipped: …]` error for all four DOM benchmarks is recorded
   verbatim in this issue.
2. Either all four publish a working `host-call` result in
   `benchmarks/results/latest.json`, or they are removed from the page with the
   reason documented here.
3. Failed strategies are represented in the results JSON with an error string
   instead of being omitted entirely.
4. The performance page renders sensibly in whichever of the two outcomes
   applies — no empty chart cards.

## Non-goals

- Optimising DOM interop performance. Get an honest bar first; optimisation is
  a separate issue filed from the resulting number.
- The offline-first Playwright DOM measurement work tracked elsewhere — this
  issue is about the existing Node-harness lane failing silently.
