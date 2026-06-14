---
id: 1466
title: "spec gap: Proxy + Reflect trap / operation fidelity"
status: done
completed: 2026-06-12
created: 2026-05-20
updated: 2026-05-20
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: proxy-reflect
goal: spec-completeness
sprint: 52
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

---

## Implementation Plan

### Feasibility assessment (AOT vs runtime)

Proxy is a fundamentally dynamic feature: the [[Get]], [[Set]], [[HasProperty]],
[[OwnPropertyKeys]], [[DefineOwnProperty]], [[Delete]], [[GetPrototypeOf]],
[[SetPrototypeOf]], [[IsExtensible]], [[PreventExtensions]], [[Call]],
[[Construct]] internal methods *must* be dispatched dynamically through the
handler. There is no static program transform that recovers full Proxy
semantics, because:

* whether a given operand is a Proxy is generally not known until run time;
* the handler can be mutated between operations (it's an ordinary object);
* the invariants that the spec enforces (e.g. non-configurable consistency,
  trap return-value coercion, recursive trap calls) are runtime checks.

For an AOT WasmGC compiler with a JS host available, the only realistic path
is to **delegate to the host's MOP** through `externref` host imports. We
already do this for `new Proxy(target, handler)` via `__proxy_create` (which
calls `new Proxy(t, h)` on the host). The bug is that **every other
operation that should consult the Proxy bypasses it**, either because:

1. **Reflect.X is rewritten at compile time** to the equivalent operation on
   plain objects (`calls.ts:3125-3328`), losing the MOP entry point.
2. **`proxy.p` element/property access falls through to `__extern_get`** in
   the runtime, which calls `_safeGet`. JS-side, `_safeGet` does access
   `obj[key]` which *does* fire the proxy trap — but only when the proxy
   reference itself reaches `_safeGet` intact. The receiver argument is
   never set, and Symbol-keyed paths take a different branch that bypasses
   the proxy.
3. **`Proxy.revocable`** wraps the host's `Proxy.revocable`, but our runtime
   sometimes caches the *target* ref (e.g. `_wrapForHost`) and later
   operations on the cache silently bypass the revoke check.

**Feasibility split:**

| Surface | AOT-compilable | Needs runtime/host | Notes |
|---|---|---|---|
| `new Proxy(t, h)` construction | partially (calls host) | host | already done (#965) |
| Proxy `[[Get]]`/`[[Set]]`/`[[Has]]`/`[[Delete]]` | no | host | go through `__extern_*` already; just need to preserve proxy identity |
| Proxy `[[OwnPropertyKeys]]`, `[[GetOwnPropertyDescriptor]]`, `[[DefineOwnProperty]]`, `[[GetPrototypeOf]]`, `[[SetPrototypeOf]]`, `[[IsExtensible]]`, `[[PreventExtensions]]` | no | host | need `__reflect_*` family |
| Proxy `[[Call]]` / `[[Construct]]` | no | host | externref bridge already invokes — must thread `newTarget` |
| `Proxy.revocable` revoke semantics | no | host | host already enforces; runtime cache must not bypass |
| `Reflect.X(target, …)` static-rewrite | YES for plain-object case | host fallback for unknown receiver | dual path: rewrite when receiver is *provably* not a Proxy; otherwise dispatch via `__reflect_X` |
| Reflect MOP invariants (boolean returns, abrupt completions) | no | host | inherited from host `Reflect.X` |

**Compile-away strategy**: keep the existing compile-time rewrites as a
**fast path** for receivers whose static type is a known non-Proxy
WasmGC struct or `void`-typed builtin. For all other receivers (including
all `externref` arguments — which is most test262 code), dispatch through a
`__reflect_X` host import. This preserves performance on monomorphic
compiler-controlled code while gaining MOP fidelity for `externref`.

### Priority order (by test262 impact)

Implement in this order — each delivers the largest share of the 464 failures
with the smallest source change:

1. **`Reflect.set` / `Reflect.get` / `Reflect.has` / `Reflect.deleteProperty`
   → host dispatch** (~119 failures, all four buckets combined). This is one
   PR: replace the four AST rewrites in `calls.ts:3130-3171,3278-3288` with
   `__reflect_get` / `__reflect_set` / `__reflect_has` / `__reflect_delete`
   host imports. The host implementation is one line each:
   `Reflect.get(t, p, r)`, `Reflect.set(t, p, v, r)`, …
2. **`Reflect.defineProperty` / `Reflect.getOwnPropertyDescriptor` /
   `Reflect.getPrototypeOf` / `Reflect.setPrototypeOf` / `Reflect.ownKeys` /
   `Reflect.isExtensible` / `Reflect.preventExtensions`** (~120 failures).
   Same pattern, seven more host imports.
3. **`Reflect.apply` / `Reflect.construct`** (~24 failures). `apply` is a
   one-line host import. `construct` needs the `newTarget` parameter
   threaded — currently the AST rewrite drops it on the floor
   (`calls.ts:3190-3205`).
4. **Proxy `get`/`set` receiver binding** (~45 failures across Proxy/get,
   Proxy/set). Verify `_safeGet`/`_safeSet` pass the proxy as the receiver
   when called via `__extern_get` originating from `proxy.prop`. May
   require a new `__extern_get_with_receiver(obj, key, receiver)` import,
   or proving the existing path is fine and the failure is a Reflect-rewrite
   side effect.
5. **`Proxy.revocable` revoke invalidation** (18 failures). The host
   `Proxy.revocable` already returns `{proxy, revoke}` and the host
   enforces revocation — but we need to **return both refs from the
   `__proxy_revocable` import as an object the compiled code can
   destructure**. Today the host returns the raw `{proxy, revoke}` and
   compiled `const {proxy, revoke} = Proxy.revocable(...)` should already
   work via `__extern_get`. Confirm via a probe in `.tmp/`.
6. **Symbol-keyed proxy access** (handful). Route through the same
   `__extern_get`/`__extern_set` path as string keys when the property
   key has type `symbol`.

### Files to change

#### 1. `src/runtime.ts` — add host imports

Add 13 new host imports in the `case "reflect_X":` block of `buildImports`
(or the inline `name === "..."` block around line 2259 / 3490 — whichever
matches the surrounding style; the existing `__proxy_revocable` (line 3516)
and the `proxy_create` import-manifest case (line 4679) show both
patterns). Each is a thin wrapper:

```typescript
if (name === "__reflect_get")
  return (target: any, key: any, receiver: any): any =>
    Reflect.get(target, key, receiver === undefined ? target : receiver);

if (name === "__reflect_set")
  return (target: any, key: any, value: any, receiver: any): number =>
    Reflect.set(target, key, value, receiver === undefined ? target : receiver) ? 1 : 0;

if (name === "__reflect_has")
  return (target: any, key: any): number =>
    Reflect.has(target, key) ? 1 : 0;

if (name === "__reflect_deleteProperty")
  return (target: any, key: any): number =>
    Reflect.deleteProperty(target, key) ? 1 : 0;

if (name === "__reflect_defineProperty")
  return (target: any, key: any, desc: any): number =>
    Reflect.defineProperty(target, key, desc) ? 1 : 0;

if (name === "__reflect_getOwnPropertyDescriptor")
  return (target: any, key: any): any =>
    Reflect.getOwnPropertyDescriptor(target, key);

if (name === "__reflect_getPrototypeOf")
  return (target: any): any => Reflect.getPrototypeOf(target);

if (name === "__reflect_setPrototypeOf")
  return (target: any, proto: any): number =>
    Reflect.setPrototypeOf(target, proto) ? 1 : 0;

if (name === "__reflect_ownKeys")
  return (target: any): any[] => Reflect.ownKeys(target);

if (name === "__reflect_isExtensible")
  return (target: any): number => Reflect.isExtensible(target) ? 1 : 0;

if (name === "__reflect_preventExtensions")
  return (target: any): number => Reflect.preventExtensions(target) ? 1 : 0;

if (name === "__reflect_apply")
  return (fn: any, thisArg: any, argList: any): any =>
    Reflect.apply(fn, thisArg, argList);

if (name === "__reflect_construct")
  return (ctor: any, args: any, newTarget: any): any =>
    newTarget === undefined
      ? Reflect.construct(ctor, args)
      : Reflect.construct(ctor, args, newTarget);
```

Each handler **must coerce WasmGC structs that flow in as `target` or
`receiver`** via `_wrapForHost(target, callbackState?.getExports())`
(same pattern as `__object_assign` at line 3486-3505). Otherwise the host
`Reflect.X` cannot enumerate properties on opaque structs.

Standalone (no-JS) fallback: in the `case "reflect_set":` etc. branches
of `buildStandaloneImports` (or wherever the standalone runtime lives —
search for the `proxy_create` case at runtime.ts:4679 for the parallel
structure), provide non-host implementations that perform the equivalent
operation on plain objects without proxy dispatch (matches today's
compile-time rewrite behaviour).

#### 2. `src/compiler/import-manifest.ts` — register the imports

Mirror the `__proxy_create` entry at line 93. Add for each `__reflect_*`:

```typescript
if (name === "__reflect_get") return { type: "reflect_get" };
// … and so on for all 13 names
```

(or use a single `type: "reflect_op"` plus the name string if the
manifest supports it — follow whichever pattern is already in use for
`__object_*` imports.)

#### 3. `src/codegen/expressions/calls.ts:3125-3328` — switch Reflect to host dispatch

Replace **each** of the 13 in-place rewrites with a host-import call.
Template (using `Reflect.set` as the worked example):

```typescript
if (reflectMethod === "set" && expr.arguments.length >= 2) {
  // Compile target, key, value, [receiver] all as externref
  const tgtTy = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
  if (tgtTy && tgtTy.kind !== "externref") coerceType(ctx, fctx, tgtTy, { kind: "externref" });
  const keyTy = compileExpression(ctx, fctx, expr.arguments[1]!, { kind: "externref" });
  if (keyTy && keyTy.kind !== "externref") coerceType(ctx, fctx, keyTy, { kind: "externref" });
  if (expr.arguments.length >= 3) {
    const valTy = compileExpression(ctx, fctx, expr.arguments[2]!, { kind: "externref" });
    if (valTy && valTy.kind !== "externref") coerceType(ctx, fctx, valTy, { kind: "externref" });
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }
  if (expr.arguments.length >= 4) {
    const recTy = compileExpression(ctx, fctx, expr.arguments[3]!, { kind: "externref" });
    if (recTy && recTy.kind !== "externref") coerceType(ctx, fctx, recTy, { kind: "externref" });
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }
  const funcIdx = ensureLateImport(
    ctx,
    "__reflect_set",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [{ kind: "i32" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (funcIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx });
    return { kind: "i32" };
  }
  // Fallback for missing import: drop args, push 1
  for (let i = 0; i < 4; i++) fctx.body.push({ op: "drop" });
  fctx.body.push({ op: "i32.const", value: 1 });
  return { kind: "i32" };
}
```

Apply the same shape to all 13. Notes per method:

* `Reflect.get`: returns `externref`. 2-3 args (target, key, [receiver]).
* `Reflect.has`, `Reflect.deleteProperty`, `Reflect.defineProperty`,
  `Reflect.setPrototypeOf`, `Reflect.isExtensible`, `Reflect.preventExtensions`,
  `Reflect.set`: return `{ kind: "i32" }` (the boolean).
* `Reflect.getOwnPropertyDescriptor`, `Reflect.getPrototypeOf`,
  `Reflect.ownKeys`, `Reflect.apply`, `Reflect.construct`: return `externref`.
* `Reflect.apply`: 3 args (fn, thisArg, argList). `argList` may be an
  array-like — host's `Reflect.apply` handles `CreateListFromArrayLike`.
  Drop the AST-rewrite to `fn.apply(...)`.
* `Reflect.construct`: 2-3 args. Third arg `newTarget` defaults to
  `target` per spec when omitted. Pass `ref.null.extern` for omitted
  and let the host-side wrapper substitute `target`.

**Important**: the existing `Reflect.isExtensible` / `Reflect.preventExtensions`
also feed `ctx.nonExtensibleVars` (line 3296, 3307) — preserve that side
effect for plain identifiers so subsequent compile-time `Object.isFrozen`
queries on the same variable name still see the marking.

Delete the synthetic-AST `createElementAccessExpression`,
`createBinaryExpression`, `createDeleteExpression`,
`createNewExpression` helpers used in these blocks.

#### 4. `src/codegen/expressions/new-super.ts:1536-1584` — `Proxy.revocable` & receiver binding

The `new Proxy(target, handler)` path is already correct. No change needed
here for `new Proxy` itself.

For `Proxy.revocable` (currently at `calls.ts:3046-3072`) — verify by
probe in `.tmp/` whether destructuring works today:

```typescript
const { proxy, revoke } = Proxy.revocable({a: 1}, {get: () => 42});
console.log(proxy.a);     // → 42
revoke();
console.log(proxy.a);     // → TypeError
```

If destructure-via-`__extern_get` works, no codegen change needed for
revocable. If not, add a `__proxy_revocable_pair` import that returns the
proxy and revoke as two separate externrefs and the compiler builds a
2-field WasmGC struct.

#### 5. `src/codegen/property-access.ts` — Symbol-keyed proxy access

Search for the `_safeGet` / Symbol branch (around line 470 — the
"Sidecar property" comment). Confirm Symbol-keyed access on an
`externref` operand routes through `__extern_get` (which calls
`_safeGet(obj, sym)` — `obj[sym]` fires the proxy trap). The bug
report mentions `__extern_get_sym` / `__extern_set_sym` — grep
confirms these names don't exist in `runtime.ts`. The symbol path
likely already works for proxies; the failures may be a downstream
consequence of the Reflect rewrite. Re-measure after step 1-3 land
before adding new symbol-keyed plumbing.

#### 6. `src/runtime.ts` — receiver binding for `proxy.prop`

`_safeGet(obj, key)` does `obj[key]` which fires the trap with
`receiver = obj` (the proxy). This is correct for `proxy.prop` access.
The bug is only that **`Reflect.get(proxy, key)` with no explicit
receiver** must pass `receiver = proxy`, which the host import wrapper
above handles (`receiver === undefined ? target : receiver`).

### WasmGC representation for Proxy objects

We do **not** represent Proxy as a Wasm struct. The host owns the proxy
state; from the Wasm side a Proxy is opaque `externref`. The compiler
**must not** attempt to `ref.cast` an externref to any concrete WasmGC
struct type (would trap with `illegal_cast`). All operations on
Proxies are routed through host imports.

Concretely:

* `new Proxy(t, h)` → `externref` returned from `__proxy_create`.
* `Proxy.revocable(t, h)` → `externref` (a JS object with `.proxy` and
  `.revoke` own properties). Destructuring via `__extern_get` already
  works.
* `revoke()` → call externref as function via the existing
  externref-callable bridge.
* Any operation on the proxy → routed via `__reflect_*` (preferred when
  invoked through `Reflect.X`) or `__extern_get/set/has/delete` (for
  direct `proxy.p` syntax).

No new WasmGC type definitions are required for this issue.

### Reflect method classification

| Method | Today | Plan | Pure host wrapper? |
|---|---|---|---|
| `Reflect.get` | AST rewrite to `obj[key]` | `__reflect_get` | YES |
| `Reflect.set` | AST rewrite, returns const `1` | `__reflect_set` | YES |
| `Reflect.has` | AST rewrite to `key in obj` | `__reflect_has` | YES |
| `Reflect.deleteProperty` | AST rewrite to `delete obj[key]` | `__reflect_deleteProperty` | YES |
| `Reflect.defineProperty` | AST rewrite to `Object.defineProperty` | `__reflect_defineProperty` | YES |
| `Reflect.getOwnPropertyDescriptor` | AST rewrite to `Object.getOwnPropertyDescriptor` | `__reflect_getOwnPropertyDescriptor` | YES (overlaps #1460/#1462 for descriptor shape) |
| `Reflect.getPrototypeOf` | AST rewrite to `Object.getPrototypeOf` | `__reflect_getPrototypeOf` | YES |
| `Reflect.setPrototypeOf` | AST rewrite, returns const `1` | `__reflect_setPrototypeOf` | YES |
| `Reflect.ownKeys` | AST rewrite to `Object.getOwnPropertyNames` (drops symbols) | `__reflect_ownKeys` | YES (includes Symbols, per spec) |
| `Reflect.isExtensible` | reads `ctx.nonExtensibleVars` | `__reflect_isExtensible` + keep var-tracking side effect for identifiers | YES |
| `Reflect.preventExtensions` | sets `ctx.nonExtensibleVars`, returns const `1` | `__reflect_preventExtensions` + keep var-tracking side effect | YES |
| `Reflect.apply` | AST rewrite to `fn.apply(thisArg, args)` | `__reflect_apply` | YES (host handles CreateListFromArrayLike) |
| `Reflect.construct` | AST rewrite to `new C(...args)`, drops `newTarget` | `__reflect_construct` | NO — host needs `newTarget` parameter to set `new.target` in constructor |

**All 13 are pure wrappers** modulo the construct/newTarget thread-through
and the descriptor-shape fidelity (which is #1460/#1462's territory).

### Wasm IR pattern (per call site)

For each Reflect.X call, the generated IR is:

```wasm
;; Reflect.set(target, "p", v, receiver)
local.get $target_or_compute    ;; externref
local.get $key_or_compute       ;; externref (string literal => string global)
local.get $val_or_compute       ;; externref
local.get $receiver_or_null     ;; externref (or ref.null.extern if omitted)
call $__reflect_set             ;; -> i32 (0 or 1)
```

If the call is used in a statement-expression position with a discarded
result (e.g. `Reflect.set(t, "p", 1);`), the surrounding driver will emit
`drop` automatically.

### Edge cases

1. **Reflect.X with non-object target** (e.g. `Reflect.get(null, "p")`)
   — host `Reflect.X` throws TypeError. We must let that propagate. The
   `__reflect_*` import call already participates in exception propagation
   via the JS-host-throw → wasm-trap bridge (same as every other
   externref-returning host call). No special handling required.
2. **Reflect.set with non-writable property on target** — host returns
   `false`; compiled code observes `i32.const 0`. Today's rewrite returns
   `1` unconditionally — this fix corrects the bug.
3. **Reflect.deleteProperty with non-configurable own property** — host
   returns `false`; today's `delete` operator may throw in strict mode,
   silently succeed in sloppy. Either way the boolean return is wrong.
4. **Reflect.construct with `newTarget` ≠ `target`** — host call sets
   `new.target` inside the constructor to `newTarget`. Our `new C(...)`
   rewrite sets `new.target = C`. Tests that read `new.target` inside
   the constructor will now pass.
5. **`Reflect.apply(fn, thisArg, {length: 2, 0: "a", 1: "b"})`** — host
   `Reflect.apply` performs `CreateListFromArrayLike` on the third arg.
   Our `fn.apply(thisArg, arrayLike)` rewrite relies on `Function.prototype.apply`
   to do the same — which it does, but only for array-likes the host
   recognises. Switching to host `Reflect.apply` is strictly more correct.
6. **`Reflect.set(obj, key, val, receiver)` with `receiver !== obj`** —
   host correctly delegates the `[[Set]]` to `receiver`. Today's rewrite
   ignores `receiver`. Important for proxy chains and accessor properties
   inherited from a prototype.
7. **`Reflect.isExtensible(plainObj)` after compile-time
   `Object.preventExtensions(plainObj)`** — host returns the runtime
   answer (`true` for a fresh object), but the compile-time
   `ctx.nonExtensibleVars` marking says `false`. **Resolution**: drop
   the compile-time `nonExtensibleVars` side effect entirely now that
   we dispatch to host — single source of truth wins. Audit other
   uses of `ctx.nonExtensibleVars` first; if used elsewhere, gate the
   change behind a flag.
8. **`Reflect.ownKeys(target)` must include Symbol-keyed own properties**
   — host `Reflect.ownKeys` does this; today's rewrite to
   `Object.getOwnPropertyNames` drops Symbols. Tests like
   `Reflect/ownKeys/return-on-corresponding-order-large-index.js` care.
9. **Late-import ordering**: each `__reflect_*` call uses
   `ensureLateImport` + `flushLateImportShifts(ctx, fctx)` — must be
   called *before* any other call instruction in the same surrounding
   expression sub-tree to avoid index-shift bugs (the pattern at
   `calls.ts:3057-3066` is the reference).
10. **Standalone mode (`--target wasi`)**: there is no host `Reflect`.
    The standalone fallback must implement the operation on plain
    WasmGC objects without trap dispatch (matches today's compile-time
    rewrite behaviour). For Proxy specifically, standalone mode falls
    back to pass-through (target returned as-is, as
    `new-super.ts:1538` notes). This is acceptable — standalone Proxy
    fidelity is not in scope for this issue.

### Test plan

Add `tests/issue-1466.test.ts` with one `describe` block per acceptance
bullet:

* `Reflect dispatch through Proxy`:
  - `Reflect.set(proxy, "p", 1)` calls the `set` trap and returns its
    boolean.
  - `Reflect.get(frozen, "p", receiver)` honours the receiver.
  - `Reflect.has(proxy, "p")` consults the `has` trap.
  - `Reflect.deleteProperty(frozen, "p") === false`.
* `Proxy.revocable`:
  - Pre-revoke: `proxy.p` returns the trap result.
  - Post-revoke: `proxy.p` throws TypeError.
  - Post-revoke: a previously-captured `proxy` variable also throws.
* `receiver binding`:
  - `proxy.foo` where `get(t,p,r){ return r === proxy; }` returns `true`.
* `Symbol-keyed traps`:
  - `proxy[Symbol.iterator]` fires the `get` trap with the symbol key.
* `newTarget propagation`:
  - `Reflect.construct(C, [], D)` sets `new.target = D` inside C.

Plus a smoke check against the four largest test262 buckets:

```bash
pnpm run test:262 -- --category=built-ins/Reflect/set \
                     --category=built-ins/Reflect/get \
                     --category=built-ins/Proxy/set \
                     --category=built-ins/Proxy/get
```

Expect ≥220 of the 464 failures to flip to PASS.

### Risks / sequencing

* **File conflict with #1460 / #1462** (descriptor fidelity). Both touch
  `Reflect.defineProperty` and `Reflect.getOwnPropertyDescriptor`. Order:
  this issue's host-dispatch change is small and additive — land it
  *first*, then #1460/#1462 refines the descriptor shape passed to/from
  the host.
* **File conflict with #1463** (bound-function exotic, `Reflect.apply`).
  Coordinate: land `__reflect_apply` here as the dispatch path; #1463
  refines what the host sees when `fn` is a bound function.
* **Performance regression risk**: replacing 13 compile-time rewrites
  with host imports adds an externref roundtrip per `Reflect.X` call.
  This is acceptable — `Reflect.X` is rarely on a hot path, and the
  current behaviour is *wrong*. Mitigation: keep an opt-in fast path
  when the receiver is statically known to be a plain WasmGC struct
  (`kind: "ref", typeIdx: ...`) — gate behind a `--fast-reflect`
  flag if a benchmark regresses. Defer until measured.
* **Standalone mode** (no JS host): the `__reflect_*` imports won't
  exist. Provide standalone implementations that emulate plain-object
  Reflect (no trap fidelity, matching today's behaviour). Document in
  `feature-examples.json` that `--target wasi` does not support
  Proxy/Reflect MOP fidelity.

### Out of scope

* True Proxy MOP without a JS host (standalone mode). Requires writing
  a Wasm-native MOP engine — a separate, much larger issue.
* Proxy of WasmGC structs with field-level trap dispatch (would require
  per-struct getter/setter externref wrappers — not pursued).
* Realm boundary tests (a few of the 464 failures probe cross-Realm
  semantics; the host's `Reflect` is single-Realm and we accept that).

