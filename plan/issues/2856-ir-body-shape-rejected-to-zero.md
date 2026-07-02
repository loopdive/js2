---
id: 2856
title: "IR: drive body-shape-rejected fallback bucket to zero (dominant unintended bucket)"
status: ready
sprint: current
created: 2026-06-30
updated: 2026-06-30
priority: low
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
2. **Land the highest-count kind first.** Per the Step-1 histogram (below,
   2026-07-02) the highest-count arm is **host-global member access in `const`
   initializers** (`vardecl-init-expr:PropertyAccessExpression` 13 +
   `CallExpression` 4 = **17/31, 55%**) — `document.*`/`window.*`/`Math.*`/
   `performance.*` receivers not in scope. **This is the approved first slice
   (2026-07-02).** Add IR selector + `from-ast.ts` handling for host-global
   receivers (a resolver notion of host globals whose member access lowers to
   the existing extern-member path), with legacy-parity equivalence coverage.
   **Mutable-assignment is demoted to the SECOND slice** (the original heuristic
   over-weighted it — the recorder shows **0** mutable-assignment rejections in
   this corpus). NB: this slice may reveal that some host-global access is
   legitimately out-of-IR-scope (no closed shape) — if so, split those into a
   `deferred`-category note rather than forcing them native.
3. **Re-run the gate after each slice** and bank the decrease:
   `pnpm run check:ir-fallbacks -- --update-on-decrease`, commit the lowered
   `scripts/ir-fallback-baseline.json`. **Verify adopted functions actually take
   the IR path** — re-run the `--shape-diag` recorder / `trackFallbacks` and
   confirm the target functions leave the `body-shape-rejected` set, not merely
   that tests stay green (the hazard is a silent legacy-fallback that keeps tests
   green while the IR path is NOT exercised).
4. When the bucket reaches **0**, add `"body-shape-rejected"` to
   `STRICT_IR_REASONS` (`src/codegen/index.ts:1013`) and promote the affected
   rows in `plan/log/ir-adoption.md` (`pnpm run gen:ir-adoption`).

**Slice order (re-scoped 2026-07-02, PO/lead approved):**

1. **Host-global member access in const initializers** (17/31) — FIRST.
2. Mutable-assignment / element-assignment — SECOND (0 hits in this corpus, but
   kept for the broader IR surface).
3. `vardecl-typenode:ArrayType` (2), body/tail `if`-statement arms (4), the 4
   `unattributed-arm` class-member helper internals — later, smaller slices.

## Step-1 diagnostic pass (2026-07-01, dev-b) — hypothesis CORRECTED

Ran a non-invasive diagnostic (reuses the real `planIrCompilation` selector to
identify the 31 `body-shape-rejected` functions, then classifies each body):

**Key correction — the "Likely covered kinds" hypothesis above is WRONG.** All
31 rejected functions have **only Phase-1-ACCEPTED top-level statement kinds**.
**Zero** of them contain a `SwitchStatement`, `BreakStatement`,
`ContinueStatement`, `DoStatement`, `LabeledStatement`, or `ForInStatement` — at
top level OR nested. So this bucket is **not** driven by unhandled statement
_kinds_; it is driven by inner **expression/statement SHAPE** rejections inside
otherwise-accepted statements.

Approximate cause histogram (heuristic — a function can carry >1 tag; derived
directly from the `isPhase1Expr` / `isPhase1StatementList` reject arms):

