---
id: 1852
title: "Make dynamic-value representation explicitly per-backend (typed refs / i31ref on WasmGC; f64-value + i32-tag on linear)"
status: backlog
sprint: Backlog
created: 2026-06-04
updated: 2026-06-10
priority: medium
feasibility: hard
reasoning_effort: high
model: fable
task_type: feature
area: ir
language_feature: compiler-internals
goal: backend-agnostic-ir
related: [1168, 1713, 1714, 1851]
---
# #1852 — Per-backend value representation for the dynamic residue

**Source:** [`docs/architecture/compiler-design-lessons.md`](../../docs/architecture/compiler-design-lessons.md) — recommendation **R5** (P2).

## Problem

A uniform tagged value word (NaN-boxing, small-int tagging) is the right
tool **only for the genuinely dynamic residue** (`any`, reflective access,
heterogeneous unions). For typed code we already specialize on the static
type and keep the f64 fast path unboxed (`coerceType`: `__box_number`,
`extern.convert_any`, emitting `f64.const 0/NaN` directly for null/undefined
in f64 context). The gap: the **dynamic-residue representation is not chosen
per backend**, even though the right choice differs:

- **WasmGC backend:** real `ref` types + `ref.cast`/`br_on_cast` let the
  engine's type info replace a hand-carried tag for proven-monomorphic
  values; `i31ref` gives small-int-in-a-reference *for free*; fall back to a
  boxed `anyref` + tag only on the truly dynamic path.
- **Linear backend:** a value-`f64` + type-`i32` parallel-locals scheme is
  the natural dynamic representation; a uniform tagged word is the fallback.

A single cross-backend representation forces one backend onto the other's
worst case.

## Recommendation

Make the dynamic-value lowering a **per-backend decision at the
`BackendEmitter` seam** (depends on #1851). Hold the line that the boxed/
tagged form is **interchange only**: unbox at the static-type boundary for
the whole typed region (we can do at compile time what a runtime does per
loop iteration). On the GC backend, resist "make everything a reference."

## Acceptance criteria

- [ ] The IR `IrType` `union`/`boxed` lowering dispatches to a per-backend
      representation via the trait (GC: typed ref / `i31ref` / boxed
      `anyref`; linear: f64-value + i32-tag).
- [ ] Typed mainline stays unboxed on both backends (no regression in
      emitted-Wasm size/op-count for typed numeric kernels).
- [ ] `i31ref` used for small-int dynamic values on the GC backend.
- [ ] Cross-backend differential test (#1854) confirms identical observable
      behavior across the two representations.
