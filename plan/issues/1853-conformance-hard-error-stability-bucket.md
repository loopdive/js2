---
id: 1853
title: "Track a separate hard-error (compiler-crash / malformed-Wasm) stability bucket on the conformance dashboard, distinct from unsupported-feature"
status: ready
sprint: 62
created: 2026-06-04
updated: 2026-06-12
priority: high
feasibility: easy
reasoning_effort: medium
task_type: infrastructure
area: testing
language_feature: n/a
goal: observability
related: [1376, 1850]
---
# #1853 — Separate hard-error stability bucket on the conformance dashboard

**Source:** [`docs/architecture/compiler-design-lessons.md`](../../docs/architecture/compiler-design-lessons.md) — recommendation **R6** (P1).

## Problem

Coverage and stability are different signals that are easy to conflate.
"We don't support `Proxy` yet" is a roadmap fact; "we crashed / emitted
invalid Wasm compiling a `for` loop" is a **bug**. A dashboard that merges
"compiler error / malformed output" into the same not-passing total as
"unsupported feature" cannot see a stability regression hiding behind an
expected gap. The fallback budget already buckets *IR demotions* by reason;
the same discipline should apply to *conformance outcomes*.

## Recommendation

Keep a first-class **hard-error bucket** ("compiler error" / "malformed
Wasm" / verifier-failure-on-claimed-function from #1850) on the test262 /
conformance dashboard, watched as a *stability* metric and **gated**,
separately from the informational "unsupported feature" count. Target:
keep the hard-error bucket near-zero; treat any growth as a
release-blocking regression, not a coverage statistic.

## Acceptance criteria

- [ ] Conformance reporting distinguishes `compiler_error` / `malformed_wasm`
      (and verifier-failure) outcomes from `unsupported_feature` outcomes.
- [ ] The hard-error bucket is surfaced on the dashboard and has a CI gate
      that fails on growth (mirrors the IR fallback-budget ratchet, #1376).
- [ ] A verifier failure on a claimed function (#1850) routes into this
      bucket rather than being silently swallowed.
- [ ] Baseline recorded; current hard-error count documented as the ceiling.
