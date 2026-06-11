---
id: 2051
title: "short-circuited ?. produces the type's default value (0 / \"null\") instead of undefined"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: optional-chaining
goal: core-semantics
related: [16, 2049, 2050, 1603]
origin: "2026-06-10 deep-audit sweep (eval-order agent): verified miscompile on main"
---

# #2051 — optional-chain short-circuit fabricates `0` / `"null"` instead of `undefined`

## Problem

When an optional chain short-circuits, the value must be `undefined`. The
compiler instead pushes the lowered result type's **default value** — `f64 0`
for numeric properties, `ref.null` for reference-typed ones. Idiomatic guards
(`x === undefined`, `typeof x`, string interpolation) silently go wrong.

## Repro (verified on main)

```ts
type Obj = { f: (x: number) => number; v: number };
function getObj(b: boolean): Obj | null { if (b) return { f: (x) => x * 2, v: 9 }; return null; }
export function t4(): string { const o = getObj(false); const r = o?.v; return "" + r; }
export function t6(): string { const o = getObj(false); return typeof (o?.v); }
```

| fn | wasm | node |
|----|------|------|
| `t4` | `"0"` | `"undefined"` |
| `t6` | `"number"` | `"undefined"` |
| `"" + o?.f(1)` (null receiver, `?.()` form) | `"null"` | `"undefined"` |

## Root cause

- `src/codegen/property-access.ts:1095-1102` (`compileOptionalPropertyAccess`
  null-arm pushes `f64.const 0` / `i32.const 0` / `ref.null extern`)
- same pattern at `src/codegen/expressions/calls-optional.ts:43-48,158,168`
  (`defaultValueInstrs(resultType)`)

The optional chain's result is lowered to the property's value type (f64/i32),
which cannot represent `undefined`, so the short-circuit arm fabricates a 0.
Issue #16's original design explicitly chose null/default here — a baked-in
spec deviation, not a regression.

## Fix direction

An optional chain whose target type is primitive must widen the result to
externref (boxed value in the non-null arm, host `undefined` in the null arm),
or at minimum use NaN-boxing/`emitUndefined` consistently with how `undefined`
is represented elsewhere (`emitUndefined`, `__extern_is_undefined`). The
widening must propagate to `===`/`typeof`/ToString consumers. Needs a small
design note (architect input) on representation choice before dev work —
this changes the lowered type of every `?.` expression whose source type is
primitive.

## Acceptance criteria

- `"" + o?.v` and `typeof o?.v` match Node for nullish and non-nullish `o`
- `o?.v === undefined` is true when `o` is nullish
- No regression on non-optional property access perf paths (widening is scoped
  to optional chains)
- test262 `optional-chaining` net positive

## Dupe check

Grepped `instead of undefined`, `optional chain`, `default value` over
plan/issues/. Closest is #1603 (`const x = undefined` receivers, fixed
differently). No issue tracks the short-circuit result representation.
