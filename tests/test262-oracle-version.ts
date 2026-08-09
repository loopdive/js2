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
export const ORACLE_VERSION = 13;

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
  {
    version: 9,
    note:
      "#3492 fixture-graph honesty. The project runner previously recognized " +
      "only `import ... from` fixture declarations, so bare side-effect imports " +
      "and their transitive dependencies were silently omitted while successful " +
      "single-source execution stamped `reached_test: true`. Both verdict lanes " +
      "now share recursive static fixture discovery. Literal dynamic fixture " +
      "imports are inventoried separately and fail explicitly on standalone " +
      "until #3494 supplies an in-module loader; they are never promoted to eager " +
      "static edges. Parse-negative dynamic imports reach syntax checking before " +
      "that loader policy, including conventional absent targets which evaluation " +
      "must never reach. Rows whose missing fixtures manufactured passes are " +
      "intentionally reclassified and require an ORACLE_REBASE baseline refresh.",
  },
  {
    version: 10,
    note:
      "#3468 F1 standalone assert-harness de-inflation (stakeholder-ruled " +
      "2026-07-23). The standalone lane's test262 assert harness was a vacuous " +
      "no-op: function objects could not carry own properties, so " +
      "assert.sameValue/assert.throws resolved to undefined and every " +
      "assertion silently passed. F1 (closure-own-property carrier widening + " +
      "the top-level F.<name>= keep-arm) makes assertions FIRE — what a " +
      "standalone 'pass' MEANS changes: measured on merge_group run " +
      "30043224652, 3,637 vacuous passes become honest fails (3,545 " +
      "assertion-time throws, 97.5%), 18 improvements, honest host-free floor " +
      "27,557/48,088. Like v4/#3285 these flips compile INTO the wasm " +
      "(wasm-CHANGE regressions), so the re-baseline lands via the bump + a " +
      "#3303 regressions-allow ceiling declared in the #3468 issue file. " +
      "ALSO in v10 (label-only, same bump — the exact v4 pattern): " +
      "classifyError now bins `^Test262Error`-prefixed messages as " +
      "assertion_fail BEFORE the trap regexes — newly-firing assertion text " +
      "quoting the test's own words ('following shrink (out of bounds) " +
      "Expected …') was matching /out of bounds/ and false-positive-tripping " +
      "the #3189 trap ratchet (6 false NEW-oob rows on the F1 run; the same " +
      "Temporal/Duration/…/result-out-of-range-1.js file the v4 fix caught " +
      "for the 'returned N' shape). No pass/fail flips from the relabel; " +
      "promote-baseline re-seeds host+standalone baselines at v10 on merge.",
  },
  {
    version: 11,
    note:
      "#3595 — the #3189 uncatchable-trap ratchet now treats a `compile_error` " +
      "baseline as BASELINE-UNKNOWN, alongside the `compile_timeout`, " +
      "missing-row and identical-`wasm_sha` exclusions it already had. " +
      "Rationale is the one already written in diff-test262.ts for " +
      "compile_timeout: an invalid-Wasm module never instantiated, so " +
      "`__module_init` never ran and never had the opportunity to trap — a " +
      "later trap on that file is *unknown*, not *introduced*. Measured " +
      "evidence (#3593): the minimized repro for " +
      "Iterator/zip/iterables-iteration.js traps IDENTICALLY with and without " +
      "the PR (#3563) that made the file compile, proving the trap pre-existed " +
      "the change that merely let the module reach it. Without this, any PR " +
      "that fixes a compile error is charged for whatever latent trap the " +
      "now-reachable code already contained — the ratchet punishes exactly the " +
      "CE-elimination work it should reward. This is a VERDICT-LOGIC change " +
      "(which transitions count as trap growth), hence the bump; no " +
      "pass/fail/classification flips, so promote-baseline simply re-seeds at " +
      "v11 on merge. A genuine pass→trap (or fail→trap) transition still FAILS " +
      "the ratchet — only baselines that never produced a running module are " +
      "excluded.",
  },
  {
    version: 12,
    note:
      "#3603 S1 HOST-lane verifyProperty de-inflation (stakeholder-ruled " +
      "2026-07-26; same ruling shape as v10/#3468 F1 for standalone). " +
      "test262's propertyHelper.js accumulates descriptor mismatches through " +
      "the uncurryThis idiom `__push = Function.prototype.call.bind(" +
      "Array.prototype.push)`. On the JS-host lane that push was a SILENT " +
      "NO-OP, so `failures.length` stayed 0 and the terminal " +
      "`assert(false, __join(failures, '; '))` never fired — `verifyProperty` " +
      "returned true for ANY expectation. MECHANISM (traced through the import " +
      "bridge, not inferred): a WasmGC vec argument crosses into a host call " +
      "as the `__make_iterable` MIRROR, a JS array that `convertToJS` " +
      "REFRESHES FROM the vec on every crossing (#3368, for array-identity " +
      "stability), so the host appended to an array the Wasm side never " +
      "consults. Plain `Array.prototype.push.call(a,x)` failed identically to " +
      "the uncurried form, so `bind` was never implicated. The fix is " +
      "RUNTIME-ONLY (src/runtime/vec-mirror-writeback.ts + ~14 wiring lines): " +
      "the two host-call bridges bracket their dispatch and replay a " +
      "length-changing mirror mutation onto the vec via __vec_pop/__vec_push. " +
      "WHAT A HOST 'pass' MEANS CHANGES: assertions that could not be " +
      "reported now fire, so previously-vacuous passes become honest fails. " +
      "The flips are NOT caused by this change — they are EXPOSED by it. " +
      "Attribution control: verifyProperty's enumerable predicate was " +
      "evaluated directly (no harness, no __push) with the change applied and " +
      "reverted, and is BIT-IDENTICAL — S1 alters only whether a detected " +
      "mismatch is REPORTED, never whether it is DETECTED. The exposed " +
      "defects are cohort-routed to #3646 (getOwnPropertyDescriptor returns " +
      "null for a class method when the class has computed-name fields, while " +
      "hasOwnProperty says true) and #3647 (propertyIsEnumerable returns true " +
      "while gOPD().enumerable is false — five reflective routes agree, it " +
      "dissents); both reproduce on stock main with S1 reverted. " +
      "Over-application was refuted by an instrumented sweep (51 tests across " +
      "6 areas, 3 in-run positive controls): every reconcile fires on a fresh " +
      "`var failures = []` growing 0→1, ZERO on any other array. " +
      "Like v4/#3285 and v10/#3468 these flips register as wasm-CHANGE " +
      "regressions, so the re-baseline lands via this bump plus a #3303 " +
      "regressions-allow ceiling declared in the #3603 issue file — the bump " +
      "is what makes `rebaseMode` true and therefore the ONLY thing that " +
      "makes that ceiling readable at all (diff-test262.ts reads it lazily " +
      "inside `if (rebaseMode)`). NOTE the gate blind spot found here: " +
      "check-verdict-oracle-bump.mjs watches only negative-verdict.mjs, " +
      "test262-worker.mjs, test262-shared.ts, test262-vitest.test.ts and " +
      "test262-runner.ts — NOT src/runtime/**, so a runtime-layer change can " +
      "flip verdicts corpus-wide without the gate demanding a bump; this " +
      "entry exists because that was caught by hand. NO classifyError change " +
      "in v12 and NO trap growth: the v10 `^Test262Error` → assertion_fail " +
      "rule already binds the newly-created assertion text before the trap " +
      "regexes (verified against the real classifier, including adversarial " +
      "messages embedding trap vocabulary), so the #3189 trap ratchet is NOT " +
      "superseded by this bump and still applies in full.",
  },
  {
    version: 13,
    note:
      "#4162 in-process-lane de-masking. Two independent harness defects in " +
      "tests/test262-runner.ts, both of which SUBSTITUTED a verdict rather than " +
      "measuring one — the same class as v2/#3086 and v12/#3603, and like those " +
      "the flips are EXPOSED by this change, not caused by it. (1) The lane " +
      "instantiated the test binary directly instead of through the shared " +
      "import-object finaliser, so a standalone module linking " +
      "`js2wasm:runtime-eval` died at instantiate and the LINK error OVERWROTE " +
      "the test's real signature. Not niche: the `$262.evalScript` shim " +
      "assembleOriginalHarness injects into EVERY assembled test contains a " +
      "direct `eval`, so the blast radius is bounded by which tests keep that " +
      "shim reachable after DCE, not by their `includes:` list. Measured on one " +
      "162-file ES5 lever: 82 files masked, 18 of them ACTUALLY PASSING — so " +
      "this arm moves rows in the fail→pass direction. (2) handleNegativeTest " +
      "built its compile options from a bare `target` identifier NEVER BOUND in " +
      "that scope; the ReferenceError was thrown inside the `try` whose `catch` " +
      'reports `status: "pass"`, so every parse/early/resolution-phase ' +
      "negative test routed through it passed VACUOUSLY without compiling " +
      "anything (compileMs ≈ 0.05 was the tell). This arm moves rows in the " +
      "pass→fail direction and is the reason the published number is EXPECTED " +
      "TO DROP: those passes were never earned. Fixed by threading the caller's " +
      "target through as a real parameter and building the options OUTSIDE the " +
      "try, so a harness defect crashes loudly instead of laundering itself " +
      "into a conformance pass. Guarded by tests/issue-4162.test.ts, including " +
      "a STRUCTURAL routing assertion that no lane file calls " +
      "WebAssembly.instantiate on a test binary itself — behavioural parity " +
      "between lanes that already share an implementation is tautological, the " +
      "structural check is what prevents a fourth instance of the drift class. " +
      "NO classifyError change and no negative-expectation-matching change in " +
      "v13: the verdict POLICY is untouched, what changes is that the policy is " +
      "now actually reached. The bump exists because a mass reclassification is " +
      "indistinguishable from oracle skew to diff-test262.ts, and without it " +
      "the #1668 catastrophic guard fires on the push-to-main run, " +
      "promote-baseline never runs and the queue wedges (#3003). NO " +
      "regressions-allow ceiling is declared here deliberately: the true flip " +
      "count for arm (2) has not been measured corpus-wide, and guessing a " +
      "ceiling would widen the guard by exactly the amount nobody verified. If " +
      "the merge_group exceeds the rebase drift tolerance, read the count it " +
      "reports and declare THAT number in the #4162 issue file.",
  },
];

