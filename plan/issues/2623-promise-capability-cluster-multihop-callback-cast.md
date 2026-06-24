---
id: 2623
title: "Promise capability-cluster: multi-hop host→wasm resolve-element callback cast + ctx-ctor species/prototype identity through the bridge"
status: in-progress
assignee: ttraenkler/sendev-promise-subclass
created: 2026-06-22
priority: medium
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen, promise, async, capability-bridge
language_feature: promise, async, proxy
goal: async-model
sprint: Backlog
parent: 1528
related: [2614, 2618, 1373b, 1042, 86, 56]
note: "Spun off from #86 (class-ctor arm, merged) + #55 async-bucket scope (PR #1947). The #56/#1940 closure-construct bridge + #86 executor-call host-routing landed the SURFACE of the capability lane; this issue is the DEEPER shared substrate behind three clusters that the surface fixes did NOT close."
---
# #2623 — Promise capability-cluster: multi-hop host→wasm callback cast + species identity

## Why this exists (one substrate, three clusters)

#56/#1940 (closure-as-dynamic-ctor bridge) and #86/#1945 (capability-ctor
`executor(...)` host-routing) both LANDED. They closed the *surface* of the
capability lane. But a single deeper substrate gap remains, and it is shared by
**three** distinct test262 clusters — fixing it once should bank all three:

1. **#2614 Promise combinator headline rows** —
   `allSettled/call-resolve-element.js`, `race/resolve-from-same-thenable.js`:
   `illegal cast in Constructor()`. The user `Constructor` passes its INNER
   `resolve` (a wasm closure that closes over outer state) to the host
   `executor`; when the host thenable later calls `resolve(value)` BACK, the
   host→wasm callback of that **capturing** closure casts/null-derefs. (#86's
   arm routes the OUTBOUND `executor(...)` call; this is the INBOUND callback.)
2. **#86 capturing-inner-resolve residual** — proven in #86: a NON-capturing
   inner `resolve` works through the arm, a CAPTURING one (`function resolve(){
   calls++; }`) fails the same way. Same root.
