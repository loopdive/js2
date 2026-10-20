---
id: 7039
title: "issue-tests host-harness slice residuals: static private brand check, fast-mode untyped export ABI, Temporal ambient closure, generic base-node factory, __extern_get null field reads back undefined"
status: ready
sprint: Backlog
created: 2026-10-17
updated: 2026-10-17
priority: low
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: n/a
goal: correctness
parent: 7014
related: [4154, 1211, 4628, 1058, 7029, 7032]
---

# #7039 — residual reds from the #7029 slice that are independent bugs

Each item was measured on upstream/main 0727e2985b; none is a harness gap.

1. **`tests/issue-4154-private-brand-check-typeerror.test.ts` (2 red).**
   Standalone: `C.Inner.access(C.Inner)` on a `static set #f` must throw a
   catchable TypeError (PrivateBrandCheck on a class object), returns 0 (no
   throw). gc: the harness calls `imports.__setInstance`, which the resolver
   does not return (it returns `setInstance`/`setExports`), and then fails with
   `Cannot read properties of null (reading 'access')`. Fix the harness to call
   `setExports` AND fix the standalone static brand check on the class-object
   carrier; the file cannot go green with only one of the two.
2. **`tests/issue-1211.test.ts` (1 red).** `fast: true`, `allowJs`: the
   exported `run(n)` (untyped JS param) now takes `(ref null $AnyValue)`, so a
   JS caller passing `25` fails with "type incompatibility when transforming
   from/to JS". An export ABI must accept JS values (externref/f64). Bisect from
   `38dd745884`.
3. **`tests/issue-4628-temporal-global.test.ts` (2 red).** `Intl` closure denial
   count is 2 not 0, and an ambient `declare const Temporal` capture fails with
   `Cannot access property on null or undefined at 5:48`.
4. **`tests/issue-1058-generic-base-node-factory.test.ts` (2 red).** Diamond
   interface return / `LiteralLikeNode` view: `Cannot access property on null or
   undefined` (a guarded cast to the wrong struct answers null).
5. **Host `__extern_get` of a null class field returns `undefined`.** Found while
   fixing #7032. On base (before #7032), `let cur: Node | null = a; cur =
   cur.next; cur = cur.next; return cur === null` (b.next initialised `= null`)
   returns false; an import trace shows `__extern_get(b, "next") -> undefined`
   on the second hop, so the typed `ref.is_null` test never fires and the
   react-hooks linked-list walk loops forever. The same read through an
   `any`-typed local answers `null`, so the defect is in how the boxed typed
   carrier's read reaches `_classChainRead`/`__extern_get` (`src/runtime.ts`).
   #7032 removed the demotion for that shape; another boxed typed reader still
   sees the wrong value.

## Acceptance criteria

- [ ] 4154, 1211, 4628, 1058 green (each may be split into its own issue when picked up)
- [ ] item 5 reproduces as a unit test and is fixed
