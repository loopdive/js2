---
id: 3679
title: "comptime() — build-time evaluation of TypeScript expressions baked into the module as literals (scriptc-inspired)"
status: backlog
sprint: Backlog
created: 2026-07-26
priority: low
horizon: l
feasibility: medium
reasoning_effort: high
task_type: feature
area: compiler
language_feature: compiler-internals
goal: performance
---

# #3679 — `comptime()` build-time evaluation

## Context / provenance

From the 2026-07-26 [vercel-labs/scriptc](https://github.com/vercel-labs/scriptc)
comparison. scriptc ships `comptime(() => ...)`: it "runs TypeScript at build
time (in an isolated VM inside the compiler) and bakes the result into the
binary as a literal." It is one of their three escape hatches (comptime, FFI,
`--dynamic`) for code that shouldn't — or needn't — exist at runtime.

## Why it fits js2wasm

We have a compiler-hosted Node runtime available at build time by construction
(the compiler *is* TypeScript running on Node), so the evaluation half is
nearly free. The payoff sites are real for a wasm target:

- **Precomputed tables** (regex derivatives, unicode property tables,
  string-method lookup tables) become data segments / `array.new_fixed`
  literals instead of startup code — smaller startup cost in standalone mode
  where there's no JIT to hide it.
- **Config/constant folding across module boundaries** that our current
  peephole pass can't see.
- **Dogfood value**: the self-hosting/dogfood pipeline compiles acorn and
  friends; hoisting their static initialization to build time attacks the same
  startup-cost problem scriptc quotes (~2.4ms native startup vs Node ~47ms).

## Design sketch

1. Recognize `comptime(<arrow with no free runtime bindings>)` in the IR
   front-end (this should be IR-path-only; no legacy-path support).
2. Evaluate the closure at compile time in an **isolated VM context**
   (`node:vm`, no ambient `require`/`fetch`/fs) with a wall-clock budget;
   evaluation failure or timeout = compile error with a code frame (see #3678
   diagnostics style).
3. Serialize the result — restrict v1 to JSON-shaped values + typed arrays —
   into the cheapest Wasm representation: `i32`/`f64` consts, data segments,
   `array.new_fixed`, struct literals.
4. Type-check the baked literal against the call-site's inferred TS type via
   `ctx.oracle` (NOT the raw checker — oracle-ratchet gate #1930/#3273).
5. Determinism guard: ban `Date.now`/`Math.random`/network in the VM so
   builds stay reproducible.

## Non-goals (v1)

- No arbitrary object graphs with functions/closures in the result
- No `comptime` in legacy-path code
- No cross-file comptime imports (the closure must be self-contained)

## Acceptance criteria

- [ ] `comptime(() => literalish-expr)` compiles to a literal in the emitted
      wasm (verify via `/analyze-wat` — no call, no closure allocation)
- [ ] Non-serializable results and nondeterminism sources are compile errors
      with a code frame
- [ ] Works under both backends (WasmGC + linear) or is explicitly gated with
      a tracked follow-up for the second backend
- [ ] Equivalence test: same observable behavior with `comptime` stripped
      (identity-function fallback) vs baked
