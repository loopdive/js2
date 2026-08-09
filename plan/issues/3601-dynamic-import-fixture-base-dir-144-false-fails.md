---
id: 3601
title: 'test262-runner: dynamic-import specifiers resolve against the runtime''s cwd, not the test''s directory — 144 false FAILs ("Cannot find module .../scripts/*_FIXTURE.js")'
status: ready
sprint: current
created: 2026-07-25
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
horizon: m
area: test-infrastructure, runtime
language_feature: dynamic-import
goal: test262-conformance
related: [1696, 1089, 3506, 3574]
---

# #3601 — dynamic-import fixture resolution uses the wrong base directory

## Problem (measured, 2026-07-25)

144 baseline rows (all `status: fail`, baseline JSONL 2026-07-24) fail with:

```
Test262:AsyncTestFailure:Error: Cannot find module
  '/home/runner/work/js2/js2/scripts/dynamic-import-module_FIXTURE.js'
  imported from ...
```

All are `language/expressions/dynamic-import/**` and `language/module-code/**`
tests whose `import('./x_FIXTURE.js')` (or `./self.js`) specifier must
resolve **relative to the test file's own directory** in the test262
checkout. Instead it resolves against `scripts/` — the directory of the CI
worker bundle. These are **false FAILs**: the compiled dynamic-import
machinery never gets a chance to run the fixture; the harness environment
loses the module before any compiler semantics are exercised. (This is the
runner-side sibling of the #1696 finding, which skipped its 18-file
`eval-script-code-*` subset rather than fixing resolution.)

## Root cause (exact)

`src/runtime.ts` ~L13804, `resolveImport`:

```ts
case "dynamic_import":
  return (specifier: any) => import(/* @vite-ignore */ specifier);
```

A bare host `import()` resolves relative specifiers against the **runtime
module's own URL** (the bundled worker in `scripts/`), because that's the
referrer of the `import()` call site. Nothing threads the test file's
directory in as the resolution base.

## Fix approach

1. **Thread an import base through `buildImports`**: add
   `opts.importBaseDir?: string` (the directory of the file under test) to
   the `buildImports(imports, overrides, stringPool, opts)` options object,
   store it in the callback/intent state, and in the `dynamic_import` arm
   resolve relative specifiers (`./`, `../`) against it:

   ```ts
   case "dynamic_import":
     return (specifier: any) => {
       let s = specifier;
       if (typeof s === "string" && /^\.\.?\//.test(s) && importBaseDir) {
         s = pathToFileURL(join(importBaseDir, s)).href;
       }
       return import(/* @vite-ignore */ s);
     };
   ```

2. **Callers pass the base**:
   - `scripts/test262-worker.mjs` — it has the absolute test path in the
     work message; pass `dirname(msg.filePath)` where it calls
     `buildImports(...)`.
   - `tests/test262-runner.ts` `runOriginalHarnessVariant` — `fileName` (the
     absolute test path) is already a parameter; pass `dirname(fileName)`.
   - Non-test262 embedders omit the option → today's behavior, byte-for-byte.

3. **Scope note — host-realm fixtures**: this makes the fixture _load_ as a
   host (V8) module, which is how Node would treat it; the deeper question
   of compiling fixtures through js2wasm (so the importer receives a
   compiled-module namespace) is the fixture-graph approach the shipped
   `js2-test262` CLI already implements (#3506). If cross-realm namespace
   interop turns out to block a large share of the 144, the follow-up is to
   port that fixture-graph resolution into `scripts/test262-worker.mjs`
   rather than to grow the host-import path.

## Edge cases

- Absolute/bare specifiers: leave untouched (only `./`/`../` re-based).
- `*_FIXTURE.js` files are excluded from the run set (`shouldSkip`) but must
  remain importable as modules from tests — no change needed there.
- Windows paths: use `pathToFileURL`, not string concat.
- Some of the 144 will still fail afterward for real reasons (TLA timing,
  rejection ordering, host-vs-compiled namespace identity) — the recoverable
  share is ≤144 and unmeasured; do a targeted rerun of all 144 in the PR and
  record the split in this file.

## Verify

- Targeted rerun of the 144 `Cannot find module` files (list them from the
  baseline JSONL via
  `node scripts/fetch-baseline-jsonl.mjs` + a grep for the error) — record
  pass/fail-for-a-new-reason counts.
- No change: a scoped rerun of ~20 non-dynamic-import module tests
  (byte-identical verdicts).
- Regression test `tests/issue-3601.test.ts`: compile+run a tiny
  `import('./fixture.js')` pair from a temp directory far from `scripts/`.
