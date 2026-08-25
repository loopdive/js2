---
id: 4516
title: "ES5 standalone small bundles: annexB Date getYear/setYear + escape/unescape + B.3.3 switch-dflt residue + harness-file fails + 4 compile timeouts (~39 rows, 2026-08-16 census)"
status: ready
created: 2026-08-16
sprint: current
priority: medium
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen, runtime
es_edition: 5
goal: es5
related: [2200, 2552, 3626]
---

# ES5 standalone small bundles — ~39 rows across 6 mechanical buckets

## Source

2026-08-16 standalone census (`plan/log/analysis-2026-08-16-es5-standalone-575.md`),
ES5 bucket 575 nonpasses. This issue bundles the small tail buckets that are
individually too small to file:

| bucket | n | notes |
|---|---|---|
| annexB-date | 6 | `Date.prototype.getYear/setYear/toGMTString` missing as own props in standalone |
| annexB-b33-hoisting | 8 | switch-dflt function hoisting: `f is not a function` / `illegal cast [in f()]` — coordinate with #2200/#2552 (claims are stale-June; check ledger before adopting; do NOT restart their phase work, only the standalone-visible residue) |
| annexB-escape-unescape | 4 | own-property descriptor + argument ToString coercion |
| annexB-other | 5 | see file list |
| annexB-regexp | 3 | legacy accessor residue in ES5 bucket |
| harness-files | 11 | harness/*.js self-tests: asyncHelpers-asyncTest-* (3× AsyncTestFailure), deepEqual-*, verifyProperty-restore-accessor, compare-array-symbol. **#4251 owns the standalone harness self-test cohort (72/116 fail, in-progress)** — extend #4251's scope to asyncHelpers-* and verifyProperty-restore-accessor (which appear in no issue) rather than fixing here; only fix under this bundle if #4251's owner agrees or the claim is stale. `String.prototype.valueOf` row belongs to #3524 (re-scoped 2026-08-16) |
| compile-timeout | 4 | `timeout (10s)`: language/comments/S7.4_A5.js, language/statements/for ×2 + 1 more — likely pathological-input compile perf; relates to the #4423 quadratic-compile fix, re-verify on current main first |
| residue | 6 | unclustered — verify individually |

File lists per bucket are in the analysis doc.

## Acceptance

- Each bucket: reproduce ≥1 file with the single-file standalone runner before
  fixing; report flips with denominators per bucket.
- compile-timeout bucket: FIRST re-run the 4 files on current main (post-#4423)
  — they may already pass; if so, record and close that bucket with the
  measurement, no code change.
- harness-files bucket: identify whether the failure is in the harness file
  semantics (fix compiler) or the runner's harness wrapping (file a separate
  runner issue; do not bury a runner defect in a compiler fix).
- annexB-b33: verify #2200/#2552 claim state on the ledger before touching.
