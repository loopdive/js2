---
id: 5171
title: "Reading any property off a genuine host object is broken in native-string lanes — typeof o.s answers null (nativeStrings) or traps with illegal cast (fast)"
status: ready
sprint: current
created: 2026-08-28
updated: 2026-08-28
priority: medium
horizon: l
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [5161, 5170, 3481]
---

# Host-object property reads are lane-broken, not Error-specific

Follow-up 2 of 2 from #5161 (PR #5189). Measured on `origin/main` during that
work — **pre-existing and independent of the Error fix**:

| expression (o is a genuine host object) | default | `nativeStrings` | `fast` |
| --- | --- | --- | --- |
| `typeof o.s` | `"string"` | `null` | **`illegal cast` trap** |
| `(o.n as number) === 42` | `true` | `false` | `false` |

Confirmed rather than reasoned: during #5161 a throwaway `__sget_cause`
fallback that *did* install `cause` on the Error still left `e.cause === c`
reading `DIFFERENT` — the write landed, the read-back path is what lies.

This blocks the user-visible half of #5170 (`e.cause === c`) and plausibly a
wide class of host-interop shapes in the native lanes. First step is a
measured census of the property-read lowering per lane (which accessor import
or cast chain each read routes through, where the null/cast originates) before
any fix — the two lanes fail differently, so do not assume one mechanism.

Evidence trail: PR #5189's report ("What is NOT fixed", boundary 2) and the
pinned residual rows in `tests/issue-5161-native-string-error-message.test.ts`.

## Acceptance criteria

- The per-lane read-path census recorded (measured, with the failing boundary
  named per lane) before the fix.
- `typeof o.s === "string"` and `(o.n as number) === 42` for a host object in
  both native lanes; default lane byte-identical.
- The #5161 pinned residuals flipped where this unblocks them; #5159/#3481/
  #5161 suites green; A/B with base at first edit; equivalence clean by name.
