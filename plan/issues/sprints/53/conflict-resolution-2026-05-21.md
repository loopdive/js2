# Conflict resolution — 2026-05-21

One senior-developer subagent walked 8 open PRs in a single sequence,
resolving conflicts by understanding the shape of `src/codegen/` on
current main and combining intents wherever both sides were additive.

## Resolved (pushed)

| PR  | Branch                                | New SHA    | Conflict files                    | Notes                                                                                                                                                              |
| --- | ------------------------------------- | ---------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 408 | issue-1470-no-js-host-string-ops      | bc0769230  | .claude/ci-status/*.json          | `--theirs` on ci-status feed files. src/codegen/index.ts auto-merged. tsc clean.                                                                                  |
| 344 | issue-862-iterator-step-errors        | 3254f77f1  | src/codegen/literals.ts           | Two sites widen untyped binding-pattern params. main's #1151 Gap B is broader and covers #862's iterable intent. Take main; credit both issues.                   |
| 350 | issue-1198-presize-dense-arrays       | eeed9f036  | src/codegen/literals.ts           | Both conflicts were `branch deleted nothing, main added': #1239 accessor helper + #1118 method-shorthand. Keep main. Added missing imports for compileArrowAsCallback / emitObjectMethodAsClosure / addStringConstantGlobal that the merged code depends on. |
| 356 | issue-1441-string-split               | 54250e5f6  | src/codegen/index.ts              | Pure textual comment conflict in emitVecAccessExports. Merged both attributions (#1441, #1057, #779c). Code change auto-merged.                                   |
| 379 | issue-1465-promise-combinators        | fc4afc13b  | src/codegen/index.ts              | Both sides additively extend the emit-trigger predicate. Union: Promise_all/race/allSettled/any (HEAD) + __extern_get (main). Combine both comments.              |
| 404 | issue-1504-browser-export-interop     | af4949364  | src/codegen/index.ts              | Union predicate: !__extern_get && vecTypeMap.size === 0. Also fixed pre-existing TS error in #1504's new emitIsClosureExport: superTypeIdx is now number | undefined on main. |
| 407 | issue-1503-browser-crypto             | 8c05f1438  | src/codegen/index.ts              | Union predicate: !__crypto_get_random_values && !__extern_get. Keep main's comment block.                                                                          |

## Recommended for close-and-redo

| PR  | Reason                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 341 | refactor(#1095): remove all 279 `as unknown as Instr` casts — superseded by #470 (issue-806-unary-updates-ts) which landed today and extracted PlusPlusToken/MinusMinusToken handling into a new `src/codegen/expressions/unary-updates.ts`. The HEAD branch still contains the inline cases (lines ~138-554, ~566-1225) that no longer exist on main. The diff is against a file shape that's gone. Comment posted: https://github.com/loopdive/js2wasm/pull/341#issuecomment-4510691967. Suggest reopening with a fresh sweep across the new file layout (158 casts remain per CLAUDE.md). |

## Still conflicting (unable to resolve in this pass)

| PR  | Why                                                  |
| --- | ---------------------------------------------------- |
| —   | None. All 7 mergeable PRs resolved; 1 needs reopen.  |

## Observations

- Six of the seven index.ts / literals.ts conflicts were "branch added a
  predicate to `emitVecAccessExports`, main also added a predicate" — purely
  additive, just textually overlapping. The right resolution is always
  union-of-predicates.
- main has heavily extended `src/codegen/literals.ts` (sprint 53 added
  #1118, #1129, #1239, #1522, #1557) and `src/codegen/expressions/unary.ts`
  (#470 extracted unary-updates). Stale branches that touched these files
  before the refactors landed are at risk of textual conflicts even when
  the intent is orthogonal.
- One pre-existing TS strictness regression surfaced when merging main
  into #1504: `cur.superTypeIdx` is now `number | undefined`. Branches
  that walk super-type chains will need to add explicit undefined-guards
  going forward.

Checklist completed.
