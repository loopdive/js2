---
id: 2857
title: "IR: drive class-method fallback bucket to zero (#1370 Phase C/D/E residual)"
status: ready
sprint: current
created: 2026-06-30
updated: 2026-07-02
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: feature
area: ir, codegen
language_feature: classes
goal: ir-full-coverage
parent: 2855
related: [1370]
---

# #2857 — IR: `class-method` → 0

Child of the IR front-end migration epic **#2855**. Completes the class-member
adoption that **#1370 started**.

## Problem

**#1370 is `done`** but only landed Phase A (selector) + Phase B (instance
methods). Constructors (Phase C), static-method bodies, getters/setters, private
fields, and inheritance/`super` (Phase D/E) were explicitly **deferred** and
still demote to the legacy class-bodies path with reason `class-method`.

## Live snapshot (verified `origin/main` @ dc29fd081, 2026-06-30)

`pnpm run check:ir-fallbacks -- --verbose` → **`class-method: 6`**, all in
`website/playground/examples/js/classes.ts`. That file exercises exactly the
deferred shapes: `#name`/`#age` private fields, `get name()` / `set name()`
accessors, a `constructor`, a `static kingdom()`, and `Dog extends Animal`
inheritance with `super`.

## Covered residual sub-features (from #1370 deferred phases)

- **Phase C — constructor body**: `struct.new $ClassName` + `__self` binding +
  `this.field = expr` lowering + implicit `return $self`. Detailed legacy recipe
  and IR approach are documented in **#1370** under "Phase C Notes" — reuse it.
- **Static-method bodies**: same funcMap key shape `${className}_${method}` but
  no `self` injection — skip the `selfParam` option when the member is static.
- **Getters / setters**: accessor declarations currently bucket as
  `class-method`; need IR claim + lowering.
- **Private fields (`#x`)**: non-exported struct slots; ensure IR `class.get` /
  `class.set` resolves the private-name field index.
- **Phase E — inheritance / `super`**: parent struct field-prefix layout and
  `super(...)` / `super.method()`. Largest sub-piece — may warrant its own slice.

## Approach

1. Land **static methods** first (smallest — Phase B infra already claims them
   in the selector; just thread the no-`self` path through integration).
2. Land **constructors** (Phase C) per the #1370 recipe — re-run the gate.
3. Land **accessors + private fields**.
4. Land **inheritance / `super`** (Phase E) — consider splitting to a follow-up
   if it grows past one PR.
5. After each slice: `pnpm run check:ir-fallbacks -- --update-on-decrease`,
   commit the lowered baseline.
6. At `class-method: 0`, add `"class-method"` to `STRICT_IR_REASONS`
   (`src/codegen/index.ts:1013`) and promote the `ClassDeclaration` /
   `MethodDeclaration` / `ConstructorDeclaration` / accessor rows in
   `plan/log/ir-adoption.md`.

## Acceptance criteria

1. `class-method` count in `scripts/ir-fallback-baseline.json` is `0`.
2. `website/playground/examples/js/classes.ts` compiles fully via IR (no
   `class-method` fallback for any member).
3. Equivalence tests for constructors, accessors, static methods, private
   fields, and inheritance pass (legacy/IR parity) — reuse the #1370 probes.
4. `"class-method"` added to `STRICT_IR_REASONS` once the bucket is zero.
5. No regression in `tests/ir-*.test.ts` or class equivalence suites.

## Files

- `src/ir/from-ast.ts` — constructor / accessor / static / `super` lowering.
- `src/ir/integration.ts` — class-member walk for the residual member kinds;
  signature-parity guard (already present for instance methods).
- `src/ir/select.ts` — relax the `class-method` rejection as each shape lands.
- `scripts/ir-fallback-baseline.json` — ratchet down.
- `src/codegen/index.ts:1013` — `STRICT_IR_REASONS` once at zero.
- `plan/log/ir-adoption.md` — promote rows.

## Banked triage (2026-07-02, dev-2912f — pre-gate prep for the #2856-sequenced dispatch)

`JS2WASM_IR_SHAPE_DIAG=1 check:ir-fallbacks --shape-diag` snapshot (main
`46e390c`-era): the `class-method` bucket is **6**, all in
`website/playground/examples/js/classes.ts` (the #1370 Phase C/D/E residual
this issue targets). Overall corpus context: 32 `body-shape-rejected`
attributions dominated by `vardecl-init-expr:PropertyAccessExpression` (13 —
host-global member access, dev-2856f's extern-in-IR dependency), then
`vardecl-init-expr:CallExpression` (4), `unattributed-arm:helper-internal`
(4), `body-unhandled-stmt:IfStatement` (3). Use `--shape-diag` per-function
attribution for the initial triage once the extern-in-IR gate clears.
