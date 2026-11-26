---
id: 7411
title: "Legacy i32 locals: `x >>>= 0` on a negative value and `x++` at INT32_MAX give wrong results"
status: done
sprint: current
created: 2026-11-19
updated: 2026-11-26
completed: 2026-11-26
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7394, 1236]
---

# #7411 — the legacy integer-local analysis keeps two non-int32 writes in an i32 slot

## Problem

RV7335 found this while reviewing #7394. The default pipeline is correct. Legacy codegen (`experimentalIR: false`, or
any function the IR does not claim) is wrong. Measured on `origin/main` ee3fcdd610 (2026-11-19), gc and standalone
alike:

| program | node | legacy path |
| --- | --- | --- |
| `let x: number = -1; x >>>= 0; return x;` | 4294967295 | 2147483647 |
| `let x: number = 2147483647; x++; return x;` | 2147483648 | -2147483648 |
| `let x: number = 2147483647; x += 1; return x;` (control) | 2147483648 | correct |

## Cause

`collectI32CoercedLocals` (`src/ir/analysis/i32-coerced-locals.ts`) promotes a local to an i32 slot when every
write is "i32-safe". Two of its rules are wrong:

- **`>>>=` produces an unsigned 32-bit value.** `isCompoundI32Safe` treats it like the signed bitwise compounds, but
  its result (0..2³²−1) does not fit an int32 slot. The `>>>` arm of `isI32SafeExpr` needs the same review.
- **`++` / `--` are recorded as always safe** (`{ kind: "incdec" }`), so the i32 add wraps at the int32 bounds where
  JavaScript leaves the int32 range. #1236 already demoted `+=` / `-=` for exactly this overflow reason; `incdec`
  needs the same rule or a range proof.

## Resolution (2026-11-26)

Fix in `src/ir/analysis/i32-coerced-locals.ts`, reusing the #1236 rule that already demotes `x += 1`:

- `x++` / `x--` are recorded as the compounds `+=` / `-=`, so `isCompoundI32Safe` demotes them exactly as it
  demotes `+=`. The separate `incdec` mutation kind, which was never checked, is gone.
- `>>>=` left the signed bitwise list of `isCompoundI32Safe`. The `>>>` arm of `isI32SafeExpr` already excluded it.
- `isCompoundI32Safe` lost its unused `rhs` parameter; the fixpoint loop's duplicated `init` / `assign` branches
  became one check.

For-loop counters are unaffected: they are promoted through `forCounterCandidates`, not this candidate list.

Measured against `origin/main` c3b7be66:

- `tests/issue-7411-i32-local-ushr-incdec-overflow.test.ts`: 16 of 32 cases fail on main, 32 pass with the fix
  (default and legacy pipelines × gc and standalone). The default pipeline was also wrong on
  `const y = ++x` at INT32_MAX.
- Byte identity: 100 test262 files (70 by stride, 30 by stride over files with a `let`/`const` and `++`/`--`/`>>>=`)
  × default and standalone, the same × legacy pipeline, and the 13 playground examples × {gc, standalone} ×
  {default, legacy}: 0 differing binaries.
- Positive control: a module with `hit()` (`x++` at INT32_MAX, `u >>>= 0`) and `miss()` (bitwise accumulator and a
  loop counter): in all four modes every WAT difference is inside `$hit`; `$miss` is identical.

