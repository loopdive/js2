---
id: 1911
title: "standalone RegExp Phase 2d: u/v/d flags, Unicode escapes, lookaround, modifiers"
status: ready
sprint: 61
model: fable
created: 2026-06-07
updated: 2026-06-07
priority: critical
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: regexp-unicode, regexp-lookaround
goal: standalone-mode
related: [1909, 1539, 682, 1474, 1444]
test262_bucket: standalone-regexp-phase-2d
test262_count: 833
---

# #1911 — Standalone RegExp Phase 2d

## Problem

The standalone RegExp residual bucket still contains high-volume syntax and
semantic families that the pure-Wasm matcher explicitly defers to Phase 2d:
`u`/`v`/`d` flags, Unicode property escapes, UnicodeSets, lookahead/lookbehind,
and regexp modifiers.

Representative signatures from the 2026-06-07 standalone JSONL:

- `flags "u" (u/v/d are #1539 Phase 2d)` in property-escape and Unicode tests.
- `flags "v" (u/v/d are #1539 Phase 2d)` in UnicodeSets tests.
- `lookahead (?= / ?!) — #1539 Phase 2d`.
- `unsupported group form '(?-' — #1539 Phase 2d` in regexp-modifier tests.

## Scope

- Implement or embed the native-engine path needed for these Phase 2d pattern
  forms in standalone mode.
- Preserve compile-time refusals for forms that remain unsupported; do not route
  them back to JS-host imports.
- Keep the classifier bucket focused on Phase 2d diagnostics.

## Acceptance Criteria

- Representative `u`/`v`/`d`, Unicode property, lookaround, and modifier
  test262 rows leave the `standalone-regexp-phase-2d` bucket.
- Any remaining refusals cite the specific follow-up phase or issue.
- Focused standalone tests prove no `env.RegExp_*` host import is emitted.
