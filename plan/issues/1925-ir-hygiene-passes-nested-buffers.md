---
id: 1925
title: "Run IR hygiene passes inside nested buffers — or commit to one control-flow representation"
status: backlog
sprint: Backlog
created: 2026-06-10
updated: 2026-06-10
priority: medium
feasibility: hard
reasoning_effort: max
task_type: refactor
area: ir
language_feature: compiler-internals
goal: performance
---
# #1925 — IR optimization inside nested buffers / one CF representation

## Problem

The IR carries **two competing control-flow representations** and pays for
both while benefiting from neither:

- A blockarg CFG with phis exists (`nodes.ts:1837-1886`) and #1850 built
  dominance analysis over it — but `simplify-cfg.ts:37-40` states that
  "from-ast.ts and CF never introduce block args": the CFG layer is largely
  vestigial.
- Nearly all real control flow lives in **nested instruction buffers** on
  statement-level instrs: `if` (`nodes.ts:613-620`), `forof.*`,
  `while.loop`/`for.loop` (`nodes.ts:1649-1692`), `try` (`nodes.ts:1723-1739`).
  Loop-carried state escapes SSA into mutable `slot.read`/`slot.write` Wasm
  locals (`nodes.ts:1045-1060`).

Consequences:
- **Constant folding never descends into buffers** (`constant-fold.ts:50-57`
  seeds only top-level `block.instrs`; `tryFoldInstr:110-120` punts on `if`
  arms). Loop bodies — the only code where folding pays — are never folded.
- Every pass must special-case ~10 buffer-bearing kinds (see #1922).
- MIR/SIL-style loop reasoning (LICM, induction variables) is impossible.

## Proposed approach

Decide explicitly, then execute (architect spec first):

**Option A (M)** — accept the structured-IR direction (Binaryen-style):
make hygiene passes (constant-fold, DCE, simplify) apply recursively inside
buffers with scoped def maps, using #1922's shared traversal; delete the
unused blockarg machinery (or freeze it behind the CFG-only paths that use
it). Cheapest path to the IR delivering optimization value.

**Option B (L)** — commit to the CFG: lower loops/ifs into blocks + branch
args at build time, make slots into SSA values with phis, drop nested
buffers. Stronger analyses, much bigger migration; touches every pass and
the emitter trait.

The review's recommendation: **A now, keep B as the long-term question** —
but either way, stop maintaining both halves. Do this **before** the
class-method/async adoption waves (#1370/#1373) multiply the per-pass
special-casing.

## Acceptance criteria

- A constant expression inside a `while` body is folded (unit test).
- DCE removes a dead value defined and used only inside a loop body.
- ADR documenting the chosen representation; `docs/adr/0012` marked
  superseded-in-practice (the high-level-IR + lowered-IR split it accepted
  was never built).

## Source

Compiler quality review 2026-06. Depends on #1922 (shared traversal).
Related: #1850, #1851, #1370, #1373.
