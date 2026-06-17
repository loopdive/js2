# ADR-012 — Intermediate representation: multi-stage typed IR over lightweight codegen-oriented IR

**Status**: Accepted — _high-level/lowered IR split superseded in practice by [ADR-018](./0018-structured-ir-nested-buffers.md)_
**Date**: 2026-04-27

> **Note (2026-06-16, #1925):** the multi-stage _split_ below — a separate
> high-level semantic IR and a distinct lowered IR — was never built. What
> exists is a single structured typed IR with control flow in nested
> instruction buffers, optimized in place; see [ADR-018](./0018-structured-ir-nested-buffers.md).
> The rest of this record (typed IR over a codegen-oriented IR; SSA-inspired,
> not strict SSA; annotations as inference seeds) still holds.

## Context

A compiler needs an IR to bridge the AST and Wasm emission. Two broad
strategies exist.

A _lightweight, codegen-oriented IR_ couples analysis tightly to emission:
type tags live on IR nodes and emission logic infers lowering decisions
inline. This is fast to implement and sufficient for compilation
strategies that accept fully boxed output for any value whose type cannot
be trivially read from the source.

The closed-world specialization strategy (ADR-001) requires more: shape
inference to determine WasmGC struct layouts ahead of emission; type
refinement to lower to unboxed primitives only where provably safe;
whole-program analysis so that specialization in one function can depend
on call-graph evidence from another; and explicit, auditable dynamic
boundaries separating proven-static regions from boxed fallbacks. These
requirements are difficult to satisfy when analysis and emission are
interleaved in a single pass.

A _multi-stage IR_ separates concerns: a high-level semantic IR preserves
full JS semantics; analysis passes annotate and refine it; a typed
lowered IR makes lowering decisions explicit; and a final Wasm emission
pass reads the lowered IR without re-deriving types.

## Decision

Adopt a multi-stage typed IR. The pipeline is:

1. **High-level IR** — JS semantics intact: objects as open maps,
   closures as captures, control flow as structured nodes. This IR is
   independent of Wasm; it is the semantic domain for analysis.
2. **Analysis passes** — whole-program type propagation (seeded from
   TypeScript annotations per ADR-009), shape inference (which
   properties are accessed, with what types), escape analysis (which
   objects can be stack-allocated or struct-lowered), and
   dynamic-boundary identification. Passes annotate IR nodes with
   refinement information without changing the semantic IR.
3. **Lowered IR** — analysis decisions are committed: objects are
   replaced by typed WasmGC struct references or retained as boxed
   `externref`; values carry explicit boxed/unboxed tags; boundary
   guards appear as explicit IR instructions at the transitions. The
   lowered IR is Wasm-typed but not yet binary.
4. **Wasm emission** — a read-only pass over the lowered IR that
   translates each node to the corresponding Wasm instruction sequence.
   No type inference at this stage.

The IR is SSA-inspired but not strict SSA — value provenance is tracked
for type refinement without the full renaming and phi-insertion cost of
strict SSA construction.

## Consequences

Positive: clean separation between analysis and emission — each pass
can be tested and evolved independently. Shape inference operates over
the full program before any Wasm is emitted; WasmGC struct types are
analytically determined, not guessed at emission time. Dynamic
boundaries are explicit IR nodes, not ad-hoc conditional checks
scattered through the codegen layer. Optimization passes (inlining,
dead-code elimination, constant folding) operate on the typed lowered
IR where specialization decisions are already committed, making their
effect predictable.

Negative: more infrastructure than a lightweight IR — each IR stage
requires its own node types, traversal utilities, and test coverage.
IR design must be stable across passes; premature changes to node
shapes break all downstream passes. Higher initial implementation
cost. This cost is amortized over the lifetime of the compiler: each
new optimization pass benefits from the already-available typed IR
without needing to re-derive type information.

## Alternatives rejected

- **Single-stage codegen-oriented IR**: tightly couples type inference
  to emission, making whole-program analysis impractical. Type
  information must be re-derived at each emission site. Object shapes
  are not representable as first-class IR concepts; they must be
  inferred ad-hoc during struct-type allocation. Dynamic boundaries
  become implicit, auditable only by reading the codegen code rather
  than inspecting IR nodes. These constraints are acceptable for
  compilation strategies that always emit boxed output; they are
  incompatible with the specialization goals in ADR-001.
