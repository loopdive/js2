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
export const ORACLE_VERSION = 8;

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
  {
    version: 2,
    note:
      "#3086 honest vacuity re-baseline. Extends the #2463 vacuity scorer from " +
      "the GLOBAL total-vacuity check (harness wrapper invoked + __assert_count " +
      "=== 1, i.e. zero asserts anywhere) to PER-CALLBACK partial vacuity: a " +
      "would-be pass is scored `vacuous` (fail) when a testWith*Constructors " +
      "wrapper was invoked and EVERY attempted callback invocation contributed " +
      "zero asserts (the dropped-dispatch / dead-callback class of #2939/#2940/" +
      "#3083) — even when setup asserts elsewhere kept __assert_count > 1. This " +
      "reclassifies previously-vacuous 'passes' to honest fails (owner-approved " +
      "regression). Landed with ORACLE_REBASE (forward-monotonic bump auto-" +
      "rebases in diff-test262.ts) so the guards treat the cross-policy diff as " +
      "a re-baseline; promote-baseline re-seeds host+standalone baselines at v2.",
  },
  {
    version: 3,
    note:
      "#3187 error_category classifier split. classifyError previously binned " +
      "'… is not a function' (missing builtin/runtime feature) and 'No dependency " +
      "provided for …' (the compiler's DI diagnostic) as wasm_compile, inflating " +
      "the genuine invalid-Wasm bucket ~3.4× (~448 → ~87 default-lane). Splits out " +
      "three honest buckets: missing_builtin ('\\bis not a function\\b'), " +
      "missing_dependency ('No dependency provided'), and harness_shape ('no test " +
      "export'), while wasm_compile is narrowed to 'invalid Wasm binary|Compiling " +
      "function'. LABEL-ONLY: zero pass/fail flips (net_per_test 0). The " +
      "regression-gate bucket diff is label-noise; landed with ORACLE_REBASE so " +
      "the guards treat the cross-policy relabel as a re-baseline.",
  },
  {
    version: 4,
    note:
      "#3285 assert_throws error-type precision (slice 1). transformAssertThrows " +
      "previously discarded the expected error constructor (args[0]): " +
      "`assert.throws(TypeError, fn)` became a bare `assert_throws(fn)` that only " +
      "checked 'did anything throw', so a codegen bug throwing the WRONG error " +
      "type (e.g. RangeError where the spec mandates TypeError) read as a false " +
      "pass. The runner now threads the expected type through — via a GLOBAL " +
      'NAME side channel (`__expected_throw_name = "TypeError"; ' +
      "assert_throws(fn);`), NOT a second call argument: any class-as-value in " +
      "the method body (2nd arg, matcher closure, or even a global ctor " +
      "assignment) deterministically triggers the #3315 standalone codegen " +
      "corruption of sibling destructured bindings. The shim verifies the " +
      "caught error's `.name` matches the expected constructor name (strict: " +
      "nameless/null payloads are NOT the required type; the check itself is " +
      "guarded so it can never crash the harness; complex ctor EXPRESSIONS — " +
      "3 corpus tests — stay legacy-untyped since evaluating them would " +
      "re-trigger #3315). This reclassifies previously-inflated " +
      "false-passes to honest fails (owner-approved per #3285 acceptance " +
      "criteria — the drop is the correct signal, not a regression). NOTE: because " +
      "the synthetic harness/preamble compiles INTO the wasm, this shim change " +
      "alters wasm_sha for every assert.throws test, so the reclassified flips " +
      "register as wasm-CHANGE regressions — the #3086 forward-bump auto-rebase " +
      "excuses only SAME-wasm oracle-skew flips, so this re-baseline needs a " +
      "promote-baseline/force-refresh at v4 to seed the new-policy floor (the " +
      "oracle bump alone does not clear the #1668/#3086 wasm-change guards). NOTE: " +
      "the #3003 verdict-oracle-bump gate did NOT flag this change — its " +
      "VERDICT_SIGNAL_RE only matches `status:` verdict-literal assignments, not " +
      "verdict-tightening inside the assert_throws/assert_throwsAsync shim body; " +
      "that false-negative is a follow-up gate-hardening item for a future window. " +
      "ALSO in v4 (label-only, same bump): classifyError now bins wrapper " +
      "return-code messages ('returned N — assert #X at LY: <source>') as " +
      "assertion_fail/exception_in_test BEFORE the trap regexes — the embedded " +
      "test source was matching /out of bounds/ etc. and mis-binning honest " +
      "assertion fails as uncatchable traps, false-positive-tripping the #3189 " +
      "trap ratchet (seen live: Temporal/Duration/subtract/result-out-of-range-1 " +
      "counted as a NEW oob on the #3104 measurement run). No pass/fail flips.",
  },
  {
    version: 5,
    note:
      "#3227 async post-drain verdict re-read. The JS-host lane schedules " +
      ".then/await continuations on the HOST microtask queue, which cannot " +
      "drain while test() is still on the Wasm→JS stack — so async tests' " +
      "sync return value was read BEFORE the assertion-bearing callbacks ran " +
      "(they run right after test() returns; #2940 flagged 1,690 of these as " +
      "vacuous). For async-flagged tests the wrapper now exports __result() " +
      "(same verdict logic as the test() epilogue) and the runner yields to " +
      "the event loop after a sync 1/-262, then re-reads the verdict. Flips: " +
      "vacuous → honest pass where continuations assert correctly, vacuous → " +
      "honest assert-fail where they expose real bugs (e.g. await <host " +
      "promise> reads NaN — slice 2), and some sync-pass → assert-fail where " +
      "a post-drain assertion genuinely fails. Cross-version diff is oracle " +
      "skew; forward-monotonic bump auto-rebases in diff-test262.ts. NOTE: " +
      "like v4/#3285, this change compiles INTO the wasm wrapper (the " +
      "__result() export) for every async-flagged test, so the flips register " +
      "as wasm-CHANGE regressions — the #3086 forward-bump auto-rebase " +
      "excuses only SAME-wasm oracle-skew flips; this re-baseline needs a " +
      "promote-baseline/force-refresh at v5 to seed the new-policy floor. " +
      "ORDERING: #3227 originally drafted this as the 3→4 bump; #3285 " +
      "(PR #3104) landed its own 3→4 first, so #3227 re-bumped to 5 per the " +
      "whichever-lands-second-re-bumps rule (documented in " +
      "plan/issues/3227-*.md). Draft PR #3111 (standalone host-backed-pass " +
      "rejection, another drafted 3→4) — or any later oracle change — must " +
      "take 6 with its own history entry.",
  },
  {
    version: 6,
    note:
      "#2961 standalone host-import honesty. A standalone binary that requests " +
      "imports is rejected before the Test262 harness can satisfy those imports; " +
      "legacy leaky-pass rows are reclassified as compile_error. Standalone pass " +
      "now has one definition: the emitted binary is host-free and passes. " +
      "NOTE: this PR was originally drafted as the v4 bump; v4 was consumed by " +
      "#3104 (#3285 assert_throws precision) and v5 was reserved by #3227 (#3161, " +
      "S1 async post-drain verdict re-read) — both landed/queued first, so this " +
      "change re-bumps to v6 per the whichever-lands-later-re-bumps convention " +
      "(v5 is intentionally skipped in this history, not reused: #3161 owns it).",
  },
  {
    version: 7,
    note:
      "#3227 S4 — async post-drain verdict re-read in the CI WORKER lane. " +
      "v5 (#3161, S1) added the __result() re-read to tests/test262-runner.ts " +
      "(runTest262File) ONLY; the sharded-CI / pnpm test:262 path executes " +
      "through scripts/test262-worker.mjs, which kept scoring the premature " +
      "sync verdict — so the v5 policy never actually applied to baseline " +
      "rows (1,679 rows stayed vacuous; the S1-sampled corpus flips 'nearly " +
      "cancelled' because neither direction ever ran). The worker now mirrors " +
      "S1 exactly: after a sync 1/-262 from an async-flagged test it drains " +
      "two setImmediate rounds (capturing a deferred continuation throw as an " +
      "honest fail for THAT test — the module-level unhandledRejection " +
      "suppressor otherwise swallowed it) and re-reads the verdict via the " +
      "wrapper's __result() export. Flips (v5's intended set, now real): " +
      "vacuous → honest pass where continuations assert correctly, vacuous → " +
      "honest assert-fail where they expose real bugs, and some sync-pass → " +
      "honest assert-fail where a post-drain assertion genuinely fails " +
      "(owner-approved honesty regression, precedent v2/#3086 and the S1 " +
      "lead approval of 2026-07-16). No wasm change: the __result() export " +
      "has been in the wrapper since v5, so these ARE same-wasm oracle-skew " +
      "flips — the forward-monotonic bump auto-rebases in diff-test262.ts, " +
      "and promote-baseline re-seeds the committed baseline at v7 on merge.",
  },
  {
    version: 8,
    note:
      "#3370 original-harness oracle. The canonical project runner previously " +
      "compiled wrapTest()'s rewritten surrogate: undefined failure guards " +
      "could be deleted, script globals became function locals, and synthetic " +
      "assert/Test262Error shims replaced upstream constructor identity. " +
      "Verdict-bearing local and sharded execution now compiles the literal " +
      "test262.fyi assembly (runtime shim + metadata includes + assert.js + " +
      "sta.js + untouched body) and performs the required strict rerun. Passes " +
      "that depended on wrapper rewrites are intentionally reclassified. " +
      "Negative failures must also occur in their declared phase and match the " +
      "expected type; wrong-phase compiler/runtime failures no longer pass. This " +
      "version requires an ORACLE_REBASE baseline refresh when landed.",
  },
];
