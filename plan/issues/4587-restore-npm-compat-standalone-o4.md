---
id: 4587
title: "Restore npm compatibility standalone benchmarks to O4"
status: done
created: 2026-08-21
updated: 2026-08-21
priority: high
feasibility: easy
reasoning_effort: medium
task_type: performance
area: npm-compat, optimizer, standalone
goal: performance
sprint: current
depends_on: [4586]
related: [3781, 4585]
assignee: ttraenkler/codex
horizon: s
origin: "The npm benchmark generator remained pinned to standalone O3 after the O4 try_table fallback merged."
files:
  - scripts/generate-npm-compat-report.mjs
  - scripts/lib/npm-compat-perf.mjs
  - tests/issue-3781-npm-perf-lanes.test.ts
  - tests/issue-4585-npm-compat-refresh-resilience.test.ts
---

# Restore npm compatibility standalone benchmarks to O4

## Problem

The npm compatibility generator was deliberately pinned to standalone O3 while
Binaryen O4 aborted in `Flatten` on standardized `try_table`. The optimizer now
retries O4 without only that unsupported pass, but leaving the generator at O3
means the benchmark refresh never exercises or reports the merged recovery.

The optimizer reports its successful fallback as a warning. Treating every
`wasm-opt` warning as a failed receipt is normally the correct fail-closed
policy, so the benchmark must recognize only the exact verified fallback and
record the omitted pass rather than broadly allowing warnings.

## Scope

- Restore standalone npm compatibility lanes to O4.
- Accept only the exact successful O4 `try_table`/`Flatten` omission receipt.
- Record `flatten` as omitted on each affected benchmark lane and chart row.
- Continue failing publication for every unrelated optimizer warning.
- Refresh the complete npm compatibility artifact through its main-only workflow.

## Acceptance criteria

- [x] Standalone npm performance lanes request O4.
- [x] The exact successful `try_table` fallback is measured and records `flatten`.
- [x] The same warning at another level and every unrelated warning fail closed.
- [x] Acorn standalone dynamic remains checksum-correct and import-free.
- [x] A merge triggers the aggregate refresh and publishes through the existing promotion-PR path.

## Measurement

The exact Acorn standalone-dynamic lane under Node 24 with standardized
`exnref` enabled measures 57,011.61 us/op versus Node at 4,067.12 us/op
(`0.07134x` Node). The measured 2,129,709-byte binary has checksum 422/422,
zero imports, a verified O4 receipt, and `optimizationOmittedPasses: ["flatten"]`.
The exact clsx runtime-dynamic control measures 0.14344 us/op versus Node at
0.02315 us/op (`0.16137x` Node), checksum 14/14, zero imports, and full O4 with
no omitted passes.
The focused generator run is diagnostic-only and does not overwrite the
aggregate artifacts; the main-only workflow remains their sole publisher.

## Non-goals

- Treating performance changes as a CI gate.
- Claiming `O4` means `Flatten` ran when a lane explicitly records its omission.
- Rewriting historical measurements produced under O3.
