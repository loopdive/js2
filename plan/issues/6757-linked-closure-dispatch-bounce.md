---
id: 6757
title: "Linked lane: a closure from another module bounces between its bridge and the calling module's dispatcher until the stack overflows"
status: done
completed: 2026-09-29
created: 2026-09-29
updated: 2026-09-29
priority: high
horizon: s
goal: core-semantics
sprint: current
# (#6757) The fix lives in the new leaf src/runtime/linked-closure-dispatch.ts.
# runtime.ts keeps only the call sites (+6 lines): the import, the configure
# call, the `linkedPeer` bridge parameter, the two `isRepeat` checks in the
# dynamic dispatch and the `routed` wrapper the bridge applies. The same +6
# raises plan/audit/host-import-policy-baseline.json maximumRuntimeTsLines
# 20214 -> 20220 (exact, no slack); resolveImport is unchanged.
loc-budget-allow:
  - src/runtime.ts
---

# Linked lane: foreign closure dispatch bounces until the stack overflows

## Symptom

`test/built-ins/RegExp/named-groups/duplicate-names-matchall.js` fails on the
authoritative host lane (`TEST262_ORACLE_MODE=linked`) with
`RangeError: Maximum call stack size exceeded`. It parked five merge groups in
one night (#6283, #6289, #6282 twice, #6290). The gate called it a cross-PR
flake each time, because the row's binary is identical on every one of those
PRs and on main.

It is not a flake. Through the CI worker path (`tests/test262-chunk-dynamic.test.ts`,
linked, Node 24) the row fails **every** time, alone or inside its shard (host
13/20). The "poison retry" re-ran it in a fresh fork and it failed again. Main's
promoted baseline row reads `pass` only because promote-baseline heals
poison-class rows (`poison_healed: true`).

## Root cause

The test hands the harness closures minted in the test body:

```js
assert.compareIterator(iterator, expected.map(e => v => assert.compareArray(v, e)));
```

`compareIterator` lives in the harness provider and calls `validators[i](value)`.
That is a method call on a host array, so the host invokes the closure through
the dynamic bridge (`_wrapWasmClosureUnknownArity`). The bridge was built with
the PROVIDER's exports, so it dispatched through the provider's
`__call_fn_method_1`.

That dispatcher matches closures by their exact function type, and only knows
its own module's closures. It matched no arm, and its #4618 terminal handed the
callee to the host as `__call_function_1(fn, …)` — the arm meant for a genuine
host function coming back. The host wrapped the closure with the provider's
state again, got the same cached bridge, and dispatched through the same
provider dispatcher. Stack from the worker (`--stack-trace-limit`, 3,400 frames):

```
wasmClosureDynamicBridge → wasmClosureDynamicDispatch → _applyWithPrefix
  → __ js2_call_fn_method_argc_1 → __call_fn_method_1   (provider)
  → fn2 (host __call_function_1) → invoke → applyWithVecMirrorWriteback
  → wasmClosureDynamicBridge → …
```

The #5225 owner registry cannot help: it asks `__struct_field_names`, and
closures answer "" in every module. `__closure_arity` cannot help either: it
reads the shared wrapper root, so the provider answers correctly for the
body's closure too.

## Fix

`src/runtime/linked-closure-dispatch.ts` detects the loop and retries the
closure through the module that minted it. It is active only while a linked
project is live.

- Each dynamic bridge dispatch records (closure, module, dispatcher export,
  receiver) on a small stack.
- The host `__call_function_N` import reports a call of the closure being
  dispatched, from the dispatching module, on the same receiver
  (`noteFallback`). That is the dispatcher's #4618 terminal giving the closure
  back, and it still proceeds exactly as before.
- Not every fallback is the loop: a re-entered bridge can choose a different
  dispatcher (another arity, or the free-call family) and succeed. The first
  version of this fix cut that off and broke
  `for-of/typedarray-backed-by-resizable-buffer-shrink-to-zero-mid-iteration.js`.
  So the loop is declared only when the re-entered bridge is about to call the
  **same** dispatcher export of the **same** module for that closure
  (`isRepeat`). Those are the arms that just missed, so the call can only
  repeat forever.
- On a loop, the re-entered bridge returns at once, the outer dispatch is
  marked missed and unwinds, and the bridge retries through the other modules
  of the project (new `peersOf` on the #5225 registry). Each retry goes through
  an uncached per-module bridge. The module that ran the closure is remembered.
- If no module can run it, the bridge throws a TypeError instead of
  overflowing the stack.

With no linked project live, no frame is ever pushed. Both hooks then return
at once and the bridge takes exactly the old path, so the honest lane and
every single-module embedder are unchanged.

## Validation

- **The row**: CI worker path, linked, Node v24.21.0: fail → **pass**.
- **Pin** `tests/issue-6757-linked-closure-dispatch-bounce.test.ts`:
  - an in-process linked run of the same shape (body-minted validators through
    the provider's `compareIterator`): `Maximum call stack size exceeded`
    before, pass after;
  - a control where the validator does not capture (its closure type is one
    the provider knows): passes before and after;
  - unit tests of the detector: same-export re-entry is a loop, a different
    export is not, only the dispatching module's fallback on its receiver
    counts, owner memo, the all-miss TypeError.
- **Shard**: host 13/20 (2,437 rows), linked, Node 24, pool 4, before and after
  the fix; see the PR for the row-level comparison.
