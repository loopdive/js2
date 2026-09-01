---
id: 5170
title: "Error cause cannot install in native-string lanes — __struct_field_names unemitted (the #3912 gap) and the __sget_cause fallback is measured unsound"
status: ready
sprint: current
created: 2026-08-28
updated: 2026-08-28
priority: low
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
goal: core-semantics
related: [5161, 5159, 3912]
---

# `_installErrorCause` has no HasProperty answer in native-string lanes

Follow-up 1 of 2 from #5161 (PR #5189), which fixed Error *construction* under
`nativeStrings`/`fast` but measured that `new Error("m", {cause: c}).cause === c`
is **unreachable from the Error code path** in those lanes:

- `_installErrorCause` answers HasProperty on the options bag via
  `__struct_field_names`, which native-string lanes deliberately do not emit —
  the known #3912 gap, recorded in `emitStructFieldNamesExport`.
- The obvious fallback is **unsound, measured**: on a single-shape module,
  `__sget_cause` answers `null` under `fast` **even for a struct that HAS the
  field**. A throwaway fallback that did install `cause` was built to confirm
  the boundary — see #5171 for what it revealed downstream.

So the fix is not a local patch in `_installErrorCause`: it needs either
`__struct_field_names` (or an equivalent field-presence answer) emitted in
native-string lanes, or a sound per-field accessor contract there. Evidence
and instrumentation pattern: PR #5189's report and
`tests/issue-5161-native-string-error-message.test.ts`, where the residual is
pinned as current behaviour with the reason inline.

Note: even with HasProperty fixed, the user-visible `e.cause === c` check also
requires #5171 (host-object property reads in these lanes) — the two compose.

## Acceptance criteria

- `new Error("m", {cause: c})` installs `cause` in `nativeStrings` and `fast`
  (observable host-side even if #5171 is still open; state which observation
  route was used and why).
- The #5161 pins for this residual flipped to the fixed expectation; the
  #5159 (30), #3481 cause-2 (37) and #5161 (45) suites stay green.
- Byte-identity for modules constructing no Error with options, per lane;
  A/B with base captured at first edit; equivalence shards clean by name.