/**
 * #3462 — FAST-oracle revision (the native-harness lane), an INDEPENDENT axis
 * from `ORACLE_VERSION` above. Do NOT fold the fast lane into the honest integer.
 *
 * The #3450 hybrid runs two oracles:
 *   - the HONEST in-wasm v8 oracle (`ORACLE_VERSION`, above) — the sole source
 *     of the published conformance number and the honest regression signal; and
 *   - the FAST native-harness oracle (host lane only) — used ONLY to gate merges
 *     against its own self-consistent baseline. The native harness runs
 *     assert.js/sta.js as native JS in the per-test sandbox and compiles the
 *     test BODY only, so its pass/fail verdict diverges from the honest lane at
 *     the native-harness boundary (error-identity, MOP/marshaling, and the
 *     builtins the harness reads from V8 rather than js2wasm — ~9,244 corpus-
 *     projected flips per the spike, plan/design/3450-native-harness-ab-findings.md).
 *
 * These two boundaries move for UNRELATED reasons, so they need independent
 * identities. If the fast lane reused `ORACLE_VERSION = 9`, a future HONEST v9
 * bump would collide: `diff-test262` would then treat a fast rev-1 baseline and
 * an honest v9 candidate as comparable and read the ~9,244 baked-in boundary
 * flips as regressions. Instead the fast lane carries `oracle_lane:
 * "fast-nativeharness"` PLUS this `ORACLE_FAST_REV`, and `diff-test262` refuses
 * to compare rows whose (oracle_version, oracle_lane, oracle_fast_rev) tuple
 * differs unless `ORACLE_REBASE=1`.
 *
 * ── HOW TO BUMP ──────────────────────────────────────────────────────────
 * Increment `ORACLE_FAST_REV` (and add an `ORACLE_FAST_HISTORY` entry) whenever
 * the native-harness VERDICT BOUNDARY changes — e.g. the binding-shim policy,
 * realm/error-construction handling, or which harness symbols resolve natively.
 * Then re-seed the fast baseline (`test262-fast-current.jsonl`) with
 * `ORACLE_REBASE=1` (the fast-lane analog of the honest ORACLE_VERSION bump;
 * see #3465). The honest integer is untouched by a fast-rev bump and vice-versa.
 *
 * Like `ORACLE_VERSION`, this is an opaque monotonic integer scoped to the fast
 * lane — NOT a compiler version or a date.
 */
