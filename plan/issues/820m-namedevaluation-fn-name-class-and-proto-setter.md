---
id: 820m
title: "NamedEvaluation: anonymous class/function value not named from binding key (~12 fails, fn-name-class + __proto__-fn-name)"
status: blocked
created: 2026-05-28
updated: 2026-05-28
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes, function-name-inference, object-literal
goal: spec-completeness
sprint: Backlog
parent: 820
test262_fail: 12
related: [1542, 1543, 1544, 820b]
---
# #820m — NamedEvaluation: anonymous class/function value not named from binding key

Carved from the #820 nullish/TypeError umbrella (triage 2026-05-28, dev-1655-2).

## Problem

Anonymous class/function values created in **NamedEvaluation-eligible contexts**
must have their `name` property set per §13.2.5.5 PropertyDefinition runtime
semantics and §sec-runtime-semantics-namedevaluation. Several specific gaps:

### Gap A — `__proto__-fn-name` (1 fail, type_error)

For object-literal property `__proto__: <AnonymousFunctionDefinition>`,
**isProtoSetter is true** (§13.2.5.4 step 3.a) and §13.2.5.5 step 5 must
**NOT** invoke NamedEvaluation on the value. We appear to be setting the
function's `name` to `"__proto__"` (or some sentinel) when we should leave it
empty (or set from the function declaration's own identifier, where present).

```
test/language/expressions/object/__proto__-fn-name.js
```

Test source:
```js
var o = { __proto__: function () {} };
assert(Object.getPrototypeOf(o).name !== "__proto__");
```

### Gap B — `fn-name-class` (3 fails, type_error)

Object property short-form `{ prop: class {} }` and assignment
`x = class {}` / `x = function(){}` must invoke NamedEvaluation, setting
the value's `name` to the property key / binding identifier.

```
test/language/expressions/object/fn-name-class.js
test/language/expressions/assignment/fn-name-class.js
test/language/expressions/assignment/dstr/array-elem-init-fn-name-class.js
test/language/expressions/assignment/dstr/obj-id-init-fn-name-class.js
test/language/statements/for-of/dstr/array-elem-init-fn-name-class.js
test/language/statements/for-of/dstr/obj-id-init-fn-name-class.js
```

Sample (`obj-id-init-fn-name-class.js`):
```js
var cls;
({ cls = class {} } = {});
// Expects: cls.name === 'cls', writable:false, enumerable:false, configurable:true
```

### Gap C — `*-ary-ptrn-elem-id-init-fn-name-class` sub-cluster (~33 procedurally-generated, mostly null_deref)

The procedurally-generated array-pattern destructuring + class-as-default
variants. These exhibit a **null_deref**, not the `.name !== 'binding'`
failure of Gap B, which suggests a *different* root cause — likely the class
expression's lowering in the binding-default position emits an invalid ref
shape. Confirmed by the test262 baseline tagging (`null_deref` not
`type_error` here, in contrast to Gap A/B). This sub-cluster likely overlaps
with #1542/#1543/#1544 dstr-default work and should be re-bucketed there if
not already covered. **NOT** addressed by this issue.

```
test/language/statements/const/dstr/ary-ptrn-elem-id-init-fn-name-class.js
test/language/statements/let/dstr/ary-ptrn-elem-id-init-fn-name-class.js
test/language/statements/function/dstr/ary-ptrn-elem-id-init-fn-name-class.js
test/language/statements/for-of/dstr/let-ary-ptrn-elem-id-init-fn-name-class.js
... (~33 entries)
```

## Acceptance criteria

1. `({ __proto__: function(){} })` — function's `.name` must remain `""`
   (or whatever the spec says under §sec-setfunctionname; `__proto__` is
   explicitly excluded from NamedEvaluation by step 5).
2. `{ prop: class {} }` — class's `.name === 'prop'`.
3. `x = class {}` — class's `.name === 'x'`.
4. Destructuring-assignment property short-form (Gap B) — `name` correctly
   set from the binding identifier.
5. Gap C (~33 ary-ptrn-elem-id-init-fn-name-class) cases remain to be
   re-routed; they're tracked in the residual section of #820 but NOT
   counted against this issue's acceptance.

## Investigation starting points

- `src/codegen/literals.ts` — object-literal property emission; look for
  PropertyAssignment handling and the `__proto__` special case
- `src/codegen/expressions/assignment.ts` (or wherever AssignmentExpression
  lives) — RHS-name inference for `id = AnonFn`
- `src/codegen/destructuring-params.ts` / `src/codegen/destructuring.ts` —
  AssignmentProperty `id = default` shape: when default is anonymous, name
  must come from the property key (§13.15.5.2 step 4)
- Spec refs:
  - §13.2.5.5 PropertyDefinition NamedEvaluation
  - §sec-setfunctionname
  - §13.15.5.2 DestructuringAssignmentTarget IdReferenceInitializer

## Out of scope

- Gap C (the ~33 ary-ptrn null_deref family). These are a distinct
  *compilation* failure shape (invalid Wasm cast / null deref at codegen)
  rather than a *missing SetFunctionName* failure. Recommend a follow-up
  issue or re-routing to #1542/#1543/#1544 dstr-default residuals after
  this lands.
- #820b (computed-property accessor names) — already done.

## Investigation 2026-05-28 (developer) — ESCALATED, needs architect spec

### What the issue calls "NamedEvaluation gap" is actually a class-as-value codegen gap

The two named tests in the issue (`object/__proto__-fn-name.js`,
`object/fn-name-class.js`) both fail with **`TypeError: Cannot access property
on null or undefined`** in the test262 baseline — NOT a `.name !== "expected"`
mismatch. Reproduced via minimal probe in `.tmp/`:

```ts
// .tmp/probe-820m-gap-b.ts
export function test(): any {
  const obj: any = { id: class {} };
  return obj.id;
}
// → RESULT=null (compiles, runs, returns null)
```

The anonymous class value inside the object literal compiles to `ref.null.extern`.
Spec-wise the `name` is wrong, but observationally the *class is missing entirely*.

Reduces further: even

```ts
export function test(): any {
  const c: any = class {};
  return c;
}
// → RESULT=null
```

returns null when nested inside a function body — only top-level
`const C = class {...}` survives because the var-decl branch at
`declarations.ts:2185` calls `collectClassDeclaration(ctx, decl.initializer,
decl.name.text)` BUT a) does this only for top-level statements, b) the
function-body recursion at `collectClassesFromStatements` line 2197 only
handles `FunctionDeclaration` (not arrow/expression bodies, not non-decl
contexts inside FunctionDeclaration).

