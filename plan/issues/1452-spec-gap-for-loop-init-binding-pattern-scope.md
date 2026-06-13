---
id: 1452
title: "spec gap: for-loop init binding patterns — declared names not visible in loop body"
status: done
completed: 2026-06-12
created: 2026-05-20
updated: 2026-05-20
priority: high
feasibility: easy
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: for-statement, let, const, destructuring
goal: spec-completeness
sprint: 52
related: [1128, 1431, 1432]
---
# #1452 — `for (let [x] = ...)` — destructured bindings missing from loop scope

## Problem

When a `for` statement's initializer is a `let`/`const` declaration that
uses a binding pattern, the names introduced by the pattern are not
registered in the loop's lexical scope. Subsequent reads of those names
inside the loop test/update/body fail with `"<name> is not defined"`.

Example (`test/language/statements/for/dstr/let-ary-ptrn-elem-id-init-undef.js`):

```js
for (let [x = 23] = [undefined]; iterCount < 1; ) {
  assert.sameValue(x, 23);  //  x is not defined
  iterCount += 1;
}
```

The expectation is that `x` is a fresh `let`-scoped binding visible
inside the body. The destructuring assigns `23` (the default) to `x`,
and the body asserts `x === 23`.

## Failure count

**~33 fails** in `language/statements/for/dstr/let-*`, `const-*`
patterns:

- `const-ary-ptrn-rest-obj-prop-id`, `let-ary-ptrn-elem-id-init-undef`,
  `let-ary-ptrn-elem-id-iter-val`, `const-ary-ptrn-elem-ary-elem-iter`,
  `const-obj-ptrn-prop-ary-trailing-comma`, and many more all show
  `"x is not defined"` or `"v is not defined"`.

Plus residual related fails in `statements/let/dstr/` and
`statements/const/dstr/` where the same pattern appears in plain
declarations.

## Root cause

`src/codegen/statements/loops.ts:compileForStatement` (line 295)
explicitly tracks scope save/restore for the for-loop's `let`/`const`
declarations, but the bookkeeping only handles `ts.isIdentifier(decl.name)`:

```ts
for (const decl of stmt.initializer.declarations) {
  if (ts.isIdentifier(decl.name)) {       // ← binding patterns skipped
    const name = decl.name.text;
    if (!savedForConstBindings) ...
    ...
  }
}
```

For `decl.name` that is an `ArrayBindingPattern` or
`ObjectBindingPattern`, the descent never runs, so the names inside
the pattern are not:
- saved/restored in `savedForScope` (shadowing outer bindings is
  broken),
- entered into `fctx.localMap` (so reads inside the loop body resolve
  to nothing → "not defined" at codegen time),
- given TDZ flags (`fctx.tdzFlagLocals`).

The destructuring helper `compileArrayDestructuring` /
`compileObjectDestructuring` is then called at lines 334-341, and it
*does* allocate locals for each binding identifier — but those locals
are not seen by the scope-restore step at the end of the loop, and may
not be entered into `fctx.localMap` in a way visible to the for-loop's
test/update expressions.

## Implementation strategy

1. Walk the binding pattern in the scope-bookkeeping loop and collect
   the bound identifier names (recursing into nested
   `ArrayBindingPattern`/`ObjectBindingPattern`, including rest
   elements and aliased properties — `{a: y}` introduces `y`, not
   `a`).
2. For each name, run the existing `savedForConstBindings` /
   `savedForScope` / `savedForTdz` save/clear flow.
3. After `compileArrayDestructuring`/`compileObjectDestructuring`
   produces the locals, ensure their `name → localIdx` mapping is
   registered in `fctx.localMap` (it likely already is — verify), and
   that the const-binding flag is set for `const` patterns.
4. At loop exit, restore the saved entries (mirror the existing logic
   for identifier-named declarations).

A small helper `collectPatternBindingNames(name: ts.BindingName):
Iterable<string>` will be useful and is reusable for other declaration
sites (let/const/var/function param).

## Acceptance criteria

1. `test/language/statements/for/dstr/let-ary-ptrn-elem-id-init-undef.js`
   passes.
2. `test/language/statements/for/dstr/const-ary-ptrn-rest-obj-prop-id.js`
   passes.
3. `test/language/statements/for/dstr/let-ary-ptrn-rest-ary-elem.js`
   passes.
4. `"x is not defined"` errors in `statements/for/dstr/` reduce to 0
   (or only those caused by genuinely missing features).
5. No regression in existing identifier-named `for (let i = 0; ...)`
   scope tests.

## Files to inspect

- `src/codegen/statements/loops.ts:compileForStatement` (line 295-470).
- `src/codegen/statements/destructuring.ts` — confirm
  `compileArrayDestructuring`/`compileObjectDestructuring` register
  bindings in `fctx.localMap`.
- `tests/issue-1452.test.ts` — small repros.
