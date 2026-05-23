---
id: 820d
title: "class/dstr async-gen-meth default-init `unresolvable` illegal cast"
status: ready
sprint: 55
created: 2026-05-21
updated: 2026-05-21
priority: high
feasibility: medium
reasoning_effort: medium
goal: property-model
parent: 820
es_edition: ES2017
language_feature: class-destructuring-async-generator-method
task_type: bug
test262_fail: 104
note: "Verified 2026-05-21: closures.ts __obj_meth_tramp at L3019/L3085; binding-element default closure location is in destructuring-params.ts (no obvious 'default-init' match in literals.ts — may need re-scoping during implementation)"
---

# #820d — class/dstr async-gen-meth default-init `unresolvable` illegal cast

## Problem

~104 test262 fails in `language/expressions/class/dstr/async-gen-meth-dflt-{ary,obj}-ptrn-*-init-unresolvable.js`
throw `illegal cast [in __closure_N() ← assert_throws ← test]`. The pattern is
an async generator method with destructured parameters whose default
initializer references an `unresolvable` identifier — the spec requires this
to evaluate (and throw `ReferenceError`) only when the parameter is
`undefined`, but the compiled binding-element default-init closure emits a
`ref.cast` typed against the wrong target, blowing up before the default
expression can run. This is closely related to #1543 (now closed) but the
`-init-unresolvable` subset shares a tighter signature that #1543's fix did
not cover.

## ECMAScript spec reference

- §15.7 ClassDefinitionEvaluation / §15.5 AsyncGeneratorMethod
- §10.2.1 OrdinaryFunctionCreate + §8.6.2 IteratorBindingInitialization
  (default-value evaluation deferred to undefined-only)
- Expected: `ReferenceError: <name> is not defined` from a normal evaluation
  path; Actual: `illegal cast` from the Wasm cast emitted ahead of the
  default-init closure body.

## Files to change

- `src/codegen/literals.ts` — binding-element exclusion / default-init
  closure typing. The closure compiles a `ref.cast` against the resolved
  parameter type rather than the union-or-undefined type that the
  destructuring caller actually passes.
- Cross-check with the async-gen-meth trampoline emitter (`src/codegen/closures.ts`,
  `__obj_meth_tramp_*` / `__class_meth_tramp_*`) for the receiver of the
  default-init closure to ensure the param slot is typed compatibly.

## Acceptance criteria

- [ ] `language/expressions/class/dstr/async-gen-meth-dflt-ary-ptrn-elem-init-unresolvable.js` no longer reports `illegal cast`; throws spec-correct `ReferenceError`.
- [ ] `language/expressions/class/dstr/async-gen-meth-dflt-obj-ptrn-id-init-unresolvable.js` no longer reports `illegal cast`; throws spec-correct `ReferenceError`.
- [ ] All `async-gen-meth-dflt-*-init-unresolvable.js` paths under `language/expressions/class/dstr` move from fail → pass (or at minimum no longer surface as `illegal_cast` in the test262 error_category bucket).
- [ ] Net test262 pass increase ≥ +80 (target ~104).
- [ ] No regression in #1543 acceptance set.
