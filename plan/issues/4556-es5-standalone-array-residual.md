---
id: 4556
title: "ES5 standalone: Array builtins + annexB built-ins residual (62 rows, 2026-08-19 census)"
status: in-progress
sprint: current
created: 2026-08-19
updated: 2026-08-19
assignee: ttraenkler/es5-standalone-push
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: conformance
area: codegen, runtime
es_edition: 5
language_feature: arrays
goal: es5
related: [4163, 4492, 4491, 3772, 4426, 4555]
origin: "2026-08-19 standalone ES5 census against baselines-repo test262-standalone-current.jsonl (48,735 entries, fetched 04:52). Lane 'array' of an 8-way fan-out."
---

# #4556 — ES5 standalone Array + annexB built-ins residual

## Census (2026-08-19)

Standalone ES5 is **8,506 / 9,029 (94.2 %)**, leaving **523 non-passes**
(495 `fail`, 24 `compile_error`, 4 `compile_timeout`), classified with the
authoritative `scripts/generate-editions.ts` classifier over the fresh
standalone baseline.

This issue owns the **62-row** slice under:

- `built-ins/Array/**`
- `annexB/built-ins/**` (`escape`, `unescape`, `Date.prototype.setYear`/
  `getYear`, the annexB `RegExp` escape forms)

## Signature histogram (top rows)

| rows | signature |
| ---: | --- |
| 5 | `Expected a TypeError to be thrown but no exception was thrown at all` |
| 5 | `TypeError: Cannot access property on null or undefined` |
| 4 | `newArr.length Expected SameValue(«N», «N»)` |
| 3 | `x.toString() must return X` |
| 3 | `The value of y[N] is expected to be N Expected SameValue(«undefined», «N»)` |
| 2 | `Expected SameValue(«null», «X»)` |
| 2 | `Code unit: N Expected SameValue(«undefined», «X»)` |

Long tail, no dominant cluster — see #4555 for the same observation across the
whole 523-row corpus.

Two annexB rows fail with `Test262Error: escape should be an own property` /
`unescape should be an own property`, i.e. the global is not installed at all in
standalone; and `TypeError: Unsupported dynamic regular expression pattern`
appears in the annexB RegExp escape tests. Those are explicit standalone gaps
rather than semantic drift.

## Reproduction

The `--standalone` flag is load-bearing; without it you measure the JS-host
lane (84.8 %), a different corpus.

```bash
npx tsx .tmp/t262.mts --standalone built-ins/Array/prototype/concat/S15.4.4.4_A2_T1.js
node .tmp/t262run.mjs --standalone .tmp/lane-tests.txt 3
```

## Acceptance criteria

- Net increase in standalone ES5 passes across the 62-row lane, measured
  before/after with the same runner.
- Regression guard (`551` locally-verified-passing standalone ES5 tests) stays
  at 551/551.
- No test-name/path special-casing; no edits to the runner's skip logic
  (`shouldSkip`, `HANGING_TESTS`).

## Relationship to existing issues

- #3772 (`es5-filter-result-array`, `in-review`) is a narrow slice of this area.
- #4426 (`es5-standalone-array-length-toprimitive-fixes`, `done`) already landed
  the `length`/ToPrimitive fixes; the rows here are what survived it.
- #4492 owns builtin-prototype methods on exotic receivers, which overlaps the
  `Array.prototype` rows — coordinate before touching shared receiver paths.
