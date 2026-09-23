---
id: 6667
title: "standalone: three.js refuses at JSON.stringify(array of objects) and at `.replace(/re/g, <number>)` — first blockers in the npm-compat standalone-dynamic lane"
status: ready
sprint: Backlog
created: 2026-09-23
updated: 2026-09-23
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: feature
area: compiler
goal: standalone
related: [1539, 1599, 1913, 6661, 6665]
---

# #6667 — three.js standalone blockers: JSON.stringify of objects, non-string replace replacement

## Problem

Found by [#6661](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6661-npm-compat-opaque-lane-diagnostic).
The three 0.185.1 standalone-dynamic lane (`--perf-only --lane
standalone-dynamic`, compile 256 s to the refusal, 789 s for the full error
list) fails at compile time with two error families:

1. `build/three.core.js:19498` — `data.data.groups = JSON.parse(JSON.stringify(groups));`
   (`BufferGeometry.toJSON`, `groups` is an array of `{ start, count, materialIndex }`):

   ```
   Codegen error: JSON.stringify of this value is not yet supported by the native JSON provider (#1599).
   Pure-Wasm JSON.stringify of null/undefined/boolean works standalone; numbers, objects, arrays, strings, and JSON…
   ```

2. `build/three.module.js:6453–6470` — the shader-chunk substitutions
   `.replace( /NUM_DIR_LIGHTS/g, parameters.numDirLights )` (a NUMBER
   replacement value), 12 sites:

   ```
   Codegen error: standalone RegExp engine does not support replace with a function (or non-string) replacer (#1913 follow-up) (#1539 Phase 2a).
   ```

   A non-callable replacement is spec'd as `ToString(replaceValue)`
   (§22.1.3.19 step 6), so this is a static-RegExp literal with a value that
   only needs a string coercion — no function-replacer machinery.

## Acceptance criteria

- Standalone `JSON.stringify([{ start: 0, count: 3, materialIndex: 1 }])`
  equals Node's output (fixture as an untyped two-file `.js` project).
- Standalone `"a NUM b".replace(/NUM/g, 4)` returns `"a 4 b"`.
- The three standalone-dynamic lane moves past both refusals (next error, if
  any, recorded here).
