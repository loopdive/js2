---
id: 2618
title: "Proxy (host): calling / constructing a Proxy whose target is callable traps (illegal cast) or ignores the construct trap result (~15 fails)"
status: ready
sprint: 65
created: 2026-06-22
updated: 2026-06-22
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: proxy
goal: spec-completeness
parent: 1355
related: [2180, 2615]
test262_bucket: proxy-apply-construct
---
# #2618 — Proxy (host): the apply/construct call path on a host Proxy

Slice of #1355. **Host (gc) mode only.** A host Proxy whose target is callable
is itself callable / constructable. Today `p(...)` traps with an illegal cast,
and `new p(...)` ignores the `construct` trap's return value.

## Re-measured evidence (arch, 2026-06-22)

```ts
// apply: callee is a host Proxy of a function → illegal cast trap
const fn = function () { return 1; };
const p = new Proxy(fn, { apply: () => 42 });
p();                       // THROWS (empty msg); test262: "illegal cast in __call_fn_method_3"

// construct: trap result ignored
class C {}
const p = new Proxy(C, { construct: () => ({ x: 9 }) });
const o = new p();  o.x;   // RETURNS 0 (BUG: construct trap returned {x:9}, o.x should be 9)
```

Affected test262 (gc): `built-ins/Proxy/apply/call-parameters.js`,
`apply/call-result.js`, `apply/trap-is-null.js`,
`apply/trap-is-undefined*.js`, `construct/call-parameters*.js`,
`construct/call-result.js`, `construct/trap-is-*` (~15, excluding the `-realm`
variants which need `$262.createRealm` — deferred).

## Root cause

1. **apply** — the compiled call site for `p(args)` statically classifies the
   callee `p` by its TS type (the target function type), so it lowers to the
   closure/method-call fast path (`__call_fn_method_N`) which `ref.cast`s the
   callee to a `$Closure` struct. A host-Proxy externref is not a `$Closure`,
   so the `ref.cast` traps ("illegal cast"). Same `project_proxy_no_ts_type_brand`
   pattern as #2615, but on the *call* path instead of the *read* path: the
   callee must be invoked through the dynamic call boundary
   (`__call_extern` / `__apply` / `__extern_method_call`) so the host runs the
   Proxy `apply` MOP — not via a static `ref.cast $Closure` + `call_ref`.

2. **construct** — `new p(...)` where `p` is a host Proxy: the `construct` trap
   fires (or forwards), but the returned object is dropped; `o` ends up as a
   default-constructed value (`o.x === 0`). The dynamic `new`-on-externref path
   must take the host MOP `[[Construct]]` result as the new object.

## Implementation Plan

### apply path
**File: `src/codegen/expressions/calls.ts`** (or wherever `CallExpression` chooses
between the closure fast path and the dynamic `__call_extern`/`__apply` boundary).
When the callee value's *storage* type is `externref`/`any` — which #2615 makes
true for a `new Proxy` local — the call must lower to the dynamic boundary, NOT
the `ref.cast $Closure` fast path. Confirm the dynamic boundary
(`__call_extern` / `__apply_closure` / `__extern_method_call`) already routes an
externref callee through the host (it does for `any`-typed callees); then this
slice is mostly "make the callee externref-typed and select the dynamic path",
which **depends on / composes with #2615's slot-type fix**. Add a guard: a
callee produced by `new Proxy` (or any externref-storage callee) skips the
`__call_fn_method_N` cast path.

### construct path
**File: `src/codegen/expressions/new-super.ts`** — the `new <expr>(...)` lowering
where `<expr>` is not a statically-known class. When the constructor value is an
externref Proxy, route through the host `[[Construct]]` boundary
(`__construct_extern` / equivalent) and **use its return value** as the result
object (§10.5.13 / §9.3.2: if the trap returns an object, that is the result).
Grep for the existing dynamic-`new` boundary helper; if none exists for
externref constructors, add `__proxy_construct(target, argArray, newTarget)` that
calls the host `Reflect.construct(proxy, args, newTarget)` (the host runs the
construct trap + §10.5.13 invariant). The runtime side mirrors #2180's
`_hostProxyConstruct` machinery.

### Edge cases
- `apply` trap absent → forward to target's `[[Call]]` (the proxied function
  runs) — the dynamic boundary already does this.
