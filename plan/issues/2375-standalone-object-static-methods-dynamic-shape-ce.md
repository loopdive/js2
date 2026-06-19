---
id: 2375
title: "standalone: Object.fromEntries / o.propertyIsEnumerable / Object.is refuse with a dynamic-shape CE"
status: ready
sprint: 64
created: 2026-06-19
updated: 2026-06-19
priority: low
task_type: bugfix
area: codegen, standalone
language_feature: object-static-methods
goal: standalone-mode
related: [2374, 2151]
origin: "2026-06-19 sd1 standalone host-import-leak hunt (object/class/property lane)"
---

# #2375 — standalone Object.fromEntries / propertyIsEnumerable / Object.is dynamic-shape CE

## Problem

In `--target standalone --nativeStrings`, three object built-ins refuse with a
`Codegen error: '<helper>' (dynamic-shape object/...)` compile error rather than
a working native lowering:

| form | refuses with |
|---|---|
| `Object.fromEntries([["a",5]])` | `__object_fromEntries` (dynamic-shape object) |
| `o.propertyIsEnumerable("x")` | `__propertyIsEnumerable` (dynamic-shape object) |
| `Object.is(NaN, NaN)` | `__object_is` (dynamic-shape object) |

These graceful-refuse (a clear CE, not a silent miscompile and not a host-import
leak), so they are **lower priority** than the un-instantiable leaks — but each is
a standalone conformance gap.

## Notes / scope

- `Object.is(a, b)` is the most tractable: §20.1.2.13 SameValue is a pure
  small comparison (`a===b` except `+0/-0` distinguished and `NaN` equal) — a
  candidate for a Wasm-native lowering with no dynamic-shape dependency.
- `Object.fromEntries` and `propertyIsEnumerable` are bound up with the same
  runtime dynamic-property / own-key machinery as #2374 (dynamic property
  read/write by runtime key) and #2151 (any-receiver dispatch); their
  "dynamic-shape" refusal is the same family. They likely follow #2374.

## Acceptance criteria

- `Object.is(NaN, NaN)` → `true`, `Object.is(0, -0)` → `false`, in standalone
  with zero host imports (the bounded sub-slice).
- `Object.fromEntries` / `propertyIsEnumerable` either lower natively or remain a
  documented refusal gated on the #2374 dynamic-property machinery.

## Validation caveat (lesson from #2371/#1734)

Before any gate/refusal change, VALIDATE against the real test262 standalone
harness — a host-import "leak" or refusal seen against an empty importObject may
be benign because the harness provides the import. A native lowering (additive)
is always safe; demoting a working path is not.
