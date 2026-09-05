---
id: 5321
title: "Module namespace object over a host-imported re-export reads back null"
status: done
sprint: current
created: 2026-09-05
updated: 2026-09-05
completed: 2026-09-05
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

Prettier's `#universal/assert` is literally

```js
export { equal, ok, strictEqual } from "node:assert";
```

and 15 of its source files open with `import * as assert from "#universal/assert"`.
`createTypeCheckFunction` calls `assert.equal(...)` while building module-scope
constants, so six of prettier's unit files died at **module init** with
`TypeError: equal is not a function` before a single test ran — 70 tests in
`doc-builders` (46), `is-empty-doc` (16), `print-doc-to-string` (3),
`strip-trailing-hardline` (2), `traverse-doc` (2) and `doc-printer` (1).

## Root cause — two defects, not one

The brief hypothesised a single defect ("a namespace object whose exports
include a host-imported binding comes back null"). Measurement found **two**,
stacked, and the prettier symptom is produced by the FIRST one:

**D1 — `#universal/assert` did not resolve at all.** `ModuleResolver`
(`src/resolve.ts`) pins `ts.ModuleResolutionKind.Node10`, which predates the
package.json `imports` field, so a `#`-specifier resolved to `null`,
`resolveAllImports` silently dropped the edge, and the file never entered the
graph. `getExportsOfModule` then reported an **empty** module, and
`namespaceFunctionExports`' deliberate "an empty module still has a real
namespace object" arm materialised an **empty object**. `assert.equal` was
`undefined` → `__extern_method_call` threw `equal is not a function`. Instrumented
proof: `[ns] module unknown decls  exports:` on the prettier graph.

**D2 — the namespace declines when an export re-exports a Node builtin.** Once
D1 is fixed, every export of `assert.js` is an alias whose target resolves to
the `unknown` symbol (there is no `@types/node` in these programs), so it has no
declaration, is not a compiled `FunctionDeclaration`, and is not an
`export const`. `namespaceFunctionExports` therefore declined the WHOLE object
and the binding fell back to the identifier path, which yields `ref.null`. The
error moves to `Cannot read properties of null (reading 'equal')` — which is
exactly the symptom the brief's synthetic control reproduced (that control used
a *relative* re-export, so it never hit D1).

## Fix

Both parts are contained; no new mechanism was needed.

