---
id: 2374
title: "standalone: dynamic property read/write by a runtime string key (o[k]) returns default — needs native key enumeration + dynamic [[Get]]/[[Set]]"
status: ready
sprint: 64
created: 2026-06-19
updated: 2026-06-19
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen, standalone, runtime
language_feature: property-access, dynamic-keys
goal: standalone-mode
related: [2371, 2151, 2001]
needs: architect-spec
origin: "2026-06-19 sd1 standalone host-import-leak hunt — the broad gap underlying #2371-phase2 (native for-in) and #2151 (any-receiver dispatch)"
---

# #2374 — standalone dynamic property read/write by a runtime string key

## Problem

In `--target standalone --nativeStrings`, reading or writing an object property by
a **runtime** string key — `o[k]` where `k` is a `string` *variable* (not a
compile-time literal) — does not resolve to the real property. It returns the
element-type default (`0`/`undefined`) on read, and the write does not persist.

```ts
// returns 0 in standalone; should be 5
export function test(): number {
  const o: { [s: string]: number } = { a: 5, b: 7 };
  let k = "a";
  return o[k];
}
```

Verified 2026-06-19 (standalone, empty importObject, and confirmed independent of
for-in): `o[k]` with a static-literal key (`const k: "a" = "a"`) works, but a
runtime `let k = "a"` returns 0.

## Why this matters (epic-blocking)

This is the **broad capability** underlying several standalone gaps:

- **#2371 phase 2 (native for-in)** — `for (k in o) … o[k] …` is the dominant
  for-in body shape; even with native key enumeration, the value read needs this.
  (The #2371 phase-1 import-gate/refusal slice was abandoned — PR #1734 net -89 —
  because the test262 standalone harness *provides* the `__for_in_*` imports, so
  for-in already passes there; the real gap is the native runtime path, gated on
  this.)
- **#2151 any-receiver method dispatch** — `o.method()` on a closed object-literal
  struct via a dynamic receiver is the method analog of this dynamic read.
- Object rest destructuring (#2373) for `any`/index-signature receivers (the
  static-struct case is separately tractable in #2373).

## Root cause (sketch — architect to confirm)

The WasmGC object representation is a **nominal struct** with `struct.get`/`set`
keyed by a *static* `fieldIdx`. A runtime string key has no compile-time field
index, so `o[k]` falls through to a default-returning path (no native
string-key → field-index lookup, no host `__extern_get`/`__extern_set` in
standalone). A correct standalone implementation needs a runtime
**[[Get]]/[[Set]] by string key** over the struct — e.g. a per-struct
(key-hash → fieldIdx) dispatch table, or a side map, emitted natively. This is
the same machinery native for-in key enumeration needs.

## Acceptance criteria

- `o[k]` (runtime `k`) reads the real property value in standalone for a
  statically-typed object / index-signature object.
- `o[k] = v` (runtime `k`) persists.
- Unblocks #2371 phase 2 (native for-in) value reads.

## Scope note

`feasibility: hard` / **needs an architect spec** — this is a
representation/runtime change to the object model (dynamic [[Get]]/[[Set]] by
string key), not a localized fix. Filed for the standalone epic pivot; do NOT
attempt as a dev slice without a binding/representation design. Pairs naturally
with #2371-phase2 and #2151.
