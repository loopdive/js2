---
id: 820m
title: "NamedEvaluation: anonymous class/function value not named from binding key (~12 fails, fn-name-class + __proto__-fn-name)"
status: ready
created: 2026-05-28
updated: 2026-05-28
priority: medium
feasibility: easy-medium
reasoning_effort: medium
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
