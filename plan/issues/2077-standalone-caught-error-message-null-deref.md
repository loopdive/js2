---
id: 2077
title: "standalone: caught Error's .message traps null deref; .name returns '[object Object]' (catch-bound value isn't the $Error struct)"
status: ready
sprint: 61
created: 2026-06-11
updated: 2026-06-11
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: exceptions
goal: host-independence
related: [1104, 1536, 2072]
origin: "2026-06-11 standalone spec audit (fable agent): verified on main @ 6bf881a0c, target standalone"
---

# #2077 — $Error struct field reads on a non-$Error catch binding

## Problem

```ts
try { throw new Error("msg1"); } catch (e: any) { const m: string = e.message; return m; }
// standalone: RuntimeError: dereferencing a null pointer   node: "msg1"
```

`e.name` on a TypeError yields "[object Object]" (node: "TypeError").
`e instanceof TypeError/Error` works — only the field reads break.

## Root cause

`src/codegen/property-access.ts:1448-1457` — standalone reads `$Error`
struct fields 1/2 for message/name, but the catch-bound value isn't that
struct after the throw/catch roundtrip → null field. Residual of #1104
(done); #1536 (backlog, $Error redesign) is the structural home.

## Fix direction

Preserve the `$Error` struct identity through the exception tag payload
(or re-cast with a guarded ref.test before the field read); the
"[object Object]" half also intersects #2072's `$__any_to_string` shape
mismatch.

## Acceptance criteria

- Both repros match Node standalone; instanceof behavior unchanged
- throw/rethrow of non-Error values unaffected

## Dupe check

#1104 (done — regressed/residual), #1536 (backlog redesign), #1597. Filed
as the concrete standalone residual.
