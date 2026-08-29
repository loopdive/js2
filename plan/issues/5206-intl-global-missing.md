---
id: 5206
title: "Intl is not provided at all — `Intl.DateTimeFormat` throws; eighth Temporal blocker, a capability gap, not an init-window bug"
status: in-progress
assignee: ttraenkler/opus-dev-5206
sprint: current
priority: high
horizon: l
goal: standalone-gap
feasibility: hard
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-29
# 2026-08-29 (#5206): the host-`Intl` arm is one condition + its rationale on
# the existing #3087 host-global-materialization branch — the cheapest place
# that already owns "ambient name → real host global object". Splitting a
# 13-line addition (12 of them the comment explaining WHY `Intl` is not
# claimed by any value-shaped arm) into a new module would cost more than it
# buys.
loc-budget-allow:
  - src/codegen/expressions/identifiers.ts
func-budget-allow:
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
---

# #5206 — no `Intl` global (capability gap)

## Problem

Eighth Temporal module-init blocker (#4628 Option A). On the full fix stack
(#5252 + #5258 + #5262 + #5264 + #5266), the `@js-temporal/polyfill` bundle
advances through both `Object.fromEntries` tables and stops at position
4:10198 — `ct = Intl.DateTimeFormat`:

```
TypeError: Cannot access property on null or undefined
```

`Intl` is simply not provided. A scoped probe fails identically AFTER init
too (verified by dev-5205), so unlike #5193/#5202/#5203/#5205 this is a
**missing-global capability gap**, not the init-window timing family —
and likely a bigger piece of work.

## Direction (decide with evidence)

The polyfill needs `Intl.DateTimeFormat` (constructor + `formatToParts` /
`resolvedOptions` at minimum — measure what it actually calls) for calendar
and time-zone resolution. Options to evaluate:

1. **Host-lane import of the real host `Intl`** (the JS host has a full
   ICU-backed `Intl`) — likely the fast path: a boxed global like
   `Temporal`'s own eventual wiring, marshalled through the existing
   host-object bridges. Must work in the init window → needs the
   #5193/#5202 start-export channel for anything it reads back.
2. Minimal compiled shim covering exactly the polyfill's call surface —
   only if (1) is architecturally blocked; record why.

Keep standalone/WASI out of scope for this issue (no host Intl there —
that's a separate, much larger gap; note it, don't fix it).

Watch for the CLOSURE_UNSAFE_HOST_AMBIENTS interaction: if `Intl` becomes a
recognized ambient, re-verify the #2838 hazard the same way `Temporal`'s
entry is handled.

## Acceptance criteria

1. Reduced repro: `const f = new Intl.DateTimeFormat("en-US"); f` (and the
   polyfill's actual call shapes, measured) at init AND after init, host
   lane. New tests/issue-5206-*.test.ts failing on base, passing with fix.
2. Temporal harness advances past 4:10198 on the full stack. New later
   blocker → file it (coordinator allocates ids); `moduleInitRuns` true →
   say so LOUDLY — that un-gates the #4628 integration.
3. No regressions in the issue-5193/5202/5203/5205 test files + scoped
   runs (name them). Gates green.

## Notes

- Blocker chain: #5191 → #5193 → #5201 → #5202 → #5203 → (#5204) → #5205 →
  this.
- Stack on PR #5266's branch (issue-5205-fromentries-marshal) — sanctioned
  predecessor-stacking; lands after the whole stack.
- Id #5206 reserved with a degraded PR scan (gh offline); manually verified
  against open PR head branches 2026-08-29. `check:issue-ids:against-main`
  arbitrates.
