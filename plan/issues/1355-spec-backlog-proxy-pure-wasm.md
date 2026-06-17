---
id: 1355
title: "spec backlog: Proxy implementation beyond JS-host fallback (235 test262 fails)"
status: ready
created: 2026-05-08
updated: 2026-06-15
priority: top
feasibility: hard
reasoning_effort: high
task_type: feature
area: runtime, codegen
language_feature: proxy
goal: spec-completeness
sprint: 63
parent: 1334
depends_on: [1100]
note: "2026-06-15: elevated to TOP priority by stakeholder (Proxy/Promise/async-to-100% epic). Remaining 10 traps + invariant checks to drive Proxy past host-fallback toward 100% (standalone). Follows #1100 Phase 1. Needs architect spec."
---
# #1355 — Proxy: pure-Wasm implementation

## Problem

`built-ins/Proxy`: **67 / 311 pass (21.5%) — 235 fails (146 assertion_fail, 53 type_error,
22 null_deref, 7 wasm_compile, 4 runtime_error)**.

Currently Proxy is supported **only** in JS-host mode by forwarding to host's `new Proxy(target, handler)`.
This is sufficient for some tests but fails on:
1. Internal-method invariant checks (e.g. `[[GetPrototypeOf]]` trap return must match if target is non-extensible).
2. Tests that pass Wasm-typed objects as the target — host can't reflect into our struct.
3. `Proxy.revocable()` and revocation lifecycle — partial.

Spec §10.5 (Proxy Object Internal Methods) and §28.2 (Proxy constructor) require:
- 13 internal methods, each invoking a corresponding handler trap.
- Per-trap invariant validation (e.g. non-configurable property must remain present after [[GetOwnProperty]] trap).
- Constructor must throw if either target or handler is non-object.

## Acceptance criteria

1. `built-ins/Proxy/get/return-trap-result.js` passes.
2. `built-ins/Proxy/getOwnPropertyDescriptor/non-existent-property-throws.js` passes
   (invariant: trap reporting non-existent property must be discardable, not throw).
3. `built-ins/Proxy/ownKeys/return-not-list-object-throws.js` passes.
4. `built-ins/Proxy/revocable/return-is-object.js` passes.
5. Pass-rate for `built-ins/Proxy` rises from 21.5% to ≥75%.

## Implementation notes

A pure-Wasm Proxy needs a meta-runtime: each [[InternalMethod]] on a Proxy struct dispatches
to the trap if present, otherwise forwards to target's [[InternalMethod]]. This requires:

1. **Indirection on every property access**: every `Get`/`Set`/`HasProperty`/etc. site must
   first check `ref.test $Proxy` and divert to the trap-dispatcher. This has measurable
   perf cost on the fast (non-Proxy) path.
2. **Trap-dispatcher**: a runtime function per trap that calls handler[trapName] if defined,
   validates invariants, and either returns or forwards to target.
3. **Revoke list**: per-Proxy weak link to `revoke()` closure that nulls the target+handler.

This is feasibility:hard because every property-access in the codegen (~50 emitter sites)
needs the indirection. Mitigation: keep the indirection **only** when type inference cannot
prove the target isn't a Proxy; for typed locals where we know the type, skip the check.

## Files (eventual)

- `src/codegen/property-access.ts` — Proxy guard at every Get/Set
- `src/codegen/registry/proxy.ts` — `__proxy_dispatch_*` runtime helpers
- `src/runtime.ts` — Proxy.revocable, Proxy.constructor

## Dependency

