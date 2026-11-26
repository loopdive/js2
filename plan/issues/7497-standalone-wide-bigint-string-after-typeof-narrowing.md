---
id: 7497
title: "Standalone: String(n) on a wide BigInt narrowed by typeof drops the upper limbs"
status: ready
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [6656, 5883]
---

# #7497: `String(n)` on a wide BigInt narrowed by `typeof` drops the upper limbs (standalone)

## Problem

Under `--target standalone`, a BigInt wider than 64 bits held in an `any` slot
loses its upper limbs when `String()` reads it after a `typeof n === "bigint"`
narrowing. The same value without the narrowing converts correctly.

This is the failing row `narrowedString` in
`tests/issue-6656-bigint-wide-carrier.test.ts`. That file is red on main, so
every PR that touches it fails the required `quality` check, whose
changed-root-tests step runs it.

## Repro

Compile with `compileMulti`, `allowJs`, `target: "standalone"`,
`hostBridge: "off"`, and run with an empty import object:

```js
function LoS(t) { let n = t; if (typeof n === "bigint") return String(n); return "other"; }
function S2(t) { if (typeof t === "bigint") return String(t); return "other"; }
function S3(t) { return String(t); }
export function a() { return LoS(2n ** 64n) === "18446744073709551616" ? 1 : 0; } // 0, expected 1
export function b() { return LoS(5n) === "5" ? 1 : 0; }                            // 1
export function c() { return S2(2n ** 64n) === "18446744073709551616" ? 1 : 0; }  // 0, expected 1
export function d() { return S3(2n ** 64n) === "18446744073709551616" ? 1 : 0; }  // 1
```

Only the `typeof`-narrowed read of a **wide** value is wrong. Small values
convert correctly, and so does an un-narrowed `String(t)`.

## Bisect

`git bisect --first-parent` on main, testing the `narrowedString` row:

- last good: 688eb4de41
- first bad: **89bd4bd78a**, the merge of PR #6182 "fix(codegen): preserve wide
  BigInt String conversion operands" (#5883, 2026-09-27)

## Likely cause

PR #6182 added `src/codegen/string-conversion-argument.ts`.
`compileStringConversionArgument` passes an `externref` expectation to
`compileExpression` for every operand that `ctx.oracle.staticJsTypeOf` types as
`bigint`, in standalone with `nativeStrings`. A `typeof`-narrowed `any`
identifier is typed `bigint`, so the expectation applies to it too. The
narrowed read then appears to go through the i64 lowering before it is boxed,
and that discards the upper limbs.

This is an unverified reading: confirm it in the narrowed identifier read before
choosing the fix site.

## Acceptance criteria

- `tests/issue-6656-bigint-wide-carrier.test.ts` passes in full, including
  `narrowedString`.
- `tests/issue-5883-bigint-string.test.ts` and
  `tests/issue-5883-bigint-string-comma.test.ts` still pass.
- The four repro probes above all return 1.
- Code quality: the fix lives at the operand read or in
  `string-conversion-argument.ts`, and it does not add a second, parallel
  bigint-to-string path.
