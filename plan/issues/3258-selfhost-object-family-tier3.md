---
id: 3258
title: "Self-host stdlib: convert object-runtime.ts hand-emitted Instr[] to TS (Tier-3)"
status: ready
sprint: current
priority: medium
horizon: xl
feasibility: hard
model: fable
task_type: refactor
area: codegen, stdlib, ir
language_feature: compiler-internals
goal: ir-full-coverage
created: 2026-07-14
depends_on: [3257]
related: [3141, 3256, 3257]
origin: "sprint-71 bloat audit — object-runtime.ts = 11.6k LOC / 3,738 hand-emitted Instr[] sites (largest single lever)"
---

# #3258 — Self-host the `object-runtime.ts` family (Tier-3)

## Problem

`src/codegen/object-runtime.ts` (11.6k LOC, **3,738** hand-emitted `Instr[]`
sites) is the single largest self-host bloat lever — but also the hardest
(object/any element-kinds, dynamic shapes). Depends on Tier-1 (#3256) + Tier-2
(#3257) landing first.

## Scope (Tier-3, per plan/self-hosting-scale-up.md)

Only THEN wire the full deferred-registry machinery (Object/Closure/RefCell/
Class resolvers via integration.ts's `makeResolver`) into the driver resolver.
Convert the object-runtime helpers whose ABI is fixed; the dynamic-shape /
any-receiver ones may stay hand-emitted if the dialect can't cover their
elem-kinds (per `reference_selfhost_netnegative_needs_full_elemkind_dialect` —
self-host nets negative ONLY if the TS dialect covers ALL elem-kinds).

## Acceptance

- Tier-3 object/class resolver support lands; the fixed-ABI object-runtime helpers
  self-hosted (hand `Instr[]` deleted), net −LOC.
- A/B equivalence + containment SHA; both pure-Wasm lanes zero host imports.
- Written verdict on which object-runtime helpers are NOT self-hostable yet
  (dialect-gap) + what dialect work would unblock them.

## Measurement (the profiler is this issue's progress meter)

Use the god-file profiler from #3259 as the acceptance instrument:

- **Before/after:** `pnpm run profile:godfiles` — `object-runtime.ts` is the
  largest single lever; `ensureObjectRuntime` (baseline 7,355 LOC, d≈0.39,
  `hand-emitted-runtime`) is 42% of the file, plus `ensureProxyRuntime`
  (1,338 LOC, d≈0.32) and the `fill*`/`buildOrdered*` groups. Record the
  per-group LOC delta here and in `plan/self-hosting-scale-up.md`.
- **Landing proof:** after each helper-group conversion,
  `node scripts/profile-godfiles.mjs --update` and commit
  `scripts/godfile-profile-baseline.json` so `pnpm run check:godfiles` ratchets
  down (fails on regrowth). Helpers left hand-emitted for a dialect-gap stay in
  the baseline — the written verdict names them.
- Shape context: `plan/log/3259-bloat-quickwins-report.md`.

## Non-goals

- Big-bang: convert leaf-first, one helper group per PR, measure each.
