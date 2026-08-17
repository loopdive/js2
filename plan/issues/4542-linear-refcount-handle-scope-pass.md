---
id: 4542
title: "Refcount discipline for the boxed tier: a handle-scope / destructor-insertion pass covering exceptional paths"
status: ready
sprint: Backlog
created: 2026-08-17
updated: 2026-08-17
priority: high
horizon: l
feasibility: hard
model: fable
reasoning_effort: max
task_type: feature
area: codegen-linear
language_feature: compiler-internals
goal: standalone-mode
parent: 4538
depends_on: [4541]
related: [652, 4236]
# id 4542 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-17 (gh CLI offline in this container; pr_scan=degraded). Equivalent
# open-PR scan via the GitHub MCP at reservation time: the sole open PR was
# 4638 (hooks-only; adds no issue file), so the id space was clear.
---

# #4542 — Refcount discipline as a codegen obligation

Slice 4 of #4538. Implements handoff item 6 from #4236's slice-2 table.

## Problem

ADR-0020 adopts reference counting plus the engine's cycle collector as the
linear lane's reclamation strategy. The engine provides the mechanism
(`JS_DupValue` / `JS_FreeValue`); **we** must provide the discipline. The rule
is simple to state — one owner, released on every exit from its scope — and
still has to be implemented on *every* path codegen can emit, including:

- early `return` / `break` / `continue` out of a scope holding handles;
- `throw` and the unwind path through intervening frames;
- values consumed by an API call that takes ownership (the `SetProp`-consumes-a-
  reference class), versus ones that borrow;
- temporaries that never reach a named binding.

Getting this wrong fails in two directions: a missing release leaks silently,
and an extra release is a use-after-free that surfaces far from its cause.

Precedent worth reading first: **#652** (compile-time ARC / static lifetimes)
covers the same discipline for a different target.

## Scope

- A handle-scope / destructor-insertion pass over the linear lane's IR, placing
  dup/free at the right points rather than at every assignment.
- An **ownership annotation** on each declared engine import (consumes vs
  borrows), so the pass is driven by the ABI table from #4539 rather than by a
  hand-maintained list. The pinned artifact's shim already normalises this —
  the shim borrows, with one destructor rule (#4236 slice 1).
- Exceptional-path coverage designed in from the start, not retrofitted: the
  unwind path is where hand-written discipline reliably breaks.

## Acceptance criteria

- [ ] A stress fixture allocating and dropping dynamic values in a loop shows a
      **flat** heap — no growth over iterations.
- [ ] The same holds when the loop body throws and is caught, and when it
      returns early from nested scopes.
- [ ] A deliberate double-free and a deliberate missing-release are both caught
      by the test suite (negative tests — proving the harness can see the bug
      class it is meant to guard).
- [ ] Every declared engine import carries an ownership annotation; an import
      without one is a compile error, not a default.
- [ ] No refcount traffic is emitted on typed-only paths.

## Validation

- Heap-growth stress fixture across normal, early-exit, and throwing paths.
- Differential execution against Node for the same fixtures (a refcount bug
  frequently shows up first as a wrong value, not as a crash).

## Non-goals

- Cycles — reclaiming those is the engine's collector, with the residual
  cross-heap leak class documented in #4541.
- Optimising the discipline (elision of provably-balanced pairs). Correct
  first; a measured elision pass is separate follow-up work.
