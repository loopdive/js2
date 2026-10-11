---
id: 6725
title: "standalone: a CommonJS `require(\"Y\")` nested in a function body never enters the compileProject graph — jest's lazy getters throw `require is not defined` at module init"
status: done
sprint: current
created: 2026-09-28
updated: 2026-09-28
completed: 2026-09-28
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
language_feature: commonjs
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6666, 6663, 1279, 3509, 3494, 6735]
---

# #6725 — function-nested `require()` is not linked in the standalone graph

## What you saw

npm-compat **jest** 30.4.2, standalone-dynamic lane (2026-09-28, upstream
`2e23e49fb1`):

    runtime-error @ module-init: uncaught Wasm-GC exception (non-stringifiable
    payload): raised by compiler-generated code (the module has no source throw,
    so no __exn_render_* exports; see #6666)

With #6666's renderer half applied the payload reads
`ReferenceError: require is not defined`.

## Mechanism

jest's `build/index.mjs` is `import cjsModule from './index.js'` followed by
`export const run = cjsModule.run;` etc. — every read runs a getter defined by
the webpack bundle in `build/index.js`:

```js
Object.defineProperty(exports, "run", { enumerable: true, get: function () { return _jestCli().run; } });
function _jestCli() {
  const data = require("jest-cli");
  _jestCli = function () { return data; };
  return data;
}
```

`rewriteCjsRequire` (#1279) links only TOP-LEVEL `const X = require("Y")`; the
resolver's dependency scan (`resolveAllImports`) looks only at top-level
variable statements. So `jest-cli`, `@jest/core` and `jest-config` never enter
the graph, `require` stays a free identifier, and the standalone backend lowers
it to `throw ReferenceError("require is not defined")`. The ESM wrapper calls
the getters while initializing, hence module-init.

A Wasm module cannot load code lazily, so the only honest lowering is to link
the edge statically.

## Implementation Plan (executed)

1. `src/cjs-standalone-nested-require.ts` — `hoistStandaloneNestedRequires(source, canResolve)`:
   for each `require(<string literal>)` call nested in a function-like body,
   overwrite the call text with `__cjs_nreqN` (space-padded, newlines kept — every
   position is preserved, like #6663's fold) and append
   `const __cjs_nreqN = require("Y");` after the last byte. The existing CJS
   rewrite turns that into `import __cjs_nreqN from "Y"` (hoisted by ESM
   semantics), and the nested read becomes a read of the live import binding.
   Declines (source untouched): a file that declares a binding named `require`
   anywhere (AMD `define(function (require) …)`, shims); a call inside any `try`
   block (optional-dependency idiom); a Node builtin; an unresolvable specifier
   (a lazy edge that cannot be linked stays lazy rather than failing the compile).
2. `src/resolve.ts` — the resolver's standalone `foldSource` (#6563/#6663) now
   takes the file path and composes the hoist after the `process.env` fold, with
   `canResolve = (s) => this.resolve(s, filePath) !== null`. JS-host (`gc`)
   compiles are untouched (`foldSource` stays the identity there).
3. Regression test `tests/issue-6725-standalone-nested-require.test.ts`.

Accepted semantic cost: a hoisted dependency now initializes before the
requiring module instead of on first call (eager instead of lazy).

## Measurements

Regression test, parent (`2e23e49fb1`) vs fix: parent 2 failed / 2 passed
(repro renders `uncaught Wasm-GC exception (non-stringifiable payload)`; the
#6666 render test fails the same way); fix 4 / 4 passed.

standalone-dynamic lane, same box, parent vs fix:

| package | parent | fix |
| --- | --- | --- |
| jest | runtime-error @ module-init, opaque payload (`require is not defined`), 198,986 B | compile-error: `Standalone dynamic import is unsupported until compileMulti provides internal module records and namespace objects` |
| react-dom | runtime-error @ module-init `ReferenceError: require is not defined` (committed report) | **measured**, 813,880 B |
| lodash-es | optimization-error (wasm-opt -O4 Flatten.cpp:231 abort) | runtime-error @ module-init `TypeError: Cannot access property on null or undefined at 10:22` |
| clsx | measured 70,163 B | measured 70,346 B (+183 B, #6666 lite renderer) |
| jsdom, three | compile-error (same diagnostic both) | unchanged |

uuid, acorn, cookie, lodash, react, axios, marked, hono, redux, moment,
styled-components, prettier, tailwindcss, stylelint, eslint: same status and
(where measured) the same byte count as the committed report.

## Next blocker (jest)

`Standalone dynamic import is unsupported until compileMulti provides internal
module records and namespace objects` — three `await import(...)` sites inside
async functions, now reachable because the graph is linked:
`jest-util/build/index.js:1045` (`importModule`) and
`jest-config/build/index.js:2426,2437` (`registerTsLoader`). #3509 traps
`import()` at run time only in non-async function bodies, because a standalone
async function does not turn a synchronous throw into a rejection (measured:
`async function f(){ await g(); }` with a throwing `g` escapes `f(1)`
synchronously). Filed as
[#6735](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6735-standalone-async-dynamic-import-trap).

## Resolution

Fixed as planned. react-dom's standalone-dynamic lane moves from module-init
`require is not defined` to measured; jest links its whole graph and now stops
at the #6735 compile-time `import()` diagnostic.
