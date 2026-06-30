---
id: 2856
title: "IR: drive body-shape-rejected fallback bucket to zero (dominant unintended bucket)"
status: ready
sprint: current
created: 2026-06-30
updated: 2026-06-30
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: feature
area: ir, codegen
language_feature: compiler-internals
goal: ir-full-coverage
parent: 2855
related: [1376, 1131]
---

# #2856 — IR: `body-shape-rejected` → 0

Child of the IR front-end migration epic **#2855**. This is the **single
largest** unintended IR fallback bucket and the highest-value migration slice.

## Problem

`body-shape-rejected` is the `IrFallbackReason` raised when `from-ast.ts` cannot
lower _some statement or expression_ in a `FunctionDeclaration`'s body, so the
whole function demotes to the legacy direct-AST→Wasm path. Per
`plan/log/ir-adoption.md`, the bucket clears for a function only when
"`from-ast.ts` handles every statement in the body."

## Live snapshot (verified `origin/main` @ dc29fd081, 2026-06-30)

`pnpm run check:ir-fallbacks -- --verbose` → **`body-shape-rejected: 31`**
(matches `scripts/ir-fallback-baseline.json`). Per-file worklist:

| File                                                | count |
| --------------------------------------------------- | ----- |
| `website/playground/examples/dom/calendar.ts`       | 6     |
| `website/playground/examples/js/algorithms.ts`      | 5     |
| `website/playground/examples/benchmarks.ts`         | 4     |
| `website/playground/examples/js/classes.ts`         | 3     |
| `website/playground/examples/benchmarks/array.ts`   | 2     |
| `website/playground/examples/benchmarks/dom.ts`     | 2     |
| `website/playground/examples/benchmarks/style.ts`   | 2     |
| `website/playground/examples/js/builtins.ts`        | 2     |
| `website/playground/examples/benchmarks/fib.ts`     | 1     |
| `website/playground/examples/benchmarks/helpers.ts` | 1     |
| `website/playground/examples/benchmarks/loop.ts`    | 1     |
| `website/playground/examples/benchmarks/string.ts`  | 1     |
| `website/playground/examples/js/async.ts`           | 1     |

## Likely covered kinds (confirm during the diagnostic pass)

The bucket is heterogeneous. From the `mixed` / `direct-only` rows in
`plan/log/ir-adoption.md`, the statement/expression kinds that throw inside
`from-ast.ts` and most plausibly drive these 31 rejections:

- **Statements (direct-only — no IR handler):** `SwitchStatement`,
  `BreakStatement` / `ContinueStatement` (labeled + unlabeled), `DoStatement`,
  `LabeledStatement`, `ForInStatement`.
- **Expression shapes that throw (`mixed` rows):** `%`, `**`, `in`,
  `instanceof` in `BinaryExpression`; `~` / `typeof` partials in
  `PrefixUnaryExpression`; complex `TemplateExpression` interpolation; computed
  / empty `ObjectLiteralExpression`; spread / sparse / mixed-type
  `ArrayLiteralExpression`; non-reference (f64/i32) `null` context; optional
  `?.()` call forms.

## Approach (recommended decomposition)

This is too large for one PR. **Step 1 is a diagnostic pass**, then slice by
kind:

1. **Diagnostic pass (do first).** Run the example corpus with per-function
   reason logging (`JS2WASM_LOG_IR_FALLBACKS=1`, or extend
   `scripts/check-ir-fallbacks.ts` to print the _offending node kind_ per
   rejected function, not just the file count). Produce an exact kind→count
   histogram. **Append the histogram to this issue** so follow-up slices are
   precisely scoped. If the histogram shows several independent kinds, split
   this issue into per-kind child issues (one PR each) rather than a single
   mega-PR.
2. **Land the highest-count kind first** (likely `SwitchStatement` or a
   loop-control kind — confirm from the histogram). Add the `from-ast.ts`
   handler + selector acceptance + IR lowering, with legacy-parity equivalence
   coverage.
3. **Re-run the gate after each slice** and bank the decrease:
   `pnpm run check:ir-fallbacks -- --update-on-decrease`, commit the lowered
   `scripts/ir-fallback-baseline.json`.
4. When the bucket reaches **0**, add `"body-shape-rejected"` to
   `STRICT_IR_REASONS` (`src/codegen/index.ts:1013`) and promote the affected
   rows in `plan/log/ir-adoption.md` (`pnpm run gen:ir-adoption`).

## Acceptance criteria

1. `body-shape-rejected` count in `scripts/ir-fallback-baseline.json` is `0`
   (verify `pnpm run check:ir-fallbacks` reports the bucket gone).
2. The kind histogram from the diagnostic pass is recorded in this issue.
3. Equivalence tests for each newly-IR-claimed kind pass (legacy/IR parity).
4. `"body-shape-rejected"` is added to `STRICT_IR_REASONS` once the bucket is
   zero, so a regression hard-errors.
5. No regression in the existing IR test suite (`tests/ir-*.test.ts`) or
   test262 conformance.

## Files

- `src/ir/from-ast.ts` — add statement/expression handlers for the rejected kinds.
- `src/ir/select.ts` — relax the body-shape check as each kind is supported.
- `src/ir/lower.ts` / `src/ir/nodes.ts` — IR node types + Wasm lowering as needed.
- `scripts/check-ir-fallbacks.ts` — (diagnostic) per-node-kind reporting.
- `scripts/ir-fallback-baseline.json` — ratchet down as slices land.
- `src/codegen/index.ts:1013` — `STRICT_IR_REASONS` once at zero.
- `plan/log/ir-adoption.md` — promote rows (regenerated).
