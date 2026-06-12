---
id: 2143
title: "WebAssembly.validate lane for unoptimized pipeline output (split of #1858-C5)"
status: ready
sprint: 62
created: 2026-06-12
updated: 2026-06-12
priority: medium
feasibility: easy
reasoning_effort: low
task_type: infra
area: ci
language_feature: compiler-internals
goal: trustworthiness
related: [1858, 1853, 1941]
origin: "2026-06-12 sprint-62 architecture analysis (quality workstream N4)"
---

# #2143 — default-pipeline malformed Wasm is only caught if a test happens to instantiate it

## Problem

Only *optimizer* output is validated (`src/optimize.ts:234`). Malformed
Wasm from the default pipeline surfaces at instantiate time, only when a
test executes that module. #1941's corpus work found 2 programs whose
unoptimized binary fails `WebAssembly.validate` — invisible to any gate.

## Approach

Validate in the equivalence-test helpers + diff-test harness (not the prod
hot path); classify failures as `malformed_wasm` feeding #1853's
hard-error stability bucket.

## Acceptance criteria

- The 2 known invalid-unoptimized corpus programs surface as bucketed hard
  errors.
- A regression emitting invalid Wasm on any corpus program fails CI loudly.

## Notes

S-size, routine dev; ride along with #1853 in the same lane.
