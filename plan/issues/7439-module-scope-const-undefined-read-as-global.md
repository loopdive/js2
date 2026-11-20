---
id: 7439
title: "A module-scope `const undefined = 42` is read as the global `undefined`"
status: ready
sprint: current
created: 2026-11-20
updated: 2026-11-20
priority: low
horizon: s
task_type: bug
area: ir
goal: core-semantics
related: [7380, 7104, 7106]
---

# #7439 — module-scope `const undefined` is ignored

## Problem

```ts
const undefined = 42;
export function f(): number { return (undefined as any) + 1; }
```

node (module code): 43. js2wasm, default and `--target standalone`: NaN.

`lowerFunctionAstToIr` with a checker and no module-binding resolver lowers the read to `dyn.undefined` instead of
refusing. Both `src/ir/from-ast.ts`'s identifier arm for `undefined` (#7104 / #7106) and
`isUnshadowedGlobalExpression` treat "no module binding found" as "the global", which is false when no resolver is
present. Rare in real code, but a wrong answer.

## Evidence

`tests/issue-3518-native-family-source-identity.test.ts`: "does not certify a shadowed undefined read in direct
lowering: const undefined = 42; …" and "retains the unsupported undefined read when the lowerer has no checker".

## Acceptance criteria

1. The program above returns 43, or is refused by name; never NaN.
2. Without a resolver, a read of `undefined` that the checker does not prove global is refused.
3. The two red tests pass unchanged.
