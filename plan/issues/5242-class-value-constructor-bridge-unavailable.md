---
id: 5242
title: "A compiled class reached as a VALUE has no constructor bridge — 'compiled class constructor Duration bridge unavailable'; Temporal add/subtract construct Duration dynamically and throw"
status: ready
sprint: current
priority: high
horizon: m
goal: core-semantics
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-31
---

# #5242 — dynamic class-value construction has no constructor bridge

## Problem

After #5241 (PR #5350) un-hijacked the method calls, Temporal arithmetic now
reaches the polyfill and fails one level deeper:
`Temporal.PlainDate.from("2020-03-04").subtract({days: 1})` (and
`.add("P1D")`) throws `TypeError: compiled class constructor Duration bridge
unavailable` — in the SINGLE-MODULE lane, so it is not a provider-seam
defect. The polyfill constructs `Duration` through a class VALUE (its
intrinsics registry, `new (ce("%Temporal.Duration%"))(…)`), and a compiled
class reached as a value has no CONSTRUCTOR bridge: #5239 fixed the
`Object.create(value.prototype)` instance-minting path, but `new value(…)` /
Reflect-style construction through the host still finds no
`__class_construct_*`-equivalent export.

## Direction

Adjacent to #5239 (same registry-variable spelling, construct path instead
of create path). Reduce with a plain class reached via a registry object:
`const K = reg.K; new K(1,2)` through the host / dynamic lane. Emit or route
a constructor bridge the way #5239's `__object_create_class_instance` matches
prototypes — likely match the class-value mirror to its `struct.new` ctor by
identity, host-side `_construct`/callable-mirror arm in `src/runtime.ts` +
emission next to `emitClassMemberKindExports`. Mind the init-window channel
(#5202) — the polyfill constructs during module init.

## Acceptance criteria

1. Plain-class reduction: `new (reg.K)(…)` constructs a real instance
   (fields, methods, getters) — single-module and linked lanes; new
   `tests/issue-5242-*.test.ts` failing on base with a passing
   direct-identifier control.
2. `Temporal.PlainDate.from("2020-03-04").subtract({days: 1}).toString()` →
   `"2020-03-03"` single-module (provider lane may stay blocked by #5225's
   consumer-literal argument — measure and report per lane). Update harness
   KNOWN_GAPS accordingly.
3. No regressions in issue-5239/5241/5237/5223/5221/4628 + linker family;
   equivalence gate at baseline. Gates green.

## Notes

- Found by dev-5241 (PR #5350 "Reported, NOT fixed"); `subtract` fails
  identically on its base, so pre-existing. Sibling of #5239.
- Id reserved with a degraded PR scan; manually checked against open PR head
  branches 2026-08-31.
