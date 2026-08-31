---
id: 5243
title: "An object argument through the dynamic method bridge arrives as null — ISO calendar dateAdd's destructuring parameter throws 'Cannot destructure null or undefined'; blocks all Temporal arithmetic single-module"
status: ready
sprint: current
priority: high
horizon: m
goal: core-semantics
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-31
---

# #5243 — dynamic method bridge nulls an object argument

## Problem

After #5242 (PR #5354) gave class values a constructor bridge, every
single-module Temporal arithmetic row (`add`/`subtract`, object or string
argument) lands on `TypeError: Cannot destructure 'null' or 'undefined'`,
thrown by the ISO calendar's
`dateAdd(e, {years = 0, months = 0, weeks = 0, days = 0}, i)` — its second
argument arrives **null** through the dynamic method bridge chain
`__extern_method_call` → `__call_fn_method_3` → `__anon_0_dateAdd`.

Control (dev-5242b): `add({days: 1})` constructs no Duration at all and fails
with the same message and a byte-identical stack on #5354's base — so this is
an argument-marshalling gap on the dynamic METHOD bridge, pre-existing and
independent of the constructor path. Adjacent to #5221's through-line (a
slot/shape mismatch silently coerced to null) and to #5221 defect 6 (call-site
specialisation of forwarding params).

## Direction

Reduce non-Temporal: a method with a destructuring-with-defaults object
parameter, called through the dynamic bridge (`any` receiver / 3-arg
`__call_fn_method_3` shape) with a real object argument. Establish where the
null appears: the bridge's argument coercion (`callArgCoercionInstrs` family),
the `__anon_*` specialised param type rejecting the shape (ref.test →
ref.null), or the method-3 dispatcher's marshalling. Fix at the general site;
never let a failed shape test coerce to null silently.

## Acceptance criteria

1. Non-Temporal reduction answers correctly; `tests/issue-5243-*.test.ts`
   failing on base with controls.
2. Single-module: `Temporal.PlainDate.from("2020-03-04").add({days:1}).toString()`
   → `"2020-03-05"`, `.subtract({days:1})` → `"2020-03-03"`. Update harness
   KNOWN_GAPS/SUPPORTED honestly; provider lane may stay blocked by #5225.
3. No regressions in the issue-5221…5242 family + linker family; equivalence
   gate at baseline. Gates green.

## Notes

- Found by dev-5242b (PR #5354 "Reported, NOT fixed" item 1) with control.
  This is now THE single-module blocker for Temporal arithmetic conformance.
- Id reserved with a degraded PR scan; manually checked against open PR head
  branches 2026-08-31.
