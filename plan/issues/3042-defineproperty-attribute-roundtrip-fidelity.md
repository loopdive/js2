---
id: 3042
title: "Object.defineProperty: attribute round-trip fidelity (writable/enumerable/configurable not faithfully stored + reported)"
status: done
sprint: 71
priority: high
horizon: m
feasibility: medium
created: 2026-07-05
completed: 2026-07-05
assignee: ttraenkler/dev-3042
task_type: bugfix
area: runtime, codegen
language_feature: object-defineproperty, property-descriptors
es_edition: 5
goal: spec-completeness
parent: 3022
related: [3022, 1334, 1629]
---

# #3042 — defineProperty attribute round-trip fidelity

Split from the #3022 umbrella (descriptor-fidelity tail). This is the
**developer-scoped, locally-test262-validatable** slice.

## Root cause

After `Object.defineProperty(obj, k, desc)`, reading the property back via
`Object.getOwnPropertyDescriptor` / `verifyProperty` (the test262 helper that
mutates then restores each attribute) reports the wrong **attribute bits**
(`writable` / `enumerable` / `configurable`) or the attributes are not
*enforced* (e.g. a `writable:false` property is still writable, an
`enumerable:false` property still shows in `for-in`). The descriptor-bit sidecar
population at the defineProperty lowering / runtime helper and the
`getOwnPropertyDescriptor` reader do not round-trip faithfully for the common
struct-typed-receiver shapes.

This is the **attribute-fidelity** half of the 600-fail descriptor tail; it is
distinct from value/identity loss (see #3022 note DF-3) and from illegal-
transition validation (#3043).

## Failing files (74, `built-ins/Object/define{Property,Properties}`, `verifyProperty` failures)

`15.2.3.7-6-a-249`, `15.2.3.6-4-79`, `15.2.3.7-6-a-253`, `15.2.3.6-4-243`,
`15.2.3.6-4-81`, `15.2.3.6-4-289`, `15.2.3.7-6-a-215`, `15.2.3.6-4-73`, … (full
set: harvest `verifyProperty` failures under `built-ins/Object/defineProperty`
+ `defineProperties` from `.test262-cache/test262-current.jsonl`).

## Minimal repro

```js
var obj = {};
Object.defineProperty(obj, "foo", { value: 1, enumerable: false });
var d = Object.getOwnPropertyDescriptor(obj, "foo");
// expected: d.enumerable === false, d.writable === false, d.configurable === false
// also: for (var k in obj) — "foo" must NOT appear
```

## Layer to fix

- `src/codegen/object-ops.ts` defineProperty lowering — ensure every descriptor
  bit is recorded (the `_wasmPropDescs` / `definedPropertyFlags` sidecar), for
  both the data and accessor fast paths and the runtime path.
- `src/runtime.ts` `getOwnPropertyDescriptor` reader + enumeration
  (`for-in` / `Object.keys`) — consult the recorded bits.

## Acceptance

- `verifyProperty`-based fails in `built-ins/Object/define{Property,Properties}`
  drop materially (target: the 74 listed → near zero).
- No regression in `Object/{freeze,seal,preventExtensions,getOwnPropertyDescriptor}`.
- Scope: **DEV** — locally validatable via `runTest262File` on the cluster.

## Resolution (2026-07-05, dev-3042)

**Root cause (narrower than hypothesised).** The `getOwnPropertyDescriptor`
reader and the sidecar attribute bits already round-trip correctly. The failing
`verifyProperty` rows are the runner's *value* check (`assert_sameValue(obj[name],
descValue)`): a **value-less** data descriptor (`{ enumerable: false }`) on a
struct-typed receiver (`var obj = {}`, widened to carry the
defineProperty-introduced field) creates a property whose `[[Value]]` defaults to
`undefined` (ES §10.1.6.3), but the read returned **`null`**.

`compileWidenedEmptyObject` (`src/codegen/literals.ts`) initialised widened
`externref` field defaults to `ref.null.extern` (→ reads as `null`). The
value-less define lowers to a struct no-op, so the field kept that default. Fix:
emit JS `undefined` (`emitUndefined`) for the widened-field default, matching the
main object-literal path (its "missing fields" branch, ~literals.ts:2242, which
already documents this: JS defaults fire on `=== undefined`, not `null`).

**Impact.** +14 of 19 value-less-plain-object rows flip to pass (e.g.
`15.2.3.6-4-79/-81/-73`); **0 regressions** on the previously-passing
define{Property,Properties} set (identical clean-vs-fix counts) and on the vitest
object/widening/assignment suites.

**Out of scope (deferred — the value-LOSS half, #3022 DF-3).** The 5 remaining
rows use an **explicit** `{ value: undefined }` (e.g. `15.2.3.6-4-61/-101`). There
the widened field is typed `f64` (from a prior `obj.x = number` or resolver
default) and cannot hold `undefined`; the explicit-undefined path routes through
`emitDefinePropertyDescRuntime`. That is the value/identity-loss half the issue
explicitly separates from attribute fidelity — a distinct root cause left for the
#3022 tail. The array-index and Arguments-object defineProperty rows
(`15.2.3.6-4-243/-289`) are likewise separate receiver paths.

Tests: `tests/issue-3042.test.ts`.

## Standalone Object.create twin (2026-08-11)

The fresh maintained standalone ES5 baseline exposed the same `null` versus
`undefined` default at a second construction site. The static
`Object.create(proto, properties)` expansion passed `ref.null.extern` to
`__defineProperty_value` whenever a descriptor literal omitted `value`. In the
standalone carrier regime that is observable JS `null`, so seven
`15.2.3.5-4-204..211` `verifyProperty` rows and the two plain empty-descriptor
rows `15.2.3.5-4-153/-232` failed. The expansion now uses the canonical
regime-aware `emitUndefined`, matching this issue's widened-object fix.

IR boundary: the verdict-bearing Test262 lane compiles the literal harness and
test body as one multi-statement Script module initializer. That initializer is
not currently IR-claimable (the prepared IR module-init owner is intentionally
bounded to a one-statement exact-map shape), and IR has no `Object.create`
operation today. This fix therefore repairs the existing pre-IR compatibility
adapter only; it adds no second descriptor semantic model. A future IR
`Object.create` lowering must call the same runtime descriptor primitives and
use the canonical JS-undefined value representation rather than copying this
AST expansion.
