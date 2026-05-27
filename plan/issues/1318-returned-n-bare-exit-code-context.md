---
id: 1318
title: "test harness: 'returned N' bare exit code — capture last assertion detail (~8,900 vague failures)"
status: done
completed: 2026-05-27
created: 2026-05-07
updated: 2026-05-27
priority: high
feasibility: medium
reasoning_effort: medium
task_type: improvement
area: test-infrastructure
goal: spec-completeness
sprint: 50
---
# #1318 — `returned N` bare exit code (8,900+ vague assertion failures)

## Problem

The single largest failure category is `assertion_fail` with 8,897 entries. The majority of these look like:

```
returned 2 — assert #3 at L15: assert.sameValue(result, expected, "message..."
```

The message is **truncated** — the assertion source code is cut mid-line, making it impossible to know the actual vs expected value. In the worst cases, the error is just:

```
returned 2
```

With zero context at all. This accounts for ~52 bare "returned N" entries and hundreds of truncated-assertion failures.

## Root cause

In `scripts/test262-worker.mjs`, when the test calls `$262.$262Fail(msg)` or throws a `Test262Error`, the worker captures the thrown message and stores it in the result. But:

1. **Truncation**: The message field has a character limit (likely from a `JSON.stringify` truncation or a fixed buffer). Long assertion messages are cut at ~200 chars.
2. **Bare exit codes**: When the Wasm module exits via `proc_exit(2)` (WASI) or returns a non-zero code without throwing, the worker records only `returned N` with no message because the test harness never called `$262.$262Fail`.

## Fix approach

1. **Increase message buffer**: Remove or raise the truncation limit for `error` field in test results. JSONL lines are one per test — a 2KB error message is fine.

2. **Capture `$262.agent.report` queue**: Some tests communicate results via `$262.agent.report(msg)` before failing. Capture all queued reports and append them to the error message.

3. **Capture Wasm return value context**: When a test "returned N" (non-zero exit), include the last `$262.$262Fail` message if any was called before exit. The test harness in `test262-worker.mjs` can track the last failure message in a mutable cell and surface it when the return code is non-zero.

4. **For WASI proc_exit(N)**: Include the exit code meaning (2 = test failure in test262 harness convention).

## Acceptance criteria

- `assert.sameValue(actual, expected, msg)` failures show both the actual and expected values.
- `returned 2` with no context never appears — replaced by the last `$262.$262Fail` message.
- Message field in JSONL is not truncated below 500 chars.
- The truncated-assertion count drops by >80% (most become diagnosable).

## Resolution (2026-05-27)

Two harness code paths build the failure-context string from a non-zero Wasm
return code (the compiled module returns the **assert index** as an integer,
not actual/expected values — so this layer surfaces the *assert source line +
its message argument*, which is the actionable triage detail):

1. **`tests/test262-runner.ts`** (`runTest262File`, used by equivalence /
   smoke tests) — **already fixed** before this task: `ASSERT_LINE_MAX = 600`,
   `assert #N at L<line>: <source>` format, `Test262Error #N` path, and the
   worker (`scripts/test262-worker-esm.mjs`) raised its cap to 2000 chars.
   Verified by `tests/issue-1318.test.ts` (3 tests, all pass).

2. **`tests/test262-vitest.test.ts`** (`findNthAssert`, the **sharded
   conformance runner** that writes the JSONL where the ~8.9k vague
   `returned N` entries actually live) — **fixed in this task**. It still used
   the old 120-char truncation. Changes:
   - Raised the per-assert cap 120 → 500 and collapse internal whitespace.
   - Bound the captured chunk to a single assert statement (stop at the next
     assert / statement-terminating `;`) so a short assert can't borrow a
     later assert's longer message.
   - Surface the assertion's message-string argument explicitly
     (`… — msg: <text>`).
   - Clearer fall-through for out-of-range return codes (non-assert throw /
     `proc_exit`).

This brings the conformance-report path in line with the runner path, so the
truncated-assertion entries in the JSONL now carry the full assert source +
message instead of a 120-char fragment.

## Test Results

- `tests/issue-1318.test.ts` — 3/3 pass (acceptance criteria for the
  `runTest262File` path: full long message preserved, `at L<n>:` format,
  Test262Error message retained).
- `findNthAssert` formatter (the changed `test262-vitest.test.ts` path)
  verified via standalone probe: short asserts no longer bleed neighbouring
  messages; multi-line asserts captured in full; out-of-range codes get a
  descriptive fallback. (Function is module-internal to the sharded runner;
  not exported to avoid disturbing the runner's top-level test registration.)
