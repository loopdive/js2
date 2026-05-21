---
id: 674
title: "SharedArrayBuffer and Atomics"
status: ready
created: 2026-03-20
updated: 2026-04-28
priority: low
feasibility: hard
reasoning_effort: max
goal: spec-completeness
test262_fail: 493
files:
  src/codegen/index.ts:
    new:
      - "shared memory declaration, atomic instructions"
---
# #674 — SharedArrayBuffer and Atomics

## ECMAScript spec reference

- [§25.2 SharedArrayBuffer Objects](https://tc39.es/ecma262/#sec-sharedarraybuffer-objects) — shared memory backing store
- [§25.4 Atomics Object](https://tc39.es/ecma262/#sec-atomics-object) — atomic operations (load, store, add, compareExchange, wait, notify)


## Status: open

~493 tests use SharedArrayBuffer/Atomics.

## 2026-04-07 current compiler bucket

The latest full recheck (`benchmarks/results/test262-results-20260407-111308.jsonl`)
shows a concrete front-edge CE cluster of **28 compile errors** with:

```text
Unsupported new expression for class: SharedArrayBuffer
```

Representative samples:

- `test/built-ins/Atomics/notify/validate-arraytype-before-count-coercion.js` — `L35:37`
- `test/built-ins/Atomics/or/validate-arraytype-before-value-coercion.js` — `L36:37`
- `test/built-ins/Atomics/notify/retrieve-length-before-index-coercion.js` — `L23:12`
- `test/built-ins/Atomics/wait/validate-arraytype-before-index-coercion.js` — `L35:37`

These are valuable because they fail before most Atomics semantics even run:
the immediate blocker is still `new SharedArrayBuffer(...)`, especially in
Atomics argument-validation tests that construct the shared buffer up front.

### Approach
1. Declare shared memory: `(memory 1 1 shared)`
2. Compile `new SharedArrayBuffer(n)` → allocate in shared linear memory
3. Compile Atomics methods to Wasm atomic instructions:
   - `Atomics.load(arr, i)` → `i32.atomic.load`
   - `Atomics.store(arr, i, v)` → `i32.atomic.store`
   - `Atomics.add(arr, i, v)` → `i32.atomic.rmw.add`
   - `Atomics.compareExchange` → `i32.atomic.rmw.cmpxchg`
   - `Atomics.wait` → `memory.atomic.wait32`
   - `Atomics.notify` → `memory.atomic.notify`

Requires Wasm threads proposal (widely supported).

## Complexity: L

## Implementation Plan

(Author: architect, 2026-05-21. Concrete plan; depends on Wasm
threads proposal which is widely supported.)

### Entry point

- New `src/codegen/builtins/atomics.ts` — all `Atomics.*`
  intrinsics.
- New `src/codegen/builtins/shared-array-buffer.ts` —
  `new SharedArrayBuffer(...)` lowering.
- `src/codegen/index.ts` — when any SAB is used, emit
  `(memory 1 65536 shared)` (max=65536 pages = 4GB cap).

### Data structures

```wat
(type $SharedArrayBuffer (struct
  (field $tag i32)               ;; SAB_TAG
  (field $byteOffset i32)        ;; offset in shared memory
  (field $byteLength i32)
)))
(type $Int32SharedArray (struct
  (field $tag i32)               ;; INT32_SHARED_TAG
  (field $buffer (ref $SharedArrayBuffer))
  (field $byteOffset i32)
  (field $length i32)
)))
```

### Algorithm

1. **Memory declaration**: when `ctx.usesSAB` is true (set on first
   SAB encounter), upgrade the module's memory to
   `(memory 1 65536 shared)`. Standard memory becomes shared
   throughout — shared memory is module-level.

2. **`new SharedArrayBuffer(n)`**: allocate `n` bytes in shared
   memory via bump allocator (same as #1199 arena, but on the
   shared memory). Store offset + length in struct.

3. **`new Int32Array(sab)`**: build view struct with byteOffset=0,
   length = byteLength/4.

4. **`Atomics.load(arr, i)`**:
   ```wat
   local.get $arr
   struct.get $Int32SharedArray $buffer
   struct.get $SharedArrayBuffer $byteOffset
   local.get $i
   i32.const 4
   i32.mul
   i32.add
   i32.atomic.load
   ```

5. **`Atomics.store / add / sub / and / or / xor / exchange /
   compareExchange`**: similar pattern → `i32.atomic.rmw.<op>`.

6. **`Atomics.wait(arr, idx, val, timeout)`**:
   ```wat
   ...compute address...
   local.get $val
   local.get $timeout_ns
   memory.atomic.wait32
   ;; result: 0=ok, 1=not-equal, 2=timed-out → map to "ok"/"not-equal"/"timed-out"
   ```

7. **`Atomics.notify(arr, idx, count)`**:
   ```wat
   ...compute address...
   local.get $count
   memory.atomic.notify
   ```

### Edge cases

- **Misaligned access**: spec throws RangeError; wasm atomic
  instructions trap. Insert alignment check before the op.
- **Out-of-bounds index**: spec throws RangeError; check
  `i*4 + offset < length`.
- **Mixed-type views** (`Int32Array` + `Uint8Array` over same
  SAB): structs share buffer ref; byteOffset differs.
- **Wait inside the main thread of a browser**: spec throws
  TypeError; detect via host import (no wasm-side way to know).
- **TimeoutNaN / negative timeout**: spec coerces; +Infinity →
  i64.max wait.
- **`Atomics.isLockFree(byteCount)`**: always true for 1/2/4 byte
  ops in wasm; false for 8 unless engine supports i64 atomics
  (most do).
- **BigInt atomics** (`Atomics.add(BigInt64Array, ...)`) — use
  `i64.atomic.rmw.add` if available; else fall back to lock.

### Test262 paths

- `test/built-ins/Atomics/*` — ~400 tests.
- `test/built-ins/SharedArrayBuffer/*` — ~90 tests.

Acceptance: ≥300 of 493 tests pass.

### Dependencies

- **#1199** — linear-memory backing; shared memory is a related
  but distinct backing store. Coordinate the allocator.
- **Wasm threads proposal** — runtime feature gate; document.

### Risks

- **Shared memory tooling**: not all Wasm runtimes support
  `shared` memory; opt-in flag `--shared-memory` required.
- **Browser COOP/COEP**: shared memory in browsers requires
  cross-origin isolation; document.
- **Test262 timing-sensitive tests**: `Atomics.wait` tests with
  short timeouts may be flaky in CI; allow timeout slop.
