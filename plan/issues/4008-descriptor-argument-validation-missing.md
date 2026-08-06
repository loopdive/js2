---
id: 4008
title: "Descriptor-ARGUMENT validation missing in Object.create/defineProperties (ES 8.10.5) plus 8.12.9-step-1 redefine-over-inherited"
status: ready
sprint: current
created: 2026-08-01
updated: 2026-08-06
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

## 2026-08-06 — measured decomposition of the surrounding 232-file family

Investigated while working the "L1 — ToPropertyDescriptor (ES5 §8.10.5)" lever
(232 ES5-label `--target standalone` failures across
`15.2.3.5-4-*` / `15.2.3.6-3-*` / `15.2.3.7-5-b-*`). **The lever's framing —
"ToPropertyDescriptor does not read the descriptor's fields correctly" — is
mostly WRONG, and the sizing discipline note above applies again.** Measured
baseline on that list: **1 / 232 passing**.

Root causes, by reading bodies and probing each mechanism under
`--target standalone` (not by clustering error strings):

| files | root cause | is it ToPropertyDescriptor? |
| ---: | --- | --- |
| 76 | `new F()` where `F.prototype` was REASSIGNED does not link `[[Prototype]]` | no — prototype plumbing (#2660 S3 territory) |
| 51 | expando own-properties are silently DROPPED on `new RegExp()` / `new Date()` / `new Error()` | no — carrier storage |
| 34 | `Math` / `JSON` used as the descriptor object read back no fields at all | no — builtin-namespace storage |
| 12 | `Object.prototype.x = …` is invisible to every instance | no — prototype plumbing |
| ~59 | remainder (own-field on Array/plain, misc) | partly |

Probe evidence (each reproduced standalone, 2026-08-06):

- `regObj = new RegExp(); regObj.enumerable = true` → `regObj.enumerable` reads
  `undefined`, `hasOwnProperty` `false`, `in` `false`. Same for `Date` and
  `Error`. Every other receiver — plain object, array, function, Arguments,
  String/Number/Boolean wrapper — stores and reads back fine. So for a third of
  this family the descriptor never had the field to begin with; the reader was
  never the problem.
- `var proto = {}; var F = function(){}; F.prototype = proto; var c = new F();`
  → `"foo" in c === false` and `Object.getPrototypeOf(c) === proto` is
  **false**, even though `c.foo` reads through. That ConstructFun idiom is how
  test262 spells "inherited property", so it accounts for all 76.
- `Object.prototype.zzz = 1; ({}).zzz` → `undefined`, while
  `Object.getPrototypeOf({}) === Object.prototype` is `true`. The identity
  comparison passes without the chain being live.

### What landed (this PR)

Only the second row: `__is_closure_prop_carrier` (`src/codegen/closure-props.ts`)
now also accepts the `__StandaloneRegExp` and `__Date` structs, so the #3468
identity-keyed property bag covers them. **Measured 1 → 29 on the 232-file list,
0 regressions on the list.** `$Error_struct` is deliberately excluded — it
already owns a `$props` side-slot (fieldIdx 5, #2101a R5) that the
externref-backed-subclass own-field path writes directly, and bagging it would
give one receiver two disagreeing stores. Wiring Error to `$props` from
`__extern_get`/`__extern_set` is the next slice, worth ~17 files.

### Measured NEGATIVE result worth keeping

A spec-correct widening of `__desc_has_own` from HasOwnProperty to the full
§7.3.12 HasProperty (delegating to `__extern_has`, which already walks the
chain) was written, verified to change the emitted module, and measured at
**+0** — twice, once alone and once A/B'd against the carrier fix. It is a real
prerequisite for the 88 prototype-chain files but yields nothing until the chain
is actually live, so it was **dropped from the PR** rather than shipped as
unmeasured generality (the #4017 lesson: generality at a shared point IS blast
radius). Re-land it together with the prototype work, where it can be shown to
be load-bearing.

### Status of THIS issue's own two arms

Arms (a) and (b) as written above are **not** addressed by that PR and remain
open. Note that (b) — redefine over an inherited property — is blocked behind
the same prototype-chain gap: with `Object.prototype.x = …` invisible to
instances there is no inherited property to redefine over, so a §8.12.9 step-1
fix cannot be validated until the chain is live.
