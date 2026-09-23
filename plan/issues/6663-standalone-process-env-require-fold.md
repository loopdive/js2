---
id: 6663
title: "standalone: react's `if (process.env.NODE_ENV …) module.exports = require(…)` entry is never linked — module init throws `require is not defined`"
status: done
sprint: current
created: 2026-09-23
updated: 2026-09-23
completed: 2026-09-23
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
language_feature: commonjs
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [3930, 1043, 1279, 3958, 6664]
---

# #6663 — the NODE_ENV build selector never enters the standalone graph

## What you saw

npm-compat **react**, standalone-dynamic lane:
`runtime-error` at `module-init`, diagnostic
`uncaught Wasm-GC exception (non-stringifiable payload)`. The binary had 0
imports and was only ~160 KB — react itself was not in it.

## Mechanism

react's package entry is

```js
'use strict';
if (process.env.NODE_ENV === 'production') {
  module.exports = require('./cjs/react.production.js');
} else {
  module.exports = require('./cjs/react.development.js');
}
```

`rewriteCjsRequire` (#1279) and the `resolveAllImports` dependency scan only
see *top-level* `X = require(...)` / single `module.exports = require(...)`
statements. Both requires here sit inside an `if`, so neither file entered the
`compileProject` graph. The compile reported success, and module init then
called the unbound global `require`: `ReferenceError: require is not defined`
(the payload rendered opaquely because the entry had no `throw` statement, so
the `__exn_render_*` exports were stripped). On the JS host the same code
works only because the host import resolves `require` to Node's own at run
time — react is never compiled there either.

Reduced two-file fixture (`main.mjs` → `lib.js` → `a.js`/`b.js`):

```js
// lib.js
'use strict';
if (process.env.NODE_ENV === 'production') { module.exports = require('./a.js'); }
else { module.exports = require('./b.js'); }
```

standalone: `ReferenceError: require is not defined` at init (parent).

## Implementation Plan (executed)

Standalone already fixes the value of every `process.env` read: codegen lowers
`process.env` to a fresh empty object (`property-access-dispatch.ts`,
`__new_plain_object`), so `process.env.NODE_ENV` is `undefined` at run time,
deterministically. The resolver can therefore decide the selector statically:

1. New `src/cjs-standalone-env-fold.ts` —
   `foldStandaloneProcessEnvBranches(source, define?)`. For each **top-level**
   `if` whose condition combines only `process.env.NAME` /
   `process.env["NAME"]` reads and string literals (`===`, `!==`, `==`, `!=`,
   `!`, `&&`, `||`, parens), evaluate it with the standalone value (or a
   string-literal `define` entry for that key) and keep only the taken arm
   (recursing into `else if`). Removed text is overwritten with spaces and
   newlines are kept, so every position is unchanged (no PositionMap).
   Declines: the file binds `process`; the dropped arm declares a `var` or a
   function; a kept block with a lexical declaration keeps its braces.
2. `src/resolve.ts` — `ModuleResolver.foldSource` applies the fold to every
   file as it is read (both the classic and consumer-driven walks), before the
   CJS rewrite and the dependency scan. Identity unless
   `options.target === "standalone"`, so JS-host / WASI output is unchanged.
3. The kept `module.exports = require('./cjs/react.development.js')` is now a
   single top-level assignment; the existing CJS rewrite links it statically.

## Resolution

- Regression test `tests/issue-6663-standalone-process-env-require-fold.test.ts`:
  parent **4 failed / 3 passed** (the 4 standalone compile+run cases throw
  `require is not defined`; the 3 pure unit tests of the new module pass
  trivially), fix **7 / 7**.
- npm-compat standalone-dynamic lane, measured locally with
  `generate-npm-compat-report.mjs --only <pkg> --no-write --perf-only --lane standalone-dynamic`
  (see the PR body for the full per-package table): react
  `runtime-error (module-init, require is not defined)` →
  `host-import-error (6 imports)`. React's development build is now in the
  binary (~160 KB → ~480 KB); the remaining imports are browser APIs with no
  standalone provider, filed as
  [#6664](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6664-standalone-unavailable-dom-globals-host-imports).
- test262 is unaffected by construction: the runner and worker compile single
  sources and never construct a `ModuleResolver`.

## Residuals

- Requires nested in functions / IIFEs are still dropped from the graph —
  [#3930](https://js2wasm.loopdive.com/dashboard/issue.html?slug=3930-compileproject-nested-require-dropped-from-graph).
  react-dom's development build hits exactly this after the fold
  (`"production" !== process.env.NODE_ENV && (function () { var React = require("react"); … })()`).
- A named import of a CommonJS export (`import { version } from "./cjs.js"`
  where the file does `exports.version = …`) yields a non-string on both gc and
  standalone; the default import is correct.
