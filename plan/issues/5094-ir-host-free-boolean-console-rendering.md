---
id: 5094
title: "IR: render branded booleans through the host-free standalone console sink"
status: in-progress
created: 2026-08-27
updated: 2026-08-27
assignee: ttraenkler/codex
branch: codex/5094-ir-host-free-boolean-console
priority: high
horizon: s
feasibility: high
reasoning_effort: max
task_type: refactor
area: ir, codegen
language_feature: console
goal: ir-full-coverage
depends_on: [4462, 4503]
related: [2961, 3143, 3469]
files:
  - src/ir/from-ast.ts
  - tests/issue-5094-ir-host-free-boolean-console.test.ts
loc-budget-allow:
  # The existing host-free console renderer is the single owner of converting
  # lowered argument carriers to strings. The new boolean arm belongs beside
  # its string/f64/i32 arms so claim and rendering cannot drift.
  - src/ir/from-ast.ts
func-budget-allow:
  # One exact branded-i32 dispatch arm reusing #4503's canonical renderer.
  - src/ir/from-ast.ts::lowerHostFreeConsoleArgument
---

# #5094 — Host-free standalone console rendering for branded booleans

## Objective

Move exact boolean `console.log|warn|error|info|debug` statements in prepared
standalone functions from direct codegen to the existing IR-first host-free
console path. Render JavaScript booleans as `"true"` / `"false"`, preserve a
zero-import module, and keep all unsupported shapes outside the claim boundary.

## Current fact and direct-codegen residual

#4462 gave standalone IR a host-free console sink and string/number argument
rendering. Its measured residual is explicit: branded boolean `i32` values are
rejected in `src/ir/from-ast.ts::lowerHostFreeConsoleArgument` because printing
the carrier as an integer would produce `1` / `0` instead of JavaScript's
`true` / `false` spelling.

When that IR build rejects, the body is emitted by the direct path:

1. `src/codegen/expressions/calls.ts` recognizes ambient `console.<method>`;
2. `src/codegen/expressions/builtins.ts::compileConsoleCall` selects standalone
   output handling;
3. `src/codegen/native-strings.ts::emitStandaloneStdoutAppendValue` services
   the legacy sink.

This remains useful IR migration work: selection already names the exact
console surface, the sink already has an IR runtime binding, and #4503 already
owns the canonical boolean-to-string semantics. The missing work is one honest
carrier arm, not a new console subsystem.

## Existing ownership to reuse

- `irTypeIsBoolean` proves the shared `i32` carrier carries a JavaScript
  boolean; an unbranded `i32` remains numeric.
- `lowerBooleanToString` emits a lazy value-position IR `if` selecting native
  string constants `"true"` and `"false"`.
- `lowerHostFreeConsoleCall` appends the rendered value plus one newline through
  `IR_CONSOLE_SINK_APPEND_FN` / `__stdout_acc`.
- `consoleSurfaceCapability` and the existing selector already restrict the
  surface to an available host-free sink, an ambient unshadowed console, the
  five supported methods, statement position, and exactly one argument.

No selector widening is required. The selected shape already reaches the
builder; today only its branded-boolean carrier demotes.

## Bounded implementation plan

1. In `lowerHostFreeConsoleArgument`, check `irTypeIsBoolean(valueType)` before
   the unbranded-i32 numeric arm and delegate to
   `lowerBooleanToString(cx.builder, value)`.
2. Keep dispatch on the lowered IR type. Do not use checker type guesses and do
   not treat every `i32` as boolean.
3. Add a focused issue test that compiles a single prepared standalone `main`
   containing exact branded boolean producers and all five console methods.
4. Drain the existing host-free stdout exports and assert JavaScript spelling,
   newline behavior, zero imports, successful IR emission, and
   `legacyBodyEmitted: false`.
5. Add negative boundary cases for an unbranded integer (still numeric) and a
   shape the existing selector excludes, proving no accidental claim widening.
6. Pin both controls: `experimentalIR: false` must restore the direct body, and
   the global `JS2WASM_IR_FIRST=0` control must not leave an IR-only dependency
   in the legacy path.

## Acceptance criteria

- Standalone output for representative exact producers is
  `true\nfalse\ntrue\nfalse\n1\n` and matches Node's boolean spelling.
- The compiled Wasm module has zero imports.
- The prepared `main` outcome is `emitted`, with `irBodyEmitted: true` and
  `legacyBodyEmitted: false` when IR is enabled.
- No `irPostClaimErrors` or invariant outcomes are recorded.
- `experimentalIR: false` compiles and executes through the direct path.
- Existing #4462 console tests and #4503 boolean-brand tests remain green.
- Typecheck, formatting, lint, and repository IR ratchets pass.

## Non-goals

- Multi-argument or zero-argument console calls.
- Console calls used in expression position.
- Shadowed/local `console` bindings or methods outside
  `log|warn|error|info|debug`.
- Dynamic, `any`, `unknown`, union, boxed/reference, or conditional argument
  rendering beyond carriers already proven boolean by the IR brand.
- Module-init ownership, WASI output, JavaScript-host console imports, or
  changing the direct-codegen fallback.
- Adding a new boolean runtime formatter, boxed-dynamic representation, or a
  new IR boolean type.

## Risk and refusal contract

The only semantic hazard is confusing a native integer with a JavaScript
boolean. The arm therefore keys exclusively on `irTypeIsBoolean`; absence of
the brand is not proof of boolean-ness. Every other carrier continues through
the existing string/number arms or the typed unsupported channel. This keeps
wrong output impossible while preserving the current fallback boundary.
