---
id: 6776
title: "codegen: emitted modules are not validated by default — a type-confused lowering ships as `success: true` and the engine rejects the binary"
status: done
sprint: Backlog
created: 2026-09-30
updated: 2026-10-01
completed: 2026-10-01
assignee: "ttraenkler/claude-dev-6776"
branch: "claude/issue-6776-validate-emitted-module"
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

## Implementation Plan

1. **One gate, one exit.** `gateEmittedModule(binary, options, errors, anchor)`
   in `src/compiler/validation.ts` replaces the opt-in block at the end of
   `finalizePipelineModule` (`src/compiler.ts`, step 8). Every driver —
   `compileSourceSync` / `compileSource` / `compileMultiSource` /
   `compileFilesSource` — returns through that function, so `compile()`,
   `compileMulti()`, `compileFiles()`, `compileProject()` and the incremental
   compiler are all covered by the same check.
   - Skipped only for `validate: false` (or an empty binary).
   - No `WebAssembly.validate` in the host → `validation-skipped` warning,
     compile still succeeds.
   - Otherwise `validateEmittedBinary` (the existing #4420 helper: `validate`,
     then `new WebAssembly.Module` in a try to recover the engine message). A
     rejection pushes `{ severity: "error", code: "invalid-module", message:
     "emitted WebAssembly failed validation — <engine message>" }` and sets
     `success: false`. The binary is still returned.
2. `CompileError.code` widened to `number | string`; `pushSourceAnchoredDiagnostic`
   takes an optional `code`. `CompileOptions.validate` JSDoc rewritten: default
   on, `validate: false` is the opt-out, and when to use it.
3. **Callers that check the bytes themselves opt out explicitly.**
   - test262 workers and runners (`scripts/test262-worker.mjs` — all honest,
     fixture-graph, linked-body and Temporal compile sites plus the WAT re-compile
     in `buildInvalidBinaryError`; `scripts/compiler-fork-worker.mjs`;
     `tests/test262-runner.ts` ×3; `tests/test262-shared.ts` fixture path). See
     Resolution for why.
   - The runtime `eval` / `new Function` shims (`src/runtime-eval.ts`): both
     build the `WebAssembly.Module` themselves and map a rejection to
     `SyntaxError`. With the gate on, an engine-rejected expression form would
     have fallen through to the statement-form retry and returned `undefined`.
   - Harness-provider and Temporal-provider builds keep the default: they are
     one-time builds whose failure is already loud, and their cache keys stay
     unchanged.
4. **Compile-time benchmarks pass `validate: false`** so published compile
   timings keep their meaning: `benchmarks/harness.ts`, `benchmarks/perf-suite.ts`,
   `benchmarks/pako-bench.ts`, `benchmarks/react-scheduler-bench.ts`,
   `benchmarks/react-reconciler-bench.ts`, `scripts/run-benchmarks.ts` (×2),
   `scripts/benchmark-landing-four-lane.mts` (js2CompileMs),
   `scripts/benchmark-landing-four-lane-worker.mts` (js2CompileMs plus the
   linear source-to-IR phase, whose recorded `js2CompileOptions` provenance now
   names `validate: false`), `scripts/benchmark-porffor-direct-ab-worker.mts`
   (linear source phase plus provenance). `scripts/check-harness-compile-budget.ts`
   counts `forEachChild` work rather than time, so it is unchanged.
5. **CLI** (`src/cli.ts`). A codegen-invalid module now fails in the compile
   and is reported through the existing `!result.success` path, which prints
   the `invalid-module` message. The CLI's own `validateEmittedBinary` check is
   kept on purpose: it checks the final artifact, and a
   `--package-linking merge` bundle is assembled after the compile pipeline.
   Only the stale "opt-in" comment changed.
6. `src/optimize.ts` is deliberately untouched. Any edit to it invalidates the
   `optional-binaryen-provider-v1` content-hash receipt in
   `scripts/compiler-extension-boundaries.json` and fails `check:dead-exports`.
   The "no WebAssembly global" detection therefore lives in the gate instead.

## Resolution

**Probes** (`compile()` against this worktree, before and after the change):

| probe | before | after (default) | after, `validate: false` |
|---|---|---|---|
| WasmGC `2 in arr` | `success: true`, engine rejects | `success: false`, `invalid-module`: `Compiling function #7:"run" failed: struct.get[0] expected type (ref null 2), found local.get of t…` | `success: true` (old behaviour) |
| linear `"1" + 2` | `success: true`, engine rejects | `success: false`, `invalid-module`: `Compiling function #50:"f" failed: f64.add[0] expected type f64, found if of type i32 @+4201` | `success: true` |
| known-good `add` | `success: true` | `success: true`, no `invalid-module` | `success: true` |

