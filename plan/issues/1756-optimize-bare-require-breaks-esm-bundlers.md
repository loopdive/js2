---
id: 1756
title: "optimize.ts bare require() breaks ESM bundlers (bun build / deno compile)"
status: done
created: 2026-05-30
updated: 2026-05-30
completed: 2026-05-31
priority: medium
feasibility: medium
task_type: bug
area: optimizer
goal: platform
related: [389, 1580]
depends_on: []
sprint: Backlog
---

# #1756 — optimize.ts bare `require()` breaks ESM bundlers

## Context

External contributor (GitHub #986). Bundling js2wasm itself into a standalone
binary fails:

```
bun build --target=node --compile --outfile=js2wasm ./node_modules/@loopdive/js2/src/cli.ts
250 |     binaryen = require("binaryen");
                             ^
error: This require call is not allowed because the transitive dependency
"node_modules/binaryen/index.js" contains a top-level await
```

## Root cause

`src/optimize.ts` had two **bare** `require()` calls — `require("binaryen")`
(sync optimize path, `optimizeWithBinaryenPackage`) and `require("node:fs")`
(temp-dir cleanup). The package is ESM (`"type": "module"`). Bun statically
resolves a bare `require(...)`, finds `binaryen`'s transitive top-level `await`,
and refuses to bundle it (a `require` can't load a TLA module).

`binaryen` is an **optional** dependency loaded in the **synchronous** public
compile API (`compileSource`/`compileMultiSource`/`compileFilesSource` →
`optimizeBinary`), so it can't simply become a static `import`, and converting
to `await import()` would force those public entry points async — a large
breaking ripple.

## Fix (applied)

The file already loads its node: built-ins through a bundler-opaque
`process.getBuiltinModule("node:module").createRequire(...)` shim
(`getNodeImportsSync`), specifically because bundlers "won't statically follow
the dynamic getter." Extracted that into a `getNodeRequireSync()` helper and
routed both remaining bare `require()`s through it:

- `require("binaryen")` → `getNodeRequireSync()?.("binaryen")`
- `require("node:fs")` → `getNodeRequireSync()?.("node:fs")`

Keeps the synchronous public API (no async ripple), stays optional (try/catch →
skip optimization if unavailable), and bundlers no longer see a static
`require("binaryen")` to reject.

## Verification

- No bare `require()` calls remain in `src/optimize.ts` (comments only).
- `tsc --noEmit` clean.
- `--optimize` still runs binaryen: a sample compiled `-O3` is 272 B vs 412 B
  unoptimized (34% smaller) — wasm-opt is active, no "wasm-opt not available"
  warning.

## Note / follow-up

This resolves the **build failure**. Under `bun ... --compile` the
standalone binary still resolves `binaryen` at *runtime* (createRequire isn't
bundled), so a single-file binary won't *embed* binaryen — it degrades
gracefully to "optimization skipped" if binaryen isn't present, or uses the
`wasm-opt` CLI. Fully embedding binaryen in a standalone build would require the
async-API migration (`optimizeBinaryAsync` + making the compile entry points
async); that's a separate, larger enhancement, not needed to unblock #986.