**D1 — `src/resolve.ts`.** Resolve package-`imports` (`#…`) specifiers directly:
find the nearest enclosing `package.json` (Node's LOOKUP_PACKAGE_SCOPE), match
the specifier against its `imports` map (exact key first, then the single-`*`
pattern key with the longest matching prefix), walk conditions, and probe the
target with the existing `probeImplementationPath`. On a miss it **falls
through** to ordinary resolution, so a tsconfig `paths` entry spelled `#*` still
wins and the change is strictly additive (today those edges resolve to null).

Conditions are `["node", "import", "default"]` — Node's ESM order, deliberately
*not* `browser`. The dogfood harness compares a Wasm run against a **native Node**
run of the same graph; taking prettier's `browser` branch would have resolved
`#universal/assert` to `../utilities/noop.js` and made every prettier assertion
a silent no-op in the Wasm lane only. That would have "fixed" the 70 tests by
deleting their assertions.

**D2 — `src/codegen/module-namespace-value.ts`.** A third export kind,
`host-member`, alongside `function` and `global`. It reuses the carrier
`registerNodeBuiltinImports` already gives a direct named import
(`extern-declarations.ts`: `declaredGlobals.set(member, { funcIdx, member })`
→ `__extern_get(__node_<mod>(), member)`), so the slot holds the host module's
own property — the real callable, not a copy. Detection is syntactic
(`export { x } from "node:assert"`, and the two-step `import { x } from
"node:assert"; export { x }`), because with the alias resolving to `unknown`
there is nothing to ask the checker; that also keeps the oracle ratchet at +0.
Declined under `ctx.wasi`, where Node builtins are unavailable.

The `__extern_get` / `__node_<mod>` imports are reserved in the **same
`ensureLateImport` batch** as `__new_plain_object`/`__extern_set`, before the
single `flushLateImportShifts` — a later reservation would shift the
defined-function index space under instructions already emitted into the getter.

## Evidence

Reduced with a standalone `compileAndRunUpstreamModule` probe (not vitest +
`instantiateWithRuntime`), with a deliberately-false control confirming the
harness reports `native=0/1` rather than passing vacuously.

| probe | base | fix |
| --- | --- | --- |
| `0` deliberately-false assertion (sanity) | `native=0/1 wasm=0/1` | `native=0/1 wasm=0/1` |
| `1` `import { equal } from "node:assert"` | `1/1 · 1/1` | `1/1 · 1/1` |
| `2` namespace of a module exporting a LOCAL fn | `1/1 · 1/1` | `1/1 · 1/1` |
| `3` namespace of `export {…} from "node:assert"` | `1/1 · 0/0` `Cannot read properties of null` | `1/1 · 1/1` |
| `4` namespace of a mixed local + host module | `1/1 · 0/1` | `1/1 · 1/1` |
| `5` prettier-exact: `createTypeCheckFunction` | `1/1 · 0/0` `module init: TypeError: equal is not a function` | `1/1 · 1/1` |

prettier upstream suite: **51/151 → 61/151**. Every `module init: TypeError:
equal is not a function` is gone; `strip-trailing-hardline` 0→2,
`is-empty-doc` 0→7, `traverse-doc` 0→1, and the rest now reach real,
diagnosable failures instead of a module-init wall.

**A/B over the 17-package upstream corpus at one head** (`bfe0158e49`), both
passes run sequentially against a frozen tree, all 34 runs exit 0. Only prettier
moves; every other package is byte-identical per test file:

```
webpack 16/16 · three 17/18 · clsx 32/32 · cookie 63740/63740 · lodash 53/62
redux 60/82 · axios 191/231 · stylelint 108/108 · tailwindcss 13/13 · jsdom 6/6
styled-components 9/9 · uuid 75/75* · marked 2/30 · moment 4/10 · jest 299/358
hono 37/52*                                        (* scored per file — these
                                                      two never print `admitted`)
prettier 51/151 -> 61/151
  tests/unit/is-empty-doc.js          0/16 -> 7/16
  tests/unit/strip-trailing-hardline.js 0/2 -> 2/2
  tests/unit/traverse-doc.js            0/2 -> 1/2
```

Regression test `tests/issue-5321-namespace-host-reexport.test.ts` — a
untyped-`.js` project (`package.json` + `universal/assert.js` +
`two-step-assert.js` + three consumers) covering the relative route, the
`#universal/*` route, and the two-step `import` + bare `export`. Parent:
**0 passed / 3 failed** (relative and two-step → Wasm trap; mapped →
`'undefined:threw:throws'`). With the fix: **3 passed / 0 failed**. Untyped
fixtures are load-bearing —
annotating the namespace `: any` routes the member access through the dynamic
property path and the test then passes either way.

## Known remaining gaps (not this change)

- **A NAMED import through a Node-builtin re-export is a silent no-op.**
  `import { equal } from "./host-assert.js"` where `host-assert.js` is
  `export { equal } from "node:assert"` compiles the call to
  `f64.const 1; drop; … ref.null extern; drop` — no call, no error. Same root
  cause, different lowering path (identifier resolution rather than the
  namespace object). Deliberately out of scope here: it would need
  `collectGraphNodeBuiltinImports` to admit `ExportDeclaration`s, which
  publishes the names into the flat module-wide `declaredGlobals` map and needs
  its own corpus measurement.
- **prettier `doc-builders` (46 tests) now fails at `__closure_374`
  (`dereferencing a null pointer`) inside the test file's own `describe`
  callback**, and `print-doc-to-string` (3) at `illegal cast` in
  `printDocToString`. Both are unrelated defects that were simply unreachable
  behind the module-init wall.
