---
id: 6705
title: "linked graphs: same-named top-level `var` in two modules share ONE module global (silent wrong answer)"
status: ready
sprint: Backlog
created: 2026-09-27
updated: 2026-09-27
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6684, 6669, 4133, 3520]
---

# #6705 — two modules' `var x` read and write the same Wasm global

## Problem

`ctx.moduleGlobals` is keyed by the bare name across a linked graph, so two
modules that each declare a top-level `var x` get ONE `__mod_x` cell. Found
while fixing #6684 (the function-read-hits-foreign-var case of the same map).

```js
// a.js
var x = 3;
export default function a() { return x; }
// b.js
var x = 5;
export default function b() { return x; }
// main.mjs
import a from './a.js';
import b from './b.js';
export function run() { return a() * 10 + b(); }
```

Node: `35`. js2wasm `--target standalone` (`compileProject`): `55` — compiles
clean, no diagnostic. The second initializer overwrites the first module's
binding.

lodash-es survives it only because most of its repeated top-level names
(`objectProto`, `hasOwnProperty`, `funcProto`, …) hold identical values in every
module.

#4133 is the function–function twin, #6669 the variable-read-hits-foreign-
function case, #6684 the function-read-hits-foreign-variable case. #3520's
source-qualified identity is the structural fix for all of them.

## Acceptance

- The repro answers 35 on both targets.
