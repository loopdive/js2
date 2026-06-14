---
id: 1433
title: "spec gap: DisposableStack and AsyncDisposableStack lifecycle semantics"
status: done
completed: 2026-06-12
created: 2026-05-11
updated: 2026-05-20
priority: medium
feasibility: hard
reasoning_effort: high
task_type: feature
area: runtime
language_feature: explicit-resource-management
goal: spec-completeness
sprint: 52
related: [1020, 1036, 1037, 1413]
---
# #1433 - DisposableStack and AsyncDisposableStack lifecycle semantics

## Problem

Spec §27.6 still shows `75 / 165` passing with 90 failures. Existing issues
covered narrower null-trap, TDZ, and `SuppressedError` construction slices, but
there is no open tracker for the remaining stack lifecycle behavior.

The missing surface includes:

- `DisposableStack.prototype.use`, `adopt`, `defer`, `move`, and `dispose`.
- `AsyncDisposableStack` async disposal ordering and rejection handling.
- The disposed/moved state checks and required TypeError paths.
- Suppression chains when both the body and disposer throw.

## Acceptance criteria

1. `DisposableStack` disposal order is LIFO and exactly-once.
2. `move()` transfers stack entries and marks the original stack disposed.
3. `AsyncDisposableStack` awaits async disposers in spec order.
4. Suppressed errors preserve primary and suppressed values.
5. §27.6 pass-rate improves materially and all new helpers work in standalone
   mode without relying on host-only mutable JS state where avoidable.

## Files to inspect

- `src/codegen/builtins.ts`
- `src/codegen/runtime-builtins.ts`
- `src/runtime.ts`
- `tests/issue-1433.test.ts`

## Fix (2026-05-20)

This PR addresses the core gap behind ~30 DisposableStack failures: object
literals carrying `[Symbol.dispose]()` or `[Symbol.asyncDispose]()` computed
methods were compiled as WasmGC structs whose `@@dispose` field is opaque
to native JS. `DisposableStack.use(resource)` rejected them outright
because `resource[Symbol.dispose]` was undefined from the host's view.

Changes:

1. `src/codegen/literals.ts` — `compileObjectLiteral` now routes literals
   with `[Symbol.dispose]` / `[Symbol.asyncDispose]` computed methods
   through `compileObjectLiteralWithAccessors` (the JS-host plain-object
   path used for accessor literals).
2. `src/codegen/literals.ts` — that path now recognises method
   declarations whose computed key resolves to a well-known Symbol and
   boxes the i32 symbol ID via `__box_symbol`, installing the disposer
   under the *real* `Symbol.dispose` / `Symbol.asyncDispose` property
   instead of the wasm-internal "@@dispose" alias.
3. `src/codegen/declarations.ts` — the `__make_getter_callback` import
   is now also enabled when any such literal is present.
4. `src/codegen/index.ts` (`hoistVarDecl`) and
   `src/codegen/statements/variables.ts` — declarations whose initializer
   matches the pattern are pre-tagged in `ctx.externrefAccessorVars`, so
   the binding's local is allocated as `externref` and later
   property reads/writes route through `__extern_get` / `__extern_set`.

Scope kept narrow on purpose: the PR fixes the disposer-method routing
that gates `DisposableStack.use` / `Symbol.dispose` lookup. Test262
sub-areas requiring separate work (and still failing after this fix):

- `assert.throws`-style harness tests that depend on resolving
  `DisposableStack.prototype.use.call(undefined)` patterns — needs
  prototype-method `.call(this)` support.
- `.adopt(value, onDispose)` and `.defer(onDispose)` — callback args to
  extern methods aren't yet wrapped through `__make_callback`.
- `get [Symbol.dispose]()` getter form — getter declarations with
  computed Symbol keys not yet routed.
- `Reflect.construct(DisposableStack, [], newTarget)` and friends.
