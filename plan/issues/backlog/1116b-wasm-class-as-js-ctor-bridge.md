---
id: 1116b
title: "Promise subclass: Wasm-compiled class extends Promise must be a valid JS constructor (Wasm-class-as-JS-ctor bridge)"
status: ready
created: 2026-05-20
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen, runtime
language_feature: classes, Promise, subclassing
goal: spec-completeness
parent: 1116
related: [1455, 1326]
---

# #1116b — Wasm-class-as-JS-ctor bridge for Promise subclasses

## Problem

~61 tests in `built-ins/Promise/` fail with `[object Object] is not a constructor`
when user-defined Wasm-compiled classes extend `Promise`:

```ts
class MyPromise extends Promise {
  constructor(executor: (resolve: any, reject: any) => void) {
    super(executor);
  }
}
Promise.all.call(MyPromise, [p1, p2]); // Should create a MyPromise, not throw
```

Root cause: `Promise.all/race/allSettled/any` use `SpeciesConstructor` (§7.3.24)
which calls the `@@species` symbol → returns the Wasm-compiled class → JS engine
tries to call it as a constructor → Wasm exports are not JS-callable constructors.

The same root cause affects:
- `Promise.all.call(SubClass, iter)` — ~61 tests
- `ctx-ctor` pattern — ~4 tests  
- Any promise combinator that respects `@@species`

## Root cause (from #1116 investigation, senior-dev-1326c, 2026-05-20)

Wasm-compiled classes are represented as GC structs with a `$constructor` field
holding a `funcref`. When the JS engine tries to use them as constructors via
`new SubClass(executor)`, the call fails because Wasm exported functions don't
carry the `[[Construct]]` internal method that JS constructors require.

## Related work

- #1382 (Wasm closures not JS-callable) — adjacent problem; closed with a bridge
  pattern. #1116b may reuse the same bridge infrastructure.
- #1455 (subclassing builtins — instanceof + prototype chain) — companion issue

## Implementation approach (needs architect spec)

Options:
1. **Wrapper function export**: For each class that extends a built-in, emit a
   JS-callable wrapper exported function that calls `$new_MyClass(executor)`.
   Register via `__register_constructor` host import.
2. **`@@species` stub**: Override `Symbol.species` on the compiled class to
   return a JS-native wrapper instead of the Wasm struct. The wrapper holds
   a reference to the Wasm new-object function.
3. **Runtime bridge at Promise.all site**: In the host runtime, detect when
   `thisArg[Symbol.species]` is a non-constructible Wasm export and substitute
   a thin proxy.

Option 1 is the most spec-compliant but requires tracking which classes extend
builtins at compile time.

## Acceptance criteria

- `Promise.all.call(MyPromise, [p1, p2])` returns a `MyPromise` instance
- `Promise.race.call(MyPromise, [...])` same
- Tests in `built-ins/Promise/all/ctx-ctor.js` (and sibling files) pass
- No regression in existing Promise tests

## Notes

Discovered during scoped fix of #1116 (ctx-non-object cluster). The ~4
`ctx-non-object` tests were fixed in PR #436. This is the remaining
architectural work.
