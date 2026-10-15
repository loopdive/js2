---
id: 7007
title: "standalone number formatting: `toFixed/toPrecision/toExponential` round the decimal-scaled f64 rather than the exact binary value — `(1.45).toFixed(1)` → `"1.5"` (node `"1.4"`), `(0.615).toFixed(2)` → `"0.62"`, `(10.235).toFixed(2)` → `"10.24"`; `toExponential()` with no argument emits 6 digits; `(x as any).toString(16)` traps `dereferencing a null pointer`"
status: ready
sprint: current
created: 2026-10-15
updated: 2026-10-15
priority: medium
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: compiler
language_feature: number-formatting, Number.prototype
goal: standalone-gap
related: [1335, 6642]
---

# Number formatting rounds the wrong value

Reported by the 2026-10-15 audit (coercion lane, CONFIRMED standalone). Not re-run by the lead — reproduce first.

## Repro (node → wasm, standalone)

| expr | node | wasm |
|---|---|---|
| `(1.45).toFixed(1)` | "1.4" | "1.5" |
| `(0.615).toFixed(2)` | "0.61" | "0.62" |
| `(10.235).toFixed(2)` | "10.23" | "10.24" |
| `(4.35).toFixed(1)` | "4.3" | "4.4" |
| `(1.45).toPrecision(2)` | "1.4" | "1.5" |
| `(1.45).toExponential(1)` | "1.4e+0" | "1.5e+0" |
| `(123456).toExponential()` | "1.23456e+5" | "1.234560e+5" |
| `const x: any = 255; x.toString(16)` | "ff" | trap: dereferencing a null pointer |

## Root cause

- `src/codegen/number-format-native.ts:21-29, 403` — the header documents "scaled f64 … round-half-away … exact to ~15-16 digits"; it rounds `x * 10^f` as an f64, so values whose binary expansion is just below the decimal midpoint (1.45 = 1.4499999…) round up. §21.1.3.3 step 10 requires the exact mathematical value: "let n be an integer for which n / 10^f - x is as close to zero as possible; if there are two such n, pick the larger". The no-arg `toExponential` shortcut is at :444. The `any`-receiver `toString(radix)` trap is the #6642 S62 arm in `number-primitive-method-call.ts:105-135`.

## Implementation Plan

1. Replace the scaled-f64 rounding with an exact digit generation: either (a) use the existing shortest-roundtrip digit generator (`src/stdlib/number-format.ts` has the Grisu/Ryu-style path used by `toString`) to get the exact decimal expansion and then round the DIGIT STRING at position `f` with the "pick the larger n on a tie" rule (ties can only occur when the exact expansion terminates at the midpoint, which the digit string shows exactly), or (b) do exact integer arithmetic on the f64's mantissa/exponent (i64 + a small bigint-free long-division for up to 20 fraction digits). (a) is less code; check that the digit generator exposes the full exact expansion, not just the shortest-roundtrip digits — `toFixed(20)` needs up to 20 fraction digits of the exact value (#1335 Phase 2 is the same requirement).
2. `toExponential()` without an argument: as many digits as necessary to uniquely represent the number (shortest round-trip), per §21.1.3.2 step 9; use the same digit generator.
3. `toPrecision`/`toExponential(f)` share the digit-string rounding helper from step 1.
4. `(x as any).toString(16)`: in `number-primitive-method-call.ts` S62 arm, the receiver unbox for an AnyValue-carried number is missing the tag-3/tag-2 path (or dereferences a null string); route through the same AnyValue→f64 dispatch #6998 fixes.
5. Tests: the table above plus `(1.005).toFixed(2)` → "1.00", `(1.5).toFixed(0)` → "2", `(2.5).toFixed(0)` → "3" (ties pick larger n), `(-1.5).toFixed(0)` → "-2", `(0).toFixed(2)` → "0.00", `(1e21).toFixed(2)` → "1e+21", `(0.000001).toExponential()` → "1e-6".

## Acceptance

- Table matches node on standalone; gc unchanged (host path).
- `tests/equivalence/*number-format*`, `*toFixed*` pass.

## Validation protocol (every issue from the 2026-10-15 audit)

- Add `tests/equivalence/issue-7007-number-format-exact-rounding.test.ts` with the repros below (node vs Wasm, `target: "standalone"` AND the default gc lane unless the issue says standalone-only). Follow the helper pattern of an existing `tests/equivalence/*.test.ts`.
- Scoped checks before pushing: the new test file, the nearest existing equivalence files for the touched area, `npx tsc --noEmit -p .` if it is fast enough, and the chained gates from CLAUDE.md (`check-loc-budget`, `check-func-budget`, `check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`).
- Keep gc output byte-identical where the change is standalone-only; if a shared path changes, say so in the PR body and name the equivalence files that cover it.
- Do not widen scope: one root cause per PR. Record anything adjacent you notice as a note in this file, not as code.
