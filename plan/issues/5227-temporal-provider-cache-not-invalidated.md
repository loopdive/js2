---
id: 5227
title: "Temporal provider artifact cache is not invalidated by compiler changes — a stale artifact silently reproduces old bugs after a codegen fix"
status: ready
sprint: current
priority: high
horizon: s
goal: dogfood
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-08-30
---

# #5227 — provider cache keyed on inputs only, not compiler version

## Problem

The #4628 compile-once provider cache (`JS2WASM_TEMPORAL_CACHE`,
`src/temporal-provider.ts`) keys the artifact on the polyfill source content
hash — not on the **compiler** that produced it. After a codegen change, the
first provider run reports `cacheHit=true` and serves an artifact built by
the previous compiler. dev-5221 measured this directly: the cached artifact
reproduced the already-fixed #5221 null deref; a fresh cache dir gave the
correct result. This is a measurement hazard (a fix looks unlanded; a
regression looks pre-existing) and will bite every future codegen PR that
touches anything on the polyfill's compile path.

## Direction

Fold a compiler-version fingerprint into the cache key. Cheapest correct key:
the package version plus a content hash of the compiled `dist/` (or, in
from-source runs, a hash of `src/**` mtimes/contents is too slow — use the
git HEAD sha of the compiler tree when available, falling back to version).
Invalidation must be automatic; an env-var escape hatch to force rebuild
(`JS2WASM_TEMPORAL_CACHE_REBUILD=1`) is a bonus, not the fix.

## Acceptance criteria

1. Changing the compiler (simulate: bump the fingerprint input) misses the
   cache; unchanged compiler + unchanged polyfill still hits (warm-path cost
   preserved, ~0.75 s).
2. Test in `tests/issue-5227-*.test.ts` proving key sensitivity both ways.
3. issue-4628 tests + harness green; gates green.

## Notes

- Found by dev-5221 (PR #5334 body carries the ⚠ warning); until fixed,
  anyone measuring the provider after a codegen change must clear the cache
  first.
- Id reserved with a degraded PR scan; manually checked against open PR head
  branches 2026-08-30.
