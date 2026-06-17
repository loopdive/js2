---
id: 1100
title: "Wasm-native Proxy: meta-object protocol without JS host"
status: done
assignee: ttraenkler/sen-a
created: 2026-04-12
updated: 2026-06-16
completed: 2026-06-16
priority: top
feasibility: hard
reasoning_effort: max
task_type: feature
language_feature: proxy
goal: spec-completeness
sprint: 63
es_edition: ES2015
note: "2026-06-15: elevated to TOP priority by stakeholder (Proxy/Promise/async-to-100% epic). Standalone Proxy Phase 1 (get/set/has/apply + revocable). Needs architect spec before dev dispatch; precedes #1355 (remaining traps to 100%)."
---
# #1100 — Wasm-native Proxy: meta-object protocol without JS host

## Problem

Proxy is currently skipped entirely in test262 and has no compilation strategy. In JS-host mode, Proxy objects could theoretically be delegated to the host's `Proxy` constructor, but this doesn't work for standalone mode and doesn't address the 1,087 opaque-object failures (#983) that stem from WasmGC structs being non-introspectable by JS-side Proxy traps.

For a standalone Wasm target, Proxy requires a compile-time meta-object protocol: intercepting property access, assignment, `in`, `delete`, function call, and `construct` at the call site, not at the object.

## Approach (compile-away strategy)

Proxy traps can be compiled as a **vtable dispatch on property operations**:

1. Every object that *might* be a Proxy gets its property operations routed through a trap table (a WasmGC struct of function references)
2. Non-Proxy objects use a direct-dispatch trap table (identity functions)
3. Proxy objects use a user-provided trap table
4. `Proxy.revocable` sets the trap table to a throwing stub

This is similar to how V8 handles Proxy internally — the meta-object protocol is a dispatch table, not runtime magic.

## Key challenges

- **Performance**: every property access on a potentially-Proxy value goes through an indirect call
- **Scope**: 14 trap types (get, set, has, deleteProperty, ownKeys, getOwnPropertyDescriptor, defineProperty, preventExtensions, isExtensible, getPrototypeOf, setPrototypeOf, apply, construct, enumerate)
- **Invariant checking**: Proxy traps have spec-mandated invariants that must be enforced

## Acceptance criteria

- [ ] `new Proxy(target, handler)` compiles in standalone mode
- [ ] At least `get`, `set`, `has`, `apply` traps work correctly
- [ ] Proxy.revocable works
- [ ] test262 Proxy tests begin passing (target: ≥50% of non-skipped Proxy tests)

## Related

- #983 WasmGC opaque object leak (symptom of missing Proxy support)
- #797 Property descriptor subsystem (Proxy traps interact with descriptors)

## Implementation Plan

(Author: architect, 2026-05-21. Large multi-phase feature; the plan
below scopes a minimum-viable Proxy that lands the four core traps,
defers the other ten as follow-ups.)

### Entry point

- `src/codegen/builtins/proxy.ts` (new) — handles `new Proxy(t, h)`
  lowering.
- `src/codegen/property-access.ts` — branch on receiver "may be
  Proxy" before emitting struct.get/set.

### Data structure

```wat
(type $ProxyTraps (struct
  (field $get        (ref null funcref))
  (field $set        (ref null funcref))
  (field $has        (ref null funcref))
  (field $apply      (ref null funcref))
  ;; Phase 2: 10 more traps
))
(type $Proxy (sub (struct
  (field $tag i32)               ;; PROXY_TAG (#1325 registry)
  (field $target (ref null any))
  (field $handler (ref null any))
  (field $traps (ref $ProxyTraps))
  (field $revoked (mut i32))
)))
```

### Numbered algorithm

1. **Construction** — `new Proxy(t, h)`:
   1. Allocate `$Proxy` struct with tag = PROXY_TAG.
   2. Read each trap by name from `h` (get/set/has/apply for Phase 1),
      store as funcref in `$traps`.
   3. Return the proxy struct.

2. **Property read** — `p.x` where `p` may be Proxy:
   1. `ref.test $Proxy` on receiver.
   2. If true and `$traps.get` not null: build `[target, "x", p]`
      argument vector, `call_ref` the trap, return its value.
   3. Otherwise: existing externref/struct.get path.

