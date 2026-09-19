---
id: 6488
title: "Harness provider cache key ignores the compiler build — a stale provider is served after any codegen change that does not bump an ABI constant"
status: ready
sprint: Backlog
created: 2026-09-16
updated: 2026-09-16
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bug
area: test262-runner
goal: test262-conformance
related: [3451, 6486, 6487]
---

# #6488 — provider cache key vs compiler build

## Problem (found during #6487, 2026-09-16)

`harnessProviderCacheKey` (`src/test262-harness-provider.ts`) fingerprints the
harness prefix, the provider compile options and three ABI constants
(`RUNTIME_RECGROUP_ABI_VERSION`, `PROVIDER_COMPILER_ABI_VERSION`,
`PROVIDER_LINKER_ABI_VERSION`). Nothing in it identifies the compiler BUILD, so
after a codegen change that leaves those constants alone (#6487 changed a
parameter's ABI from f64 to externref without touching any of them) every
reuse of a cache directory — `.tmp/linked-smoke/providers` for the smoke
script, `$TMPDIR/js2wasm-test262-harness-cache` for the worker
(`scripts/test262-harness-cache.mjs`) — serves the OLD provider against a NEW
consumer. The #6487 lane's first "before" measurement was contaminated this
way. CI is not affected today only because every shard job starts on a fresh
runner; a prewarm/cache step for providers (planned in #6486 if provider
builds dominate shard time) would make it affect CI too.

## Fix

Add a compiler build identity to the fingerprint. Options, cheapest first:

1. `esbuild --define:__JS2WASM_BUILD_ID__=<git sha or content hash>` in
   `build:compiler-bundle` / `build:runtime-bundle` / `pnpm run build`, with
   a `"dev"` fallback under `tsx` that ALSO folds in the mtime+size of
   `src/codegen/**` (cheap `fs.stat` walk, memoised per process) so an
   in-source run never hits a bundle's cache entry and vice versa.
2. Alternatively hash `scripts/compiler-bundle.mjs` itself when the running
   module URL points into it.

Either way, `scripts/prewarm-test262-harness-providers.mjs` and the stamp in
`scripts/test262-harness-cache.mjs` must carry the same identity so a prewarm
from another build is refused, not served.

## Acceptance

- [ ] A test compiles a provider, changes the build id (test seam), and
      asserts a cold build is taken; same id ⇒ cache hit.
- [ ] Smoke script and worker behave identically; no CI change needed.
