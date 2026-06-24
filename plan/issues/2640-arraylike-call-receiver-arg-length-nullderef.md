---
id: 2640
title: "Array.prototype.X.call(arrayLike, cb): callback's receiver-arg .length/[i] null-derefs (typed-vec param vs dynamic externref receiver)"
status: done
assignee: ttraenkler/sdev-bce
sprint: 65
created: 2026-06-24
completed: 2026-06-24
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: arrays, closures, array-like dispatch
goal: test262-conformance
related: [2580, 983d]
---

# #2640 — `Array.prototype.X.call(arrayLike, cb)` callback receiver-arg `.length`/`[i]` null-deref

## Problem (bisected, faithful `runTest262File`, host mode)

When a generic `Array.prototype.X.call(arrayLike, cb)` over a **dynamic
(non-vec) array-like receiver** invokes its callback, it passes the receiver
back as the callback's array argument (`cb`'s 3rd arg for `forEach`/`map`/…, 4th
for `reduce`/`reduceRight`). Inside the callback, reading `obj.length` or
`obj[i]` on that argument **dereferences a null pointer**:

```js
var got = -1;
Array.prototype.forEach.call({ 0: 5, 1: 6, length: 2 },
  function (v, i, obj) { got = obj.length; });   // → "dereferencing a null pointer in __closure_0"
```

Bisection (forEach native arm, cross-method): the callback's **value arg**
(1st) and **index arg** (2nd) read fine; only the **receiver/array arg** traps.
`obj` outside a callback (`o.length === 2`) reads correctly via the M2.1
`.length`-on-any reader — so the trap is specific to the receiver re-passed into
the closure.

### Root cause (from the emitted WAT)

The callback's array parameter is inferred by TypeScript as the array type
(`T[]`) from `Array.prototype.forEach`'s callback signature, so codegen lowers
it to a typed WasmGC vec ref:

```wat
(type $__fn_wrap_1_type (func (param (ref null 23) externref f64 (ref null 2))))
;;                                          v: extern  i: f64  obj: (ref null $__vec_base)
```

But the actual receiver passed by the dispatch loop is a **dynamic externref**
(an `extern.convert_any`-wrapped `$__anon_0` object-literal struct), which is
**not** a subtype of `$__vec_base`. So the call-site coercion (`externref` →
vec ref) `ref.test`s the receiver, fails, and pushes **`ref.null`** as the
`obj` argument:

```wat
local.get 1            ;; receiver externref ($__anon_0-wrapped)
any.convert_extern
ref.test (ref 2)       ;; is it $__vec_base?  NO
(if (result (ref null 2)) (then …) (else ref.null 2))   ;; ← pushes NULL
```

Then inside the closure, `obj.length` lowers to `struct.get $__vec_base 0` on
**null** → trap. (For an inline arrow whose `obj` param happens to stay
`externref`, the read instead routes through the M2.1 dynamic reader and is
correct — which is why the bug only surfaces when TS gives the param a concrete
vec type, e.g. inside the test262 wrapper's full-signature context.)

## Fix (gated, value-rep-safe)

`compileArrayLikePrototypeCall` is entered **only** for a non-vec array-like
receiver — real `__vec_`/`__arr_` receivers bail out upstream (lines ~700-712).
So the typed `arr.forEach(cb)` hot path **never** enters this function. The fix
forces any callback parameter that TS inferred as a typed vec/array
(`__vec_*`/`__arr_*`/`$__vec_base`) to `externref` for the callback compiled on
this path, so `obj.length`/`obj[i]` lower through the tag-aware dynamic reader:

1. **`ctx.forceExternrefCallbackParams`** (`src/codegen/context/types.ts`) — a
   transient flag.
2. **`compileArrowAsClosure`** (`src/codegen/closures.ts`) — when the flag is
   set, widen any param whose resolved ValType `isVecOrArrayRefType` to
   `externref` (value=externref and index=f64 are untouched).
3. **`compileArrayLikePrototypeCall`** (`src/codegen/array-methods.ts` ~849) —
   set the flag around the callback compile, restore it after (nested closures
   outside this path keep their typed params). The dispatch loop already coerces
   the receiver `externref → paramTypes[N]`; with the param now `externref`
   that coercion is a no-op and the receiver is passed directly.

This is gated on the non-vec array-like path, so the byte image of any program
that does not dispatch a generic array-like `.call(cb)` is unchanged.

## Acceptance

- `Array.prototype.forEach.call({0:5,1:6,length:2}, (v,i,obj)=>got=obj.length)`
  → `got === 2` (no trap). Same for `obj[i]`, and across
  forEach/map/some/every/find/findIndex/filter/indexOf/lastIndexOf.
- ZERO regression on the typed `arr.forEach(cb)` / `arr.map(cb)` hot path
  (it never enters this code path) — verified `[1,2,3].map(x=>x*2)` = 12.
- Net-positive on the inline-callback array-like cluster, validated via the
  full merge_group gate (value-rep / call-path touch → full-gate, not a scoped
  sweep, per `project_broad_impact_validate_full_ci`).

## Measured impact (local faithful `runTest262File` vs committed baseline)

Scan of 217 inline-callback array-like `.call` tests under
`built-ins/Array/prototype/*`: **+64 gains (baseline≠pass → pass), 0 losses**
(no baseline-pass row regressed). Typed-array / normal-HOF controls unchanged.

## Out of scope (separate follow-ups, NOT this slice)

- **Named `function callbackfn(...)` + `reduce` boolean accumulator** — the
  chartered corpus target `reduce/15.4.4.21-2-1` (a *named* fn whose body returns
  a boolean `obj.length === 2`) fails for a DIFFERENT reason: the reduce arm
  boxes an i32-boolean callback result via `f64.convert_i32_s` + `__box_number`
  → a *number* accumulator, losing boolean identity (`typeof result` becomes
  `"number"`, and the harness sees `2`). That needs the closure's TS boolean
  return type carried in `ClosureInfo` + a boolean boxing path — a closure-
  metadata change, not the receiver-arg fix. Tracked for a follow-up.
- **`.call(primitive)` reading inherited `Boolean.prototype`/`Number.prototype`
  indices** (`map/15.4.4.19-1-3`, `forEach/15.4.4.18-1-5`) — primitive
  ToObject + prototype-chain inherited read = the #2580 M3 `[[Prototype]]`-link
  substrate (deferred / architect-spec'd).

## Files changed

- `src/codegen/context/types.ts` — `forceExternrefCallbackParams` flag
- `src/codegen/closures.ts` — `isVecOrArrayRefType` + gated param widening
- `src/codegen/array-methods.ts` — set/restore the flag around the callback compile
- `tests/issue-2640-arraylike-call-receiver-arg.test.ts` — regression suite
