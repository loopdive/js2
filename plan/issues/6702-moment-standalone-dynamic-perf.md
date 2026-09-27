---
id: 6702
title: "moment standalone-dynamic lane is measured but ~2400x slower than Node (12.9 ms vs 5.3 µs per format)"
status: ready
sprint: current
created: 2026-09-27
updated: 2026-09-27
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: perf
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6683, 6678]
---

# #6702 — moment standalone-dynamic: correct, but ~2400x slower than Node

## Problem

After [#6683](./6683-standalone-any-array-slice-returns-null.md) the moment
`standalone-dynamic` lane reaches `status: measured` with the correct checksum
(10 per `moment("2021-02-03").format("YYYY-MM-DD").length`). The measurement
(2026-09-26, local, `--perf-only --lane standalone-dynamic`):

| | per op |
| --- | --- |
| Wasm (standalone, O4) | 12,941 µs (std 7,012) |
| Node | 5.3 µs |
| ratio | 0.00089 |

Every op re-parses a string date through moment's token machinery on `any`
receivers (dynamic dispatch through `__call_m_*`, `__extern_get`, boxed
numbers). Where the time goes is not measured yet.

## Acceptance

- Profile one op (`--inspect-wat` / a sampling profiler) and name the top
  three cost centres with numbers; file or fix the largest.