3. **await-thenable bucket (#55 scope, PR #1947, ~21 rows)** —
   `await <custom thenable {then(res){res(42)}}>` → `dereferencing a null
   pointer in __closure_N`. `await V` lowers to `Promise_resolve(V)` +
   `Promise_then2(p, __make_callback(continuation))`; for a custom thenable,
   V8's `p.then(resolve,reject)` calls the wasm continuation back as a host→wasm
   callback — the SAME inbound-callback cast/null-deref.

Common shape: **a wasm closure / continuation is handed to host code (a user
`executor`, a custom thenable's `.then`, or V8's NewPromiseCapability) and later
INVOKED BACK by the host**, and that inbound call casts the wasm-closure-struct
arg or null-derefs its captured environment.

## Scope

1. **Inbound host→wasm callback marshalling** — when a wasm closure flows OUT to
   host code (as a `.then`/executor arg, a capability resolve/reject element
   function, an await continuation) and the host calls it back, the inbound call
   must recover the closure struct + its captured environment correctly (no
   unconditional `ref.cast` to a closure struct that fails on the marshalled
   host wrapper; no null-deref of the captured env). The capturing-closure case
   is the hard part — a non-capturing closure has no env to lose.
2. **ctx-ctor species / prototype identity** — `all/allSettled/race/any
   ctx-ctor.js`: `instance.constructor === SubPromise` requires the capability's
   `.constructor`/prototype identity to survive `_wrapCallableForHost`
   (a `.prototype`/species concern on the construct-trap wrapper).
3. **Observable-resolve coupling** (#2614 invoke-resolve all/race) — the
   sandbox-`Promise.resolve` identity fix proven net-negative ALONE in #2614
   (it regressed `any/invoke-resolve` pre-#1940); re-test it composed on top of
   the inbound-callback fix here (the regression was the cross-realm construct,
   which #1940 + this should make legal).

## Gating / discipline

- Bounded-vs-epic TBD: the inbound-callback marshalling touches the hot
  closure-call + host-glue path. Likely needs an architect spec first.
- Broad-impact → validate via merge_group, never a scoped sweep (the #1940/#2615
  eject pattern: PR-level passes, the floor catches the regression).
- Keep any gate SYNTACTIC / narrow to avoid the #1941 host-import LinkError into
  pure-closure programs.

## Expected payoff

#2614 headline rows (call-resolve-element, resolve-from-same-thenable, ctx-ctor,
invoke-resolve) + #86 capturing-inner-resolve residual + await-thenable (~21) +
unblocks #2618 (Proxy apply/construct shares the `__fn_tramp_Constructor`
dispatch). Routed to the #2614/#1528 capability-cluster lane, next-sprint.

---

## Implementation Plan (architect, 2026-06-22 — re-grounded against current main)

### Bounded-vs-epic verdict: **BOUNDED** (3 narrow runtime/codegen slices), NOT epic

The "epic" framing in the parent note was a hedge before the substrate was
pinned. Faithful `runTest262File` re-measure on current main + direct compile
probes show **three distinct, separable, narrow root causes** — each
independently floor-validatable — not one tangled rewrite. Two of them are
**pure `src/runtime.ts`** changes (no codegen ABI churn), and the third
(#2618) is the externref-callee call/construct routing already 90% specced in
the #2618 issue file. None requires a new ABI, a value-rep change, or touching
the `__call_fn_N` dispatcher's funcref-dispatch loop.

### Re-grounding evidence (current main, faithful runner + compile probes)

| Probe | Result on main | What it tells us |
|---|---|---|
| `new this({},input).getLen()` **chained IN-WASM** (acorn `parse()` shape) | **returns 5 ✓** | #2628's headline is ALREADY FIXED in-wasm. The construct-trap `self` IS registered as a fnctor instance (`[protoHook]` fires for `parse` AND `getLen`), so in-wasm `__extern_method_call` resolves the proto method. |
| `Parser.makeViaThis(input)` returned to **host JS**, then `.getLen()` from JS | **THROWS "getLen is not a function"** | The bridge result handed back to the JS harness is a plain `Object` (`constructor.name === "Object"`), NOT a Parser instance — host-side proto dispatch misses. This is the *residual* #2628 gap, but acorn's `parse()` chain is entirely in-wasm so it does NOT block the dogfood lap. |
| `allSettled/call-resolve-element.js` | `fail: illegal cast in Constructor()` | inbound host→wasm callback of a CAPTURING inner `resolve` closure — the user `function Constructor(executor){…}` body casts. **Slice 2614-A.** |
| `race/resolve-from-same-thenable.js` | `fail: illegal cast in Constructor()` | same root as above. |
| `all/invoke-resolve.js` | `fail: returned 2 \| assert #1` | element-identity break (the array round-trip); sd proved the observable-resolve fix net-NEGATIVE alone (regresses `any/invoke-resolve`). **Couples to 2614-A** — deferred to compose ON TOP of the inbound-callback fix. |
| `all/ctx-ctor.js` | `fail: instance.constructor !== SubPromise` | species/prototype identity through the capability bridge. **Slice 2614-B.** |
| `Proxy/apply/call-result.js` | `fail: illegal cast in __call_fn_method_3()` | externref-Proxy callee mis-routed to the `ref.cast $Closure` fast path. **Slice 2618-apply.** |
| `Proxy/construct/call-result.js` | `fail: … is not a constructor` | externref-Proxy constructor + dropped construct-trap result. **Slice 2618-construct.** |

### Root cause (one substrate, two mechanisms)

**Mechanism (a) — inbound host→wasm callback of a CAPTURING closure.**
When a wasm closure flows OUT to host code (the user `executor`'s inner
`resolve`, a custom thenable's `.then` continuation, an await continuation) and
the host invokes it BACK, the host either (i) holds the **JS wrapper Function**
produced by `_wrapWasmClosureUnknownArity` / `_wrapCallableForHost`, or (ii)
re-passes the value through a path that lost the raw struct. The inbound entry
`__call_fn_N` / `__call_fn_method_N`
(`emitClosureCallExportN`, `src/codegen/index.ts:3218`) does
`local.get 0 → any.convert_extern → ref.test/ref.cast` against the closure base
wrapper (`index.ts:3322-3324` + the per-entry funcref dispatch). **It never
unwraps a host wrapper back to the raw struct first** — so when the inbound
value is the wrapper Function (not the struct), `ref.test` misses every arm and
the dispatch either falls to `ref.null.extern` (→ caller null-deref of the
captured env) or a downstream `ref.cast` traps (`illegal cast in Constructor()`).
A NON-capturing inner resolve survives because it has no captured env to lose
and its wrapper round-trips trivially; a CAPTURING one
(`function resolve(){ calls++; }`) is the failing case (the #86 residual). The
bidirectional map already exists — `_wasmClosureWrapperTargets`
(Function→struct, `runtime.ts:1750`) and `_unwrapForHost`/`_hostProxyReverse`
(`runtime.ts:4092`) — it is simply **not consulted on the inbound `__call_fn_*`
arg path**.

**Mechanism (b) — `__construct_closure` result identity + species.**
`__construct_closure` (`runtime.ts:9389`) returns
`Reflect.construct(_wrapCallableForHost(callee), args)`. The callable wrapper's
`construct` trap (`runtime.ts:4904-4918`) builds a fresh **plain JS `self = {}`**,
runs the body on it, and returns `self`. So the result (1) is NOT linked to the
constructor closure via `_fnctorInstanceCtor` for HOST-side proto dispatch, and
(2) carries no `.constructor`/`.prototype` species identity
(`instance.constructor === SubPromise` fails — `ctx-ctor`). In-wasm dispatch
works because the `self` does get registered for the in-wasm read path (proven
by the `[protoHook]` trace), but the host-facing identity is lost.

### Slice plan (each independently floor-validatable; broad-impact → merge_group)

The slices are ordered so the keystone (2614-A inbound marshalling) lands first;
everything else composes on top. Each slice is its own PR with its own
merge_group floor validation (per `project_broad_impact_validate_full_ci` — the
inbound-callback path is a hot closure-call site; a scoped sweep WILL hide
regressions, exactly the #1940/#2615 eject pattern).

---

**Slice 2623-A — inbound capturing-closure marshalling (KEYSTONE).**
*Flips:* `allSettled/call-resolve-element`, `race/resolve-from-same-thenable`,
the #86 capturing-inner-resolve residual, and the await-thenable bucket (~21:
`await <custom thenable {then(res){res(42)}}>` → `__closure_N` null-deref).

**File: `src/runtime.ts`** — the OUTBOUND wrap side is where the raw struct is
still in hand; ensure every closure that flows to host as a callback argument is
wrapped through `_wrapWasmClosureUnknownArity` (which already records
`_wasmClosureWrapperTargets[wrapper] = struct` at `runtime.ts:1916`) so the
reverse map is always populated. Audit the executor-call host-routing arm (the
#86 arm) and the `.then`/thenable assimilation path (#2613) to confirm the inner
`resolve`/`reject`/continuation closures are wrapped via this helper (not handed
to the host as raw structs or via a path that skips the target-map write).

**File: `src/codegen/index.ts`** — `emitClosureCallExportN` (line 3218), the
inbound dispatcher. After `local.get 0` / `any.convert_extern` (line 3322-3324)
the value is tested against the closure base wrapper. **Problem:** when the host
calls back with the JS wrapper Function, the externref arriving at slot 0 is the
wrapper, not the struct. The fix is host-side, not wasm-side: the wrapper
Function's own body (`wasmClosureDynamicBridge`, `runtime.ts:1880`) ALREADY
forwards to `exports.__call_fn_method_${arity}(rawThis, closure, …)` with the
**raw `closure` struct** captured in its lexical scope — so when the host calls
the wrapper, the raw struct is recovered. The failing case is when the host
passes the wrapper as an **argument** to ANOTHER wasm closure (the executor
receives `resolve` as a param), and that inner closure is later dispatched with
the wrapper-as-externref-arg. **Fix locus:** in `emitClosureCallExportN`'s
`buildArgConversion` (line 3331), for an `externref`/`anyref` closure-call
**argument** that is itself a wasm-closure wrapper, the arg must be unwrapped to
the raw struct before it feeds the inner `call_ref`. The host already exposes
the reverse map; add a runtime helper `__unwrap_closure(externref) → externref`
(returns `_wasmClosureWrapperTargets.get(v) ?? _unwrapForHost(v) ?? v`) and call
it in `buildArgConversion` when the param is a reference kind that could hold a
marshalled closure. Gate SYNTACTICALLY narrow (only the closure-arg path, only
JS-host) to avoid the #1941 LinkError into pure-closure programs.

*Wasm IR pattern (argument unwrap in the dispatcher arm):*
```wasm
;; buildArgConversion for a reference-kind closure-call arg
local.get $argN              ;; externref (possibly a wrapper Function)
call $__unwrap_closure       ;; → raw struct externref if it was a wrapper, else passthrough
any.convert_extern           ;; existing lowering continues
(ref.cast $closureParamType) ;; existing, when the param is a concrete ref
```
*Edge cases:* (1) arg is a real host function (not a wasm wrapper) → passthrough
unchanged. (2) arg is a non-closure struct → passthrough. (3) capturing vs
non-capturing — both go through the same unwrap; non-capturing was already
green, must stay green. (4) standalone — `__unwrap_closure` is JS-host-only; the
helper must dead-elim to nothing when no host imports (no LinkError).
*Validation:* the four named rows above + a `tests/issue-2623.test.ts` with a
capturing inner-resolve executor + a custom-thenable await. **merge_group floor
mandatory** — this is the closure-call hot path.

### Slice 2623-A facet 1 LANDED (sd-2623a, 2026-06-24) — guarded inbound arg cast

The narrowest, monotonically-safe facet of 2623-A: the inbound dispatchers
`__call_fn_N` / `__call_fn_method_N` (`emitClosureCallExportN`,
`src/codegen/index.ts`) lowered each host-supplied callback arg via
`buildArgConversion` → `externToClosureParamRef`, which for a **nullable
concrete-struct param** (`ref_null` → `(ref null $T)`, e.g. a callback param the
compiler typed `any[]` → a wasm vec struct) emitted an **unconditional
`ref.cast_null $T`**. That TRAPS with `illegal cast` when the host passes a value
that is not a `$T` — the dominant case being a real **host JS array** passed for
an `any[]` param (a Proxy `apply`/`construct` trap's `args`; #2618).

**Fix:** new `externToClosureParamRefGuarded` — `ref.test $T` first; on match
`ref.cast_null $T` exactly as before (byte-identical for every matching
callback — the hot path is unchanged), on mismatch a typed `ref.null $T` so
`call_ref` typechecks and the closure receives null instead of crashing. Only
for `ref_null` params (a non-null `ref` has no valid null fallback and its sole
inbound use — native-strings `string` → `(ref $AnyString)` — is always
host-satisfied, so it keeps the direct cast).

**Monotonically safe for status:** a *passing* callback always supplied a value
matching its declared param (no trap previously), so its behavior is unchanged;
the guard can only turn a prior `fail (illegal-cast crash)` into `pass` or a
different `fail` (wrong value) — never a `pass` into a `fail`.

*Verified (per-process, gc):* `built-ins/Proxy/{apply,construct}` non-realm
matrix **15 → 16 PASS, +1** (`apply/call-result` illegal-cast → PASS), zero
regressions. The `*/resolve-from-same-thenable` + `allSettled/call-resolve-element`
rows are UNCHANGED (they fail with "resolve or reject function is not callable" —
the OUTBOUND capturing-closure-wrap facet, NOT this arg cast; still needs the
runtime `_wrapWasmClosureUnknownArity` audit above). `tests/issue-2623a.test.ts`
(4 cases: the Proxy apply arg + forEach/map/sort matching-path guards). Broad
(hot inbound callback path) → merge_group floor validated. The prototyped #2618
construct codegen routing + constructable-target wrapper compose ON TOP of this
to flip the construct rows (follow-up PR).

---

**Slice 2623-B — `__construct_closure` host-side instance identity + species.**
*Flips:* `all/allSettled/race/any ctx-ctor` (`instance.constructor === SubPromise`)
and the host-side residual of #2628 (`new this(...)` result returned to host JS,
then `.method()` — the `viaThis` repro, currently `constructor.name === "Object"`).

**File: `src/runtime.ts`** — `_wrapCallableForHost`'s `construct` trap
(line 4904). Instead of building a bare `self = {}`, the trap should produce an
object whose `[[Prototype]]` is the closure's vivified `.prototype`
(`_getOrVivifyFnPrototype(closure, callbackState)`), and register it via
`_fnctorInstanceCtor.set(result, closure)` so BOTH the in-wasm
(`_fnctorProtoLookup`) and host-side (`Object.getPrototypeOf`) dispatch resolve.
Concretely: `const proto = _getOrVivifyFnPrototype(closure, callbackState);
const self = proto && typeof proto === "object" ? Object.create(proto) : {};`
then after the body runs, `if (result is the fresh self) _fnctorInstanceCtor.set(result, closure)`.
`Object.create(proto)` gives the host `.constructor`/`.method()` chain for free
(proto.constructor is set by the existing fnctor machinery), closing `ctx-ctor`.

**File: `src/runtime.ts`** — `__construct_closure` import (line 9389). After
`Reflect.construct`, if the result is a fresh ordinary object (not an object the
body explicitly returned), ensure the `_fnctorInstanceCtor` link is set (belt
and braces — the trap already does it; this covers the direct-`__construct_closure`
entry that bypasses the trap's ordinary path). One terminal write, no funcidx
shifts (pure runtime).

*Edge cases:* (1) body explicitly returns an object (`return {x:9}`) → that
object is the result per §10.2.2; do NOT re-link to the ctor proto (matches
`Proxy/construct/call-result` semantics too). (2) closure has no vivified
prototype yet → fall back to `{}` (current behavior, no regression). (3)
`@@species`/subclass — `ctx-ctor` reads `instance.constructor`; once the proto
chain is correct, `constructor` resolves through it.
*Validation:* the four `ctx-ctor` rows + the host-side `viaThis().getLen()`
repro flipping to 5. Pure-runtime → still merge_group-validate (broad: every
`__construct_closure` consumer, incl. acorn `new this`).

---

**Slice 2623-C — Proxy apply/construct (unblocks #2618).**
*Flips:* `Proxy/apply/call-result`, `apply/call-parameters`,
`construct/call-result`, `construct/call-parameters`, `construct/trap-is-*`
(~15 gc rows). **This is #2618** — its issue file already carries the 3-change
plan; this slice is the "sequence-after-#56/#86" trigger. With 2623-A landed,
the externref-Proxy callee `.call()`-in-capture regression that blocked the
#2618 prototype (the `apply/return-abrupt.js` PASS→ERR) is resolved by the same
inbound-marshalling unwrap, so #2618's apply path can now land without the
regression.

**File: `src/codegen/expressions/calls.ts`** — a callee whose storage slot is
`externref`/`any` (a `new Proxy` local) must route `p(args)` through the dynamic
`__call_function`/`__apply` boundary, NOT the `ref.cast $Closure` fast path.
**File: `src/codegen/statements/variables.ts`** — the `isCallable` branch must
NOT recast a `new Proxy` externref to a `$Closure` struct (add the Proxy guard
mirroring the `isBindHostCall` branch, per #2618 finding-2).
**File: `src/codegen/expressions/new-super.ts`** — `tryEmitDynamicNew` /
`emitDynamicNewFallback` (line 1728): when the constructor value is an externref
Proxy, route through the host `[[Construct]]` boundary
(`_hostProxyConstruct`-class, `runtime.ts:5037`) and USE its return value as the
result object (§10.5.13 / §9.3.2). **File: `src/runtime.ts`** — the target-wrap
change (#2618 finding-1: `_maybeWrapCallableUnknownArity` a callable target
before `new Proxy(target, handler)`) is clean and can land here.

*Edge cases:* per #2618 issue file (apply-trap-absent → forward to target
`[[Call]]`; construct-trap-absent → forward to target `[[Construct]]`;
construct returns non-object → §10.5.13 TypeError via #2617 boundary
propagation; `new.target` threading for `construct/call-parameters-new-target`).
*Validation:* the ~15 `built-ins/Proxy/{apply,construct}` rows + the existing
`tests/issue-2618.test.ts` plan. Broad (call/construct dispatch selection) →
merge_group.

---

### Coupled / deferred (do NOT bundle into A/B/C)

- **`invoke-resolve` element-identity break** (`all/race`) — sd proved the
  observable-resolve fix net-NEGATIVE *alone* (regressed `any/invoke-resolve`
  pre-#1940). Re-test it COMPOSED on top of 2623-A as a follow-up slice 2623-D,
  AFTER A lands and the cross-realm construct is legal. File forward; do not
  gate A/B/C on it.

### Sequencing summary

```
2623-A (inbound capturing-closure marshalling)  ──► keystone, lands first
   ├─► 2623-B (construct_closure identity + species)   independent, can parallel A
   ├─► 2623-C == #2618 (Proxy apply/construct)          DEPENDS on A (removes the
   │                                                     .call()-in-capture regr)
   └─► 2623-D (invoke-resolve observable-resolve)       follow-up, compose on A
```

A and B are pure-runtime + one codegen helper (~80-120 LoC each). C is the
already-specced #2618 (~150 LoC across 4 files). Each is its own PR, each
merge_group-floor-validated, none touches the value-rep substrate (#2580) or the
`__call_fn_N` funcref-dispatch loop body.

### Bounded-vs-epic, restated

**BOUNDED.** The substrate is one missing unwrap on the inbound closure-arg path
plus one identity link on the construct-trap result — both leverage maps that
already exist (`_wasmClosureWrapperTargets`, `_fnctorInstanceCtor`,
`_hostProxyReverse`). No new ABI, no dispatcher rewrite, no value-rep change.
The risk is regression breadth (hot closure-call path), addressed by
merge_group floor validation per slice — NOT by scope.

## Downstream consumers (observed gaps) — 2026-06-23, dev-promise (#1528/#40 probe)

Probed two STANDARD Promise surfaces against current `origin/main` to scope the
#42 re-spec concretely. Both are already mostly-implemented; every residual
failure resolves to **this** substrate, with exact test paths:

### `.finally` — ES2018, 22/29 test262 pass. The 7 fails are the substrate:
| test (under `built-ins/Promise/prototype/finally/`) | what it asserts |
|---|---|
| `invokes-then-with-function.js` | `.finally` must call the receiver's own (monkey-patched) `target.then(onFinally, onFinally)` with `this===target`, `arguments.length===2` |
| `invokes-then-with-non-function.js` | same, with a non-function `then` |
| `resolved-observable-then-calls-argument.js` | the wrapped `then` callback identity must be observable |
| `species-constructor.js` | `.finally` reads `this.constructor[@@species]` to build the result promise |
| `this-value-thenable.js` / `this-value-then-poisoned.js` / `this-value-then-throws.js` | `.finally` must invoke the user-supplied `then` (and propagate its poison/throw) |

**Root cause:** our `.finally` delegates to the HOST `p.finally()`
(`src/runtime.ts:10250` — `Promise_finally` → `p.finally(_maybeWrapCallable(cb))`).
The host `Promise.prototype.finally` calls V8's native `then` on the *wrapped*
object, so a **wasm-side monkey-patched `target.then`** is never observed, and
the `@@species` read happens on the host promise, not the wasm receiver. This is
exactly the **observable-then / multi-hop inbound-callback** gap — i.e. the
`2623-D` (invoke-resolve / observable-resolve) + `2623-B` (species/constructor
identity) arms, surfacing on `.finally` rather than on the combinators.

### `Promise.try` — ES2025, 9/12 test262 pass. The 3 fails are identity:
| test (under `built-ins/Promise/try/`) | what it asserts |
|---|---|
| `promise.js` | `Promise.try(fn).constructor === Promise` and `instanceof Promise` |
| `ctx-ctor.js` | `Promise.try.call(SubPromise, fn)` → result `instanceof SubPromise`, `.constructor===SubPromise`, executor invoked once |
| `not-a-constructor.js` | `isConstructor(Promise.try)===false` + `new Promise.try()` throws (capability-ctor identity through the bridge) |

**Root cause:** the capability constructor's `.constructor`/`.prototype`/species
identity must survive the host bridge — the **`2623-B` construct_closure identity
+ species** arm. Same dependency as the `#1528` `is-a-constructor.js` /
`executor-function-not-a-constructor.js` residual.

### Implication for the #42 re-spec
`.finally` and `Promise.try` are NOT separate work — they are additional
**consumers** of arms B (identity/species) and D (observable-then). When B+D
land, sweep these 10 test paths as acceptance fixtures. `allKeyed`/
`allSettledKeyed` are the Stage-1 `await-dictionary` proposal (NOT standard ECMA)
— exclude, no payload. See `plan/issues/1528-non-constructor-typeerror-promise-and-species.md`
"Re-grounded against current main — 2026-06-22/23" for the full cluster table.

---

## Slice 2623-A re-grounding — senior-dev (2026-06-23): mechanism MIS-ATTRIBUTED, fix is NOT inbound marshalling

Implemented and traced Slice A end-to-end against current main. **The architect's
mechanism (a) — "inbound host→wasm callback of a capturing closure needs a
`__unwrap_closure` on the `emitClosureCallExportN` buildArgConversion arg path" —
does NOT match the actual failure.** No `__unwrap_closure` is needed; the inbound
dispatcher is not where the `illegal cast in Constructor()` originates.

### True root cause of `illegal cast in Constructor()` (binaryen-decoded)
`allSettled/call-resolve-element` and `race/resolve-from-same-thenable` trap in the
**OUTBOUND** materialization of the capturing inner `resolve`, not on any inbound
callback. Decoded types (binaryen, not the WAT printer which mis-numbers ref
operands):
- `callCount` is boxed once as a ref cell `$10 = (struct (mut f64))`.
- The user `function Constructor(executor)` is itself materialized as a closure
  VALUE (`Promise.allSettled.call(Constructor, …)` → `__construct_closure`), so it
  captures `callCount` as `$10` (its param-0).
- The nested `function resolve(){ callCount++ }` is lifted by
  `processNestedDeclaration` (`src/codegen/statements/nested-declarations.ts`).
  Its mutable-capture param type is computed as
  `getOrRegisterRefCellType(ctx, c.type)` — but `c.type` is ALREADY the cell
  `$10`, so it boxes a SECOND time into `$17 = (struct (mut (ref null $10)))`.
- At resolve's construction site inside Constructor, the available value is `$10`
  (single box); the field expects `$17` (double box). The `struct-field-coerce`
  fixup (`src/codegen/stack-balance.ts:1870`) inserts an UNGUARDED `ref.cast`
  `$10 → $17` that traps at runtime → `illegal cast in Constructor()`.

The fix locus is therefore **`nested-declarations.ts` capture typing** (avoid
re-boxing an already-boxed mutable capture), NOT `emitClosureCallExportN` /
runtime `__unwrap_closure`.

### Why the narrow fix is NOT bounded (regresses the hot async path)
A surgical "don't re-box when the captured local IS already a ref cell" change
(thread the existing cell through; register `boxedCaptures` with the existing
`refCellTypeIdx` + inner valType) **fixes the `illegal cast`** but **regresses
`tests/issue-1312.test.ts` "async inner recursion via param with mutable ref-cell
capture" (→ NaN) and a case in `tests/async-await.test.ts`.** Both decode to the
same shape: an async nested function whose lifted body / state machine was compiled
expecting the DOUBLE-box deref depth (`$newcell → $cell → f64`); collapsing to a
single box desyncs the body's deref depth → NaN. Gating on the local TYPE being the
cell (not mere `boxedCaptures` membership) was not enough — the async-recursion case
ALSO reads its capture type as the cell at collection time. This is exactly the
documented #1205/#1312 force-boxing hazard. The capability case WANTS single-box
reuse; the async-recursion case BREAKS under it — they are indistinguishable at the
capture-typing step without a deeper async-aware deref-depth model.

### Downstream layers (independent of the substrate)
After locally applying the capture fix, the two named rows reveal TWO MORE blockers
that are **test-harness gaps, not substrate**, so the rows cannot flip on the
substrate fix alone:
1. `Test262Error.thrower` is not shimmed in `tests/test262-runner.ts` (test262
   `sta.js` defines it; passed as the REJECT fn → "Promise resolve or reject
   function is not callable").
2. `promiseHelper.js` (`checkSettledPromises` / `checkSequence`) is not shimmed
   (the `includes:` is ignored) → the resolve body calls an undefined helper.

### await-thenable bucket — NOT blocked by `illegal cast`
`await <custom thenable>` compiles and runs on current main WITHOUT the
`__closure_N` null-deref the spec predicted. The residual await rows
(`await-awaits-thenables` returns 2/assert#1, `await-non-promise-thenable` null
deref in `trigger()`) are SEPARATE failures, not this substrate.

### Recommendation (architect re-spec required — NOT a dev-claimable slice)
Slice A as written is mis-framed and the genuine fix is a deeper closure-capture
boxing-depth disambiguation that must NOT regress the async-recursion path.
Re-spec is needed to decide one of:
  (a) make the async state-machine lowering deref-depth-aware so a shared single
      cell works for both sync and async nested captures, or
  (b) detect the capability-ctor shape syntactically narrowly (outer fn is
      materialized-as-value AND nested capture is non-async non-self-recursive)
      and only collapse the box there — risk: hidden async cases.
The branch `issue-2623a-inbound-marshalling` was reverted to clean (no codegen
change shipped) because every attempted gate regressed #1312 / async-await.
Slices B (`__construct_closure` identity/species) and C (#2618 Proxy
apply/construct) are independent of this and remain claimable.

---

## Slice 2623-B re-grounding — senior-dev (2026-06-23): SPLITS into two mechanisms, NEITHER is the spec's construct-trap fix; NOT bounded

Verified Slice B against the actual faults (traced + decoded). The spec's B
mechanism — "`_wrapCallableForHost` construct trap → `Object.create(vivified
proto)` + `_fnctorInstanceCtor.set`" — does NOT match the ctx-ctor rows, and the
#2628 acorn host residual does not reproduce as the clean bounded fix the
re-grounding describes. **Verdict: DEFER (mis-specced / not bounded).**

### ctx-ctor rows (all/allSettled/race/any) — `class extends Promise` IDENTITY, not the construct trap
Repro: all four fail `assert #1: instance.constructor === SubPromise`. Traced via
host instrumentation on `Promise_all`:
- `Promise.all.call(SubPromise, [])` passes `thisArg = the synthesized host
  SubPromise` (`__promise_subclass_ctor`, a `class extends Promise {}` keyed by
  name). The instance V8 builds from it is CORRECT: `inst.constructor === C` is
  TRUE, `Object.getPrototypeOf(inst) === C.prototype` is TRUE,
  `inst.constructor.name === "SubPromise"`.
- The assert fails on **identity divergence**: the test's RHS `SubPromise`
  read-as-VALUE goes through `identifiers.ts` and emits the wasm **class-object
  singleton** (`__class_<Name>`, via `emitLazyClassObjectGet`), a DIFFERENT object
  than the synthesized host `C` used by the capability. So
  `inst.constructor (=C) === SubPromise (=__class singleton)` → false.
- **The spec's `_wrapCallableForHost` construct-trap mechanism never touches this
  path** — these rows use a host-synthesized Promise subclass, not a compiled
  closure's construct trap.

A narrow identity-unification fix (route a `class extends Promise` VALUE read
through the same cached `__promise_subclass_ctor` — mirrors
`resolvePromiseSubclassThisArg` for the value position; ~40 LoC in
`identifiers.ts`) WAS prototyped and DOES flip `assert #1`+`#2` for all/race/any
(allSettled stays at #1 — empty-array capability path differs). **But all three
then fail `assert #3: callCount === 1` and `#4: typeof executor === 'function'`**
— the synthesized `class extends Promise {}` is BARE and never invokes the user's
wasm constructor body (`super(a); executor=a; callCount++`). So the identity fix
yields **0 net test262 rows** on its own while adding a broad-impact change to the
hot identifier-as-value path. Reverted. Completing ctx-ctor requires the
synthesized subclass to run the user wasm constructor body (capability-executor
protocol THROUGH a host-synthesized Promise subclass) — a deep change, NOT bounded.

### #2628 acorn host residual — does NOT reproduce as the bounded construct-trap fix
The re-grounding (this file, the #2628 §) claims `viaIdent → 5` works and only
`viaThis` (host-side) throws, pinning it to the bare-`self={}` construct trap. On
current main I could NOT reproduce that clean split: for BOTH a `var Parser =
function` shape AND an ES `class` shape, an instance returned to host JS and read
via the host proxy has `constructor.name === "?"` and `.getLen()` does NOT resolve
for `viaIdent` AND `viaThis` alike. So the host-facing prototype-method dispatch
on a returned instance is a broader gap than "the construct trap forgot to link
the result", and the architect's shape-specific "viaThis-only" residual is not the
general case. There is also **no test262 row gated on #2628** (acorn dogfood is
in-wasm and already works per the re-grounding), so even a clean fix has ~0
conformance payoff.

### Verdict
**Slice B is DEFER — mis-specced and not a bounded dev slice.**
- ctx-ctor = `class extends Promise` host/wasm identity unification PLUS running
  the user constructor body through the synthesized subclass (capability-executor
  protocol). Two coupled deep changes; architect re-spec on the
  `__promise_subclass_ctor` ↔ class-object-singleton unification + executor-body
  invocation.
- #2628 host residual = a broader host-facing returned-instance prototype-dispatch
  gap, not the bare-`{}` construct-trap fix; ~0 test262 payoff; fold into the
  acorn-host lane, not #2623-B.
- The branch `issue-2623b-construct-identity` is reverted to clean (no codegen
  shipped). **Row delta: 0.** Slice C (#2618 Proxy apply/construct) is independent
  and not yet verified — recommend the same verify-first treatment before claiming.

---

## Slice 2623-A — SHIPPED — box-depth lowering (senior-dev sendev-2623a, 2026-06-24)

**Verdict: the box-depth double-box IS a real, fixable codegen bug — and the
prior A re-grounding's blocker ("collapsing the box regresses #1312 async
recursion") was a MIS-ATTRIBUTION. Shipped a clean, bounded fix; zero scoped
regressions.**

### Corrected root cause (binaryen-decoded on current main)
The double-box is a missing `alreadyBoxed` disambiguation in the
**FunctionDeclaration** capture path (`src/codegen/statements/nested-declarations.ts`),
which the **arrow** path already has (`src/codegen/closures.ts:1681 / 1728-1748 /
2457-2476`). Concretely, for the capability shape
(`Promise.allSettled.call(Constructor, [thenable])`, `Constructor` materialized
as a host-routed closure VALUE):
- `callCount` is boxed once into `$__ref_cell_f64` and threaded as a leading
  `(ref null $cell_f64)` param of `Constructor`.
- The nested `function resolve(){ callCount++ }` re-captures `callCount`. In
  `nested-declarations.ts` the mutable-capture param TYPE was computed as
  `getOrRegisterRefCellType(ctx, c.type)` where `c.type` was ALREADY the
  `$cell_f64` → it produced `$__ref_cell_ref_N (struct (mut (ref null
  $cell_f64)))` — a **cell-of-cell** (single positional decode:
  `resolve.cap0 = (ref null 26)` vs `Constructor.cap0 = (ref null 24)`).
- **Two breakages from that one depth mismatch:** (1) the construction site
  (`emitFuncRefAsClosure`) pushed the existing single `$cell_f64` into a closure
  field typed as the double cell → the `struct.new` field-coerce in
  `src/codegen/stack-balance.ts:1870` inserted an UNGUARDED `ref.cast $cell_f64
  → $cell_of_cell` → **`illegal cast in Constructor()`**. (2) the lifted
  `resolve` body derefed once (`struct.get $cell_of_cell`) and got the inner
  `$cell` (a ref) where it expected the f64 → `callCount += 1` read garbage
  (decoded body literally computed `f64.const 0 + 1` and dropped it) → callCount
  never incremented.

### Canonical box-depth verdict
**Capture by the existing single `$cell`; do NOT re-box at the nested-capture
boundary.** When the captured name is already in the outer scope's
`boxedCaptures`, the outer slot IS the canonical cell — thread it through. This
is exactly the arrow path's `alreadyBoxed` rule, now ported to the
FunctionDeclaration path. Both producer (closure field type, via the lifted fn's
param type) and consumer (lifted body `struct.get/set`, registered at the cell's
INNER value depth) now agree at depth 1.

### Fix (one file, `src/codegen/statements/nested-declarations.ts`)
1. capture record gains `alreadyBoxed` (= `fctx.boxedCaptures?.has(name)`) +
   `boxedValType` (the outer cell's inner value type).
2. `valueCaptureParamTypes`: `if (c.mutable && c.alreadyBoxed) return c.type;`
   (the existing cell) instead of re-wrapping.
3. `boxedCaptures` registration: when `alreadyBoxed`, register the EXISTING
   cell's typeidx + its inner valType so the body derefs exactly once.
   `emitFuncRefAsClosure` already pushes the existing cell when
   `boxedCaptures.has(name)` — no change needed there.

### Why the prior "regresses #1312 async" was wrong
The `#1312` "async inner recursion via param with mutable ref-cell capture" test
is **ALREADY NaN on clean `origin/main`**, independent of any box change. Its
async `next` is **single-boxed** already (`cap0 = $__ref_cell_f64`) and my fix
does not touch it. The NaN is a SEPARATE bug: the async helper `call(fn){ return
await fn() }`'s await-of-closure dispatch only handles the VOID wrapper arm; for
an **f64-returning** callback it does `call_ref; drop; ref.null extern` — it
**discards the callback's return value** → the recursion's accumulated value is
lost → NaN. That is an `await`-callback-result-drop bug in the await/call-of-
closure dispatch, NOT box depth. (File forward as a separate async-lane issue.)

### Results
- `tests/issue-2623-capture-box-depth.test.ts` (new): asserts no
  `__ref_cell_ref_*` cell-of-cell + `resolve.cap0 == Constructor.cap0` on the
  real `allSettled/call-resolve-element.js` fixture. PASS with fix, FAIL on
  baseline (both assertions flip).
- The two headline rows (`allSettled/call-resolve-element`,
  `race/resolve-from-same-thenable`) **no longer trap `illegal cast in
  Constructor()`** — they advance to a DOWNSTREAM **test-harness shim gap**
  (`Promise resolve or reject function is not callable` = `Test262Error.thrower`
  / `promiseHelper.js` not shimmed in `tests/test262-runner.ts`). The substrate
  is fixed; the row flips additionally require those runner shims (separable
  follow-up, NOT codegen — documented in the prior A re-grounding, lines
  410-414).
- Scoped sweep: 9 capture/closure/async failures (#585 ×4, #1712, #1312-async,
  …) are ALL identical on clean baseline = **zero regressions**. (The
  `helpers.js` file-load errors in 4 unrelated suites are a pre-existing infra
  gap on main — `tests/helpers.ts` is not on `origin/main`.)
- Broad-impact (hot closure-capture path) → **merge_group floor authoritative**
  (#2097), per `project_broad_impact_validate_full_ci`.

### Follow-ups (NOT in this PR)
- `await`-callback-result-drop (the real #1312-async NaN) — async-lane.
- `Test262Error.thrower` + `promiseHelper.js` runner shims — to actually flip the
  two headline rows green once on top of this substrate fix.

---

## Slice 2623-B re-grounding #2 — senior-dev (2026-06-23): identity unification IS landable (+1 row, regression-free); executor-body half deferred

Re-verified Slice B end-to-end against current `origin/main` (binaryen-decoded +
per-process runner — one `npx tsx` process per file, NO in-process
`runTest262File` loop). The identity-divergence root cause is **confirmed and
SPLIT into a landable half and a deferred half**. The prior re-grounding above
was right that the executor-body is the deep half, but it made two factual
errors that I corrected, and it under-reported the payoff.

### Correction 1 — the value-read does NOT emit a `__class_<Name>` singleton; it emits `ref.null.extern`
The prior note said the RHS `SubPromise` "goes through `identifiers.ts` and emits
the wasm class-object singleton (`__class_<Name>`)". **False.** A
`class extends Promise` is externref-backed (#1366a/b) and `class-bodies.ts:762`
**skips** the `__class_<Name>` global for any class with a builtin parent
(`if (!ctx.classBuiltinParentMap.has(className))`). So `classObjectGlobals` never
holds it, the `emitLazyClassObjectGet` branch in `identifiers.ts` is skipped, and
the bare-identifier value-read fell through to the `ref.null.extern`
graceful-default. Decoded WAT: `(func $subPromiseValue (result externref)
ref.null extern return)`. The divergence is **synthesized-ctor vs. null**, not
synthesized-ctor vs. `__class` singleton.

### Correction 2 — identity unification ALONE banks a real test262 row (+1, not 0)
The prior note's "0 net test262 rows" is true ONLY for the `ctx-ctor` rows that
additionally assert the executor body ran (`callCount===1`, `typeof
executor==='function'`). But **`built-ins/Promise/withResolvers/ctx-ctor.js`**
uses a default-ctor `class SubPromise extends Promise {}` and asserts ONLY
identity (`instance.promise.constructor === SubPromise`, `instanceof SubPromise`)
— no executor body. Full main-vs-branch per-process diff over the entire
`extends Promise` corpus (24 Promise + 4 language files):

```
FLIP: built-ins/Promise/withResolvers/ctx-ctor.js   fail -> pass
(every other row unchanged; 0 regressions)
```

The `all/race/any/reject/resolve/try` ctx-ctor rows correctly **advance from
assert #1 to assert #3** (identity now passes; the bare synthesized subclass
still doesn't run `super(a); executor=a; callCount++`). `allSettled/ctx-ctor`
stays at #1 (empty-array capability path differs). The already-passing
`finally/subclass-{reject,resolve}-count` stay green. Non-Promise subclass
value-reads (`Error`/`Array`/`Map`) and plain-class identity (`C === C`) are
**unaffected** — the branch is gated to `classSet ∩ extends-Promise ∩
unshadowed ∩ JS-host`.

### What shipped (PR — Slice 2623-B identity unification)
A new shared module `src/codegen/expressions/promise-subclass.ts`
(`resolvePromiseSubclassName` + `emitPromiseSubclassCtor` +
`tryEmitPromiseSubclassValue`/`Receiver`) is the single detection+emission core.
- `calls.ts`: `resolvePromiseSubclassThisArg` now delegates to it (the combinator
  receiver path), and the `isPromiseSubclassReceiver` IIFE uses
  `resolvePromiseSubclassName` (dedup; −122 LoC of inline duplication).
- `identifiers.ts`: a new value-read branch (after the `__class` singleton block,
  before the `ref.null.extern` fallback) routes a `class extends Promise`
  identifier-as-value through the SAME cached `__promise_subclass_ctor` singleton.
- The receiver and the value-read can never diverge again — one object per name.
- Standalone/WASI-safe (`isStandalonePromiseActive` short-circuits → fallback).
- merge_group-floor validated (broad-impact: identifier-as-value hot path).
- `tests/issue-2623-promise-subclass-identity.test.ts` (7 tests: identity, the
  withResolvers row, chained subclass, + plain-class / Error-subclass / local-
  shadow / combinator-capability regressions).

### Deferred (executor-body half — the other ctx-ctor rows + #3/#4)
Completing `all/race/any/reject/resolve/try/allSettled ctx-ctor` (asserts
#3/#4) requires the synthesized `__promise_subclass_ctor` `class extends Promise
{}` to RUN the user's wasm constructor body on V8's NewPromiseCapability-provided
`this` + executor. That is a deep, coupled change:
(1) thread `callbackState` into `__promise_subclass_ctor`;
(2) re-architect the externref-backed `<Sub>_new` so it runs as a ctor body on a
    host-provided `this` (today it builds its OWN promise via `__new_Promise`);
(3) marshal the executor closure inbound — the **#2623-A** substrate (capturing
    inner `resolve`).
This overlaps #2623-A and is NOT bounded; keep deferred. The identity unification
is its prerequisite foundation and is now landed.

---

## Slice 2623-E (executor-body half) — VERIFIED NOT-BOUNDED, scoped handoff (senior-dev sendev-2623a, 2026-06-24)

Re-grounded the executor-body half against current `origin/main` (post-#1977
identity + post-#1981 box-depth), faithful per-process runner + WAT decode.
**Verdict: NOT a one-pass bounded slice — confirms both prior sessions' defer,
now with concrete WAT/runtime evidence. Landed nothing (correct outcome).**

### Current state of the ctx-ctor rows (per-process runner, current main)
`all/race/any/allSettled/withResolvers/try ctx-ctor`: identity (`assert #1/#2`)
**now PASSES** (#1977 landed). All now fail at **`assert #3` (`callCount === 1`)** /
`#4` (`typeof executor === 'function'`): the synthesized `class extends Promise {}`
never runs the user's wasm constructor body, so the executor is never invoked.
```
all/ctx-ctor.js   => fail | returned 4 | assert #3 at L36: assert.sameValue(callCount, 1)
race/ctx-ctor.js  => fail | returned 4 | assert #3 at L36 (same)
any/ctx-ctor.js   => fail | (AggregateError: All promises were rejected)
```

### WHERE the body lives, and why it never runs (WAT-decoded)
The user constructor body **IS fully compiled** as `$SubPromise_new(externref)→externref`:
decoded body does `__new_Promise(executor)` (the `super(a)`), then
`global.set $executor` (`executor = a`), then `global.get $callCount; f64.const 1;
f64.add; global.set $callCount` (`callCount += 1`), then `__set_subclass_proto`.
So the body is correct and present. The gap is purely **invocation**: V8's
`NewPromiseCapability(C)` does `new C(internalExecutor)` where
`C = __promise_subclass_ctor(name)` is a **BARE** `class extends Promise {}`
(`src/runtime.ts:10378`) whose default ctor only forwards `super(executor)` and
**never calls `$SubPromise_new`**. The combinators
(`Promise.all.call(C,…)`) go through this bare host `C`.

### TWO coupled blockers (each verified), neither bounded
**(B1) Even direct `new SubPromise(executor)` is broken** — pre-existing,
independent of the combinators. Probe: `new SubPromise((res,rej)=>res(1))` →
runtime **`Promise resolver [object Object] is not a function`**. `$SubPromise_new`
forwards the executor to `super(Promise)` via the extern-class construction path
(`__new_Promise`), but the executor arrives **boxed/wrapped**, not as a raw
callable, so V8's real `Promise` ctor rejects it. Needs `_maybeWrapCallable`-style
unwrap at the `super(<builtin Promise>)` boundary. Touches the extern-class
`super(builtin)` path — broad-impact, and **flips 0 test262 rows alone** (every
ctx-ctor row goes through the combinator/NewPromiseCapability path, not direct
new), so it cannot be the "narrowest verified-safe slice" on its own.

**(B2) The combinator path needs a wasm→host ctor-callback registration that does
not exist.** To run the user body under `NewPromiseCapability(C)`, the synthesized
`C`'s constructor must call back into `$SubPromise_new` with V8's internal
executor AND thread V8's provided `this` (the capability promise) so `super(a)`
binds to it (today `$SubPromise_new` builds its OWN promise via `__new_Promise`).
The host CAN call wasm closures (`exports.__call_fn_N` via `setExports`), but
there is no mechanism to (i) register `$SubPromise_new` as a host-callable closure
keyed by class name, (ii) have `__promise_subclass_ctor` build a `C` whose ctor
invokes it, (iii) re-architect `$SubPromise_new` to run as a ctor body ON a
host-provided `this` instead of allocating its own promise. This also couples to
#2623-A (the executor closure is a capturing closure marshalled inbound).

### Why this is genuinely multi-PR (architect re-spec required)
The three changes (executor unwrap at `super(builtin)`; wasm ctor-closure
registration import; `<Sub>_new` "run-on-host-this" re-architecture) are
interdependent: B2 depends on B1 (the executor must be callable before the
registered closure can use it), and B2's `<Sub>_new` re-architecture changes the
direct-new path too (must not regress it). None is independently floor-positive.
A bounded slice does not exist here; this is an architectural re-spec on the
`__promise_subclass_ctor` ↔ `<Sub>_new` ↔ `NewPromiseCapability` protocol.

### Recommendation
- **Architect re-spec** the executor-body protocol as its own issue (split from
  #2623): define the wasm ctor-closure registration ABI + the `run-on-host-this`
  `<Sub>_new` shape + the `super(builtin)` executor-unwrap, sequenced B1→B2.
- Do NOT land a speculative broad-impact B1-only PR: 0 row payoff, hot
  extern-class `super(builtin)` path, exactly the scoped-sweep-hides-regression
  hazard (`project_broad_impact_validate_full_ci`).
- The #2623 capability cluster's landable substrate (box-depth #1981, identity
  #1977) is now banked; the executor-body remainder is the deep tail and should be
  scheduled as architect-specced work, not a dev slice.

**Formalized as #2637** — `plan/issues/2637-promise-subclass-executor-body-protocol.md`
carries the full architecture spec (B1 → B2 sequencing, WAT evidence, ABI shape,
floor discipline). #2623's landable slices are done (box-depth #1981 + identity
#1977 merged); #2618 (Proxy apply/construct, Slice C) and #2623-D (invoke-resolve)
remain as separate forward items.
