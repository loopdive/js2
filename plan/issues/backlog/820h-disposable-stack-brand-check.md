---
id: 820h
title: "DisposableStack / AsyncDisposableStack brand-check and protocol stubs (~74 fails)"
status: ready
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bug
area: builtins
goal: async-model
parent: 820
es_edition: ES2025
language_feature: explicit-resource-management
test262_fail: 74
created: 2026-05-21
---

# #820h — (Async)DisposableStack brand check + protocol

## Problem

~74 test262 failures across `built-ins/DisposableStack/*` and
`built-ins/AsyncDisposableStack/*`. Errors:

- `TypeError: Cannot access property on null or undefined` on
  `.disposed`, `.dispose`, `.use`, `.adopt`, `.defer`.
- `Symbol.dispose` / `Symbol.asyncDispose` brand checks missing on the
  receiver.
- `prototype-from-newtarget-*` tests fail because the prototype chain isn't
  wired for the explicit resource management built-ins.

This is the explicit resource management (ERM) ES2025 feature surface, which
appears to be partially stubbed: the constructors are present but
`prototype-from-newtarget` / receiver brand checks / protocol method
delegation are not.

## Sample failing tests
- `test/built-ins/AsyncDisposableStack/prototype-from-newtarget-custom.js`
- `test/built-ins/DisposableStack/prototype/dispose/not-a-constructor.js`
- `test/built-ins/DisposableStack/prototype-from-newtarget-abrupt.js`

## Suspected source

- `src/codegen/builtins/` — no dedicated `disposable-stack.ts` exists yet;
  the constructors are likely defined inline in `runtime.ts` without proper
  brand checks.
- `src/codegen/runtime.ts` — `prototype-from-newtarget` chain wiring.

## Spec reference

- ECMAScript §27.3 DisposableStack Objects
- §27.4 AsyncDisposableStack Objects
- §27.5 Symbol.dispose / Symbol.asyncDispose protocol

## Acceptance criteria

- [ ] At least 60 of the ~74 tests flip to `pass`.
- [ ] Brand check on `.disposed`, `.dispose`, `.use`, `.adopt`, `.defer`
      receiver — throws `TypeError` (not null-deref) when called on a
      non-(Async)DisposableStack receiver.
- [ ] `prototype-from-newtarget` returns the correct prototype object.
- [ ] No regressions in already-passing ERM tests.

## Notes

- ES2025 feature; consider whether this is in scope before the rest of the
  ES2025 surface is built out. May be a candidate for `goal: deferred`
  re-classification if the team isn't pursuing ES2025 coverage yet.
