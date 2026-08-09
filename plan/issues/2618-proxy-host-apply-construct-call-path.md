---
id: 2618
title: "Proxy (host): calling / constructing a Proxy whose target is callable traps (illegal cast) or ignores the construct trap result (~15 fails)"
status: blocked
assignee: ttraenkler/sd-2618
sprint: Backlog
created: 2026-06-22
updated: 2026-07-04
reconcile_status_note: "2026-06-24 (PO reconcile vs upstream/main): Slice 1 LANDED (PR #1984, commit 1cc09f72f — pure-runtime START-timing + callable-target wrap, +1 gc row). REMAINING work (externref-callee p.call(a,b) CALL dispatch + dynamic-new construct-result routing) is gated on the deep #56 dispatch substrate (blocked_on:[56] already set). NOT dev-claimable until #56 lands. → blocked (was in-progress)."
blocked_on: [56]
reconcile_note: "SLICE 1 MERGED #1984 (sd-2618): pure-runtime START-timing + callable-target [[ProxyTarget]] wrap; +1 gc row (apply/call-parameters), zero regr. DEFERRED slices SCOPED+HANDED OFF 2026-06-24 (sd-2618): both apply-dispatch AND construct bottom out in the SAME root cause — the inbound __call_fn_method_N dispatcher ref.cast-ing a host JS argArray to a wasm vec struct (illegal cast). == 2623-A inbound-marshalling KEYSTONE (codegen/index.ts buildArgConversion 3356/3659). Construct codegen routing (compileNewExpression Proxy guard + constructable-target wrapper) prototyped, correct, but INERT (0 rows) without the keystone. NOT shipped — broad surface for 0 rows = #1888 floor-eject hazard. See '## Deferred slices … SCOPE+HANDOFF' for WAT evidence + ordering. Architect/2623-A territory, not a standalone dev slice."
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

---

## Slice 1 (sd-2618, 2026-06-24) — START-timing + callable-target wrap (pure runtime)

**Verify-first re-grounding against current `origin/main` (faithful per-PROCESS
test262 wrap: `parseMeta` + `wrapTest` + `compileSource` + `buildImports` +
`setExports`, one node process per file — NOT in-process `runTest262File`
loops).** Reconfirmed all three sd-2623 prerequisites per-process; two of the
three framings have MOVED since the 2026-06-22 spec.

### Re-grounding evidence (current main, faithful runner)

| Probe | Prior framing | ACTUAL on current main (per-process) |
|---|---|---|
| **START-timing** (top-level `new Proxy(...)`) | "null-derefs at `_hostProxyConstruct`" | **REAL but no crash** — the eager bridge builds with `getExports()` undefined, so EVERY trap is mis-resolved and the host falls back to its default internal methods. A genuine module-top-level `new Proxy({a:1},{get:()=>99}).x` returned the **target's** value (effectively `0`/dropped), NOT `99`. **Verified flip with fix: 99.** BUT — see below — **test262's harness never triggers it.** |
| START-timing's test262 reach | (assumed it blocks the rows) | **test262 `wrapTest` injects `var p = new Proxy(...)` INSIDE the synthetic `export function test()` body** (proxy at wrapped-line 46, `function test` at line 38). So in the harness EVERY proxy is built post-`setExports`; START-timing **flips 0 test262 rows**. It is a latent correctness fix for genuine module-scope proxies only. |
| `apply/call-parameters.js` | `illegal cast in __call_fn_method_3` | `FAIL: call is not a function` (proxy of a wasm-closure target is not host-callable). **Fixed by the callable-target wrap → PASS (+1 row).** |
| `apply/call-result.js` & most apply rows | illegal cast | still `FAIL illegal cast` — the externref-callee **CALL dispatch** (`p.call(...)`) casts in codegen; NOT fixed by this slice. |
| `construct/call-result.js`, `construct/call-parameters*.js` | trap result dropped | `FAIL: … is not a constructor` / `No dependency provided for extern class "P"` — the **dynamic-new** path (`tryEmitDynamicNew`) doesn't route an externref Proxy ctor through host `[[Construct]]`; NOT fixed by this slice. |

