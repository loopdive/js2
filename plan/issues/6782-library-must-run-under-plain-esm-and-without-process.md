---
id: 6782
title: "api: the published library does not run under plain Node ESM (`compileFiles()` → `require is not defined`) and hard-requires a global `process` (browser bundles throw)"
status: done
sprint: Backlog
created: 2026-09-30
updated: 2026-10-01
completed: 2026-10-01
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
assignee: "ttraenkler/claude-dev-6782"
branch: "claude/issue-6782-esm-process"
# #6782 process.env → readEnv codemod, 2026-10-01: every listed god-file grows only
# by the one `import { readEnv } from "…/env.js"` line the codemod adds (the reads
# themselves are a token swap that adds no lines); src/compiler.ts also gains one hoisted
# `const` so the env-provided path keeps its narrowed `string` type.
loc-budget-allow:
  - src/codegen/binary-ops.ts
  - src/codegen/class-bodies.ts
  - src/codegen/closed-method-dispatch.ts
  - src/codegen/closures.ts
  - src/codegen/declarations.ts
  - src/codegen/declarations/object-shape-widening.ts
  - src/codegen/dyn-read.ts
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/fnctor-escape-gate.ts
  - src/codegen/index.ts
  - src/codegen/ir-inline.ts
  - src/codegen/literals.ts
  - src/codegen/multi-prepared-program.ts
  - src/codegen/numeric-property-analysis.ts
  - src/codegen/property-access.ts
  - src/codegen/stack-balance.ts
  - src/codegen/statements/control-flow.ts
  - src/codegen/string-ops.ts
  - src/codegen/typed-this.ts
  - src/compiler.ts
  - src/ir/backend/linear-integration.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/propagate.ts
  - src/runtime.ts
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

## Implementation Plan

What was done, in order (branch `claude/issue-6782-esm-process`):

1. **Bare `require` (part 1).** `src/checker/index.ts` — the two
   `require("node:path")` calls in `resolveProjectCompilerOptions` and
   `analyzeFiles` now use a new `requirePath()` helper that takes `path` from
   `getDefaultEnvironment()` and throws a clear error when the host has none.
   No other bare `require(` exists in `src/` (`ts-api.ts` and `cli.ts` use a
   local `createRequire` binding). The `globalThis.require ??= createRequire(…)`
   shims that hid the bug are deleted from
   `tests/helpers/compile-files-validate-probe.ts`,
   `tests/standalone-cutover-public-routes.test.ts` and
   `scripts/check-ir-fallbacks.ts`.
2. **`readEnv` (part 2).** `src/env.ts` gains
   `readEnv(name): string | undefined`, which reads
   `globalThis.process?.env?.[name]` live (no caching). An AST-driven codemod
   (TypeScript API, so comments and string literals are untouched) moved the
   `process.env.X` / `process.env?.X` / `process.env[e]` reads in `src/` onto
   it: 127 files now import it. Hand edits: `compile-profile.ts` (its private
   `readEnv()` is replaced by the shared one), `fallback-telemetry.ts`
   (`strictFallbacksEnabled(env?)` no longer defaults a parameter to
   `process.env`), two hoisted `const`s in `compiler.ts` / `emit/binary.ts` so
   an env-provided path keeps its narrowed `string` type, and
   `typeof process` guards dropped where `readEnv` made them redundant and the
   guarded block does not itself use `process`.
3. **Files deliberately NOT migrated** (each still reads `process.env`
   directly):
   - Node-only entry points: `src/cli.ts`, `src/cli-compile-cache.ts`,
     `src/runtime-node-eval-worker.ts`.
   - Already-guarded whole-env pass-throughs that forward the env object to
     the compiled program: `src/runtime.ts` (`__get_process_env`),
     `src/runtime/wasi-polyfill.ts`, `src/runtime-eval.ts`.
   - `src/ts-api.ts` (guarded): it is in the activated `frontend-ts` layer,
     which `check-compiler-boundaries` forbids from importing `src/env.ts`
     (`mixed-needs-split`).
   - Source-receipt-pinned files: `src/codegen/expressions/calls.ts`,
     `closure-exports.ts`, `any-helpers.ts`, `native-strings-basics.ts`,
     `number-format-native.ts`, `src/ir/select.ts`, and the freshly relocated
     `src/ir/runtime/verify.ts` / `src/ir/verify-alloc.ts`. #3518 tests pin
     their exact text (span offsets or whole-file hashes); with the codemod
     applied, 11 receipt test files went red that are green on main.
   - `src/optimize.ts` (part 3, see below).
4. **Build-level backstop.** Because the receipt-pinned reads above sit on the
   `compile()` path (`select.ts` even reads at module load),
   `vite.config.lib.ts` now defines `process.env` →
   `__js2wasmProcessEnv` and prepends
   `const __js2wasmProcessEnv = globalThis.process?.env ?? {};` to every
   chunk. In Node this is the live `process.env` object, so reads and writes
   behave as before; without `process` every variable reads as `undefined`.
   It changes `dist/` only — source files stay byte-identical.
5. **Smoke test.** `tests/dist-esm-smoke.test.ts` spawns plain
   `node --input-type=module` children (cwd outside the repo) against
   `dist/index.js`: (a) `compileFiles(<tmp .ts>)`, (b) `compile()` with
   `globalThis.process` deleted. Both assert success and a valid binary. The
   cases are skipped when `dist/index.js` is absent.

