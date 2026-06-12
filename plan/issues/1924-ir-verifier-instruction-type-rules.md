---
id: 1924
title: "Instruction-level type rules in the IR verifier — operands, branch-arg types, and resultType validation"
status: ready
sprint: 62
created: 2026-06-10
updated: 2026-06-12
priority: high
feasibility: medium
reasoning_effort: high
task_type: feature
area: ir
language_feature: compiler-internals
goal: correctness
---
# #1924 — IR verifier: instruction-level type rules

## Problem

The IR verifier is positioned as the project's compensation for TypeScript's
unsound type system (`docs/architecture/structure-and-language-assessment.md:107-110`),
and #1850 hardened SSA/dominance/legality. But it still checks **no
per-instruction operand typing at all**:

- `f64.add` over two i32 values, `string.concat` over f64s, `object.get` of
  a missing field, `closure.call` arity/type mismatch — all pass verification.
  The only type rules are the union trio (`verify.ts:375-410`) and
  conservative return assignability (#1798, `verify.ts:264-285`).
- Branch args: **arity checked, types not** — `checkBranchArity`
  (`verify.ts:681-704`) compares lengths only; `blockArgTypes` are never
  matched against passed values' types.
- `resultType` is denormalized onto every instr "for verifier speed"
  (`nodes.ts:438`) and **trusted, never re-derived** — yet it directly
  becomes Wasm local types at lowering (`lower.ts:523-533`). A pass that
  writes a wrong resultType is invisible until the engine rejects the binary
  (or worse, accepts it with wrong semantics).
- Slot discipline unchecked: `slot.read/write` indices never validated
  against `func.slots` bounds or declared types.
- Perf note: `operandIrType` re-scans the whole function per query
  (`verify.ts:629-641`) — quadratic; build a def-map once (the dominance
  check already builds one).

## Proposed approach

1. Table-driven rule per `IrInstr` kind: expected operand IrType kinds →
   derived result kind. Start permissive (kind-level: scalar/ref/string/
   object) and tighten; reuse the def map from #1850's dominance pass.
2. Validate `resultType` against the derived kind; mismatch ⇒ verify error
   (demotes safely via the existing channel, metered by #1923).
3. Branch-arg type matching against `blockArgTypes`.
4. Slot read/write bounds + declared-type checks.
5. Keep total verify cost O(n): one def-map, one pass.

## Acceptance criteria

- Injected wrong-resultType and i32-into-f64.add IR (unit tests via
  IrFunctionBuilder) are rejected.
- No new post-claim demotions on the playground corpus (or each one
  investigated — they are real latent bugs by definition).
- Verify wall-time on the corpus within 1.5× of current.

## Source

Compiler quality review 2026-06. Extends #1850 (in-review). Related: #1923,
#1857 (attributes vs operands).
