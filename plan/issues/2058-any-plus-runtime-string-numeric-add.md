---
id: 2058
title: "+ and += with a runtime string in an any/externref position do numeric addition instead of concatenation"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: type-coercion
goal: core-semantics
related: [79, 308, 1134, 1175, 2059]
origin: "2026-06-10 deep-audit sweep (coercion agent): verified miscompile on main"
---

# #2058 — `any + any` with runtime strings forces f64 addition

## Problem

Per [§13.15.3 ApplyStringOrNumericBinaryOperator](https://tc39.es/ecma262/#sec-applystringornumericbinaryoperator),
`+` must ToPrimitive both operands and concatenate if *either* primitive is a
string. With `any`/externref-typed operands carrying runtime strings, the
compiler unconditionally unboxes to f64: `1 + "2"` → `3` instead of `"12"`.

## Repro (verified on main)

```ts
export function plus(s: any): any { return 1 + s; }
export function plusBoth(a: any, b: any): any { return a + b; }
export function compound(s: any): any { let x = 1; x += s; return x; }
```

| call | wasm | node |
|------|------|------|
| `plus("2")` | `3` | `"12"` |
| `plusBoth("1","2")` | `3` | `"12"` |
| `compound("2")` | `3` | `"12"` |

## Root cause

Three converging paths in `src/codegen/binary-ops.ts` /
`src/codegen/expressions/assignment.ts`:

1. AnyValue dispatch (binary-ops.ts:905-921) requires
   `leftIsAny && rightIsAny` *and* `ctx.anyValueTypeIdx >= 0`; for plain
   externref-typed `any` params in default (non-fast) mode the AnyValue infra
   isn't active, so even any+any falls through.
2. String-concat routing (941-952) is gated on the static checker type
   `isStringType`, which `any` never satisfies.
3. The externref-numeric fallback (1721-1733) unconditionally unboxes externref
   operands to f64 with hint "number".

Compound `+=` shares the defect via the `hasStringAssignment` heuristic
(assignment.ts:4573-4585).

## Fix direction

For `+` with any externref/any-typed operand, emit a runtime-dispatched add
(a `__host_add` import mirroring `__host_loose_eq` from #1134, with a
standalone tag-dispatch fallback) instead of forcing f64. The same helper
serves `+=` when the LHS static type is any/unknown. Keep the f64 fast path
when the checker proves both operands numeric.

## Acceptance criteria

- All three repros match Node (`"12"`)
- `any + any` with two numbers still numeric (`1 + 2 = 3`)
- Object operands go through ToPrimitive (valueOf/toString order)
- Standalone mode covered (no host-only fix)

## Dupe check

Grepped `compileAnyBinaryDispatch`, `concat` + `any`, `addition` + `externref` —
#79 (AnyValue infra, done, fast-mode only), #308 (static string/number
addition, done), #1175 (concat type mismatch, different). Not covered.
