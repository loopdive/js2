---
id: 1928
title: "Source-position remapping for pre-parse rewrites — diagnostics report wrong line numbers"
status: done
sprint: 63
created: 2026-06-10
updated: 2026-06-16
completed: 2026-06-16
assignee: ttraenkler/tld-2108
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

## Implementation (2026-06-16)

- **`src/position-map.ts`** — new `PositionMap`: built from `SourceEdit`s
  (`{origStart, origEnd, newLength}`, in the rewriter's INPUT coordinates;
  a prepend is `origStart=origEnd=0`). `toInputOffset(out)` translates an output
  offset back to input — exact outside edited spans, anchored at the original
  span start for offsets inside injected text. `compose(inner)` chains stages by
  function composition (apply this stage, then defer to the earlier one) — no
  edit-list flattening, so no interleaving-delta traps.
- **Per-rewrite maps** — each pre-parse rewriter now returns its map:
  `preprocessImports` → `PreprocessResult.positionMap` (import-stub replacements +
  timer-shim prepend, both already tracked internally);
  `rewriteCjsRequireWithMap` (cjs-rewrite.ts); `applyDefineSubstitutionsWithMap`
  (define-substitution.ts, rewritten to scan matches and record spans for exact
  column mapping). The thin string-returning originals delegate, so existing
  callers are untouched.
- **`compiler.ts`** — composes the maps in pipeline order
  (`imports ∘ cjs ∘ define`; `rewriteEvalSuperCall` is a rare same-line
  rewrite → identity, documented & omitted) and applies the composed map at the
  single diagnostic-materialization point (`remapDiagnosticPosition`): map
  `diag.start` (processed offset) → original offset, then compute line/column
  from the ORIGINAL source. Identity map ⇒ byte-for-byte the old behaviour.

### Acceptance criteria — met
- [x] Diagnostic positions match the user's source under each rewrite (import
      replacement, timer shim, CJS, define) — one regression test each in
      `tests/issue-1928.test.ts`.
- [x] No position changes when no rewrite fires (identity path; control test).

## Test Results (2026-06-16)

`tests/issue-1928.test.ts` — 10/10: 4 `PositionMap` unit tests (identity,
prepend, replaced-span anchoring, composition) + 6 end-to-end diagnostic-line
tests (timer-shim → user L3 [was L6 before the fix], import-stub → L4, CJS → L4,
define → L3, combined shim+import → L5, no-rewrite control → exact L2).
typecheck / lint / format clean. The pre-existing failures in
`import-resolver.test.ts` (9) and `typescript-diagnostic-failures.test.ts`
(1, "incremental compilation") reproduce IDENTICALLY on clean origin/main —
not caused by this change.
