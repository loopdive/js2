---
id: 6750
title: "S3-i: the native regime must clear the per-edition ratchet floors (ES5 −99, ES2026 −179, ES2016 −9, ES2023 −4 vs the host lane)"
status: ready
created: 2026-09-29
updated: 2026-09-29
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen, testing
language_feature: conformance
goal: architecture
sprint: current
parent: 5385
depends_on: [6710]
related: [3468, 3178, 4394, 6708, 6709]
---

# #6750 — S3-i: edition-ratchet parity for the native regime

Slice S3-i of the #5385 "Implementation Plan v2"; #6708 evidence item 2.
`pnpm run check:edition-ratchet -- --results <regime JSONL>` on nightly
36399520787 (2026-09-28) against the host-lane floors:

| edition              | floor  | regime | delta    |
| -------------------- | ------ | ------ | -------- |
| ES5                  |  9,028 |  8,929 | **−99**  |
| ES2016               |     99 |     90 | **−9**   |
| ES2023               |    172 |    168 | **−4**   |
| ES2026               |    266 |     87 | **−179** |
| Unclassified (legacy)|    273 |    272 | −1       |
| ES2015 / ES2018 / ES2020 / ES2022 / ES2025 | | | +668 / +520 / +187 / +103 / +280 |

The ratchet exists precisely so that +1.6k elsewhere cannot hide a
completed edition going backwards; S6 may not flip the default while any
ratcheted edition is below its floor.

## Where the rows are (host-pass, regime-fail, non-Temporal, by directory)

`language/statements/class` 255 · `language/expressions/class` 239 ·
`built-ins/Array/prototype` 219 · `built-ins/Iterator/prototype` 155 ·
`built-ins/TypedArray/prototype` 86 · `language/statements/for-await-of`
67 · `built-ins/Promise/prototype` 49 · `built-ins/SharedArrayBuffer/prototype`
36 · `built-ins/String/prototype` 32 · `Promise/allSettled` 31 ·
`TypedArrayConstructors/ctors-bigint` 30 · `AsyncDisposableStack/prototype`
29 · `Array/fromAsync` 27 · `language/expressions/dynamic-import` 27.

By signature (same population): policy-rejected generator/async-generator
imports 357 (#3178 carriers — these are ES2015/ES2018 rows but also the
ES2026 `Iterator` helpers, hence the −179), `m should be an own property`
192 (#3468 function-object own-property residual — ES5/ES2015 class rows),
`Expected a TypeError … no exception` 115, native generator "sequential
numeric yields only" 74, `Expected a Test262Error but got undefined` 66,
`Cannot convert undefined or null to object` 59, `Invalid iterator
protocol` 44, `__get_builtin` dynamic-shape refusal 41.

## Method

1. Re-run the ratchet with `--compare <host JSONL>` for the per-TEST diff,
   and attribute every ES5 and ES2026 pass→fail row to one of the buckets
   above (script it; paste the table into this issue).
2. Route: rows owned by #3468 / #3178 / #4394 stay with those owners but
   get their counts refreshed there; rows with no owner become child
   issues of this one (one per root cause, with the repro file list).
3. Land the owned fixes in edition order: ES5 first (it is the largest
   and the oldest completed edition), then ES2026's Iterator-helper rows.
4. Re-run the ratchet on the next nightly's regime JSONL after each
   landing; the exit criterion is `test262-edition-ratchet: OK` on the
   regime lane with the **host-lane floors unchanged** (never lower a floor
   for this).

## Acceptance

- [ ] Per-test attribution table in this issue (ES5 99 rows, ES2026 179,
      ES2016 9, ES2023 4).
- [ ] `check:edition-ratchet` green on a nightly regime JSONL with the
      host floors untouched.
- [ ] Standalone high-water floor moves up or stays; default `gc` output
      byte-identical throughout.
