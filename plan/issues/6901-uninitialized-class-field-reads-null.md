---
id: 6901
title: "A class field declared without an initializer reads `null`, not `undefined` (`class A { x; }`)"
status: done
sprint: current
created: 2026-10-07
updated: 2026-10-09
completed: 2026-10-07
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bug
area: codegen
goal: dogfood
related: [6900]
loc-budget-allow:
  # 2026-10-09 (#6901): uninitialized externref field DEFINEd as undefined in the field-init loop, deferring to #5312-claimed slots (+8 LOC, +7 in compileClassBodiesInner)
  - src/codegen/class-bodies.ts
func-budget-allow:
  # 2026-10-09 (#6901): uninitialized externref field DEFINEd as undefined in the field-init loop, deferring to #5312-claimed slots (+8 LOC, +7 in compileClassBodiesInner)
  - src/codegen/class-bodies.ts::compileClassBodiesInner
---

## Problem

```js
class A { pub; #p; read() { return this.#p; } }
const a = new A();
a.pub === null;      // true on main — must be false
typeof a.read();     // "object" on main — must be "undefined"
```

§7.3.33 DefineField defines a field with no initializer as `undefined`. The
instance struct is allocated with field defaults and the constructor's
field-initializer loop (`emitOwnInstanceFieldInitializers`, `class-bodies.ts`)
skipped every member without an initializer, so an `externref` slot kept its
struct default `ref.null extern` — JS `null`.

hono's `Context` declares `#status;` and builds responses with
`arg?.status ?? this.#status`; `null` survives `??`, so `c.body(text)` built
`new Response(text, { status: null })` and the host threw
`RangeError: init["status"] must be in the range of 200 to 599` (hono accepts
"decide language" row, and any handler that returns `c.body(...)` without a
status).

## Implementation Plan

In `emitOwnInstanceFieldInitializers`, visit uninitialized non-static, non-`declare`
property declarations in declaration order (DefineField order matters: a later
`x;` overwrites an earlier initializer's `this.x = …`) and, for an `externref`
slot only, store `emitUndefined`. Typed slots (`f64`, `ref`) keep their current
representation — that is a separate rep decision, not this bug.

## Resolution

Implemented as planned. Standalone/native-strings lanes: `emitUndefined`
resolves to the `$undefined` singleton under the #2106 regime, else
`ref.null.extern` (same value as before). Regression:
`tests/issue-6900-hono-accepts-concurrent-client.test.ts` (`typeof c.read()`,
`typeof c.pub`, plus an initialized-field control).

Interaction with #5312 (found 2026-10-09 re-basing onto current main): #5312
teaches the OBSERVATION sites that a typed uninitialised field's `ref.null` IS
its `undefined` (`m!: () => number`, annotation not admitting `null`). Storing
a host `undefined` into such a slot made those sites (`typeof this.m`, a
`ref.is_null` test) misread it — 11 rows of
`tests/issue-5312-uninitialised-field-reads-undefined.test.ts` went red. The
init loop now skips any field `uninitialisedFieldSlotOfDeclaration` claims
(the declaration-level half of #5312's predicate, split out for this), so the
two mechanisms partition the fields: annotated non-null fields keep #5312's
null-means-undefined, unannotated (JS) fields get a real `undefined`.
