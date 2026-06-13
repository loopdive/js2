---
id: 1781
title: "standalone test262 run must publish full JSONL and root-cause issue map"
status: done
completed: 2026-06-12
created: 2026-06-02
updated: 2026-06-02
priority: high
feasibility: medium
reasoning_effort: high
task_type: infrastructure
area: testing
language_feature: test262-standalone
goal: standalone-mode
sprint: 58
es_edition: n/a
related: [1662, 1776, 1472, 682, 1474, 1599, 1387, 1778, 1782, 1591, 1623, 1665]
origin: "Investigation of all failing standalone test262 tests found that the June 1 full standalone JSONL/report artifacts were generated but not retained, leaving only summary counts and five manually documented root-cause clusters."
---
# #1781 - Standalone test262 run must publish full JSONL and root-cause issue map

## Problem

The 2026-06-01 standalone test262 run produced a measured summary of
4,368 / 43,106 passing (10.1%) and referenced these generated artifacts:

- `benchmarks/results/test262-standalone-report-20260601-213702.json`
- `benchmarks/results/test262-standalone-results-20260601-213702.jsonl`

Those full artifacts are not committed, not present in the workspace, and were
not included in the GitHub Pages artifacts I checked for the relevant June 1
runs. The committed public report is `summary_only`, so it preserves the pass
count but not the per-test failure rows, failure signatures, categories, or the
unclassified tail.

That means a later investigator cannot verify that **every failing standalone
test262 test** has an issue file for its root cause. We can only verify the
five root-cause clusters that were manually copied into issue files.

## What is already covered

The preserved June 1 root-cause clusters have issue coverage:

| Root cause                                                         |            Evidence from June 1 run | Issue                                                          |
| ------------------------------------------------------------------ | ----------------------------------: | -------------------------------------------------------------- |
| `isSameValue` externref equality emitted invalid Wasm              |                     13,614 failures | #1776 (done by PR #1025; rerun required to remove stale count) |
| Dynamic object/property operations still need a no-JS-host runtime | 22,986 priority-classified failures | #1472                                                          |
| Native standalone RegExp engine missing                            |        1,882 non-exclusive failures | #682, with Phase-1 refusal in #1474                            |
| JSON parser/stringifier missing in standalone                      |          134 non-exclusive failures | #1599                                                          |
| `with` statement lowering missing                                  |          294 non-exclusive failures | #1387                                                          |

The broader construct-level standalone host-import audit also has issue
coverage in #1662 and follow-ups (#1663, #1664, #1665, #1666), plus existing
owners such as #1103, #1335, #1470, #1473, #1474, and #1599.

## Published artifact

A full standalone rerun was published on 2026-06-02 to
`loopdive/js2wasm-baselines`. The latest checked baseline commit is
`b4684d8f97a462c6414716aea46f31b67f48b959`, with
`test262-standalone-current.jsonl` and `test262-standalone-report.json`
pointing at js2 baseline
`ac88301967d70be11c9abb456051ff4afcd3a9d7`.

The repo also retains the timestamped first artifact commit
`fef6d42c21ffcb933f4916b5f4a8e8eeeb98ec52`:

- `test262-standalone-results-20260602-124735.jsonl`
- `test262-standalone-current.jsonl`
- `test262-standalone-results.jsonl`
- `test262-standalone-report-20260602-124735.json`
- `test262-standalone-current.json`
- `test262-standalone-report.json`

Run command: `TEST262_TARGET=standalone TEST262_REPORTER=dot bash scripts/run-test262-vitest.sh`.

Validated counts:

- JSONL rows: 48,110
- Full summary: 7,788 pass, 6,412 fail, 33,793 compile_error,
  3 compile_timeout, 114 skip
- Official summary: 7,594 pass / 43,128 total (17.6%)
- Current JSONL SHA-256:
  `509c07be2eee43e933db76959d4bc26f0d126d0756a9cff339ab5fdcb9bc8a07`
- Current report SHA-256:
  `26a3e86ab400edd78a83bdfcb2fcfde1ae7dcd725235f7b4d2280ea34c8c3d79`
- Timestamped JSONL SHA-256:
  `9096fce194cad887af6b0642fca7e6df898523684329509ebe752ec6da2edc5e`
- Timestamped report SHA-256:
  `91cf08789581b7381566ee482babf765b719fcea9b85a38c5b3e37a6e833aee9`

## 2026-06-02 root-cause classification

