---
id: 6664
title: "standalone: lib.dom-only globals with no Wasm provider (performance, MessageChannel, window.ErrorEvent, queueMicrotask via a parameter) still emit env:: host imports"
status: done
sprint: current
created: 2026-09-23
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
related: [6663, 5351, 2907, 1662, 3958, 6671, 3930]
loc-budget-allow:
  # 2026-09-24 (#6664): each god-file gains only a 2-5 line call (plus one
  # import) into the two new satellites that hold the mechanism —
  # standalone-unavailable-globals.ts (typeof/read/new/performance.now and
  # the extern-class skip) and expressions/standalone-queue-microtask.ts. The
  # hooks must sit at the dispatch points they gate: the identifier read arm,
  # the top of `new`, the namespace-static call arm, the lib extern-class and
  # `declare function` scans, and the typeof fold.
  - src/codegen/expressions/new-super.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/extern-declarations.ts
  - src/codegen/typeof-delete.ts
  - src/codegen/expressions/calls.ts
func-budget-allow:
  # 2026-09-24 (#6664): +5/+6 lines — one guarded call into the satellite at
  # the head of `new` evaluation (the ReferenceError must precede argument
  # evaluation), before the declared-globals read arm, and beside the WASI
  # `performance.now()` arm it mirrors.
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
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

## Implementation Plan

Executed 2026-09-24. Decided per global, Wasm-natively, no new host import:

1. **`MessageChannel` / `MessagePort` / `ErrorEvent` — unavailable.** A
   standalone module has no event loop, so a port has nothing to deliver to.
   React's `enqueueTask` fallback does not branch on the global (it warns when
   `typeof MessageChannel === "undefined"`, then does `new MessageChannel()`
   unconditionally), so a same-tick port would only fake an event loop. The
   honest lowering is an engine without the global:
   - `src/codegen/standalone-unavailable-globals.ts` (new) owns the name set
     and the predicate (ambient binding only, via `resolvesToAmbientGlobal`;
     not in a linked standalone module, whose realm may have it).
   - `extern-declarations.ts` `collectExternFromDeclareVar`: the three
     classes and `Performance` are not registered as extern classes under
     standalone, so no member or constructor becomes an `env::` import.
   - `typeof-delete.ts` `ambientIdentifierIsUnavailable`: `typeof` folds to
     `"undefined"`.
   - `identifiers.ts` (before the declared-globals arm) and `new-super.ts`
     (head of `compileNewExpression`, before any argument): evaluating the
     reference throws `ReferenceError: <name> is not defined`.
2. **`performance.now()` — the time origin.** Standalone `Date.now()` is the
   epoch `0` when no clock capability is certified (#2164), so
   `performance.now()` returns `0` too: monotonic non-decreasing,
   deterministic, and react's lazy `_ioInfo` timing keeps running
   (`call-namespace-static.ts`, beside the WASI `clock_time_get` arm).
3. **`queueMicrotask(cb)` — the module's own microtask queue.** The
   standalone lowering had no queueMicrotask arm at all (a literal callback
   leaked `env.queueMicrotask` too). `expressions/standalone-queue-microtask.ts`
   (new) enqueues the callback VALUE on the native queue Promise reactions use
   (drained by the exported `__drain_microtasks`) through one shared job,
   `__queue_microtask_dyn`, that calls it via `__apply_closure` with
   `this = undefined` and no arguments. No argument is a TypeError (WebIDL);
   the lib `declare function queueMicrotask` stub is no longer registered as
   an import under standalone.

## Resolution

- Regression test `tests/issue-6664-standalone-dom-globals.test.ts` (two-file
  untyped `.js` fixtures): parent **4 failed / 1 passed**, fix **5 / 5**. The
  passing-both-ways row is the anti-vacuity control (user `class
  MessageChannel` / user `performance` object keep their own semantics).
- npm-compat standalone-dynamic lane
  (`generate-npm-compat-report.mjs --only <pkg> --no-write --perf-only --lane standalone-dynamic --inspect-imports`),
  measured 2026-09-24 on the same checkout, parent vs fix:

  | package | parent | fix |
  | --- | --- | --- |
  | react (-O4) | host-import-error, 6 imports (`Performance_now`, `MessageChannel_new`, `MessageChannel_get_port1/2`, `MessagePort_set_onmessage`, `MessagePort_postMessage`), 476,517 B | runtime-error @ module-init, `TypeError: Cannot access property on null or undefined at 698:20`, 0 imports, 476,020 B |
  | react (-O0, lane constant flipped locally) | host-import-error, 8 imports (the 6 above + `queueMicrotask`, `ErrorEvent_new`), 982,333 B | runtime-error @ module-init, same TypeError, 0 imports, 977,304 B |
  | react-dom | runtime-error @ module-init, `ReferenceError: require is not defined`, 414,292 B | unchanged (identical bytes) |

  React's next blocker is not a host import: `console` reads as `null` in a
  standalone module, so react's module-init feature test
  `createTask = console.createTask ? … : …` (react.development.js:695)
  throws — filed as
  [#6671](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6671-standalone-console-value-read-null).
  react-dom's `require("react")` inside its dev-build IIFE is
  [#3930](https://js2wasm.loopdive.com/dashboard/issue.html?slug=3930-compileproject-nested-require-dropped-from-graph).
- Scoped STANDALONE test262 (`scripts/run-test262-paths.mts --standalone`,
  131 rows: `language/expressions/typeof`, `language/expressions/new`,
  `language/identifier-resolution`, `language/global-code`): parent
  **109 pass / 22 fail**, fix **109 / 22**, identical non-pass set. No test262
  file references any of the gated names.
- JS-host and WASI output are byte-identical (sha256 of `target: "gc"` and
  `"wasi"` compiles of the MessageChannel/performance/queueMicrotask fixture
  and of react.development.js, parent vs fix). Everything is gated on
  `ctx.standalone`.

## Residuals

- `document`/`window`/`navigator` (the pre-existing `HOST_ONLY_AMBIENT_GLOBALS`)
  still fold `typeof` to `"undefined"` but READ as `null` instead of throwing
  `ReferenceError`; only the three names above throw. Unifying them is a
  behaviour change for the #4576 standalone DOM capability and was left out.
- `performance` itself is not modelled: only `performance.now()` is lowered;
  `performance.mark(...)` etc. read the `null` global and throw TypeError.
  With a certified clock capability, `Date.now()` advances but
  `performance.now()` stays `0`.
- A queued callback that throws propagates out of `__drain_microtasks`
  (HTML reports it and keeps draining) — same as the existing timer wrapper.
  A non-callable argument is rejected when the job runs, not at the call.
- `tests/dogfood/react-upstream-suite.mjs` exits 0 without its headline on
  this box on parent and fix alike (log stops after extraction), so the
  "139/180" control could not be re-read; the byte-identical JS-host compile
  above stands in for it.
