---
id: 4539
title: "Linear lane link topology: extern-C import declarations, emit imports at all, import the memory instead of defining it"
status: done
sprint: Backlog
# The substantive code lands in c-abi.ts (not a god-file). What remains is
# wiring that can only live where the module is constructed: +24 in
# codegen-linear/index.ts (the two LinearOptions fields and the
# declare-imports-first calls, which MUST precede any runtime function) and +7
# in runtime.ts (the `skip defining memory when one is imported` guard inside
# addRuntime). Neither can move to a subsystem module without indirecting the
# construction order the gate exists to keep legible.
loc-budget-allow:
  - src/codegen-linear/index.ts
  - src/codegen-linear/runtime.ts
created: 2026-08-17
updated: 2026-08-17
completed: 2026-08-19
priority: high
horizon: l
feasibility: medium
model: fable
reasoning_effort: high
task_type: feature
area: codegen-linear
language_feature: compiler-internals
goal: standalone-mode
parent: 4538
related: [4236, 4540]
# id 4539 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-17 (gh CLI offline in this container; pr_scan=degraded). Equivalent
# open-PR scan via the GitHub MCP at reservation time: the sole open PR was
# 4638 (hooks-only; adds no issue file), so the id space was clear.
---

# #4539 — Linear lane link topology

Slice 1 of #4538. Implements handoff items 1–3 from #4236's slice-2 table.

## Problem

The linear backend cannot currently link against anything. Three concrete gaps,
all verified on main 2026-08-17 (cited by symbol — line numbers in this area
drift):

1. **No import direction.** `src/codegen-linear/c-abi.ts` models the
   export direction only. There is no way to declare an external C function the
   module *calls*.
2. **The lane emits zero imports.** Both `FunctionContext` initialisers in
   `src/codegen-linear/index.ts` hard-code `numImportFuncs: 0`, and every
   function-index computation is written as `ctx.numImportFuncs + …` — so the
   arithmetic is already parameterised, but the value is pinned at zero.
3. **The module defines and exports its own memory.** `addLinearRuntime` in
   `src/codegen-linear/runtime.ts` unconditionally pushes `(memory 1 256)` and
   exports it. The engine artifact **exports** memory, so a linked module must
   **import** it instead.

## Scope

- Add an extern-C **import** declaration table to `c-abi.ts`. This is cheap
  because every engine wrapper has signature `(i32…) -> i32 | f64 | i64`: the
  opaque handle is just an `i32` and needs no new `ValType`.
- Emit imports for real. Add them **before** codegen starts so the existing
  `ctx.numImportFuncs + …` arithmetic resolves correctly. **Do not** replicate
  the WasmGC lane's late `addUnionImports` index-shifting — that pattern exists
  there for historical reasons and shifting indices after the fact is exactly
  the bug class to avoid here.
- Make memory ownership a mode: define-and-export (today's standalone default)
  or import-from-the-engine. The `--link node:fs` shape in `src/codegen/wasi.ts`
  is the existing precedent for this topology on the WasmGC side; the linear
  lane has no analogue yet.
- Note that the current `max 256` pages (16 MiB) is below what an engine heap
  wants — the pinned artifact ships `initial 256 / max 16384`. Importing the
  memory makes this moot, but the define-path default should be revisited in
  the same pass rather than left as a latent ceiling.

## Acceptance criteria

- [x] A linear-target module can declare and call an imported C function, with
      correct function indices, verified by a decoded-module assertion.
- [x] A linear-target module can be emitted in import-memory mode and
      instantiate successfully against the pinned engine artifact.
- [x] Existing standalone output is **unchanged** when neither mode is
      requested — verified by `scripts/prove-emit-identity.mjs` against a
      pre-change baseline captured at the first edit.
- [x] The import path is exercised by a test that links the two modules and
      calls through, not merely by a unit test of the declaration table.

**All four criteria met (recorded 2026-08-19, post-merge).** Where each is
demonstrated, since three landed with this issue and the fourth arrived later:

- Declare + call an imported C function with correct indices, and the
  link-and-call-through test: `tests/issue-4539.test.ts` and
  `tests/issue-4539-c-link.test.ts` (the latter builds a real clang module).
- Standalone output unchanged: `prove-emit-identity`, 60/60 records identical.
- **Instantiate against the pinned engine artifact** — this one was NOT met when
  the rest landed, because no artifact existed here. It is met now via #4557,
  whose tests instantiate our module alongside the real `libquickjs.wasm`
  sharing one memory and run `eval` workloads through it. Ticked on that
  evidence rather than on this issue's own tests.

## Validation

- `pnpm run check:linear-ir`
- Emit-identity proof vs a baseline captured before the first edit (capture it
  up front — the revert copy makes every later base run one `cp` away).
- The `#4236` probe (`node scripts/quickjs-artifact/probe/probe.mjs`) still
  passes, since it shares the artifact this slice links against.

## Non-goals

- Any dynamic value representation — that is #4541. This slice only makes the
  module *linkable*.
- Arena relocation and data-segment safety — those are #4540, and a link that
  runs without them is expected to corrupt memory. Land them together before
  claiming any end-to-end result.
