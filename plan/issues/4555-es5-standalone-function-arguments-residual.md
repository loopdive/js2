---
id: 4555
title: "ES5 standalone: Function builtins / function-code / arguments-object residual (75 rows, 2026-08-19 census)"
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
language_feature: functions
goal: es5
related: [4163, 4492, 4491, 4515, 4556]
origin: "2026-08-19 standalone ES5 census against baselines-repo test262-standalone-current.jsonl (48,735 entries, fetched 04:52). Lane 'function-semantics' of an 8-way fan-out."
---

# #4555 — ES5 standalone Function / function-code / arguments-object residual

## Census (2026-08-19)

Standalone ES5 is **8,506 / 9,029 (94.2 %)**, leaving **523 non-passes**
(495 `fail`, 24 `compile_error`, 4 `compile_timeout`). Classification is the
authoritative `scripts/generate-editions.ts` edition classifier run over the
fresh standalone baseline, so the denominator matches the published
`test262-standalone-editions.json` (8,506/9,029) exactly.

This issue owns the **75-row** slice under:

- `built-ins/Function/**`
- `language/function-code/**`
- `language/arguments-object/**`

## Signature histogram (top rows)

| rows | signature |
| ---: | --- |
| 6 | `Expected a TypeError to be thrown but no exception was thrown at all` |
| 4 | `The value of X is expected to be X Expected SameValue(«X», «X»)` |
| 4 | `Expected true but got false` |
| 3 | `TypeError: cannot read property X of null` |
| 3 | `X had incorrect value!` |
| 2 | `The value of this[X] is expected to be X Expected SameValue(«undefined», «X»)` |
| 2 | `The value of retobj[X] is expected to be true` |

**There is no dominant cluster.** The standalone residue at 94 % is a long
tail — the largest single signature in the whole 523-row corpus is 13 rows.
Plan for many small root causes, not one lever. Cluster size is a ceiling on
what a fix can move, not a forecast (#3626 §2.1 method).

## Reproduction

The `--standalone` flag is load-bearing; without it you measure the JS-host
lane, which is a different (and much worse: 84.8 %) corpus.

```bash
npx tsx .tmp/t262.mts --standalone built-ins/Function/prototype/apply/S15.3.4.3_A6_T1.js
node .tmp/t262run.mjs --standalone .tmp/lane-tests.txt 3
```

## Acceptance criteria

- Net increase in standalone ES5 passes across the 75-row lane, measured
  before/after with the same runner.
- Regression guard (`551` locally-verified-passing standalone ES5 tests) stays
  at 551/551.
- No test-name/path special-casing; no edits to the runner's skip logic
  (`shouldSkip`, `HANGING_TESTS`) — those manufacture passes rather than earn
  them.

## Known local limitation

Tests whose root cause is `eval` cannot be faithfully validated on the dev Mac:
CI's standalone lane uses a QuickJS eval tier that needs clang-18 (Homebrew
`llvm@18` requires Xcode Command Line Tools, absent here), and the fallback
interpreter tier diverges semantically. Such rows are recorded as blocked
rather than fixed. See #4163 for the umbrella note.
