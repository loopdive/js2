---
id: 1854
title: "Cross-backend differential testing harness — same TS to WasmGC / linear / bytecode-VM must produce identical observable output"
status: done
assignee: ttraenkler/tld-2139
sprint: 63
created: 2026-06-04
updated: 2026-06-16
completed: 2026-06-16
priority: high
feasibility: medium
reasoning_effort: medium
task_type: test
area: testing
language_feature: n/a
goal: test-infrastructure
related: [1714, 1715, 1851, 1852]
---
# #1854 — Cross-backend differential testing harness

**Source:** [`docs/architecture/compiler-design-lessons.md`](../../docs/architecture/compiler-design-lessons.md) — recommendation **R7a** (P1).

## Problem

The `tests/equivalence/` suite compiles-and-runs against a JS/TS reference
oracle (the right backbone). But we now have **three** lowering paths behind
the `BackendEmitter` trait (WasmGC, linear memory, bytecode-VM), and nothing
asserts they agree with **each other**. A backend-specific lowering bug
(e.g. a linear-memory layout error, or a divergent boxing choice from #1852)
that produces wrong-but-not-crashing output can pass the single-oracle test
on whichever backend the test happens to run.

## Recommendation

Add a **cross-backend differential test**: compile the same TS program to
each available backend and assert **identical observable output**. This is
nearly free given the dual/triple backend and catches the exact class of
backend-divergence bugs the reference oracle alone can miss. It also becomes
the regression guard for the per-backend value representation (#1852) and the
trait-migration work (#1851).

## Acceptance criteria

- [ ] A test helper compiles a TS source to WasmGC **and** linear (and, where
      applicable, the bytecode-VM) and diffs observable results (return value,
      stdout, thrown errors).
- [ ] Seeded from a representative corpus (numeric kernels, strings, objects,
      arrays, control flow, closures) — start with the existing equivalence
      corpus.
- [ ] A divergence fails the test with a minimal-enough repro pointer
      (full minimization is #1855).
- [ ] Wired into CI; runtime kept modest (subset corpus if needed).

## Sprint-62 planning amendment (2026-06-12)

> **Superseded during implementation (2026-06-16).** The approach below was
> found infeasible and replaced — see the Resolution section. Kept for history.

~~Concretized approach: implement as a `DIFF_TEST_TARGET=linear` lane in
`scripts/diff-test.ts` against the same V8 oracle (oracle-agreement per
backend ⇒ cross-backend agreement transitively), with a per-lane baseline
like the optimize lane — most of the 104 corpus programs won't compile on
linear yet, so baseline the gap and gate the delta.~~ **This stdout lane is
infeasible: the linear backend (`target:"linear"`, non-WASI) has no
`console.log` host import and silently drops stdout (see Resolution), so the
stdout-driven diff-test corpus cannot exercise it.** The bytecode-VM leg is
demoted to "where applicable" (it is test-only today). Prerequisite: #2139
(linear tests in CI at all). Scheduled sprint 62.

**Shipped approach (2026-06-16):** a **return-value** cross-backend
differential (`tests/cross-backend-diff.test.ts` + `tests/cross-backend/
corpus.ts`) — compile each corpus program to both WasmGC and linear and assert
identical exported-function return values. The linear backend is
return-value-oriented (its only observable without WASI), and WasmGC↔linear
return-value agreement is transitively agreement with the V8 oracle the WasmGC
lane already tracks. The "baseline the gap" intent is preserved via
`expectLinearUnsupported` per-program skips (assert-still-unsupported, so the
gap can only shrink). Full design + rationale in the Resolution section below.

## Resolution (2026-06-16)

### Design pivot — the stdout lane is infeasible

The sprint-62 amendment's `DIFF_TEST_TARGET=linear` stdout lane in
`scripts/diff-test.ts` **cannot work**: the diff-test corpus is 100 %
stdout-driven (`console.log`), but the linear backend (`target: "linear"`,
non-WASI) has **no `console.log` host import** — a linear-compiled program
emits zero imports and no output mechanism in the WAT, so it runs but prints
nothing (verified). Diffing linear-stdout vs the V8 oracle would mark all
~100 corpus programs as false mismatches.

The linear backend's observable surface is the **exported function return
value** — exactly what `tests/linear-*.test.ts` already assert (they
instantiate with no imports and check return values). So the harness diffs
**return values across backends**, which transitively diffs against the V8
oracle (the WasmGC lane already tracks it via the equivalence suite) and is
the design the linear backend actually supports.

### What landed

- **`tests/cross-backend/corpus.ts`** — a structured, data-driven corpus
  (12 programs across numeric / control / string / array / object / closure)
  of self-contained TS modules exporting functions + the arg tuples to call.
  Seeded from the equivalence-corpus feature areas requested by AC #2.
- **`tests/cross-backend-diff.test.ts`** — compiles each program to BOTH
  WasmGC and linear, invokes every declared call on both, and asserts
  identical return values (`toStrictEqual`). A divergence fails with a
  per-call repro pointer: `program :: fn(args) — WasmGC returned X but linear
  returned Y`.
- **Gap baseline + ratchet (no frozen file).** Programs the linear backend
  does not yet compile are flagged `expectLinearUnsupported` and skipped from
  the diff — BUT the harness still asserts they remain unsupported, so the
  moment linear gains support the assertion flips and forces removing the flag
  (the gap can only shrink, never silently grow). Currently flagged:
  `numeric/math-trunc` (Math.trunc), `string/charcode` (charCodeAt),
  `closure/counter` (arrow closures).
- **CI wiring** — runs in the normal vitest suite (~5.5 s); no dedicated
  workflow needed.

### Acceptance criteria — verified

- ✅ **Helper compiles a TS source to WasmGC and linear and diffs observable
  results (return value)** — `run(program, backend)` + `invoke()` in the test;
  bytecode-VM leg correctly demoted to "where applicable" (test-only today).
- ✅ **Seeded from a representative corpus** (numeric kernels, strings, arrays,
  control flow, objects, closures).
- ✅ **A divergence fails the test with a minimal-enough repro pointer** —
  confirmed by injecting a forced mismatch: the test fails with the
  `Cross-backend DIVERGENCE in numeric/arithmetic :: arith() — WasmGC returned
  5 but linear returned 6` message (full minimization remains #1855).
- ✅ **Wired into CI; runtime modest** — 15 tests, ~5.5 s, in the vitest suite.

### Tests — `tests/cross-backend-diff.test.ts` (15, all pass)

11 programs diffed across backends (all agree), 3 `expectLinearUnsupported`
skipped-but-asserted-still-unsupported, 1 corpus-shape sanity check.

### Follow-ups

- Grow the corpus as the linear backend gains features (drop the
  `expectLinearUnsupported` flags as Math.*, charCodeAt, closures land).
- #1855 (minimization) and the bytecode-VM leg remain future work.
