---
id: 2142
title: "Reconcile undefined-representation ownership: #2051 spec (externref widening) vs #2106 (UNDEF_F64 sentinel)"
status: ready
sprint: 62
created: 2026-06-12
updated: 2026-06-12
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: docs
area: planning
language_feature: undefined
goal: consistency
related: [2051, 2106, 2004]
origin: "2026-06-12 sprint-62 architecture analysis (value-rep workstream N1)"
---

# #2142 — two architect documents prescribe different representations for the same sites

## Problem

The #2051 spec (PR #1393, `arch-2051-undefined-repr`) prescribes
**externref widening + host `undefined`** for optional-chain short-circuit
arms; #2106 (value-rep P3) prescribes the **`UNDEF_F64` sentinel** for the
same producer list. A dev dispatched on either will contradict the other.

## Approach

Amend #2106: remove #2051's sites from its producer list; record the
decision rule — *widen when consumers already discriminate externref;
sentinel only inside hot f64 carriers* (codePointAt OOB, f64 destructuring
reads). #2051 lands per its own spec (it composes with all three existing
consumers and needs zero observer changes).

## Acceptance criteria

- Both documents name exactly one owner mechanism per site.
- #2051's t4/t6 cases and #2004's `codePointAt ?? -1` each cite exactly one
  mechanism.

## Notes

Doc-only, S-size. Do before dispatching #2051 or #2106.
