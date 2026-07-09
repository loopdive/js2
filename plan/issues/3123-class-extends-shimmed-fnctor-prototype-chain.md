---
id: 3123
title: "class C extends F (plain fnctor with runtime-assigned .prototype): instance member lookup does not reach F.prototype — Iterator-helper exhaustion/return-forwarding residual (~8 files)"
status: ready
sprint: Backlog
priority: medium
horizon: m
feasibility: hard
created: 2026-07-09
task_type: bugfix
area: codegen, runtime
language_feature: class-extends, iterator-helpers
goal: spec-completeness
test262_category: built-ins/Iterator/prototype
related: [3049]
---

# #3123 — `class C extends F` over a runtime-assigned fnctor prototype

## Source

Split out of #3049 (fable-proto, 2026-07-09). After #3049 landed Layers 1–3
(top-level `F.prototype = …` init keep, deferred host init in the test262
harness, `%ArrayIteratorPrototype%` middle proto, bridge-exit marshaling), the
`this-plain-iterator` cluster flipped (11/11), but ~8 sibling files remained
red with a DIFFERENT root:

- `built-ins/Iterator/prototype/{map,filter,flatMap,drop}/exhaustion-does-not-call-return.js`
- `built-ins/Iterator/prototype/{drop,take,filter}/return-is-forwarded.js`
- `built-ins/Iterator/prototype/flatMap/iterable-to-iterator-fallback.js`

## Repro / mechanism

These tests all use:

```js
class TestIterator extends Iterator {
  next() {
    return { done: false, value: 1 };
  }
  return() {
    ++returnCount;
    return {};
  }
}
let iterator = new TestIterator().drop(0); // ← "Cannot read properties of null (reading 'drop')"
```

where `Iterator` is the test262-runner harness shim — a plain top-level
`function Iterator(){}` whose `.prototype` is ASSIGNED AT RUNTIME (module
init) to the helper-bearing `%IteratorPrototype%`:

```ts
function Iterator(this: any): void {}
(Iterator as any).prototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
```

The compiled `class TestIterator extends Iterator` wires its prototype chain
to whatever the class-extends machinery resolves as the parent prototype at
COMPILE/CLASS-SETUP time — it does not observe the runtime re-assignment of
`F.prototype`, so `new TestIterator().drop` (an inherited helper two levels
up) resolves through a chain that never reaches the helper proto; the member
read yields null/undefined ("Cannot read properties of null (reading
'drop')" / "reading 'next'").

Note this is NOT the #3049 elision (the assignment DOES run now) and NOT the
bridge-marshal gap — it is the class-hierarchy wiring for `extends <plain
function>` with a dynamically (re)assigned `.prototype`. Spec §15.7.14
(ClassDefinitionEvaluation): the parent's `prototype` property is read at
class-definition time — but at that point (module init order) the shim's
assignment HAS already executed (it precedes the class in program order), so
an implementation that reads `F.prototype` dynamically at class-eval time
would see the helper proto. Our class-extends lowering likely resolves the
parent prototype through a compile-time singleton / vivified sidecar object
instead of the live `F.prototype` slot.

## Suggested approach

Trace `class C extends F` (F = top-level plain function, not a class) in
`src/codegen/class-bodies.ts` / the fnctor-extends arm: where does the
parent-prototype link come from, and can it read the LIVE `F.prototype`
(host sidecar `_getOrVivifyFnPrototype` / `__extern_get(F, "prototype")`) at
class-definition time in `__module_init`? With #3049's deferred harness init,
class setup that runs inside `__module_init` executes after `setExports`, so
host reads are available.

## Acceptance criteria

- The 8 residual files above pass in the host lane.
- No regression in class-extends-class or the #3049 cluster.
