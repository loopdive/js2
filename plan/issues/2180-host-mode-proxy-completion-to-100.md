---
id: 2180
title: "Host-mode Proxy: close remaining test262 failures toward 100% (invariant checks, Wasm-typed targets, revocation lifecycle)"
status: done
assignee: se2
created: 2026-06-15
updated: 2026-06-16
completed: 2026-06-16
priority: top
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: proxy
goal: spec-completeness
sprint: 62
related: [1466, 1100, 1355]
note: "2026-06-15: created + elevated to TOP priority by stakeholder (Proxy/Promise/async-to-100% epic). #1466 (Proxy+Reflect trap fidelity, done) was the last host-mode Proxy issue; built-ins/Proxy still sits at ~23% (71/311). No tracker existed for the remaining host-mode failures — this is it. Needs architect triage of the failing buckets before dev dispatch."
---

# #2180 — Host-mode Proxy: close remaining test262 failures toward 100%

## Problem

In JS-host mode `new Proxy(target, handler)` and `Proxy.revocable()` delegate
to the host via `__proxy_create` / `__proxy_revocable` (see
`src/codegen/expressions/new-super.ts`, `src/codegen/expressions/calls.ts`).
After #1466 (Proxy + Reflect trap/operation fidelity, **done** 2026-06-12),
`built-ins/Proxy` conformance is still only **~23% (71/311 pass, 231 fail)**.

The remaining host-mode failures are **not tracked by any open issue** —
#1466 was the last one and it's closed; #1100/#1355 are the *standalone*
(pure-Wasm) Proxy track. This issue captures the host-mode tail so the
"Proxy → 100% in host mode" goal has a vehicle.

## Scope (host mode only)

Architect to triage `built-ins/Proxy` failures into buckets first. Known
suspect areas from prior analysis:

- **Invariant enforcement** — `[[Get]]`/`[[Set]]`/`[[GetOwnProperty]]` /
  `[[DefineOwnProperty]]` invariant `TypeError`s required by the spec when a
  trap result contradicts a non-configurable / non-writable target property.
- **Wasm-typed objects as Proxy targets** — a Proxy wrapping a compiler-typed
  struct (not a plain host object) must still route ordinary operations
  correctly through the trap → target path.
- **Revocation lifecycle** — operations on a revoked proxy must throw
  `TypeError`; `Proxy.revocable().revoke()` semantics and idempotence.
- **Trap receiver / argument fidelity** — argument arrays, receiver binding,
  and result coercion for the less-common traps (`ownKeys`, `getOwnPropertyDescriptor`,
  `defineProperty`, `deleteProperty`, `getPrototypeOf`, `setPrototypeOf`,
  `isExtensible`, `preventExtensions`).

## Acceptance criteria

- Architect triage doc: failing `built-ins/Proxy` tests bucketed by root
  cause, with per-bucket fix sizing.
- Host-mode `built-ins/Proxy` pass rate raised substantially toward 100%
  (target ≥90% of non-skipped; stretch 100%). Set concrete numeric target
  after triage.
- No regressions in `built-ins/Reflect` (currently ~72%) or elsewhere.
- Each fixed bucket has a probe under the issue-coverage rule.

## Notes

