---
id: 6671
title: "standalone: `console` read as a value is null — react's module-init `console.createTask` feature test throws TypeError"
status: ready
sprint: current
created: 2026-09-24
updated: 2026-09-24
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
language_feature: globals
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6664, 6663, 2907]
---

# #6671 — `console` as a value reads `null` in a standalone module

## What you will see

Once [#6664](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6664-standalone-unavailable-dom-globals-host-imports)
removed react's last host imports, the npm-compat **react** standalone-dynamic
lane (0 imports, 476,020 B at -O4) fails at module init:

```
runtime-error @ module-init: TypeError: Cannot access property on null or undefined at 698:20
```

react.development.js:695 (the lane's source carries a 3-line CJS wrapper):

```js
createTask = console.createTask
  ? console.createTask
  : function () { return null; };
```

Repro (single `.js` file, `target: "standalone"`, no imports):

```js
export function t() {
  try { var c = console.createTask ? console.createTask : function () { return null; }; return 0; }
  catch (e) { return e instanceof TypeError ? 2 : 3; }   // → 2
}
```

The WAT shows the `console` read lowered to `ref.null extern`, so the property
get throws. `console.log(...)` CALLS work (they have a dedicated lowering); a
bare `console` VALUE does not.

## Expected

`console` exists in every JS engine react targets, so the honest standalone
value is an object: member reads of methods the module provides natively
(`log`/`error`/`warn`/… — whatever the call lowering already supports) return
callables, and unknown members (`createTask`) read `undefined`, so react's
feature test takes its fallback. No host import.

## Pointers

- `src/codegen/expressions/identifiers.ts` — the declared-globals arm and the
  graceful-null default the `console` read falls to under standalone.
- The existing standalone `console.*` call lowering (grep `console` in
  `src/codegen/expressions/calls.ts`) — the natively provided method set.
