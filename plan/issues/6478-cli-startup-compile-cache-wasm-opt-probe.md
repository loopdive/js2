---
id: 6478
title: "CLI startup: enable Node's compile cache and memoise the wasm-opt path probe (−0.7 s of a 3.1 s run)"
status: ready
created: 2026-09-14
updated: 2026-09-14
priority: medium
horizon: s
feasibility: easy
reasoning_effort: low
task_type: perf
area: cli, optimizer
goal: npm-library-support
sprint: current
es_edition: n/a
related: [5814, 1941, 1950, 3946]
---

# #6478 — CLI startup: compile cache + wasm-opt probe memo

## Measured (2026-09-14, `dist/cli.js` after #5814, 5-line input, warm disk cache, 4-core container)

| step | cost |
| --- | --- |
| whole `-O0` run | 2.2 s |
| ↳ ESM/CJS module load of the 18 MB runtime bundle + 11 MB `typescript.js` | ~0.56 s |
| ↳ TypeScript parse of the bundled lib composite (`lib.dom.d.ts` is 1.9 MB) | ~0.45 s |
| ↳ user-file semantic diagnostics | ~0.21 s |
| ↳ codegen (JIT-cold) | ~0.50 s |
| same run with `NODE_COMPILE_CACHE` set | **1.8 s** (−0.4 s) |
| `-O3` adds | ~1.0 s: `wasm-opt --version` probe **0.29 s** + optimize run 0.73 s |

Two facts that bound the design:

- `optimizeWithSystemBinary` (`src/optimize.ts`) resolves the wasm-opt path
  on EVERY call: `which wasm-opt` (5 ms) then a `--version` spawn of the
  bundled Emscripten `node_modules/binaryen/bin/wasm-opt` (**292 ms** — it is
  a 10 MB Node script). `wasmOptPath` is a local `let`, so pooled callers pay
  it per compile too. The compact-imports capability probe next to it is
  already memoised (`_wasmOptCompactImportsSupport`).
- The in-process `binaryen` module is NOT an alternative: `import("binaryen")`
  takes **11.5 s** on this box and `readBinary` rejects our rec-groups
  without feature flags. #1941's "CLI first" order stands.

## Implementation Plan

1. **`src/cli.ts`** — at the top of the entry, before any heavy import:
   ```ts
   import { enableCompileCache } from "node:module";
   if (process.env.JS2WASM_NO_COMPILE_CACHE !== "1") {
     try { enableCompileCache?.(); } catch { /* Node < 22.1, read-only tmp: best effort */ }
   }
   ```
   `enableCompileCache` exists from Node 22.1 (`engines` is `>=20`, so the
   optional-call + try/catch is load-bearing). It honours `NODE_COMPILE_CACHE`
   when set and otherwise uses `os.tmpdir()`. Must run BEFORE the dynamic
   import of the compiler bundle — `dist/cli.js` is built by vite; check the
   emitted order (`pnpm run build`, then read the head of `dist/cli.js`).
2. **`src/optimize.ts`** — hoist the resolved path into a module-level
   `let _resolvedWasmOptPath: string | null | undefined` (undefined = not yet
   probed, null = probed and absent). Populate it from the existing
   `which` + `--version` sequence on first call; reuse afterwards. Keep the
   `--version` probe itself (it is what proves the candidate is runnable);
   only its repetition goes. Invalidate nothing — the path cannot change
   inside one process.
3. **Tests**
   - `tests/issue-6478-wasm-opt-path-memo.test.ts`: spy on
     `child_process.execFileSync` (or count via an injected `_nodeImports`
     seam if one exists) across two `optimizeBinaryAsync` calls; assert the
     `--version` probe runs once.
   - `tests/issue-6478-cli-compile-cache.test.ts`: spawn `dist/cli.js` twice
     with `NODE_COMPILE_CACHE=<tmp>` and assert the cache dir is non-empty
     after the first run; spawn once with `JS2WASM_NO_COMPILE_CACHE=1` and
     assert it stays empty. Skip when `enableCompileCache` is absent.
4. **Measure** before/after with the file-copy A/B pattern (`cp` the two
   sources to `.tmp/` first): `time node dist/cli.js <5-line file>` ×3 at
   `-O0` and `-O3`; record medians in this file under "## Measured after".

## Acceptance

- [ ] `-O3` run: `--version` spawn count per process is 1 (test).
- [ ] Second `-O0` run with the cache is ≥ 0.3 s faster than without on the
      same box (record, do not gate CI on it).
- [ ] Binary output byte-identical with and without the cache and with the
      memoised path (compare in the CLI test).
- [ ] Node 20 path: `enableCompileCache` absent ⇒ CLI runs unchanged (guarded
      call; add a unit test that stubs the import to `undefined`).

## Not in scope (measured, documented for the record)

- **Lib parse (0.45 s)**: `lib.dom.d.ts` dominates and `console` lives there,
  so auto-eliding DOM by scanning identifiers rarely fires. `--platform node`
  already selects the DOM-free composite (#2528).
- **Codegen JIT warm-up (0.5 s)**: a V8 startup snapshot would remove it; not
  worth the build complexity for a one-shot CLI today.
