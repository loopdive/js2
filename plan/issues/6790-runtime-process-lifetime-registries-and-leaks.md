---
id: 6790
title: "runtime: three process-lifetime registries leak or collide across instances — eval Worker handle maps (never released), name-keyed class-parent map, linked-provider registry that needs a manual reset the public API never calls"
status: done
sprint: Backlog
assignee: "ttraenkler/claude-dev-6790"
branch: "claude/issue-6790-runtime-registries"
created: 2026-09-30
updated: 2026-10-02
completed: 2026-10-02
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

## Implementation Plan

One commit per part, so each can be bisected on its own.

1. **Eval Worker handles** (`src/runtime-node-eval-worker.ts`).
   - Host side: `proxyByHandle` holds `WeakRef`s, and every proxy `decode`
     mints is registered with a `FinalizationRegistry` keyed by its handle id.
   - When a proxy is collected, its id is queued. The queue is flushed as one
     `{ op: "release", handles }` message, by microtask and also at the start
     of every `request()`, so a release always reaches the Worker before any
     later request.
   - `release` is not a `Request`: it has no id and gets no reply. A reply
     would land in the next request's synchronous loop as a desynchronized
     packet.
   - A finalizer whose id a newer live proxy has re-minted does nothing.
   - Worker side: `release` deletes the handle and its object→id entry. If
     the same object is encoded again it gets a fresh id. Ids are never
     reused, so a stale or duplicate release is a no-op.
2. **Class-parent registry** (`src/runtime/class-static-parent.ts`,
   `src/runtime.ts`).
   - The two module-level name-keyed maps became a `ClassParentRegistry`
     class (`register` / `registerLazy` / `remember` / `get`). The #5280
     null-heritage semantics carry over unchanged.
   - `buildImports` creates one per instance (`instanceState.classParents`,
     next to `subclassCtors`). `classParentsFor(state)` returns it.
   - The `__register_class_parent`, `__register_class_parent_ref` and
     `__call_dynamic_class_parent_N` imports each use their own instance's
     registry.
   - `__register_class_ctor` links each class object to that registry
     (`registerClassObject(obj, name, registry)`). Lookups that start from
     the object — `resolveClassStaticParent`, and the constructible mirror's
     `resolveParent` through `classParentOf(obj, name)` — therefore never
     consult another instance.
   - The property-access resolver (`_classParentRefResolver`) now only
     resolves. Memoization stays in `get`, as before.
3. **Linked-provider registry** (`src/runtime/cross-module-struct-owners.ts`,
   `src/runtime.ts`, `src/linked-provider-runtime.ts`).
   - Modules are grouped into projects: `beginProject(root)`, and
     `registerModule(exports, root?)`, which joins `root`'s project or else
     the newest one.
   - Reads go through `projectFor(local)`. That is local's own project; for
     an `Object.create(rawExports)` host-bridge view, its prototype's
     project; for an unknown reader, the newest project. A project with fewer
     than two modules answers nothing, which keeps the old `enabled`
     semantics per project.
   - A module that is already registered stays in its project, because
     `wrapLinkedProviderValue` re-registers providers on every crossing.
   - `instantiateLinkedProviders` calls `beginLinkedProject(rootImports)` and
     registers its providers with that root. `wireCompiledInstance` registers
     the consumer with the same `imports` object.
   - `resetLinkedProjectRegistry` stays, for the test262 seam and tests. No
     other caller needs it.
   - A test lists every remaining module-level `Map`/`Set` in `src/runtime/`
     together with its reason, so a new process-wide registry fails it.

## Resolution

Probes are in the worktree's `.tmp/`. Each "Before" figure was measured on
`origin/main` sources at `401a90a7e0`, the merge base.

| Probe | Before | After |
| --- | --- | --- |
| `probe-6790-evalworker.mts`: 10,000 `eval("({})")` through `connectNodeEvalWorker`, host and Worker garbage-collected | 10,000 host proxies and 10,000 Worker objects alive | 1 and 1 |
| `probe-6790-classparent2.mts`: one binary instantiated twice, `class C extends NS.Base`, with base A and then base B | `A.tag` = "B" (A's `new C()` ran B's constructor); `A.staticWho` = "B" | `A.tag` = "A", `B.tag` = "B", `A.staticWho` = "A", `B.staticWho` = "B" |
| `probe-6790-registry.mts`: the public instantiate path replayed for two projects of one provider binary, no reset | project 2's consumer decodes `struct2` via **provider1**; its peers are project 1's modules plus provider2 | via provider2; peers `[provider2]`; project 1 still decodes via provider1 |
| `probe-6790-linked.mts`: two live `instantiateLinkedProject` results from one compile, no reset | all reads correct | all reads correct (unchanged) |

