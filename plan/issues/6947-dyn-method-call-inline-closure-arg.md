---
id: 6947
title: "An inline `function(){…}` argument to a method call on an `any` receiver is host-wrapped (`__make_callback_ctor`), and the callee's `f(x)` traps `dereferencing a null pointer` instead of taking the host-callable arm (Octane splay `traverse_`)"
status: ready
sprint: current
created: 2026-10-10
updated: 2026-10-10
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: callbacks, closures, dynamic-dispatch
goal: correctness
related: [874, 6943, 6946, 1300, 1311, 1712, 1941, 3747, 4394, 4616]
assignee: "ttraenkler/claude-session-c-octane-dyn-method-call-inline-closure-arg-20261010"
---

# #6947 — inline callback to an any-receiver method call: wrapped for the host, then null-dereferenced by the compiled callee

Found by the Octane triage (#874, Session C, 2026-10-10). This is the gc
blocker of `splay.js` after #6943 (verified with `.tmp/octane-probe-patched.mjs`,
which rewrites `SplayTree.Node` to a function declaration: gc then fails
`dereferencing a null pointer` in `exportKeys`).

## Problem

Octane `splay.js`:

```js
SplayTree.prototype.exportKeys = function() {
  var result = [];
  if (!this.isEmpty()) {
    this.root_.traverse_(function(node) { result.push(node.key); });   // any receiver, inline callback
  }
  return result;
};
SplayTreeNode.prototype.traverse_ = function(f) {
  var current = this;
  while (current) { var left = current.left; if (left) left.traverse_(f); f(current); current = current.right; }
};
```

Minimized against the real file (`.tmp/sp23.js` = `splay.js` with
`SplayTree.Node` → `function SplayTreeNode`, plus):

```js
function id_(x) { return x; }
export function main() { var r = new SplayTreeNode(0.5, {a:1}); var c = 0; id_(r).traverse_(function(node){ c++; }); return c; }
```

| lane       | result                                                                  |
| ---------- | ----------------------------------------------------------------------- |
| node       | `1`                                                                     |
| gc         | `RuntimeError: dereferencing a null pointer` in `traverse_` (`__closure_42`) via `__call_fn_method_1` ← `_applyWithPrefix` |
| standalone | `TypeError: Cannot access property on null or undefined` at `f(current)` (splay.js:420) |

Holding the SAME callback in a variable first works everywhere
(`.tmp/octane-splay-bisect.mjs` `p_q` → 1 vs `p_o` → trap), and so does a typed
receiver (`r.traverse_(function…)`).

## Root cause (mechanism confirmed from the emitted WAT; trigger condition partly open)

Call site (`main` in `.tmp/sp23-gc.wat`): the inline function expression is
compiled as a HOST callback — `struct.new` closure → `call
$__make_callback_ctor` (import) — and passed to `__extern_method_call_1(recv,
"traverse_", cb)`. The decision is `isHostCallbackArgument`
(`src/codegen/closures/callback-classification.ts:237+`, property-access branch
≈ `:290+`), consumed by `compileArrowFunction` (`src/codegen/closures.ts:2637`);
the maker name comes from `resolveCallbackMakerName`
(`src/codegen/callback-ctor-bridge.ts:73`). A variable-held callback is compiled
by `compileArrowAsClosure` and stays a raw closure struct, which is why `p_q`
works.

Callee side (`traverse_` body): the callable-parameter call `f(current)`
(`src/codegen/expressions/call-identifier.ts:2865-2874`) keeps the raw externref
in `__callable_raw_N`, guard-casts to the closure wrapper root into
`__callable_param_N` — the host-wrapped JS function fails `ref.test`, so the
local is NULL — then immediately `struct.get <wrapper> 0` on that null to fetch
the funcref for the per-signature `ref.test`/`call_ref` ladder. The #1712
host-callable fallback (`hostCallFallback`, `:3033-3062`, dispatching through
`__call_function_N`) is emitted only when `calleeMayBeHostCallable(ctx, callee)`
(the #1941 narrowing: ordinary callable PARAMETERS are assumed to always hold
wasm closures), so for `f` it is absent and the `struct.get` traps first. The
same callee shape on standalone has no host arm at all and reads the wrapped
value as nullish (the `Cannot access property on null` at `f(current)`).

Open: `.tmp/sp24.js` (same two call-site shapes in a 25-line file) passes on
both lanes, so some property of the full `splay.js` makes
`isHostCallbackArgument` classify this site as host-bound where the small file
does not — identify it in step 1 below (candidates: the method name
`traverse_` also appearing on a user prototype vs. the `any` receiver type of
`this.root_`, and the second inline-callback site in `exportKeys`).

## Implementation Plan

Spec: §10.2.1 [[Call]] of an ordinary function object; the callee must be able
to call any callable it receives. The two halves are independent and BOTH should
land — one closes the trap, the other removes the needless host round-trip.

1. **Pin the classification trigger**: dump the WAT of `.tmp/sp23.js` and
   `.tmp/sp24.js` (`.tmp/wat.mjs`) and diff the `main` call sites
   (`__make_callback_ctor` vs raw `struct.new`); add a `JS2WASM_LOG_CALLBACK_CLASS`
   trace to `isHostCallbackArgument` printing the branch taken, run both.
2. **Call site** (`callback-classification.ts`, property-access branch): when the
   method name resolves to a USER prototype method anywhere in the program
   (`<F>.prototype.<name> = function` or a class method — the oracle already
   indexes these for `__extern_method_call` dispatch), classify the argument as
   a compiled-closure consumer, not a host callback — the #1311 rule generalized
   from "user-defined class" to "user-defined method". Keep host-wrapping for
   genuine host methods (`arr.forEach`, `promise.then`, `JSON.parse` reviver).
3. **Callee side** (`call-identifier.ts`): never `struct.get` on a nulled
   guarded cast. Either guard the funcref fetch with `ref.is_null` and route to
   the existing `__call_function_N` host arm (gc) — i.e. make `hostCallFallback`
   available for every externref callee, not only `calleeMayBeHostCallable`
   ones, which the #1941 comment resisted only to avoid pulling host imports
   into self-contained modules (so gate the arm on `__call_function_N` already
   being imported, or import lazily); or on standalone throw the §7.3.14 Call
   `TypeError: called value is not a function` instead of reading null. The
   standalone side needs no host arm once step 2 stops the wrapping.
4. **Tests** (`tests/issue-6947-inline-callback-any-receiver.test.ts`, both
   lanes vs node): sp23's shape in a small program once step 1 has found the
   trigger (Octane sources must not be copied into the repo — write a reduced
   `exportKeys`/`traverse_` pair that reproduces); `p_o` vs `p_q` equivalence;
   controls: `arr.forEach(function(x){…})` on a real host array still works on
   gc, `promise.then(function(v){…})` still works, and the #3747 IIFE shape and
   #4616 call-of-call shape keep their current behaviour.
5. **Acceptance**: Octane `splay.js` passes end to end on gc with #6943
   (`.tmp/octane-probe.mjs splay`), and on standalone with #6943 + #6946.

## Ownership note

`callback-classification.ts`, `closures.ts`, `call-identifier.ts` are Session
A's WasmGC/shared-IR area; Session C implements at the project lead's
direction. Functions touched: `isHostCallbackArgument`,
`compileArrowFunction` (no change expected, consumer only), the
callable-parameter call lowering in `call-identifier.ts` around
`__callable_param_`/`hostCallFallback`, `calleeMayBeHostCallable`.
