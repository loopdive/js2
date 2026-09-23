---
id: 6664
title: "standalone: lib.dom-only globals with no Wasm provider (performance, MessageChannel, window.ErrorEvent, queueMicrotask via a parameter) still emit env:: host imports"
status: ready
sprint: current
created: 2026-09-23
updated: 2026-09-23
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
language_feature: globals
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6663, 5351, 2907, 1662, 3958]
---

# #6664 — lib.dom-only globals leak `env::` imports into a standalone binary

## What you will see

`--target standalone` compiles a module that only *mentions* a browser API
inside a function that never runs, and the binary carries an `env::` import,
so it cannot be instantiated without a JS host (npm-compat standalone lanes
report `host-import-error`).

Measured 2026-09-23 on the npm-compat **react** standalone-dynamic lane once
[#6663](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6663-standalone-process-env-require-fold)
links `react.development.js` into the graph (at `-O4`, 6 imports):

| import | react source shape |
| --- | --- |
| `env.Performance_now` | `ioInfo.start = ioInfo.end = performance.now()` (lazy/thenable tracking) |
| `env.MessageChannel_new`, `_get_port1`, `_get_port2`, `MessagePort_set_onmessage`, `MessagePort_postMessage` | `enqueueTask` fallback: `var channel = new MessageChannel(); channel.port1.onmessage = …` |

Unoptimized (`-O0`) two more appear, dropped by Binaryen DCE only:
`env.queueMicrotask` (`queueMicrotask(function () { return queueMicrotask(callback); })`
— the callback is a parameter, so `compileTimerCall` finds no ClosureInfo and
falls back to the host path) and `env.ErrorEvent_new`
(`new window.ErrorEvent("error", …)` behind `"object" === typeof window`).

Two-line repros (standalone, each a `.js` producer imported by an entry):

```js
function f() { return performance.now(); }            // env.Performance_now
function g() { var c = new MessageChannel(); }        // env.MessageChannel_new
```

## Expected

A standalone program has no `performance`, `MessageChannel` or `window`. The
honest lowering is the one `process` already gets: `typeof X` is
`"undefined"` and a read throws `ReferenceError: X is not defined` — no host
import. `queueMicrotask` has a native provider (the standalone microtask
queue); a non-literal callback must route onto it rather than onto the host.

## Pointers

- `src/codegen/typeof-delete.ts` `HOST_ONLY_AMBIENT_GLOBALS` /
  `ambientIdentifierIsUnavailable` — the `typeof` half exists for a fixed
  DOM list; `performance` / `MessageChannel` are not in it.
- `src/codegen/extern-declarations.ts` — the declared-globals loop already
  skips `global_<Name>` under standalone (#2907); the extern-class member /
  constructor imports (`<Class>_new`, `<Class>_<member>`) have no such gate.
- `src/codegen/expressions/calls.ts` `queueMicrotask` arm — requires a
  statically known closure.
