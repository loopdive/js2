---
id: 1925
title: "Run IR hygiene passes inside nested buffers — or commit to one control-flow representation"
status: done
assignee: ttraenkler/sdev-1537
completed: 2026-06-16
sprint: 63
created: 2026-06-10
updated: 2026-06-16
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

## Implementation Notes (sdev-1537, 2026-06-16)

**Decision: Option A** (the review's recommendation) — accept the structured-IR
direction and make the hygiene passes optimize *inside* nested buffers, rather
than the much larger Option B (lower everything to a phi-based CFG). Documented
in **`docs/adr/0018-structured-ir-nested-buffers.md`**; ADR-0012's high-level/
lowered-IR *split* (never built) marked superseded-in-practice in its header and
the ADR README index.

### What changed
- **`src/ir/nodes.ts`**: added `mapNestedBuffers(instr, mapBuffer)` — the
  write-side companion to #1922's `forEachNestedBuffer`. Exhaustive switch +
  `never`-check (same authority guarantee); reference-equality preserving (same
  instr back when every buffer is unchanged).
- **`passes/constant-fold.ts`**: `constantFold` now recurses into every buffer
  via `mapNestedBuffers`, folding `binary`/`unary` inside loop/if/for-of/try
  bodies. **Scoped const-def maps**: each buffer gets a child scope cloned from
  its parent (outer consts dominate the buffer); a const defined *inside* a
  buffer is recorded in the child only, so it never leaks to siblings after the
  buffer (it doesn't dominate following code) — pinned by a scope-isolation
  test. Top-level global seeding unchanged.
- **`passes/dead-code.ts`**: Phase-4 rebuild now recursively filters dead instrs
  inside buffers (`filterBuffer` + `mapNestedBuffers`); the change-detection and
  alloc-retire phases recurse too. Liveness was already deep after #1922, so the
  `live` set is globally correct for interior instrs.
- Both passes keep the reference-equality "no change" contract, so
  `runHygienePasses`'s `===` fixpoint still terminates.
- **`simplify-cfg.ts` / `constant-fold` branch-collapse / the block-arg CFG**:
  deliberately left as-is. Per ADR-0018 the CFG layer is frozen (kept for the
  linear backend + dominance checks), not extended.

### Acceptance criteria — met
- A constant expression inside a `while` body folds (`6.0*7.0 → 42`); also folds
  inside a nested `if` arm within a loop. (unit test)
- DCE removes a value defined+used only inside a loop body; post-DCE verify
  clean. (unit test)
- ADR written; ADR-0012 marked superseded-in-practice.

### Validation
- `tests/issue-1925.test.ts`: 7 tests (fold-in-while, fold-in-nested-if,
  CF no-change, CF scope-isolation, DCE-in-loop, DCE keeps-live, DCE no-change).
- Legacy-vs-IR **equivalence** on real loop programs with foldable/dead
  loop-body values — identical results, behavior-preserving.
- 192 existing IR tests green; `tsc` + `npm run lint` clean; IR fallback gate
  shows no unintended/post-claim increases.

### Follow-ups (not in scope)
- CF's `tryFoldTerminator` collapses top-level `br_if(const)`; collapsing a
  const-cond `if` to one arm inside a buffer is a further DCE opportunity left
  for later.
- LICM / induction-variable analysis remain Option-B territory (ADR-0018).
