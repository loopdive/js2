---
id: 3662
title: "Descriptor `value` reads back wrong from getOwnPropertyDescriptor (153 tests)"
status: ready
sprint: current
created: 2026-07-26
updated: 2026-07-26
priority: high
horizon: m
complexity: M
feasibility: medium
task_type: bugfix
area: codegen, runtime
language_feature: property-descriptors
es_edition: es5
goal: es5
related: [3647, 3661, 3663, 739, 3603]
origin: "2026-07-26 lead measurement of the #3603 host de-inflation regression set (merge_group run 30179758665), decomposed per failed assertion."
---

# #3662 — descriptor `value` reads back wrong

## Measured population

From the #3603 de-inflation merged report (merge_group run `30179758665`) diffed
against the baseline JSONL; reconstruction totals **exactly 1,066**, matching the
gate.

**153 tests** fail on a `value`-shaped assertion. The two clause forms observed:

| clause                              | occurrences |
| ----------------------------------- | ----------: |
| `obj[X] value should be <VALUE>`    |         140 |
| `obj[X] descriptor value should be <VALUE>` | 115 |

(The two overlap heavily — most affected tests emit both, one for the direct
property read and one for the descriptor's `value` field.)

Observed concrete expectations in the corpus include `gen`, `fn`, `arrow`, and
`undefined` — i.e. **class members and function-valued properties**, plus a
distinct sub-family asserting `value should be undefined`.

## Why this is filed separately from #3647 / #3661

`enumerable` (#3647) and `writable`/`configurable` (#3661) are **attribute**
defects — booleans that read back wrong. This is a **value** defect: the property
holds, or reports, the wrong thing entirely. That is plausibly a different
mechanism (wrong slot read, accessor-vs-data confusion, or a sidecar/struct
two-store mismatch) and should not be assumed to fall out of the attribute
fixes.

**Check first whether it does.** If fixing #3647 or #3661 also clears these, close
this as subsumed and say so — that is a perfectly good outcome and cheaper than
a parallel investigation. What must not happen is assuming either way.

## Strong prior — the two-store pattern

Three defects tonight shared one shape: **a value is written to one store while a
second, unconditional path answers the read**. #739's descriptor bug, the
`__vec_len`/vec-mirror dual route, and the Annex B `funcMap` registration. A
descriptor whose `value` reads back wrong while its attributes are right is
exactly that silhouette — the accessor may be landing in a sidecar the
struct-field reader never consults.

See #739's S1 pin (`collectEmptyObjectWidening`) and the parked branch
`issue-739-s2-descriptor-consult` (`20da830ec`), which fixed precisely this class
for **descriptor objects**: a non-empty object literal that later receives an
accessor define stays widened, the accessor lands in the sidecar, and
`ToPropertyDescriptor`'s struct-field reader misses it. **Read that before
starting** — this may be the same bug seen from the receiver side.

## Acceptance

- [ ] Determine whether this is subsumed by #3647 / #3661 / #739-S2; record the
      answer either way.
- [ ] If distinct: identify the mechanism by direct probe on HEAD.
- [ ] Regression test **red on the merge base**.
- [ ] Report the **measured flip count** from a re-run, with its denominator.

## ⚠️ Do not quote 153 as a flip count

It is a floor for tests failing on this assertion, not a forecast of flips.

## Provenance caveat

Baseline used was the then-current cache, not the exact artifact the gate read
(#3648). The 1,066 total matching exactly means the regression **set** is right;
individual counts may shift by a few.
