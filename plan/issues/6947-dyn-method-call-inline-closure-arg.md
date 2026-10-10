---
id: 6947
title: "An inline `function(){…}` argument to a method call on an `any` receiver is host-wrapped (`__make_callback_ctor`), and the callee's `f(x)` traps `dereferencing a null pointer` instead of taking the host-callable arm (Octane splay `traverse_`)"
status: in-progress
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
loc-budget-allow:
  # 2026-10-10 (#6947) calls.ts +13: the `F.prototype.m = function (cb)`
  #   holder arm (documented) in `isHostReachableMemberFunction`, next to the
  #   #4616 object-literal / class-member arms it generalizes.
  - src/codegen/expressions/calls.ts
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

## Implementation notes (2026-10-10, Session C)

### Step 1 — the trigger, pinned

`.tmp/sp24.js` passes and `.tmp/sp23.js` (real splay) fails because of the
**JSDoc on the callee**: splay.js declares `@param {function(SplayTree.Node)} f`
on `traverse_`. Adding that one comment to sp24 (`.tmp/sp25.js`) reproduces the
gc trap and the standalone TypeError exactly. With the JSDoc, `f` has a call
signature, so `f(current)` takes the typed callable-param closure dispatch
(guarded cast to the wrapper root, funcref ladder); without it `f` is `any` and
takes the generic dynamic call, which accepts a host function. A temporary
trace of `isHostCallbackArgument` showed the classification is
the SAME in both files (every inline callback to `.traverse_` was host-wrapped:
receiver `any`, or the JS-inferred `SplayTreeNode | undefined` for
`this.root_`, whose expando method declaration the class-name candidates cannot
see). The issue's "holding the callback in a variable works" (`p_q`) does not
hold once the callee is JSDoc-typed (`.tmp/sp26.js` fails on base, gc and
standalone).

### What landed (gc fixed; each half alone closes the gc trap)

- **Step 2, call site** (`isHostCallbackArgument`,
  `src/codegen/closures/callback-classification.ts`): a method name that is NOT
  in `HOST_CALLBACK_METHODS` is a compiled-closure consumer when (a) the
  receiver is `any`/`unknown` and the program defines that name as a
  function-valued member (`ctx.userMethodNames`), or (b) the method symbol has
  a compiled function IMPLEMENTATION declaration
  (`isCompiledFunctionMemberImplementation`: `X.prototype.m = function…`,
  object-literal `m: function…`/`m() {}`, a class method with a body —
  signatures are excluded, they may describe a host API). On the host lane a
  closure that does reach a host method is still made callable by the
  `__extern_method_call` bridge (`_maybeWrapCallableUnknownArity`).
- **Step 3, callee side, gc** (`isHostReachableMemberFunction`, consumed by
  `calleeMayBeHostCallable`, `src/codegen/expressions/calls.ts`): a param of
  `F.prototype.m = function (cb) {…}` gets the #1712 host-callable arm, exactly
  like the object-literal / class members #4616 already covered — so a host
  function arriving in `cb` dispatches through `__call_function` instead of
  trapping on `struct.get` of the nulled cast.

Tests: `tests/issue-6947-inline-callback-any-receiver.test.ts` (reduced
exportKeys/traverse_ pair, JSDoc inline + variable-held on gc, untyped control
on gc + standalone, host `forEach`/`map`/`find` controls on typed and `any`
receivers, object-literal user method). Base: 2 fail / 5 pass; head: 7 / 7.
Regression A/B over 113 test files matching 1311/1300/1712/1941/4616/3747/
2070/3016/3231/2903/callback/callable/host-call: identical pass/fail sets apart
from the two new gc cases.

Octane `splay.js` with `SplayTree.Node` rewritten to a function declaration
(`.tmp/splay-probe.mjs rewritten gc`) now runs to completion on gc
(`run(1) -> 1`). The ORIGINAL splay.js still fails on gc with
`traverse_ is not a function` — #6943's follow-up (top-level
`SplayTree.Node.prototype.traverse_ = …` dropped by the module-init keep gate),
not this issue.

### Remaining — standalone (why status stays in-progress)

The plan's premise that "the standalone side needs no host arm once step 2
stops the wrapping" does not hold. With step 2 the callback reaches `traverse_`
as a genuine closure struct (verified: the root cast succeeds), but the funcref
ladder of the JSDoc-typed `f(current)` only lists signatures compatible with
`function(N)` — `(root, ref null $N)` and friends — while an untyped JS
`function (node) {…}` compiled without a contextual type has `(root,
externref)`. No arm matches and the ladder's terminal arm throws the
`TypeError` (`.tmp/sp28.js`: even a TYPED-receiver call `n.run(cb)` with a
variable-held `cb` throws on standalone; the inline form at a typed call site
works only because contextual typing gives `node` the type `N`). gc survives
this because its terminal arm is the #1058 unmatched-closure host call.

The standalone fix belongs in `reserveUnmatchedClosureHostCall`
(`src/codegen/expressions/unmatched-closure-host-call.ts`), which already emits
the finalize-time `__apply_closure` arm for standalone — but only for a
descriptor-accessor callee (#6769 S7c). Admitting a callable param whose type
comes from JSDoc (or, more broadly, any closure-root callee) there would route
the unmatched live closure through `__apply_closure`. That file is outside this
issue's named functions, so it was not changed in this pass.
