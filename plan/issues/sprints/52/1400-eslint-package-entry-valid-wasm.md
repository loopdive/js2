---
id: 1400
sprint: 52
title: "npm: compile ESLint package entry to valid Wasm"
status: ready
created: 2026-05-11
updated: 2026-05-11
priority: high
feasibility: hard
reasoning_effort: high
task_type: feature
area: compiler, resolver, codegen
es_edition: n/a
language_feature: commonjs, package-exports, classes
goal: npm-library-support
related: [1075, 1277, 1279, 1282, 1287, 1289]
---
# #1400 - Compile ESLint package entry to valid Wasm

## Goal

Compile ESLint from its package entry as real JavaScript implementation code,
not as declaration-file extern stubs, and produce a structurally valid Wasm
module for the Tier 1 `Linter.verify()` scenario.

The target smoke case is:

```ts
import { Linter } from "eslint";

const linter = new Linter();

export function test(): number {
  const messages = linter.verify("const x = 1;", {});
  return Array.isArray(messages) ? messages.length : -1;
}
```

## Current state

Verified on 2026-05-11:

1. `compileProject("/workspace/node_modules/eslint/lib/linter/linter.js", { allowJs: true })`
   succeeds and emits a ~276 kB binary, but `WebAssembly.validate()` is false.
2. The first direct `linter.js` validation blocker is:

   ```text
   WebAssembly.instantiate(): Compiling function #178:"Config_new" failed:
   extern.convert_any[0] expected type anyref, found extern.convert_any of type externref @+112747
   ```

3. `compileProject("/workspace/node_modules/eslint/lib/api.js", { allowJs: true })`
   also succeeds and emits a ~953 kB binary, but hits the same validation class.
4. `import { Linter } from "eslint"` currently compiles to a small valid binary
   that imports `env.__new_Linter`; it does not compile the real ESLint
   implementation. Runtime fails with:

   ```text
   No dependency provided for extern class "Linter"
   ```

5. `tests/stress/eslint-tier1.test.ts` has Tier 1a/1b/1c passing and Tier
   1d/1e still skipped.

## Missing pieces

### 1. Resolve package `exports` implementation entries

ESLint's `package.json` maps the bare package export to both:

```json
{
  "types": "./lib/types/index.d.ts",
  "default": "./lib/api.js"
}
```

The resolver currently handles the `@types/*` case, but this package-local
`types` vs `default` shape still resolves through declarations for the bare
`eslint` import. `compileProject` needs to choose the implementation body
(`default` / `main`) for compile-time codegen while preserving type information
for checking.

### 2. Preserve CJS class exports across modules

ESLint exposes classes through CommonJS object exports, for example:

```js
const { Linter } = require("./linter");

module.exports = {
  Linter,
  SourceCodeFixer,
};
```

The existing CJS export lowering handles enough function export cases for
previous stress tests, but class/constructor values still degrade to extern
constructors in the package-entry path. Named class exports need to link to the
compiled class implementation, not `env.__new_Linter`.

### 3. Fix direct `linter.js` validation

The direct implementation graph already compiles, so the next hard blocker is
the `Config_new` duplicate `extern.convert_any` validation error. This is
separate from #1289: #1289 removed the earlier
`FileReport_addRuleMessage` `array.set` mismatch and exposed this next issue.

### 4. Re-enable the ESLint Tier 1 execution ladder

After the direct graph validates, unskip and update the ESLint stress test so it
tracks current progress:

- Tier 1d: direct `eslint/lib/linter/linter.js` binary validates/instantiates.
- Tier 1e: package-entry `new Linter().verify("const x = 1;", {})` returns `[]`.
- Add a package-entry assertion that verifies no `env.__new_Linter` extern
  constructor is emitted for the real implementation path.

## Acceptance criteria

1. Bare `import { Linter } from "eslint"` resolves to the implementation graph,
   not only to `.d.ts` declarations.
2. The package-entry Tier 1 source compiles without `env.__new_Linter` in the
   import manifest.
3. Direct `eslint/lib/linter/linter.js` compile returns `success: true` and
   `WebAssembly.validate(binary) === true`.
4. The direct `linter.js` binary instantiates with `buildImports(...)` and
   `setExports(instance.exports)`.
5. `new Linter().verify("const x = 1;", {})` returns an empty message array in
   the Tier 1 stress test.
6. `tests/stress/eslint-tier1.test.ts` has no skipped Tier 1d/1e rungs for this
   scenario.
7. Existing Hono/lodash/npm stress tests remain green.

## Suggested implementation order

1. Fix package `exports` implementation resolution for bare package imports.
2. Add CJS class/object export linkage for `module.exports = { Linter }` and
   `module.exports = SourceCode`-style class exports.
3. Fix the `Config_new` duplicate `extern.convert_any` validation bug.
4. Unskip Tier 1d, then Tier 1e, and record any newly exposed runtime blocker as
   a follow-up only if it is outside this milestone.
