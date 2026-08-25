---
id: 4268
title: "codegen: preserve implementation arity when a generic overload's first call is shorter"
status: done
sprint: 78
created: 2026-08-09
updated: 2026-08-18
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: function-overloads
goal: dogfood
related: [1121, 3471, 4267]
assignee: "ttraenkler/typescript-upstream-source-build"
---

# codegen: preserve implementation arity when a generic overload's first call is shorter

## Problem

Generic call-site ABI inference stops at the first same-name call and copies the
resolved overload signature. When that overload has fewer parameters than the
body-bearing implementation, the runtime function is created with a truncated
Wasm signature. Optional-parameter metadata then indexes past the inferred
parameter array and crashes in `extractConstantDefault()`:

```ts
export function some<T>(values: readonly T[]): boolean;
export function some<T>(values: readonly T[], predicate: (value: T) => boolean): boolean;
export function some<T>(
  values: readonly T[],
  predicate?: (value: T) => boolean,
): boolean {
  return predicate === undefined ? values.length > 0 : predicate(values[0]);
}

some([1]); // the first call selects the one-parameter overload
some([1], value => value === 1);
```

The implementation has two runtime parameter slots even when one call omits
the optional second argument. Selecting an overload may specialize parameter
types, but it must not erase implementation parameters.

## TypeScript package impact

After #4267 removes bodyless overload signatures from runtime inventory, the
exact 280-file TypeScript v5.9.3 source graph reaches
`src/compiler/core.ts::some`. Its first local call selects the one-parameter
overload, while the implementation's optional `predicate` is parameter 1. The
build fails after 9.35 seconds with an undefined `ValType` at
`src/codegen/index.ts:775` rather than producing a binary.

## Acceptance criteria

- [x] A generic overload whose first call is shorter than its implementation
      compiles and returns `42` from Wasm after both short and full-arity calls.
- [x] Generic call-site inference retains the first call's established ABI
      types/results while filling every implementation parameter slot from a
      resolved full-arity call when one exists.
- [x] If no full-arity call exists, missing optional implementation slots get a
      conservative declaration-derived representation instead of crashing.
- [x] Existing generic-inference and overload regressions remain green.
- [x] The exact TypeScript v5.9.3 source probe advances beyond
      `compiler/core.ts::some`; the next honest frontier is recorded.

## Scope

Fix generic ABI inventory construction in
`src/codegen/declarations/param-return-inference.ts` and its exact declaration
wiring. Do not special-case TypeScript, `some`, or callback parameters, and do
not weaken `extractConstantDefault()` to accept an undefined type.

## Result

`resolveGenericCallSiteTypes()` now knows the exact body-bearing declaration's
arity. It preserves the first resolved call's parameter/result specialization,
continues scanning only while implementation slots are missing, and appends
the additional slots from a wider resolved overload. If no call supplies an
optional trailing slot, the resolver uses its declaration type as a
conservative carrier instead of returning an incomplete ABI.

The focused runtime regression executes both a short and full-arity call and
returns `42`; a second case proves a never-supplied optional implementation
slot is still represented. #4267's overload-owner tests and typecheck remain
green.

The exact TypeScript v5.9.3 source probe now passes `compiler/core.ts::some` and
reaches the next independent source-inventory frontier after 18.50 seconds:

```text
Codegen error: class callable Version_new has no consistent exact
class-constructor inventory owner
(at src/codegen/program-abi-class-callable-planning.ts:181:13)
```

The declaration is `src/compiler/semver.ts::Version`, whose class constructor
also has overload signatures followed by one body-bearing implementation. No
binary is claimed from this probe.
