---
id: 3076
title: Standalone destructuring lane must honor throwing accessor getters / user @@iterator
status: ready
sprint: current
model: fable
priority: medium
horizon: m
feasibility: hard
blocks: [3040]
created: 2026-07-07
updated: 2026-07-08
---

# Standalone destructuring must invoke throwing accessor getters / user `@@iterator`

## Problem

The standalone (pure-Wasm) destructuring lowering does **not** invoke
user-defined accessor **getters** or a user-defined **`@@iterator`** while
binding a destructuring pattern. So a pattern like:

```js
var { p } = { get p() { throw new Test262Error(); } };   // getter never fires (standalone)
var [ a ] = iterableWithThrowingNext;                     // @@iterator/next never fires (standalone)
```

silently binds instead of throwing. In **host mode** the accessors are
invoked correctly; this gap is standalone-only.

## Why this surfaced now (#3040)

Discovered while unparking **#3040** ("thread param-default captures in
closures + object destructuring"). #3040 is net-correct
(+75 host pass, +12 genuine standalone fail→pass), but it exposed **14
standalone `dflt-*-err.js` false-passes**:

- On main those 14 (`default = <outer var>` destructuring where a getter /
  `@@iterator` throws) passed only *incidentally*: the outer var was **not
  captured** → the default read `null` → destructure-of-`null` threw a
  `TypeError`, and standalone `assert.throws(Test262Error, …)` is **lenient**
  (opaque WasmGC thrown values ⇒ any throw counts as a pass). So they were
  **false-passes**, not real coverage.
- #3040 correctly captures the outer var, removing the incidental
  null-throw. The *intended* getter / `@@iterator` throw still does not fire
  (this gap), so `f()` doesn't throw at all → the lenient `assert.throws`
  now fails. Hence the 14 standalone flips (host mode: all 14 correctly pass).

The 14 are therefore a symptom of THIS gap, not a #3040 regression. #3040 is
**gated on this issue** (`blocks: [3040]`): once the standalone destructuring
lane invokes throwing accessors / user `@@iterator`, the 14 genuinely pass
and #3040 can land.

## Acceptance criteria

1. Standalone object-pattern binding invokes a property's accessor **getter**
   (and propagates a thrown value) at the spec-mandated point
   (GetV / ToObject-then-Get ordering, before default evaluation where the
   spec requires).
2. Standalone array/iterable-pattern binding invokes the user
   **`@@iterator`** + `next()` and propagates thrown values.
3. The 14 `dflt-*-err.js` standalone tests identified under #3040 flip to
   genuine pass (getter/`@@iterator` actually throws), with #3040's branch
   merged.
4. No standalone regressions in the broader
   `language/**/dstr/**` corpus (scoped sweep, 0 net pass→fail).

## Notes

- The lenient standalone `assert.throws` (opaque WasmGC thrown values ⇒ any
  throw passes) is a separate, known harness limitation; this issue is about
  the codegen lane actually invoking the accessors, not the harness.
- Related substrate: standalone value-read / `$Object` dynamic reader.
