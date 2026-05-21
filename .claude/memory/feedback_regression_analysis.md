---
name: Regressions may be false-positive exposure, not real regressions
description: When CI shows a PR has pass→fail regressions, always consider if the "passing" tests were false positives on main
type: feedback
originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---
When a PR CI shows "X tests went from pass → fail", don't immediately assume the PR broke them. ALWAYS consider: were those tests actually passing correctly on main, or were they "passing" by coincidence?

**Common false-positive patterns:**
1. A test expects a SyntaxError in the parse phase, but our compiler also throws SyntaxError during codegen for unrelated reasons — harness accepts it as a match and marks "pass"
2. A test expects TypeError on null access, but the harness wrapper crashes in setup before reaching the real code — accidentally matches
3. An assertion test returns 0 asserts (not wrapped properly), so the harness marks it as pass with "found 0 asserts in source"
4. A test with a skip or throws helper throws in an unexpected place that happens to match the expected error
5. When a fix makes the code more correct (e.g. real Promise.then instead of synchronous mock), tests that relied on the broken behavior flip to "fail" — but those were never really passing

**How to apply:**
- Before blaming the PR, sample 2-3 of the "regressions" and trace them manually
- Look at the test file — what is it actually testing? Is the current behavior on main really correct or is it coincidentally matching?
- If the main "pass" is a false positive:
  - File a follow-up issue (like #1020)
  - Either patch the baseline to mark those tests as `fail` (honest state) or add them to a skip list
  - Admin-merge the PR (don't block a real win on false positives)
- Tell the dev NOT to chase false-positive "regressions" — it wastes iteration cycles

**Example from this session:**
- PR #57 (#1014 async generators) had 4 "regressions" in AsyncFromSyncIterator throw-null/throw-undefined tests
- They were passing on main only because our sync-mock async generator crashed in the harness at a point that matched the expected error phase
- The fix (real Promise-returning async gens) made them correctly fail — the "regression" was the fix exposing the real state
- Admin-merged with #1020 filed for tracking

**Second pattern — `pass → compile_timeout` flake (2026-05-21):**

The post-wave investigation for sprint 53 (see
`plan/issues/sprints/53/post-wave-regression-investigation.md`, task #105)
found that 23 of 27 reported "regressions" were not real — they were
`pass → compile_timeout` flips on tests that compile in <500ms on a fresh
local run. Headline regression count was **overstated ~6×** (27 reported vs.
4 actual assertion failures).

Cause: tests near the 30s compile-timeout boundary flap on/off "pass" with CI
runner load (scheduling, memory pressure, GC timing). The transition is
"runner-load noise," not a compiler regression.

Rule of thumb: a `pass → compile_timeout` transition is noise unless
`baseline_compile_ms > 5000`. The CI feed's `regressions_wasm_change`
(introduced in #1222) already filters these — prefer it for ratio analysis.
For older feeds without that field, subtract `compile_timeout` from
`regressions` before applying the 10% ratio check. The `dev-self-merge`
skill encodes this in Step 1b.