### What this slice changes (PURE RUNTIME — `src/runtime.ts` only; NO codegen)

1. **START-timing lazy bridge** (`_buildProxyBridgeHandler` → `_buildLazyProxyBridgeHandler`
   + `_proxyForwardDefault`): when `getExports()` is undefined at construct time
   (a module-top-level `new Proxy`), defer trap resolution to first invocation
   (post-`setExports`, when the program actually calls through the proxy). The
   eager branch (exports present) is byte-for-byte unchanged. Absent-trap →
   forward to the target default (§7.3.10); non-callable trap → TypeError
   (§7.3.10 GetMethod); callable trap → forward with `this` = raw handler.
2. **Callable-target [[ProxyTarget]] wrap** (`_proxyTargetFor` in
   `_hostProxyConstruct` / `_hostProxyConstructRevocable`): a Proxy whose target
   is a wasm closure must be host-callable (V8 derives [[Call]]/[[Construct]]
   from [[ProxyTarget]]; a raw struct is not callable). Use the target's
   `_maybeWrapCallableUnknownArity` JS wrapper as [[ProxyTarget]]; the bridge
   substitutes the **raw struct** back as the apply/construct trap's `target`
   arg (`_wrapPlainHandlerForRawTarget` for plain-JS handlers; `rawTarget` arg
   threaded through both eager + lazy WasmGC-handler paths) so
   `assert.sameValue(t, target)` holds (`apply/call-parameters.js`).

### Verified result (per-process faithful runner, gc mode)
- `built-ins/Proxy/{apply,construct}` non-realm matrix (29 files): **baseline 14
  PASS → fix 15 PASS, exactly +1** (`apply/call-parameters.js` fail→pass), **zero
  regressions** (byte-for-byte identical on all other rows).