Cascade-blocks Reflect.* invariant tests (#1346). Until landed, Proxy stays at host-mode only.

## Implementation Plan (architect, 2026-06-16; sequencing re-confirmed arch1 2026-06-16)

(Standalone/pure-Wasm. Builds on #1100 Phase 1. Adds the remaining 10 trap
dispatchers + full §10.5 invariant enforcement; drives standalone
`built-ins/Proxy` from ~21% to ≥75%. Host-mode companion is #2180.)

### BLOCKED — hard dependency on #1100 (verified against upstream/main 319d43460)
The standalone substrate this plan extends **does not exist on main yet**:
`grep` for `$Proxy` / `$ProxyTraps` / `registerProxyType` / `__proxy_*_dispatch`
in `src/codegen/object-runtime.ts` and `src/codegen/registry/proxy.ts` returns
nothing — `src/codegen/registry/proxy.ts` is not created, and the only `__proxy`
references are the **host-mode** path in `runtime.ts`/`calls.ts`. #1100
(`status: ready`, senior-dev WIP on a branch per s63 task #21) lands
`$Proxy` + `$ProxyTraps` + get/set/has/apply + revocable. **Do NOT dispatch
#1355 until #1100 has merged to main** — every section below presumes
`$ProxyTraps` (the 4 base trap fields) and the standalone Proxy struct exist.
When #1100 lands, re-grep to confirm the field layout of `$ProxyTraps` and the
`$Proxy` struct before extending — coordinate the 9 added funcref fields with
whatever #1100 shipped (append, do not renumber the base 4).

Also note `$PropEntry` exists (`object-runtime.ts:16`) but the
descriptor-attribute bits (configurable/writable/enumerable) needed for §10.5
invariant enforcement may not be present — verify and extend per the Invariant
section below, coordinating with #797/#1460/#1462.

### Root cause / gap

#1100 lands `$Proxy`/`$ProxyTraps` + get/set/has/apply with only the
revoked-proxy invariant. The 235 standalone fails (146 assertion_fail,
53 type_error, 22 null_deref, 7 wasm_compile, 4 runtime_error) are dominated by
(1) the 10 missing traps and (2) missing §10.5 invariant checks.

### Architecture

Extend `$ProxyTraps` (object-runtime.ts) with 9 more funcref fields
(deleteProperty, ownKeys, getOwnPropertyDescriptor, defineProperty,
getPrototypeOf, setPrototypeOf, isExtensible, preventExtensions, construct).
Add one `__proxy_<trap>_dispatch` runtime helper per trap, each shaped:
(1) revoked→throw; (2) read trap funcref; (3) null→forward OrdinaryX on target;
(4) call_ref trap; (5) coerce result to spec type; (6) ENFORCE the §10.5
invariant(s)→TypeError on violation; (7) return.

### Wire operators / builtins
`property-access.ts` + `calls.ts`: `delete proxy.x`→deleteProperty;
`Object.keys/getOwnPropertyNames/getOwnPropertySymbols`/for-in/spread→ownKeys;
`Object.getOwnPropertyDescriptor`→getOwnPropertyDescriptor;
`Object.defineProperty`→defineProperty; `Object.getPrototypeOf`/`__proto__` read→
getPrototypeOf; `Object.setPrototypeOf`/`__proto__` write→setPrototypeOf;
`Object.isExtensible`→isExtensible; `Object.preventExtensions/seal/freeze`→
preventExtensions; `new proxy(...)`→construct. The standalone `Reflect.*` path
(calls.ts:5411-5540) must also route through these when `ref.test $Proxy`
succeeds (today it bypasses to `__extern_*`/`__object_keys`).

### Invariant enforcement (§10.5 — implement from fetched spec text)
§10.5.5 [[GetOwnProperty]], §10.5.6 [[DefineOwnProperty]], §10.5.7
[[HasProperty]], §10.5.8 [[Get]], §10.5.9 [[Set]], §10.5.10 [[Delete]], §10.5.11
[[OwnPropertyKeys]] (List of String/Symbol, no dups, includes non-configurable
keys; non-extensible→exactly target keys), §10.5.1/2 [[GetPrototypeOf]]/
[[SetPrototypeOf]], §10.5.3/4 [[IsExtensible]]/[[PreventExtensions]], §10.5.13
[[Construct]]. Needs a standalone descriptor model — coordinate with
#797/#1460/#1462; extend `$PropEntry` (object-runtime.ts:202) with
configurable/writable/enumerable attribute bits first if absent.

### Standalone vs host scoping
Standalone only. Host (#2180) gets invariants free from the engine. Keep §10.5
invariant predicates + trap-name list in one shared module
(`src/codegen/registry/proxy.ts`) as single source of truth.

### Edge cases
ownKeys non-array/non-String-or-Symbol/dups→TypeError;
getOwnPropertyDescriptor of non-existent on non-extensible→undefined (not throw);
defineProperty partial-descriptor reconciliation; proxy-of-proxy recursion;
symbol keys through every key-taking trap; construct only when target has
[[Construct]].

### Test-gate plan (test262)
≥75% non-skipped `built-ins/Proxy` standalone. Gate
`built-ins/Proxy/get/return-trap-result.js`,
`getOwnPropertyDescriptor/non-existent-property-throws.js`,
`ownKeys/return-not-list-object-throws.js`, `revocable/return-is-object.js`, and
all `built-ins/Proxy/{deleteProperty,ownKeys,getOwnPropertyDescriptor,defineProperty,getPrototypeOf,setPrototypeOf,isExtensible,preventExtensions,construct}/**`;
`tests/issue-1355.test.ts`. Regression: standalone equivalence green; host #2180
unchanged.

### Dependencies / risks
depends_on #1100 (hard prereq); #797/#1460/#1462 descriptor attributes;
cascade-unblocks standalone `Reflect.*` invariants (#1346). Implement strictly
from fetched §10.5 spec text, cite the section in each helper + commit.
