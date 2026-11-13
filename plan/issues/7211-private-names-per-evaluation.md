---
id: 7211
title: "Private names are shared between evaluations of one class expression"
status: ready
sprint: Backlog
created: 2026-10-31
updated: 2026-10-31
priority: low
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: classes
goal: correctness
related: [7162]
---

# #7211 — one private name per evaluation

Found by the PR #7011 (#7162) review. In the spec, each evaluation of a
class expression creates fresh private names. We create one struct type,
one tag and one `__class_<C>` global per declaration, so the brand checks
of one evaluation accept values from another:

```js
function mk() {
  return class {
    #m() {} static #s = 1;
    static h(o) { return #m in o; }
    static hs(o) { return #s in o; }
  };
}
const A = mk(), B = mk();
A.h(new B());   // node: false — we print: true
A.hs(B);        // node: false — we print: true
```

Private fields behave the same way already (`#m = 1` instead of a method
gives `true` on both main and before #7162), so this is not a regression.
The fix has to cover fields, methods and statics together.

## Plan

1. Give each class evaluation a runtime identity (for example a fresh brand
   value stored in the class value and copied into each instance) and check
   it in `#x in o`, private reads and private writes.
2. Measure the cost on the common case, a class that is evaluated once, and
   keep it free there.
3. Tests on 3 lanes against node: fields, methods, accessors and statics,
   each across two evaluations.
