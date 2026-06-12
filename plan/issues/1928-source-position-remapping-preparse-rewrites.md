---
id: 1928
title: "Source-position remapping for pre-parse rewrites — diagnostics report wrong line numbers"
status: ready
sprint: 63
created: 2026-06-10
updated: 2026-06-12
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: compiler
language_feature: compiler-internals
goal: correctness
---
# #1928 — Source-position remapping for pre-parse rewrites

## Problem

Diagnostics are computed against the **rewritten** source, not the user's:
`compiler.ts:554` calls `diag.file.getLineAndCharacterOfPosition` on
`processedSource`, after:

- the timer shim is **prepended** (`import-resolver.ts:697`) — every line
  shifts down for any source using `setTimeout`;
- imports are replaced by multi-line `declare namespace` stubs
  (`import-resolver.ts:546-589`) — everything below shifts;
- CJS/define rewrites change text lengths.

No offset mapping exists, so reported line numbers are wrong whenever any
pre-parse rewrite fires — which on the primary single-source path is most
nontrivial inputs. Additionally, codegen crashes are anchored to the first
statement (`compiler/validation.ts:17-24`), reporting line 1.

## Proposed approach

1. The rewriters already build replacement lists — record per-rewrite deltas
   `(origStart, origEnd, newLength)` while applying them.
2. A small `PositionMap` translates processed→original offsets; apply it at
   the single point where `CompileError`s are materialized (`compiler.ts:554`
   and the multi-source equivalents — or once in the unified driver, #1927).
3. Prepends (timer shim) become a constant line offset; same-length padding
   is an acceptable stopgap for line-preserving rewrites if any resist
   mapping.
4. Test: a source with an import stub + timer shim + a type error on a known
   line asserts the reported line equals the original.

## Acceptance criteria

- Diagnostic positions match the user's source under each rewrite (import
  replacement, timer shim, CJS, define) — one regression test each.
- No position changes for sources where no rewrite fires.

## Source

Compiler quality review 2026-06. Related: #1929, #1927.
