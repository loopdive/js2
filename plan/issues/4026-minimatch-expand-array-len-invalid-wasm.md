---
horizon: m
id: 4026
title: "minimatch compiles but emits invalid Wasm: array.len on a struct ref in expand_"
status: ready
created: 2026-08-01
updated: 2026-08-01
assignee: unassigned
priority: high
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: arrays
goal: npm-library-support
sprint: current
es_edition: n/a
related: [1282, 4001, 4018]
---

# #4026 — `expand_` emits `array.len` against a struct reference

## Problem

With #4018 fixed, the real `minimatch` package compiles for the first time:
`success: true`, 119,213 bytes. The emitted module does **not validate**:

```text
WebAssembly.Module(): Compiling function #78:"expand_" failed:
array.len[0] expected type arrayref, found local.get of type (ref null 2)
@+34382
```

So the package is one codegen type defect away from being the first real npm
dependency to produce a loadable binary.

## Reproduce

```sh
node --max-old-space-size=4096 --import tsx \
  tests/helpers/compile-project-probe.ts \
  node_modules/minimatch/dist/esm/index.js \
  '{"allowJs":true,"target":"gc","platform":"node"}'
```

Reports `success: true`, `valid: false`, and the `validationError` above.
`expand_` comes from `brace-expansion`, which minimatch re-exports.

## Analysis

`array.len` is emitted for a value whose static Wasm type is `(ref null 2)` — a
**struct**, not an array. So the lowering decided "this is array-like" on a
value the type table says is a struct. Candidate causes, in rough order of
likelihood:

- shape inference marking a variable array-like on a path where it actually
  holds a struct (`applyShapeInference`),
- a `.length` read lowered to `array.len` without re-checking the receiver's
  final lowered type,
- a union/`any` receiver narrowed to the array arm in codegen but to the struct
  arm in the type table.

## Acceptance criteria

- A reduced fixture reproduces `array.len` against a struct ref, independent of
  minimatch.
- `minimatch/dist/esm/index.js` compiles **and validates** (`valid: true`).
- The `.length`/`array.len` lowering consults the receiver's final lowered type,
  so the mismatch cannot silently reappear elsewhere.
- Test asserts `valid === true`, not merely `success === true` — the whole point
  is that `success` was already true while the binary was unloadable.
