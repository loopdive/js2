---
id: 3109
title: "Test-helper consolidation: 132 test files re-declare compileAndRun (10+ signature variants) across 292k test LOC"
status: ready
sprint: Backlog
created: 2026-07-09
updated: 2026-07-09
priority: medium
horizon: m
feasibility: easy
model: opus
reasoning_effort: medium
task_type: refactor
area: tests
language_feature: compiler-internals
goal: maintainability
related: [3102]
---

# #3109 — Consolidate duplicated test harness helpers

**Source:** 2026-07-09 compiler consolidation audit (fable-refactor). See
`plan/log/compiler-consolidation-plan.md`.

## Problem (measured)

`tests/` is 1,923 files / **292,655 LOC** — comparable to src/ itself — with
no shared compile-and-run harness:

- **132 test files define their own local `compileAndRun`**, in at least 10
  divergent signatures (`(source: string)` ×34, `: Promise<Record<string,
Function>>` ×13, `: Promise<any>` ×11, `: Promise<number>` ×9, result-object
  variants ×6, …).
- **793 test files** hand-roll the `compile(...)` → `buildImports`/
  `instantiateWasm` → export-call sequence inline.
- `tests/helpers/` exists but contains only `ir-fallbacks.ts` (19 LOC).

Each local copy re-implements the same 10–30 lines (compile, instantiate,
maybe setExports wiring for host closures — a known trap, see memory
`project_wrapforhost_setexports_harness`), and behavioral drift between
copies means two tests can disagree on what "run" means (e.g. whether
`callbackState.getExports` is wired), which produces confusing
false-negative repros.

## Fix

1. Add `tests/helpers/compile.ts` with the ~4 canonical shapes:

```ts
export async function compileAndInstantiate(src: string, opts?: CompileOpts): Promise<WebAssembly.Exports>;
export async function compileAndRun(src: string, entry = "main", opts?: CompileOpts): Promise<unknown>;
export async function compileAndRunStandalone(src: string, entry?: string): Promise<unknown>;
export async function compileExpectError(src: string): Promise<{ errors: string[] }>;
```

— implemented ONCE on top of `src/runtime.ts` `instantiateWasm`, with the
setExports/callbackState wiring done correctly by default. 2. Migrate mechanically, in batches of ~20 files per commit: delete the local
helper, import the shared one. **Only migrate files whose local copy is
semantically equivalent to a canonical shape** — a file whose helper does
something extra (custom import stubs, wasi polyfill knobs) keeps its local
helper (or passes the extra via `opts`). 3. New-test guidance: one line in `tests/README` (or CLAUDE.md tests section)
pointing at the helper.

## Safety story

Zero compiler-source changes — emitted Wasm untouched by construction. The
risk is _test semantics drift_ during migration; guard: each batch must keep
every migrated test green with **unchanged assertions** (vitest run scoped to
the batch). A test that fails after migration reveals its local helper was
NOT equivalent → revert that file from the batch and leave it local.

## Estimated LOC delta

≈ **−2,000 to −3,500** in tests/ (15–25 lines × 132 files, plus partial
adoption by the 793 inline sites in new/touched tests). More valuable:
one correct harness for host-closure wiring.

## Acceptance criteria

1. `tests/helpers/compile.ts` exists; ≥ 100 of the 132 local definitions removed.
2. Full vitest suite green with unchanged assertions.
3. No src/ changes in the PR(s).
