---
id: 1914
title: "standalone RegExp native-engine reflection, constructor, prototype, and result-shape gaps"
status: ready
sprint: 61
model: fable
created: 2026-06-07
updated: 2026-06-07
priority: critical
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: regexp
goal: standalone-mode
related: [1909, 682, 1474, 1539, 1905]
test262_bucket: standalone-regexp-native-engine
test262_count: 546
---

# #1914 — Standalone RegExp native-engine and reflection gaps

## Problem

The residual RegExp bucket is not only unsupported pattern syntax. The current
standalone JSONL also includes assertion/runtime failures and object/prototype
access refusals around RegExp reflection, constructor forms, result shape, and
legacy static properties.

Representative signatures from the 2026-06-07 standalone JSONL:

- `assert.sameValue(pattern.source, ...)`.
- `assert.sameValue(__executed.input, __expected.input, ...)`.
- `assert.sameValue(__executed.index, __expected.index, ...)`.
- `dynamic constructor patterns`.
- `__get_builtin` dynamic-shape object/property refusals in RegExp prototype
  and accessor tests.
- `Cannot convert object to primitive value` in RegExp literal/prototype tests.

## Scope

- Split true RegExp runtime/result-shape failures from object-runtime
  classifier overlap.
- Fix the smallest native-engine/reflection slice if one is contained, such as
  `.source` fidelity or result `index/input` fields.
- Coordinate object/prototype value reads with #1905 where the root cause is
  generic standalone object dispatch rather than RegExp-specific behavior.

## Acceptance Criteria

- Representative assertion/runtime RegExp rows leave
  `standalone-regexp-native-engine` or are reclassified to a better owner.
- At least one native-engine/reflection residual gets a focused standalone
  regression test when implemented.
- The classifier no longer hides these failures under completed #682/#1474
  umbrellas.
