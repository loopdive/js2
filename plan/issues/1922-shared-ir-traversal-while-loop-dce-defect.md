---
id: 1922
title: "Shared IR traversal/use-collection module — fixes live defect: ordinary while loops demote off the IR path"
status: ready
sprint: 62
created: 2026-06-10
updated: 2026-06-12
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
language_feature: compiler-internals
goal: correctness
---
# #1922 — Shared IR traversal; fix while-loop DCE demotion

## Problem

At least **five hand-rolled copies** of "walk nested instruction buffers /
collect uses" exist in `src/ir/`, each with its own buffer coverage, kept in
sync only by comments ("if a new buffer-bearing instr kind is added, extend
both", `verify.ts:33-34`):

- `verify.ts:459` + `nestedBuffers` (`verify.ts:35`)
- `lower.ts:2255` + `collectForOfBodyUses` (`lower.ts:2409`)
- `passes/dead-code.ts:285` with per-case inline walkers
- `passes/constant-fold.ts` const-map seeding
- alloc-discipline's walker

**Confirmed live defect** (probe-verified during the 2026-06 review):

```ts
export function f(n: number): number {
  const limit = n * 2; let i = 0;
  while (i < limit) { i = i + 1; }
  return i;
}
```

with `experimentalIR: true` emits `warning IR path failed for f:
post-hygiene verify: use of SSA value 2 before def in block 0 [IR-FALLBACK]`.
Root cause: DCE's `collectInstrUses` returns only `[condValue]` for
`while.loop`/`for.loop`, with a comment claiming the buffers "are already
walked separately by the dead-code analysis walker"
(`passes/dead-code.ts:489-494`) — **false**; no such walk exists in
`computeLiveValues` (`dead-code.ts:138-173`). DCE strips `limit` (its only
use is inside the condition buffer it never walks), the post-stage verifier
catches the dangling ref, and the function silently demotes to legacy. The
most ordinary loop shape in the language never compiles through the IR — and
because this is a post-claim demotion, no ratchet counts it (#1923).
`while.loop`/`for.loop` (#1280) updated some walker copies and not others —
exactly the failure mode the duplication invites.

## Proposed approach

1. Add to `src/ir/nodes.ts`: `forEachNestedBuffer(instr, fn)` and
   `collectUses(instr, { deep?: boolean })`, the single authority on which
   instr kinds carry buffers (`if`, `forof.vec/iter/string`, `while.loop`,
   `for.loop`, `try`, generator kinds…).
2. Port verify / lower / dead-code / constant-fold / alloc-discipline onto
   them; delete local copies (~600 lines).
3. Exhaustiveness test: for every `IrInstr` kind that has an `Instr[]`/
   nested-IR field (derive by construction in the test), assert
   `forEachNestedBuffer` visits it.
4. Regression test: the `while (i < limit)` function above compiles through
   the IR path with **zero** fallback warnings.

## Acceptance criteria

- The probe program (and a `for (let i = 0; i < limit; i++)` variant) stays
  on the IR path.
- One traversal module, five consumers; the false comment at
  `dead-code.ts:489-494` is gone.
- `check:ir-fallbacks` corpus shows the while-loop demotions disappear.

## Source

Compiler quality review 2026-06. Related: #1280 (introduced the loop kinds),
#1923 (would have made this visible), #1530.
