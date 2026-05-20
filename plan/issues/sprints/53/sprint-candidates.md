---
sprint: 53
status: draft
created: 2026-05-20
author: product-owner
---

# Sprint 53 — Candidate Issues

This list is the PO's working set for sprint 53 planning. Final selection will
be made after smoke-testing each candidate against current `main` and verifying
the bug/feature still reproduces.

## Theme proposal

Sprint 52 closed at 28,171/43,160 test262 passes (65.3%). The biggest
remaining buckets are spec gaps (Promise/async, null-pointer/TypeErrors,
`assert` mismatches) plus host-independence and ecosystem stress tests.
Sprint 53 should pursue two parallel tracks:

1. **High-impact test262 buckets** — bug-fixes whose acceptance criteria can
   be measured in "FAIL → PASS" deltas. Priority `critical`/`high` issues
   already marked `ready` are the obvious draw pool.
2. **Continuation work from sprint 52** — close the in-progress
   host-independence track (#1471–#1474) so we can demonstrate a true
   standalone build and unblock #1505's audit numbers.

## Carry-over from sprint 52 (must close or re-plan)

These were dispatched in sprint 52 but are still open. They are first
in line for sprint 53.

| ID | Status | Why it matters |
|----|--------|----------------|
| 1471 | in-progress | Host-independence — boxing/unboxing in pure Wasm. Unblocks standalone build. |
| 1472 | in-progress | Host-independence — object/property ops in pure Wasm. |
| 1473 | in-progress | Host-independence — error/exception ops in pure Wasm. |
| 1474 | in-progress | Host-independence — pure-Wasm RegExp. |
| 1326c | in-progress | Async standalone: microtask queue + chained-resolution Promise.then. |
| 1505 | in-progress | Comprehensive ECMAScript audit (parent issue for spec sub-gaps). |
| 1520 | in-progress | Static Hermes vs js2wasm architectural comparison (docs). |
| 1373 | ready      | IR claim for async functions. Touches the IR phase-3/4 work. |
| 1373b | blocked   | CPS lowering for await — unblocks once #1373 lands. |
| 1521 | blocked    | WASI Native Messaging example (depends on WASI shipping bits). |

**Recommended sprint 53 capacity allocation: 4 of the 10 slots go to closing
out the host-independence track + #1326c. The remaining slots come from the
new candidates below.**

## New candidates (high test262 impact)

Pulled from `priority: critical|high` + `status: ready` in
`plan/issues/backlog/`. Listed in priority order.

| # | ID  | Title (truncated) | Rationale |
|---|-----|-------------------|-----------|
| 1 | 820 | Nullish TypeError / null-pointer / illegal-cast umbrella (6,993 FAIL) | Largest single bucket in the FAIL ledger. One fix retires thousands of failing tests. |
| 2 | 779 | Assert failures: tests compile and run but produce wrong values (8,674 tests) | Even partial reductions here would dwarf any other sprint outcome — likely splits into sub-issues during planning. |
| 3 | 846 | assert.throws not thrown: built-in methods accept invalid arguments silently (2,799 tests) | High-value spec compliance push; pairs naturally with the spec-audit work in #1505. |
| 4 | 1116 | Promise resolution and async error handling (210 tests) | Sits adjacent to #1326c and #1373; finishing it tightens the async story. |
| 5 | 821 | BindingElement null guard over-triggering | Probably the root cause of a chunk of #820; closing this should cascade. |
| 6 | 983 | WasmGC objects leak to JS host as opaque values (1,087 FAIL) | Host-boundary bug that interacts with the standalone push (#1471/#1472). |
| 7 | 1151 | Async function synchronous throws bypass Promise.reject wrapping | Small, well-scoped async correctness fix. |
| 8 | 1042 | async/await state-machine lowering (AwaitExpression currently no-op) | Core async correctness; foundation for #1116 and #1373. |
| 9 | 1525 | spec gap: ToPrimitive eager throw on object args | Newly filed (sprint 52 retro). Self-contained; good first-task material. |
| 10 | 1522 | codegen: invalid Wasm binary at type-boundary coercion | Crash-level codegen bug; blocks several feature stress tests. |

## Stretch / "if-capacity-allows" candidates

| ID  | Title (truncated) | Rationale |
|-----|-------------------|-----------|
| 1352 | RegExp exec result: wasmGC string struct ≠ externref string in strict equality | Clean correctness fix; medium-priority. |
| 1528 | non-constructor TypeError — Promise.all / allSettled species and executor paths | Promise spec gap; small surface. |
| 1529 | codegen: 'illegal cast' umbrella at closure & destructuring parameter boundaries | Probable root cause of more FAILs in #820 territory. |
| 1526 | BigInt + Number mixed arithmetic should throw spec TypeError | Spec gap; trivial fix if BigInt path is already there. |
| 1527 | module-code: ambiguous-export & re-export tests fail with 'no test export' | Test262 harness gap (not codegen); cheap. |

## Out of scope for sprint 53

- `feasibility: hard` architecture issues (#680 pure-Wasm generators,
  #1100/#1101/#1103 wasm-native collections) — need architect specs first.
- Browser / Node ecosystem demos (#1032 axios, #1033 React) — these depend on
  the host-independence work closing.
- `low` priority backlog items — reserved for fill-in work or scrum master
  rotation.

## Risks to flag at planning

- `1373b` is `blocked` on `1373`. Make sure both are sequenced in the same
  sprint or move `1373b` to sprint 54 explicitly.
- Many sprint-52 `in-review` issues never got their merge confirmation
  recorded in the issue file (see audit report). Tech lead should re-check the
  PR list before sprint 53 starts so we don't accidentally re-plan completed
  work.
