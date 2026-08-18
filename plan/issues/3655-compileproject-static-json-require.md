---
horizon: m
id: 3655
title: "compileProject allowJs: support static CommonJS require of JSON modules"
status: done
created: 2026-07-26
updated: 2026-08-18
completed: 2026-07-31
priority: critical
feasibility: medium
reasoning_effort: high
task_type: feature
area: resolver, codegen
language_feature: json-modules
goal: npm-library-support
sprint: 78
required_by: [1400, 2691]
es_edition: n/a
related: [1279, 1400, 1575, 2691, 2693, 3654]
---

# #3655 — Static `require("./file.json")` in project graphs

## Problem

ESLint's real Linter reads its own version:

```js
const pkg = require("../../package.json");
```

`compileProject("node_modules/eslint/lib/linter/linter.js",
{ allowJs: true })` reports:

```text
Cannot find module '../../package.json' or its corresponding type declarations.
```

The file exists. Static CommonJS JSON modules are a separate resolver/codegen
surface from `JSON.parse` and from JavaScript module resolution.

## Scope

Support compile-time-known `require("./relative.json")` within a
`compileProject` graph:

1. resolve the JSON path relative to the importer;
2. parse it at compile time;
3. materialize its JSON value as the CommonJS module value;
4. preserve strings, numbers, booleans, null, arrays, and object properties;
5. report malformed or missing JSON with a source-qualified diagnostic.

Dynamic `require(expr)`, import assertions/attributes, cache invalidation, and
arbitrary filesystem access at Wasm runtime are out of scope.

## Implementation (2026-07-26)

The project resolver now recognizes relative specifiers ending in `.json`
before TypeScript's script-only resolver:

1. resolve and canonicalize the JSON path relative to the physical importer;
2. read and parse the file during graph expansion;
3. synthesize a uniquely named JavaScript module whose default export is the
   parsed JSON literal;
4. retain the exact importer/specifier/module edge through the same virtual
   checker map introduced by #3654;
5. stop before checking/codegen with a source-qualified diagnostic when the
   file is missing or malformed.

The Wasm module receives only the materialized value. It imports no runtime
filesystem capability for the static JSON edge.

Reduced runtime coverage verifies nested objects, arrays, strings, numbers,
booleans, and null by value. The real ESLint resolver/checker probe now walks
146 canonical files, contains ESLint's `package.json` module, and reports
neither a resolver diagnostic nor entry-file TS2307 for
`require("../../package.json")`.

## Acceptance criteria

- A reduced JS project can `require("./package.json")` and read `.name`,
  `.version`, nested objects, and arrays.
- ESLint's `require("../../package.json")` no longer produces TS2307.
- JSON booleans and null retain their JavaScript types across compiled reads.
- The compiler does not emit a runtime filesystem import for a static JSON
  module.
- Missing and malformed JSON fail with the importer path, JSON path, and a
  clear diagnostic.
- `tests/issue-3655.test.ts` permanently covers the reduced static-JSON
  CommonJS project, including nested values and diagnostic cases.
- Existing JavaScript/TypeScript/CJS project-resolution tests remain green.

## Verification (2026-07-31, measured against current `main` `af7d6f87`)

### Pre-fix repro — compile-green, runtime-broken

A reduced `require("./pkg.json")` project on stock `main` reports
`success: true` with **zero errors and zero warnings**, `WebAssembly.validate`
**true** — and the exported accessor **throws** when called. The silent-drop
shape is the defect: nothing in the compile result signals that the JSON module
was never materialized.

### Test harness is non-vacuous (proved, not assumed)

`tests/issue-3655.test.ts`: **4 discovered / 4 attempted / 4 passed**, none
skipped (the `skipIf` real-ESLint case executes in this container).

Red-proof by reverting only `src/resolve.ts`, `src/index.ts`, and
`src/import-resolver.ts` to `main` while keeping the test file: **4 / 4 fail.**
The suite detects the actual defect rather than passing vacuously.

### Real ESLint graph — local-vs-local A/B

`tests/helpers/compile-project-probe.ts` on
`node_modules/eslint/lib/linter/linter.js` with
`{"allowJs":true,"target":"gc","platform":"node"}`:

|                      | clean `main`               | with this change |
| -------------------- | -------------------------- | ---------------- |
| entry errors         | 125                        | 124              |
| `Cannot find module` | 1 (`'../../package.json'`) | 0                |

Exact multiset diff of the two error lists: **0 added, 1 removed** — precisely
`Cannot find module '../../package.json' or its corresponding type
declarations.` `resolveAllImports` expands **146** canonical sources, includes
ESLint's `package.json` as a graph module, and reports **0** resolver
diagnostics.

This does **not** make ESLint compile. The graph still aborts on the same
terminal codegen error as before this change — `inherited class callable
LazyLoadingRuleMap_has has no exact defined function for handle 676` — which is
#3672 / #3798 territory, not #3655. #3655 removed the last unresolved-module
diagnostic in the graph; it removed nothing else.

### No collateral

Scoped resolver/project suite (`tests/resolve.test.ts`, `issue-1279`,
`issue-1289`, `issue-1096-env-adapter`, `issue-2688`, `issue-2689`,
`issue-3654`, `issue-3656`, `issue-3657`) run local-vs-local:

- clean `main` (8 files): 3 failed / 59 passed / 1 skipped
- with this change (10 files, adding `issue-3654` + `issue-3655`): 3 failed /
  68 passed / 1 skipped

The **same three** pre-existing failures in both runs (`issue-2688`,
`issue-2689`, `resolve.test.ts`); 59 + 9 = 68 accounts for every delta. Nothing
regressed.

`tests/issue-3654.test.ts` is updated in step: the `../../package.json` edge
now resolves instead of returning `null`. That file remains **5 / 5** passing,
none skipped.
