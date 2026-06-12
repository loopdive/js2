---
id: 2089
title: "silent-fallback telemetry + check-codegen-fallbacks ratchet (Phase 0: instrument the 16 verified sites)"
status: ready
sprint: 62
created: 2026-06-11
updated: 2026-06-12
priority: critical
feasibility: easy
reasoning_effort: medium
task_type: infrastructure
area: compiler
language_feature: compiler-internals
goal: correctness
related: [1376, 1530, 2090]
origin: "2026-06-11 analysis program (report 04 §5); stub 08-B4"
---

# #2089 — count the silent fallbacks so the classes stop breeding

## Problem

~33 of the ~135 June wrong-answer bugs trace to seven silent-fallback
classes (ref.null value fallback, lookup-miss skip, NaN/0/false constants,
arity truncation, allowlist miss, silent caps, compiler catch-and-
continue). None are counted, so the classes keep breeding — the corpus's
#1 family (24 issues).

## Root cause

No codegen-internal equivalent of the proven #1376/#1530 IR-fallback
ratchet.

## Plan (Phase 0, ~1 day)

`src/codegen/fallback-telemetry.ts` with `reportSilentFallback(class,
site)`; `scripts/check-codegen-fallbacks.ts` + baseline JSON + CI
`quality` wiring (growth fails, `--update-on-decrease` banks);
`STRICT_FALLBACK_CLASSES` promotion to hard error at zero. Phase 0
instruments only the ~16 verified bug sites (8 unary-updates NaN sites, 7
`fieldIdx===-1` skips, identifiers.ts:812). Phases 1–4 (full inventory
coverage) ride this issue or split. Full inventory + design:
plan/log/analysis-2026-06/04-fail-loud-audit.md.

## Acceptance criteria

- Baseline file committed; CI fails on growth; decrease auto-banks
- The 16 Phase-0 sites report through the choke point

## Dupe check

#1376/#1530 are the IR-path ratchet only; no codegen-fallback equivalent
exists. New (analysis program).
