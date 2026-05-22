---
id: 639
title: "Full Component Model adapter (canonical ABI)"
status: ready
created: 2026-03-19
updated: 2026-04-28
priority: critical
feasibility: hard
reasoning_effort: max
goal: platform
depends_on: [600]
files:
  src/codegen/index.ts:
    new:
      - "Component Model canonical ABI adapter layer"
---
# #639 — Full Component Model adapter (canonical ABI)

## Status: open

#600 added WIT generation. This issue adds the canonical ABI adapter that wraps the core Wasm module in a Component Model component. Required for deployment on Fastly Compute, Fermyon Spin, Cosmonic.

### Approach
1. Generate canonical ABI lift/lower functions for exported types
2. Wrap core module in a component with proper imports/exports
3. Add `--component` flag to CLI that outputs a .wasm component

## Complexity: L

## Implementation Plan

(Author: architect, 2026-05-21. Concrete plan; builds on #600's
WIT generator. Use `wasm-tools component new` as the wrapper
toolchain rather than emitting component-encoded wasm directly.)

### Entry point

- New `src/component-wrap.ts` — orchestrates the wrap.
- `src/cli.ts` — `--component` flag.
- `src/wit-generator.ts` (existing per #600) — extended for the
  canonical ABI lift/lower signatures.

### Algorithm

1. **Generate WIT** via existing `wit-generator.ts`.

2. **Compile core module** as today (produces a wasm core module).

3. **Emit adapter wasm**: per WIT export, generate a canonical
   ABI lift/lower wrapper as a small wasm function that:
   - For strings: marshals between core memory `(ptr, len)` and
     component-level `string`.
   - For records: lifts/lowers field-by-field.
   - For lists: marshals via `(ptr, len)` to the core's
     vec/array type.
   - For variants: tag dispatch.

4. **Invoke `wasm-tools component new`**: pass the core module
   + adapter wat + WIT file; receive a component-encoded wasm.

5. **CLI**: `--component` outputs the component wasm; default
   remains the core wasm.

### Canonical ABI mapping (subset)

| WIT type | Core wasm rep | Lift/lower |
|----------|---------------|------------|
| string   | `(ptr i32, len i32)` | UTF-8 bytes in core memory; lift via `string.new_utf8` |
| u32 / s32 / u64 / s64 / f32 / f64 | matching prim | identity |
| list<T>  | `(ptr i32, len i32)` | element-wise lift |
| record   | tuple of fields | per-field lift/lower |
| variant  | `(tag i32, payload)` | tag dispatch |
| option<T>| `(present i32, value)` | option encoding |
| result<T,E>| variant encoding | tag dispatch |

### Edge cases

- **String encoding**: WIT uses UTF-8; native-strings uses UTF-16.
  Convert at boundary (existing utility per #682).
- **List ownership**: canonical ABI owns the list at the boundary;
  free after marshalling. For `nativeStrings` mode, copy and
  release.
- **Resources / handles**: Component Model resources require
  per-component state; defer to Phase 2.
- **Errors**: WIT `result<T,E>` maps to wasm exception tag;
  trampoline catches and lowers to the variant encoding.

### Test plan

- New `tests/issue-639-component.test.ts`:
  - Compile a simple module with `--component`.
  - Verify the output is a valid component via
    `wasm-tools component wit <output>`.
  - Instantiate in `wasmtime` with a host that calls the
    component's exports; verify round-trip.

### Dependencies

- **#600** — WIT generation; hard prerequisite (already in flight).
- External: `wasm-tools` CLI; pin a known version.

### Risks

- **wasm-tools version churn**: component model spec is still
  evolving. Pin a tested version; CI runs against that pin.
- **Resource types** (handles): defer; document gap.
- **Async functions** in WIT: not yet stable; out of scope for
  v1.
