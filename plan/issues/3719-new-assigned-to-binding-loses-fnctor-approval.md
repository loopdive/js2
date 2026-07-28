---
id: 3719
title: "`p = new F()` (assignment) loses fnctor approval — prototype methods silently resolve to undefined"
status: done
created: 2026-07-27
updated: 2026-07-27
completed: 2026-07-27
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: prototype-methods
goal: core-semantics
related: [3685, 3683, 3673, 2660, 2773]
---

# #3719 — `new F()` assigned to a binding loses fnctor approval

## Problem

A prototype method call answered **`undefined`, silently**, whenever the
`new F()` reached its binding through an ASSIGNMENT rather than a declaration
initializer:

```js
function Q() {
  this.v = 9;
}
Q.prototype.inc = function () {
  return 1000;
};
export function test() {
  var p;
  p = new Q();
  return p.inc();
} // -> undefined
```

No trap, no diagnostic — a wrong value. Standalone lane, long-standing (repros
on `upstream/main` in a clean worktree), and independent of the #3673/#3683
performance work.

## Root cause

`bindingOf` in the fnctor escape gate recognised **only** the declaration form:

```ts
if (ts.isVariableDeclaration(parent) && parent.initializer === newExpr && …)
```

For any other shape it returned `undefined`, so classification fell to the
INLINE branch, which looks only at the single expression directly consuming the
`new`. That branch sees a bare assignment, matches none of its cases, and the
site settles on `keep-static`. Consequence chain:

1. the class never enters `approvedNames`;
2. `resolveLiftedMethodThisStruct` therefore refuses it, so its prototype
   methods are never lifted;
3. the method's closure is **never compiled at all** — the emitted module
   contains no user closure and `__module_init` makes no calls;
4. the dynamic path (`__call_m_<m>_<n>` → `__method_cache_lookup` →
   `__extern_method_call`) finds nothing and yields the undefined sentinel.

## How it was pinned

The decisive observation: adding **any** separate typed use — _even a dead one
that never runs_ —

```js
function dead() {
  var q = new Q();
  return q.inc();
} // never called
```

made the original call return 1000. A dead use cannot affect runtime dispatch,
so the defect had to be compile-time registration. That ruled out the three
earlier hypotheses in one step:

- **not** the method-lookup cache (a method name unique to the class fails
  identically);
- **not** a static/dynamic class disagreement (a single-class program with no
  reassignment at all fails the same way);
- **not** the terminal fallback in `buildClosurePropMethodCallElseArm` — a fix
  there was attempted and changed nothing, which is what redirected the search
  upstream to classification.

Also misleading en route: `typeof p.inc` answers `"function"` for the broken
program while `p.inc` is falsy — `typeof` is folded at compile time from the TS
type, so it reports the static shape, not what the module actually holds.

## Fix

Recognise the assignment form in `bindingOf`, returning the assignment target
so the ordinary use-walk classifies the binding. This preserves the fast path:
an own-field consumer still yields `keep-typed`; only a genuinely dynamic
consumer (a method call) yields `reconstruct`.

Pinned by `tests/issue-3719-new-assigned-to-binding.test.ts` (6 cases,
including the dead-typed-use equivalence that pinned the diagnosis, and an
own-field read to guard the fast path).
