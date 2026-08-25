---
id: 4267
title: "codegen: give top-level overload implementations a canonical callable owner"
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
related: [1058, 1579, 3994, 3998]
assignee: "ttraenkler/typescript-upstream-source-build"
---

# codegen: give top-level overload implementations a canonical callable owner

## Problem

`compileProject()` rejects an ordinary TypeScript overload set before emitting
Wasm when the function is not exported:

```ts
function every<T>(values: readonly T[], predicate: (value: T) => boolean): boolean;
function every<T>(values: readonly T[], predicate: (value: T) => boolean): boolean {
  return values.every(predicate);
}

export function runCase(): number {
  return every([1, 2, 3], value => value > 0) ? 42 : 0;
}
```

The body-bearing declaration is compiled, but retained callable planning cannot
find that exact declaration in the source-callable inventory and aborts with:

```text
source callable every has no consistent exact top-level or compiler-support inventory owner
```

The overload signatures are declarations of the same source-level function,
not three runtime functions. The inventory must canonically own the single
body-bearing implementation while bodyless signatures remain type-only.

## TypeScript package impact

The exact `microsoft/TypeScript@v5.9.3` source entry
`src/typescript/typescript.ts` resolves 280 source files (13,780,098 bytes) and
reaches this invariant in 31.35 seconds. The first failing declaration is
`src/compiler/core.ts`'s `every`, which has three overload signatures followed
by one implementation. A parser-only workload importing the original
`createSourceFile` implementation reaches the same failure in 17.67 seconds,
so the bug blocks even the compiler parser slice rather than only the full
language-service graph.

This source path avoids the monolithic npm bundle's earlier opaque scale
frontier, but cannot produce a binary until overload ownership is stable.

## Acceptance criteria

- [x] An internal top-level overload set compiles and its exported caller
      returns the expected non-vacuous value (`42`) from Wasm.
- [x] An exported overload set has one runtime export backed by the
      body-bearing implementation, not duplicate exports for its signatures.
- [x] Ordinary non-overloaded top-level functions retain their existing
      callable identity and runtime behavior.
- [x] The exact TypeScript v5.9.3 source probe no longer stops on
      `source callable every ... inventory owner` within its 900-second budget;
      any next failure is recorded without claiming the package runs.

## Result

Top-level declaration collection now erases bodyless overload signatures when
the same source file contains a body-bearing implementation. Callable planning,
function exports, and IR outcome accounting therefore all refer to that exact
implementation declaration. The duplicate-export early-error pass applies the
same TypeScript erasure rule, so an exported overload set contributes one
runtime exported name.

The focused regression runs internal generic and exported overloads from Wasm,
checks the value `42`, verifies exactly one exported overload function, and
keeps a non-overloaded control. The exact 280-file TypeScript v5.9.3 source
probe advances past `every` and reaches the next independent frontier after
24.73 seconds:

```text
Codegen error: Cannot read properties of undefined (reading 'kind')
(at src/codegen/index.ts:775:17)
```

No binary is claimed from that probe.

## Scope

Fix source-callable inventory identity for overload implementations. Do not
special-case TypeScript or the function name `every`, and do not suppress the
planning invariant: the emitted runtime function must remain tied to the exact
body-bearing declaration.
