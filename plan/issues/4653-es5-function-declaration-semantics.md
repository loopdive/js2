---
id: 4653
title: "ES5 standalone: language/statements/function residual — 12 rows across arguments.callee identity, named-function-expression scope, property-vs-declaration shadowing, and a null-pointer in __module_init"
status: ready
sprint: current
created: 2026-08-23
updated: 2026-08-23
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: functions
goal: standalone-gap
related: [4515, 4641, 4643]
origin: "wave-5 lead sweep (2026-08-23) on campaign HEAD c9990a7d2+, fresh compiler bundle + eval adapter. All 12 rows re-verified failing; no existing issue covers this directory."
---

# #4653 — `language/statements/function` residual (12 rows)

## Affected rows (sweep-verified on campaign HEAD, 2026-08-23)

| row | observed |
| --- | --- |
| `S13.2.2_A18_T1.js` | `callee === 0` → got `1` |
| `S13.2.2_A18_T2.js` | `callee === 0` → got `1` |
| `S13.2.2_A17_T3.js` | `RuntimeError: dereferencing a null pointer in __module_init()` at source L38 |
| `S13.2.2_A8_T3.js` | `ReferenceError: arg is not defined` |
| `S13.2.2_A4_T2.js` | `__device.printShape` is `undefined` |
| `S13.2.2_A19_T8.js` | `__func()==="b"` → got `a` |
| `S13.2.2_A2.js` | exception type should be `TypeError`, got `[object Object]` |
| `S13_A6_T1.js` | `__1 === __A` → got `NaN` |
| `S13_A2_T2.js` | `x === "11"` → got `2` |
| `S13_A15_T3.js` | `typeof __func() === "undefined"` → got `object` |
| `13.2-17-1.js` | expected `"data"`, got `"constructor"` |
| `13.2-18-1.js` | `TypeError: Cannot destructure 'null' or 'undefined'` at `fun.prototype` |

Read each test's source: they are NOT one root. At least four visible
sub-shapes — `arguments.callee` identity across the constructed-instance
boundary (the two `A18` rows share one wording), the `new`-instance
property table (`13.2-17-1` / `13.2-18-1` probe `fun.prototype`'s own
descriptors, so they may belong with #4491's MOP lane — measure before
claiming), named-function-expression scope (`A19_T8`, `S13_A2_T2`), and one
hard invalid-access crash (`A17_T3`).

## Implementation Plan

1. Brief: `plan/method/es5-standalone-agent-brief.md` — BINDING. Read it
   fully before the first edit: methodology 1–7 (revert copies at first
   edit, cross-lane third-arm rule, pin-exercises-the-shape, unfoldable
   pins, "N passed" never exit 0), the stale-`compiler-bundle.mjs` trap,
   the worktree symlink-farm + **gitlink** hazard, the concrete-ref
   `try_table` trap, verification floor, commit rules.
2. **Triage first, fix second.** Re-verify all 12 live, read each test's
   source, cluster by measured ROOT (not by filename prefix). Report the
   cluster table before implementing. Fix the largest cluster(s); a lane
   that lands 5 of 12 with the other 7 correctly attributed is a success,
   a lane that "fixes" 12 by guessing is not.
3. `S13.2.2_A17_T3`'s null-pointer is an invalid-access crash — treat it
   trap-first (absent-not-wrong: decline gracefully before answering
   wrongly), and if the correct answer is out of scope, say so with the
   measurement.
4. Hand off, don't double-fix: rows whose root is the descriptor MOP
   belong to #4491 (dev-4491 active in that territory), value-rep rows to
   #4641, prototype-chain rows to #4643. Cross-lane claims need the third
   arm (methodology 7).

## Acceptance

Scoped standalone sweep over `language/statements/function` +
`language/statements/{return,try}` before AND after from your own runs;
per-file flip list; **zero regressions**. `tests/issue-4653.test.ts`
pinning every fixed shape (executing it, not asserting about it), verified
failing on base by revert; `it.fails` pins for measured residuals with
owners. `## Root cause` (per cluster) / `## Fix` / `## Test Results` /
`## Residuals` in this file.
