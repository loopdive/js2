---
id: 1921
title: "Replace the 'Codegen error:' string-prefix compile-failure gate with structured severity"
status: done
sprint: 63
created: 2026-06-10
updated: 2026-06-16
completed: 2026-06-16
assignee: ttraenkler/tld-1921
priority: high
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: compiler
language_feature: compiler-internals
goal: correctness
---
# #1921 — Structured compile-failure gate

## Problem

Whether a codegen diagnostic **fails the build** is decided by a string
prefix: `compiler.ts:731` bails only when a message
`startsWith("Codegen error:")`. The consequences:

- A plain `reportError(..., "Unsupported expression: X")`
  (`src/codegen/expressions.ts:1274`) pushes a severity-`"error"`
  diagnostic, the expression compiles to `null`, the stack balancer patches
  the hole with a default value (#1918), and `compileCore` still returns
  **`success: true`** (`compiler.ts:877`) with the wrong value baked in.
- 177 `reportError` sites; ~118 "Unsupported …" messages are on the soft
  path. Failing vs silently degrading depends on whether the author
  remembered the magic prefix.
- `generateModule` wraps the whole pipeline in one try/catch that flattens
  any exception into a single locationless "Codegen error"
  (`index.ts:1576-1578`).

`CodegenError` already has a `severity?` field (`context/errors.ts:29-36`) —
the gate just doesn't use it.

## Proposed approach

1. Gate on severity, not message text: any `severity: "error"` diagnostic ⇒
   `success: false`. Introduce `severity: "degrade"` for the (few,
   deliberate) cases where compile-with-fallback-value is intended, each with
   a tracking-issue reference (mirror the host-import allowlist discipline).
2. Sweep the 177 `reportError` sites: classify each as error vs degrade.
   Expect most "Unsupported …" sites to become hard errors; run test262
   sharded CI to quantify the conformance delta and whitelist deliberate
   degrades.
3. Preserve the exception catch-all but attach `lastKnownNode` position
   instead of locationless line 1.

## Acceptance criteria

- `git grep 'startsWith("Codegen error'` is empty; gate reads severity.
- An "Unsupported expression" input returns `success: false` (regression
  test) unless explicitly degrade-listed.
- test262 net impact reviewed and accepted in the PR (some currently-"passing"
  tests may legitimately flip to compile errors — that is the honest result).

## Resolution (2026-06-16)

The compile-failure gate now keys on diagnostic **severity**, not on a
`"Codegen error:"` message prefix.

- **`src/codegen/context/types.ts`** — `CodegenError.severity` gains a third
  value `"degrade"` (deliberate compile-with-fallback-value), alongside
  `"error"` / `"warning"`. Doc-comment spells out the gate contract.
- **`src/codegen/context/errors.ts`** — `reportError` / `reportErrorNoNode`
  now stamp `severity` (default `"error"`) on every diagnostic they push, so
  omitting the magic prefix no longer silently downgrades a real error. New
  exported helper `isFatalCodegenDiagnostic(err)` — fatal iff
  `(severity ?? "error") === "error"`; `"warning"` and `"degrade"` are
  non-fatal. An *omitted* severity is treated as fatal so a forgotten
  classification fails loudly.
- **`src/compiler.ts`** (3 gate sites) and **`src/compiler/output.ts`**
  (1 site) — the four `result.errors.some(err => err.message.startsWith(
  "Codegen error:"))` gates are replaced with
  `result.errors.some(isFatalCodegenDiagnostic)`. A deliberate `"degrade"`
  diagnostic is surfaced to the user as a non-fatal `"warning"` (the
  external `CompileError.severity` only models `"error" | "warning"`). The
  linear-backend message normalization keeps the cosmetic `"Codegen error:"`
  prefix via a named `withCodegenPrefix` helper so the gate-pattern grep is
  clean.
- **`src/ir/types.ts`** — `WasmModule.codegenErrors` element type gains the
  optional `severity` field so the linear backend can carry it through.

The exception catch-all (`index.ts`) already routes through
`reportErrorNoNode`, which attaches `ctx.lastKnownNode` position instead of a
locationless line 1 — satisfying approach point 3.

The full 177-site error/degrade reclassification (approach step 2) is left to
follow-up: this PR flips the *mechanism* (so any omitted/`"error"` diagnostic
is now fatal) and lets test262 sharded CI quantify the conformance delta.
Deliberate degrade sites can be opted out incrementally by passing
`"degrade"` to `reportError`, each with a tracking-issue reference.

## Test Results

- `tests/issue-1921.test.ts` — 3/3 pass:
  - A `satisfies` expression (hits the `Unsupported expression:
    SatisfiesExpression` catch-all at `src/codegen/expressions.ts:1302`, the
    exact site named in the problem statement) now returns `success: false`.
    On `origin/main` the same input returned `success: true` with the
    `[error]`-severity diagnostic already present but ignored by the prefix
    gate — the precise silent-degrade bug.
  - `isFatalCodegenDiagnostic` unit cases (`error`/omitted → fatal,
    `warning`/`degrade` → non-fatal).
  - A well-formed standalone program still compiles, validates, and runs
    (gate is not over-eager).
- `git grep 'startsWith("Codegen error'` over `src/` is empty (criterion 1).
- `npm run typecheck` and `npm run lint` (Biome) clean.
- Behavioral equivalence suites and the test262 conformance delta are left to
  CI: this container cannot stub the host-mode `env`/`string_constants`
  imports, so host-mode instantiation fails identically on `origin/main`
  (verified) — not a regression from this change.

## Source

Compiler quality review 2026-06. Direct child of #1858. Related: #1918,
#1853 (hard-error stability bucket).
