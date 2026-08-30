---
id: 5211
title: invokeMethod never callable-wraps struct arguments — a compiled comparator crosses to Array.sort as an opaque struct
status: ready
sprint: current
priority: high
horizon: m
goal: core-semantics
feasibility: hard
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-30
---

# #5211 — compiled sort comparator crosses as an opaque struct

## Problem

Eleventh Temporal module-init blocker (#4628). With the full fix stack plus
PR #5283 (#5209), the polyfill sorts the era table right after the filter
guard and stops at:

```
TypeError: The comparison function must be either a function or undefined: [object Object]
    at Array.sort (<anonymous>)
    at invokeMethod                 src/runtime.ts:10952
    at GregorianBaseHelper_init ← OrthodoxBaseHelper_init ← EthiopicHelper_init ← __module_init
```

`moduleInitRuns` stays false.

## Mechanism (located by dev-5209)

`invokeMethod` (src/runtime.ts:10952) wraps struct arguments with
`_wrapForHost(args[i], exports)` where `exports = callbackState?.getExports()`
(undefined at init — the same window family), and **never applies
`_maybeWrapCallableUnknownArity` to arguments at all** — so a compiled
comparator closure crosses to the host `Array.sort` as an opaque struct even
after init. Two facets to verify separately:

1. Timing: `getExports()` → `marshalExports()` on that path (the established
   pattern from #5193/#5202/#5205/#5209).
2. Capability: callable-wrapping of struct arguments that are compiled
   closures. dev-5209 deliberately did NOT do this — `invokeMethod` is the
   DOM lane's hot path and adding callable-wrapping semantics to arguments
   is a behaviour change needing its own regression run. Measure the
   after-init behaviour of `arr.sort(cmp)` with a compiled closure on base
   first: if it is ALSO broken after init, this is a capability gap, not
   just timing.

## Acceptance criteria

1. Reduced repro: `t.sort((a,b) => a.x - b.x)` on an untyped param inside a
   ctor, at init AND after init, host lane; plus a DOM-lane-shaped control
   (host method taking a compiled callback via invokeMethod) proving no
   behaviour change where it worked before. New tests/issue-5211-*.test.ts
   failing on base for every wrong row.
2. Perf sanity on the invokeMethod hot path — no wrapping added for
   non-closure structs; state how you kept the fast path.
3. Temporal harness measured before/after on the full stack (…#5279 → #5283
   → this). Advances past the sort error; new later blocker → report
   precisely; `moduleInitRuns` true → say so LOUDLY.
4. No regressions in issue-5209/5207/5205 test files + DOM/host-method
   scoped runs (name them). Gates green.

## Notes

- Found by dev-5209 while validating PR #5283. Related unfiled observations
  recorded in that PR's body (dynamic-receiver init trap — possibly #5210
  family; vec write-side exports not on the init channel) — file them only
  if they land on the critical path.
- Id #5211 reserved with a degraded PR scan; manually verified against open
  PR head branches 2026-08-30. `check:issue-ids:against-main` arbitrates.
