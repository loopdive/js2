---
id: 3214
title: "IR: first-class function values (pass a top-level function / arrow as a () => T argument)"
status: backlog
sprint: Backlog
created: 2026-07-13
updated: 2026-07-13
priority: medium
horizon: l
feasibility: hard
model: fable
reasoning_effort: high
task_type: feature
area: ir, codegen
language_feature: closures
goal: ir-full-coverage
parent: 2855
related: [2856, 1276, 1382]
---

# #3214 — IR: first-class function values

Child of the IR front-end migration epic **#2855**. A **bounded, broadly-useful**
capability surfaced while scoping the #2856 corpus (2026-07-13, opus-2856): the
IR front end cannot yet claim a function that **passes a top-level function or an
arrow as a `() => T` value** (a first-class function reference). This is
generally useful far beyond the corpus — but note it is **NOT bucket-serving on
its own** (see Scope).

## Motivating shapes (from the benchmark-harness corpus)

```ts
// benchmarks/*.ts main — passing a named top-level fn as () => number:
addBenchCard(wrap, "fib(30)", "…", bench_fib);

// benchmarks/helpers.ts addBenchCard — an arrow-closure value + its use:
card.addEventListener("click", () => {
  const v = fn();              // fn: () => number invoked
  out.textContent = v.toString();
});
```

`main` rejects at `nontail-callstmt:CallExpression` (the `addBenchCard(…,
bench_fib)` call is not IR-claimable because a function-valued argument has no IR
lowering); `addBenchCard` rejects at `expr-unhandled:ArrowFunction`.

## Prior art (reuse, don't reinvent)

`#1276` (HOF returning closure — function-valued module exports) and `#1382`
(wasm-closure ↔ host bridge) landed the closure/function-reference ABI in the
LEGACY backend (`closures.ts`, `builtin-fn-meta.ts`, `$__fn_wrap`). This issue
is the **IR front-end** adoption of that ABI: `select.ts` accepting a function
identifier / arrow as a `() => T` value, `from-ast.ts` lowering it to the same
closure-wrap the legacy backend emits (ABI/byte parity so a mixed IR/legacy
module links), and the call site (`fn()`) lowering to the closure-call path.

## Scope — bounded capability, NOT a `body-shape-rejected` drain

Verified against the corpus gate (opus-2856, #2856 Step-2 lineage): landing this
capability **alone does not reduce `body-shape-rejected`**. The benchmark `main`s
that need it ALSO need cross-module imported calls (ES-module IR, #1046) + DOM
host-member SET + DOM event/host APIs — contagion means a `main` claims only when
ALL land together. So this issue is tracked/prioritised as a **general IR
capability** on its own merits, not as a corpus-bucket lever. Do not schedule it
expecting a gate delta.

## Acceptance criteria

1. `select.ts` accepts a named-function / arrow argument at a `() => T`
   parameter position (JS-host lane; standalone per the closure ABI's existing
   support), and the matching `fn()` call.
2. `from-ast.ts` lowers both to the legacy closure-wrap ABI with byte/ABI parity
   (a mixed IR-caller / legacy-callee — and vice versa — links and runs).
3. IR-vs-legacy equivalence tests (a HOF that takes a `() => number` and invokes
   it), anti-vacuity (`irFirstSkipped` / byte-diff).
4. No `check:ir-fallbacks` regression; no test262 regression.

## Files

- `src/ir/select.ts` — function-value argument + arrow-value acceptance.
- `src/ir/from-ast.ts` — closure-wrap lowering + closure-call.
- `src/ir/nodes.ts` / `src/ir/lower.ts` — IR node/lowering as needed (reuse the
  legacy closure ABI, don't fork it).
- `src/codegen/closures.ts`, `src/codegen/builtin-fn-meta.ts` — the ABI to mirror.
