---
id: 4453
title: "TDZ early-error false positive: nested-block shadowing — 'Cannot access X before initialization' on correct code"
status: done
sprint: 78
created: 2026-08-15
updated: 2026-08-18
completed: 2026-08-15
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

# #4453 — TDZ checker reports shadowed nested-block consts as TDZ violations

Found by the #4420 self-hosting baseline sweep: compiling the compiler's own
`src/import-resolver.ts` fails with `Cannot access 'replacementText' before
initialization` and `src/cjs-rewrite.ts` with `Cannot access 'imports' before
initialization` — both files are correct TypeScript that executes fine.

## Suspected mechanism (verify first — this is a hypothesis with a specific
predicted repro, not a confirmed diagnosis)

`checkTDZInStatements` (`src/compiler/early-errors/tdz.ts`) collects the
let/const declarations of ONE statement list, then scans earlier statements
for references to not-yet-declared names via a traversal that stops at
function/class boundaries but **descends into nested Blocks without tracking
shadowing**. So:

```ts
if (cond) {
  const x = 1;      // inner block's OWN x
  use(x);           // ← reported: "Cannot access 'x' before initialization"
}
const x = 2;        // outer list declares x AFTER the if-statement
```

The outer list's scan sees the identifier `x` inside the `if` block before the
outer `const x` and cannot tell it refers to the inner binding.
`src/import-resolver.ts` declares `const replacementText` twice in sibling
scopes (lines ~1313 and ~1396), matching this shape.

## Implementation Plan (Fable, 2026-08-15)

1. **Confirm the mechanism**: run the predicted repro above through
   `detectEarlyErrors` (see `.tmp/ee-diff.mts` in the `compiler-speedup`
   worktree for the parse+detect harness shape). If it does NOT reproduce,
   STOP and diagnose from the real files instead (binary-search
   `import-resolver.ts` down to the triggering construct) before changing
   anything — then update this section with the real mechanism.
2. **Fix in the collector, minimally**: in the TDZ reference scan
   (`collectTDZRefs` / `checkForTDZRef` — note #4432 restructured this file;
   read the current shape first), when descending into a nested **Block /
   CaseClause-like scope** whose own `LexicallyDeclaredNames` include the
   pending name, do not report references to that name inside it (the inner
   binding shadows the outer). Implementation sketch: at each Block boundary
   during the scan, compute the block's own let/const/class/function lexical
   names (reuse the existing collection helpers in `duplicates.ts` if their
   semantics fit — check before reusing) and subtract them from the pending
   set for that subtree. Same rule for `for`-statement heads if the scan
   descends into them.
3. **Scope discipline**: this changes emitted diagnostics (removes false
   positives) — it is NOT differential-neutral, so the #4425-style
   byte-identical gate does not apply. The guard is tests + the merge_group
   conformance diff: removing a false TDZ *warning* may flip test262
   runtime-negative tests that relied on the warning channel — check the
   test262 TDZ-adjacent suites locally if feasible (grep the baseline for
   tests whose expected error is `Cannot access`), and state in the PR that
   the merge queue's regression diff is the authority.
4. **Tests** (`tests/issue-4453*.test.ts`): (a) the shadowed-nested-block
   shape produces NO TDZ diagnostic; (b) a genuine TDZ violation
   (`use(x); const x = 1;` same list) still produces one — pin both
   directions; (c) `compileFiles` on a reduced fixture mirroring
   import-resolver's shape reports no `Cannot access` error. Optionally (d):
   the real files — `compileFiles("src/import-resolver.ts")` no longer
   emits the false positive (cheap: 5.6 s graph; assert on error text, not
   success, since other gaps may remain).
5. **Perf note**: the per-block lexical-name computation runs only while a
   pending name exists and only on nested blocks in its subtree — keep it
   lazy so #4432's single-traversal win is not eroded; if you add
   allocations on the hot path, re-run `.tmp/ee-time.mts` (compiler-speedup
   worktree) and report the delta.

## Acceptance criteria

- [x] Mechanism confirmed (or corrected) and documented in Results.
- [x] Shadowed nested-block shape emits no TDZ diagnostic; genuine TDZ still
      caught (both pinned by tests).
- [x] `src/import-resolver.ts` / `src/cjs-rewrite.ts` no longer emit the
      false 'Cannot access' errors.
- [x] Typecheck + gates green; detect-time delta reported if the hot path
      changed.

## Results (2026-08-15)

### Mechanism — CONFIRMED exactly as hypothesized, no correction needed

The predicted repro reproduced on the first run, before any change:

```
=== shadowed nested block (predicted repro)
   [warning] 4:11 Cannot access 'x' before initialization   ← the INNER `const x = 1` itself
   [warning] 5:9  Cannot access 'x' before initialization   ← `use(x)`
```

Note the first row: the scan flagged the inner declaration's **own name
identifier**, which is the giveaway that it was descending into the block with
no notion of the scope it had entered.

