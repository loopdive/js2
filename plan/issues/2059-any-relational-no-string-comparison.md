---
id: 2059
title: "relational operators on two any/externref operands never perform string comparison (\"a\" < \"b\" → false)"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-11
completed: 2026-06-11
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: type-coercion
goal: core-semantics
related: [117, 295, 2058]
origin: "2026-06-10 deep-audit sweep (coercion agent): verified miscompile on main"
---

# #1939 — `any < any` skips §7.2.13 string comparison

## Problem

[§7.2.13 IsLessThan](https://tc39.es/ecma262/#sec-islessthan) compares strings
lexicographically when both ToPrimitive results are strings. With
`any`/externref operands the compiler unboxes both to f64 (`Number("a")` →
NaN), so every string relational yields `false`.

## Repro (verified on main)

```ts
export function lt(a: any, b: any): boolean { return a < b; }
```

| call | wasm | node |
|------|------|------|
| `lt("a","b")` | `0` | `true` |
| `lt("10","9")` | `0` | `true` |

Statically-typed `string` params compare correctly — only `any`/externref
operands are affected.

## Root cause

`src/codegen/binary-ops.ts:899-921` deliberately skips AnyValue dispatch for
relationals ("strictly numeric ops … unbox to f64 directly"). Both operands
then hit the externref-numeric path (1721-1733) → `__unbox_number` →
`Number("a") = NaN` → `f64.lt(NaN, NaN) = false`. The existing `__any_lt`
helper (line 2299) is unreachable for this case.

## Fix direction

Route relationals with any/externref-typed operands through a runtime helper
(`__host_lt` family or the existing `__any_lt` after boxing) that implements
§7.2.13 string-vs-number dispatch; keep the f64 fast path only when the
checker proves both operands numeric. Standalone fallback required (dual-mode
policy). Likely shares plumbing with #2058.

## Acceptance criteria

- `lt("a","b")`, `lt("10","9")` match Node; mixed `lt("10", 9)` numeric
- NaN-operand relationals still false
- No perf regression on provably-numeric compares

## Dupe check

Grepped `relational`, `string comparison`, `__any_lt` — #117 (harness string
compare, done), #295 (comparison ops, bigint-focused, done), #1563/#1577
(broad spec audits, item absent). Not covered.

## Resolution (2026-06-11)

The root-cause note about `__any_lt` was a red herring for the **default**
(JS-host) compile path: there `ctx.anyValueTypeIdx` is `-1`, so the AnyValue
helpers are never registered and `any` operands compile to **externref**, not
`$AnyValue`. The numeric fast path then coerces both externrefs to f64
(`__unbox_number` → `Number("a") = NaN`), so every string relational was false.

Fix (JS-host path, dual-mode safe):
- Added a `__host_relational` host import + `host_relational` intent
  (`src/compiler/import-manifest.ts`, `src/index.ts`, `src/runtime.ts`). It
  takes `(externref, externref, i32 opcode)` where opcode 0/1/2/3 =
  `<`/`<=`/`>`/`>=` and delegates to the native JS operator, which already
  implements §7.2.13 (ToPrimitive + lexicographic string compare).
- In `compileBinaryExpression` (`src/codegen/binary-ops.ts`), before the numeric
  coercion, when the op is relational, a JS host is available, **and neither
  operand is statically typed as a primitive we already handle numerically**
  (number / boolean / bigint / string), compile both operands as externref and
  call `__host_relational`. The "both non-primitive" guard keeps the
  provably-numeric and provably-string fast paths untouched (no perf
  regression). Standalone/WASI (`ctx.standalone`/`ctx.wasi`) falls through to
  the existing numeric path — no new unsatisfiable host import is emitted.

### Test Results

New `tests/equivalence/any-relational-string.test.ts` — 16 cases covering
string lexicographic (`"a"<"b"`, `"10"<"9"`, `"abc"<"abd"`, `"abc"<"ab"`),
mixed string/number (numeric), pure numeric, NaN, and null/undefined, across
all four operators. All pass. No regressions in string-relational-operators /
comparison-coercion / boolean-relational-comparison / i32-loop-compare /
string-arithmetic-coercion / logical-operators (48 tests green).
