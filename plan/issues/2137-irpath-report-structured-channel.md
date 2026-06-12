---
id: 2137
title: "IrPathReport channel: stop laundering IR fallbacks through ctx.errors warnings"
status: ready
sprint: 62
created: 2026-06-12
updated: 2026-06-12
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: refactor
area: compiler
language_feature: compiler-internals
goal: maintainability
related: [1921, 1923, 1530]
origin: "2026-06-12 sprint-62 architecture analysis (pipeline workstream N1); the codegen/index.ts:1318 comment calls this 'tracked as a follow-up' but no issue existed"
---

# #2137 — IR-path failures ride the diagnostics array as fake warnings

## Problem

IR-path failures are pushed as warning-severity entries into the
compile-diagnostics array (`src/codegen/index.ts:1330-1344`). Consumers
(bridge tests, #1858's `[IR-FALLBACK]` grep, the `"Codegen error:"` prefix
gate) all string-match on diagnostics — brittle and unqueryable.

## Approach

Add `irPath?: { claimed: string[]; fallbacks: {name, reason, phase}[] }` to
the codegen result and `CompileResult`; keep one warning line for
back-compat one sprint; migrate bridge-test filters.

## Acceptance criteria

- No test filters on `message.startsWith("IR path failed")`.
- `check:ir-fallbacks` reads the structured channel.

## Notes

Coordinate with #1921 (structured failure gate) and #1923 (demotion
metering) — same family, don't merge into one PR. Routine dev.
