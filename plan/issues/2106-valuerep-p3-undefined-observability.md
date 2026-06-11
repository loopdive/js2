---
id: 2106
title: "value-rep P3: undefined observability — UNDEF_F64 sentinel, union-collapse reversal (flagged), standalone $undefined singleton"
status: ready
sprint: Backlog
created: 2026-06-11
updated: 2026-06-11
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen
language_feature: type-coercion
goal: core-semantics
related: [2004, 2051, 2030, 2001]
origin: "2026-06-11 analysis program (report 02 phase P3); stub 08-E21"
---

# #2106 — T | undefined collapses to bare T

## Problem

`T | undefined` collapses to bare T at the type mapper, so undefined
becomes NaN/0 in numeric carriers and is unobservable to `===`/`??`/`?.`/
typeof/ToString (#2004 codePointAt, optional-chain representation #2051
slug, #2030 exhausted .value, the #2001 destructuring addendum). In
standalone mode `undefined` and `null` are the SAME bit pattern
(ref.null extern) — indistinguishable by construction.

## Root cause

Union collapse at index.ts:9108-9117 / type-mapper.ts:79-99; observers
never check the existing sNaN sentinel; late-imports.ts:535-543
null-extern fallback. No standalone `$undefined` singleton.

## Fix direction

Per the value-rep spec P3: standardize the sNaN sentinel
(0x7FF00000DEADC0DE) for `number|undefined` carriers with observer
support; reverse union collapse behind a feature flag with measured
blast radius; add the standalone tag-1 `$undefined` singleton global.
Erasure stays for pure ToNumber/ToBoolean sinks (proven sound).

## Acceptance criteria

- `codePointAt(oob) ?? -1`, `=== undefined`, typeof, and stringification
  observe undefined in both modes; null vs undefined distinct standalone
- Flag-gated collapse reversal lands with perf/size measurements

## Dupe check

Symptom issues filed; the representation phase is unfiled. New (analysis
program).
