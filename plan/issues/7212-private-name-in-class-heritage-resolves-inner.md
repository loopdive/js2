---
id: 7212
title: "Private name inside an `extends (...)` clause resolves against the class being defined"
status: ready
sprint: Backlog
created: 2026-10-31
updated: 2026-10-31
priority: low
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: classes
goal: correctness
related: [7162]
---

# #7212 — private names in ClassHeritage

Found by the PR #7011 (#7162) review. The spec (§15.7.14) evaluates the
`extends` expression with the *outer* private environment, but our name
lookup matches the class being defined first:

```js
function t(f) { return f(); }
class O {
  #m() {}
  static f(o) {
    let r = -1;
    class X extends (r = t(() => #m in o), Object) { #m() {} }
    return r;
  }
}
console.log(O.f(new O()));   // node: true (outer #m) — we print: false
```

Same answer before and after #7162, so not a regression.

## Plan

1. In the private-name resolvers (`resolvePrivateInTarget` in
   `src/codegen/binary-ops-in.ts` and the shared resolver), skip a class
   when the reference lies inside that class's `heritageClauses`.
2. Tests on 3 lanes against node: `#m in o`, a private read and a private
   call inside `extends (...)`.
