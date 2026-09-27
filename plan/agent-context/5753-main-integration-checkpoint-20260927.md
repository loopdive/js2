# PR 5753: pinned-main reconciliation checkpoint

2026-09-27. Still held; not merge-ready and not a compiler-retirement claim.

## Exact integration

Isolated worktree:
`/Users/thomas/Code/js2/.codex-worktrees/codex-5753-main-integration-20260927`.
Branch: `codex/5753-main-integration-20260927`.
Merge: `fab3c7cd06e1dda0e4237e7fd2c05c352d8249bb`.
Parents: published PR head `5668c8014b8365358ed655bf6f14b11c85a04065`
and pinned upstream main `46c10411d69c8e18b6e36c2ff09bbe08069f0711`.

The only textual conflict was an import hunk in
`src/codegen/expressions/call-identifier.ts`. Keep all three actually used
imports: `fixedSourceFunctionCallHandle`, `emitConditionalCaptureBoxRepair`,
and main's `compileStringConversionArgument`. No whole-file replacement or
runtime behavior change was invented to resolve this conflict. Main's String
conversion body changes and the branch's call/capture handling are retained.

The previous `codex-5753-main-repair-20260927` worktree remains untouched,
including its modified class-ownness plan and untracked class-evaluation pair.
Do not delete or overwrite them. Their 0/8 result is a shared defect on that
recorded pair, not attribution of all historical PR regressions.

## Measured checks

- Source TypeScript 7: pass.
- File/function size, conversion vocabulary, checker-query and diff whitespace
  checks: pass against pinned main, no new allowance edits.
- Compiler-boundary inventory: valid, zero errors; graph incomplete.
- The two unchanged String-conversion test files from main's PR 6182:
  **21/21 pass**, first run on this integration, terminal session 44428 exit 0.
  Report `.tmp/5753-integration/string-conflict-control.json`, SHA-256
  `f3f1a0b62db1579041d23890b4955f9e6f9981f9dd97c11d7fdfedeaec0b6dfa`.
- The fixture-preservation comparison records all 5,093 tracked test assets
  from the published PR head unchanged. The 36 differences from pinned main
  are retained branch differences, not manual merge edits. Raw manifest:
  `.tmp/5753-integration/fixture-preservation.json`.

These checks cover reconciliation and the conflicting import's actual String
consumer. They do not establish complete behavior, current CI success, or
the disappearance of the known regressions.

## Required next verification

Preserve the original 176-case population, pinned Test262 revision
`b363f29d3c43c626dc852744ad64a0b48a003693`, and all recorded failures in
`5753-original-floor-pair176-20260927.json`. Its HISTORICAL pair compares
main `935dab385ba7f21588ea371d052e7f143f894205` (154 pass) with candidate
`b212925eaba4a038e3b422b21232c41000e2b451` (38 pass): 129 losses and 13 gains.
Those figures are not new measurements of this integration or current main.

Recover the exact original harness/configuration/list and compare pinned
current main against this integration using the same population and settings.
Keep original failures and fixtures; do not exclude losses or refresh a floor
to manufacture acceptance. Distinguish original regressions from additional
shared class-evaluation failures. Broader equivalence and conformance checks
remain necessary before protected-queue entry.

PR 5748 is a separate overlapping branch, not an established predecessor of
5753. Neither is verified superseded. Reconcile their shared IR builder/from-AST
and selection changes explicitly; stacked merges do not count as reaching main.
The old compiler stays until the new IR path is complete and equivalent.
