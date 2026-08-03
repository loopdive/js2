---
id: 4004
title: "A parameter does not shadow a module-level function of the same name in standalone — silently infinite-recurses"
status: ready
sprint: current
created: 2026-08-01
updated: 2026-08-01
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: n/a
goal: core-semantics
related: []
---

# A parameter does not shadow a module-level function of the same name in standalone — silently infinite-recurses

## Problem

```js
function g(test) { return test(); }
export function test() { return g(() => 7); }
```

Node returns **7**. Standalone gives **`Maximum call stack size exceeded`**.

The parameter `test` does not shadow the module-level function declaration `test`,
so the call inside `g` resolves to the module-level function and recurses forever.

**This is a correctness bug, not a conformance number.** It does not merely fail a
test — it makes correct user code hang. Shadowing an outer binding with a
same-named parameter is an extremely common JS idiom.

## Why it is worth more than its own repro

It presents as a **stack overflow in an unrelated test**, not as a scoping error.
It cost one agent a full test run before being identified, and it may be inflating
unrelated buckets across the corpus — possibly including part of the 202
unclassified files in the ES5+untagged tail census.

## First actions

1. **Census the trigger shape** — files containing a parameter that shadows a
   same-named module-level function declaration. That converts one repro into a
   population. Use trigger-shape enumeration: files without the shape compile
   identically and cannot move, which makes the count a population rather than a
   sample. Positive-control the enumerator against known instances.
2. **Check BOTH lanes.** Reported as a standalone observation; whether the host/gc
   lane shares it is unmeasured and changes the owner.
3. Root-cause in identifier resolution / environment-record construction, not in
   call codegen.

Found incidentally by `L-strwith` 2026-08-01, A/B-confirmed against `upstream/main`
by file-copy revert (no stash). Pre-existing; not introduced by any current work.
