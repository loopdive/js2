---
id: 7032
title: "codegen: `let x: T | null` reassigned from `x.next` widened to externref (linked-list walk hangs on the JS host); `module.exports.foo = fn` lost its Wasm export after the CJS export-cell rewrite"
status: done
sprint: Backlog
created: 2026-10-17
updated: 2026-10-17
completed: 2026-10-17
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: n/a
goal: correctness
parent: 7014
related: [7029, 3961, 4122, 1075, 1277, 1387]
assignee: "ttraenkler/wave15-host-harness"
---

# #7032 — two shared-codegen regressions found by the issue-tests backlog

## 1. Nullable object reassignment demoted to the boxed carrier

```ts
let current: Node | null = a;
while (current !== null) { sum += current.value; current = current.next; }
```

Bisected (first-parent, July 16 → Aug 20) to **34c865498a** (#4008, #3961
"mixed assignment carrier"). `bindingHasMixedAssignmentCarrier` asks
`oracle.staticJsTypeOf(rhs)`, which answers `"mixed"` for every union; for a
non-number slot an unresolvable assignment demotes the local to `externref`. So
`Node | null` (one object part plus `null`, and `typeof null === "object"`)
crossed "domains". Every hop then went through `__extern_get`, and on the JS
host the read of a null struct field came back `undefined` instead of `null`,
so `ref.is_null` never fired: `tests/react-hooks-test.test.ts` "linked list
traversal" hangs forever (standalone gets the right answer, just boxed).

Fix: a union with exactly one non-null part whose tag is `object`, and no
`undefined`, counts as the object domain (`nullableSingleObjectAssignment` in
`src/codegen/analysis/mixed-assignment-carrier.ts`). `number | null`,
`T | undefined` and multi-part unions are unchanged.

The host `__extern_get` null-vs-undefined read of a null class field (the
reason the boxed path looped) is separate and still open; it is tracked in
#7039.

## 2. `module.exports.foo = function () {}` exports nothing

Since 58081ee2d9 the cjs-rewrite prepass replaces every literal
`module.exports` in a CommonJS script with the export cell
`__cjs_default_export`. The #1075 export recogniser in `collectDeclarations`
only matched the literal spelling, so named CJS function exports vanished
(`tests/issue-1075.test.ts` 3 red, `tests/issue-1387.test.ts` 6 red,
`tests/issue-1277.test.ts` "module.exports.foo = ident"). Fix: accept both
spellings (`isCjsModuleExportsObject`, new
`src/codegen/declarations/cjs-module-exports.ts`, used by both recogniser
sites in `src/codegen/declarations.ts`; inventory entry added to
`scripts/compiler-boundaries.json` beside its siblings).

`tests/issue-1387.test.ts` also pinned two refusal diagnostics ("field is
immutable", "requires a proven closed object-literal shape") that the dynamic
`with` lowering no longer reaches; those two cases now assert the correct
sloppy-mode values instead (node: 1 and 9).

## Acceptance criteria

- [x] react-hooks-test 0/7 → 7/7 (with the #7029 harness), issue-1075 5/8 → 8/8, issue-1387 1/9 → 9/9
- [x] issue-1277 9/13 → 10/13 (the 3 others fail identically on base)
- [x] carrier suites (#3961, #4131, #1058-scope-scan-cache, #2917 jsbi) unchanged; #4122's 2 reds fail identically on base
- [x] scoped standalone test262 base vs fix (`language/statements/{while,do-while,variable}`, `built-ins/Object/getPrototypeOf`, `built-ins/Array/prototype/reduce`, 551 rows): 457 / 457 pass, zero per-row flips
