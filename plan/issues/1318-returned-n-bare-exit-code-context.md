---
id: 1318
title: "test harness: 'returned N' bare exit code — capture last assertion detail (~8,900 vague failures)"
status: done
created: 2026-05-07
updated: 2026-05-27
completed: 2026-05-27
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

## Resolution

Landed in two parts.

**Part 1 (commit 39fa6ef3f)** — improved the `runTest262File` smoke-test path
in `tests/test262-runner.ts`: raised the assert-line truncation 160→600 chars,
added the `assert #N at L<line>: <source>` format, added a `throw new
Test262Error(...)` fallback, and bumped the worker JSONL `error` cap to 2000
chars in `scripts/test262-worker-esm.mjs`.

**Part 2 (this change)** — the **sharded CI runner** (`tests/test262-shared.ts`,
driven by the `test262-chunk*.test.ts` files that generate the live conformance
JSONL) and the legacy `tests/test262-vitest.test.ts` still used the OLD
`findNthAssert`: a 120-char cap, a narrow `\b(assert|verify\w+)\b` regex, and a
bare `returned N (found M asserts in source)` fallback. Extracted the locator
into `tests/test262-assert-locator.ts` (side-effect-free, unit-tested) and used
it from both runners. Improvements:

- `extractFullAssert` balances parentheses across lines, capturing the full
  `assert.sameValue(actual, expected, "message")` call — including the message
  argument that `wrapTest` strips from the compiled body but is still in the
  source — capped at 500 chars (was 120).
- Broadened the assert-detection regex to also match `assert.*`, `compareArray`,
  `$DONOTEVALUATE`, and `throw new Test262Error`.
- When the executed-assert counter outruns the static source scan (loops,
  helper-internal asserts), the diagnostic anchors on the **last** assertion in
  the file instead of emitting a bare `returned N` — so the assertion_fail
  bucket entries are diagnosable. The `returned N —` prefix is preserved so
  `classifyError` bucketing is unchanged.

Tests: `tests/issue-1318-locator.test.ts` (10 cases). Existing
`tests/issue-1318.test.ts` (3 cases, Part 1 path) stays green.
