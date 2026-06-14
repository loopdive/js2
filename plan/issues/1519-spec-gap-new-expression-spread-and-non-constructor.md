---
id: 1519
title: "spec gap: `new` expression — non-literal spread + non-constructor TypeError + new.target via apply/call"
status: done
completed: 2026-06-12
created: 2026-05-20
updated: 2026-05-20
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: new-expression, constructors
goal: spec-completeness
sprint: 52
related: [1455]
---
# #1519 — `new` edge cases

## Problem

`language/expressions/new/` and `language/expressions/new.target/`
contribute **~30 failing test262 cases**. Three sub-issues share the
same compile path:

### Sub-issue A — non-literal spread compile error (~10)

```js
new ctor(...args);  // args = identifier or call expression
```

At `src/codegen/expressions/new-super.ts:867`:

```ts
reportError(ctx, expr, "new FunctionExpression with non-literal spread not supported");
```

Failing tests: `spread-err-{sngl,mult}-*`, `spread-sngl-{expr,iter}.js`,
`spread-mult-obj-{null,undefined}.js`.

### Sub-issue B — `new <non-constructor>` should throw TypeError (~10)

```js
new Math;        // expected: TypeError ("Math is not a constructor")
new this;
new null;
new (new Boolean(true));
new (new Number(1));
new (new String("1"));
```

`S11.2.2_A3_T5.js`, `S11.2.2_A4_T{1,2,3,4,5}.js`. We instead crash
with `dereferencing a null pointer` or skip the IsConstructor check
entirely.

### Sub-issue C — `new.target` lost on apply/call/Reflect.apply (~5)

```js
function f() { return new.target; }
f.apply(null, []);                  // expected: undefined ✓ (we crash)
Reflect.apply(f, null, []);          // expected: undefined
```

`new.target/value-via-fpapply.js`, `value-via-fpcall.js`,
`value-via-reflect-apply.js`. The `[[NewTarget]]` slot is dropped on
`Function.prototype.apply` / `call` paths — the caller sees a
null-ref instead of the explicit `undefined` sentinel.

### Sub-issue D — `spread-obj-{getter,…}` Wasm compile error (~5)

```js
new ctor({ ...{ get a() { return 1; } } });
```

`spread-obj-null.js`, `spread-obj-getter-init.js`,
`spread-mult-obj-{null,undefined}.js`. The object-spread + new-expr
codegen produces an invalid Wasm binary (the spread emits an
externref that the call site reads as a struct ref).

## Failure count

**~30 fails** in `language/expressions/new/` and
`new.target/`. Realistic target: **all 30** (small, well-bounded
codegen fixes).

## Root cause + files to touch

- `src/codegen/expressions/new-super.ts:850–900`:
  - Sub-issue A: replace the `reportError` with a fallback to
    `Reflect.construct(ctor, [...spreadArgs])` (already implemented
    for the regular call site in
    `src/codegen/expressions/calls.ts:3188`).
  - Sub-issue B: emit an `IsConstructor(target)` guard before
    issuing `call_ref`; if false, throw TypeError.
  - Sub-issue D: ensure the object-spread emitter returns a
    consistent struct ref shape inside `NewExpression` argument
    lists.
- `src/codegen/expressions/calls.ts` — `Function.prototype.apply`
  / `call` paths: thread the caller's `[[NewTarget]]` (or `undefined`
  sentinel) through to the invoked function. Currently dropped.
- `src/codegen/expressions/new-super.ts` — `new this`, `new <function-expression>(...)` etc. should run through the same
  IsConstructor guard.

## Acceptance criteria

1. All `language/expressions/new/spread-*` tests compile and either
   pass or throw the expected error.
2. `new Math` throws `TypeError`.
3. `f.apply(null, [])` and `Reflect.apply(f, null, [])` return
   `undefined` for `new.target` inside `f`.
4. No regression in `language/expressions/super/` (which also
   touches `new-super.ts`).

## Reference tests

- `language/expressions/new/spread-sngl-expr.js`
- `language/expressions/new/S11.2.2_A4_T5.js` (`new Math`)
- `language/expressions/new.target/value-via-fpapply.js`
- `language/expressions/new/spread-obj-null.js`
