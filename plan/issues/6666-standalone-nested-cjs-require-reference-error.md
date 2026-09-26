---
id: 6666
title: "standalone: a CommonJS `require()` inside a function body is left unresolved — 'ReferenceError: require is not defined' at module init (jest, react-dom); the compiler-raised throw also renders as an opaque payload"
status: ready
sprint: Backlog
created: 2026-09-23
updated: 2026-09-23
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
related: [5384, 6456, 6661]
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
