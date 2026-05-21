---
id: 779d
title: "Object-literal destructuring (non-class, non-for-of) residuals (~132 fails)"
status: ready
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
goal: property-model
parent: 779
es_edition: ES2018
language_feature: object-destructuring
test262_fail: 132
created: 2026-05-21
---

# #779d — Object-literal destructuring residuals

## Problem

~132 test262 `assertion_fail` failures under
`language/expressions/object/dstr/*`. These are destructuring patterns inside
plain object literals (not class methods, not for-of headers). The methods
inside object literals (e.g. `{ async *m([x, y, ...rest]) {} }`) compile and
run but bind wrong values.

This pattern is the object-literal analogue of #779a; it slips through the
class-only paths fixed by #1543/#1544 and the for-of paths fixed by
#1396/#1454/#1468.

## Sample failing tests
- `test/language/expressions/object/dstr/async-gen-meth-ary-ptrn-elem-id-iter-step-err.js`
- `test/language/expressions/object/dstr/async-gen-meth-ary-ptrn-rest-ary-empty.js`
- `test/language/expressions/object/dstr/async-gen-meth-ary-ptrn-rest-obj-prop-id.js`

## Suspected source

- `src/codegen/literals.ts` — object-literal property emission for
  method/gen/async-gen property values. Binding-element params on these
  method values do not route through the destructuring helper.
- `src/codegen/destructuring-params.ts` — likely needs to be invoked from
  the object-literal method-value emission path.

## Spec reference

- ECMAScript §13.2.5 Object Initializer (PropertyDefinitionEvaluation for
  MethodDefinition)
- §14.1.18 IteratorBindingInitialization

## Acceptance criteria

- [ ] At least 100 of the ~132 tests flip to `pass`.
- [ ] No regressions in passing `language/expressions/object/dstr` tests.
- [ ] Fix is symmetric with #779a (class-method) — same helper, same call
      site shape.
