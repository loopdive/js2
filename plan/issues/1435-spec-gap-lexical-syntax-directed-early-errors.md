---
id: 1435
title: "spec gap: lexical grammar and syntax-directed early errors"
status: done
completed: 2026-06-12
created: 2026-05-11
updated: 2026-05-11
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: compiler
language_feature: lexical-grammar, early-errors
goal: spec-completeness
sprint: 52
related: [833, 990, 1315, 1390]
---
# #1435 - Lexical grammar and syntax-directed early errors

## Problem

Spec §8 and §12 are still marked partial. §12 shows `358 / 389` passing with
runtime, negative-test, and skip residuals. Several failures are not runtime
semantics; they are parser or early-error classification gaps.

Known residual areas:

- Import-defer/import-source proposal negative tests.
- Sloppy-mode lexical grammar cases such as legacy octal and reserved words.
- ASI and restricted-production diagnostics that must fail at parse time.
- Reporting false positive/false negative negative-test outcomes in test262.

## Acceptance criteria

1. Negative lexical/syntax tests fail during compile with the expected error
   class instead of producing runtime failures or false passes.
2. Existing import-defer/source handling remains aligned with #1315/#1390.
3. Sloppy-mode lexical cases are either implemented or explicitly skipped with a
   tracked reason tied to #833.
4. §12 mapped pass-rate improves and the report points to this issue for any
   remaining syntax-directed operation gaps.

## Files to inspect

- `src/compiler/early-errors.ts`
- `src/compiler/parser.ts`
- `tests/test262-runner.ts`
- `tests/issue-1435.test.ts`
