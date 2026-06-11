---
id: 2092
title: "spec-conformance suite: tests/equivalence/spec/ table-driven harness + June probe-corpus migration"
status: ready
sprint: Backlog
created: 2026-06-11
updated: 2026-06-11
priority: critical
feasibility: medium
reasoning_effort: medium
task_type: test
area: testing
language_feature: n/a
goal: correctness
related: [2093, 1897]
origin: "2026-06-11 analysis program (report 06 §2); stub 08-C7"
---

# #2092 — the probes that found 170 bugs live only in issue markdown

## Problem

~600 ad-hoc June probes found 170 bugs the 2,000+-file test corpus could
not see (hand-picked happy paths; issue tests pin the past, not the spec).
The probes exist only in issue Repro sections and will rot.

## Root cause

No table-driven value×operator sweeps; no standalone/-O execution lanes at
PR time.

## Plan (report 06 §2)

`tests/equivalence/spec/<family>.test.ts` table-driven files: snippet →
auto-diffed against Node (`compileToWasm` vs `evaluateAsJs`), harness
composed from tests/equivalence/helpers.ts + `runStandalone` from
tests/issue-1901.test.ts:42 (semantics + import-leak check in one). Four
lanes (host, standalone, ±-O). Open-bug repros land RED-BUT-BASELINED
under the already-required `equivalence-gate` known-failures mechanism.
Sprint 62 = skeleton + the 3 highest-yield family tables (~150 probes);
long tail follows.

## Acceptance criteria

- Skeleton + first 3 family tables merged and running in the required gate
- A deliberately-reverted June fix turns the suite red in the right lane

## Dupe check

No spec-sweep suite exists; equivalence.test.ts is example-driven. New
(analysis program).
