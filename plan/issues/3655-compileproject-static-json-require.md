---
id: 3655
title: "compileProject allowJs: support static CommonJS require of JSON modules"
status: review
created: 2026-07-26
updated: 2026-07-26
priority: critical
feasibility: medium
reasoning_effort: high
task_type: feature
area: resolver, codegen
language_feature: json-modules
goal: npm-library-support
sprint: current
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
