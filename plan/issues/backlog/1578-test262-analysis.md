# test262 failure-cluster analysis — 2026-05-20

Analysis of `benchmarks/results/test262-current.jsonl` (run 2026-05-20,
17:47 UTC). Baseline: **29,534 pass / 17,055 fail / 1,371 compile_error
/ 96 skip / 86 compile_timeout** across 48,142 records.

## Method

1. Bucketed failures by `category` (first 3 path segments).
2. Bucketed by `error_category` (codegen vs assertion vs runtime).
3. Extracted top error-message stems and grouped by call-site shape.
4. Cross-checked against existing issues in `plan/issues/sprints/52/`
   and `plan/issues/backlog/` to avoid duplicates.

## Top error-category breakdown

| Count  | Bucket             |
|--------|--------------------|
| 9,231  | assertion_fail     |
| 4,686  | other              |
| 1,607  | runtime_error      |
| 1,189  | wasm_compile       |
| 601    | type_error         |
| 570    | null_deref         |
| 241    | illegal_cast       |
| 157    | negative_test_fail |
| 51     | range_error        |
| 40     | promise_error      |
| 36     | oob                |
| 17     | unreachable        |

## Already covered (no new issue filed)

| Cluster                                                      | Existing issue |
|--------------------------------------------------------------|----------------|
| Temporal API (~3k fails)                                     | #661 (polyfill backlog) |
| SharedArrayBuffer / Atomics (~133 fails)                     | spec-backlog |
| dynamic-import valid/invalid syntax (~376 fails)             | #1089, #1512 |
| with-statement support                                       | #1456-ish exploration |
| Object.defineProperty descriptor fidelity (~629)             | #1438 (sprint 52) |
| Array.prototype generic / array-like (~1,483)                | #1461 (sprint 52) |
| subclassing instanceof (`class Sub extends Map / …`)         | #1455 (sprint 52) |
| String.prototype.split constructor / String.raw coercion     | #1444, #1445 (sprint 52) |
| OrdinaryToPrimitive returns undefined                        | #1253 |
| for-loop init binding patterns (`x is not defined` in for/dstr) | #1452 (sprint 52) |
| class/object-method param destructuring defaults             | #1451 (sprint 52) |
| Function.prototype.bind / toString fidelity                  | #1463 (sprint 52) |
| Function.prototype.bind "Bind must be called on a function"  | #1463 |
| Annex B function-in-block hoisting                           | #1518 (sprint 52) |
| Iterator.prototype helpers + Iterator.zip / Iterator.concat  | #1466 (sprint 52) |
| TypeError on non-constructor `new`                           | #1519 (sprint 52, narrow) — extended for Promise by #1528 |

## New issues filed today

| ID  | Title                                                                                    | est. fails |
|-----|------------------------------------------------------------------------------------------|------------|
| 1522 | codegen: invalid Wasm binary at type-boundary coercion (extern/anyref + struct refs)    | 530 |
| 1523 | test262 harness: provide `$262` host-object API                                          | 341 |
| 1524 | test262 harness: TypedArray `ctors` fixture not visible in resizable-buffer tests        | 202 |
| 1525 | spec gap: ToPrimitive throws "Cannot convert object to primitive value" eagerly          | 170 |
| 1526 | spec gap: BigInt + Number mixed arithmetic must throw spec TypeError                     | 30  |
| 1527 | module-code: ambiguous-export / re-export tests fail with `no test export`               | 54  |
| 1528 | spec gap: non-constructor TypeError for Promise.all / allSettled species & executor paths | 79  |
| 1529 | codegen: `illegal cast` umbrella at closure / destructuring parameter boundaries         | 241 |
|     | **Total upper-bound unblocked**                                                          | **~1,647** |

These eight issues cover the largest still-uncovered clusters in the
2026-05-20 baseline. Two of them (#1523 and #1524) are runner /
harness fixes rather than compiler bugs — small effort but they
unblock 500+ tests from CE → execution so downstream gaps become
measurable.

## Recommended sprint-53 candidates (by value × feasibility)

1. **#1524** (ctors fixture) — easy, runner-only, ~200 fails unblocked.
2. **#1523** (`$262` host object) — medium, runner-only, ~341 fails unblocked.
3. **#1525** (ToPrimitive eager throw) — medium codegen, ~170 fails.
4. **#1526** (BigInt mixed TypeError) — easy, ~30 fails, also closes a host/standalone gap.
5. **#1528** (non-constructor TypeError) — medium, ~79 fails + shared helper with #1519.
6. **#1522** (invalid Wasm at type boundaries) — high-effort umbrella, but ~530 fails make it the highest single-ticket prize.
7. **#1529** (illegal-cast umbrella) — high-effort, ~241 fails.
8. **#1527** (ambiguous-export "no test export") — medium, ~54 fails.

Suggested wave-1 pairing: **#1524 + #1523 + #1526** (low effort, fast
wins) for one dev; **#1522** (umbrella) for senior dev / architect
spec-first.

## Notes for the PO follow-up

- Several "covered" issues (#1452, #1518, #1519, #1438, #1455) are
  marked `in-review` — confirm whether they have already merged
  before sprint-53 planning. The audit task #7-#12 in TaskList covers
  this.
- TemporalHelpers harness include (≥635 fails clustered under
  Temporal/*) is the next-biggest harness-fixture gap after `ctors`;
  worth filing if/when Temporal moves into scope, otherwise dependent
  on #661.

— Product Owner (test262 analysis run 2026-05-20)
