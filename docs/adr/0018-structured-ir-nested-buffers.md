# ADR-018 — Structured IR: optimize inside nested control-flow buffers

**Status**: Accepted
**Date**: 2026-06-16
**Supersedes (in practice)**: parts of [ADR-012](./0012-intermediate-representation.md)

## Context

ADR-012 accepted a multi-stage IR with a _high-level semantic IR_ and a
separate _lowered IR_, bridged by analysis passes. In practice that split was
never built. What exists (`src/ir/`) is a single typed IR that carries control
flow in **two competing representations**:

- a block/CFG layer with block-args-as-phis (`nodes.ts` `IrBlock` /
  `IrTerminator`), over which #1850 built dominance analysis — but
  `from-ast.ts` and the hygiene passes never introduce block args, so nearly
  every function is a single block;
- the **real** control flow, which lives in _nested instruction buffers_ on
  statement-level instrs: `if` (then/else), `forof.{vec,iter,string}` (body),
  `while.loop` / `for.loop` (cond/body/update), `try` (body/catch/finally).
  Loop-carried state is mutable `slot.read`/`slot.write` Wasm locals, not SSA
  phis.

The cost of maintaining both halves was real: hygiene passes only ever
optimized **top-level** `block.instrs`. Constant folding seeded only top-level
consts and punted on control-flow arms; DCE filtered only top-level instrs.
Loop and conditional **bodies — the code where folding and dead-code removal
actually pay — were never optimized.** Worse, each pass independently
special-cased ~10 buffer-bearing kinds, the duplication that produced the
silent while-loop DCE demotion fixed in #1922.

Two ways forward (the 2026-06 compiler quality review):

- **Option A** — accept the structured-IR direction (Binaryen-style): make the
  hygiene passes apply _recursively inside buffers_ with scoped def maps, using
  #1922's shared traversal; treat the block/CFG + block-arg machinery as a
  thin, mostly-single-block envelope rather than the primary CF representation.
- **Option B** — commit to the CFG: lower loops/ifs to blocks + branch args at
  build time, promote slots to SSA values with phis, drop nested buffers.
  Stronger analyses (LICM, induction variables) but a much larger migration
  touching every pass and the emitter trait.

## Decision

Adopt **Option A**. Nested instruction buffers are the canonical control-flow
representation of this IR; the hygiene passes optimize _through_ them.

- A single shared traversal authority (`src/ir/nodes.ts`, #1922):
  `forEachNestedBuffer` / `forEachInstrDeep` / `collectUses(_, { deep })`, plus
  its write-side companion `mapNestedBuffers` (#1925) for passes that rewrite
  buffer contents. Adding a buffer-bearing instr kind is a single
  exhaustive-switch edit the compiler enforces.
- `constantFold` recurses into every buffer with a **scoped** const-def map: a
  child scope inherits its parent (outer consts dominate the buffer) but a
  const defined inside a buffer does **not** leak to siblings after it (it does
  not dominate following code).
- `deadCode` filters dead instrs inside buffers too; liveness was already
  deep-aware after #1922.
- Both passes preserve the reference-equality "no change" contract so
  `runHygienePasses`'s fixpoint still terminates by `===`.

The block-arg/phi CFG machinery is **kept but frozen**: it is not deleted (the
linear backend and dominance checks still reference the block model), but
from-ast and the hygiene passes do not introduce block args, and no new pass
should rely on a phi-based CFG. Loops/ifs stay in buffers.

Option B remains the open long-term question; this ADR does not foreclose it,
but commits the _near term_ to one representation so we stop paying for both.

## Consequences

- Constant expressions and dead values inside loop/if/for-of/try bodies are now
  optimized (the only place folding/DCE materially pays). Verified by unit +
  legacy-vs-IR equivalence tests in `tests/issue-1925.test.ts`.
- Every pass shares one traversal; per-kind special-casing (and its silent
  drift, #1922) is gone.
- MIR/SIL-style loop reasoning (LICM, induction-variable analysis) remains out
  of reach without Option B — accepted for now. Do the Option A consolidation
  **before** the class-method/async adoption waves (#1370/#1373) multiply the
  per-pass buffer handling.
- ADR-012's high-level-IR/lowered-IR _split_ is superseded in practice: there
  is one structured IR, optimized in place. ADR-012's other content (typed IR
  over a codegen-oriented IR; annotations as inference seeds) still holds.
