---
id: 6790
title: "runtime: three process-lifetime registries leak or collide across instances — eval Worker handle maps (never released), name-keyed class-parent map, linked-provider registry that needs a manual reset the public API never calls"
status: ready
sprint: Backlog
created: 2026-09-30
updated: 2026-09-30
priority: high
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bug
area: runtime
language_feature: n/a
goal: platform
related: [3009, 5748]
requested_by: ttraenkler/claude-review
origin: "2026-09-30 codebase review (plan/agent-context/claude-codebase-review-2026-09-30.md) — H7/H9/H10"
---

# #6790 — state that should be per-instance is per-process

Three independent sites, one fix pattern: key by the instance (a `WeakMap`
on the exports/instance-state object the runtime already threads through),
never by name and never in a module-level strong `Map`/`Set`.

## 1. Node eval Worker handles are never released

- `src/runtime-node-eval-worker.ts:401` `handles.set(id, value)` (worker
  side) — no `delete` anywhere; `:276` `proxyByHandle.set(value.id, proxy)`
  (host side) — same. The `Request` union has no release/free/dispose op
  (grep confirms).
- A long-running host whose compiled program `eval`s expressions returning
  objects or functions retains every one of them in both threads until
  `terminate()`.
- Fix: a `release` request driven by a `FinalizationRegistry` on the host
  proxies, plus per-request scoping for handles that never escape the reply.

## 2. Class-parent registry is keyed by class **name**, process-wide

- `src/runtime/class-static-parent.ts:10-11`
  `classParentsByName = new Map<string, any>()`, `classParentLazy`; populated
  from `src/runtime.ts:6832` / `:6844` on every class declaration; no
  `clear()`/reset. The file's own comment (`:30-40`) admits the collision
  hazard for common names.
- Two instances in one process, each declaring `class C extends X` /
  `class C extends Y`: last registration wins for both; parents are retained
  for process life.
- Fix: `instanceState.classParents` (a `Map` inside the per-instance state
  object), the way `_subclassCtors` is already scoped via
  `instanceState.subclassCtors` (`src/runtime.ts:18525`).

## 3. Linked-provider registry requires a manual reset

- `src/linked-provider-runtime.ts:284` `registerLinkedProviderModule(rawExports)`
  into a strong `Set` (`src/runtime/cross-module-struct-owners.ts:33`).
  `src/runtime.ts:6432-6450` documents that a **second** project in the same
  process mis-decodes structs (`x instanceof C` → false) unless
  `resetLinkedProjectRegistry()` is called before instantiation. Only
  `scripts/test262-import-object.mjs:256` and two tests call it; no public
  API path does.
- Fix: `instantiateLinkedProviders` (or whatever the public entry is) scopes
  the registry per call / per instance; the reset export stays for tests.

## Acceptance

- A test instantiates two programs in one process: (a) both declare
  `class C extends <different base>` and each `super` call resolves to its own
  base; (b) both use linked providers and `instanceof` is correct in both
  without any reset call.
- Eval Worker: a loop of 10,000 `eval("({})")` calls keeps `handles.size`
  bounded (assert via a test-only introspection request or heap sampling).
- No module-level `Map`/`Set` keyed by a JS-visible name remains in
  `src/runtime/` (grep gate, or list the survivors with a reason).
