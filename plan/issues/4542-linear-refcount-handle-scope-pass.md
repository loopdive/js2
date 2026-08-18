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

## Elision safety condition (agreed 2026-08-18)

Elision stays out of scope for this slice (see Non-goals), but the condition
under which it is *legal* belongs here, because the pass this slice builds is
what a later elision pass would edit, and the rule is easy to get wrong in a way
tests do not catch.

**Rule.** A balanced `JS_DupValue` / `JS_FreeValue` pair around a region R may be
elided only if another reference to the value is held for the whole of R by an
owner that **nothing in R can release**.

**"Alive on entry to R" is not sufficient**, and that is the entire content of
the rule. The engine adjusts refcounts as it runs — the same property ADR-0020
cites when rejecting our own refcounting over engine objects — so a reference
that exists when R begins can be dropped inside R by engine code we called.

**The counterexample the rule exists to reject:**

```js
const a = obj.x;   // pass wants to elide a's dup, reasoning "obj.x still holds it"
f(a);              // borrows — harmless
obj.x = other;     // engine releases the old value; its count may reach zero
use(a);            // use-after-free
```

The proposed owner (`obj.x`) is a container slot, and a container slot is
invalidatable by any engine call able to write it.

**Practical form for the pass:**

- An owner qualifies only if it is a root the pass itself established and no
  engine call in R can reach — a local root, never a slot in an engine-visible
  object.
- Any engine C API call inside R invalidates elision against a container-slot
  owner, unless that import's `ownership` annotation (the #4539 ABI table)
  establishes it cannot release the owner. This is the **second** consumer of
  those annotations, alongside consumes/borrows, and is worth stating because it
  affects what the annotation must be able to express.
- When in doubt, keep the pair. A redundant dup/free costs measurable time; a
  wrong elision is a use-after-free surfacing far from its cause — the failure
  mode this issue's Problem section already names as the expensive direction.

## Non-goals

- Cycles — reclaiming those is the engine's collector, with the residual
  cross-heap leak class documented in #4541.
- Optimising the discipline (elision of provably-balanced pairs). Correct
  first; a measured elision pass is separate follow-up work — its
  safety condition is agreed and recorded above, so the follow-up starts from a
  rule rather than deriving one.
