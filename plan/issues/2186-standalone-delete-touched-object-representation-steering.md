---
id: 2186
title: "standalone: post-delete struct read returns stale value — steer delete-touched object literals to $Object"
status: ready
sprint: Backlog
created: 2026-06-17
updated: 2026-06-17
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: object-literals
goal: property-model
related: [2179, 2130]
origin: "2026-06-17 — A7 standalone half split out of #2179 (A6 JS-host landed)"
---

# #2186 — standalone post-delete read: $Object representation steering

## Problem

`#2179` fixed the post-delete struct READ for `any` receivers in **JS-host**
mode by routing reads through the tombstone-aware `__extern_get` host helper.
That helper is a JS host import and is unavailable under `--target standalone` /
WASI, so the fix is gated `!ctx.standalone` and standalone still returns the
stale value:

```ts
const o: any = { a: 1, b: 2 };
delete o.a;
o.a               // standalone wasm: 1   node: undefined
o.a === undefined // standalone wasm: false
```

## Root cause

In standalone mode an object literal with a resolvable shape is lowered to a
WasmGC struct. `delete o.a` sets a runtime tombstone but cannot clear the struct
field, and the read fast-path (`struct.get`) reads the live field. There is no
host `__extern_get` to reroute through, and a wasm-side `(obj,key)` tombstone
registry is rejected (architect addendum A7): WasmGC has no weak refs, so it
would strongly retain every deleted-from object.

## Fix direction (architect addendum A7, from #2130)

**Representation steering.** Reuse the `moduleUsesDelete` pre-scan
(`ctx.moduleUsesDelete`, `src/codegen/index.ts`, landed in #2179) to find the
object-literal struct types that are targeted by `delete`, and in standalone
mode lower **those** literals to the dynamic `$Object` representation
(`src/codegen/object-runtime.ts`) instead of a WasmGC struct. `$Object` already
has spec-correct `FLAG_TOMBSTONE` tombstones, proto-walk `in`, and #1837
insertion-order enumeration. Zero overhead for untouched objects; full fidelity
for delete-touched ones.

Likely scope: a per-literal "is a delete target?" analysis (which object
literals flow into a `delete <member>` whose base resolves to that literal),
then steer those literals' lowering to `$Object` in standalone; the read/`in`/
keys paths then go through the existing `$Object` ops.

## Acceptance criteria

- `const o:any={a:1,b:2}; delete o.a; o.a` → `undefined` under `--target standalone`.
- `o.a === undefined` after delete → `true` (standalone).
- `delete o.a; o.a = 5; o.a` → `5`; `"a" in o` → `true` (standalone re-add).
- `Object.keys(o)` / `for (const k in o)` omit the deleted key (standalone).
- Non-delete-touched object literals keep their WasmGC struct lowering (no
  perf/representation change); JS-host behavior (#2179) unregressed.

## Notes

Split from #2179 (A6 JS-host read-path fix is `done`). See #2179's
`## Resolution` and #2130's architect addendum A7.
