---
id: 2106
title: "value-rep P3: undefined observability — UNDEF_F64 sentinel, union-collapse reversal (flagged), standalone $undefined singleton"
status: ready
sprint: 62
created: 2026-06-11
updated: 2026-06-15
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

## Ownership reconcile (#2142, 2026-06-15) — READ BEFORE DISPATCH

#2142 reconciled the two-document conflict (this issue's `UNDEF_F64` sentinel
vs #2051's externref widening). Authoritative decision in
[`2142-undefined-rep-owner-reconcile.md`](2142-undefined-rep-owner-reconcile.md#decision-authoritative--2026-06-15-arch1).
Net effect on this issue's scope:

**Decision rule:** widen to **externref + host `undefined`** when the value
must be observable to `===`/`!==`/`typeof`/ToString/`??`; use the **sNaN
sentinel** only inside hot f64 carriers whose sole consumer is
`emitDefaultValueCheck` (destructuring/default-parameter reads, array/tuple
holes).

**Producer list — #2051's sites are REMOVED from this issue.** The
optional-chain short-circuit sites (`a?.b` / `a?.[i]` / `a?.m()`) are owned by
**#2051** (externref widening, per its own `## Implementation Plan`). Do **not**
apply the `UNDEF_F64` sentinel to optional-chain sites — that channel cannot
reach `===`/`typeof`/ToString (verified: `=== undefined` on an f64 is
unconditionally `false`, `binary-ops.ts:479-482`; the sNaN sentinel is observed
*only* by `emitDefaultValueCheck`, `shared.ts:418`).

**This issue's remaining scope after the reconcile is three disjoint pieces:**

1. **General `number|undefined` observability → externref.** For
   `number|undefined` carriers consumed by `===`/`!==`/`typeof`/ToString/`??`
   (NOT optional-chain — those are #2051), widen to externref + host
   `undefined`, composing with the #2072/#2104 value-rep boxing. This is the
   same mechanism #2051 uses, applied to the non-optional-chain producers.
2. **Codify the sNaN sentinel carve-out (erasure stays).** The existing
   `0x7FF00000DEADC0DE` sentinel for default-check / hole carriers
   (`type-coercion.ts:2672`, `emitDefaultValueCheck`) is **kept** — erasure is
   proven sound for pure ToNumber/ToBoolean and default-initializer sinks. Do
   not widen these to externref (hot path, zero observability gain).
3. **Standalone `$undefined` singleton.** Add the standalone tag-1 `$undefined`
   global so `undefined` is distinct from `null` in standalone mode
   (`late-imports.ts:553-571` currently falls both back to `ref.null extern`).
   This is orthogonal to the host-vs-sentinel choice and aligns with #2104's
   JsTag module.

**Do NOT re-claim `codePointAt(oob) ?? rhs`** — already shipped via the
`??`-site NaN special-case (`logical-ops.ts:208-216`, `isCodePointAtCall`);
#2004 is `done`. Neither this issue nor #2051 touches it.

The flag-gated union-collapse reversal (index.ts:9108-9117 /
type-mapper.ts:79-99) stays in this issue's scope and lands with the
perf/size blast-radius measurement as the acceptance criteria require.

## Dupe check

Symptom issues filed; the representation phase is unfiled. New (analysis
program).
