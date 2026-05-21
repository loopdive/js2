---
id: 1101
title: "Wasm-native WeakRef and FinalizationRegistry via WasmGC weak references"
status: ready
created: 2026-04-12
updated: 2026-04-12
priority: low
feasibility: hard
reasoning_effort: max
task_type: feature
language_feature: weak-references
goal: spec-completeness
es_edition: ES2021
---
# #1101 — Wasm-native WeakRef and FinalizationRegistry via WasmGC

## Problem

WeakRef and FinalizationRegistry are currently skipped in test262 and delegated to the JS host constructor table in runtime.ts. For standalone mode, these need Wasm-native implementations.

## WasmGC weak reference support

The WasmGC proposal does not yet include weak references. However:

1. **WeakRef**: can be approximated with `extern.convert_any` + a nullable `externref` slot. In a GC-managed runtime, the Wasm engine's GC can null out the reference. Without engine support, WeakRef degrades to a strong reference (conformant but not useful for memory management).

2. **FinalizationRegistry**: requires a callback mechanism when objects are collected. This is fundamentally tied to the GC implementation. Options:
   - **Polling approach**: register targets in a table, periodically check for null (requires engine weak ref support)
   - **Host callback**: keep FinalizationRegistry as a host import where available, no-op in standalone mode
   - **Wasm GC finalizers proposal**: track the `gc-finalizers` proposal for native support

## Acceptance criteria

- [ ] `new WeakRef(target)` compiles in standalone mode
- [ ] `WeakRef.prototype.deref()` returns the target while it's alive
- [ ] `new FinalizationRegistry(callback)` compiles (callback invocation may be best-effort)
- [ ] test262 WeakRef/FinalizationRegistry tests that don't depend on GC timing pass

## Related

- #988 FinalizationRegistry constructor CE (23 tests)
- WasmGC weak references proposal (future spec work)

## Implementation Plan

(Author: architect, 2026-05-21. Pragmatic compile-away: since WasmGC
weak refs are not yet shipped, implement WeakRef as a *strong* ref
that is spec-conformant for non-GC-timing-dependent tests, and stub
FinalizationRegistry as no-op-on-collect.)

### Entry point

`src/codegen/builtins/weakref.ts` (new). Invoked from the constructor
dispatch when `new WeakRef(...)` or `new FinalizationRegistry(...)`
is seen.

### Data structures

```wat
(type $WeakRef (sub (struct
  (field $tag i32)               ;; WEAKREF_TAG
  (field $target (mut (ref null any))) ;; mut for revoke; "weak" in name only
)))
(type $FinReg (sub (struct
  (field $tag i32)               ;; FINREG_TAG
  (field $cb (ref null funcref))
  (field $entries (ref $vec_FinRegEntry))
)))
(type $FinRegEntry (struct
  (field $target (ref null any))
  (field $heldValue (ref null any))
  (field $token (ref null any))
))
```

### Algorithm

1. **WeakRef construction**: store target strongly. (Spec note: a
   WeakRef whose target is never collected is conformant — the spec
   only requires that *if* the target is collected, deref returns
   undefined. With strong storage, deref always returns the target;
   that's allowed.)
2. **`weakRef.deref()`**: return `$target`. Never undefined under
   our strong-ref implementation.
3. **FinalizationRegistry construction**: store callback, allocate
   empty entries vec.
4. **`reg.register(target, held, token?)`**: push entry to vec.
5. **`reg.unregister(token)`**: filter entries by token equality.
6. **Cleanup**: no-op (no GC hook available). Spec allows this — the
   callback is best-effort.

### Edge cases

- **`deref()` after register-unregister roundtrip**: still returns
  target (strong storage).
- **Primitive target** — `new WeakRef(42)` throws TypeError per spec;
  enforce at construction.
- **`new WeakRef(symbolToken)`** — per ES2024, symbols are
  permitted; tagged-union storage in the target slot handles this.
- **Cross-realm targets** — N/A (single realm).
- **GC-timing tests** — these will fail; document the gap. Skip in
  test262 with a clear reason.

### Test262 paths

- `test/built-ins/WeakRef/*` — most non-timing tests should pass.
- `test/built-ins/FinalizationRegistry/*` — construction +
  register + unregister should pass; cleanup-callback tests stay
  skipped.

Acceptance: ≥60% of non-timing-dependent WeakRef/FinReg tests pass.

### Dependencies

- **#1325** — tag registry; add WEAKREF_TAG, FINREG_TAG.
- Future: when WasmGC adds weak refs (proposal stage), upgrade
  storage to nullable-on-collect; this is a drop-in replacement
  inside `$WeakRef.$target` lowering.

### Risks

- Memory leak: targets are pinned. Document; programs relying on
  WeakRef for memory management need the native weak-ref proposal.
- Test262 may have tests that explicitly assert collection
  occurred — those fail by design. Add skip filters with reason
  "WeakRef requires WasmGC weak-ref proposal".
