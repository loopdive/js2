---
id: 2623
title: "Promise capability-cluster: multi-hop host→wasm resolve-element callback cast + ctx-ctor species/prototype identity through the bridge"
status: backlog
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