## Resolution

**Before → after**, probes run with plain `node` against a fresh `pnpm run build`
of `dist/index.js`, from a working directory outside the repo:

| Probe | Before (main) | After |
| --- | --- | --- |
| `await compileFiles("/tmp/…/hello.ts")` | `ReferenceError: require is not defined` | success, valid binary |
| `delete globalThis.process` after import, then `compile(src)` | `ReferenceError: process is not defined` (`cachedFlag` ← `dtsEntrypointSeedsFlagEnabled`) | success, valid binary |
| `delete globalThis.process` BEFORE `import(dist)`, then `compile(src)` | not measured | success, valid binary |
| no-process `compile()` for gc / standalone / wasi / `optimize: true` / `emitWat` | — | all succeed; `linear` fails identically with and without `process` (unsupported `.sqrt()` / arrow in the linear backend — unrelated) |

Measured during this work: with the codemod only (no build-level define), the
no-process `compile()` still failed with `process is not defined` from the
receipt-pinned files listed above, which is why step 4 exists.

**Tests.** New `tests/dist-esm-smoke.test.ts` (2 cases, both pass on the built
dist). Related suites re-run on the final tree: `issue-1058`, `issue-1096`
(env adapter), `issue-1775`, `issue-3523-module-init-single-pass`,
`issue-3946` (compile profile), `issue-4420` (uses the de-shimmed probe
helper), `issue-4451`, `issue-5335`, `standalone-cutover-public-routes` — all
pass. `issue-1501` (1), `issue-3523-module-init-discovery-static` (2) and
`issue-743-dts-entrypoint-seeds` (1) fail with the same assertions on
`origin/main` (A/B by swapping the 129 touched files back).

Source-receipt audit: the 104 root tests that read a touched `src/` file (or
use a helper that does) were run before and after. After restoring the 7
pinned/clean-layer files, no test fails on this branch that passes on main;
the remaining failures there (missing `test262/` checkout, unbuilt QuickJS
provider, pre-existing #3518 receipt drift, load-sensitive subprocess
timeouts that pass on re-run) reproduce identically on main.

**Gates** (exit codes, final tree): `typecheck` 0, `typecheck:ts5` 0,
`format:check` 0, `lint` 0, `test:guard` 0 (20 files / 255 tests),
`check-loc-budget` 0 (merge-base and `LOC_GATE_BASE=origin/main`),
`check-func-budget` 0 (both bases), `check-coercion-sites` 0,
`check:oracle-ratchet` 0, `check:dead-exports` 0,
`check-compiler-boundaries --mode inventory --base origin/main` 0,
`check:ir-dialect` 0, `check:ir-kind-neutrality` 0, `check:jstag-seam` 0,
`check:ir-layering` 0, `check:codegen-fallbacks` 0, `check:any-box-sites` 0,
`check:speculative-rollback` 0, `check:stack-balance` 0, `check:pushraw` 0,
`check:host-import-policy` 0, `check:ir-only` 0, `check:ir-adoption` 0,
`check:issues` 0, `check:done-status-integrity` 0,
`check:issue-spec-coverage` 0, `check:harness-compile-budget` 0,
`check:verdict-oracle` 0, `check:ir-fallbacks` 0 (now runs without the
`require` shim).

**CI.** Not wired into `quality`: that job only runs `build:compiler-bundle`
(an esbuild bundle), never the `dist/` build, and `pnpm run build` measured
243 s, 412 s and 446 s on this 4-core container (load 4–9) — over the 3-minute
bar. The smoke test skips itself when `dist/` is absent.

**Left out, and why.**
- **Part 3 (`optimize.ts` resolves `binaryen` from the package first).**
  Implemented and verified locally, then withdrawn: `src/optimize.ts` is
  pinned by the reviewed `optional-binaryen-provider-v1` receipt in
  `scripts/compiler-extension-boundaries.json` (whole-file git-blob digest),
  so any edit fails `check:dead-exports` until a reviewer re-signs that
  receipt. That re-signing is a human review step, not something this change
  should do for itself. The change is small: a `syncRequires()` helper that
  returns `createRequire(import.meta.url)` then `createRequire(cwd)`, used by
  `getNodeImportsSync` and looped over in `resolveWasmOptPath`, plus a
  `globalThis.process?.stderr?.write` guard. Follow-up needed: apply it and
  refresh the receipt in the same reviewed change.
- **Browser bundle acceptance.** Not added to the smoke test. `dist/index.js`
  still has static `node:fs` / `node:path` / `node:module` /
  `node:child_process` / `node:os` / `node:crypto` imports, so an esbuild
  `--platform=browser` bundle needs those stubbed regardless of `process`;
  that belongs with #6794 (package/bundle shape).
- **Node < 20.16.** `compileFiles()` now gets `node:path` from
  `process.getBuiltinModule`; on Node 20.0–20.15 under ESM it throws a clear
  "needs a Node `path` module" error instead of `require is not defined`.
- The 8 receipt-pinned source files (and the guarded `ts-api.ts`) keep direct
  `process.env` reads; the dist build covers them, but a consumer that
  bundles `src/` itself does not get that backstop. Migrating them needs the
  #3518 receipt owners to re-sign.
