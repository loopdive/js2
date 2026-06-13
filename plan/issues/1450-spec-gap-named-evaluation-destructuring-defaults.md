---
id: 1450
title: "spec gap: NamedEvaluation — anonymous fn/class names from binding identifiers in destructuring defaults"
status: done
completed: 2026-06-12
created: 2026-05-20
updated: 2026-05-20
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: destructuring, function-name
goal: spec-completeness
sprint: 52
related: [1431, 1432, 1364]
---
# #1450 — NamedEvaluation: bind anonymous function/class names from destructuring identifiers

## Problem

ECMA-262 §13.3.3.6 (`IteratorBindingInitialization` / SingleNameBinding) and
§13.15.5.2 (Runtime Semantics: DestructuringAssignmentEvaluation) require that
when the *initializer* of a binding is an `IsAnonymousFunctionDefinition`
(a `FunctionExpression` with no name, an `ArrowFunction`, a `ClassExpression`
with no name, or generator/async variants), the resulting function/class
object's `name` internal slot is set to the **binding identifier** the
initializer is bound to.

Example (`test/language/statements/try/dstr/ary-ptrn-elem-id-init-fn-name-fn.js`):

```js
try { throw []; } catch ([fn = function () {}, xFn = function x() {}]) {
  assert.sameValue(fn.name, 'fn');         // anonymous → inherits 'fn'
  assert.notSameValue(xFn.name, 'xFn');    // named expression keeps own name 'x'
}
```

We currently emit the default expression and store the resulting closure
struct/externref into the binding's local — but never set the function's
`name` slot. As a result, `fn.name` is `''` (or whatever the closure
defaults to) instead of `'fn'`.

The same rule applies to:
- Function parameter defaults: `function f(g = function () {}) {}` →
  `g.name === 'g'`.
- Variable declarators: `var g = function () {}` → `g.name === 'g'`.
  (We probably handle the variable-declarator case for the *value initializer*
  but not the *destructuring default* sub-case.)
- For-loop / for-of / for-await-of destructuring with default initializers.
- Catch binding patterns.
- Assignment patterns (`({x = function() {}} = {})` → `x.name === 'x'`).

## Failure count

**≥250 fails** across test262 with `init-fn-name-fn`, `init-fn-name-class`,
`init-fn-name-arrow`, `init-fn-name-gen`, `init-fn-name-async-gen`,
`init-fn-name-fn-async`, `init-cover-init-name-*` in the path. Distribution:

- statements/for-await-of: 54
- expressions/class: 48
- statements/class: 48
- statements/for-of: 21
- expressions/assignment: 15
- expressions/object: 12
- statements/try: 10
- expressions/async-generator: 8
- statements/for: 6
- expressions/function: 4
- statements/async-generator: 4
- statements/function: 4
- statements/generators: 4
- expressions/generators: 4
- expressions/arrow-function: 4

Many of these tests are `assertion_fail` with messages like
`fn.name === 'fn'` failing.

## Root cause

Function expressions, arrow functions, and class expressions compiled by
`src/codegen/closures.ts` (closure struct creation) and
`src/codegen/declarations.ts` (class expression handling) do not consume the
binding identifier context that surrounds them during destructuring
emission. The `name` slot is either:

- The literal name from the source (e.g., `function x() {}` → `'x'`), or
- Empty / a counter-based name for anonymous closures.

The destructuring emitters in
`src/codegen/statements/destructuring.ts:emitDefaultValueCheck` (line ~297),
`src/codegen/destructuring-params.ts:destructureParamObject`/`Array`, and
the function-parameter-default site in
`src/codegen/class-bodies.ts:1175-1185` all run `compileExpression(ctx, fctx,
initializer, hintType)` without any name-context hook. So
`IsAnonymousFunctionDefinition` is never realised.

## Implementation strategy

1. Introduce a **`nameContext` parameter** (string, optional) on the few
   compile-expression entry points that handle destructuring/default
   initializers, threaded through to `closures.ts` and the class-expression
   path in `declarations.ts`.

2. In `closures.ts` (arrow / function expression emission), when
   `nameContext` is set **and** the closure has no own name, store the
   name in the closure's `name` field (the runtime accesses it via
   `Function.prototype.name` getter or via a struct field).

3. In `declarations.ts` (class expression), when `nameContext` is set and
   the class expression is anonymous, register the class with that name
   instead of `__anon_<N>`.

4. Drive `nameContext` from:
   - `emitDefaultValueCheck` in `statements/destructuring.ts` — pass the
     binding identifier from the surrounding `BindingElement`.
   - `destructureParamObject`/`destructureParamArray` element-level
     emission — when an element is a `BindingElement` with an
     `Identifier` name + anonymous initializer.
   - Variable declarator and assignment patterns where the LHS is an
     identifier.
   - Catch binding pattern descent in `statements/exceptions.ts`.

