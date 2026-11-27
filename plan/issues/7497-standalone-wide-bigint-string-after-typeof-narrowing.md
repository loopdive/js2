---
id: 7497
title: "Standalone: String(n) on a wide BigInt narrowed by typeof drops the upper limbs"
status: done
sprint: current
created: 2026-11-26
updated: 2026-11-26
completed: 2026-11-26
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [6656, 5883, 7506]
---

# #7497: `String(n)` on a wide BigInt narrowed by `typeof` drops the upper limbs (standalone)

## Problem

`tests/issue-6656-bigint-wide-carrier.test.ts` row `narrowedString` is red on main. In that file's SOURCE:

```js
function LoS(t) { let n = t; if (typeof n === "bigint") return String(n); return "other"; }
export function narrowedString() { return LoS(2n ** 64n) === "18446744073709551616" ? 1 : 0; }
```

It returns 0 under `--target standalone` with `hostBridge: "off"`. The required `quality` check runs every root test
file a PR changes, so this red row blocks any PR that touches the file.

## Repro

Run the row in its own file:
`node node_modules/vitest/dist/cli.js run tests/issue-6656-bigint-wide-carrier.test.ts -t "narrowedString|compiles host-free"`.

The surrounding SOURCE matters. Its helpers also see non-bigint call sites, which makes their parameters reference
slots. A minimal stand-alone file where `LoS` is only ever called with a BigInt does not reproduce: that shape fails
even at the good commit, for the separate reason in #7506.

| commit | narrowedString |
|---|---|
| 688eb4de41 (last good) | pass (25/25 rows, RV7450) |
| 89bd4bd78a (first bad) | fail |
| main 1a726b3e64 | fail |

## Bisect

`git bisect --first-parent` on main, testing `narrowedString|compiles host-free` (S23):

- last good: 688eb4de41;
- first bad: 89bd4bd78a, the merge of PR #6182 "fix(codegen): preserve wide BigInt String conversion operands"
  (#5883, 2026-09-27).

## Cause (confirmed, S18)

The narrowed identifier read unboxed the value to i64 whatever its consumer wanted. When the checker narrows a slot
held as `externref` to `bigint`, `compileIdentifierCore` (`src/codegen/expressions/identifiers.ts`) called
`narrowTypeToUnbox`, which emitted `__to_bigint`. PR #6182 made `String()` ask for an `externref` operand (and register
the wide carrier types first), so the i64 was boxed again as a narrow `$BigInt`: every bit past 64 was lost. Before
#6182 the same operand reached `String()` through a path that kept the carrier. The comments above both unbox arms
still described a "JS-host: leave the externref on the stack" branch that no longer existed.

## Fix (PR #7459)

- `compileExpression` forwards its expected type to the identifier read (`compileIdentifier` → `compileIdentifierCore`).
- `emitNullablePrimitiveUnbox` leaves a BigInt carrier alone when a reference is wanted; an i64 consumer (arithmetic)
  still gets the i64.
- `narrowTypeToUnbox` folds into `emitNullablePrimitiveUnbox` instead of repeating its per-kind unbox; the dead
  `isHeterogeneousUnion` guard (only true for a union, which `isUnion()` already returns for) and the stale JS-host
  comments go. `identifiers.ts` is 18 lines shorter.

Measured on main 1a726b3e64:

- `tests/issue-7497-narrowed-bigint-keeps-carrier.test.ts` (new) together with the 6656 file: 7 of 36 fail on main,
  `narrowedString` included; with the fix, 7497 + 6656 + 5883 pass 65/65.
- Narrowed-`String()` probes: pass at 688eb4de41, fail at 89bd4bd78a and on main, pass with the fix.
- Bytes identical to main on 160 test262 files × {gc, standalone}; the 56 bigint/narrow/typeof test files fail the same
  51 tests on main and with the fix.

## Pre-existing gap (not this regression)

`String(t)` on a wide BigInt in an untyped parameter is also wrong when the function is called only with BigInts.
RV7450 added these probes to the 6656 SOURCE (review of #7450, comment 7190408344):

- `S2(t)`, narrowed on the parameter itself;
- `S3(t)`, un-narrowed.

Both fail at 688eb4de41, at 89bd4bd78a, on main and with this fix. They predate #6182. Cause: each is called only with
`2n ** 64n`, so call-site inference gives `t` an i64 parameter and the value wraps at the call. Given one non-BigInt
caller, both pass with this fix. Filed as #7506.

## Acceptance criteria

- `tests/issue-6656-bigint-wide-carrier.test.ts` passes in full, `narrowedString` included.
- `tests/issue-5883-bigint-string.test.ts` and `tests/issue-5883-bigint-string-comma.test.ts` still pass.
- The pre-existing `String(any wide BigInt)` gap is filed or linked (#7506), not claimed fixed.
- Code quality: the fix lives at the operand read or in `string-conversion-argument.ts`, with no second
  bigint-to-string path.
