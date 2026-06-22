---
id: 2616
title: "Proxy (host): present-but-non-callable trap is silently dropped instead of throwing TypeError (~19 fails)"
status: done
sprint: 65
created: 2026-06-22
updated: 2026-06-22
completed: 2026-06-22
assignee: ttraenkler/agent-acc861f0e7aea64c8
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: proxy
goal: spec-completeness
parent: 1355
related: [2180, 2615]
test262_bucket: proxy-trap-not-callable
---
# #2616 — Proxy (host): a present non-callable / non-undefined trap must throw TypeError

Slice of #1355; stacked on #2615 (needs the externref Proxy slot so reads reach
the bridge). Per §10.5 each internal method does `trap = GetMethod(handler,
"<trapName>")`; §7.3.10 GetMethod throws a **TypeError** when the property is
present but not callable (it returns `undefined` only for `undefined`/`null`).

## Two-part root cause (re-grounded against current main, #2615 on branch)

1. **TS-checker hard error (the real blocker, not in the original spec).**
   `new Proxy({}, { get: {} })` — the test262 source itself — fails TS2322
   (`Type '{}' is not assignable to type ProxyHandler<T>['get']`) **before
   codegen**, so the runtime path is never reached. All 14
   `*/trap-is-not-callable.js` tests were hard compile errors.
2. **Runtime bridge silently omits** a present-non-callable trap.
   `_buildProxyBridgeHandler` (`src/runtime.ts`) did
   `if (typeof callable !== "function") continue;`, so the bridge had no trap,
   the host engine used ordinary behavior, and the spec TypeError never fired.

## Fix

1. **`src/compiler.ts`** — `isProxyHandlerTrapDiagnostic(diag)`: downgrade a
   TS2322 raised on a trap value **inside the handler (2nd) argument of a
   `new Proxy(...)`** so the program compiles (and throws at runtime). Tightly
   scoped — a non-Proxy 2322 still hard-errors (verified). The downstream
   2339/2349 ("property/call on the target type") are already non-hard.
2. **`src/runtime.ts`** — `_buildProxyBridgeHandler`: for a present-but-non-
   callable trap, install a bridge trap that **throws a host TypeError on
   invocation**. The throw surfaces at operation time (`p.attr` / `p(...)` /
   `new p(...)`) and propagates through the Proxy MOP + lastCaughtException
   bridge so `e instanceof TypeError` holds in the compiled program. Absent
   (`undefined`/`null`) traps still omit → host forwards to target (correct).

## Test Results (local harness, gc mode)

`trap-is-not-callable.js` + `null-handler.js` corpus (26 files): incremental
over #2615-only **5 pass / 14 err → 11 pass / 1 err** (+6 pass, −13 compile
errors). `get/construct/defineProperty/getOwnPropertyDescriptor/isExtensible/
setPrototypeOf` `trap-is-not-callable` now pass.

Whole `built-ins/Proxy` directory (this branch = #2615 + #2616): **82 → 106
pass** (+24 over #2615-alone; +28 over pure main), err **166 → 113**. The TS
suppression unblocked many Proxy tests that contained non-callable trap literals,
not just the 6 trap-is-not-callable rows. `built-ins/Reflect`: identical
82/19/52 (no regression).

`tests/issue-2616.test.ts` (5 cases) all pass.

## Scope / deferred residual

`set` / `has` / `deleteProperty` / `getPrototypeOf` / `ownKeys` /
`preventExtensions` `trap-is-not-callable` still FAIL(2): those operations route
through `__extern_set` / `__extern_has` / `__delete_property` / etc., which don't
consult the bridge handler the way the real JS-Proxy get-path does — they need
the boundary helpers to surface the non-callable TypeError (overlaps #2617). The
`null-handler.js` cases are revoked-proxy tests (#2617 territory, mis-bucketed in
the spec). `apply`/`construct` non-callable need the call path (#2618).

## Scoped checks

`tsc --noEmit` clean · `prettier --check` clean · `tests/issue-2616.test.ts` 5/5
· non-Proxy 2322 still hard-errors (scope guard) · Reflect unchanged.
