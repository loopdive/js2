---
id: 2541
renumbered_from: 2375
title: "standalone: Object.fromEntries / o.propertyIsEnumerable / Object.is refuse with a dynamic-shape CE"
status: ready
sprint: 64
created: 2026-06-19
updated: 2026-06-21
priority: low
task_type: bugfix
area: codegen, standalone
language_feature: object-static-methods
goal: standalone-mode
related: [2374, 2151]
origin: "2026-06-19 sd1 standalone host-import-leak hunt (object/class/property lane)"
---

# #2541 — standalone Object.fromEntries / propertyIsEnumerable / Object.is dynamic-shape CE

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

## Disposition (PO true-up 2026-06-21, sprint-64, origin/main d0bf058bc) — PARTIAL

Smoke-tested all three forms under `--target standalone`, instantiated under
empty imports:

| form | result |
|---|---|
| `Object.is(NaN, NaN)` | RAN → `true` ✅ FIXED |
| `Object.is(0, -0)` | RAN → `false` ✅ FIXED |
| `Object.is(1, 1)` | RAN → `true` ✅ FIXED |
| `Object.fromEntries([["a",5]]).a` | RAN → `5` ✅ FIXED |
| `Object.fromEntries([["a",5],["b",7]]).b` | RAN → `7` ✅ FIXED |
| `({x:1}).propertyIsEnumerable("x")` | **CE** `'__propertyIsEnumerable' (dynamic-shape object/property operation) is not yet supported in --target standalone (#1472 Phase B)` ❌ STILL OPEN |

**Two of three sub-cases are already fixed on main** (`Object.is`,
`Object.fromEntries` both lower natively in standalone with zero host imports —
likely landed via the #1472 / #2374 dynamic-property runtime work). The scope of
this issue is now reduced to the single remaining refusal: **`propertyIsEnumerable`**.

Issue stays `status: ready` with narrowed scope. `propertyIsEnumerable` is a
clean graceful refusal (a clear CE, not a miscompile / host-import leak), so it
keeps `priority: low`. It is bound to the same dynamic own-key machinery as
#2374 (any-receiver dispatch); likely follows that. No regression test exists for
the now-fixed `Object.is`/`Object.fromEntries` standalone behaviour — a dev should
add a guard when closing the residual.
