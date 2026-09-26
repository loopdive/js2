---
id: 6673
title: "standalone: lodash `baseMerge` callback reads the enclosing function's local for a captured constructor (`stack-balance invariant: '__cb_7' references local 327`)"
status: done
completed: 2026-09-25
sprint: Backlog
created: 2026-09-24
updated: 2026-09-25
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
related: [6661, 6665, 6679, 6680]
---

# #6673 — lodash standalone compile: captured `Stack` read through the outer local index

## Problem

With the #1474 match/search/split refusals gone
([#6665](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6665-standalone-string-methods-dynamic-regexp-value)),
lodash 4.18.1's npm-compat **standalone-dynamic** lane reports this as its
first error (it was already present behind the refusals — the parent's full
error list carries it too, and #6661 recorded it):

```
Codegen error: stack-balance invariant (entry): '__closure_72' references local 327, but only 3 params + 59 locals are declared (locals: 3:__self_cast, 4:stack, 5:Stack, 6:object, ...
```

(on upstream/main 7d94ea72bf; the closure was named `'__cb_7'` with 61
locals on d772cc772d). The closure is the `baseFor` callback inside `baseMerge` (`lodash.js:3647`):

```js
baseFor(source, function(srcValue, key) {
  stack || (stack = new Stack);
  ...
}, keysIn);
```

`Stack` is a captured binding (the callback's local 5), but the emitted
`new Stack` reads `local.get 327` — the index `Stack` has in the enclosing
`runInContext` function — i.e. the constructor callee was resolved against the
outer function's `localMap` instead of the closure's capture.

## Acceptance criteria

- A reduced fixture (outer function with many locals declaring a constructor,
  an inner callback that `new`s it through a `||` assignment) compiles under
  `--target standalone` and runs like Node.
- lodash's standalone-dynamic lane moves past the stack-balance invariant.

## Implementation Plan

What was executed (2026-09-24, reduced from lodash 4.18.1 `baseMerge` / `mixin`):

1. **Reduce.** Two-level closure over a factory frame: `Stack` (a declaration
   capturing `ListCache`/`a9`, value also observed) constructed with
   `new Stack` inside the `baseFor` callback nested in `baseMerge`. Not
   lane-specific — `--target gc` produces the same wrong value (`11` vs
   Node's `20`); the index only goes out of range in lodash's larger frame.
2. **Invoke facts see nested closures** (`function-declaration-observation.ts`,
   `functionBindingUseFacts`). `invokedNames` skipped nested function scopes,
   so `baseMerge` "observed only" `Stack` (the `new` sits in the callback) and
   the sibling SCC never gave it `Stack`'s captures. The invoke scan now runs
   in the same shadow-aware walk as `observedNames`, counting call/construct
   callees inside nested closures.
3. **Closures inherit a forwarded declaration's captures**
   (`closures/arrow-phases.ts`, `isForwardedDeclarationCapture`). The closure's
   transitive-capture expansion skipped `Stack` because it is a PARAMETER of
   `baseMerge` — but it is the hidden leading capture param carrying the
   declaration itself (slot provenance via `liftedCaptureSlots`, checker
   resolves the reference to `funcMapOwnerDecl`), not a user parameter.
4. **Shadowed name read only in a nested closure**
   (`closures/arrow-phases.ts`, `bindsMappedFunctionDeclaration`). The next
   lodash blocker was the same symptom (`'__closure_177' references local
   316`): `mixin`'s `var chain` shadows `function chain` and is read only
   from the closure nested in the `arrayEach` callback, so the callback's
   shallow declaration lookup was empty and the name was skipped as a
   function reference. It now resolves through nested scopes (ignoring
   bindings declared inside the closure) before treating the name as the
   mapped function.

## Resolution

Re-verified after merging upstream/main (2026-09-25).

- `tests/issue-6673-closure-forwarded-declaration-captures.test.ts`: 3 shapes x
  {standalone, gc}. Parent: 0/6 (`11` vs Node `9020`, `101` vs `110`,
  stack-balance CE). Fix: 6/6.
- Scoped standalone test262 (`language/statements/function`,
  `language/function-code`, `language/expressions/{arrow-function,new,function}`
  top level, 656 rows, `scripts/run-test262-paths.mts --standalone`): parent
  572 pass / 83 fail / 1 CE, fix 572 / 83 / 1, identical non-pass sets.
- JS-host lodash dogfood: 59/62 before and after.
- lodash standalone-dynamic lane: parent `compile-error` at
  `stack-balance invariant (entry): '__closure_72' references local 327`;
  fix gets past both stack-balance invariants and now stops at Wasm
  validation (`optimization-error`):
  `[wasm-validator error in function baseUpdate] global.set value must have right type, on (global.set $global$616 (ref.null none))`
  — tracked as [#6679](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6679-return-call-arg-null-retype-across-global-set)
  (fix prototyped), and behind it
  [#6680](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6680-lodash-pullat-basepullat-extra-stack-value).
  The same validator report also names `cond` (`struct.new operand 2 must
  have proper type`, a `ref.null none` operand) and `__closure_116`.
