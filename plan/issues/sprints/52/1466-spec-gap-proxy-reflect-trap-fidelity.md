---
id: 1466
sprint: 52
title: "spec gap: Proxy + Reflect trap / operation fidelity"
status: ready
created: 2026-05-20
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: proxy-reflect
goal: spec-completeness
related: [965, 929, 1460, 1462]
---
# #1466 - spec gap: Proxy + Reflect trap / operation fidelity

## Problem

`built-ins/Proxy/` and `built-ins/Reflect/` together contribute
**464 test262 failures**:

```
Proxy/                                Reflect/
  27 ownKeys     27 set                18 set                14 setPrototypeOf
  29 construct   24 defineProperty     13 getOwnPropertyDescriptor
  26 has         21 getOwnPropertyDescriptor    13 ownKeys
  19 get         19 getPrototypeOf     12 defineProperty
  18 revocable   17 deleteProperty     11 deleteProperty   11 get
  17 setPrototypeOf  14 apply          10 has              10 construct
  12 isExtensible    12 preventExtensions   10 preventExtensions
                                       10 getPrototypeOf    9 apply
```

The compiler does have a Proxy escape hatch (`__proxy_create` host
import, `src/codegen/expressions/new-super.ts:1539`) and Reflect.*
compile-time rewrites to equivalent operations
(`calls.ts:3125-3300`). The failures fall into four buckets:

### 1. Reflect → operation rewrites lose spec hooks

Tests like `Reflect/set/return-abrupt-from-result.js`,
`Reflect/get/return-abrupt-from-result.js`,
`Reflect/defineProperty/return-abrupt-from-attributes.js` assert that
`Reflect.set(target, prop, val, receiver)` calls the **target's
`[[Set]]` internal method**, returning `true`/`false` to signal
success without throwing. Our compile-time rewrite to `target[prop] = val`
throws or coerces silently, losing the boolean result.

Examples:
- `Reflect.set(target, "p", v)` should return `false` if `target` is
  frozen — currently silently succeeds.
- `Reflect.has(target, prop)` should consult `[[HasProperty]]` — we
  rewrite to `prop in target` which works for plain objects but not
  for Proxies (the rewrite happens at compile time, before the value's
  proxy-ness is known).

### 2. Proxy trap invariants

Tests assert spec invariants per trap:
- `Proxy/ownKeys` — result must include all non-configurable keys of
  target;
- `Proxy/set` — TypeError if trap returns true but target has
  non-writable property with different value;
- `Proxy/has` — TypeError if trap returns false on non-configurable
  own property;
- `Proxy/construct` — result must be Object;
- `Proxy/getOwnPropertyDescriptor` — invariants on non-configurable
  reports.

Our `__proxy_create` is a thin wrapper around the host's `new Proxy`,
so the host enforces these invariants — but only when **the operation
flows through the host's MOP**. Many tests call traps via Reflect, and
the Reflect rewrite (above) bypasses the proxy entirely.

### 3. Proxy with externref handler functions

Tests pass arrow / classic functions as trap handlers. The compiler's
externref bridge handles host-callable functions but loses `this`
binding for traps like `get(target, prop, receiver)` — `receiver`
should be the proxy itself; currently it's `undefined`.

### 4. `Proxy.revocable`

18 failures — the revocable proxy is returned but the `revoke` function
fails to invalidate trap dispatch (host import returns the proxy and
revoke as separate refs; revoke call should set internal `[[ProxyHandler]]`
to null; subsequent operations on the proxy throw TypeError).

### 5. Symbol-keyed traps

A few tests use `Symbol(…)`-keyed property access (`proxy[sym]`) which
hits a different externref path that drops trap dispatch.

## Failure count

464. Realistic target: **~260**. The remaining failures depend on full
descriptor fidelity (#1460/#1462), the bound-function exotic (#1463),
and a few platform tests that probe Realm boundaries.

## Root cause

1. **`src/codegen/expressions/calls.ts:3125-3300`** rewrites
   `Reflect.X(target, …)` to direct operations. The rewrite is sound
   for plain objects but loses fidelity when `target` is a Proxy. We
   need either:
   - a runtime guard (`if target is a Proxy, call host Reflect.X`); or
   - drop the compile-time rewrite for Reflect's "operation as
     function" forms and dispatch via a `__reflect_X` host import
     that calls the host's `Reflect.X` directly.

2. **`src/codegen/expressions/new-super.ts:1536-1610`** —
   `__proxy_create` host import treats the handler as opaque. It is
   currently correct, but `Proxy.revocable` returns `{proxy, revoke}`
   and `revoke()` does not propagate back into Wasm-side caches; once
   revoked, code paths that cached the underlying ref still operate on
   the (revoked) proxy without throwing.

3. **`receiver`** parameter passed to `get`/`set` traps is the host's
   internal `Receiver` argument; our externref bridge does not set it
   to the Proxy when the access originates from `proxy.prop`. Need to
   confirm via `src/codegen/property-access.ts:1121` / 1460 (where
   `Proxy` is listed as a known builtin).

4. **Symbol-keyed accesses** route through `__extern_get_sym` /
   `__extern_set_sym` which forward to the host but don't bind to
   the proxy's MOP — re-route through the same path as string-keyed.

## Acceptance criteria

1. `Reflect.X` (set, get, has, deleteProperty, defineProperty,
   ownKeys, getOwnPropertyDescriptor, getPrototypeOf, setPrototypeOf,
   apply, construct, isExtensible, preventExtensions) dispatches via
   a host import (`__reflect_X` family) so that Proxy targets see
   their traps fire and the boolean return is preserved.
2. `Proxy.revocable` returns a `{proxy, revoke}` pair where
   `revoke()` makes subsequent operations on the proxy throw
   TypeError, even on cached references.
3. `get` / `set` traps receive `receiver` = the proxy when access
   originates from `proxy.prop`.
4. Symbol-keyed proxy access invokes the host's MOP (so traps fire).
5. `Reflect.construct(C, args, newTarget)` honours the `newTarget`
   parameter (so `new.target` inside the constructor matches).
6. `Reflect.apply(fn, thisArg, argList)` accepts an array-like
   `argList` (CreateListFromArrayLike) — overlaps with #1463 (5).
7. ≥220 of the 464 failures resolved.
8. Tests: `tests/issue-1466.test.ts` covers each acceptance bullet
   (Reflect dispatch through Proxy, revocable, receiver binding,
   Symbol-keyed traps, newTarget propagation).

## Files to inspect

- `src/codegen/expressions/calls.ts` 3125–3300 (Reflect rewrites)
- `src/codegen/expressions/new-super.ts` 1536–1610 (`new Proxy`)
- `src/codegen/property-access.ts` 1100–1500 (Proxy / Reflect known
  builtins; Symbol-keyed access)
- `src/runtime.ts` — add `__reflect_*` host imports and
  `__proxy_revoke` invalidation handling
- `tests/issue-1466.test.ts`

## Notes

- #965 introduced `Proxy.revocable` and the `__proxy_create` host
  bridge; this issue closes the long tail.
- Counts above include some descriptor / bound-function tests that
  resolve via #1460/#1462/#1463 — the 220 target is net of those.
