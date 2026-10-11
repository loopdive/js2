---
id: 6855
title: "standalone: styled-components module init throws TypeError: called value is not a function"
status: ready
sprint: current
created: 2026-10-05
updated: 2026-10-05
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
language_feature: calls
goal: standalone
requested_by: ttraenkler/wave9-styled-hostimports
related: [6841]
---

# #6855 — styled-components standalone-dynamic: module init throws `TypeError`

## What you will see

After [#6841](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6841-standalone-browser-dom-globals-host-imports)
removed the 12 lib.dom host imports, the styled-components standalone-dynamic
lane compiles to a zero-import binary (1.86 MB optimized) and then fails at
instantiation time:

```
npx tsx scripts/generate-npm-compat-report.mjs --only styled-components --no-write --perf-only --lane standalone-dynamic
standaloneDynamic: runtime-error, phase module-init — "TypeError: called value is not a function"
  moduleImportCount 0, binaryBytes 1853070
```

Same verdict on the unoptimized binary (2.51 MB), so it is a codegen issue,
not an optimizer one. The error object is in-module; read it with
`e.getArg(exports.__exn_tag, 0)` and `__exn_render_prepare` /
`__exn_render_char` (see `tests/v8x-tla-graph.test.ts` `renderGraphValue`).

## What is already ruled out

- React's default import: `import t from "react"; t.createContext(5)` at
  module scope runs fine standalone (driver probe, 0 imports).
- `_t.forEach(e => { Tt[e] = kt(e) })` (properties on an arrow, `jt` closure
  factory) runs fine as a reduced fixture.
- The DOM / `navigator` / `window` reads: those throw `ReferenceError`, not
  `TypeError`, and are guarded by `typeof` at module scope.

## Remaining module-scope calls to bisect

From the top-level statements of `dist/styled-components.esm.js` 6.4.4:
`f("REACT_APP_SC_DISABLE_SPEEDY")` (process.env reads), `z(u)` (hash),
`new je` + `nt()` (stylis instance: `o.compile`, `o.serialize`,
`o.middleware`, `o.stringify` through `import * as o from "stylis"`),
`me(() => new Set)`, `Symbol.for(...)`, `new RegExp(...)` in the `ye` class
field, and the `@emotion/is-prop-valid` default import.

## Implementation Plan

1. Bisect the module-scope statements with a generated, truncated copy of
   the package entry (keep every `FunctionDeclaration`, replace later
   `const`/`let` statements with bare declarations). Caveat found while doing
   this: re-pointing the bare imports to absolute paths changes which
   `stylis` entry resolves — use the package's `exports.import`
   (`stylis/index.js`) or the harness diverges (RegExp compile errors with
   `dist/stylis.mjs`).
2. Reduce the failing statement to a fixture and fix the call lowering in
   standalone; add a regression test under `tests/`.
3. Re-measure the lane and report the next blocker.

Note for the lane measurement: on a loaded box the `--skip-pass=flatten`
retry inside `src/optimize.ts` can hit its 600 s timeout and the lane reads
`optimization-error`; that is load, not a regression (82 s CPU, 15 min wall
at 9 % CPU when measured on 2026-10-05).
