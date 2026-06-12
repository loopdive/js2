---
id: 1855
title: "UB-free TypeScript program generator + automated validity-preserving test-case minimization for equivalence failures"
status: ready
sprint: 62
created: 2026-06-04
updated: 2026-06-12
priority: medium
feasibility: hard
reasoning_effort: high
task_type: test
area: testing
language_feature: n/a
goal: test-infrastructure
related: [1854]
---
# #1855 — UB-free TS fuzzer + automated minimization

**Source:** [`docs/architecture/compiler-design-lessons.md`](../../docs/architecture/compiler-design-lessons.md) — recommendation **R7b** (P2).

## Problem

Hand-written equivalence tests cover the cases we *thought of*. The
highest-yield way to find wrong-code bugs in a compiler is **random program
generation + differential testing**, but it only works if the generator
avoids undefined/unspecified behavior (otherwise its "wrong" outputs drown
the real bugs), and if failures are **minimized** automatically (nobody
debugs a 2000-line repro). TypeScript is far closer to UB-free than the
low-level languages this technique was pioneered on, so a *sound* generator
is markedly easier here — an unusually high-ROI bet.

## Recommendation

1. **UB-free TS program generator** producing well-typed TS within our
   supported subset, fed into the reference oracle and the cross-backend
   differential harness (#1854). Optionally add an equivalence-modulo-inputs
   mode (inject provably-dead code / identity transforms; output must not
   change) as a self-oracle that needs no reference.
2. **Automated validity-preserving minimization**: on any equivalence /
   differential failure, iteratively remove statements/branches and re-run
   the oracle, keeping only reductions that **still mismatch** *and* **still
   typecheck** (the validity predicate is "still valid TS in our subset").
   Fire automatically and attach a minimal repro to the failing node kind.

## Acceptance criteria

- [ ] Generator emits well-typed TS in the supported subset; emitted programs
      have deterministic, reference-defined output (no reliance on
      unspecified behavior).
- [ ] Generated corpus runs through the reference oracle and #1854.
- [ ] A minimizer reduces a failing case to a small repro while preserving
      both the mismatch and type-validity.
- [ ] Minimization is wired to fire on equivalence/differential failures.
- [ ] (Optional) EMI self-oracle mode implemented.
