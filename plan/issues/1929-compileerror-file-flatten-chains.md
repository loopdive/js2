---
id: 1929
title: "CompileError: add file attribution and stop truncating TS diagnostic message chains"
status: ready
sprint: 63
created: 2026-06-10
updated: 2026-06-12
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: compiler
language_feature: compiler-internals
goal: contributor-readiness
---
# #1929 — CompileError.file + flattened diagnostic chains

## Problem

- `CompileError` has no `file` field (`src/index.ts:124-131`). Multi-file
  compiles report `line/column` with no way to tell **which file** — a hard
  usability gap for the multi-source/files APIs.
- Message chains are truncated: `diag.messageText.messageText`
  (`compiler.ts:560`) keeps only the head of a `DiagnosticMessageChain`,
  dropping TS's "Type X is not assignable… because…" elaboration.
  `ts.flattenDiagnosticMessageText` exists for exactly this.

## Proposed approach

1. Add optional `file?: string` to `CompileError`; populate from
   `diag.file.fileName` at every materialization site (3 today; 1 after
   #1927).
2. Replace manual `.messageText` digging with
   `ts.flattenDiagnosticMessageText(diag.messageText, "\n")`.
3. Include `file` in CLI error formatting when present.

## Acceptance criteria

- A multi-file compile with an error in the second file reports that file's
  name (test).
- A nested assignability error includes the "because" elaboration (test).
- Public API change is additive only.

## Source

Compiler quality review 2026-06. Related: #1928, #1927.
