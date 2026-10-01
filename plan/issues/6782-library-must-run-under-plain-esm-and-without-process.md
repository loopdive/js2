---
id: 6782
title: "api: the published library does not run under plain Node ESM (`compileFiles()` → `require is not defined`) and hard-requires a global `process` (browser bundles throw)"
status: ready
sprint: Backlog
created: 2026-09-30
updated: 2026-09-30
priority: critical
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bug
area: compiler
language_feature: n/a
goal: npm-library-support
related: [4419, 1927, 1757]
requested_by: ttraenkler/claude-review
origin: "2026-09-30 codebase review (plan/agent-context/claude-codebase-review-2026-09-30.md) — C4/H20/#6"
---

# #6782 — the library must work from `dist/` under plain ESM and in a browser bundle

## Problem

Three independent defects, all reproduced against the built `dist/index.js`
(`pnpm run build`, then `node probe.mjs`):

1. **`compileFiles()` throws.** `await compileFiles("/abs/hello.ts")` →
   `ReferenceError: require is not defined`. `compile()` works.
2. **A global `process` is mandatory.** `delete globalThis.process` after
   import, then `compile(src)` → `process is not defined`. README.md:42 pitches
   browser use; the playground only works because Vite's client build rewrites
   `process.env` to `{}`. Library mode (`vite.config.lib.ts`, `isBuildLib`)
   does not, so esbuild/rollup/webpack browser bundles fail.
3. **`wasm-opt` resolution is anchored at `process.cwd()`**, not the package.

## Evidence

- `src/checker/index.ts:1301` and `:1344`: `const pathMod = require("node:path")`.
  Package is `"type": "module"`, dist is built `formats: ["es"]`
  (`vite.config.lib.ts:53`) with no shim. Vitest passes only because vite-node
  injects `require`; `tests/helpers/compile-files-validate-probe.ts:16-20`
  monkey-patches `globalThis.require ??= createRequire(import.meta.url)` to
  hide it. Lines 67-73 of the same file already use
  `getDefaultEnvironment().path` — the correct pattern.
- 334 `process.env.*` reads across `src/` (grep, 2026-09-30); on the hot path:
  `src/compiler.ts:1051` `if (process.env.JS2WASM_IR_POSTCLAIM_LOG && …)` runs
  on every WasmGC compile; `derivation-flags.ts:87`, `inline-hints.ts:147`,
  `target-profile.ts:137`. `src/compile-profile.ts:57` has a guarded accessor.
- `src/optimize.ts:112`, `:556`: `createRequire(\`file://${process.cwd()}/\`)`.
  A global install, or any cwd without `binaryen` in `node_modules`, misses and
  falls to `import("binaryen")` (`:394`) — the JS-module backend the file
  itself documents as the buggy encoder (`:280-284`). `package-bundler.ts:45`
  does it right with `createRequire(import.meta.url)`.

## Correction

1. Replace both bare `require("node:path")` with `getDefaultEnvironment().path`.
2. One `env.ts` accessor `readEnv(name): string | undefined` that returns
   `undefined` when `globalThis.process?.env` is absent; migrate every
   `process.env.` read through it (a codemod; the ratchet gates count LOC, so
   grant the allowance in this issue's frontmatter when implementing).
3. `optimize.ts`: `createRequire(import.meta.url)` first, cwd second.
4. Add `tests/dist-esm-smoke.test.ts` that runs the built `dist/index.js` in a
   child `node` process with `--input-type=module` and (a) calls `compileFiles`,
   (b) deletes `globalThis.process` before `compile`. Run it in `quality`
   after the build step (the build already runs there for `build:compiler-bundle`).
5. Delete the `globalThis.require` monkey-patch in the test helper once (1)
   lands.

## Acceptance

- `node -e 'import("@loopdive/js2").then(m => m.compileFiles("x.ts"))'` works
  from a directory outside the repo.
- `compile()` succeeds with `globalThis.process` undefined (Node) and inside a
  minimal esbuild `--platform=browser` bundle (add the bundle to the smoke test
  if esbuild is already a devDependency — it is).
- `wasm-opt` is found from a global install (`npm i -g @loopdive/js2`) with
  `binaryen` as its own peer.
