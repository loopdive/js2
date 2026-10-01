---
id: 6797
title: "arch: codegen, ir and frontend form one 693-file strongly-connected component (40 % of src, 3,083 circular chains) — add an import-cycle ratchet and cut the 74 ir→codegen edges first"
status: ready
sprint: Backlog
created: 2026-09-30
updated: 2026-09-30
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: refactor
area: compiler
language_feature: compiler-internals
goal: compiler-architecture
related: [912, 1172, 4601, 6793]
requested_by: ttraenkler/claude-review
origin: "2026-09-30 codebase review (plan/agent-context/claude-codebase-review-2026-09-30.md) — arch #1/#2"
---

# #6797 — the documented IR retirement path cannot be executed layer-by-layer

## Measurements (2026-09-30, HEAD e303c5c7)

- `src/` = 904,803 lines / 1,738 files; 48 files > 3,000 lines;
  `src/codegen/` has **824 files (473,840 lines) flat** in one directory.
- Tarjan SCC over value imports (3,345 type-only imports excluded): 5 SCCs;
  the largest is **693 files** (681 codegen + 11 ir + 1 frontend); 105 mutual
  A↔B pairs. `madge --circular src/index.ts`: **3,083** circular chains over
  1,569 files. Example: `codegen/stdlib-selfhost.ts → frontend/builtins/build-ir.ts
  → ir/from-ast.ts → … → codegen/function-body.ts`.
- Directory-level two-way edges: codegen↔ir **310 / 74**, backend↔ir 97/20,
  frontend↔ir 17/7, codegen-linear↔ir 9/4, checker↔ir 1/8, ir↔runtime 7/1.
- Fan-out leaders: `codegen/index.ts` 279 imports, `expressions/calls.ts` 139,
  `ir/integration.ts` 109. God functions in `codegen/index.ts`:
  `generateModule` 1,909 lines (`:5229`), `generateMultiModule` 1,301
  (`:10552`), `planIrOverlay` 650, `emitIteratorMethodExport` 621,
  `resolveWasmType` 556. `check:godfiles` is **red on main** (two new
  mega-functions) and is not run in CI.
- `docs/architecture/codegen-axes.md` says the IR "replaces the hacks";
  `plan/log/ir-adoption.md`: 20 ir-owned / 31 mixed / 1 direct-only / 14
  deferred. The `*-native.ts` → `src/backend/wasmgc/` move
  (`target-architecture.md`) is half done: 42 files in `codegen/`, 49 in
  `backend/wasmgc/`, no progress marker. #912 (done) removed cycles once;
  nothing prevents them from returning.

## Correction

1. **Ratchet, not a big-bang.** `scripts/check-import-cycles.mjs`: Tarjan over
   `import … from` (value imports only), baseline
   `scripts/import-cycles-baseline.json` = {largest SCC size, total chains,
   per-directory two-way edge counts}. Fails on growth; `--update-on-decrease`
   banks improvements post-merge (same shape as `check:ir-fallbacks`). Wire
   into `quality`.
2. **Cut ir → codegen first (74 edges).** The IR must not import the legacy
   backend; each edge is either a shared type (move to `src/shared/`), a
   helper both need (move to `src/backend/wasmgc/`), or a real dependency
   inversion (inject via the `IrBackend` interface). List the 74 edges in a
   follow-up slice issue with an owner each.
3. **Directory budget for `src/codegen/`.** A `check:flat-dir-budget` that
   fails when `src/codegen/*.ts` (non-recursive) grows; new files go into the
   sub-directories the layout already has.
4. Put `check:godfiles` in `quality` (after refreshing its baseline in the
   same PR — it is red today), or delete it.

## Acceptance

- `pnpm run check:import-cycles` exists, is required in `quality`, and its
  baseline is committed with the numbers above.
- ir → codegen value-import count reaches 0 (tracked in the baseline);
  `docs/architecture/codegen-axes.md` gets a "how to verify" line pointing at
  the script.
- `src/codegen/` flat file count does not grow.
