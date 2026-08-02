---
id: 4040
title: "UMBRELLA: close the standalone↔host lane gap on ES5+untagged — 902 files pass in host and fail in standalone (6.31 pp)"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: n/a
goal: standalone-mode
related: [1781, 4040]
---

# UMBRELLA: close the standalone↔host lane gap on ES5+untagged — 902 files pass in host and fail in standalone (6.31 pp)

## The measurement

Goal scope = test262 files carrying `es5id:` **or** none of `es5id`/`es6id`/`esid`.
Both lanes, same corpus (`b363f29d`), baselines repo, 2026-08-02, **0 unopenable**:

| | files | pass | |
| --- | ---: | ---: | ---: |
| host (gc) | 8,544 | 6,837 | **80.02 %** |
| standalone | 8,544 | 6,298 | **73.71 %** |
| | | | **gap 6.31 pp** |

⚠ **The net 539 hides the real shape. The three-way split is what matters:**

| | files | meaning |
| --- | ---: | --- |
| host-pass ∧ standalone-**fail** | **902** | ← THE GAP. Standalone-specific work. |
| both-fail | 1,344 | shared front-end/semantics — **NOT lane-gap work** |
| standalone-pass ∧ host-**fail** | **363** | standalone is *ahead* here |

**The lanes are not nested.** Anyone who reasons about "the gap" as 539, or who
assumes standalone ⊂ host, will mis-scope: the actionable population is **902**,
and 363 files would *regress* if standalone were naively made to match host.

## Sub-clusters, and who owns them

Measured from the standalone-side error on the 902:

| cluster | gap files | owner |
| --- | ---: | --- |
| descriptor — defineProperty 120 · create 82 · defineProperties 76 | 278 | in flight |
| `invalid Wasm binary` 35 · null-deref `__module_init` 31 | 66 | in flight |
| missing `TypeError` | 38 | in flight |
| **prototype / `constructor` identity** | **~35** | **#4041** |
| **dynamic RegExp pattern + `RegExp.prototype`** | **~35** | **#4042** |
| **`__get_builtin` dynamic-shape refusal** | **11** | **#4043** |
| dynamic-code (`eval`/`Function`) | ~63 | **OUT OF SCOPE** — see the goal restatement |
| SharedArrayBuffer | 28 | excluded by stakeholder |

Top areas in the 902: `String/prototype` 120 · `Object/defineProperty` 120 ·
`Object/create` 82 · `Object/defineProperties` 76 · `Function/prototype` 42 ·
`RegExp/prototype` 35.

## Sizing discipline for anyone picking up a child issue

- **File counts are NOT flip ceilings.** Measured conversions this sprint: 33 %,
  63 %, 81 %. Report population / reachable / flips separately.
- **A shared error string is a SIGNATURE, not a mechanism** — a 117-file "family"
  decomposed into six unrelated defects; an `invalid Wasm binary` bucket into six.
  Read test bodies before sizing.
- **Re-fetch the baseline `--force`** before any measurement; the cache goes stale
  within hours and reproduces its own checks exactly while answering yesterday's
  question.
- **Some files pass for the WRONG reason.** Enumerate the complete at-risk set and
  do not sample — one instance this sprint was 1 file in 634.