| cause                                                         | ~fns   | reject arm                                                                                                                                            |
| ------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stmt: local reassignment` `x = e;` (LHS not property-access) | ~10    | `isPhase1StatementList` accepts `=` only when LHS is a PropertyAccess (line ~824)                                                                     |
| `guard: C-style loop + array literal` (#1804)                 | 5      | `isPhase1Expr` array-literal arm withholds when `currentFnHasCStyleLoop` (line ~1761)                                                                 |
| `expr: closure value` (arrow / function expression)           | 3      | no `isPhase1Expr` arm for ArrowFunction/FunctionExpression                                                                                            |
| `op: %` (remainder)                                           | 2      | `isPhase1BinaryOp` rejects `%`                                                                                                                        |
| `stmt: if/else @ non-tail`                                    | 2      | non-tail loop accepts only `if` WITHOUT else (line ~842)                                                                                              |
| `stmt: ++/--`                                                 | 1      | no ExpressionStatement arm for postfix/prefix inc-dec                                                                                                 |
| `stmt: element assignment` `arr[i] = e;`                      | 1      | same `=` arm — ElementAccess LHS not accepted                                                                                                         |
| `op: instanceof`                                              | 1      | `isPhase1BinaryOp` rejects `instanceof`                                                                                                               |
| **unclassified by the heuristic**                             | **17** | needs the selector's own verdict (bare/multiple non-tail returns, var-decl with non-Phase-1 / non-resolvable initializer, unsupported tail shapes, …) |

**The heuristic explains ~14/31; 17 remain unclassified.** An EXACT per-cause
histogram requires **opt-in selector instrumentation** — thread an
"offending-node" recorder through the `return false` sites of
`isPhase1StatementList` / `isPhase1Expr` (behaviour unchanged when the recorder
is off) and surface it via `planIrCompilation`'s fallbacks, then have
`scripts/check-ir-fallbacks.ts` print the node-kind. That instrumentation is the
concrete Step-1 implementation (was mis-scoped as "just print the kind"; the
kinds are all accepted — it must print the _reject-arm/shape_).

**Recommended first kind-slice** (highest lever, once instrumentation confirms):
statement-level **mutable assignment** — `x = e;` and `arr[i] = e;` — which the
heuristic attributes to ~11 functions. NB this is a substantial IR change
(mutable-local versioning / element-store lowering in `from-ast.ts`), not a
quick win; size it as its own PR with legacy/IR equivalence parity.

Diagnostic script kept at `.tmp/diagnose-body-shape.mjs` (heuristic; not
committed — the exact instrumentation supersedes it). Routing: this epic needs
`senior-developer` for the selector instrumentation + the mutable-assignment IR
lowering.

## Step-1 diagnostic DONE (2026-07-02, sr-funcidx) — heuristic OVERTURNED

Implemented the opt-in reject-arm recorder (`shapeNo`/`takeShapeRejectDetail` in
`src/ir/select.ts`, gated on `JS2WASM_IR_SHAPE_DIAG=1`, byte-inert when off) and a
`--shape-diag` mode in `scripts/check-ir-fallbacks.ts`. Every instrumented
`return false` in the Phase-1 shape gate (`isPhase1StatementList`,
`isPhase1VarDecl`, `isPhase1Expr`, `isPhase1Tail`, `isPhase1BodyStatement`) records
its `"<arm>:<NodeKind>"`; the FIRST (deepest) wins.

Run: `JS2WASM_IR_SHAPE_DIAG=1 pnpm run check:ir-fallbacks -- --shape-diag`.

**Exact histogram (31/31 attributed) — the "mutable assignment ~11 + 17
unclassified" heuristic was WRONG:**

| count | reject arm                                   | meaning                                                                                                                                                                  |
| ----- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 13    | `vardecl-init-expr:PropertyAccessExpression` | `const x = <host-global>.<prop>` — receiver identifier not in scope (`document.*`, `window.*`, `Math.*`, DOM globals)                                                    |
| 4     | `vardecl-init-expr:CallExpression`           | `const x = <host-global-or-method>(...)` — call receiver/callee not IR-claimable                                                                                         |
| 4     | `unattributed-arm:helper-internal`           | class-member reject inside an as-yet-uninstrumented helper (`isPhase1ObjectLiteral`/`TryStatement`/`ClosureLiteral`/`ForStatement` internals) — Step-1b to sub-attribute |
| 3     | `body-unhandled-stmt:IfStatement`            | `if` in a constructor/body-statement position (non-tail body list)                                                                                                       |
| 2     | `vardecl-typenode:ArrayType`                 | `const x: number[] = …` — `isPhase1TypeNode` rejects the array annotation                                                                                                |
| 2     | `nontail-callstmt:CallExpression`            | non-tail call statement whose call isn't IR-claimable                                                                                                                    |
| 1     | `tail-unhandled:ExpressionStatement`         | non-void tail expression statement                                                                                                                                       |
| 1     | `nontail-if-cond:BinaryExpression`           | `if` condition expr not Phase-1                                                                                                                                          |
| 1     | `nontail-unhandled-stmt:IfStatement`         | `if`-with-`else` at a non-tail (non-early-return) position                                                                                                               |

**Key finding — the corpus is DOM / benchmark code dominated by host-global
member access (`document`/`window`/`Math`/`performance`), NOT the compiler-
internal statement-kind gaps the issue originally hypothesised, and NOT
mutable-assignment (0 hits).** So driving THIS corpus's `body-shape-rejected` to
zero is mostly about **host-global member access in `const` initializers** (17 of
31 = 55%), not a `from-ast.ts` statement handler. That is a very different (and
larger / possibly out-of-IR-scope) problem than a kind-slice — it likely needs a
resolver notion of host-global receivers, or the corpus/gate scope revisited.
**Recommend PO/architect re-scope #2856 around this finding before any lowering
slice.**

**Verification:** the `check:ir-fallbacks` gate is byte-unchanged with the
recorder off (`body-shape-rejected: 31`, "IR fallback gate: OK"); typecheck
clean; behaviour-neutral (identical IR-test pass/fail counts with vs. without the
instrumentation — the ~28 pre-existing `ir-*-equivalence` failures in this
container are unrelated and present on the pristine base).

### Remaining (Step-1b, small)

Instrument the 4 `unattributed-arm` helper internals (`isPhase1ObjectLiteral`,
`isPhase1TryStatement`, `isPhase1ClosureLiteral`, `isPhase1ForStatement`
internals) for full sub-attribution of the class-member rejects.

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
