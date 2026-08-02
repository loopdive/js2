---
id: 4083
title: "A transferred `RegExp.prototype.test` on a RegExp receiver now returns `null` instead of crashing — a #3992 receiver-matching gap that the crash was masking"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: standalone
language_feature: n/a
goal: standalone-mode
related: [3992, 4082]
---

# Transferred RegExp receiver answers `null` instead of crashing

Filed by the lead 2026-08-02 as a **required condition** of shipping #4082
(PR #4011). The authoring agent surfaced this residual itself rather than
letting it pass, and explicitly asked to be overruled if the call went the other
way. It did not — #4082 ships — but the trade is recorded here rather than
absorbed.

## Repro (standalone)

```js
var re = /a/;
re.borrowed = RegExp.prototype.test;
re.borrowed("banana");
```

| | before #4082 | after #4082 |
| --- | --- | --- |
| outcome | **crashes** (invalid Wasm) | **validates, answers `null`** |

## This is a LOUD failure becoming a QUIET wrong answer

No test moves from pass to fail — the file was broken before and is broken now.
What degrades is **diagnosability**. That is the same class as #4075 (a refusal
erased before it is reported), #4071 (enumeration silently empty) and #4064
(silent infinite recursion): a subsystem that produces a plausible value instead
of announcing that it cannot answer.

It is filed **because** it is that class. A loud→quiet trade is acceptable when
it is tracked and unacceptable when it disappears into a green PR.

## ⚠ It is NOT caused by #4082's boxing — that was checked, not assumed

A trace shows the #4082 arm selecting `f64.convert_i32_s ; call $__box_number`,
which **cannot** yield null. The null comes from further out: the **#3992
exact-identity receiver guard does not match this receiver at runtime**, so the
outer dispatch falls through to its own `ref.null.extern`. The crash was
previously masking that fall-through.

**#3992's own doc block already names `null` as the symptom of this gap.** So
this is a known, documented coverage hole newly made visible — not a new defect
introduced by #4082.

## ⚠ Do NOT write a test that asserts `null`

The #4082 tests deliberately do **not** pin the returned value, and that must
stay true until this is fixed. Asserting the current value would freeze the bug
and manufacture exactly the vacuous pass this project spent #3603 removing
~989 of. Removing a refusal and exposing what it masked is progress; pinning the
exposed wrong answer converts it into a permanent false green.

## Work

1. Widen the #3992 transferred-native-proto receiver matching so a RegExp
   receiver carrying a transferred `RegExp.prototype.test` is matched.
2. Establish the population first — this repro is **one shape**; do not size the
   fix from it. Report the funnel per stage against a force-refreshed standalone
   baseline, with denominators.
3. Prove attribution by kill-switch removal, and re-run every apparent
   regression **solo** before believing it (a fully serial sweep inflated
   apparent regressions ~79% on 2026-08-02).

## Context

#4082 itself is sound and measured: population 53 → mechanism 12 → reachable 12
→ **9 flips**, kill-switch 12/12 fail on revert, regression control 500 → 496
with all 4 non-passes failing identically on revert (**0 attributable**). The 9
flips assert a genuine `TypeError` on a non-RegExp receiver, confirmed by probe
(`caught === 2`) rather than assumed — they are real, not vacuous.
