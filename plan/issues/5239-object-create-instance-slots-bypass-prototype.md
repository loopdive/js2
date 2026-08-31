---
id: 5239
title: "Member reads on an Object.create(proto)-built host object never reach the compiled prototype's accessors — module-independent, the true cause of Temporal .from() results answering undefined/[object Object]"
status: ready
sprint: current
priority: high
horizon: l
goal: core-semantics
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-31
---

# #5239 — `Object.create(proto)` host objects bypass compiled prototype accessors

## Problem

`Temporal.PlainDate.from("2020-03-04")` still answers `.toString()` →
`"[object Object]"` and `.year` → `undefined` after #5237 (PR #5343), and
dev-5237's control DISPROVES the cross-module theory: the same polyfill +
consumer compiled into ONE module with `compileMulti` (no linker,
`linkedModules === 0`) answers identically. The polyfill's
`CreateTemporalDate` builds its instance as `Object.create(PlainDate.prototype)`
and keeps ISO fields in slots keyed by that HOST object; a host object whose
prototype is a WasmGC struct never reaches the prototype's accessors on a
member read.

Reduced non-Temporal (in `tests/issue-5237-cross-module-class-members.test.ts`
base pins): `Object.create(C.prototype)` built INSIDE the class's own module
dispatches correctly after #5237; the same expression in a consumer against a
`C.prototype` read through the ctor-mirror facade answers `Pnull:null` where
the single-module control answers `P1:2`. And explicit-proto method calls work
(`prototype.toString.call(inst)` → `"2020-03-04"` after #5237) — it is the
implicit member-read path on the host object that never walks its
proto chain into the compiled dispatch surface.

Direct successor to #5223's "Not fixed" item 1 and #5237's kept `staticFrom`
knownGap; harness rows: `staticFrom` in
`tests/dogfood/temporal-global-harness.mjs`.

## Direction

The host-lane property read on a plain host object with a mirror/struct
prototype (`_safeGet` / `__extern_get` tail) must, on an own-property miss,
walk `Object.getPrototypeOf` and route a hit on a compiled prototype through
the same `__call_get_*` / `__member_kind_*` dispatch #5223 wired — with the
receiver bound to the ORIGINAL host object (its slots carry the state), which
#5237's `selectBridgeReceiver` now supports. Watch the #3903 hot path.

## Acceptance criteria

1. Non-Temporal: `Object.create(C.prototype)` in the consumer answers getter
   and method reads correctly (flip the pinned base rows in issue-5237 tests).
2. `Temporal.PlainDate.from("2020-03-04").toString()` → `"2020-03-04"`,
   `.year` → `2020`, single-module AND provider lanes; flip the harness
   `staticFrom` knownGap. This unblocks wiring the test262 runner to the
   provider (#4628 criterion 2) together with #5225/#5226.
3. No regressions: issue-5221/5222/5223/5237/4628 + linker family; equivalence
   gate at baseline. Gates green.

## Notes

- Found by dev-5237 (PR #5343) with the 37.9 s single-module control run.
- Id reserved with a degraded PR scan; manually checked against open PR head
  branches 2026-08-31.
