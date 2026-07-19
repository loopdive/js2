---
id: 3451
title: "arch(#1046/#33/#34): linked harness .wasm as the driving use case for separate compilation"
status: backlog
sprint: current
created: 2026-07-19
updated: 2026-07-19
priority: low
horizon: xl
feasibility: hard
reasoning_effort: high
task_type: arch
area: codegen
language_feature: compiler-internals
goal: standalone-mode
depends_on: [1046, 33, 34]
---

# Linked harness .wasm as the driving use case for separate compilation (L4 / Spec F)

> **Roadmap / XL.** This rides on the #1046 (separate ES-module compilation) / #33
> (relocatable wasm object file) / #34 (multi-memory module linker) slices — it is
> **not this-window CI work** and requires no CI change until the linker slice
> exists. Endorsed end-state, filed so the test262 prelude is named as the
> acceptance workload for the linker roadmap.

Implements lever **L4** from `plan/ci-acceleration-review.md` (§3-L4, §5-F).

## Problem

The standalone lane **cannot** host-execute the harness by definition — its whole
point is host-free wasm, and #2961 / oracle v6 rejects binaries with host imports
(`scripts/test262-worker.mjs:1399-1403`). So the L3 native-JS-harness win (#3450)
is unavailable here: the harness must stay in-wasm.

The dedup shape for standalone is therefore **separate compilation + linking**:
compile the assembled prelude **once per (includes-set × strict × compiler-bundle)**
into a harness module, then per test compile only the **body** and link it against
that prelude module.

The includes-set cardinality is small — **a few dozen** distinct prelude
combinations cover all 43k tests — so when linking exists the per-run compile
count collapses from **~73k prelude codegens → ~10²** prelude compiles + ~73k
body-only compiles.

## Why it is XL / roadmap, not a CI-window fix

This is the #1046 separate-compilation / #33 relocatable-object / #34 module-linker
path. #3433's roadmap already endorses it as the end-state and notes that slice-1's
**scalar/externref boundary is insufficient** — the harness needs:

- **class identity** across modules (`Test262Error instanceof`),
- **shared script globals**,
- **closure-grade linkage** across the module boundary.

That is an XL compiler-roadmap item in which the harness becomes the *driving use
case*, not a CI-window change. A cheaper interim (front-end-only prelude snapshot)
was measured and rejected in #3433 — ceiling ≈ 13 %, not worth the diagnostics
risk.

## Acceptance criteria

1. The **#1046 slice-2 spec** names the test262 prelude as its acceptance
   workload: compile the assembled prelude once per (includes-set × strict), link
   per-test bodies against it.
2. Class identity (`Test262Error instanceof`) + shared script globals hold across
   the module boundary in the linked output.
3. Demonstrated: per-run prelude codegens collapse **~73k → ~10²** on the
   standalone lane.
4. No CI change lands under this issue until the linker slice exists; this issue
   is the roadmap anchor + acceptance-workload definition.

## References

- Review: `plan/ci-acceleration-review.md` §3-L4, §5-F, §2.1.
- Depends on #1046 / #33 / #34. #2961 (standalone host-free contract),
  #3433 (roadmap, 13 % snapshot ceiling, lane-asymmetric end-state).