- `get`/`has`/`set`/`defineProperty`/`getPrototypeOf`/`ownKeys`/`deleteProperty`
  `call-parameters` rows: identical baseline↔fix (they already pass; the
  identity wrap doesn't disturb them).
- vitest proxy/reflect/closure suites (`issue-2615/2616/2180/1466`,
  `proxy-passthrough`, `struct-proxy-wrappers`, `issue-1312`,
  `issue-1712-capture-closure-dispatch`): the 8 fails are **PRE-EXISTING on
  pristine `origin/main`** (verified by reverting `runtime.ts` and re-running) —
  no new regressions from this slice.
- `tests/issue-2618.test.ts` (6 cases, green): top-level get/has/set/apply traps
  fire; top-level==inner no-trap parity; apply-result via `p.call()`.

### Broad-impact note (validation gate)
The target-wrap changes `[[ProxyTarget]]` for **every** callable-target proxy
(not just test262 ones) — affects `proxy===target` probes, `_userProxies`
reverse-mapping, `typeof`/`instanceof`. Per `project_broad_impact_validate_full_ci`
the **merge_group floor (#2097) is authoritative**; this PR is full-gate via
merge_group, not a scoped sweep.

### REMAINING work — prerequisite ordering (deferred, the deep #56 dispatch zone)

The two remaining failure classes are **codegen call/construct dispatch**, NOT
runtime — exactly the `#56` substrate sd-2623 flagged. They are a separate
slice and MUST NOT be forced half-built into this PR (the #1888-class floor-eject
hazard):

1. **Slice 2618-apply-dispatch** — `p.call(a, b)` / `p(args)` for an
   externref-Proxy callee still casts (`illegal cast`). Locus
   `src/codegen/expressions/calls.ts` `tryEmitInlineDynamicCall` (the closure-
   struct dispatch chain whose default `else` is `ref.null.extern`; route an
   externref-Proxy callee through `__call_function`/host apply). Confirmed
   fragile: no-arg `p.call()` works (host apply MOP), but multi-arg
   `p.call(a,b)` → illegal cast — the dispatch is only partially functional
   without this. **This is the broad-impact dispatch change; full-CI before
   landing.**
2. **Slice 2618-construct** — `new p()` for an externref-Proxy ctor fails (`is
   not a constructor` / `No dependency provided for extern class`). Locus
   `src/codegen/expressions/new-super.ts` `tryEmitDynamicNew` — route through host
   `[[Construct]]`/`Reflect.construct` and USE the trap result as the new object
   (§10.5.13). The runtime callable-target wrap (this slice) already makes the
   Proxy host-constructable, so slice 2618-construct narrows to the codegen
   routing + threading the construct-trap result + `new.target`.

Ordering: **this slice (runtime, foundational) FIRST** → then 2618-apply-dispatch
and 2618-construct (each its own PR, each merge_group-floor-validated). Neither
touches the value-rep substrate (#2580) or the `__call_fn_N` funcref loop body.

### Refinement of sd-2623's "inert at module-START" claim (below)
sd-2623's Slice C re-grounding (next section) concluded the callable-target wrap
is "correct in principle but inert at module-START construct time, so it cannot
land usefully alone." **That is true ONLY for a genuine module-top-level
`new Proxy`** — which `test262`'s harness does NOT produce: `wrapTest` injects
`var p = new Proxy(...)` INSIDE the synthetic `export function test()` body (the
proxy is built post-`setExports`). So at construct time in the harness, exports
ARE wired and the callable-target wrap DOES fire — verified flip of
`apply/call-parameters.js` fail→pass (+1 row). For the genuine module-scope case
sd-2623 measured, **Slice 1's lazy bridge** (`_buildLazyProxyBridgeHandler`)
covers it. So Slice 1 lands the bounded runtime piece; only the externref-callee
CALL dispatch and dynamic-new construct routing remain in the #56 zone.

## Re-grounding (senior-dev #2623 Slice C, 2026-06-23) — CONFIRM DEFER; faults have MOVED

Verify-first re-measure of the two faults on current `origin/main` (after
#2615/#56 siblings landed). **Confirm DEFER — not bounded.** The faults moved
since the 2026-06-22 measure, and the new blockers are START-timing + the
`.call()`-on-Proxy dispatch, not a clean routing select.

### apply — fault has split by callee TS type; the real test262 shape adds two new blockers
- `const p: any = new Proxy(fn, {apply:()=>42}); p()` → returns **0** (silent
  wrong; the `any`-callee dispatch chain `ref.test (ref $closure)` misses and the
  ELSE arm is `i32.const 0`, NOT an illegal cast anymore).
- inferred-type `const p = new Proxy(fn, …)` (no annotation — the test262 shape) →
  `p()` **null-derefs** in the matched-closure dispatch (the proxy externref is
  `ref.cast`→null, then `struct.get` of null).
- A prototyped fix (add `receiverMayBeProxy` to the `hostCallFallback` gate at
  `calls.ts` ~11389 so a Proxy callee routes through `__call_function`, PLUS wrap a
  callable wasm-closure target in `_hostProxyConstruct` via
  `_maybeWrapCallableUnknownArity`) advances the inferred case past the null-deref
  — but then hits **TWO blockers the real `apply/call-result.js` shape always has**:
  1. **START-timing.** `apply/call-result.js` builds `var p = new Proxy(…)` at
     **top level**, so `_hostProxyConstruct` runs during the module START function
     BEFORE `setExports` wires `__is_closure` — instrumented: `isClosure = noFn`.
     The callable-target wrap therefore can NOT fire at construct time (the same
     lazy-exports hazard as `_wrapWasmClosure`/#1712). A callable target IS
     required at construct time for V8 to make the proxy `[[Call]]`-able, so the
     wrap can't simply be deferred to the trap. (Deferred construction inside a
     post-instantiation function DOES wrap — `isClosure=1` — confirming the
     mechanism, but that is not the test shape.)
  2. **`.call()`-on-Proxy.** The test invokes `p.call()`, not `p()` — the
     Proxy-method dispatch path that the 2026-06-22 investigation already flagged
     as the `.call()`-in-capture regression blocked on #56.

### construct — trap result still dropped; routing lives in the #56 dynamic-new zone
- `new Proxy(C, {construct:()=>({x:9})})` then `new p(); o.x` → returns **0** (trap
  result dropped) at BOTH top level and inside a function. `new p()` is statically
  lowered to a direct `C` struct construction (the `new <expr>` path resolves `p`'s
  TS type to the target class), so the construct trap never runs. Routing
  `new <externref Proxy>` through a host `Reflect.construct` boundary lives in
  `tryEmitDynamicNew` / `emitDynamicNewFallback` (`new-super.ts`) — the same
  call/construct dispatch zone #56 reworks, and it needs the same START-timing-safe
  callable-target representation as apply.

### Verdict
**DEFER — confirmed, NOT bounded.** The three coupled prerequisites — a
START-timing-safe host-callable representation of a wasm-closure Proxy target,
`.call()`/`.apply()`-on-Proxy method dispatch through closure capture, and the
dynamic-`new`-on-externref construct-result threading — are all in the #56
call/construct-dispatch rework. The isolated runtime target-wrap is correct in
principle but inert at module-START construct time, so it cannot land usefully
alone. Sequence AFTER #56; do not staff as a standalone slice. Branch
`issue-2623b-construct-identity`-adjacent work (Slice C) was kept pristine — no
codegen shipped. This closes the #2623 cluster verdict: A + B + C all DEFER to
architect re-spec / #56-sequencing (see the #2623 Slice A & B
re-groundings).

---

## Deferred slices (apply-dispatch + construct) — SCOPE+HANDOFF with WAT evidence (sd-2618, 2026-06-24)

After Slice 1 (#1984) merged, I re-grounded the two deferred slices per-process
(faithful `wrapTest`+compile+execute, binaryen-decoded WAT). **Both bottom out in
the SAME single root cause — the 2623-A inbound-marshalling substrate — and
neither is a narrow safe row-positive slice. HANDOFF, do not force half-built.**

### Root cause (one fault, surfaces on BOTH apply and construct)

The inbound host→wasm callback dispatcher **`__call_fn_method_N`**
(`emitClosureCallExportN` → `buildArgConversion` → `externToClosureParamRef`,
`src/codegen/index.ts:3356-3378` and `:3659-3690`) **unconditionally
`ref.cast`s** each host-supplied callback arg to the closure's declared wasm
struct param type. When a trap's parameter is typed `any[]`/array-ish → lowers to
`(ref null $vec)`, but the host passes a real **JS array** as that arg → the
`ref.cast (ref null $vec)` traps with `illegal cast`.

**WAT evidence — `apply/call-result.js` (`p.call()`), decoded `__call_fn_method_3`:**
```wat
(call_ref $5
  (ref.cast (ref $0) (local.get $5))   ;; self
  (local.get $2)                        ;; arg t (externref, raw)
  (local.get $3)                        ;; arg c (externref, raw)
  (ref.cast (ref null $4)               ;; arg `args` — CAST host JS array -> $vec -> ILLEGAL CAST
    (any.convert_extern (local.get $4)))
  (ref.cast (ref $5) (local.get $7)))
```
The passing row `apply/call-parameters.js` differs ONLY in that its trap's `args`
param inferred to `externref` (no cast) — so the fault is purely "is the trap
param a concrete struct ref?", call-shape/type-inference-sensitive, not a routing
choice.

**Runtime call chain (both apply & construct):** `p.call()` / `new p()` ->
`__extern_method_call` / `__construct_closure` -> host `[[Call]]`/`[[Construct]]`
MOP -> bridge trap (slice 1) -> `wasmClosureDynamicBridge` (`runtime.ts:1897`) ->
`__call_fn_method_3` -> **illegal cast on the args param**. Identical stack for
construct (verified: `construct/call-result.js` throws `illegal cast` at
`__call_fn_method_3` once the proxy is made constructable).

### apply-dispatch — NOT "route through `__call_function`"
The codegen routing is already correct: `p.call()` lowers to
`__extern_method_call(p, "call", argv)` (WAT-confirmed; NO `ref.cast $Closure` in
`$test`). The `illegal cast` is in the INBOUND dispatcher, not the outbound call.
So the "route the externref-Proxy callee through `__call_function`" framing does
not match the actual fault — the call already routes correctly; the trap's
arg-marshalling is what casts. **Fix = the 2623-A inbound `__call_fn_*` arg path
(broad, hot callback dispatch), not a routing select.**

### construct — codegen routing FIXED, but inert without the inbound fix
Two real sub-faults found & prototyped (reverted — inert):
1. **`new p()` mis-routes by TS type.** `new Proxy<C>(C,h)` types as `C`, so the
   static class / extern-class arm fires -> "No dependency provided for extern
   class P", dropping the construct trap. **Fix (prototyped, correct):** a
   syntactic Proxy guard (`receiverMayBeProxy`, exported from `calls.ts`) early in
   `compileNewExpression` (`new-super.ts`) routes a `new Proxy(...)`-bound callee
   through `__construct_closure` (host `Reflect.construct` -> fires the construct
   trap, threads the result; `new.target` === the proxy is the default). JS-host
   only, syntactically narrow.
2. **The callable-target wrapper is an ARROW -> not constructable.** The Proxy
   target compiles to a `callback_maker` ARROW (`runtime.ts:11506`,
   `(...args)=>exports[__cb_id](...)`) which has NO `[[Construct]]`, so the host
   proxy is not constructable -> "is not a constructor". **Fix (prototyped):**
   `_proxyTargetFor` wraps a non-constructable callable target in a constructable
   forwarding function-expression (`_wrapConstructableForwarder`). NOTE: this is
   semantically over-broad (makes ALL callable-target proxies constructable; spec
   §10.5.13 says constructable iff target is) — no test in the suite regresses
   (no negative non-constructable-target test), but a cleaner fix plumbs
   source-constructability through `callback_maker`.

With BOTH construct fixes applied, `construct/call-result.js` advances from "is
not a constructor" -> the construct trap FIRES -> then dies at the SAME
`__call_fn_method_3` `illegal cast` on the trap's `args` param. **Net construct
row delta of the two construct fixes ALONE: 0** (baseline 10 PASS -> 10 PASS, no
regressions). They are correct and necessary but inert until the inbound fix
lands. Landing them alone adds broad surface for 0 rows -> NOT shipped.

### Prerequisite ordering (the gate for ALL remaining apply+construct rows)

```
2618-inbound-marshalling (== 2623-A)  -- KEYSTONE, blocks everything
   the __call_fn_method_N arg cast: a host JS array passed for an `any[]`/array
   trap param must be MARSHALLED into the expected wasm vec struct (or the cast
   guarded with ref.test + a marshalling fallback), NOT blindly `ref.cast`.
   Locus: src/codegen/index.ts buildArgConversion (3356/3659) +
   externToClosureParamRef (3212). BROAD: the hot inbound callback path (every
   .map/.forEach/Promise-executor/await-continuation callback). Per
   project_broad_impact_validate_full_ci -> full local-ci / merge_group, NOT a
   scoped sweep. This is the #2623 Slice A inbound capturing-closure marshalling.
   |-> 2618-apply rows (call-result, trap-is-null, trap-is-undefined, ...)
   |     flip once the trap's args param marshals correctly.
   +-> 2618-construct rows -- ALSO need the two construct fixes above
         (compileNewExpression Proxy guard + constructable-target wrapper),
         which are ready/prototyped and land trivially ON TOP of the inbound fix.
```

**Recommendation:** this is architect/2623-A territory (the inbound-marshalling
keystone), not a standalone dev slice. Sequence: land 2623-A inbound marshalling
first (full-gate), THEN the construct codegen guard + constructable wrapper
(small, prototyped) compose on top to flip the construct rows, and the apply rows
flip for free. Forcing either deferred slice now would ship broad dispatch
surface for **0 rows** — the #1888-class floor-eject hazard. Branch
`issue-2618-apply-dispatch` kept pristine (all prototyped changes reverted; no
codegen shipped).

---

## Architect spec pointer (2026-07-04)

The inbound-marshalling keystone (2623-A) and the construct routing are now
specced as slices **K1 / K1b** of the dynamic-MOP umbrella spec **#3031**
(`plan/issues/3031-dynamic-mop-extensions-spec.md`, Part 1 §1.2). K1 is
tier-marked FABLE (guarded `ref.test` + `__marshal_extern_to_vec_T` fallback
in `buildArgConversion`, full merge_group gate); K1b (the prototyped construct
guard + constructable-forwarder above) is OPUS-executable on top. Coordinate
with #56 state before starting K1.
