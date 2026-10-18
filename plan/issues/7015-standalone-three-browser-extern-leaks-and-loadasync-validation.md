---
id: 7015
title: "standalone: three's standalone-dynamic lane: 57 browser host-import leaks, an ObjectLoader_loadAsync validation error, and `typeof self.scheduler` throwing"
status: ready
sprint: current
created: 2026-10-16
updated: 2026-10-16
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: npm-compat, standalone, host-imports
goal: standalone
requested_by: ttraenkler/wave14-three-stylelint-leaks
related: [6842, 6841, 6691, 6664, 4287, 2961, 7023]
---

# #7015 — three standalone-dynamic: the blockers after #6842

## Problem

#6842's `requestAnimationFrame` leak is gone; it was fixed by #6841. Measured
on upstream/main `ee58c1aa26` on 2026-10-16, at load ~160–190 on 8 cores:

- **Lane**: `npx tsx scripts/generate-npm-compat-report.mjs --only three --no-write --perf-only --lane standalone-dynamic`.
  This runs in-process with no budget. Codegen took 213.9 s, and the first
  diagnostic is
  `Host import leak … "env.createImageBitmap"`. 213.9 s exceeds the 180 s CI
  lane budget (#4287).
- **Full diagnostic list**: the same driver
  (`import { Vector3 } from "three"`, sample op `new Vector3(x, 2, 3).length()`),
  compiled directly with `compileProject` using the lane's options
  (`target: "standalone"`, `runtimeEvalProvider: false`,
  `deferTopLevelInit: true`, `optimize: false`). Codegen took 325.8 s, then
  `success: false`:
  1. **Validation error**:
     `Compiling function "ObjectLoader_loadAsync" failed: extern.convert_any[0] expected type anyref, found call of type externref`.
     A call that returns `externref` is fed to `extern.convert_any`, which
     needs an `anyref` operand. This is a coercion bug, independent of the
     host-import question.
  2. **57 `env.*` host-import leaks**. Two are free functions:
     `createImageBitmap` and `fetch`. `fetch` is already in #6691's table, so
     find out why this call site escapes it. The rest are browser
     extern-class members reached through values:
     `WebGL2RenderingContext_*` (10), `PannerNode_*` (20), `AudioParam_*`,
     `AnalyserNode_*`, `GainNode_*`, `AudioNode_*`, `VideoFrame_*`,
     `OffscreenCanvas_*`, `DOMParser_*`, `ReadableStream*`,
     `AbortController_*`, `ProgressEvent_new` and `CustomEvent_new`.
  3. **`typeof self.scheduler` throws.** three's `yieldToMain` guard
     `typeof self !== 'undefined' && typeof self.scheduler !== 'undefined'`
     throws `TypeError` on standalone. `typeof self` is not `"undefined"`, but
     reading a member of `self` fails. Either `self` is the global object, in
     which case the member read must work, or it is unavailable, in which case
     `typeof self` must be `"undefined"`.

## Implementation Plan

To be written. Start with item 1 (validation). Then extend the #6841/#6664
unavailable-DOM-class gate (`isUnprovidedDomClass` in
`src/codegen/standalone-unavailable-globals.ts`) to the Web Audio, WebGL,
Streams and DOMParser families, and work out why `fetch` and
`createImageBitmap` bypass `tryStandaloneHostFreeCall`.
