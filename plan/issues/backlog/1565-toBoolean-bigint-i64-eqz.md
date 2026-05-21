---
id: 1565
title: "ToBoolean BigInt: must use i64.eqz, not f64.convert_i64_s (§7.1.2)"
status: ready
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bug
area: codegen
goal: spec-completeness
es_edition: ES2020
language_feature: bigint
test262_fail: 12
created: 2026-05-21
---

# ToBoolean BigInt: must use i64.eqz, not f64.convert_i64_s

## Problem

`Boolean(0n)` currently goes through `f64.convert_i64_s` → ToBoolean(f64). For BigInts > 2^53 this drops precision and gives wrong truthiness. Per §7.1.2 ToBoolean, the BigInt path is binary: `0n` is `false`, every other BigInt is `true`.

## Spec

ECMAScript §7.1.2 ToBoolean: "If argument is a BigInt: Return false if argument is 0n; otherwise return true."

## Fix

In `src/codegen/type-coercion.ts` add an i64.eqz path for ToBoolean when the source is i64 (BigInt). Emit `i64.eqz` then invert: `i32.eqz` on the result to get the BigInt-truthy bit.

## Acceptance criteria

- [ ] `Boolean(0n)` returns `false`
- [ ] `Boolean(1n)` returns `true`
- [ ] `Boolean(2n ** 100n)` returns `true` (no f64 precision loss)
- [ ] `if (0n) { ... }` does not enter the branch
- [ ] +~12 test262 passes
