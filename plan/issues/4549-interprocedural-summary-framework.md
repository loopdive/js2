---
id: 4549
title: "Shared inter-procedural summary framework: one call graph + summary fixpoint serving lifetime, escape, type-flow and foreign-function analyses"
status: ready
sprint: Backlog
created: 2026-08-17
updated: 2026-08-17
priority: high
horizon: xl
feasibility: hard
model: fable
reasoning_effort: max
task_type: feature
area: ir
language_feature: compiler-internals
goal: compiler-architecture
related: [652, 685, 1166, 1587, 3756, 4538, 4542, 4543]
# id 4549 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-17 (gh CLI offline in this container; pr_scan=degraded). Equivalent
# open-PR scan via the GitHub MCP at reservation time: sole open PR was 4639
# (ci/npm-compat-refresh, artifact-only), which adds no issue file.
---

# #4549 — One inter-procedural summary framework, several consumers

## Problem

Several tracked workstreams independently need the same three things: a
**whole-program call graph**, **compact per-function summaries**, and a
**monotone fixpoint** over that graph. None of them has it, and each is
positioned to build its own.

What exists today is one axis half-built and the other missing:

- **#685 — "Interprocedural type flow: track return types across call sites"**
  (`done`) — return types already flow across call sites. Partial, and
  type-specific.
- **#1587 — "Static analysis pass: ownership and access semantics on IR
  values"** (`done`) — but Phase 1 only. Its own source states: *"Phase 1 is
  intra-procedural: unknown callees are treated as fully escaping.
  Inter-procedural summaries are Phase 2."*

Measured consequence of that gap (2026-08-17, recorded in **#652 —
"Compile-time ARC: static lifetime analysis for linear memory mode"**): in a
ten-pattern probe, *"object passed to a local callee"* was **rejected at IR
build** — not analysed conservatively, not analysed at all. Passing an object
to a function is not an exotic shape.

## Consumers (all currently blocked on the same missing layer)

| consumer | needs |
| --- | --- |
| #1587 Phase 2 | escape/ownership across calls — today unknown callee ⇒ fully escaping |
| #652 | lifetime placement; region assignment needs region-polymorphic callees |
| **#1166 — "Closed-world integer specialization from literal call sites"** (`ready`) | call-site → callee value/type flow |
| #4542 (refcount discipline) | foreign summaries: per-import consumes/borrows/retains for the engine C API |
| #4543 (object frontier) | inter-procedural taint: which allocation sites can reach dynamic code |
| `param-type-not-resolvable`, `return-type-not-resolvable`, `type-resolution-failure` | CLAUDE.md names the fix as "better TypeMap propagation" — all three are **unintended** buckets in the #1376 ratchet |

**Foreign functions are summaries too.** #4542's requirement that every declared
engine import carry an ownership annotation is exactly a hand-written summary
for code the analysis cannot see. It should use this framework's summary type,
not a parallel mechanism.

## What is shared, and what is emphatically not

**Shared:** call-graph construction, summary representation and propagation,
the worklist/fixpoint driver, convergence and cycle handling (recursion,
mutual recursion), caching and invalidation. The lattice machinery is already
factored out in `src/ir/analysis/lattice.ts`.

**Not shared:** the lattices and transfer functions. Conflating them would be a
serious mistake, because the *soundness directions differ*: a wrong type is a
miscompilation, a wrong lifetime is a use-after-free. Different tops, different
joins, different notions of "safe when uncertain". The framework must let each
analysis define its own lattice and its own conservative element, and must
never supply a default.

## The two properties that decide whether this is worth having

**1. It must be able to say "I don't know", and that must be the safe answer.**
Every consumer has an unanalyzable boundary — `eval`'d source, host imports,
callbacks from dynamic code, function-valued parameters. A framework that
silently treats an unresolved callee as benign is unsound for every consumer at
once, which is strictly worse than the per-analysis conservatism it replaces.
Per `.claude/memory/MEMORY.md`: *what does it do when it CANNOT SEE?* Going to
top must be explicit, attributable to a named cause, and countable.

**2. Compile time is the real risk.** A whole-program fixpoint scales with
program size, and this repo already has superlinear-scaling pain on
acorn-sized input (**#3756 — "acorn parse superlinear scaling"**). Summaries
must be compact — bounded size per function, independent of callee count — or
the analysis becomes the bottleneck it was built to remove. Budget this
up front rather than discovering it on a large package.

## Acceptance criteria

- [ ] A framework with: call-graph construction over the IR, a summary
      interface parameterised by a consumer-supplied lattice, and a fixpoint
      driver that terminates on recursive and mutually-recursive call graphs.
- [ ] **Two** consumers ported onto it — one lifetime-shaped (#1587 Phase 2)
      and one type-shaped — so the abstraction is proven against the two
      soundness directions rather than fitted to one. (ADR-0014's "one
      demonstration consumer" rule is the floor; two is the requirement here
      precisely because the risk is over-fitting to a single lattice.)
- [ ] Unresolved callees are recorded with a **reason** and **counted**, not
      silently widened; the count is reportable per compilation.
- [ ] A compile-time budget is measured and committed as a baseline on a large
      real package, with the framework enabled and disabled.
- [ ] Foreign-function summaries (#4542's engine-import annotations) use the
      same summary type as inferred ones.
- [ ] Removing the framework cannot change emitted Wasm while consumers are in
      annotation-only mode — the ADR-0014 inertness property #1587 already
      holds.

## Non-goals

- Any specific optimisation. This issue delivers the substrate; #652, #1166 and
  #1587 Phase 2 deliver the wins.
- Whole-program analysis across the dynamic-tier frontier. Analysis is only as
  whole-program as the typed tier is closed; the frontier is where summaries go
  to top by construction (see ADR-0020 and #4543).
- Separate compilation. We compile whole-program; if that ever changes, summary
  serialisation becomes a new requirement, not a retrofit.
