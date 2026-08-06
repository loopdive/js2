---
id: 4008
title: "Descriptor-ARGUMENT validation missing in Object.create/defineProperties (ES 8.10.5) plus 8.12.9-step-1 redefine-over-inherited"
status: ready
sprint: current
created: 2026-08-01
updated: 2026-08-01
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: n/a
goal: standalone-gap
related: []
---

# Descriptor-ARGUMENT validation missing in Object.create/defineProperties (ES 8.10.5) plus 8.12.9-step-1 redefine-over-inherited

## Problem

**31 files**, ES5+untagged goal scope. Two related arms:

**(a) ES §8.10.5 `ToPropertyDescriptor` argument validation** — steps 1 / 7.b /
8.b / 9.a. Malformed descriptor arguments must throw `TypeError` and do not:

- `{prop: null}` — descriptor is not an Object
- `get:` bound to a primitive — non-callable accessor
- `get` and `value` present together — mutually exclusive fields

**(b) ES §8.12.9 step 1** — redefine over an **inherited** property.

Entry points: `Object.create` and `Object.defineProperties`.

## Why this is SEPARATE from the adjacent fixed work

- The strict-`[[Set]]` fix was the assignment / compound-assignment **write** path
  (37 files); root cause was the strict helper aliased onto the sloppy one.
  Nothing to do with argument validation.
- The array-`length` fix was the **Array-receiver define** path (35 files); a
  routing gap where `compileObjectDefineProperties` never reached the
  ArraySetLength helper.

This bucket is the **non-Array define path**, and it is about **rejecting
malformed descriptor arguments before any define happens** — a validation gap,
not a routing or enforcement gap.

## ⚠ Sizing discipline

These 31 were split out of a "117-file family" that turned out to be a
**signature** census, not a mechanism census: it decomposed into 37 / 35 / 31 /
11 (`Function.prototype.caller` poisoning) / 2 (`Object.getOwnPropertyNames` arg
validation) / 1 (`arguments.callee`). **Quoting 117 for any single fix overstates
it ~3x.** Read bodies, do not cluster error strings.

Scoped and deliberately not folded in by `g-enforce` 2026-08-01.
