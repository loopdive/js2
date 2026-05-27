---
id: 779d
title: "Object-literal destructuring (non-class, non-for-of) residuals (~132 fails)"
status: in-review
created: 2026-05-21
updated: 2026-05-27
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: object-destructuring
goal: property-model
sprint: Backlog
parent: 779
es_edition: ES2018
test262_fail: 132
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

## Fix (2026-05-27) — narrow funcIdx-shift sub-cluster

Root cause confirmed in `src/codegen/destructuring-params.ts`
`destructureParamObject` externref path (lines ~581-609): the struct-fast-path
`then` branch and the `__extern_get` `else` branch each compile the binding
default into a detached buffer via a manual `fctx.body` swap. When the *second*
branch's compilation added a late/union import, the function indices shifted,
but the *first* branch's buffer was detached from `fctx.body` at that moment, so
the index-shift walk missed its forward `call`, leaving an off-by-one funcIdx
("not enough arguments on the stack for call"). E.g. `method({ x = thrower() })`
emitted `call <method>` instead of `call <thrower>`.

Fix: register both branch buffers in `ctx.liveBodies` (walked by every shift
path) for the whole construction window. Same mechanism as the #801/#1384
liveBodies safety net.

### Test Results
- 6 `*-meth-obj-ptrn-*-init-throws` tests (meth/gen-meth/async-gen-meth ×
  id/prop-id) flip from `compile_error` → `pass` (verified in process isolation).
- `tests/issue-779d.test.ts` added (3 cases) — passes.
- Regression check: `default-params.test.ts` 3 failures are PRE-EXISTING on the
  branch base (verified by stashing the fix), NOT introduced here.
- Out of scope (separate bugs, still failing): `*-init-skipped` family (default
  fires on `null` — #821/#1550 semantics); `async-gen-*-prop-id-init-skipped`
  has a distinct funcIdx orphan in the async-gen path; elision/rest = #1592.

## Acceptance criteria

- [ ] At least 100 of the ~132 tests flip to `pass`.
- [ ] No regressions in passing `language/expressions/object/dstr` tests.
- [ ] Fix is symmetric with #779a (class-method) — same helper, same call
      site shape.
