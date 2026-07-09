---
id: 1447
title: "ADR-013 interpreter bytecode design — register-file + br_table dispatch"
status: backlog
created: 2026-05-20
updated: 2026-05-20
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
area: runtime
language_feature: eval
depends_on: []
related: [1520]
---

# #1447 — ADR-013 interpreter bytecode design — register-file + br_table dispatch

## Problem

ADR-013 proposes a lazy-loaded, opt-in WasmGC-native interpreter for
the source-at-runtime family of features (`eval`, `new Function`,
sloppy `with`). The architectural shape is settled. The **bytecode
design itself** is not: stack-based vs register-based, dispatch via
`call_indirect` vs `br_table`, opcode space allocation, how to
encode wide operands, how to handle implicit-register conventions.

The decisions made here determine both interpreter size and
interpreter speed for the lifetime of the artefact. A bad choice
compounds with every feature ADR-013 covers.

## Proposed approach

Adopt the design pattern that decades of production-grade engine
work has converged on:

1. **Accumulator + register-file**, not stack-based. One implicit
   accumulator register holds the most recent value; a small
   register-file (per-frame local slots) holds named bindings.
   Reduces operand encoding overhead and matches WasmGC's local
   register convention.

2. **Short-form opcodes for hot patterns.** `LoadAccumulator0`–
   `LoadAccumulator15`, `StoreAccumulator0`–`StoreAccumulator15`
   as separate single-byte opcodes for the common case of
   referring to one of the first 16 register-file slots.

3. **Wide / extra-wide operand prefixes.** Two prefix bytes that
   extend the next opcode's operand width. Keeps the common case
   compact without capping the opcode set's expressive range.

4. **Implicit-register-use declarations per opcode.** Each
   opcode declares which registers it reads/writes; the
   verifier and the (eventual) optimiser use this without
   re-deriving it.

5. **Dispatch via `br_table` inside one big function**, not via
   `call_indirect` to per-opcode handler functions. `br_table` is
   the closest thing WasmGC has to a computed-goto loop and
   keeps the dispatch overhead near zero. `call_indirect` per
   opcode incurs a function-call boundary on every bytecode.

## Acceptance criteria

- Bytecode design document drafted in `plan/issues/sprints/.../`
  (or the appropriate location) with opcode table and operand
  conventions.
- Prototype interpreter implemented in TypeScript, compiled by
  js2wasm itself, demonstrating the bytecode shape on a small
  subset of JS (numeric expressions + variable access).
- Measured: dispatch overhead per bytecode below a target
  threshold on a representative benchmark.
- Decision recorded in ADR-013 supplement on register-file +
  br_table vs alternatives, with the trade-off explicit.

## Notes

This is the design-heaviest of the ADR-013 sub-issues and the one
where premature commitment to the wrong shape will be expensive
to undo. Take time to prototype before publishing.

The accumulator + register-file design and the Star0–Star15
short-form encoding are V8's Ignition interpreter pattern
(https://github.com/v8/v8, `src/interpreter/bytecodes.h`). V8's
interpreter is the most heavily-traffic-tested bytecode design in
production; the shape is well-validated. The `br_table` dispatch
decision is our adaptation: V8 dispatches via direct threading in
native code, but in a WasmGC-compiled interpreter `br_table` is the
closest semantic match — `call_indirect` adds a function-call
boundary on every bytecode, which is the wrong primitive.