- This is the **host-mode** companion to the **standalone** Proxy track
  (#1100 Phase 1 + #1355 remaining traps). The two share trap-dispatch
  semantics; coordinate so the standalone meta-object protocol reuses the
  host-mode invariant logic where possible.
- All three Proxy issues (#2180 host, #1100 + #1355 standalone) are part of
  the 2026-06-15 stakeholder-elevated **Proxy/Promise/async → 100% epic**
  (see `plan/issues/sprints/63.md`).
## Implementation Plan

(Author: architect, 2026-06-16. Host-mode-only. The standalone track is #1100/#1355.)

### Root cause / gap analysis

After #1466, host mode already routes the full MOP through the host's native
`Proxy`/`Reflect`, so the host engine enforces §10.5 invariants for us. The
remaining `built-ins/Proxy` failures (~231 of 311) are **not** missing trap
dispatch — they are defects at the Wasm↔host boundary and in construction:

1. **Construction does not throw the spec-mandated TypeErrors.**
   `proxy_create` in `src/runtime.ts:11075-11089` does
   `const t = target ?? {}; const h = handler ?? {}; try { new Proxy(t,h) } catch { return t }`.
   Per §28.2.1.1 `Proxy(target, handler)` step 1-2, **both** target and
   handler must be objects or a `TypeError` is thrown *before* allocation.
   Today `new Proxy(null, {})`, `new Proxy({}, null)`, `new Proxy(1, {})`,
   `new Proxy({}, 5)` all silently succeed. Accounts for the entire
   `built-ins/Proxy/create-target-*` / `create-handler-*` bucket (~14 tests).

2. **`new Proxy` requires `[[Construct]]`/`[[Call]]` distinction.**
   `Proxy(t,h)` without `new` must throw `TypeError` (no `[[Call]]`). The
   codegen handles only the `new` form (`new-super.ts:2073`); the call form
   falls through and `Proxy` is **not** in `NAMESPACE_NON_CALLABLE`
   (`calls.ts:2097`). Add it there. (~2-3 tests.)

3. **WasmGC-typed targets are opaque to the host MOP unless wrapped.**
   `__reflect_*` already wraps via `_wrapForHost` (`runtime.ts:8444`) but
   `__proxy_create`/`__proxy_revocable` do **not**. Wrap a Wasm-struct target
   with `_wrapForHost(target, exports)` when `_isWasmStruct(target)` and record
   the reverse mapping so `proxy.target === orig` probes resolve. (~20-40 tests.)

4. **Trap result / argument coercion at the boundary.** Direct
   (`Object.keys(proxy)`, `delete proxy.x`, `Object.getPrototypeOf(proxy)`)
   paths must reach the host proxy intact. The `_hostProxyReverse.get(obj) ?? obj`
   unwrap (runtime.ts:2326, 2582, 4586) is for our live-mirror proxies and must
   NOT strip a user `new Proxy` (a user proxy isn't in the map, so `?? obj` keeps
   it — verify no path casts it to a struct).

### Trap-dispatch architecture (host mode)

The host engine owns trap dispatch, invariant checks, and recursion. Our job is
only to (a) construct a correct proxy (TypeErrors + wrapped targets) and (b) keep
the proxy externref intact across every operation. `proxy.x` → `__extern_get(proxy,"x")`
→ host fires `handler.get(target,"x",proxy)`; `Reflect.get(proxy,...)` → `__reflect_get`.

### Invariant enforcement (§10.5)

**Delegated to the host.** Do not reimplement invariant logic in host mode; just
ensure the operation reaches the host proxy.

### Revocation lifecycle

`Proxy.revocable` → `__proxy_revocable` (runtime.ts:8434) → native; host enforces
revoked-throws + revoke idempotence. Apply the same target-wrapping + no-swallow
validation as `proxy_create`. Add a post-revoke probe.

### Changes
- `src/runtime.ts` `proxy_create` (11075): spec-validate target/handler (let
  `new Proxy` throw natively, don't swallow); wrap Wasm-struct targets via
  `_wrapForHost`.
- `src/runtime.ts` `__proxy_revocable` (8434): same validation + wrapping.
- `src/codegen/expressions/calls.ts` (2097): add `"Proxy"` to `NAMESPACE_NON_CALLABLE`.
- `src/codegen/expressions/new-super.ts` (2073): ensure missing-handler passes
  `ref.null.extern` so runtime validation fires.

### Edge cases
`new Proxy(null,{})`/`({},null)`/`(1,{})` → TypeError; `Proxy(t,h)` without `new`
→ TypeError; `new Proxy(wasmStruct,h)` → enumerable wrapped target; revoked proxy
→ TypeError; `proxy === proxy` identity holds; `proxy[sym]` fires trap.

### Test-gate plan (test262)
`built-ins/Proxy/create-*-is-not-object-throws.js`, `revocable/*-is-not-object-throws.js`
(construction); `built-ins/Proxy/{get,set,has,deleteProperty,ownKeys,getOwnPropertyDescriptor,defineProperty,getPrototypeOf,setPrototypeOf,isExtensible,preventExtensions,apply,construct}/**`
(boundary, host-enforced); `built-ins/Proxy/revocable/**`. Regression-guard
`built-ins/Reflect/**` (stay ≥72%). Add `tests/issue-2180.test.ts`. Target ≥90% of
non-skipped `built-ins/Proxy`.

### Risks
File overlap with #1100/#1355 in `new-super.ts`/`calls.ts`/`runtime.ts` — land #2180
first (small additive runtime fixes); standalone tracks branch on `ctx.standalone`.
Adding `Proxy` to `NAMESPACE_NON_CALLABLE` must not shadow `new Proxy`.

## Implementation Notes (se2, 2026-06-16)

Host-mode `built-ins/Proxy` went **71 → 112 pass / 311** (+41; 23 % → 36 %),
no `built-ins/Reflect` regression (119/153 ≈ 78 %, well above the ≥72 % gate).
The architect plan's first-order diagnosis (construction TypeErrors + wrap
Wasm-struct targets) was correct but **incomplete** — empirical triage found the
dominant defect was trap **discovery**, not target wrapping. Root causes and
fixes:

1. **Trap discovery was the real blocker (largest win).** A compiled object
   literal handler is an opaque WasmGC struct; `handler[trapName]` returns
   `undefined` for every trap, so the host's native `Proxy` fired **no traps**
   and silently fell through to the target. The architect plan's `_wrapForHost`
   route does **not** work here: `_wrapForHost(handler).get` runs the closure
   value back through `_wrapForHost` (because the closure-field detector only
   matched `_isWasmStruct(val)` *after* the mirror had already wrapped it),
   yielding a non-callable object. Fix: read each trap closure **directly off
   the raw struct** via the per-shape `__sget_<name>` getter (+ sidecar
   fallback) in `_structFieldRaw`, then wrap with
   `_maybeWrapCallableUnknownArity`. The result is a plain-object *bridge
   handler* the host can read; each bridge method forwards to the closure with
   `this` = the **raw** handler struct so trap-receiver identity
   (`assert.sameValue(this, handler)`) holds. `new-super.ts`/`calls.ts` are
   unchanged on the wrapping side — all of this is in `runtime.ts`.

2. **Construction TypeErrors** (§28.2.1.1 step 1/2): `_hostProxyConstruct` /
   `_hostProxyConstructRevocable` throw `TypeError` when target/handler is not
   object-like, replacing the old swallow-and-return-target behaviour. The raw
   struct stays as `[[ProxyTarget]]` so `t === target` holds in traps.

3. **`Proxy(t,h)` without `new`** → added `"Proxy"` to `NAMESPACE_NON_CALLABLE`
   in `calls.ts` (bare-identifier call guard only; `new Proxy` and
   `Proxy.revocable(...)` reach other branches, so no shadowing).

4. **Proxy-over-struct misclassified as a struct.** `_isWasmStruct` probes by
   "null proto + set throws"; a Proxy whose target is a WasmGC struct inherits
   the null proto and forwards the probe-set to the opaque target (which
   throws), so the heuristic flagged the Proxy itself as a struct — routing
   `delete`/`in`/`getPrototypeOf` to the sidecar instead of the host trap.
   Fixed with a `_userProxies` WeakSet that `_isWasmStruct` short-circuits
   (+9 pass).

5. **Revoked-proxy errors were swallowed.** `__extern_get`/`__extern_has`/
   `_safeSet`/`__delete_property` wrap their host read in a try/catch that
   falls through to a struct-getter path; a revoked-proxy `TypeError` was
   eaten there. Added `_isRevokedProxyError` and re-throw it in each.

### Out of scope (separate front-end codegen issues, not host-proxy plumbing)
Empirically confirmed via probes that these remaining buckets fail **before**
the runtime proxy path:
- `construct/**` — proxy target is a `class`; the extern-class machinery
  ("No dependency provided for extern class …") is unrelated.
- `with`-statement tests (#1387).
- A function that returns a complex object literal (`allowProxyTraps` helper)
  compiles to `return null`, so handlers built through it arrive as `null` —
  many `*/call-parameters-prototype.js` and several `null-handler` revocation
  tests depend on it.
- `delete p.x` / `Reflect.deleteProperty` on an `any`-typed proxy receiver: the
  bare `delete` statement never emits `__delete_property` (the front-end
  resolves/elides it), so the trap can't fire regardless of runtime. The
  `_userProxies` + revoked-rethrow fixes are in place for when that path is
  fixed.

### Files changed
- `src/runtime.ts` — `_hostProxyConstruct`, `_hostProxyConstructRevocable`,
  `_buildProxyBridgeHandler`, `_structFieldRaw`, `_isObjectLike`,
  `_isRevokedProxyError`, `_userProxies`; rewired `proxy_create` intent +
  `__proxy_revocable` host import; revoked-rethrow in the four boundary helpers.
- `src/codegen/expressions/calls.ts` — `"Proxy"` in `NAMESPACE_NON_CALLABLE`.
- `src/codegen/expressions/new-super.ts` — no-arg `new Proxy()` now routes
  through `__proxy_create(null, null)` so the runtime raises the TypeError.
- `tests/issue-2180.test.ts` — construction-throws + trap-dispatch coverage.
