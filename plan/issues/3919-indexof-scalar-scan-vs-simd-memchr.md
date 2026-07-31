---
id: 3919
title: "perf: __str_indexOf's first-code-unit scan is scalar where V8 uses SIMD memchr — the residual mixed/text-search gap after #3899"
status: ready
created: 2026-07-31
updated: 2026-07-31
priority: medium
feasibility: hard
reasoning_effort: high
task_type: optimization
area: codegen
language_feature: string-methods
goal: performance
sprint: Backlog
horizon: l
es_edition: multi
related: [3899, 1746]
---

# #3919 — the residual `text-search` gap is algorithmic, not scaffolding

## Status: open — the clean remainder after #3899

## Problem

#3899 removed the per-code-unit f64/NaN-guard scaffolding from the gc-native
string scan kernels and took `mixed/text-search` from **2.495 ms → 1.233 ms**
(2.0×). What is left is a different kind of cost.

Our `__str_indexOf` first-code-unit skip is a **scalar** scan over the
`(array i16)`. V8 uses a **SIMD `memchr`** for the same step. That is a
constant-factor gap no amount of instruction-shape cleanup will close — #3899
explicitly measured the scaffolding out and this is what remained, at roughly
**1.95× vs JS** on `text-search`.

## Why this is filed at medium/Backlog rather than high

Two reasons to be honest about the priority:

1. **The corrected baselines shrank the prize.** Before #3898, `text-search`
   looked like a 5.7× gap. Against honest baselines it is ~1.95×, and
   `startsWith-endsWith` (the benchmark that looked worse) is now *faster* than
   JS. This is no longer the dramatic outlier it appeared to be.
2. **Both plausible fixes are large.** WasmGC has no `memchr`; the options are
   Wasm SIMD (`v128` lane compare, which needs the `simd` proposal in the
   emitted module and a fallback path for engines without it) or a
   Boyer-Moore-Horspool skip table (no SIMD dependency, but it only pays off
   for longer needles — `text-search` uses a 4-char needle where the setup cost
   may dominate).

Neither is a small change, and the measured win is bounded by whatever fraction
of `text-search` the first-unit scan actually is. **Measure that fraction
first** — if the scan is 30% of the benchmark, a perfect `memchr` buys 1.4×,
not 1.95×.

## Scope

1. Profile `mixed/text-search` to attribute its remaining time between the
   first-unit scan, the full compare, and everything else. Publish the split.
2. Only then choose SIMD vs Boyer-Moore, justified by that split and by needle
   length in the target workloads.
3. If SIMD: settle the fallback story for engines without it before writing
   any lowering. A benchmark win that breaks standalone portability is not a
   win — see the dual-mode principle in `CLAUDE.md`.

## Acceptance criteria

1. A published time-attribution for `mixed/text-search`'s remaining 1.95×.
2. A chosen approach with the measurement that justifies it.
3. If implemented: `mixed/text-search` improves against the corrected #3898
   baseline, with no standalone-lane regression.

## Notes

Identified by `issue-3899-string-scan` as the explicit remainder after its
kernel work, and flagged by it as lower priority than it looked once the
baselines were corrected. Filed separately rather than folded into #3899
because the fix is a different kind of change — an algorithm/ISA decision, not
instruction-shape cleanup.
