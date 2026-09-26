---
id: 6681
title: "standalone: lodash-es module-init calls Date.now() (via _shortOut) and throws — no standalone clock"
status: done
sprint: Backlog
created: 2026-09-26
updated: 2026-09-26
completed: 2026-09-26
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
language_feature: Date
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [2164, 6675, 6676, 6678, 6684]
---

# standalone: lodash-es module-init calls `Date.now()` and throws

## Problem

After #6675/#6676 the lodash-es `standaloneDynamic` npm-compat lane compiles
with **0 imports** and fails at module-init with (verbatim):

```
TypeError: Date.now is not yet implemented in --target standalone
```

That throw is the deliberate #2164 slice-1 behaviour: a standalone module has
no clock import, so `Date.now()` / `new Date()` throw instead of emitting an
unsatisfiable host import.

lodash-es reaches it at module-init, not in user code:

- `_shortOut.js`: `var nativeNow = Date.now;` and the returned wrapper calls
  `nativeNow()` on every invocation (hot-function detection).
- `_setToString.js` / `_setData.js` are `shortOut(...)` wrappers, and
  `baseRest(fn)` calls `setToString(...)` — which top-level definitions such as
  `var difference = baseRest(function ...)` run during module-init.

Probe (2026-09-26, branch issue-lodash-es-standalone-timers-eval, standalone):

| source | result |
| --- | --- |
| `var nativeNow = Date.now;` (read only) | ok, 0 imports |
| `var nativeNow = Date.now; var t = nativeNow();` | throws at module-init |

## Direction (to be decided in the plan)

Standalone has no host clock. Options, none chosen yet:

1. A Wasm-native clock only when the target provides one (WASI
   `clock_time_get` already exists for `--target wasi`); pure standalone keeps
   throwing.
2. A documented deterministic standalone clock (e.g. a monotonic counter from
   0) — spec-questionable, needs a project-lead decision.
3. Leave `Date.now` throwing and accept lodash-es as blocked in pure
   standalone.

No new host imports in standalone (host-import policy, #6659/#6664 precedent).

## Acceptance criteria

- lodash-es `standaloneDynamic` lane gets past module-init with 0 imports, or
  the issue is closed wont-fix with the decision recorded.
- Standalone Date test262 buckets do not regress.

## Implementation Plan (executed)

Decision: none of the three options needed a new policy. The DIRECT call
`Date.now()` already has a decided standalone lowering (#2164 slice 1 — the
certified clock@1 embedder capability when the module demanded one, else the
Unix epoch `0`; `new Date()` and `performance.now()` follow the same rule).
Only the VALUE read `Date.now` threw: the builtin static-method value closure
fell to the generic "not yet implemented" refusal body. So:

- `ensureStandaloneBuiltinStaticMethodClosure` (builtin-value-read.ts) gets a
  `Date.now` case: signature `() -> f64` (the checker's `() => number`, the ABI
  a typed call through the binding uses), body = `emitStandaloneDateNowValue`,
  the direct call's own emitter. Value and call cannot disagree, and no import
  is added.

lodash's `_shortOut` with a clock that never advances treats every call as
hot and, after 800 consecutive calls, returns its first argument without
calling through — `setToString`/`setData` then skip decoration. That is the
same observable behaviour it has under a coarse real clock.

## Resolution

- lodash-es `standalone-dynamic`: `TypeError: Date.now is not yet implemented
  in --target standalone` → module-init now reaches `TypeError: Unsupported
  dynamic regular expression pattern` (0 imports) — filed as #6684.
- `tests/issue-6678-6681-standalone-date.test.ts` (#6681 block): parent throws
  at module-init, fix 0/6 rows fail.
- Scoped standalone test262 `built-ins/Date` (includes `Date/now`): parent
  538/594, fix 538/594, identical non-pass set.
