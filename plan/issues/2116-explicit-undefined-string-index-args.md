---
id: 2116
renumbered_from: 1957
title: "explicit undefined as optional string-index arg coerced to NaN/0 instead of per-method default (substring/slice/lastIndexOf/endsWith/repeat, both backends)"
status: wont-fix
sprint: 61
created: 2026-06-10
updated: 2026-06-12
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: string-methods
goal: core-semantics
related: [1248, 1381, 2115]
origin: "2026-06-10 deep-audit sweep (strings agent): verified miscompile on main"
---

# #2116 — explicit `undefined` ≠ absent for string method index args

## Problem

Spec: when an optional index arg is `undefined`, methods default it (e.g.
substring's *If end is undefined, intEnd = len*). The compiler coerces explicit
`undefined` through an f64 slot (NaN→0) or `i32.trunc_sat` (→0).

## Repro (verified on main)

| case | node | jsHost | native |
|------|------|--------|--------|
| `"hello".substring(1, undefined).length` | 4 | **1** | **1** |
| `"hello".slice(1, undefined).length` | 4 | **0** | **1** |
| `"aba".lastIndexOf("a", NaN)` | 2 | 2 | **0** |
| `"aba".lastIndexOf("a", undefined)` | 2 | 2 | **0** |
| `"hello".endsWith("lo", undefined)` | true | true | **false** |
| `"a".repeat(-0.5)` | `""` | `""` | **throws RangeError** |

## Root cause

- Host path: `string_substring`/`string_slice` imports take
  `(externref, f64, f64)`; explicit `undefined` coerces to f64 NaN
  (calls.ts generic arg loop ~7225-7240) → host runs `substring(1, NaN)`. The
  `padsUndefined` fix (#1381, calls.ts ~7250) covers only *missing* args, not
  explicit `undefined` in f64-typed slots.
- Native path: `compileStringIntegerArg` (`src/codegen/string-ops.ts:1754`)
  coerces via `i32.trunc_sat_f64_s` → undefined/NaN → 0 for every position arg
  (`lastIndexOf` absent-default is `0x7fffffff` but explicit undefined → 0,
  string-ops.ts:2021; `endsWith` same at 2060).
- Native `repeat`: RangeError check `count < 0` runs on the un-truncated f64
  (string-ops.ts:2098-2117); spec truncates first (ToIntegerOrInfinity(-0.5)
  = -0).

## Fix direction

Detect statically-undefined args at the call site and substitute the
per-method default (len / NaN-passthrough / 0x7fffffff); for dynamic
`number | undefined` args, branch on undefined before truncation. For repeat,
truncate before the range check (keep the +Infinity check on the f64).

## Acceptance criteria

- All six table rows match Node on both backends
- Absent-arg defaults (#1248/#1381) unregressed

## Dupe check

#1248 (missing-arg defaults, done), #1381 (null-vs-undefined padding for
*missing* args, done). Explicit-undefined / NaN-through-f64-slot untracked.

## Closed as duplicate (2026-06-12)

Duplicate of #2124 — the same audit batch was filed twice (#2110–#2117 ≡ #2118–#2125). The high series is canonical: merged/open PRs reference #2120–#2125. No work was lost; see #2124.