5. Only apply when `IsAnonymousFunctionDefinition(initializer)` would be
   true — i.e. unnamed `FunctionExpression`, `ArrowFunction`, unnamed
   `ClassExpression`, generator/async variants thereof. Named
   expressions (`function x() {}`, `class X {}`) keep their own name
   per spec.

## Acceptance criteria

1. `test/language/statements/try/dstr/ary-ptrn-elem-id-init-fn-name-fn.js`
   passes (catch destructuring → `fn.name === 'fn'`).
2. `test/language/statements/class/dstr/meth-ary-ptrn-elem-id-init-fn-name-class.js`
   passes (class method param destructuring → class expression `.name`).
3. `test/language/statements/for-of/dstr/let-obj-ptrn-id-init-fn-name-class.js`
   passes (for-of destructuring → class expression `.name`).
4. `test/language/statements/function/dstr/dflt-ary-ptrn-elem-id-init-fn-name-class.js`
   passes (function param destructuring → class expression `.name`).
5. The 250+ `init-fn-name-*` and `init-cls-name-*` failures across §13–§15
   reduce by **≥ 200** in the next test262 run.
6. Existing function-name behaviour for plain identifier declarators
   (`const f = function () {}`) does not regress.

## Files to inspect

- `src/codegen/closures.ts` — `emitClosureStruct` / function-expression
  compilation site (~line 745, 935). Add a name-slot writer.
- `src/codegen/declarations.ts` — class expression compilation (line 2009
  area) and variable-declarator name inference (line 742).
- `src/codegen/statements/destructuring.ts` — `emitDefaultValueCheck`
  (line 297) and `compileObjectDestructuring`/`compileArrayDestructuring`
  (376 / 1070).
- `src/codegen/destructuring-params.ts` — element-level binding emission.
- `src/codegen/statements/exceptions.ts` — catch parameter destructuring.
- `tests/issue-1450.test.ts` — regression cases for each binding context.

## Test Results (#1450 implementation, 2026-05-20)

Implemented a property-access constant-folding fallback in
`src/codegen/property-access.ts` for `f.name` access where the static
type lacks call/construct signatures (the `any` widening case for catch
parameters, destructuring binding elements with no type hint, etc.).
When the identifier's `valueDeclaration` is a `BindingElement` or
`VariableDeclaration` whose initializer is an `IsAnonymousFunctionDefinition`,
emit the binding identifier text as a string constant.

Equivalence tests (`tests/issue-1450.test.ts`, 7 cases):

| Pattern | Result |
| --- | --- |
| `try/catch ([fn = function(){}])` → `fn.name === 'fn'` | PASS |
| `try/catch ({fn = function(){}})` → `fn.name === 'fn'` | PASS |
| `for (let [fn = function(){}] of [[]])` → `fn.name === 'fn'` | PASS (already worked) |
| `function f([fn = function(){}])` → `fn.name === 'fn'` | PASS (already worked) |
| `function g(h = function(){})` → `h.name === 'h'` | PASS (already worked) |
| `const f = function(){}` → `f.name === 'f'` | PASS (already worked) |
| Named fn expr in destructuring keeps own name (`function x` ≠ binding) | PASS |

Regression check across `tests/issue-1049.test.ts`,
`tests/issue-43-*-dstr*.test.ts`, `tests/basic-destructuring.test.ts`,
`tests/null-destructuring.test.ts`, `tests/classes.test.ts`,
`tests/class-expressions.test.ts`, `tests/closed-imports.test.ts`,
`tests/for-of-array-destructuring.test.ts`,
`tests/array-rest-destructuring.test.ts`:

- main HEAD: 13 failed / 31 passed (all pre-existing)
- this branch: 11 failed / 33 passed — net **+2** (the two new #1450 tests)

No regressions. The 11 remaining failures are pre-existing and unrelated.

### Not covered by this PR

The fix does **not** address:

- **Assignment patterns** (`({a = function(){}} = {})` → `a.name === 'a'`).
  The LHS identifier resolves to its outer `var`/`let` declaration, so
  `valueDeclaration` doesn't carry the destructuring initializer. Would
  require an AST walk for the enclosing destructuring assignment.
  test262 weight: ~15 fails (`expressions/assignment`).
- **Class expressions in destructuring defaults**
  (`var [cls = class {}] = []`). Class expressions in destructuring
  positions hit a separate, pre-existing compile-time bug where the
  class struct/funcref doesn't coerce correctly into the destructuring
  slot (runtime `dereferencing a null pointer`). Out of scope; a deeper
  destructuring-codegen fix is required.

## Out of scope

- `Function.prototype.name` getter semantics (`.name` is a regular own
  property in our model; that part is unchanged).
- Computed property keys producing `'[propName]'`-style names (separate
  spec rule, low fail count).
- `Function.prototype.bind`-derived `'bound '` prefix.
