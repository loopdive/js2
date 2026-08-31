---
id: 5237
title: "Compiled-class members resolve against the CALLING module's exports — every prototype member of a linked provider's class answers undefined in the consumer"
status: ready
sprint: current
priority: high
horizon: l
goal: core-semantics
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-31
---

# #5237 — cross-module compiled-class member resolution

## Problem

Through the #4628 linked provider, every member read off a provider class's
prototype answers `undefined` in the consumer:
`typeof Temporal.PlainDate.prototype.toString` is `"undefined"`, `d.year` /
`d.month` / `d.day` on a `.from()` result are `undefined`, and
`Temporal.PlainDate.prototype.toString.call(d)` throws "Cannot read
properties of null" — while `Object.getOwnPropertyNames(PlainDate.prototype)`
correctly lists all 31 names. This is why the harness `staticFrom` row still
prints `[object Object]` after the #5223 fix (PR #5339 re-measured:
byte-identical before/after, so it is a distinct defect).

Root cause (measured by dev-5223): the host boundary resolves compiled class
members against the **calling module's** exports. The provider binary exports
141 `__member_kind_*` / 41 `__call_get_*` / 137 `__class_call_*`; the
consumer exports none, so nothing resolves. A `new`-built instance escapes
because its host proxy carries the provider's export slot; a prototype-read
or `Object.create(proto)` path does not.

Control: the identical single-module shape answers `"function"`.

## Direction

Same family as #5222 (PR #5324's module-aware mirrors) and #5225: the member
resolver needs to consult the exports of the module that OWNS the class (the
minting module recorded on the mirror/prototype), not the reader's. Likely
site: `_resolveClassMember` / `_safeGet` in `src/runtime.ts` and the linked
provider export registry from #5324 — route resolution through the owner's
registered export set when the receiver/prototype is foreign.

## Acceptance criteria

1. Non-Temporal linked reduction: prototype member reads and getter reads on
   a provider class resolve in the consumer; new `tests/issue-5237-*.test.ts`
   failing on base (linked lane), single-module control passing on base.
2. Temporal: `Temporal.PlainDate.from("2020-03-04").toString()` answers
   `"2020-03-04"` and `.year` answers `2020` through the provider; flip the
   harness `staticFrom` knownGap.
3. No regressions: issue-5222/5223/4628 test files + #2527 linker family.
   Gates green.

## Notes

- Found by dev-5223 (PR #5339 "Found and NOT fixed" item 1) with counts and
  controls. With #5225/#5226, this is the remaining provider-seam family
  before the test262 runner can be wired to the provider (#4628 criterion 2).
- Id reserved with a degraded PR scan; manually checked against open PR head
  branches 2026-08-31.