Source artifact: `loopdive/js2wasm-baselines` commit
`b4684d8f97a462c6414716aea46f31b67f48b959`,
`test262-standalone-current.jsonl`. The classifier covers every non-pass,
non-skip row: 33,793 `compile_error`, 6,412 `fail`, and 3
`compile_timeout` rows, for 40,208 rows total.

Classification method: ordered primary match by diagnostic, error category,
and path cluster. Some families are intentionally non-exclusive in the raw
artifact (for example, a RegExp test can first hit #1472 object dispatch), so
the table below is the primary owner for root-cause tracking, not a claim that
the issue id is the only text matched in that row.

| Count | Primary owner | Root-cause bucket |
| ---: | --- | --- |
| 26,880 | #1472 | Standalone dynamic object/property operation gate (`__extern_*`, `__object_*`, `__defineProperty_*`, `__get_builtin`, `__new_plain_object`, etc.) |
| 2,351 | #1623/#1666/#1525b | Invalid Wasm at type/coercion boundaries, late globals, and trampolines |
| 1,660 | #1591/#1365/#1364 | Class element, prototype, own-property, private-name, and descriptor reconciliation gaps |
| 1,513 | #682/#1474 | RegExp literals/constructor/String-RegExp paths still refused or missing native engine |
| 1,436 | #1776 | Residual standalone `isSameValue` invalid-Wasm validator failures after PR #1025 |
| 876 | #1525/#1525b/#1759 | ToPrimitive / object-to-string dispatch residuals |
| 643 | #1358/#1461/#1654 | Array, TypedArray, DataView, and buffer semantics |
| 532 | #1665/#681 | Generic iterator protocol still needs a pure-Wasm standalone path |
| 327 | #1472/#176/#281/#1466 | Object/property/destructuring semantic mismatches behind the object model |
| 279 | #1105/#1442/#1381 | String methods and string coercion residuals in standalone |
| 228 | #1577/#779 | Miscellaneous low-volume spec-completeness tail, after #1782 numeric separators are carved out |
| 264 | #1594/#1050 | Annex B function/eval semantics |
| 236 | #1343 | Date prototype formatting/coercion |
| 218 | #1335/#1663/#1689 | Number parsing, formatting, and coercion |
| 197 | #1732/#562/#160 | Math method descriptors and coercion edge cases |
| 197 | #661 | Temporal proposal/polyfill gap |
| 178 | #731/#1732/#1596 | Function object name/length/prototype/call semantics |
| 168 | #334/#1456/#540 | Assignment targets, private refs, and short-circuit semantics |
| 157 | #1103 | Wasm-native Map/Set/Weak collection semantics |
| 155 | #1066/#1073/#990 | Eval and `new Function` semantics |
| 154 | #1665/#1718 | Iterator protocol / for-of semantic failures after compile |
| 154 | #1511/#1726 | Arguments object fidelity |
| 153 | #1315/#1435 | `import.defer` / `import.source` proposal syntax and early errors |
| 115 | #1089/#1512 | Dynamic import unsupported / early errors |
| 95 | #1599 | Standalone JSON codec, after Phase 1 refusal |
| 91 | #1644 | BigInt typed-path/coercion |
| 86 | #1665/#680 | Generators and async iteration |
| 82 | #1128/#990/#1726 | Lexical scope, TDZ, and declaration semantics |
| 77 | #1326c/#1116/#1694 | Promise and async standalone semantics |
| 68 | #1046/#1527 | Module semantics and harness export shape |
| 64 | #602/#787 | Tail-call/control-flow loop semantics, including 3 compile timeouts |
| 62 | #927/#1435/#990 | Missing parse/early/runtime SyntaxError or ReferenceError |
| 62 | #1387 | `with` statement dynamic-scope lowering residuals |
| 50 | #1782/#53 | Numeric and BigInt separator literals evaluate to wrong values |
| 45 | #1759/#836 | Template literal and tagged-template semantics |
| 43 | #832/#270 | Unicode/reserved-word identifier handling |
| 41 | #1036/#990 | DisposableStack / explicit resource management |
| 41 | #787/#1378 | Completion values and control-flow semantics |
| 33 | #812/#1559 | Extern class dependency metadata |
| 32 | #843/#1551 | `super`, spread, and receiver-evaluation semantics |
| 32 | #1535/#1644 | Standalone BigInt host/typed-path residual |
| 29 | #270/#990 | Strict-mode reserved words and directive prologue |
| 26 | #674/#1354 | SharedArrayBuffer / Atomics backlog |
| 25 | #1519/#1609/#1603 | `new`, spread, and optional-chaining semantics |
| 20 | #1038/#1732 | Function.prototype.bind / function-object descriptors |
| 18 | #1435/#832 | Lexical grammar, hashbang, whitespace, and line terminators |
| 6 | #680/#1665 | Recursive/generator/iterator stack overflow |
| 5 | #826/#1623 | Illegal-cast/type-boundary residual |
| 2 | #1663 | Standalone parseInt/parseFloat constructor metadata |
| 2 | #820 | Null/undefined TypeError lowering residual |

No high-volume standalone failure family is unowned after this pass. The only
new issue filed from the artifact is #1782 for numeric/BigInt separator
literal values; other buckets already had root-cause issues and were refreshed
where the latest artifact materially changed the evidence.

## 2026-06-02 implementation findings

Implemented the auditability layer for standalone test262 reporting:

- `tests/test262-shared.ts` now writes stable `error_signature`,
  `imports`, `host_import_leak_class`, and `reached_test` metadata into JSONL
  rows when that information is available from the worker or fixture compile
  path.
- `scripts/test262-worker.mjs` returns summarized compile imports, a
  host-import leak class, and whether the exported `test()` function was
  reached.
- `scripts/build-test262-report.mjs` now supports `--target standalone`,
  emits `root_cause_map` for standalone reports, and fails when
  `--max-unclassified-root-causes N` is exceeded.
- `scripts/run-test262-vitest.sh` delegates report generation to the shared
  report builder, so local standalone runs emit the same report schema as CI.
- `.github/workflows/test262-sharded.yml` runs the standalone merged report
  with `--max-unclassified-root-causes 0`, making unowned standalone failures a
  required-check failure.

Validation:

- `pnpm test tests/issue-1781.test.ts`
- `pnpm test tests/build-test262-report.test.ts`
- `pnpm test tests/issue-1781.test.ts tests/build-test262-report.test.ts`
- `bash -n scripts/run-test262-vitest.sh`
- `node --check scripts/build-test262-report.mjs`
- `node --check scripts/test262-worker.mjs`
- `pnpm exec tsc --noEmit --pretty false`
- Fetched
  `https://raw.githubusercontent.com/loopdive/js2wasm-baselines/main/test262-standalone-current.jsonl`
  and ran:
  `node scripts/build-test262-report.mjs --input .test262-cache/test262-standalone-current.jsonl --output .test262-cache/test262-standalone-report-issue-1781.json --target standalone --max-unclassified-root-causes 0 --include-proposals`

The fetched standalone artifact classified all 40,189 non-pass/non-skip rows
with 0 unclassified rows across 43 root-cause buckets. No full local test262
run was performed.

## Root Cause

Standalone test262 is not a durable, reproducible reporting lane today:

- The current vitest test262 worker hardcodes the default JS-host target.
- The standalone run's full JSONL/report were generated outputs, but only a
  summary-only public report was committed later by #1778.
- The Pages artifacts for the relevant June 1 runs contain the default
  `test262-results.jsonl`, not `test262-standalone-results-*.jsonl`.
- No committed classifier maps standalone failure signatures to issue ids and
  reports unclassified failures.

## Acceptance Criteria

- Add a supported standalone test262 runner mode using the existing vitest
  pipeline, e.g. `TEST262_TARGET=standalone` or an explicit package script.
- The standalone lane writes durable artifacts named
  `test262-standalone-results-<timestamp>.jsonl` and
  `test262-standalone-report-<timestamp>.json`.
- Each JSONL row records enough detail to classify the result: file, category,
  status, error signature, imports/host-import leak class when available, and
  whether execution reached `test()`.
- Publish or retain the full standalone JSONL, not only the summary. Acceptable
  destinations: `loopdive/js2wasm-baselines`, Pages download artifacts, or a
  committed small indexed artifact with the large JSONL fetched on demand.
- Generate a root-cause map from standalone failures to issue ids. The report
  must list every mapped bucket and a separate `unclassified` bucket.
- A CI/check command fails when the standalone root-cause map has unclassified
  failures above an explicit threshold.
- Rerun standalone test262 after #1776 and update the five cluster counts plus
  any newly exposed root causes in their issue files.

## Notes

Do not use this issue to implement the compiler fixes themselves. This issue is
the reporting and auditability layer that lets #1472/#682/#1599/#1387 and the
host-import audit issues be verified against a real standalone test262 corpus.
