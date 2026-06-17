---
id: 1929
title: "CompileError: add file attribution and stop truncating TS diagnostic message chains"
status: done
sprint: 63
created: 2026-06-10
updated: 2026-06-16
completed: 2026-06-16
assignee: ttraenkler/dev-b
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

## Resolution (2026-06-16, dev-b)

1. **`src/index.ts`** — `CompileError` gains an additive `file?: string`.
2. **`src/compiler.ts`** — all three diagnostic-materialization sites now:
   - build the message via `ts.flattenDiagnosticMessageText(diag.messageText,
     "\n")` (keeps the full chain incl. the "because…" elaboration) instead of
     `diag.messageText.messageText` (head only);
   - populate `file: diag.file.fileName` when the diagnostic has a source file
     (spread-guarded so file-less option diagnostics stay clean).
3. **`src/cli.ts`** — the error formatter prefers `e.file` over the entry path
   so multi-file compiles point at the real source file.

Public API change is additive only (new optional field; message content is
strictly richer).

Verified: a `compileMulti` with the error in the imported `other.ts` reports
`file: "other.ts"`; the callback-param-mismatch case now yields the 3-line
chain (head + "Types of parameters … incompatible" + "Type X not assignable to
Y") where the old code kept only the head.

Tests: `tests/issue-1929.test.ts` (3 cases — multi-file attribution to the
imported file, chain flattening keeps the elaboration, single-file still
carries its file name). All pass.

**Acceptance:**
- [x] Multi-file error in the second file reports that file's name
- [x] Nested assignability error includes the "because" elaboration
- [x] Public API change is additive only
