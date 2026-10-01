---
id: 6776
title: "codegen: emitted modules are not validated by default — a type-confused lowering ships as `success: true` and the engine rejects the binary"
status: ready
sprint: Backlog
created: 2026-09-30
updated: 2026-09-30
priority: critical
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
language_feature: compiler-internals
goal: crash-free
related: [6777, 6778, 1868, 3775, 6414, 3162]
requested_by: ttraenkler/claude-review
origin: "2026-09-30 codebase review (plan/agent-context/claude-codebase-review-2026-09-30.md) — C1/C2"
---

# #6776 — validate the emitted module by default; an invalid binary is a compile failure

## Problem

`compile()` returns `success: true` with `errors: []` for programs whose
binary `WebAssembly.Module()` / `WebAssembly.compile()` rejects. Both backends
do it; two reproductions from the review, both against the built `dist/`:

| lane | source | engine verdict |
|---|---|---|
| WasmGC | `const arr: any[] = [1,2,3]; arr[5] = 9; return [2 in arr]` | `struct.get[0] expected type (ref null 2), found local.get of type (ref null 4)` |
| linear | `const s = "1" + 2; return s.length` (`target: "linear"`) | `f64.add[0] expected type f64, found if of type i32` |

The per-lowering bugs are #6777 (the `in` operator on array carriers) and
#6778 (linear mixed-operand `+`). This issue is the **policy** gap that let
both reach a green compile: output validation is opt-in.

## Evidence

- `src/index.ts:495-506` — validation is opt-in, documented as "validation
  costs a full engine decode".
- `src/compiler.ts:1025-1027` claims `collectLinearCodegenErrors` fails the
  compile "instead of emitting a structurally invalid binary (#1868)"; the
  linear probe above passes that collector.
- The CLI validates before writing (`src/cli.ts:551-558`), so the CLI user is
  protected and the **library** user is not — `compileAndInstantiate`, the
  playground, npm-compat harnesses and every `compile()` caller get a green
  result and a throw at instantiate time, attributed to the engine.
- History: #1040, #1062, #1226, #1287, #1601–#1604, #3162, #3775, #3908,
  #6414 are all "emits invalid wasm" bugs that were found late for this reason.

## Correction

1. Validate by default in `compile()` / `compileMulti()` / `compileFiles()`:
   `WebAssembly.validate(binary)` when a `WebAssembly` global exists; on
   failure, run `new WebAssembly.Module(binary)` inside a try to harvest the
   engine's message and push it as a `severity: "error"` diagnostic with
   `code: "invalid-module"`. `success` becomes `false`.
2. Keep an explicit `validate: false` opt-out for callers that measure
   compile time (benchmarks name it in their options, so the cost is visible).
3. Where no `WebAssembly` global exists (some worker/edge builds), fall back to
   the repo's own structural checker if one exists (`scripts/check-stack-balance.ts`
   family) or leave a `warnings` entry saying validation was skipped — never
   silently.
4. Wire the same check into the test helpers so every unit test that compiles
   also validates (`tests/helpers/*` compile helpers, the equivalence harness).

## Acceptance

- Both probes above return `success: false` with an `invalid-module` error
  naming the engine message.
- `compile(src, { validate: false })` preserves today's behaviour.
- A unit test asserts that a deliberately corrupted body (inject one bad
  instruction via a test hook) surfaces as a compile error, not as a throw at
  instantiate.
- Compile-time benchmark lanes pass `validate: false` explicitly and their
  numbers are unchanged.
