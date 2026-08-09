---
id: 3663
title: "Properties are OVER-restricted — configurable/writable read FALSE when the spec requires TRUE (72 + 16 tests)"
status: ready
sprint: current
created: 2026-07-26
updated: 2026-07-26
priority: high
horizon: s
complexity: S
feasibility: medium
task_type: bugfix
area: codegen, runtime
language_feature: property-descriptors
es_edition: es5
goal: es5
related: [3647, 3661, 3662, 739, 3626, 3603]
origin: "2026-07-26 lead measurement of the #3603 host de-inflation regression set (merge_group run 30179758665); independently corroborates opus-loop-e's refutation of the ES5 census's A1 direction."
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/select.ts
  - src/ir/integration.ts
  - src/ir/lower.ts
func-budget-allow:
  - src/ir/from-ast.ts::lowerMethodCall
  - src/ir/select.ts::isPhase1Expr
  - src/ir/integration.ts::makeFromAstResolver
  - src/ir/lower.ts::lowerIrFunctionBody
  - src/ir/lower.ts::emitInstrTree
---

# #3663 — properties are OVER-restricted

## Measured population

From the #3603 de-inflation merged report (merge_group run `30179758665`) diffed
against the baseline JSONL; reconstruction totals **exactly 1,066**, matching the
gate.

| defect kind                  | tests |
| ---------------------------- | ----: |
| `configurable` wrongly FALSE |    72 |
| `writable` wrongly FALSE     |    16 |

The failing clauses read *"obj[X] descriptor should be configurable"* /
*"should be writable"* — i.e. we mark properties **more restricted than the spec
requires**, the opposite direction from #3647/#3661.

## Why this matters more than its size

**It settles a contested direction.** The ES5 census (#3626 §2.2) claimed the
dominant descriptor defect was *"write to non-writable silently succeeds"* —
under-enforcement — and sized it at 51 tests as a "probe-confirmed" floor.

That was refuted twice, independently:

1. **`opus-loop-e`, by corpus signature analysis**: of ~59 corpus-wide `writable`
   failures, **34** were *"expected to be writable, but was not"* (over-restriction)
   against only ~10 in the census's direction — and all 10 of those were
   `language/statements/{using,await-using}/fn-name-*`, i.e. **explicit resource
   management, not ES5 descriptors at all**. The census's probe had used an
   inline-literal descriptor; with a *variable* descriptor HEAD is already
   correct.
2. **This measurement**, from a different corpus slice and a different method.

The two directions are **both real but attribute-specific**, which is the part
neither earlier account captured:

| attribute      | wrongly TRUE | wrongly FALSE |
| -------------- | -----------: | ------------: |
| `writable`     |          202 |            16 |
| `configurable` |          134 |            72 |

So `writable` skews strongly toward over-permissiveness while `configurable`
has substantial traffic in **both** directions. **A single "descriptor defaults"
fix that assumes one direction will regress the other.** That is the concrete
reason this is filed separately rather than folded into #3661.

## Acceptance

- [ ] Identify the mechanism by direct probe on HEAD — specifically, what makes a
      property `configurable: false` that should be configurable.
- [ ] Verify a fix here does **not** regress #3661's 202/134 — run both
      directions as a matrix, not one arm.
- [ ] Regression test **red on the merge base**, covering both directions.
- [ ] Report the **measured flip count** from a re-run, with its denominator.

## ⚠️ Method requirements

- **Do not quote 72 or 16 as flip counts** — floors, not forecasts.
- **Vary the descriptor shape.** The census's A1 error came from testing exactly
  one spelling (inline literal) and generalising; with a variable descriptor the
  behaviour differs. *An unvaried axis is an assumption, not a measurement.*
- Ensure no assertion in a probe can **throw before** the value under test is
  read — that is how the census's A2 row recorded a defect that does not exist.

## Provenance caveat

Baseline used was the then-current cache, not the exact artifact the gate read
(#3648). The 1,066 total matching exactly means the regression **set** is right;
individual counts may shift by a few.
