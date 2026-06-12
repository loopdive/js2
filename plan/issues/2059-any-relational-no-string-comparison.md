---
id: 2059
title: "relational operators on two any/externref operands never perform string comparison (\"a\" < \"b\" → false)"
status: ready
sprint: 62
created: 2026-06-10
updated: 2026-06-12
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

---

## Implementation Plan (per-site delta — shared design in #2058)

> **Read [#2058's `## Implementation Plan`](./2058-any-plus-runtime-string-numeric-add.md)
> first** for the shared root cause, the −788 boxing-site trap, the dual-mode
> probe table, and the per-site tag-dispatch mechanism. This section covers only
> the relational deltas. **Land order: this is step 3 — after #2058.**

### Root cause (relational-specific)

Two converging gates blind relationals to strings:

1. **Dispatch gate** (`binary-ops.ts:958-962`): `compileAnyBinaryDispatch` is
   only entered for `isPlusOp || isEqualityOp` — relationals are deliberately
   excluded, so `any < any` never reaches the AnyValue helpers even when
   `anyValueTypeIdx >= 0`.
2. **`__any_lt` is numeric-only** anyway (`any-helpers.ts:1305-1323`): all four
   comparison helpers do `__any_to_f64(a) f64op __any_to_f64(b)`, so
   `"a" < "b"` becomes `NaN < NaN = false`.
3. In default mode `anyValueTypeIdx < 0`, both externref operands hit the
   **externref-numeric fallback** (`binary-ops.ts:1815-1828`) → `f64.lt(NaN,NaN)`.

### Changes

**File: `src/codegen/binary-ops.ts`**

- **New gate, placed alongside the #2058 `+` gate, BEFORE the
  externref-numeric fallback at line 1815.** Condition:
  `isRelational && (leftType.kind === "externref" || rightType.kind === "externref")`
  where `isRelational` is already computed at line 968-972 (move/duplicate that
  flag above the gate).
- Spill both operands to externref temps (the #1776 spill at 1877-1887).
- **JS-host path:** emit the new shared `__host_compare(externref, externref)
  -> i32` (spec'd in #2058), then map its 4-way result to the operator:

  | op | predicate on `cmp = __host_compare(l, r)` |
  |----|--------------------------------------------|
  | `<`  | `cmp == -1` (i32.const -1; i32.eq) |
  | `>`  | `cmp == 1` |
  | `<=` | `cmp == -1 OR cmp == 0` → `(cmp \| 0x?) ` — simplest: `cmp <= 0 AND cmp != 2` ; or test `cmp == -1 \|\| cmp == 0` |
  | `>=` | `cmp == 1 \|\| cmp == 0` |

  The `cmp == 2` (NaN/undefined incomparable) sentinel makes **all four**
  operators yield `0` (false) for any NaN/undefined operand, matching §7.2.13
  (IsLessThan returns `undefined` → the relational expression is `false`). Build
  each predicate so that `cmp == 2` can never satisfy it (for `<=`/`>=`, test the
  two concrete values explicitly rather than `cmp <= 0` / `cmp >= 0`, since `2`
  would wrongly pass `>= 0`).
- **Standalone path** (`noJsHost && ctx.nativeStrings && ctx.anyStrTypeIdx >=
  0`): inline §7.2.13 dispatch on the externref temps, mirroring
  binary-ops.ts:879-908 + the #1914 string arm:
  - if **both** `__typeof_string` → `any.convert_extern` + `ref.cast
    $AnyString` + `__str_flatten` both, `__str_compare` → returns -1/0/1
    (native-strings.ts:1656-1657 — already the exact convention), map to op.
  - else ToNumber both (string→`__str_to_number`, number→`__unbox_number`,
    bool→`f64.convert_i32_s` after `__unbox_boolean`) and `f64.lt/le/gt/ge`.
    NaN propagates → `false` automatically (f64 comparisons with NaN are false).
  - §7.2.13 subtlety: string-vs-string is **lexicographic**, but
    string-vs-number is **numeric** (ToNumber the string). So the "both strings"
    test must be `AND`, not `OR` — a mixed `"10" < 9` goes numeric
    (`10 < 9 = false`), matching the issue's acceptance criterion
    `lt("10", 9)` numeric.
- **Fast path preserved:** when the checker proves both operands numeric, skip
  the gate (the existing numeric relational path at 1815 runs). No perf change
  on provably-numeric compares (acceptance criterion).

### Optional: also fix `__any_lt` for the `anyValueTypeIdx >= 0` (fast) mode

If a module already has `anyValueTypeIdx >= 0` (fast mode with boxed any), the
cleanest secondary fix is to (a) extend the dispatch gate at line 958 to include
relationals, and (b) make `addComparisonHelper` (`any-helpers.ts:1305`)
tag-aware: when both tags are 5 (string), compare via `wasm:js-string`/`__str_*`
content ordering; else fall to the existing `__any_to_f64` numeric path. This is
**lower priority** than the externref-site fix because default mode (externref,
`anyValueTypeIdx < 0`) is where the issue's repro actually lives — but doing both
closes the gap in both lowerings. Gate it behind the same staged landing.

### Edge cases (relational-specific; see #2058 for the shared list)

- `lt("a","b")` → `true`, `lt("10","9")` → `true` (lexicographic: "1" < "9").
- `lt("10", 9)` → numeric `10 < 9` → `false` (mixed → ToNumber).
- NaN operand → all relationals `false` (the `cmp == 2` sentinel / f64 NaN rule).
- `null < 1` → `0 < 1 = true`; `undefined < 1` → `NaN < 1 = false` (ToNumber).

### Coordination note (dev-4) — interim fix must be forward-compatible

As of this spec, the local `issue-2059-any-relational-string` branch has **0
commits ahead of main** and is **not pushed to origin** — no implementation
exists to conflict with. Dev-4 was told to either **scope #2059 to
provably-string operands** or **release the issue**.

**Any scoped interim fix MUST be compatible with the general mechanism here**:

- A provably-string-only interim (both operands statically `string`, route to
  `__str_compare` / `wasm:js-string` ordering) is an **acceptable subset** of
  this design — it is exactly the "both `__typeof_string`" arm, just resolved at
  compile time instead of at runtime. Land it as the **statically-typed fast
  path** that sits *in front of* the externref runtime gate, not as a competing
  mechanism. Do **not** introduce a separate helper or a separate boxing scheme
  that the full externref gate would later have to unwind.
- Do **not** implement the interim by flipping `anyValueTypeIdx` on in default
  mode or by re-tagging at the `externref→AnyValue` boxing site — that is the
  −788 trap (see #2058's shared plan). The interim must stay **per-site on the
  operands**, same as the full fix.
- The general fix here **supersedes and absorbs** any such interim: when this
  lands, the runtime externref gate handles the `any < any` repro and the
  provably-string fast path remains a pure compile-time shortcut. No rework of
  the interim is required if it followed the two rules above.

This design slots the relational gate **next to** the #2058 `+` gate and
**reuses** the same spill scaffolding and the new `__host_compare` host import,
so dev-4 should implement the full #2059 **after** #2058 lands (or coordinate to
share the spill/dispatch helper). If dev-4 has already chosen a divergent
approach (e.g. routing through `__any_lt` only, or a bespoke boxing path),
reconcile toward the externref-site gate here, since that is the path the repro
exercises in default mode.

### Test files to verify (#2059)

- This issue's repros: `lt("a","b")`, `lt("10","9")` → `true`; `lt("10",9)` →
  `false`; provably-numeric `lt(1,2)` unchanged.
- Standalone test262 shard: confirm no movement in comparator buckets (the −788
  guard from #2058 — relational gate is disjoint from equality, so the
  `isSameValue` path is untouched).
