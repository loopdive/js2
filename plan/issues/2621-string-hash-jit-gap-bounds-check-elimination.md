---
id: 2621
title: "string-hash AOT-vs-JIT gap: GC-array bounds-check elimination in hot loops (epic)"
status: backlog
sprint: Backlog
created: 2026-06-22
updated: 2026-06-24
priority: low
feasibility: hard
model: fable
reasoning_effort: high
task_type: performance
area: codegen
related: [1580, 2619]
goal: performance
language_feature: strings, arrays, loops
reconcile_note: "2026-06-24 (PO reconcile vs upstream/main): DEFERRED EPIC, NOT dev-claimable. The title itself marks it '(epic)'; BCE on a trapping WasmGC array.get is inherently an AOT-vs-JIT gap with no tractable WasmGC slice. Sequence only after #1760 (warm-runtime bench lane, open PR/owner sdev-strback) lands AND only if JS-parity becomes a hard requirement. → backlog (was ready)."
---

# #2621 — string-hash AOT-vs-JIT gap: GC-array bounds-check elimination (epic, deferred)

Follow-up to #2619 (string-hash hot-path profiling). #2619 proved that
**no bounded, semantics-preserving front-end codegen change** narrows the
remaining ~2-3× gap between the js2wasm AOT lane (~920 µs warm) and the
JS-JIT/vm lane (~330 µs) on the `string-hash` benchmark. This issue captures
the **only** remaining lever and why it is epic-scale, so it is on record for
next-sprint prioritisation rather than forced now.

## Why the bounded levers are already exhausted (#2619 measurements)

- **Build loop (`text += charAt`)** — already optimized: presize fires (#1761),
  one `array.new_default(n*3)`, no doubling growth (confirmed: presize-on 3614 B
  vs presize-off 3771 B).
- **Materialized-string read in the loop** — already cached (#1580): `text$mat`
  ref-cell, `ref.is_null` guard.
- **Hash arithmetic `(h*31+cc)` masked by `|0`** — already i32-narrowed by
  wasm-opt; an explicit `i32`-typed hash measures identical to the f64 hash
  (~600 µs).
- **`charCodeAt` string access** — NOT the bottleneck: hashing a pre-extracted
  `number[]` (zero string access) is the SAME ~600-675 µs (the loop is
  arithmetic-latency-bound, so the per-char bounds-branch + `length` call hide
  under the arithmetic).

## The remaining lever (epic)

The residual is **per-element overhead in the hot loop**: every `array.get_u`
on a WasmGC i16 string-data array (and every `array.get` on a `number[]`) is a
**bounds-checked** access. V8's JIT does dynamic range analysis and hoists/
eliminates these checks in a monomorphic counted loop; Cranelift's AOT
(wasmtime) keeps them. That per-iteration check + the f64 arithmetic latency is
the ~2-3× gap.

Closing it would require one of:

1. **Whole-program / loop range analysis in js2wasm** to prove a counted-loop
   index is in `[0, len)` and emit an unchecked access. WasmGC core does **not**
   expose an unchecked `array.get`, so this only helps on the linear backend
   (`array` → `i32.load` with a hoisted single bound test) — a large new
   analysis pass + a linear-backend-only payoff. Epic.
2. **Lean on the engine** — this is a Cranelift bounds-check-elimination
   improvement (wasmtime upstream), not a js2wasm change. Out of our repo.
3. **SIMD-ify the hash** (`v128` lanes over 8 code units) — WasmGC arrays have
   no SIMD load; would require a linear-memory string representation in the hot
   path. Epic + representation change.

All three are epic-scale and/or out-of-repo. None is a this-sprint bounded win.

## Verdict

**Deferred / epic.** The js2wasm AOT lane is already competitive vs other Wasm
runtimes (StarlingMonkey 14.2 ms, Javy 36 ms → AOT ~920 µs is ~15× / ~39×
faster). The JS-JIT gap is the inherent AOT-vs-JIT tradeoff on a tight
arithmetic loop and is not closable by a safe front-end codegen edit. Surface
to the user for next-sprint prioritisation only if the JS-JIT-parity headline is
a hard requirement; otherwise leave deferred.
