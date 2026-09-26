---
id: 6658
title: "compiler-boundaries `--mode complete` is stale after the prepared-async-frame-adapter move — `bound-unresolved` on clean main"
status: ready
sprint: current
created: 2026-09-23
updated: 2026-09-23
priority: low
horizon: s
feasibility: easy
task_type: chore
area: infra
goal: correctness
---

## Problem

On clean `upstream/main` `10902f7c8d`, with zero local changes under `src/`,
`scripts/` or `.github/`:

```
pnpm run -s check:compiler-boundaries      # --mode complete (the default)
-> compiler-boundaries: inventory-valid-architecture-incomplete (exit 1)
```

The report names one unresolved binding:

```json
{
  "originalPath": "src/codegen/prepared-async-frame-adapter.ts",
  "symbol": "emitPreparedIrAsyncFrame",
  "mappedPaths": [
    "src/codegen/prepared-async-frame-adapter.ts",
    "src/backend/wasmgc/async/prepared-async-frame-adapter.ts"
  ],
  "presentPaths": ["src/backend/wasmgc/async/prepared-async-frame-adapter.ts"],
  "status": "bound-unresolved",
  "resolved": false
}
```

The module was moved to `src/backend/wasmgc/async/prepared-async-frame-adapter.ts`;
only the new path exists on disk, but the policy still lists the old
`src/codegen/` path as a live mapping target, so the binding cannot resolve.

## Why it has not been noticed

`.github/workflows/ci.yml:168` runs the gate as `--mode inventory --base HEAD^1`,
and inventory mode is **green** (`inventoryValid: true`, exit 0). Only the
default `complete` mode fails. The project's documented pre-commit gate chain
(CLAUDE.md, and every dev brief that copies it) invokes the **bare**
`pnpm run -s check:compiler-boundaries`, i.e. `complete` mode — so every dev
running the sanctioned chain sees a red gate that CI does not enforce, on a
tree they did not change. That is the worst shape for a gate: it trains people
to ignore it.

Found 2026-09-23 while landing
[#6451](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6451-jshost-struct-enumeration-returns-empty-in-2131-harness),
a tests-only PR with a provably empty `src/` diff.

## Acceptance criteria

1. `pnpm run -s check:compiler-boundaries` (default `complete` mode) exits 0 on
   a clean `main` checkout — by updating the policy's mapping for
   `emitPreparedIrAsyncFrame` to the module's real path.
2. Decide and record which mode the documented pre-commit chain should call. If
   `complete` is not meant to be a pre-commit gate, change the chain in
   `CLAUDE.md` to the inventory mode CI actually enforces; if it is, CI should
   run it too. Today the two disagree silently.
3. Sweep the policy for any other `bound-unresolved` entry left by a file move,
   so this does not recur one module at a time.

## Notes

- Policy hash at time of report: `004ff08dc1f5a05e6ad9313e48a59c9a957888284d374bb4091ebf123f514a5e`.
- `moved-runtime gate: FAIL (production-rooted evidence incomplete)` printed by
  `check:dead-exports` on the same run is a **different**, long-standing
  open-graph message; that gate still exits 0. Do not conflate the two.
