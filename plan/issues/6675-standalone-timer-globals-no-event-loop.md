---
id: 6675
title: "standalone: setTimeout/clearTimeout/setInterval/clearInterval emitted env:: host imports (lodash-es debounce/throttle/delay)"
status: done
sprint: current
created: 2026-09-24
updated: 2026-09-24
completed: 2026-09-24
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bug
area: compiler
language_feature: globals
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6664, 6659, 6676, 2632, 2961]
loc-budget-allow:
  # 2026-09-24: #6675/#6676 wire two small classified modules
  # (standalone-timers.ts, expressions/standalone-dynamic-code.ts) into the
  # existing dispatch points: one import + one call-site line per file, plus
  # the `runtimeEvalProvider` option threading (index/compiler/context types).
  - src/codegen/expressions/calls.ts
  - src/codegen/extern-declarations.ts
  - src/codegen/typeof-delete.ts
  - src/codegen/expressions/eval-inline.ts
  - src/codegen/context/types.ts
  - src/compiler.ts
  - src/index.ts
func-budget-allow:
  # 2026-09-24: one `??`-chained dispatch line in compileCallExpression
  # (#6675/#6676); one option projection line in createCodegenContext (#6676).
  - src/codegen/expressions/calls.ts::compileCallExpression
  - src/codegen/context/create-context.ts::createCodegenContext
---

# #6675 — timer globals leaked `env::` imports into a standalone binary

## Problem

npm-compat **lodash-es** `standaloneDynamic` lane (2026-09-24, upstream/main
`d76cdfc9b4`): compiles, then `host-import-error — standalone binary retained
4 host import(s)`: `env.setTimeout`, `env.clearTimeout`,
`js2wasm:runtime-eval.__runtime_new_function`,
`js2wasm:runtime-eval.__runtime_apply_interpreted`. This issue owns the two
timer imports (the runtime-eval pair is
[#6676](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6676-standalone-dynamic-function-no-runtime-eval-provider)).

Emitted by `collectExternDeclarationsImpl` (`extern-declarations.ts`): the
lib.dom `declare function setTimeout(...)` / `clearTimeout(...)` became
`env.<name>` stubs via `registerAmbientParseImport` because the source
references them (`_baseDelay.js`, `debounce.js`, `throttle.js`). Only WASI
lowers timers (onto its poll_oneoff reactor, #2632); standalone fell through
to the host stub. Two-line repro (untyped `.js` producer imported by an entry):

```js
export function later(f, w) { return setTimeout(f, w); } // env.setTimeout
```

## Implementation Plan

A standalone module has no event loop (nothing re-enters it after an export
returns) and no clock, and it may not import a host timer. The
`timer-capability-adapter.ts` / `standalone-timer-callback-bridge.ts` pair is
the JS-embedder side of a timer *capability import* — it needs an import the
zero-import lane forbids. So, per the #6659 (`crypto`) / #6664 precedent, the
standalone environment models an engine without the globals:

1. `src/codegen/standalone-timers.ts` (new): `isStandaloneUnavailableTimerGlobal`
   (`targetProfile.environment === "none"`, so WASI and JS host are untouched)
   and `tryStandaloneUnavailableTimerCall` — a call whose callee identifier is
   declared only in lib `.d.ts` files (via `ctx.oracle.declarationsOf`), not a
   sloppy implicit global and not runtime-eval-shadowable, throws
   `ReferenceError: <name> is not defined` before any argument is evaluated
   (§13.3.6.1 step 1).
2. `extern-declarations.ts`: skip the `env.<timer>` stub on standalone (same
   shape as the `structuredClone` skip).
3. `typeof-delete.ts` `ambientIdentifierIsUnavailable`: `typeof setTimeout`
   folds to `"undefined"`.
4. `calls.ts`: dispatched through `tryStandaloneHostFreeCall`
   (`expressions/standalone-dynamic-code.ts`), after the constant
   `Function(...)` compile-away.

## Resolution

- `tests/issue-6675-standalone-timers.test.ts`: parent 1 fail / 2 pass (the 2
  are controls: user-defined `setTimeout`, JS-host import retained); fix 3/3.
- lodash-es standaloneDynamic: see #6676 Resolution (lane measured with both).
- Scoped standalone test262 (311 rows incl. all timer / `atomicsHelper.js`
  files): identical before/after — see #6676. The 112 Atomics rows stay
  `compile_error` on `env::SharedArrayBuffer_new` + `env::__timer_set_timeout`
  (the harness's own `$262.agent` timer path via the import-resolver timer
  shim, a separate producer; not changed here).
- JS host unchanged (gate is `environment === "none"`).

Residual: a first-class read (`var t = setTimeout`) on standalone is not yet
a ReferenceError; no lane needs it.
