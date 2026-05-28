---
id: 1695
title: "DisposableStack/AsyncDisposableStack prototype methods — deferred-callback writeback fires too early (23 fails)"
status: ready
created: 2026-05-28
updated: 2026-05-28
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen, closures
language_feature: explicit-resource-management
goal: spec-completeness
sprint: Backlog
related: [820h, 859, 929, 1036, 1116, 1433]
test262_fail: 23
note: "Investigation 2026-05-28 (dev-1527). Sibling #820h fixed the brand checks; what remains is a closure-writeback model gap for stored callbacks — defer/use/adopt store the callback for later invocation, but the compiler emits the post-call ref-cell writeback EAGERLY (right after defer), so the outer local snapshots stale 0 before dispose runs the disposer. Same shape will affect Promise.then, setTimeout, addEventListener, EventTarget callbacks."
---
# #1695 — DisposableStack/AsyncDisposableStack stored-callback writeback fires before the callback runs

## Problem

23 test262 failures across `built-ins/DisposableStack/*` and
`built-ins/AsyncDisposableStack/*` (`.test262-cache/test262-current.jsonl`,
2026-05-28). The sibling #820h fix landed the brand checks and reflection
plumbing — what's left is the prototype methods themselves (`defer`, `use`,
`adopt`, `dispose`, `move`).

Spread across:
- 8 `built-ins/DisposableStack/prototype/{defer,dispose,use,adopt,move}/*`
- 4 `built-ins/{,Async}DisposableStack/prototype-from-newtarget-*` (custom +
  abrupt)
- 11 misc (`disposed`, `Symbol.dispose-getter`,
  `disposes-resources-in-reverse-order`, `throws-suppressederror-if-multiple-
  errors-during-disposal`, etc.)

## Failing-test shape (typical)

`test/built-ins/DisposableStack/prototype/defer/adds-onDispose.js`:

```js
var stack = new DisposableStack();
var disposed = false;
stack.defer(() => { disposed = true });
stack.dispose();
assert.sameValue(disposed, true, 'Expected callback to have been called');
```

We return `disposed === false`. The host `DisposableStack` IS called with a
real JS function for `defer`, AND `dispose()` IS dispatched, AND the JS
function IS invoked (traced via `__make_callback` wrapper). The callback's
internal write `disposed = true` reaches the ref-cell. But the outer local
`disposed` keeps reading `false`.

## Root cause (confirmed by WAT inspection)

Closure-mutable captures use the standard `#859` ref-cell model
(`src/codegen/closures.ts:2625-2670`). For `let x = 0; stack.defer(() => { x++; })`:

1. At the `defer` call site, the compiler creates a ref-cell, boxes the
   capture, and registers a **post-call writeback** that reads the ref cell
   back into the outer local AFTER the call.
2. The writeback fires immediately after `defer()` returns — but `defer`
   only STORES the callback; it doesn't invoke it. So the writeback
   snapshots the still-zero ref cell into the outer local.
3. `dispose()` runs the callback (which DOES write to the ref cell), but
   nothing re-reads the ref cell into the outer local afterwards.
4. The subsequent `if (disposed !== true)` reads the stale 0 from the outer
   local → assertion fails.

The model assumes the callback runs synchronously during the call that
registers it (Array.forEach, Map.forEach, etc., where the existing model
works). The model breaks for **stored-callback** host APIs:

- `DisposableStack.prototype.{defer, use, adopt}` (this issue)
- Eventually: `Promise.prototype.then/catch/finally`,
  `setTimeout`/`setInterval`, `addEventListener`, `FinalizationRegistry`
  callbacks, `MutationObserver` callbacks, etc.

The `needsThis=true` branch at closures.ts:2663 already implements the
"every subsequent call re-syncs" model via `persistentCallbackWritebacks`
— exactly for getter/setter callbacks that may be invoked later by an
unrelated host call. The fix is to route stored-callback methods through
the same persistent writeback path.

## Why this is NOT a localized fix

A surface-level "promote defer/use/adopt writebacks to persistent" patch is
small but introduces hard tradeoffs:

