---
id: 1813
title: "node:events / EventEmitter — host class + closure-callback contract"
status: wont-fix
sprint: Backlog
created: 2026-06-03
updated: 2026-06-12
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
e.on("tick", (n: number) => { got = n; });
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
   #6403 Buffer and #983).
3. Standalone fallback is feasible later (EventEmitter is ~200 lines of pure
   JS) — defer to a follow-up, but design the callback contract so it does not
   assume a JS host.
4. This unblocks the http Tier 0 (#6405) which consumes response streams via
   `EventEmitter`, and exercises the same callback wiring #640 (WASI HTTP) will
   need.

## Test

`tests/issue-6404.test.ts` — compile the Tier 0 snippet under JS-host config
and assert `got === 42` plus once/off behavior.

## Closed as duplicate (2026-06-12)

Duplicate of #1794 (node builtin filed twice — renumber artifact). #1794 is canonical; both were parked on the npm front.
