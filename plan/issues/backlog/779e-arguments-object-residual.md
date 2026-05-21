---
id: 779e
title: "arguments-object mapped / trailing-comma / sloppy-strict residuals (~161 fails)"
status: ready
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
goal: property-model
parent: 779
es_edition: ES5.1
language_feature: arguments-object
test262_fail: 161
created: 2026-05-21
---

# #779e — arguments-object residuals after #849

## Problem

~161 test262 `assertion_fail` failures under `language/arguments-object/*`.
Cases include:

- Strict-mode mapped vs. unmapped argument behavior (`10.5-*-s.js`)
- Trailing-comma in async-gen-meth / cls-decl-async-gen-meth argument lists
- `eval("arguments = 10")` must throw SyntaxError (currently passes through)
- mapped-arguments sync vs. parameter renaming

After #849 closed the bulk of the arguments-object work, these residuals
remain. They cluster around:

1. Strict-mode unmap of arguments (modifying `arguments[i]` must not
   reflect into the named parameter under strict).
2. Trailing-comma handling in argument lists for class/object methods.
3. Annex-B `eval("arguments = ...")` should be a SyntaxError.

## Sample failing tests
- `test/language/arguments-object/10.5-1-s.js`
- `test/language/arguments-object/async-gen-meth-args-trailing-comma-undefined.js`
- `test/language/arguments-object/cls-decl-async-gen-meth-static-args-trailing-comma-multiple.js`

## Suspected source

- `src/codegen/expressions/arguments.ts` — mapped-argument synchronization,
  strict-mode branch.
- `src/codegen/statements.ts` — parse-time validation that `arguments`
  cannot be assigned under strict mode.
- Parser / source-text validator for trailing-comma sets in method headers.

## Spec reference

- ECMAScript §10.4.4 Arguments Exotic Objects
- §10.2.11 FunctionDeclarationInstantiation (mapped vs unmapped split)
- §13.2.5 PropertyDefinitionEvaluation (trailing-comma rules)

## Acceptance criteria

- [ ] At least 110 of the ~161 tests flip to `pass`.
- [ ] No regressions in already-passing arguments-object tests.
- [ ] Both strict and sloppy variants pass for each touched test family.