1. **Identifying stored-callback methods is heuristic.** The compiler at
   the closure-emission site (`compileArrowAsCallback`) does NOT know which
   extern method is going to consume the resulting externref. The
   information lives at the call site (`extern_class` action="method",
   member="defer"/"use"/"adopt") — a separate compile pass.
2. **`persistentCallbackWritebacks` cost.** Re-emitting writeback
   instructions after every subsequent call in the function adds a
   `struct.get` + `local.set` per capture per call site. For functions
   that contain only a single defer + a single dispose this is negligible,
   but for tight loops over stored callbacks it can bloat module size.
3. **Promise.then / setTimeout would need the same path** AND those go
   through different codegen surfaces (host-import allowlist, builtin
   intent), so the fix has to touch each surface.
4. **`#1116` Promise.then standalone work touches the same pattern.** Any
   shared "persistent writeback for deferred callbacks" infra should be
   designed with #1116 in mind; otherwise we'll have two parallel
   implementations.

## Recommended next step

Architect spec for **"deferred-callback writeback model"** covering:

- A pass-thru flag on `compileArrowAsCallback` (`{ deferredInvocation?: true }`)
  set by the caller (extern-class method dispatch in
  `src/codegen/property-access.ts` for `defer`/`use`/`adopt`, plus
  Promise.then in `src/codegen/builtins/promise.ts`).
- When the flag is set, route writebacks through
  `persistentCallbackWritebacks` regardless of `needsThis`.
- Allowlist of host methods that treat their callback arg as deferred:
  `DisposableStack.{defer,use,adopt}`,
  `AsyncDisposableStack.{defer,use,adopt}`,
  `Promise.prototype.{then,catch,finally}`,
  `globalThis.{setTimeout,setInterval,queueMicrotask}`,
  `EventTarget.prototype.addEventListener`,
  `FinalizationRegistry` constructor callback.

## Acceptance criteria

1. The 8 `built-ins/DisposableStack/prototype/{defer,use,adopt,dispose,move}/*`
   fails flip to pass.
2. The 11 misc DisposableStack/AsyncDisposableStack residuals are re-evaluated
   — some are `prototype-from-newtarget-*` artefacts of #820h's reflection
   wiring, and may be a separate sub-cluster.
3. No regression in `tests/spec-gaps.test.ts`, equivalence tests, or the
   existing #859/#929 captured-mutation test pins.

## Reproducer (probes live in `.tmp/`)

```ts
export function test(): number {
  const stack = new DisposableStack();
  let called = 0;
  stack.defer(() => { called = called + 1; });
  stack.dispose();
  if (called !== 1) return 7777;
  return 1;
}
```

Returns `7777`. Traced: `defer(self, cb)` receives a real JS function;
`dispose(self)` is called; `__cb_0` IS invoked inside dispose. But `called`
reads stale 0.

WAT shows the writeback (`local.get refCell; struct.get; local.set called`)
emitted between `defer` and `dispose` instead of after `dispose`.

## Investigation log (2026-05-28, dev-1527)

- Sibling #820h fixed bare-identifier reflection (`DisposableStack.prototype`
  etc.) — that work is done.
- Object-literal Symbol.dispose: `MethodDeclaration` form
  (`{[Symbol.dispose]() {…}}`) does work via the well-known-symbol path at
  `literals.ts:392`. The `PropertyAssignment` form
  (`{[Symbol.dispose]: () => {…}}`) is silently dropped at
  `literals.ts:344` ("Computed property names not handled here — fall
  through silently"). Symmetric fix is straightforward but only buys ~2 of
  the 23 fails; the dominant issue is the writeback model above.
- Sibling locked worktree `issue-1695-disposable-stack` exists with
  unrelated state from a prior run; this investigation used a fresh
  `issue-1695-disposable-stack-v2` worktree.

## Out of scope

- The `_hasDisposalMethod` PropertyAssignment-form fix (~2 fails) is a
  drive-by improvement; not the architect-spec item this issue tracks.
- The Symbol.dispose / asyncDispose object-literal routing for
  `using r = X` declarations — separate codegen path
  (#1036, #1433).
- Native (standalone-Wasm) (Async)DisposableStack — depends on the
  host-independence work (#1471/#1473/#1474) and would need its own design.