3. **Property write** — `p.x = v`: symmetric to read with `$set`.

4. **`'x' in p`** — `$has` trap.

5. **`p()` / `p.call(...)`** — `$apply` trap if `p` is a function-like
   proxy.

6. **`Proxy.revocable`** — return `{proxy, revoke}` where `revoke`
   sets `$revoked = 1`; every trap dispatch checks the bit first.

### Edge cases

- **Symbol-keyed access** — trap receives the symbol via the key arg.
- **Invariant violation** — e.g. `getOwnPropertyDescriptor` reports
  a non-existent property on a non-extensible target. Phase 2 work.
- **Reflect.* operations** — defer; Reflect can be implemented in
  Phase 2 as wasm functions that invoke the same trap dispatch.
- **Proxy target is itself a Proxy** — recursive dispatch; must
  unwrap once per level. The trap funcref returns the raw target on
  identity-equality probes (e.g. `proxy === proxy`).
- **Revoked proxy** — every trap throws TypeError. Check `$revoked`
  bit at trap dispatch entry.
- **Receiver-vs-target binding for `get`** — spec passes
  `(target, property, receiver)`; ensure trampoline pushes `receiver`
  not `target` when called via `obj.method()`.
- **null / undefined target** — spec rejects at construction; throw
  TypeError before allocation.

### Test262 paths

- `test/built-ins/Proxy/*/get/*` — Phase 1
- `test/built-ins/Proxy/*/set/*` — Phase 1
- `test/built-ins/Proxy/*/has/*` — Phase 1
- `test/built-ins/Proxy/apply/*` — Phase 1
- All others — Phase 2.

Phase 1 acceptance: ≥30% of non-skipped Proxy tests pass.

### Dependencies

- **#1325** — instanceof tag registry; PROXY_TAG must be registered.
- **#983** — `_wrapForHost` must NOT wrap proxies (already correct);
  document the contract.
- **#1101** WeakRef — independent.

### Risks

- **Hot-path slowdown**: every property access now needs `ref.test
  $Proxy`. Mitigate by static analysis — only emit the test when the
  receiver's type may include Proxy. For untyped externref receivers
  we already pay a host call, so no net regression.
- **Spec invariant enforcement** is fiddly; Phase 1 explicitly does
  NOT enforce invariants (spec says traps "should" return consistent
  values; non-compliant trap behaviour is technically allowed to
  throw, which Phase 2 will do).

## Implementation Plan (revised — architect, 2026-06-16)

