---
id: 3423
title: "Module-global representation: top-level bindings read as undefined under literal harness — ~600 default reclassifications"
status: ready
created: 2026-07-18
priority: medium
feasibility: hard
task_type: bugfix
area: codegen
goal: test262-conformance
model: fable
sprint: current
horizon: l
related: [3370, 3188, 3417]
---

# #3423 — top-level module-global bindings read as undefined under the literal harness

## Problem
#3370 stopped wrapping the test body in `export function test()`, which used to turn
module-global `var`/`let`/`function`/`class` bindings into function locals (masking a
representation gap). Under the literal harness the body runs as real top-level
`__module_init`, and cross-reference reads of those globals resolve to `undefined`.
Measured (oracle-v8, default lane) reclassification signatures:

- `Expected SameValue(«NaN», «undefined») to be true` = 122
- `Expected SameValue(«undefined», «"X"») to be true` = 80
- `Expected SameValue(«N», «undefined») to be true` = 35
- `null is not a constructor [in __module_init()]` = 47
- `obj should have an own property m` / `foo doesn't appear as an own property on the C
  constructor` / `strict rerun: obj should have an own property {length,name}` =
  201 + 136 + 92 + 86 (class field/method + function length/name own-property presence)
- `Cannot convert undefined or null to object [in verifyProperty()/verifyNotEnumerable()/
  verifyNotWritable()]` = 140 + 9 + 5

## Root cause (to confirm)
Two overlapping representation gaps the correct harness exposes:
1. **Top-level binding storage**: `var`/`let`/`function`/`class` declared at module
   top level are not stored/loaded as real module globals reachable by later top-level
   statements — later references read the uninitialised/undefined slot (hence the
   `SameValue(x, undefined)` and `null is not a constructor` families). Overlaps the
   module-code semantics umbrella #3188.
2. **Own-property presence on class/function objects**: class fields/methods and
   function `length`/`name` are not installed as observable own properties, so
   `verifyProperty`/own-property assertions fail.

## Implementation Plan
- Reproduce a minimal case: `var x = 1; assert.sameValue(x, 1);` and
  `class C { m(){} } assert(Object.prototype.hasOwnProperty.call(C.prototype,'m'))`
  through the literal harness; confirm the undefined/own-property gaps.
- Sub-family 1: ensure top-level `var`/`let`/`function`/`class` bindings are emitted as
  module globals with correct init ordering and TDZ, and later top-level reads load the
  live slot. Coordinate with #3188 (module-code semantics) to avoid double-work — this
  may be a child of #3188.
- Sub-family 2: install class methods/fields and function `length`/`name` as
  enumerable/own properties per spec so `verifyProperty` observes them.

### Edge cases
- TDZ for `let`/`const` (read-before-init must throw ReferenceError, not undefined).
- Function `.name`/`.length` and class static vs instance property placement.
- Hoisting order of `function` declarations vs `var`.

## Verification
- Scoped: `language/statements/{class,let,const,var}/**` own-property + value tests
  pass on the default lane.
- Cross-check with #3188 to route shared module-semantics work.

## Notes
This is genuinely HARD (representation work) — spec first, land incrementally. Likely
overlaps/merges with #3188; the architect/PO should decide whether to fold this into
#3188 or keep it as the v8-reclassification-scoped child.
