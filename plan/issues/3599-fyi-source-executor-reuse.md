---
id: 3599
title: "expose FyiSourceExecutor reuse for external test262 integrations + fix its worker-path resolution when published"
status: done
completed: 2026-07-25
sprint: 77
priority: high
horizon: s
goal: test262-conformance
feasibility: easy
created: 2026-07-25
assignee: ttraenkler
related: [3284, 3285, 3349, 3574]
---

# #3599 — external executor reuse for js2-test262 + a worker-path bug it exposed

## Problem

test262.fyi's js2wasm integration ([test262-fyi/data](https://github.com/loopdive/test262-data)
engines/js2wasm) calls `js2-test262` once per test file, matching every other
engine's `run.js` contract in that shared runner. `js2-test262` is a one-shot
CLI: each invocation loads js2's full TypeScript-based compiler from scratch,
plus a second, nested Node process fork internally — measured at ~2.3-2.8s of
pure fixed overhead per test file, dwarfing actual compile+execute time
(#3574's investigation surfaced this while chasing an unrelated async bug).

`scripts/run-test262-fyi.mjs`'s own `main()` (the full-suite CI entry point)
already avoids this: it builds a small pool of `FyiSourceExecutor`s once and
reuses them across the whole corpus via `runTest(test, target, executor)`.
That reuse path was not reachable from outside this package: `FyiSourceExecutor`
and `runTest` were not exported, and `executeTestFile` (the one exported
function shaped for external per-file use) always constructed a fresh
executor and shut it down before returning, with no way to hand it one.

## Fix

- Export `FyiSourceExecutor` and `runTest` from `test262-fyi-cli.mjs` (and
  by extension the published `./test262-fyi` subpath — see below).
- `executeTestFile({ ..., executor })` accepts an optional pre-existing
  executor. Omitted: identical to the old behavior (fresh executor,
  `shutdown()` in the `finally`). Provided: the caller's executor is used and
  left running — the caller owns its lifecycle.
- Added `"./test262-fyi": "./dist/test262-fyi-cli.js"` to `package.json`'s
  `exports` map. It was completely unreachable via `import` before this
  (Node's `exports` field, once present, blocks any subpath not explicitly
  listed) — only the `js2-test262` bin invocation worked.

## A real bug this surfaced: `FyiSourceExecutor`'s default `workerPath` breaks when published

Verified directly against a fresh `npm pack` + `npm install` (not just the
monorepo checkout): calling `new FyiSourceExecutor()` with no explicit
`workerPath` — the natural thing an external caller building a reusable
executor would do — threw:

```
Error: Cannot find module '.../node_modules/@loopdive/js2/scripts/test262-worker.mjs'
```

Root cause: `WORKER_PATH` was a module-level constant —
`join(ROOT, "scripts", "test262-worker.mjs")` — where `ROOT` is derived from
`import.meta.url`. `scripts/run-test262-fyi.mjs` gets bundled (via
`scripts/build-test262-cli.mjs`, esbuild) into `dist/test262-fyi-cli.js` for
publishing, and bundling flattens `import.meta.url` to wherever the *bundle*
lives, not the original source file. So `ROOT` resolved to the package root,
and `WORKER_PATH` pointed at a `scripts/` path that was never published
(`scripts/` isn't in `package.json`'s `files`; only `dist/test262-worker.js`
is). This was invisible before because the only caller was
`executeTestFile`, which always passed an *explicit* `workerPath` computed by
its own private `workerPathForCli()` helper — which already had the correct
fix (checks both `.mjs`/`.js` siblings of *its own* `import.meta.url`, so it
resolves correctly in both the unbundled monorepo and the bundled published
package). `WORKER_PATH`'s naive constant never got that treatment because
nothing exercised the no-argument constructor path from outside the bundle
until now.

**Fix**: replaced the stale `WORKER_PATH` constant with `resolveWorkerPath()`,
the same "check `.mjs` then `.js` next to this module's own resolved
location" logic `workerPathForCli()` already used, called lazily as
`FyiSourceExecutor`'s default `workerPath` parameter. `workerPathForCli()`
itself is now redundant and removed; `executeTestFile`'s fresh-executor path
simplifies to `new FyiSourceExecutor()`, matching `main()`'s own pool
construction.

## Verification

- Built the package fresh (`pnpm run build`), packed it (`npm pack`),
  installed the tarball into a clean directory (not `npm link` — a real
  `npm install` of what would actually get published), and drove it directly:
  - `new FyiSourceExecutor()` now correctly resolves `dist/test262-worker.js`
    (previously threw immediately).
  - 6 sequential `executeTestFile({ ..., executor })` calls against the same
    reused executor: 6966ms (cold — worker fork + full module load) → 1872ms
    → 1454ms → 1106ms → 997ms → 1260ms (steady state), vs. ~2.3-2.8s *every
    single call* through the one-shot CLI. Roughly 5-7x per-test-file
    speedup once warm, on top of eliminating the outer CLI process's own
    separate cold start.
  - The existing one-shot `js2-test262` bin invocation (no executor
    override) still exits 0 on a real passing test — the default behavior
    is unchanged.

## Consumer-side follow-up (test262-fyi/data, not this repo)

test262-fyi/data's `engines/js2wasm/` gets a `server.mjs` (one persistent
`FyiSourceExecutor` per cluster worker, Unix-socket request/response) and a
`client.mjs` (the actual tiny per-test process `run.js` spawns — deliberately
zero heavy imports, so its own cost stays close to bare Node startup). That
side is tracked and shipped in the test262-fyi/data repo, not here — this
issue is scoped to what js2 itself needed to expose/fix to make it possible.
