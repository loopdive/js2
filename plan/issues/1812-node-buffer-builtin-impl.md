---
id: 1812
title: "node:buffer + global Buffer — host class with from/concat/toString"
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
related: [1044, 1032, 983]
---
# node:buffer + global Buffer — host class with from/concat/toString

## Problem

`Buffer` underlies every `node:http` body, every non-utf8 `node:fs` read, and
every `node:crypto` digest (#1575 matrix: blocks axios, zlib consumers,
crypto). It is also a **global**, not just an export of `require("buffer")`, so
the opaque `__node_buffer` externref path cannot handle the common form at all
— compiled code crashes on the first `Buffer.from(...)` because `Buffer` is not
recognised as an extern class (contrast: `Date` is).

## Acceptance criteria

Tier 0 (JS-host target — standalone deferred):

- `Buffer.from("hi", "utf-8").toString("utf-8") === "hi"`
- `Buffer.concat([Buffer.from("a"), Buffer.from("b")]).length === 2`
- `Buffer.from([104, 105]).toString() === "hi"`
- `Buffer.alloc(4).length === 4`
- Passing a `Uint8Array` to a host import takes a Buffer view in JS-land
  without copying.
- Both the global form (`Buffer.from(...)`) and the import form
  (`import { Buffer } from "node:buffer"`) resolve to the same host class.

## Implementation approach

1. Recognise the global identifier `Buffer` in codegen as an extern class
   (same machinery as `Date`), so static calls `Buffer.from` / `Buffer.alloc`
   / `Buffer.concat` lower to host imports.
2. Map `Buffer.prototype.{toString, slice, write, readUInt8, ...}` to
   externref method dispatch via `__extern_method_call`.
3. Provide a thin `Uint8Array` ↔ `Buffer` bridge so Wasm-side typed arrays can
   cross the host boundary as Buffer views without a copy (see #983 for the
   round-trip-argument hazard with stream callbacks).
4. The encoding matrix (latin1/base64/hex/ucs2 …) is the long tail — Tier 0
   covers utf-8 + byte-array only; remaining encodings are a follow-up.
5. Standalone (WASI) Buffer is out of scope here — track alongside #1471/#1472.

## Test

`tests/issue-6403.test.ts` — compile each Tier 0 snippet under JS-host config
and assert against the host's native `Buffer`.

## Closed as duplicate (2026-06-12)

Duplicate of #1793 (node builtin filed twice — renumber artifact). #1793 is canonical; both were parked on the npm front.
