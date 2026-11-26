---
id: 7526
title: "IR: ToNumeric dynamic numeric ops (neg, - * / %, ++/--, BigInt-aware + and ==)"
status: ready
sprint: Backlog
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: m
feasibility: hard
reasoning_effort: high
task_type: feature
area: ir
goal: backend-agnostic-ir
related: [7525, 7135, 2949, 7403, 7506]
---

# #7526 — IR: ToNumeric dynamic numeric ops

## Problem

The IR's dynamic-operand numeric arms run ToNumber (`dyn.to_number`), then an f64 op. The spec takes ToNumeric for
unary `-`, binary `- * / %` and `++` / `--` (§13.5.5, §13.15.3, §13.4.2–5): a BigInt operand stays a BigInt, and a
BigInt mixed with a Number throws TypeError. Unary `+` is ToNumber, which throws on a BigInt; `+` addition and loose
equality have their own BigInt steps (§13.15.3 step 1.b, §7.2.15). The IR has no BigInt value, so it cannot lower any
of these on a BigInt.

#7525 stops the IR from claiming such units when the checker types an operand with a BigInt member (host-free lanes),
so legacy compiles them. That is a refusal, not support. Still wrong after #7525, measured by S18 on main 1a726b3e64:

| shape | node | gc (legacy) | standalone |
| --- | --- | --- | --- |
| `-t` on `t` narrowed to `bigint \| number`, `5n` | `-5n` | wrong | right after #7525 (refused) |
| `-t`, `t * t`, … on an un-narrowed `t: any` holding a BigInt | BigInt result | NaN | NaN |

## Direction

A dynamic numeric op family whose lowering is ToNumeric on the carrier:

- `dyn.neg`, `dyn.arith(op)` for `- * / % **`, `dyn.inc` / `dyn.dec`: a BigInt operand goes through the native BigInt
  carrier helpers (`__bigint_carrier_neg` exists, #6656; the binary ones need adding), a Number through f64, a mix
  throws TypeError. The result is `dynamic`, not `f64`.
- `dyn.add` and loose `dyn.eq` gain their BigInt steps; the latter overlaps #7403's open loose-equality rows (a BigInt
  case in `__extern_loose_eq`).
- Selector and builder then claim the #7525 shapes instead of refusing them, and #7525's refusal helper goes away.

Cost to plan for: a new op touches every exhaustive dynamic-op switch (builder, verifier, effects, inline-small,
monomorphize, legalization, lower-generic, prepared dependencies, async-linear), and the `dynamic` result changes what
the selector and builder promise for these expressions today (`f64`).

## Acceptance criteria

- The #7525 pins pass with the IR claiming `f` (`trackIrOutcomes`), on standalone and gc.
- The rows above answer like node on both pipelines.
- An Implementation Plan reviewed before code, per the IR code-quality rule.
