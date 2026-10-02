---
id: 6666
title: "standalone: a CommonJS `require()` inside a function body is left unresolved — 'ReferenceError: require is not defined' at module init (jest, react-dom); the compiler-raised throw also renders as an opaque payload"
status: done
sprint: current
created: 2026-09-23
updated: 2026-09-28
completed: 2026-09-28
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
related: [5384, 6456, 6661, 6725, 6735]
---

# #6666 — nested CommonJS `require()` is not resolved in the standalone graph

## Problem

Found by [#6661](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6661-npm-compat-opaque-lane-diagnostic).
Both packages compile under `--target standalone` and then throw during
`__module_init`:

| package | standalone-dynamic lane (2026-09-23) |
| --- | --- |
| jest 30.4.2 | `runtime-error` at module-init: `uncaught Wasm-GC exception (non-stringifiable payload)` — decoded from the WAT it is the same `ReferenceError: require is not defined` |
| react-dom 19.2.6 | `runtime-error` at module-init: `ReferenceError: require is not defined` |

Both entries are bundler output that defers `require` into a lazy getter
(jest's `build/index.js`):

```js
function _jestConfig() {
  const data = require("jest-config");
  _jestConfig = function () { return data; };
  return data;
}
```

The top-level CommonJS rewrite resolves `const x = require("./m")`, but a
`require` inside a function body is left as a free identifier, which the
standalone backend lowers to `throw ReferenceError("require is not defined")`
(`$_jestConfig` in the WAT is exactly `global.get <"require is not defined">;
call <ReferenceError ctor>; throw 0`). The JS-host lane does not hit this
(same entry compiles and validates, 16,289 B).

Minimal repro (untyped two-file project, `compileProject(entry.mjs, { target: "standalone", allowJs: true })`):

```js
// dep.js
exports.value = 7;
// lib.js
"use strict";
function _dep() { const data = require("./dep.js"); _dep = function () { return data; }; return data; }
Object.defineProperty(exports, "value", { enumerable: true, get: function () { return _dep().value; } });
// entry.mjs
import lib from "./lib.js";
export function probe(n) { return lib.value + n; }
```

`probe(1)` throws a `WebAssembly.Exception`. Control: moving the `require` to
the top level of `lib.js` (`const data = require("./dep.js"); exports.value = data.value;`)
compiles and runs.

### Secondary: the throw is unrenderable

The module exports `__exn_tag` but not `__exn_render_prepare` /
`__exn_render_char`: #5384 keeps them only when the SOURCE contains a `throw`
statement (`ctx.usesSourceThrowStatement`). A compiler-synthesized throw (this
ReferenceError, and any other lowering that raises) does not set the flag, so
jest's lane reports `non-stringifiable payload` while react-dom (whose source
has a `throw`) renders the real text. The flag should also be set when codegen
emits a throw of its own.

## Acceptance criteria

- The repro above returns 8 under `--target standalone`.
- A standalone module whose only throw is compiler-synthesized exports the
  render pair, so the npm-compat lane shows the message instead of
  `non-stringifiable payload`.
- jest and react-dom standalone-dynamic lanes move past module init (next error,
  if any, recorded here).

## Implementation Plan (executed)

1. **Renderer (diagnosability).** `emitExceptionRenderExports`
   (`src/codegen/native-strings.ts`) now picks a flavor: the full
   `__any_to_string` renderer when the source has a `throw` or the host bridge is
   published (unchanged), else the lite body from `src/codegen/exn-render-lite.ts`
   — null → -1, `$Error_struct` → `__error_to_string` ("TypeError: msg"),
   native string → itself, anything else → 0 (harness keeps the label). It never
   reaches the number formatter, so #5384's 49 kB cascade does not return.
   `stripHostBridgeExports` keeps the `__exn_render_*` pair unconditionally (the
   emitter already chose).
2. **Harness.** `renderModuleInitThrow` (`scripts/generate-npm-compat-report.mjs`)
   now distinguishes "no render exports" from "payload is not an Error/string".
3. **jest mechanism** — split out as
   [#6725](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6725-standalone-nested-cjs-require-hoist):
   function-nested `require("Y")` is linked into the standalone graph.

## Resolution

Regression tests: `tests/issue-6725-standalone-nested-require.test.ts` (the
lite-renderer case and the jest-shaped repro), plus the updated export-surface
expectations in `tests/issue-4035-host-bridge-policy.test.ts` and
`tests/issue-3520-vec-support-callable-abi.test.ts`.

- Compiler-synthesized throws render: a null-guard read now reports
  `TypeError: Cannot access property on null or undefined at 1:46` (was the
  opaque label); jest's lane showed `ReferenceError: require is not defined`
  before the #6725 fix. Cost, measured 2026-09-28 at `-O3`: +183 B on
  `run(o:any){return o.x.y}` (53,938 → 54,121 B), +520 B on the untyped arith
  floor (6,150 → 6,670 B); clsx lane +183 B. A module whose tag is never armed
  (typed arith) is unchanged (37 B).
- react-dom standalone-dynamic: `require is not defined` → measured (813,880 B).
  jest: past module init, now a compile-time `import()` diagnostic
  ([#6735](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6735-standalone-async-dynamic-import-trap)).
- Residual (not fixed here): the literal repro above also references a bare
  `exports` that is never wrapped (no `exports.x` / `module.exports` access in
  `lib.js`), so it fails with `ReferenceError: exports is not defined` (parent:
  `TypeError: Object method called on null or undefined`). The regression test
  uses jest's real shape (webpack IIFE with a local `exports`) instead. Also
  observed on parent: a top-level `Object.defineProperty(exports, "value", { get })`
  after `exports.value = 0` overflows the stack when read (standalone).