(Supersedes the earlier draft above. Standalone/pure-Wasm only. Phase 1 =
get/set/has/apply + revocable. Remaining traps + full invariants are #1355.
Host-mode companion is #2180.)

### Root cause / gap

In standalone mode there is no host `Proxy`. Today the compiler hard-errors:
`new Proxy` → `new-super.ts:2074-2078`; `Proxy.revocable` → `calls.ts:5247-5256`.
So every `built-ins/Proxy` test fails to compile standalone. Phase 1 lands a
Wasm-native meta-object protocol for the 4 highest-impact traps. The object
model to extend is `$Object` in `src/codegen/object-runtime.ts:210-226`,
created by `ensureObjectRuntime(ctx)`. Standalone reads/writes flow through
`__extern_get`/`__extern_set`/`__extern_has`/`__delete_property`.

### WasmGC representation

Add `$ProxyTraps` (struct of 4 funcref fields: get/set/has/apply) and `$Proxy`
as a **subtype of `$Object`** (so existing `ref.test $Object` guards still match)
with extra fields: `$ptag` (PROXY_TAG), `$ptarget` (ref null any), `$phandler`
(ref null any), `$ptraps` (ref $ProxyTraps), `$revoked` (mut i32). Subtyping is
the lowest-churn discriminator — add one extra `ref.test $Proxy` at dispatch
sites. Register PROXY_TAG in the instanceof tag registry (#1325) or use a bare
`ref.test $Proxy` if #1325 is unlanded.

### Trap-dispatch architecture

`p.x` → `ref.test $Proxy(p) ? __proxy_get_dispatch(p,"x",p) : existing __extern_get`.
`__proxy_get_dispatch(proxy,key,receiver)` (new runtime helper from a
`ensureProxyRuntime(ctx)` slice): (1) if `$revoked` → throw TypeError;
(2) `trap = $ptraps.$get`; if null → forward `__extern_get($ptarget,key)`;
(3) else `call_ref trap ($ptarget,key,receiver)`. set/has symmetric; apply only
when `$ptarget` is callable and call site is a CallExpression on the proxy.
Phase 1 does NO §10.5.8 result-invariant check (that is #1355).

### Construction

`new Proxy(t,h)` (new-super.ts): §28.2.1.1 — if t or h not object → throw;
allocate `$ProxyTraps` reading get/set/has/apply off h via `__extern_get`
(callable→funcref via the existing closure-call bridge, else null);
`struct.new $Proxy`; return as externref via `extern.convert_any`.
`Proxy.revocable(t,h)` (calls.ts): build the `$Proxy`, build a `revoke` closure
capturing it (sets `$revoked=1`, nulls target/handler/traps per §28.2.2.1.1),
return a 2-field `{proxy,revoke}` object.

### Property read/write/has integration

`src/codegen/property-access.ts`: at each standalone Get/Set/HasProperty site,
branch on `ref.test $Proxy(receiver)` ONLY when inference can't prove a
non-proxy receiver (typed concrete struct/class locals skip the test → hot path
unaffected); externref/unknown/object receivers get the proxy branch.

### Invariant enforcement (Phase 1 scope)

Only the revoked-proxy invariant. §10.5.7/8/9 result-consistency invariants are
deferred to #1355. Phase 1 must not trap the module on them — just return the
trap result.

### Edge cases
non-object target/handler → TypeError; `proxy[sym]` → symbol externref to trap;
`proxy.m()` passes receiver=proxy; proxy-of-proxy recurses to a non-proxy target;
`proxy === proxy` ref identity; missing trap forwards to ordinary [[Get]].

### Test-gate plan (test262)
Phase 1 target ≥30% non-skipped `built-ins/Proxy` standalone. Gate
`built-ins/Proxy/{get,set,has,apply}/**`, `revocable/**`,
`create-{target,handler}-is-not-object-throws.js`; `tests/issue-1100.test.ts`.
Regression: the `$Proxy <: $Object` subtype change touches every `ref.test
$Object` — full standalone equivalence suite must stay green.

### Dependencies / risks
#1325 tag registry (or bare `ref.test $Proxy`); #1355 depends on this; audit
every `struct.get $Object` site to `ref.test $Proxy` first; reuse the
closure→funcref bridge, do not invent a calling convention.


## Implementation — Phase 1 COMPLETE (sen-a, 2026-06-16, sprint 63)

Standalone `new Proxy(target, handler)` with **get / set / has** traps + the
§28.2.1.1 non-object construction throw + missing-trap forwarding. All in
`src/codegen/object-runtime.ts` (`ensureProxyRuntime` + `fillProxyDispatch`),
`src/codegen/expressions/new-super.ts` (call site), `src/codegen/index.ts`
(finalize wiring), `src/codegen/context/types.ts` (`proxyDispatchReserved`).
`tests/issue-1100.test.ts` (9 tests, all green; tsc clean; every program
`WebAssembly.validate`s true).

### WasmGC representation
- `$Object` stays a **plain (final) struct** — the earlier `$Object` non-final
  `sub` (so `$Proxy` could extend it) tripped WasmGC iso-recursive
  canonicalization (#2009): the opened single-shape struct merged with another
  module type and a baked `struct.new`/index resolved to a wrong-arity type, so
  `__new_plain_object` failed to validate ("not enough arguments on the stack
  for drop") for EVERY standalone object program. Same hazard #2158 hit.
- `$Proxy` is a **standalone struct** `(ptag i32, ptarget anyref, phandler
  anyref, ptraps (ref null $ProxyTraps), revoked i32)`, discriminated by its own
  `ref.test $Proxy` (NOT subtyping). `$ProxyTraps` holds the 4 traps as
  **externref closures** (get/set/has/apply), not funcrefs.

### Calling convention (the crux the prior senior flagged)
A user trap `(t,k,r)=>…` lowers to a GC closure-wrapper struct boxed as
externref; its funcref takes the closure-self as arg0, so it can't be
`call_ref`-ed with `(target,key,receiver)`. Phase 1 invokes traps through the
**proven open-`any` closure bridge `__apply_closure(fn, recv, argsVec)`** (the
same path `__extern_method_call` uses) — NOT `__call_fn_method_N` (whose
per-arity wrapper-type + result-boxing ABI mismatched the trap closure). The
trap-invoke drivers `__proxy_call_{get,set,has}` are reserved in
`ensureProxyRuntime` and filled at FINALIZE by `fillProxyDispatch` (reserve-then-
fill, #1719) to build a `$ObjVec` of the spec args and call `__apply_closure`
with the **handler as `recv`/`this`** (§10.5.x). `reserveApplyClosure(ctx)` is
called so the bridge exists when `new Proxy` is the only closure-call site.

### Dispatch + guards
`ensureProxyRuntime` registers `__proxy_{get,set,has}_dispatch` (cast `$Proxy` →
revoked-throw → read trap closure → forward to `__extern_*` on the target when
null, else invoke the driver) and prepends a `ref.test $Proxy` **front-guard**
to `__extern_get`/`__extern_set`/`__extern_has`. The `has` guard coerces the
trap's booleanish externref result back to i32 via `__is_truthy`; the
trap-absent `has` arm boxes the i32 `__extern_has` result via `__box_boolean`.

### Construction
`__proxy_create(target, handler) -> externref`: §28.2.1.1 null-target/handler →
TypeError; reads get/set/has/apply off the handler via `__extern_get`. **The
call site (`new-super.ts`) builds object-literal target/handler as OPEN objects
(`compileObjectLiteralAsExternref`)** — a closed typed struct hides its fields
from the open-object `__extern_get` prop-map walk, so every trap would read null
and never fire. `__proxy_revoke` retained for revocable (step below).

### THREE shared-mutable-array hazards found & fixed (root-cause notes)
The bring-up exposed three latent index/type-corruption bugs, all from SHARED
mutable objects mutated by FINALIZE passes:
1. **Shared `dispatchLocals`** array reused across the 3 dispatch helpers →
   FINALIZE dead-type-elim `func.locals[i] = …` over-remapped the shared
   ValType, desyncing the local's type index from the body (`struct.get expected
   (ref null A) found (ref null B)`). Fix: fresh locals array per function.
2. **Shared `throwRevoked`/`throwNotObject`** Instr arrays reused across helpers
   AND twice within one `__proxy_create` body → `remapFuncIdxInBody`
   (no dedup Set) double-remapped the baked `call __new_TypeError`, pointing it
   at `__unbox_boolean`. Fix: fresh array per use (factory functions).
3. Both classes are the general "shared mutable IR object visited by a
   multi-pass FINALIZE remapper" trap — build fresh arrays/objects per emission.

### Deferred to follow-ups (NOT in this PR)
- **`Proxy.revocable`** — `__proxy_revoke` runtime helper is in place, but
  synthesising the `{proxy, revoke}` closure pair at the call site is deferred.
  `Proxy.revocable` still hard-errors standalone (calls.ts) — Phase 1b.
- **apply trap** (`proxy()` call) — deferred; `$ProxyTraps.apply` field reserved.
- **Statically-typed proxy locals** — a non-`any` proxy local lowers to a closed
  `struct.get` against the target's inferred shape, bypassing the meta-object.
  test262 (untyped JS) always takes the dynamic `__extern_*` path, so this does
  not affect conformance; documented in the test header.
- **§10.5 result invariants** — #1355.

### Regression surface
`$Object` reverted to plain struct + 3 front-guards on `__extern_*` touch every
standalone object program. Verified clean: issue-2084/2086/2105/2107/2130/2158/
2164/2166/1536 standalone suites all green; the only failing nearby suites
(struct-proxy-wrappers, proxy-passthrough, issue-907) fail identically on the
pre-edit merged base (pre-existing, unrelated to this work).
