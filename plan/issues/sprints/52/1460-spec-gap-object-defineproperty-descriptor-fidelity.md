---
id: 1460
sprint: 52
title: "spec gap: Object.defineProperty / defineProperties descriptor fidelity"
status: ready
created: 2026-05-20
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: property-descriptors
goal: spec-completeness
related: [929, 1334, 1364]
---
# #1460 - spec gap: Object.defineProperty / defineProperties descriptor fidelity

## Problem

`built-ins/Object/defineProperty/` and `built-ins/Object/defineProperties/`
account for **1,763 test262 failures** (1,131 + 632). Most are silent
assertion failures (no error thrown, but the resulting property doesn't
match the spec). Representative patterns:

| Pattern | Test file | Spec gap |
| --- | --- | --- |
| Property key coerced from non-string (number 1e+22, Symbol, object with `toString`) | `15.2.3.6-2-19.js`, `15.2.3.6-2-48.js` | ToPropertyKey not applied to `P` |
| Truthy/falsy coercion of `configurable` / `writable` / `enumerable` (e.g. `-12345` → `true`) | `15.2.3.6-3-108.js`, many `15.2.3.6-3-*.js` | `ToBoolean(desc.X)` not applied; non-bool stored verbatim or ignored |
| `delete obj.x` after `defineProperty` with `configurable:false` should throw / be a no-op | `15.2.3.6-3-123.js` | configurable flag not honoured by `delete` |
| Redefining a non-configurable accessor / data property → TypeError | "Expected TypeError, got Test262Error" (40 cases) | redefinition validation skipped |
| Mixing accessor + data attributes → TypeError | `15.2.3.7-5-b-*.js` | mixed-attribute rejection missing |
| `Object.defineProperties(obj, descMap)` with inherited descriptor keys | `15.2.3.7-5-a-3.js` | only own enumerable descriptor keys should be visited |
| Property description must be an object: 0 | `L55:3 TypeError: Property description must be an object: 0` | numeric descriptor accepted (should throw) |
| Codegen error: op.endsWith is not a function | 3 tests | crashes inside codegen on certain descriptor shapes |

Existing infrastructure (`src/codegen/object-ops.ts`) already encodes flags
into a packed integer for `__defineProperty_value` and handles the
struct-property fast path, but the validation and coercion required by the
spec algorithm `OrdinaryDefineOwnProperty` / `ValidateAndApplyPropertyDescriptor`
(ES §10.1.6) is largely missing.

## Failure count

1,763 (1,131 `Object/defineProperty/` + 632 `Object/defineProperties/`).
Roughly 50% of failures are silent "wrong result" assertions, 30% are
"Expected TypeError" cases where the spec demands a throw, the rest are
crashes / compile errors.

## Root cause

In `src/codegen/object-ops.ts` (~1,400 LOC for the Object.defineProperty
family):

1. **Boolean coercion of attribute flags is absent.** Around line 437 the
   compiler assembles the descriptor flag word, but it reads
   `desc.writable` / `desc.configurable` / `desc.enumerable` literally —
   if the source supplies `-12345` the value is captured but never run
   through ToBoolean. Spec §6.2.5.6 step 5.b requires `ToBoolean(value)`.

2. **ToPropertyKey on `P` is not applied uniformly.** When the key is a
   non-string literal (number, Symbol, object with `toString`) the codegen
   keeps the original kind, so `1e+22` becomes `"1e22"` instead of
   `"1e+22"`. This is a JS `String()` issue too — the canonical
   number-to-string algorithm must run.

3. **Redefinition validation is missing.** `__defineProperty_value` /
   `__defineProperty_accessor` overwrite blindly. The spec
   (`ValidateAndApplyPropertyDescriptor`, §10.1.6.3) rejects:
   - changing a non-configurable data property to accessor (or v.v.);
   - widening attributes on non-configurable;
   - changing the value of a non-writable, non-configurable data property.

4. **Mixed accessor + data descriptors** (`{ value: 1, get: f }`) are not
   rejected. Spec §6.2.5.6 step 4 requires TypeError.

5. **Descriptor type check** (`Type(desc) is Object`) is missing — the
   runtime accepts `defineProperty(obj, "x", 0)`. Spec §6.2.5.5 step 1.

6. **`delete` path does not consult the configurable flag**
   (`src/codegen/typeof-delete.ts` line 195 notes the gap explicitly).

7. **`Object.defineProperties` iterates all enumerable keys** —
   but it must filter by `enumerable: true` of the *descriptor map's*
   own properties, not the resolved descriptors.

8. **Codegen crash** "op.endsWith is not a function" — descriptor
   compilation path mis-types a non-string property key (3 tests).

## Acceptance criteria

1. `defineProperty(obj, K, desc)` applies `ToPropertyKey(K)` and
   `ToBoolean` on `configurable`/`writable`/`enumerable` before storing.
2. Numeric property keys render via JS canonical
   `Number::toString` (so `1e+22` stays `"1e+22"`).
3. Redefinition validation per §10.1.6.3 — throws TypeError when changing
   non-configurable in ways the spec forbids.
4. Mixed accessor + data descriptors throw TypeError (§6.2.5.6 step 4).
5. Non-object descriptor argument throws TypeError (§6.2.5.5 step 1).
6. `delete` respects `configurable:false` (extends existing #1334 work).
7. `Object.defineProperties` iterates only own enumerable keys of the
   descriptor map (and reads each via `ToPropertyDescriptor`).
8. No codegen crashes ("op.endsWith is not a function") on any
   `Object/defineProperty` test262 case.
9. ≥1,200 of the 1,763 failures resolved (≥68% pass-rate).
10. Tests: `tests/issue-1460.test.ts` covers each of the eight rules
    above with a focused vitest case.

## Files to inspect

- `src/codegen/object-ops.ts` (~1,400 LOC — main implementation)
- `src/codegen/typeof-delete.ts` (configurable-aware `delete`, lines 109/195)
- `src/codegen/literals.ts` (`__defineProperty_accessor` for object literals)
- `src/codegen/declarations.ts` (widening hooks, lines 523–545, 1722–1820)
- `src/runtime.ts` — host `__defineProperty_value`/`_accessor` implementations
- `tests/issue-1460.test.ts`

## Notes

- Issue #1364 covered class-element method descriptor fidelity — this
  issue is the broader Object.defineProperty surface.
- Issue #1334 covered writable on `delete` — there is overlap on the
  configurable-aware delete path.
- Many of the 40 "Expected TypeError" failures resolve trivially once
  redefinition validation lands; tackle that early to avoid double work.
