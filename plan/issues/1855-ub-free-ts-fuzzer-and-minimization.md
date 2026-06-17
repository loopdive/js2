---
id: 1855
title: "UB-free TypeScript program generator + automated validity-preserving test-case minimization for equivalence failures"
status: done
assignee: ttraenkler/tld-2139
sprint: 63
created: 2026-06-04
updated: 2026-06-16
completed: 2026-06-16
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

## Resolution (2026-06-16)

Implemented the UB-free generator + differential runner + validity-preserving
minimizer, wired into the vitest suite.

### What landed

- **`tests/fuzz/generator.ts`** — a seeded (mulberry32) deterministic generator
  emitting well-typed TS in the supported subset. UB-free by construction:
  - safe-integer domain only ([-2³¹, 2³¹)) so f64 math is exact and there is no
    float-rounding divergence between V8 and the backend;
  - guarded division/modulo (`b === 0 ? 0 : Math.trunc(a / b)`), shift-counts
    masked to [0,31], multiplications band-limited, every result `| 0`-pinned;
  - no NaN/Infinity, no uninitialized reads, no OOB, no order-dependence —
    every generated expression is total and reference-defined;
  - emits `export function main(...)` + integer arg tuples.
- **`tests/fuzz/differential.ts`** — runs each program through the V8 oracle
  (types stripped → `new Function`) and the WasmGC backend (compile + run),
  classifying `match`/`mismatch`/`compile_error`/`runtime_error`/`oracle_error`.
  (Cross-backend folding deferred to #1854's harness: per-backend
  oracle-agreement ⇒ cross-backend agreement transitively.)
- **`tests/fuzz/minimizer.ts`** — `reduceLines(lines, predicate, keep)`: a pure,
  deterministic fixpoint line-reducer (extracted so the algorithm is
  unit-testable); `minimize(program)` wires it to the real backend with the
  validity-AND-failure predicate "still compiles AND oracle ≠ wasm". Never
  removes the `return`; returns `null` (never fabricates a repro) when there is
  no mismatch.
- **`tests/fuzz.test.ts`** — generates a fixed-seed batch (60 seeds), runs the
  differential sweep, and on any mismatch minimizes the first failure and fails
  with the small repro attached. Plus generator/minimizer unit tests.

### Acceptance criteria — verified (tests/fuzz.test.ts, 7 tests)

- ✅ **Generator emits well-typed TS in the supported subset with
  deterministic, reference-defined output** — the 40-seed UB sweep confirms
  every program evaluates to a finite integer under V8; PRNG + program
  determinism unit-tested.
- ✅ **Generated corpus runs through the reference oracle (+ feeds #1854's
  harness shape)** — 60-seed differential sweep, WasmGC matches V8 on every
  program (the compiler is correct on this subset today).
- ✅ **A minimizer reduces a failing case while preserving mismatch +
  validity** — `reduceLines` shrinks `[a,b,BUG,c,d,return]` → `[BUG,return]`
  and never drops kept lines; `minimize` applies it against the real backend.
- ✅ **Minimization wired to fire on failures** — the differential-sweep test
  invokes `minimize` and embeds the minimized repro in the failure message.
- ◻ EMI self-oracle mode — optional, deferred.

### Notable: the fuzzer caught a bug in its own generator

The first sweep run surfaced an `oracle_error` (`Identifier 'v0' has already
been declared`): the generator's per-statement `{ ...cx }` shallow-copies were
recycling the fresh-local counter, emitting a duplicate `let`. Fixed by sharing
the counter via a single `{ n }` object and the scope via a shared array ref —
a good demonstration that the differential harness surfaces real soundness bugs
(here, in the generator itself).

### Scope note

The generated subset is the numeric/boolean/control-flow core (the part the
WasmGC backend reliably compiles); broadening to strings/arrays/objects/closures
and the EMI self-oracle mode are natural follow-ups that reuse this scaffold.