Even when collection runs (verified via instrumented `compileClassExpression`
fallback path: never hit on the `{ id: class {} }` probe), the failure is
elsewhere — the `compileObjectLiteralForStruct` path doesn't call
`compileClassExpression` for property values, so an anonymous class in
property position is silently dropped and the field is left default-initialised.

### Why this is NOT a "SetFunctionName runtime hook" patch

The original issue framing ("add NamedEvaluation to fn-name-class sites")
assumes the class value exists and just needs its `.name` set. It doesn't —
the value is null. Adding a `__setFunctionName(value, key)` host call would
get called on `null` and either no-op or throw. Fixing this requires:

1. **Anonymous class collection in nested expression contexts** —
   `collectAnonymousClassesInNewExpr` only walks `NewExpression` and direct
   `ClassExpression` nodes, missing:
   - `{ prop: class {} }` (PropertyAssignment.initializer)
   - `({ x = class {} } = ...)` (BindingElement.initializer)
   - `var x = function(name) { return class {} }(...)` (any nested context)
   Need a full recursive `forEachChild` walk of every expression position,
   gated on whether the class would actually escape (e.g. assigned/returned).
2. **Class-as-value emission in struct-typed object literal path** —
   `compileObjectLiteralForStruct` (literals.ts:1032) currently emits field
   values via the generic struct-field type, which for a class-typed field
   resolves to `ref null Struct$X` not `externref`. The class expression
   resolves through `compileExpression` → `compileClassExpression` returning
   an externref, which then needs coercion + writeback into the struct field.
   The actual current behavior is "silently drop" because the type inference
   doesn't pick up that the field holds a class value.
3. **Then, after the value is preserved**, layer the NamedEvaluation
   bookkeeping: a compile-time pass that propagates the binding-key string
   to a `class.name` field initialiser, OR a runtime `__set_class_name`
   host hook called before the class struct escapes.

### Why this is hard (feasibility: hard)

Each of the three pieces above is a non-trivial codegen change touching
shared paths (class collection, object-literal compilation, function-name
inference). The blast radius hits every test that uses anonymous
classes/functions inside complex contexts — which is a lot. The "easy-medium"
rating in the original issue was based on the assumption that the .name was
just being overwritten; the actual failure (null class value) is deeper.

### Recommendation

**Status: blocked / needs-architect-spec.** The three-piece scope above
should be specced by an architect against a clean baseline. Two of the
three pieces (anonymous class collection in nested contexts, class-value
escape from object-literal struct path) overlap meaningfully with the
class-expression issues tracked under #1605, #1681, and the dstr-default
work in #1542/#1543/#1544 — there may be a unified design that handles
all of them.

No code change landed under this task; needs architect spec before
implementation. The probe files (`.tmp/probe-820m-*.ts`,
`.tmp/run-*.mts`) are gitignored and used only for the investigation.
