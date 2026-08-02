---
horizon: m
id: 4038
title: "Internal error compiling expression: Cannot read properties of undefined (reading 'kind')"
status: ready
created: 2026-08-02
updated: 2026-08-02
assignee: unassigned
priority: critical
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, observability
goal: npm-library-support
sprint: current
required_by: [1282, 1400, 2693]
es_edition: n/a
related: [1282, 4030, 4033]
---

# #4038 — a `TypeError` inside expression compilation is reported as a diagnostic

## Problem

Two occurrences on the ESLint package entry, blocking emission:

```text
Internal error compiling expression: Cannot read properties of undefined (reading 'kind')
```

This is a **compiler crash**, not a user diagnostic: some code path reads
`.kind` off an `undefined` type/node. It is caught and reported as a compile
error, so the user sees an unactionable message and no binary.

## Why this needs the #4030 treatment first

Like #4019's `Maximum call stack size exceeded`, the message carries **no
location** — no file, no function, no frame — so it cannot be acted on as
reported. #4030 (attach the innermost `src/` frame to internal exceptions) is
effectively a prerequisite for diagnosing this one efficiently; without it the
next person pays the same instrumented-re-run cost on a ~16-minute compile that
#4019 already cost once.

## Acceptance criteria

- The throwing site is identified (do #4030 first, or hand-instrument the catch).
- A reduced fixture reproduces it without ESLint.
- The underlying `undefined` is fixed — not defended against with an `?.`, which
  would convert a crash into a silently wrong lowering.
- ESLint's package entry no longer reports this diagnostic.