The two lowering bugs are still open (#6777, #6778).

**Test** — `tests/issue-6776-validate-by-default.test.ts` (7 cases):
- A test hook (`vi.mock` on `src/emit/binary.js`) injects one `drop` onto an
  empty stack. Default `compile` returns `success: false` with exactly one
  `invalid-module` error that names `drop`. `compileMulti` goes through the
  same gate. With `validate: false` the compile reports success and
  `new WebAssembly.Module` throws `CompileError` (the old behaviour).
- The two review probes assert that the compile verdict agrees with the
  engine's verdict on the `validate: false` bytes. Today that means
  `success: false` and an `invalid-module` message containing the engine
  detail. The test is written this way so it keeps passing once #6777 or #6778
  makes a probe valid.
- A known-good program compiles with no `invalid-module` entry.
- A host with `WebAssembly` stubbed out gets a `validation-skipped` warning.

**test262 classification** (measured against the 2026-10-01 baseline JSONL,
48,735 rows, and test262 frontmatter at the pinned submodule SHA). 59 host
rows fail today as `compile_error` with `invalid Wasm binary (…)`:
- 58 are positive tests. With the gate on they would stay `compile_error`; only
  the message changes, and it still contains `Compiling function …`, so the
  `wasm_compile` error category is unchanged.
- 1 is a negative parse/SyntaxError test:
  `language/expressions/in/private-field-in-nested.js`. With the gate on, the
  workers' negative compile-FAILED arm accepts any compile error for a
  `SyntaxError` negative (`negativeCompileErrorMatches`), so this row would
  flip `compile_error` → **pass** without the early error ever being detected —
  the incidental-pass pattern from #2920.
- The test262 workers therefore pass `validate: false`. They already validate
  the bytes themselves, with a source-mapped line and a WAT snippet. Net effect:
  **zero rows reclassified, no oracle bump.** The runner's own `malformed_wasm`
  hard-error bucket also keeps seeing these rows.

**Other suites**
- `pnpm run -s test:guard`: 20 files, 255 tests, exit 0.
- `tests/issue-4420-emitted-binary-validation.test.ts` and
  `tests/issue-3338-cli-refuse-invalid-wasm.test.ts`: 9/9 pass. The CLI still
  refuses invalid output, now with the compile's `invalid-module` message.
- 113 test files that assert `success` without instantiating were run twice,
  with the new default and with a base-equivalent opt-in gate. Under heavy
  shared-box load: 80 failures with the new default vs 86 with the base gate,
  and these failures come from the environment (no test262 checkout, no built
  compiler bundle, timeouts). Exactly one test failed only under the new
  default: `issue-4394 … seeds each top-level function name` (10.7 s). It
  passes when run alone, so it was a load timeout.

**Gates.** All exit 0, re-run after merging `origin/main` at 3444df3d.
- Budgets: check-loc-budget and check-func-budget, at the merge-base and with
  `LOC_GATE_BASE=origin/main`; check-coercion-sites.
- `check-compiler-boundaries --mode inventory --base origin/main`.
- `check:` gates: oracle-ratchet, dead-exports, ir-dialect,
  ir-kind-neutrality, jstag-seam, ir-layering, codegen-fallbacks,
  any-box-sites, speculative-rollback, stack-balance, pushraw,
  host-import-policy, ir-only, ir-adoption, issues, done-status-integrity,
  issue-spec-coverage, harness-compile-budget, verdict-oracle,
  test-vacuity-shapes, ir-fallbacks.
- lint, typecheck, format:check (run by hand: the pre-push copy timed out
  under load), and the pre-push hook (typecheck, lint, oracle ratchet,
  coercion sites, numeric-local IR parity, issue integrity).
- No LOC or function budget allowance was needed.

**Left out on purpose**
- The `--package-linking merge` bundle and `compileToObject` (`.o` relocatable
  output) are produced outside `finalizePipelineModule` and are not gated here.
  The CLI's final-artifact check still covers the merged bundle.
- Item 3's "fall back to the repo's structural checker" when `WebAssembly` is
  absent: there is no runtime-shippable structural validator
  (`scripts/check-stack-balance.ts` is a dev script), so the warning path is
  used instead.
