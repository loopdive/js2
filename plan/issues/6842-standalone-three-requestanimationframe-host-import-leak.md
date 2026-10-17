---
id: 6842
title: "standalone: three's requestAnimationFrame leaks as host import env.requestAnimationFrame (npm-compat standalone-dynamic compile-error)"
status: done
sprint: current
created: 2026-10-05
updated: 2026-10-16
completed: 2026-10-16
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: npm-compat, standalone, host-imports
goal: standalone
requested_by: ttraenkler/wave9-6288-refresh
related: [6742, 6675, 6659, 6664, 6691, 2961, 6841, 7015]
---

# #6842 — three: `requestAnimationFrame` leaks into the standalone binary

## Problem

The npm-compat `three` `standalone-dynamic` lane fails in codegen, before
wasm-opt runs:

```
Host import leak (warning, #2961): host import "env.requestAnimationFrame" survives into
the finished --target standalone binary and would fail instantiation in a runtime with no JS host
```

This was measured on 2026-10-05 on the #6742 refresh branch (main `b6324ee6d1`
plus #6742), in-process with no budget. Codegen took 1,294 s wall at load
80–390 on 8 cores. On main, the lane's record only says
`standalone-dynamic lane exceeded the 180000ms harness budget (compile-budget)`.
With #6742's phase marker, that overrun now reads `during codegen`.

Source: `node_modules/three/build/three.core.js` ~L2084, in the yield helper:
`self.scheduler.yield()` when available, else
`new Promise(resolve => { requestAnimationFrame(resolve); })`.
`three.module.js` L20/L32 also calls `context.requestAnimationFrame(...)`
through a member, which does not leak.

## Implementation Plan

`requestAnimationFrame` is a browser rendering API. A standalone runtime has
no frame clock, so there is nothing Wasm-native to implement. This follows
#6675 (timers) and #6664 (`MessageChannel`): a call to an unavailable
capability throws a documented error at the call.

1. Find where #6675 lowers a free `setTimeout` identifier in standalone mode
   (grep `6675` under `src/codegen/` and `src/runtime/`). Add
   `requestAnimationFrame` and `cancelAnimationFrame` to the same table of
   unavailable standalone globals. A call throws
   `ReferenceError: requestAnimationFrame is not defined`, which matches what
   Node does. `typeof requestAnimationFrame` must stay `"undefined"` and must
   not throw.
2. Do not add a host import. Do not add the name to
   `src/codegen/host-import-allowlist.ts`.
3. Regression test `tests/issue-6842-*.test.ts`, compiled with `--target standalone`:
   - (a) a function that calls `requestAnimationFrame(cb)` compiles with zero
     imports, and calling it throws a `ReferenceError`;
   - (b) `typeof requestAnimationFrame === "undefined"`;
   - (c) anti-vacuity control: the same source on the JS-host lane still
     imports or uses the host global.
4. Re-measure:
   `npx tsx scripts/generate-npm-compat-report.mjs --only three --no-write --perf-only --lane standalone-dynamic`.
   Record the next error.

## Acceptance

- The three standalone-dynamic lane no longer reports the
  `env.requestAnimationFrame` leak.
- JS-host binaries for three are byte-identical before and after.

## Resolution

The fix came in through #6841 (`28df1536b3`, 2026-10-05). That change added
`requestAnimationFrame` / `cancelAnimationFrame` to the
`STANDALONE_UNAVAILABLE_TIMER_GLOBALS` table in
`src/codegen/standalone-timers.ts`, which is exactly what step 1 of the plan
asks for. This issue was measured on `b6324ee6d1`, which does not contain
#6841, so the leak it recorded was already fixed when the issue was filed.

- `tests/issue-6842-standalone-three-raf.test.ts` pins three's exact
  `yieldToMain` source shape. On standalone it compiles with zero imports;
  `typeof requestAnimationFrame` and `typeof cancelAnimationFrame` are
  `"undefined"`; a direct call throws `ReferenceError`; and in the
  Promise-executor fallback the error rejects the promise instead of escaping.
  The gc control still imports `env.requestAnimationFrame`.
  - With the pre-#6841 `standalone-timers.ts`: 1 fail / 1 pass.
  - On main: 2/2 pass.
- Lane re-measure, upstream/main `ee58c1aa26`:
  `npx tsx scripts/generate-npm-compat-report.mjs --only three --no-write --perf-only --lane standalone-dynamic`.
  It runs in-process with no budget. Codegen took 213.9 s at load ~160–190
  on 8 cores, so it would overrun the 180 s CI lane budget (#4287). The first
  diagnostic is now `env.createImageBitmap`. `requestAnimationFrame` is gone.
- The same driver compiled directly with `compileProject` gives the full
  picture: codegen 325.8 s, then `success: false`.
  - 57 host-import leaks: `createImageBitmap`, `fetch`, and browser
    extern-class members of `WebGL2RenderingContext`, `PannerNode`,
    `AudioParam`, `AnalyserNode`, `GainNode`, `AudioNode`, `VideoFrame`,
    `OffscreenCanvas`, `DOMParser`, `ReadableStream*`, `AbortController`,
    `ProgressEvent` and `CustomEvent`.
  - A Wasm validation error:
    `ObjectLoader_loadAsync: extern.convert_any[0] expected type anyref, found call of type externref`.

  These are the next blockers, filed as #7015, and are not part of
  this issue.
- Residual found while writing the test: on standalone, three's guard
  `typeof self !== 'undefined' && typeof self.scheduler !== 'undefined'`
  throws `TypeError`. `typeof self` is not `"undefined"`, but the member read
  fails, so `yieldToMain()` throws before it reaches the
  `requestAnimationFrame` fallback. Filed in #7015 with the other three residuals.