Both real files reproduced at the `detectEarlyErrors` level too —
`src/import-resolver.ts` 3 diagnostics (lines 1313/1317/1318),
`src/cjs-rewrite.ts` 4 (lines 179/184/186/190) — and the source confirms the
shape in both: `cjs-rewrite.ts` declares `const imports` at line 179 inside
`if (!isConst) { … }` and again at line 194 in the enclosing function body;
`import-resolver.ts` declares `const replacementText` at 1313 inside a nested
`if` and at 1396 in the enclosing for-body statement list.

### Fix

`src/compiler/early-errors/tdz.ts` only. `collectTDZRefs` now subtracts a
nested scope's own lexically-declared names from the pending set **for that
subtree**, via `shadowedNames(node, names)`:

- Boundaries handled: `Block` (let/const incl. destructuring patterns, plus
  function and class declarations), `CaseBlock` (one scope across all clauses),
  `for`/`for-in`/`for-of` heads with a let/const initializer, and `CatchClause`
  (the catch parameter). Function/class scopes are unaffected — the scan
  already stops there.
- **Lazy, per #4432's constraint**: `shadowedNames` returns `undefined` both
  for a non-boundary node and for a boundary that shadows nothing, so the
  common case allocates nothing and the traversal continues unchanged. A
  narrowed `Set` is built only when a scope actually re-declares a pending
  name. When *every* pending name is shadowed the subtree is skipped outright,
  which is strictly less work than before.
- **Emission order is preserved by construction**: the change only removes
  candidate matches; the grouped-by-declaration-map-order-then-encounter-order
  emission in `checkTDZInStatements` is untouched.
  `tests/issue-4432-scope-collectors.test.ts` stays green (8/8).
- `checkForTDZRef` (the initializer self-reference path) gets the same rule,
  guarded by a cheap kind test so it allocates only at an actual boundary.

### Measurements (all A/B'd against the unmodified file kept at `.tmp/tdz-base.ts`)

**Diagnostic delta** — `ee-diff.mts` over test262 `language` + `annexB` + `src/**/*.ts`
(25,878 files):

| | base | fixed |
| --- | --- | --- |
| diagnostics | 23,988 | 22,421 |

**1,567 removed, 0 added.** Every removal is `Cannot access 'X' before
initialization`. 1,566 of them are in `src/**` — 95 distinct compiler source
files, **76 of which drop to zero early-error diagnostics**, so this was
blocking self-hosting far more broadly than the two files in the report.

Exactly **one** removal lands in the whole test262 corpus scanned:
`language/statements/block/scope-lex-close.js` — a **positive** test
(`assert.sameValue(x, 'outside')`) that was being handed a spurious warning on
its `let x = 'inside'`. Removing it can only help that test. The merge queue's
regression diff remains the authority on conformance.

**Detect time** — `ee-time.mts`, same corpus at `sampleEvery=3` (8,626 files),
steady-state (iter2), two independent rounds each:

| | round 1 | round 2 |
| --- | --- | --- |
| base | 2.56 s wall / 2.62 s cpu | 2.63 s / 2.71 s |
| fixed | 2.46 s / 2.52 s | 2.80 s / 2.85 s |

The sign flips between rounds, so **no measurable delta** — the round-to-round
spread (~0.2 s) exceeds the base-vs-fixed spread. #4432's single-traversal
structure is intact.

**Whole-program `compileFiles`** (tsx, outside vitest):

| entry | base | fixed |
| --- | --- | --- |
| `src/import-resolver.ts` | 8 errors, 3 TDZ | 5 errors, **0 TDZ** |
| `src/cjs-rewrite.ts` | 9 errors, 4 TDZ | 5 errors, **0 TDZ** |

The 5 residual errors in each are unrelated self-hosting gaps (a `typescript`
module-resolution error and `Missing __make_getter_callback import`), which is
why the tests assert on the diagnostic text rather than on `success`.

### Tests

`tests/issue-4453-tdz-shadowed-block.test.ts` (16 tests, all green; **11 of the
16 fail on the unmodified file**, verified by reverting):

- 7 shadowing shapes emit nothing: if-block, bare top-level block, for-head,
  switch `CaseBlock`, catch parameter, destructuring pattern, block-scoped
  class/function.
- 6 genuine-TDZ pins still fire at the exact same position, including
  `{ use(x); const x = 1; } const x = 2;` — which is both a shadowing block AND
  its own TDZ violation, and now reports **once** instead of three times.
- `compileFiles` on `tests/fixtures/issue-4453-shadowed-block.ts` (reduced
  import-resolver shape) reports no `Cannot access`.
- The two real files are asserted via `detectEarlyErrors` on their own source
  rather than `compileFiles`: a whole-program compile of either pulls the
  ~700-file compiler graph and peaks at 0.7–0.9 GB RSS, which **OOMs a vitest
  worker** (measured — the worker died at a ~510 MB heap limit). The false
  positive is produced by the early-error gate on the single file, so this
  asserts the same thing without the graph.

Other suites: `issue-4432` 8/8, `issue-1931` 20/20, `issue-4417` 13/13,
`issue-2929` (4 files) 35 passed / 12 skipped — all green. `issue-790` has 4
failures that are **pre-existing**: identical on the unmodified file.

`pnpm run typecheck` exit 0; biome and prettier clean on all touched files.
