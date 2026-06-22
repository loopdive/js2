---
id: 2615
title: "Proxy (host): a `new Proxy` result typed as its target's struct causes every read through the proxy to trap (~32+ fails)"
status: done
sprint: 65
created: 2026-06-22
updated: 2026-06-22
completed: 2026-06-22
assignee: ttraenkler/agent-acc861f0e7aea64c8
priority: top
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: proxy
goal: spec-completeness
parent: 1355
related: [2180]
test262_bucket: proxy-get-read-through-host-proxy
---
# #2615 — Proxy (host): `new Proxy` result must be storage-typed `externref`, not the target's struct type

Slice of #1355. The single highest-leverage host-mode Proxy bug: it made
*every* property READ through a Proxy trap at runtime, which is why the
`built-ins/Proxy/get/**` directory and many read-through tests failed. Fixing it
unblocks acceptance criterion #1 of #1355 (`built-ins/Proxy/get/return-trap-result.js`).

## Root cause

`new Proxy(target, handler)` codegen (`src/codegen/expressions/new-super.ts`)
correctly returns `{ kind: "externref" }` (host) / the native `$Proxy` externref
(standalone). **But a Proxy carries no TypeScript-type brand** — `ProxyConstructor`
is typed to return its TARGET type `T`, so the checker types
`const p = new Proxy(t, h)` as `T` (the object-literal struct of `t`). The
receiving local was therefore slotted as the target's WasmGC struct `(ref null N)`.
The Proxy externref is coerced into that struct slot with `any.convert_extern`
+ `ref.test (ref N)`, which **fails** for a host/native Proxy (it is not that
struct) → the value becomes `ref.null N`, and the subsequent `p.attr` lowers to a
direct `struct.get N 0` on the null/struct local → an empty-message Wasm trap.
(`"k" in p` worked only because it routes via `__extern_has`, never `struct.get`.)

This is the `project_proxy_no_ts_type_brand` memory in concrete form.

## Fix

`src/codegen/statements/variables.ts` — mirror the existing `isBindHostCall` /
`isPromiseHostCall` slot-type overrides. Added `isProxyConstruction(expr)` and
forced the variable's storage ValType to `externref` for a `new Proxy(...)`
initializer, so member reads/writes/has/delete lower through the dynamic
boundary helpers (`__extern_get` / `__extern_set` / `__extern_has`) — the only
paths that run the Proxy MOP / trap. Two sites:
1. The `wasmType` computation (the override chain) — fresh slots.
2. The pre-hoisted-slot retype guard (`let`/`const` are pre-allocated by
   `hoistLetConstWithTdz` as the struct ref) — narrowing ref → externref is
   safe here (the hoist pass emits no init for ref locals), same rationale as
   the accessor-literal branch.

Mode-agnostic: both host and standalone emit a Proxy externref, so both get the
override.

### NARROWING (merge_group regression fix)

The first attempt forced externref for **every** `new Proxy(...)` result. That
over-applied and regressed 6 test262 rows in the merge_group (PR-level checks
green, merged-state −1 net): `Object/prototype/toString/proxy-array`,
`Proxy/getPrototypeOf/trap-is-undefined-target-is-proxy`,
`Array/prototype/copyWithin/return-abrupt-from-has-start`, and two
`Object/getOwnPropertySymbols/proxy-invariant-*`. Root cause: when the Proxy is
handed to a host **generic-method / global** (`Object.prototype.toString.call(p)`,
`Object.getPrototypeOf(p)`, `Array.prototype.X.call(p, …)`), a struct-typed slot
let the host introspect the target (IsArray, prototype identity, the
Array.prototype.* spec walk); a bare externref Proxy takes a different host path
that loses Array-ness / prototype identity.

So the override is now gated by `proxyResultEscapesToCall(decl, name)`: it fires
**only when the Proxy stays local and is used purely in member position**
(`p.x` / `p[k]` / `delete p.x` / `k in p`). If the variable appears as a
call/new **argument** or a `.call`/`.apply` first-arg (the `this`), the struct
typing is kept and the host generic-method path keeps working. The keystone
read-trap fix still lands for the common direct-read case.

## Test Results (local harness, gc mode, via `wrapTest` + `compileAndInstantiate`)

Whole `built-ins/Proxy` directory (NARROWED): baseline **78 pass / 181 err** →
**83 pass / 173 err** (net **+5 pass**). The 6 merge_group regressions all pass
again (verified file-by-file: 5 PASS, 1 pre-existing ERR on baseline too).
`built-ins/Reflect`: identical 82/19/52 (no regression).

Acceptance: `built-ins/Proxy/get/return-trap-result.js` now PASSES (was an
empty-message trap).

Dedicated equivalence test: `tests/issue-2615.test.ts` (8 cases — get-trap read,
read-through-no-trap-no-longer-traps, `in`, set, delete, set-trap, plus two
WAT-level narrowing guards: escaping Proxy keeps struct slot / member-only Proxy
is externref) all pass.

The closed-struct read-through value (`trap-is-undefined.js` returning the
target's actual field for a non-`any` target) and the
`return-trap-result-accessor-property.js` `Object.defineProperty(target,…)`
interaction remain deferred — they need host introspection of a closed WasmGC
struct target and are out of scope for this slice (folded into the broader #1355
read-through-to-struct-target work). Both were already non-pass on `main`.

## Scoped checks

`tsc --noEmit` clean · `prettier --check src/**/*.ts` clean ·
`tests/issue-2615.test.ts` 6/6 pass · existing `proxy-passthrough` /
`struct-proxy-wrappers` / `anon-struct` failures are pre-existing on `main`
(identical sets), not regressions.
