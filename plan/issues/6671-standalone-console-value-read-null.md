---
id: 6671
title: "standalone: `console` read as a value is null — react's module-init `console.createTask` feature test throws TypeError"
status: done
sprint: current
created: 2026-09-24
updated: 2026-09-24
completed: 2026-09-24
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
language_feature: globals
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6664, 6663, 2907, 3469, 2933, 4616]
loc-budget-allow:
  # 2026-09-24 (#6671): +4 lines — the collector records a `console` VALUE
  # read (one state field, its initializer, one probe call into
  # standalone-console-object.ts, and the widened sink condition) so the
  # pre-body window mints the stdout sink the console object's methods write to.
  - src/codegen/declarations/import-collector.ts
  # +3 lines: the identifier read arm calls tryEmitStandaloneConsoleValue next
  # to the #6664 unavailable-global arm (restated here so the grant is not
  # stranded in #6664's file once that PR lands first).
  - src/codegen/expressions/identifiers.ts
func-budget-allow:
  # 2026-09-24 (#6671): +1 line — the single probe call above sits in the
  # collector's one visit function, next to the direct-call console arm.
  - src/codegen/declarations/import-collector.ts::unifiedVisitNode
  # +2 lines: the console value arm in the identifier read dispatch.
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
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

## Implementation Plan

What was executed (standalone lane only; JS host byte-identical):

1. **Object model** — new `src/codegen/standalone-console-object.ts`. An
   ambient `console` VALUE read (not shadowed by a local, capture, eval-visible
   binding or source declaration; not a linked standalone module; not WASI)
   calls `__standalone_console_object()`, which lazily builds ONE plain
   `$Object` (cached in `__native_console`) with own properties
   `log`/`warn`/`error`/`info`/`debug`. Everything else is absent, so
   `console.createTask` reads `undefined` and react's guard takes its fallback.
   No import.
2. **Methods** — one shared lifted body `__standalone_console_method(self,
   (ref null $vec_externref)) -> externref` writing each argument through
   `emitStandaloneStdoutAppendValue` (the #3469 sink the direct
   `console.log(...)` lowering uses), `" "`-separated, then `"\n"`; returns
   `undefined`. Each method is an identity-stable builtin-fn singleton with its
   own metadata subtype (`name` = method, `length` = 0), so
   `console.log !== console.error`.
3. **Every call shape packs the arguments** — the metadata subtype's
   ClosureInfo copy is flagged `hasRestParam`, so the #4616/#5329 rest-carrier
   machinery packs all arguments into the vector in `__call_fn_method_<n>`
   (method call on the object, `.call`, `.apply`) and in any-callee dynamic
   call sites. Statically typed aliases (`var l = console.log; l(a, b)`) pack
   by the lib's `(...data)` signature.
4. **Sink minting** — the import collector records a `console` value read
   (`isConsoleValueIdentifier`) so the pre-body window mints the stdout sink
   even when the module has no direct `console.<method>(…)` call.

Rejected on measurement: publishing the #2933 `variadicBuiltinClosure` slot
(adds a pack arm at every any-callee site, +4 KB on react, not needed once the
rest flag is set); an `(externref) -> externref` signature (typed aliases then
printed only their first argument).

## Resolution

- Repro (`console.createTask ? … : fallback`, two-file `.js`, standalone):
  parent → TypeError (2); fix → fallback taken (0), 0 imports.
- `tests/issue-6671-standalone-console-value.test.ts`: parent 1/4 (only the
  shadowing control passes), fix 4/4. Covers the react guard, member shape
  (`typeof`, `in`, identity), stdout for alias / method-on-object / `.call` /
  `.apply` / callback / no-arg calls, and user `console` bindings.
- npm-compat **react** standalone-dynamic: `runtime-error @ module-init:
  TypeError: Cannot access property on null or undefined at 698:20` →
  **measured** (checksum 8/8, 0 imports, 609,228 B at -O4). The binary grows
  from 444,862 B because module init no longer aborts at line 695, so the
  rest of react's module body is live (the lowering disabled by env: 444,862 B
  again).
- Scoped standalone test262 (Math.max, String.fromCharCode,
  async-function, Function.prototype.apply — 77 rows): parent 74/77, fix
  74/77 (the 3 are the unbuilt quickjs eval provider on this box). No test262
  file reads `console` as a value, so the lowering is inert there.
- JS host: `probe.js` and `react.development.js` compile to identical bytes
  on parent and fix (sha256 prefix `90c1ba370b6d95ef` / `653abd56ec317436`).
- Known residual: a direct `console.log(...)` call site still ignores a user
  binding named `console` (`var console = {log(){}}; console.log(1)` writes to
  the sink) — pre-existing in the direct-call intercept, not changed here.

