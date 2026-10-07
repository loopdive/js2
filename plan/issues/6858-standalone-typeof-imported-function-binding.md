---
id: 6858
title: "standalone: typeof of an imported function binding is not \"function\""
status: ready
sprint: current
created: 2026-10-05
updated: 2026-10-05
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
language_feature: typeof
goal: standalone
requested_by: ttraenkler/wave9-styled-hostimports
related: [6841]
---

# #6858 — `typeof importedFn === "function"` is false under `--target standalone`

## What you will see

Found while writing the
[#6841](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6841-standalone-browser-dom-globals-host-imports)
regression test, on upstream/main `b6324ee6d1` (reproduces with and without
#6841's change):

```js
// sheet.js
export function css(strings) { return strings.join(""); }
// main.js
import { css } from "./sheet.js";
const ns = { css };
export function direct() { return typeof css === "function" ? 1 : 0; }    // 0 — WRONG
export function viaObj() { return typeof ns.css === "function" ? 1 : 0; } // 1
```

`compileProject(main.js, { allowJs: true, skipSemanticDiagnostics: true, target: "standalone" })`,
instantiated with `{}`. The same function stored in an object answers
`"function"`, so the value is a real closure; only the `typeof` of the bare
imported binding folds wrong. The npm-compat perf driver for styled-components
uses `typeof __pkgNs.css` and is not affected.

## Implementation Plan

1. Find which `typeof` arm answers for an imported-binding identifier in
   `src/codegen/typeof-delete.ts` (static fold from the checker type vs. the
   runtime tag). An `allowJs` import of a `function` declaration should fold
   to `"function"` statically, or read the runtime value's tag.
2. Check the JS-host lane for the same fixture before changing anything; keep
   it byte-identical if it is already right.
3. Regression test: the fixture above plus a re-exported (`export { f as g }`)
   and a default-exported function; anti-vacuity control with an imported
   non-function (`export const n = 1` → `"number"`).
