# S8 / C8 — Milestone-M integration lane (#7354): suspended 2026-11-20

## Suspended Work

- **Branch:** `claude/7354-integration` (throwaway: never PR'd, never merged, pushed only by this lane).
- **Head:** `e24d01e175`. It holds lane O up to `14345199fe` (O3) and every lane head merged through round 7.
- **Worktree:** `/home/user/js2/.claude/worktrees/c8-int`. Merge resolutions are logged in its `.tmp/resolutions.txt`.
- **Round 8 was started and then aborted. Next step: redo it.**
  - Merge `origin/claude/7354-o` (`e587829733`, O2b runtime ToPrimitive). Five files conflict:
    - the #7354 plan file;
    - `dynamic-member-access.ts`;
    - `dynamic-value-kinds.ts`;
    - `dynamic-value-legalization.ts`;
    - `source-dynamic-contracts.ts`.
  - The resolving agent ran out of budget, so the merge was aborted to leave a clean tree. The partial index diff is in `c8-int/.tmp/round8-o2b-partial.diff`.
  - Then re-merge `origin/claude/7354-crashes`. That brings `097d6a9c71`, the compiler-boundaries entry for `regexp-literal-admission.ts`.
  - Then run the real-prelude census and check S3's measurement that the wall moves from ToPrimitive to `assert.js:27` JSON.stringify. Send the delta to S9.
- **Integration-only rows that the second lander of each pair needs:**
  - `MEMBER_ACCESS_ARM.function = "refused"`, plus the `refused` case in `dynamic-member-access.ts`. Needed by O vs Fa/C.
  - `ProgramKinds.catches`. This replaces O's `LegalizationProgram`.
  - `carrierKind` answering `"function"` for a packed callable. Needed by O vs C.
  - Two compiler strictness inputs: C's `functionThisStrictness` and O3's `codeStrictness`. They should fold into one (S11/S3).
- **Pins to flip (the second lander flips each):**
  - c-function-objects "refuses the object kind's test by name": c vs fa-ty `f4ae23a7b6`. It is a correct claim and matches node.
  - x-dynamic-throw "a closure pack": O vs C. It now moves from refused to admitted.
- **Known failing on the integration head:** the same 44 tests as on `9426e5e1c2`. Of the 93 `check:compiler-boundaries` errors, `prepared-allocations.ts` is with S6/perf2, and `regexp-literal-admission.ts` is fixed by the crashes re-merge.
- **Last census (round 7):**
  - Prepared pass 0 of 9,174 ES5 files.
  - First wall: `assert.js:127` ToPrimitive of an object, 6,690 files.
  - Stand-in harness (S9): 165 pass.
- **Open review threads:** none. #7311, #7313, #7316 and #7318 are merged. Docs PR #7328 stays on hold.
- **Unpushed patch:** `c8-7334/.tmp/7334-arrow-pin.patch`, the #7334 arrow WAT pin (the reviewer's nit). It is for the next PR that touches `tests/issue-7334-*`.
