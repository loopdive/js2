---
id: 7356
title: "Core-vocabulary seam test: guard the living consequence of the PR 5742 move, not whole-file hashes"
status: done
sprint: current
created: 2026-11-17
updated: 2026-11-17
completed: 2026-11-17
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: test
area: ir, tests
goal: ir-full-coverage
related: [3518, 7354, 7355]
---

# #7356 — Core-vocabulary seam test: a living move check

## Problem

`tests/issue-3518-core-vocabulary-seam.test.ts` checked the PR 5742 move
(declarations moved from four IR modules into the core vocabulary) by rebuilding
the eight pre-move sources from the **working tree** through the receipt in
`tests/helpers/ir-core-vocabulary-evolution.json`. That receipt pins the complete
SHA-256 of 23 current files. Twelve of them have since changed (seven through
unrelated main PRs, five through #7354 D1), so its four "moves exactly N
declarations" tests failed on `origin/main` b02b2b9d87. Nobody saw it, because CI
runs a root test file only when a PR touches it (the `quality` changed-root gate);
#7354 D1 touched it and turned red.

Stacking a successor replay per drifted file does not scale: every slice that
adds an intrinsic drifts the same files again. A check of immutable historical
blobs against constants would never change its result, so it would guard nothing
going forward, and CI checkouts (depth 2, main depth 200) do not carry those
blobs.

## Implementation Plan

- **Module:** only `tests/issue-3518-core-vocabulary-seam.test.ts`.
- **What it checks now:** for each of the four moves, the moved declaration
  **names** (embedded once, read from the receipt blobs 8429806b → 1265c47d;
  counts 12/3/2/4 and the old digests matched the previous constants), and on the
  current tree, by TypeScript AST:
  1. each moved name is declared exactly once in its canonical module;
  2. the old module no longer declares it;
  3. the old module still forwards it by name (an export specifier), whichever
     module the forward goes through. Two forwarders now route through
     `runtime/async-providers` and `core/string-runtime`.
  Names added to either module later are outside the lists, so growth cannot
  break the check.
- **Removed:** the whole-file-SHA replay path from this test (the
  `readCoreVocabularyReceiptSource` reads, the moved/retained digests), and the
  `createHash` import with its `digest` helper. The receipt JSON and its helper
  stay: `tests/issue-3518-core-vocabulary-evolution.test.ts` still uses them.
- **Kept unchanged:** the living assertions that pass today (the single canonical
  runtime values, the tuple order and the intrinsic counts, the module-reference
  closure, the type-probe surface).
- **Quality criterion:** no whole-file hash and no git access in this test;
  every assertion fails when the moved declaration it names is redeclared in the
  old module, is no longer forwarded, or is removed from or duplicated in its
  canonical module.

## Result

- The test file passes in full: 20/20.
- Non-vacuity, one name per source file (`IntrinsicSignatureVersion`,
  `AsyncRuntimeFeature`, `IrStringConcatMode`, `IrCountedStringAppendSiteClaim`).
  Each of the four mutations fails the move test, 16 of 16; the unmutated
  control passes. The mutations: redeclare in the old module, remove the
  forward, rename away the canonical declaration, duplicate the canonical
  declaration.

## Follow-up (out of scope)

`tests/issue-3518-core-vocabulary-evolution.test.ts` fails 115 tests on main for
the same reason: it re-authenticates the same receipt against the working tree,
so every drift of the 23 pinned files breaks it. The same subset form fits where
its assertions state a move or retention by declaration name. Its parts that
prove the receipt's own replay mechanics (reciprocal bytes, transfer recipes)
only make sense against fixed inputs. They would have to read the historical
sources from a fixture or be retired with the receipt.