- `construct` trap absent → forward to target's `[[Construct]]`.
- `construct` trap returning a non-object → §10.5.13 TypeError (host enforces;
  re-throw via the #2617 boundary-propagation fix — note the cross-slice link).
- A Proxy of a non-callable target called as `p()` → TypeError "not a function"
  (host enforces).
- `new.target` / `newTarget` threading: pass the correct newTarget to
  `Reflect.construct` so `construct/call-parameters-new-target.js` passes.

### Dependencies / sequencing
- **Depends on #2615** (the externref slot-type fix) for callee/constructor
  classification — without it the callee local is struct-typed and the dynamic
  path is never selected. Land #2615 first; this slice then narrows to "select
  the dynamic call/construct path for externref callees + thread the construct
  result".
- Composes with #2617 for the construct-non-object / apply-not-callable TypeError
  propagation.

### Test-gate (test262, gc mode)
- `built-ins/Proxy/apply/call-parameters.js`, `apply/call-result.js`,
  `apply/trap-is-null.js`, `apply/trap-is-undefined.js`
- `built-ins/Proxy/construct/call-parameters.js`, `construct/call-result.js`,
  `construct/call-parameters-new-target.js`, `construct/trap-is-undefined.js`
- `tests/issue-2618.test.ts` — apply trap returns value; construct trap returns
  object used as result; absent traps forward.

### Risk
Hard — touches the call/construct dispatch selection (hot path). Gate the dynamic
routing strictly on externref-storage callees so non-proxy calls keep the
fast path. Validate full gc equivalence (broad-impact: call path).

## Investigation findings (2026-06-22, agent-acc861f0e7aea64c8) — DEFER / COORDINATE

A working **apply direct-call** path was prototyped and reverted (net +4 / −1 in
`built-ins/Proxy`, but the −1 is a hard PASS→ERR — not shippable). Four
coupled changes were needed and they entangle with closure-capture + the
call/construct dispatch sd-1838 is reworking under #56:

1. **Runtime (`src/runtime.ts` `_hostProxyConstruct`)**: wrap a CALLABLE target
   (`_maybeWrapCallableUnknownArity`) before `new Proxy(target, handler)` — a raw
   wasm-closure target is opaque to the host, so `new Proxy(wasmClosure, …)` is
   not host-callable and `p()` fails the host IsCallable check
   ("... is not a function" / `String(fn)` "Cannot convert object to primitive").
   **This change is clean and regression-free on its own** but useless without
   the codegen changes below.
2. **`src/codegen/statements/variables.ts`** — the `isCallable` branch
   match-recasts a `new Proxy` externref result to a `$Closure` struct
   (`ref.test` fails → NULLs `$p`). Needs a Proxy guard to keep externref
   (mirroring the `isBindHostCall` branch). **Required for the apply win.**
3. **`src/codegen/expressions/calls.ts`** — a callee whose slot is externref
   (`calleeSlotIsExternref`) must route `p()` through `__call_function` (host
   `[[Call]]` boundary) instead of the `ref.cast $Closure` fast path. Reuses
   `emitBoundFunctionCall`. **Required for the apply win.**

**The blocker (why it's deferred):** changes 2+3 make `$p` externref, which is
correct for direct `p()` BUT regresses `apply/return-abrupt.js` — `p.call()`
inside a nested `assert.throws(…, function(){ p.call(); })`. The OLD path
recast `$p` to a closure struct so the nested-capture `.call()` dispatched via
the struct-method path (which threw the Test262Error correctly); with `$p`
externref the captured `.call()` hits an `illegal cast` in the closure-capture /
method-call path. Getting the apply-direct win without the `.call()`-in-capture
regression requires fixing the externref-Proxy `.call()`/`.apply()` method
dispatch through closure capture — the same call/construct dispatch area
**sd-1838 is reworking under #56** (`__fn_tramp_Constructor` cross-realm cast).

**construct-trap-result:** `new p()` is statically lowered to a direct struct
construction (the `new <expr>` path resolves `p`'s TS type to the target class),
so the `construct` trap's return value is dropped (`o.x === 0`). Routing
`new p()` through a host `Reflect.construct` boundary lives in the dynamic-new
dispatch (`tryEmitDynamicNew`, new-super.ts) — **also the sd-1838 / #56 zone.**

**Recommendation:** sequence #2618 AFTER sd-1838's #56 call/construct-dispatch
rework lands (the capability bridge), then the apply+construct routing becomes
"select the dynamic host path for externref callees/constructors + thread the
result". Coordinate with sd-1838 before editing shared trampoline/call-dispatch.
The runtime target-wrap (change 1) can land independently if useful. Branch was
restored to pristine `origin/main`; no PR opened.
