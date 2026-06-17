/**
 * test262-oracle-version.ts — single source of truth for the conformance
 * ORACLE VERSION (#2096).
 *
 * The "oracle" is the verdict logic that decides pass/fail/CE for a test262
 * row: error classification (`classifyError`), negative-test expectation
 * matching, and the error-type precision the runner demands (e.g. the #1945
 * trap-vs-TypeError upgrade). When that logic tightens, rows that used to
 * read `pass` flip to `fail`/`compile_error` for the SAME compiler output.
 * Those flips are oracle skew, not code regressions.
 *
 * Every result row (`recordResult`) and every merged report/baseline JSON
 * is stamped with this version. `scripts/diff-test262.ts` refuses to diff a
 * baseline against a candidate whose oracle_version differs (the comparison
 * would be apples-to-oranges and the regression gate would fire on skew),
 * unless `ORACLE_REBASE=1` is set — which is how the #1945 flip PR (and any
 * future oracle change) re-seeds the baseline at the new version.
 *
 * ── HOW TO BUMP ──────────────────────────────────────────────────────────
 * When you tighten the oracle (change classifyError / negative-expectation
 * matching / required error precision in a way that flips existing rows):
 *   1. Bump ORACLE_VERSION below (increment the integer).
 *   2. Note the change in ORACLE_VERSION_HISTORY.
 *   3. Land the change as a single PR run with ORACLE_REBASE=1 so the diff
 *      gate accepts the cross-version comparison and promote-baseline
 *      re-seeds the committed baseline at the new version.
 * After that PR merges, every post-flip PR diffs same-version → same-version
 * and the gate measures only code changes again.
 *
 * The version is an opaque monotonic integer — it is NOT the compiler
 * version or a date. Two runs with the same ORACLE_VERSION are guaranteed to
 * apply identical verdict logic, so their rows are directly comparable.
 */
export const ORACLE_VERSION = 1;

/**
 * Append-only log of what each oracle version means. Newest last.
 */
export const ORACLE_VERSION_HISTORY: ReadonlyArray<{ version: number; note: string }> = [
  {
    version: 1,
    note:
      "Baseline oracle as of #2096. Error classification per classifyError + " +
      "negative-test expectation matching as shipped before the #1945 error-type upgrade.",
  },
];
