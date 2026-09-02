---
id: 5249
title: "Compiled Temporal polyfill traps `RuntimeError: unreachable` in HelperBase_adjustCalendarDate — largest residual family after provider wiring (123 of 838 sampled rows)"
status: in-progress
sprint: current
priority: high
horizon: m
goal: core-semantics
reasoning_effort: high
requested_by: ttraenkler/fable-lead
assignee: ttraenkler/dev-5249
created: 2026-08-31
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
