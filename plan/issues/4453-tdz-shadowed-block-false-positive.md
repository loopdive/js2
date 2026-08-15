---
id: 4453
title: "TDZ early-error false positive: nested-block shadowing — 'Cannot access X before initialization' on correct code"
status: in-progress
sprint: current
created: 2026-08-15
updated: 2026-08-15
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

- [ ] Mechanism confirmed (or corrected) and documented in Results.
- [ ] Shadowed nested-block shape emits no TDZ diagnostic; genuine TDZ still
      caught (both pinned by tests).
- [ ] `src/import-resolver.ts` / `src/cjs-rewrite.ts` no longer emit the
      false 'Cannot access' errors.
- [ ] Typecheck + gates green; detect-time delta reported if the hot path
      changed.
