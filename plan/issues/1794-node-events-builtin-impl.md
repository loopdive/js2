---
id: 1794
title: "node:events / EventEmitter — host class + closure-callback contract"
status: done
completed: 2026-07-16
assignee: ttraenkler/fable-s2
sprint: current
created: 2026-06-03
updated: 2026-07-16
loc-budget-allow:
  - src/runtime.ts
  - src/import-resolver.ts
  - src/codegen/registry/imports.ts
priority: high
feasibility: hard
reasoning_effort: high
task_type: feature
area: host-interop
language_feature: node-builtins
goal: npm-library-support
parent: 1575
related: [1044, 1032, 1382, 983, 640]
---

# node:events / EventEmitter — host class + closure-callback contract

## Problem

`EventEmitter` is the universal Node IO primitive — `fs.createReadStream`,
`http.IncomingMessage`, and `process` itself are all EventEmitters (#1575
matrix: blocks essentially all Node IO code). Subscribing from compiled code
requires passing a Wasm closure as a host-side callback. The `__extern_method_call`
path can pass closures (#1382 wasm-closure JS bridge), but the receiver expects
a `(arg) => ...` JS shape and the argument types (Buffer, Error) must round-trip
cleanly (see #983). Today `node:events` is the opaque `__node_events` externref
with no first-class EventEmitter recognition.

## Acceptance criteria

Tier 0 (JS-host target):

```ts
import { EventEmitter } from "node:events";
const e = new EventEmitter();
let got = 0;
e.on("tick", (n: number) => {
  got = n;
});
e.emit("tick", 42); // got === 42
```

- `e.once(...)` fires exactly once.
- `e.off(...)` / `removeListener` unsubscribes.
- Both global-less import form and `events.EventEmitter` member form resolve to
  the same host class.

## Implementation approach

1. Bind `EventEmitter` as a host-import constructor (extern class, `Date`
   pattern).
2. Establish the **closure-callback round-trip contract**: `e.on(name, fn)`
   must register the compiled `fn` as a JS-callable that, when the host fires
   it, marshals the event argument back across the boundary (numbers, strings
   for Tier 0; Buffer/Error round-trip is the long pole — coordinate with
   #1793 Buffer and #983).
3. Standalone fallback is feasible later (EventEmitter is ~200 lines of pure
   JS) — defer to a follow-up, but design the callback contract so it does not
   assume a JS host.
4. This unblocks the http Tier 0 (#1795) which consumes response streams via
   `EventEmitter`, and exercises the same callback wiring #640 (WASI HTTP) will
   need.

## Test

`tests/issue-1794.test.ts` — compile the Tier 0 snippet under JS-host config
and assert `got === 42` plus once/off behavior.

## Implementation (2026-07-16, fable-s2)

Four coordinated changes:

1. **Foundation un-break — registry/imports.ts.** The #1284 user-class shadow
   guard's `collectUserClassNames` collected AMBIENT classes (`declare class`,
   classes inside `declare namespace`) as user classes, so every
   declare-namespace extern class blocked ITS OWN import registration:
   `new Host.Widget()` lowered to `__get_undefined` (funcMap miss → muted
   reportError in the hoist pass → null) and all extern method/property
   imports were suppressed. Latent since 2026-05-02 (#1284);
   tests/externref.test.ts was failing 5/5 on main. Fixed by excluding
   ambient class declarations (NodeFlags.Ambient + declare-modifier ancestor
   walk). The externref suite harness also needed the (newer)
   `string_constants` import namespace.
2. **Named class import — import-resolver.ts.** `import { EventEmitter } from
"node:events"` was stubbed as `declare const EventEmitter: any` (null
   externref; every method silently no-opped). New
   `NODE_BUILTIN_CLASS_TYPED_STUBS` substitutes the #1044 namespaced
   extern-class shape (`declare namespace events { class EventEmitter {…} }` +
   `declare const EventEmitter: typeof events.EventEmitter`), so bare and
   namespaced forms hit ONE extern-class path whose ImportIntent carries
   `namespacePath: ["events"]` — runtime resolves `deps.events ??
require("events")` via `_resolveNamespacedClass`. Class-stubbed bindings
   are excluded from the module-thunk `__node_events` declaredGlobal binding.
3. **Stored-listener capture writebacks — closures/callback-classification.ts.**
   `on/once/off/addListener/removeListener/prependListener/prependOnceListener`
   added to `DEFERRED_CALLBACK_METHODS_BY_CLASS` (#1695): the listener fires
   from a LATER host call (`emit`), so captured-mutable writebacks must be
   persistent (one-shot pending writebacks resynced before the listener ever
   ran — `got` stayed 0).
4. **Callable wrapping for variable-held listeners — runtime.ts.** Node
   validates `typeof listener === "function"`; a variable-held closure crossed
   as a raw WasmGC struct (ERR_INVALID_ARG_TYPE). The EventEmitter
   listener-method arm wraps args via `_maybeWrapCallableUnknownArity` —
   identity-CACHED (`_wasmClosureDynamicWrapperCache`), so `on(h)`/`off(h)`
   receive the SAME wrapper and removal identity-matches.

## Test Results

- tests/issue-1794.test.ts (new): 5/5 — named-import on+emit (42), once/off
  (1), namespace form (7), addListener + two listeners (330), #1284 guard
  intact (user class still shadows).
- tests/externref.test.ts: 5/5 (was 5/5 FAILING on main — pre-existing).
- Residual filed: #3329 — two host-callbacks sharing ONE mutable captured
  local get separate ref cells (last writeback wins; pre-existing #859/#929
  design, also affects DisposableStack).
- Standalone note: no new host imports without fallback — EventEmitter is
  JS-host Tier 0 by design (issue scope); standalone EventEmitter is the
  documented follow-up (pure-TS ~200 LoC shim).