The last row cannot show a difference. As #5364 measured, a small provider
never reaches the registry's cross-project arm; only the Temporal polyfill's
surface does. So the base-failing check for part 3 is the registry replay,
and the integration test guards against regressions.

**Tests.** `tests/issue-6790-runtime-registries.test.ts` has 12 tests:

- Part 1, 3 tests. The 10,000-eval bound fails on base ("expected 10000 to
  be less than 10"). Two guards check that a released object comes back
  under a fresh handle and that a held proxy is never released.
- Part 2, 2 tests, both failing on base ("expected 'B' to be 'A'"): two
  instances of one binary, and two different programs that declare the same
  `C`.
- Part 3, 6 tests: five registry tests (own project with no reset, project 1
  still live, the view object, re-registration after a newer project
  opened, an unknown reader) and one integration test with two live linked
  projects and no reset.
- The `src/runtime/` module-level `Map`/`Set` inventory.

`tests/issue-5280-class-parent-null-heritage.test.ts` was ported to the
registry class; its semantics are unchanged.

**Gates**, after merging `origin/main` (`4a7cb0dc96`, which includes #6791).
Every one exited 0:

- check-loc-budget and check-func-budget, against both the merge base and
  `LOC_GATE_BASE=origin/main`
- check-coercion-sites, check:oracle-ratchet, check:dead-exports
- typecheck, format:check, and the compiler-boundaries inventory
- every gate in the agent brief's loop, from ir-dialect through lint
- check:ir-fallbacks
- test:guard: 20 files, 255 tests

No budget allowance was needed: `runtime.ts` and `resolveImport` did not grow
past their ceilings once the registry plumbing moved into
`class-static-parent.ts`.

**Vitest**, single fork:

- Passing: issue-6779 (11), issue-6790 (12), runtime-host-eval-isolation
  (7), issue-5280 (6), issue-6791 (5), issue-5379 (5), and an 11-file
  class-heritage batch (60 tests: 4618 bridges, 4371, 5195-r3, 6640, 6644 ×2,
  6767, regexp static inheritance, 5280, 6790).
- All 67 test files that use the linked-provider registry were run. Their
  14 failures across 9 files reproduce identically on the base sources, so
  none is caused by this change:
  - 5364 (1) and 5738 (4): `scripts/test262-import-object.mjs`
    `providerModuleFor` → "WebAssembly.Module(): Argument 0 must be a buffer
    source".
  - 5226 (1) and 5363 (1): an uncaught provider throw reaches the host as a
    `WebAssembly.Exception` instead of the original error.
  - 5383 S2i (1), 6609 (1), 6612 (1), 5373 (1) and 5376 (3).
- `issue-4618-scoped-same-name-classes` "fncount=NaN" also fails on base.

**Survivors** of the "no module-level name-keyed `Map`/`Set` in
`src/runtime/`" criterion. Both are pinned by the inventory test:

- `init-marshal-registry.ts::_classDispatchNameLists` is a memo from a
  compiler-emitted CSV to its split list. The value is a pure function of the
  key, so two instances cannot disagree.
- `string-predicate-adapter.ts::HOST_STRING_SYMBOL_DISPATCH` is a constant.

`src/runtime.ts`'s `_subclassCtors` and `_userClassParents` lie outside that
directory. They are reached only when no `instanceState` is threaded, which
`buildImports` never does.

**Deliberately left out.** The eval Worker's host-side `bindingById` map
(reified direct-eval binding id → binding) still grows by one entry for each
fresh activation cell. A binding can escape its request: a closure created by
`eval` can capture the binding scope and read it later. Releasing bindings
safely therefore needs a Worker → host release that knows which request it
applies to. That is a separate protocol change and is not covered by this
issue's acceptance criteria.
