---
id: 7234
title: "classNameIsAmbiguous misses a class expression bound to the same name"
status: ready
sprint: Backlog
created: 2026-11-04
updated: 2026-11-04
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
goal: ir-full-coverage
related: [7227, 7054]
---

# #7234: `classNameIsAmbiguous` misses `const C = class {}`

Found in the round-2 review of PR #7054 (#7227).

`classNameIsAmbiguous` (`src/ir/private-member-syntax.ts`) counts named class
declarations and named class expressions. It does not count an anonymous class
expression bound to a variable of the same name. The IR static-call arm then
looks up the wrong shape by name.

```js
class C { static #m() { return 1 } static a() { return C.#m() } }
function f() { const C = class { static #m() { return 12 } static a() { return C.#m() } }; return C.a(); }
export function test() { return f(); } // node 12
```

- **base:** null-pointer trap at runtime.
- **head (#7054):** compile error on all 3 lanes ("prepared implicit constructor
  C_new has no exact installed support pair").

Not worse in practice: base cannot run this program either, and the variant
where `f` is never called already fails to compile on base. A compile error
still loses the whole module.

**Fix:** also count `VariableDeclaration`s (and assignments) whose initialiser is
a class expression, so the static-call arm refuses the ambiguous name.

**Test:** add the repro to `tests/equivalence/issue-7227-ir-class-sync-member-gaps.test.ts`
(or a new `issue-7234-*.test.ts`) on gc, standalone and wasi.
