---
id: 3426
title: "Standalone: authoritative Test262 harness leaks env::console_log_externref + env::structuredClone into every module (37,369 records, 32,245 with no other cause)"
status: ready
sprint: current
created: 2026-07-18
updated: 2026-07-18
priority: critical
horizon: l
feasibility: hard
task_type: bug
area: codegen, standalone, test262-runner
language_feature: n/a
es_edition: n/a
goal: standalone-mode
related: [1781, 2961, 2860, 3178, 3370, 3393]
origin: "2026-07-18 oracle-v8 harvest (fable harvest agent): standalone leak-class census of test262-standalone-current.jsonl @ oracle 8 (baseline_sha 6ae06435, 4,312/43,106 pass)."
---

# #3426 — Standalone universal harness shim leak (console_log_externref + structuredClone)

## Problem

The 2026-07-18 oracle-v8 standalone census (`test262-standalone-current.jsonl`,
4,312/43,106 pass, 38,772 compile_error) shows the standalone corpus is
dominated by a **single universal host-import leak**, not by per-feature gaps:

| Leak set | Records |
| --- | ---: |
| `env::console_log_externref` | 37,369 |
| `env::structuredClone` | 37,369 |
| records leaking **ONLY** those two (no other host import) | **32,245** |
| records leaking those two **plus** a real feature import | 5,124 |
| records with a real feature leak but **no** shim leak | **0** |

Every single standalone `compile_error` that carries a host-import-leak verdict
also carries `env::console_log_externref` + `env::structuredClone`. There are
zero records where a feature import leaks without these two. In other words the
`#2961` `strictNoHostImports` leak-scan is tripping corpus-wide on two imports
that the **authoritative Test262 harness prelude (#3370) emits unconditionally**
— including in tests that never call `console.log` or `structuredClone`:

```
test/language/expressions/optional-chaining/iteration-statement-for.js
  standalone target emitted host imports: env::console_log_externref, env::structuredClone (#2961)
test/language/expressions/less-than/bigint-and-symbol.js
  standalone target emitted host imports: env::console_log_externref, env::structuredClone (#2961)
test/language/expressions/compound-assignment/11.13.2-5-s.js
test/language/expressions/class/accessor-name-inst/literal-string-hex-escape.js
test/language/expressions/assignment/S11.13.1_A7_T4.js
```

None of these tests use console or structuredClone — the imports come from the
harness/runtime prelude, not the test body.

## Why this matters (burndown lever)

This is the #1 standalone burndown lever. The standalone pass collapsed from the
pre-v8 high-water of ~24,946 to 4,312 when #3370 made the literal upstream
harness authoritative (#3393 re-seeded the floor to 4,508 full-corpus and
documented the collapse as intended-at-the-metric-level). But the *cause* of the
collapse — the harness prelude leaking two host imports into every module — has
no fix issue. Eliminating these two universal leaks would let up to **~32,245
tests** (the shim-only set, which have no other refusal reason) re-enter
standalone, and would unmask the true per-feature census for the remaining 5,124.

## Root-cause hypothesis

`env::console_log_externref` and `env::structuredClone` are pulled by the
assembled standalone prelude (runtime shim + `assert.js`/`sta.js` harness
reporting path), not tree-shaken when the test body doesn't reference them. Two
candidate mechanisms to confirm:

1. The harness's `print` / Test262Error reporting path lowers to
   `console_log_externref`; the authoritative-harness assembly (#3370) now
   always includes it.
2. A value-copy / deep-compare helper (or the runtime prelude) references
   `structuredClone` unconditionally.

Either way the fix is a **standalone-native lowering or dead-import elimination**
of the two prelude imports so the leak-scan sees a genuinely host-free module.
Per the dual-mode principle, standalone needs a Wasm-native `print`/report path
(or no report import at all) and must not depend on host `structuredClone`.

## Acceptance criteria

- A standalone compile of a trivial test that uses neither `console.log` nor
  `structuredClone` emits **zero** host imports (no `env::console_log_externref`,
  no `env::structuredClone`).
- The standalone shim-only leak set (32,245 records) drops to ~0; standalone pass
  count recovers materially above 4,312 (target: unmask and re-measure — the
  remaining leaks are the per-feature census in #3178 / #1472 / #1474 / #2046).
- No regression in the default (JS-host) lane.

## Cross-reference

Leak-scan mechanism: #2961 (done). Standalone umbrella: #1781. Host-async
machinery family (the 5,124 feature-plus-shim residual): #3178. Metric collapse
already documented: #3393, #3370.