export const ORACLE_FAST_REV = 1;

/**
 * Append-only log of what each fast-oracle revision means. Newest last.
 */
export const ORACLE_FAST_HISTORY: ReadonlyArray<{ rev: number; note: string }> = [
  {
    rev: 1,
    note:
      "#3461/#3450 native-harness fast oracle (host lane only). The harness " +
      "prelude (runtime shim + metadata includes + assert.js + sta.js) runs as " +
      "NATIVE JS in the per-test sandbox via runInContext; only the test BODY " +
      "(prefixed by a binding shim that binds the referenced harness symbols " +
      "into body scope) is compiled to wasm and instantiated with the sandbox " +
      "as globalSandbox. This moves the verdict boundary relative to the honest " +
      "in-wasm v8 lane: harness-side error identity (assert.js's Test262Error / " +
      "assert.throws matching) is decided by native V8, and MOP/marshaling reads " +
      "that the honest lane performs in-wasm (e.g. Array.prototype.*.length, " +
      "property-descriptor checks in verifyProperty) are delegated to the host. " +
      "Net effect per the spike A/B (plan/design/3450-native-harness-ab-findings.md): " +
      "~18 flips on the 252-test stratified sample, ~9,244 corpus-projected, both " +
      "directions. These are baked into the fast baseline ONCE (seed #3465) and " +
      "never published — the honest v8 lane remains the sole source of the badge.",
  },
];
