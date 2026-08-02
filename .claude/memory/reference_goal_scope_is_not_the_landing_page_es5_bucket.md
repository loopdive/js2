---
name: reference_goal_scope_is_not_the_landing_page_es5_bucket
description: "The ES5+untagged GOAL SCOPE (8,544 files, es5id-or-no-edition-id) is NOT the landing page's ES5 edition bucket (8,930 files, classifyEdition cascade). Both are correct; quoting one against the other reads as a discrepancy."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
  modified: 2026-08-02T03:24:20.959Z
---

Measured 2026-08-02 after the project lead asked why a reported **6.31 pp** lane
gap did not match the landing page's **75.2 % / 68.8 % (≈6.8 pp)** for "ES5
edition". Neither number was wrong. They are **different populations**.

| population | n | host | standalone | gap |
| --- | --- | --- | --- | --- |
| landing page **ES5 bucket** | 8,930 | 75.15 % | 68.42 % | **6.74 pp** |
| **goal scope** (#4040 etc.) | 8,544 | 80.02 % | 73.71 % | **6.31 pp** |

## The two definitions

- **Goal scope** = `scope_official` ∧ (`es5id:` present ∨ *none* of
  `es5id`/`es6id`/`esid`), intersected across both lanes. 8,114 of its files
  carry `es5id`; only **430** are the "untagged" arm.
- **Landing page** = `classifyEdition()` in `scripts/generate-editions.ts`, a
  6-priority cascade: `es5id`→ES5, `es6id`→ES2015, `features:`→edition year,
  **path heuristics (annexB→ES5)**, then two sentinel buckets.

## Why the goal-scope rates read ~5 pp HIGHER on a SMALLER denominator

**816 files are in the ES5 bucket but not in goal scope** — routed to ES5 by
*path heuristic*, not by an `es5id` tag. They pass at **35.2 % host / 23.3 %
standalone**. That low tail is the entire difference. (Goal scope also adds 430
files the ES5 bucket lacks, 273 of them `Unclassified (legacy)` at 100 %/99.3 %,
nudging it up further.)

## ⚠ The open question this exposed — "untagged" means two different things

The goal says "ES5 **and untagged**". Goal scope's untagged = *no edition id at
all* = **430 files**. The landing page's `Unclassified (untagged)` bucket is
**5,444 files that DO carry `esid:`** but no edition feature tag — a nearly
disjoint population, sitting **outside** goal scope, with a **10.9 pp** lane gap
(75.1 % host / 64.2 % standalone) — *wider than ES5's*. If that bucket was meant
to be in the goal, the scope under-covers by ~5,400 files. **Unresolved as of
2026-08-02; ask before assuming either reading.**

## How to reproduce the landing page exactly

```bash
npx tsx scripts/generate-editions.ts --results .test262-cache/test262-current.jsonl --output .tmp/ed-host.json
npx tsx scripts/generate-editions.ts --target standalone \
  --results .test262-cache/test262-standalone-current.jsonl --output .tmp/ed-sa.json
```

`--target standalone` switches the pass definition to **host-free** (excludes
`host_import_leak_class`). In goal scope that made **zero** difference (6,298
either way), but do not assume that holds elsewhere.

Related: [[project_es5_standalone_goal_restated_ex_dynamic_code]],
[[feedback_measure_never_extrapolate]],
[[reference_cached_baseline_jsonl_goes_stale_within_hours]].
