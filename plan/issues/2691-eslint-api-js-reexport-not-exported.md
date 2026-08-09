---
id: 2691
title: "ESLint api.js: re-export 'ESLint' declared locally but not exported (compile error)"
status: blocked
created: 2026-06-26
updated: 2026-07-26
priority: low
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: module-resolution
language_feature: commonjs-reexports
goal: npm-library-support
sprint: Backlog
depends_on: [1575, 3654, 3655, 3656]
es_edition: n/a
related: [1400, 1573, 1791, 1792, 1793, 1794, 2693, 3653, 3657]
---
# ESLint api.js — re-export resolution: 'ESLint' declared locally but not exported

## 2026-07-26 refresh — cascade now also hides `Linter`

The cascade diagnosis remains correct, but the old statement that ESLint's npm
dependencies are not installed is false in the current checkout. They are
installed by the committed ESLint dependency:

- `eslint-scope`, `eslint-visitor-keys`, `@eslint/plugin-kit`, `debug`,
  `espree`, and `esquery` resolve from ESLint's importer context;
- `@eslint/core` is installed as a types-only package.

The compiler nonetheless reports those modules as missing in the direct
`linter.js` graph, together with existing relative modules. That resolver
frontier is #3654; static `require("../../package.json")` is #3655.

The bare-package probe now starts with:

```text
Module '"eslint"' has no exported member 'Linter'.
```

This is the same cascade class as the issue's original missing `ESLint`
diagnostic, not evidence that the reduced CJS re-export implementation in
#1560 regressed. The graph's target modules fail first.

Two fatal `undefined.kind` diagnostics at lines 240 and 562 also remain.
The diagnostics do not carry a source-file path, so do **not** label them as
`api.js` line numbers or merge them as one root cause without source-qualified
instrumentation and minimization. #1400 owns the integration re-measure.

> **INVESTIGATED 2026-06-26 — SUBSTRATE-GATED, do not grind.** The
> "ESLint not exported" TS2459 is a **cascade symptom**, NOT a module-resolution
> bug. `api.js` does `const { ESLint } = require("./eslint/eslint")`; the target
> `eslint/lib/eslint/eslint.js` itself **fails to compile**, so the TS checker
> sees no exports on it and reports the re-export as unresolved. The minimal
> CJS re-export shape (`class Foo {}; module.exports = { Foo }` re-exported
> through a second module) compiles + validates fine — so the resolver/CJS
> interop is NOT broken.
>
> `eslint.js` (the **ESLint CLI class**, 1359 lines) fails on a large Node-builtin
> surface that is out of scope here:
> ```
> Cannot find module 'node:fs'            (untracked)
> Cannot find module 'node:fs/promises'   (untracked)
> Cannot find module 'node:os'            (untracked)
> Cannot find module 'node:path'          (#1791)
> Cannot find module 'node:url'           (#1792)
> Cannot find module 'node:worker_threads'(untracked)
> Cannot find module '../../package.json' (JSON import — untracked)
> Module '"../config/default-config"' has no exported member 'defaultConfig'
> Module '"linter/timing"' has no default export
> Module '"./eslint-helpers"' declares 'createDebug' locally, but it is not exported
> ```
> Plus two codegen crashes (`Internal error compiling expression: Cannot read
> properties of undefined (reading 'kind')` at api.js L240 / L562).
>
> **Not on the minimal-`Linter.verify` critical path.** `api.js` re-exports the
> heavy **ESLint** CLI class (fs / os / worker_threads / fs-promises), whereas a
> runnable `Linter.verify` only needs `Linter` (linter.js — whose sole `node:`
> import is `node:path`, #1791). So api.js is the FULL-eslint-CLI endgame, gated
> on the whole Node-builtin dependency tree, not a near-term win.
>
> **Blocked on:** node:fs, node:fs/promises, node:os, node:worker_threads (NONE
> individually tracked — only node:path #1791 / node:url #1792 / node:buffer
> #1793 / node:events #1794 have impl issues; see the survey #1575), JSON
> `require("*.json")` import support, and the eslint-internal export mismatches
> above. Defer until the node-builtin substrate (#1575 fan-out) lands. The two
> `undefined.kind` codegen crashes (api.js L240/L562) are worth a separate
> narrow issue if they reproduce on a node-builtin-independent input.

Carved from the de-staled #1573 ESLint survey. Unlike the other residuals this
is a **compile error** (not a validation failure) — it fails earlier in the
pipeline, in module resolution.

## Reproducer
```ts
import { compileProject } from "./src/index.js";
const r = await compileProject("/workspace/node_modules/eslint/lib/api.js", { allowJs: true });
// r.success === false
// r.errors[0].message === "Module '\"./eslint/eslint\"' declares 'ESLint' locally, but it is not exported."
```

## Error (current main, eslint 10.0.3)
```
Module '"./eslint/eslint"' declares 'ESLint' locally, but it is not exported.
```

`api.js` is the public re-export bundle. It re-exports `ESLint` from
`./eslint/eslint`, but the compiler's module-resolution / re-export handling
does not see `ESLint` as exported from that module (likely a CJS
`module.exports` / `Object.defineProperty(exports, ...)` shape, or a re-export
form the resolver doesn't follow).

## Fix direction
Investigate how `eslint/lib/eslint/eslint.js` exports `ESLint` (CJS
`module.exports = { ESLint }` vs `Object.defineProperty`/getter) and why the
re-export in `api.js` doesn't resolve it. Module resolver + CJS interop in
`src/` (ModuleResolver / `resolveAllImports` / CJS export detection in
`src/codegen/declarations.ts`).

## Bug class
MODULE RESOLUTION / CJS interop — re-export of a CJS-exported binding.
