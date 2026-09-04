---
id: 5249
title: "Compiled Temporal polyfill traps `RuntimeError: unreachable` in HelperBase_adjustCalendarDate — largest residual family after provider wiring (123 of 838 sampled rows)"
status: done
sprint: current
priority: high
horizon: m
goal: core-semantics
reasoning_effort: high
requested_by: ttraenkler/fable-lead
assignee: ttraenkler/dev-5249
created: 2026-08-31
completed: 2026-09-03
---

# #5249 — `unreachable` in `HelperBase_adjustCalendarDate()` (Temporal residual, top family)

## Problem

With the test262 runner wired to the compile-once Temporal provider (#5248 /
PR #5375), the single largest residual failure family in the 838-row sampled
Temporal bucket is **123 rows** failing with
`RuntimeError: unreachable in HelperBase_adjustCalendarDate()`.

The polyfill's calendar arithmetic (`@js-temporal/polyfill@0.5.1`,
`HelperBase.adjustCalendarDate` and its callers) hits a compiled `unreachable`
trap — i.e. js2wasm lowered some reachable path in that function to an
`unreachable` instruction (typical causes: an unhandled expression/statement
shape demoted to a trap, an exhaustiveness fallthrough, or a cast ladder with
no fallback arm). The trap fires on non-ISO calendar operations broadly, so
the family spans `intl402/Temporal/**` (calendar-sensitive `from`, `add`,
`until`, `with` rows).

## Evidence and bounds

- Counts come from dev-5248b's sample census (838 rows, two agreeing runs,
  provider built cold in-tree — see PR #5375's measurement section and
  `.tmp/` artifacts in worktree `agent-a316c90e14c5ca605`).
- **Sample census only — no bucket-wide count is claimed**; the sample is not
  proportional. The family is the top residual by a wide margin (next:
  74× ZonedDateTime_init destructure-null, #5221/#5243 family).

## Direction

1. Reduce: compile the polyfill, call a non-ISO calendar op
   (e.g. `Temporal.PlainDate.from({calendar:"hebrew", ...})` or an ISO row
   that routes through `adjustCalendarDate`) and capture the trap.
2. Find which construct inside `adjustCalendarDate` lowers to `unreachable`
   (disassemble the provider around the trap, or bisect the function's source
   shapes in a probe compile).
3. Fix the codegen gap; a hard compile error is acceptable over a silent
   trap if the shape is genuinely unsupported — but the goal is to run it.

## Acceptance criteria

1. A base-failing reduction pinning the trap; fixed to spec behaviour.
2. Measured on the same sampled bucket: the 123-row family shrinks
   substantially (state the new count); no regressions in the
   issue-5221…5248 provider family; gates green.

## Notes

- Filed from PR #5375's residual worklist (dev-5248b census).
- Id reserved with a degraded open-PR scan (gh unreachable from the
  container); manually checked against open PR head branches 2026-08-31.

## Outcome (2026-09-03)

**Fixed:** the `unreachable` itself. Open-receiver `this.m(...)` dispatch built
its `__tag` cascade from direct children that DECLARE the method; the cascade's
terminal `else` is `unreachable`, so a grandchild that declares an override and
any descendant that merely inherits one trapped at run time on a module that
compiled clean. `collectOpenReceiverCandidates`
(`src/codegen/expressions/virtual-candidate-set.ts`) now spans the full
descendant set, each resolved to its nearest declaring ancestor.

**Additive-only, measured not asserted.** For a hierarchy whose declarers are
all direct children — where the old walk was already complete — the emitted WAT
is **byte-identical** before and after (5,154 bytes both sides, A/B on this
branch). Declared direct children keep their `classParentMap` order, so
`candidates[0]` (the static fallback and the emitter's result-type schema) is
unchanged wherever the old walk produced one.

**The 123-row family does NOT go green, and this is the honest headline.**
Full measurement, all 123 rows, provider linked, on this branch:

| | rows | pass | fail |
| --- | --- | --- | --- |
| after (this fix) | 123 | 0 | 123 |

`unreachable in HelperBase_adjustCalendarDate()`: **123 → 0** — the targeted
trap is gone from every row. But no row turns green; each now fails one layer
deeper:

| rows | new failure |
| --- | --- |
| 120 | `RuntimeError: illegal cast in HebrewHelper_minMaxMonthLength()` |
| 3 | `RangeError: Invalid monthCode: M13 in ti()` |

The issue assumed one defect gated these rows; there are at least three stacked
behind each other. The acceptance criterion "the family shrinks substantially"
is therefore NOT met by this change alone, and no such claim is made. What this
change does deliver is the removal of a class of silent runtime traps on
modules the compiler reports as clean.

Equivalence gate: 24 failing / 1718 passing — exactly the baseline.

### The `HebrewHelper` route — investigated, ruled pre-existing (with its bound)

A *Japanese*-calendar row now executes `HebrewHelper_maximumMonthLength`, which
looks like a cross-subtree mis-dispatch. Evidence it is not this change's:

1. `minMaxMonthLength` is declared **exactly once** in the whole polyfill, in
   the same class as the `minimumMonthLength`/`maximumMonthLength` wrappers —
   `HebrewHelper`, per the compiled frame names.
2. Several other classes declare their own `maximumMonthLength`, so
   `this.maximumMonthLength(e)` in `HelperBase_regulateMonthDayNaive` is an
   open-receiver call with several declaring candidates, and `candidates[0]` is
   the first declarer in `classParentMap` order — `HebrewHelper`.
3. `candidates[0]` is provably unchanged by this fix (the byte-identical A/B
   above), and it is what an open-receiver call statically binds to whenever
   `emitVirtualMethodDispatchByTag` takes one of its transactional bail-outs.

**Bound:** this is inference from (1)-(3), not a direct observation of the same
frame on base — on base these rows die earlier at the `unreachable`, so the
route is unobservable there. `wasm2wat` in this container predates WasmGC and
cannot disassemble the provider, and the polyfill does not compile standalone
(it needs the linker path), so both direct-disassembly routes were closed.

### Follow-up worth filing

An open-receiver call that binds statically to `candidates[0]` when the cascade
emitter bails is **unsound**: it calls a sibling subtree's body for any receiver
whose runtime type is not `candidates[0]`. That is a separate defect from this
one and is what the `HebrewHelper` route above is an instance of.
