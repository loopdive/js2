# Wide-carrier owning-main comparison — same24/25, slot returned

2026-09-27. Parent extended the exclusive slot only for the unchanged full25-case file on exact owning main after the integration run. All processes are terminal; slot explicitly returned after baseline terminalea3a2f. No source fix, commit, push, merge, hold change, fixture modification, retry, killed process or unapproved extra compiler execution.

## Pair and isolation

- Candidate: `/Users/thomas/Code/js2/.codex-worktrees/codex-5748-main7443-integration-20260927`, PR HEAD `60fb42a20c0c71e1f273527571170e38da9e5d1e` plus uncommitted MERGE_HEAD `7443ab4826fde65b72f875e0af12337a35520932`, reviewed resolution/formatting and approved five-line deletion. Immutable execution receipt `5748-approved-bigint-deletion-validation-20260927.md` and its hash manifest remain unchanged.
- Baseline: newly owned detached `/private/tmp/js2-5748-main7443-wide-control-20260927`, HEAD **`7443ab4826fde65b72f875e0af12337a35520932`**. No existing exact-HEAD worktree appeared in the filtered worktree inventory. No original pair tree edited.
- Normal `git worktree add --detach /private/tmp/js2-5748-main7443-wide-control-20260927 7443ab4826fde65b72f875e0af12337a35520932` after cwd/branch verification. Initial sandbox attempt failed before creation: terminal50a9ba exit128, worktree metadata permission. Approved escalation succeeded: session61329, terminal6b2ff1 exit0. No hooks/config/LFS overrides. Configured hooks path `.husky`; no post-checkout hook there. No locks removed or persistent config writes.
- Baseline node_modules linked to existing `/Users/thomas/Code/js2/node_modules`; no install. This full file has no external Test262 fixture reads. No test262 provision/change needed for it.
- Before and after run: `git diff --exit-code HEAD -- src tests package.json pnpm-lock.yaml vitest.config.ts tsconfig.json` exit0; `git ls-files --others --exclude-standard -- src tests` empty. Thus compiler/test/config inputs checked clean, not merely trusted HEAD. `.tmp/5748-wide-baseline-before.sha256` records the original fixture, call-identifier, coercion-engine, string-conversion-argument, bigint-string-context, bigint-wide, vitest config; all seven hashes rechecked unchanged at terminalc43ff2.

## Execution

Same Node **v22.23.2**, Vitest3.2.4, shared dependency installation,2048MB worker heap, one worker, no file/case concurrency as candidate. Both use the original fixture's standalone compileMulti lane and hostBridge off, not a fabricated alternate runner.

Exact baseline command, cwd baseline tree above:

```sh
set -o pipefail; VITEST_FORK_MAX_OLD_SPACE_SIZE=2048 VITEST_MAX_FORKS=1 node node_modules/vitest/vitest.mjs run tests/issue-6656-bigint-wide-carrier.test.ts --no-file-parallelism --maxWorkers=1 --maxConcurrency=1 --reporter=default --reporter=json --outputFile=.tmp/5748-wide-baseline-first.json 2>&1 | tee .tmp/5748-wide-baseline-first.log
```

Baseline session **53692**, terminal **ea3a2f**, **exit1**, **24passed/25total,1failed**. Candidate full five-file batch was session53942, terminal5982f0, exit1; wide-carrier subset24/25, entire population76/77. Candidate was not rerun. Baseline was one full-file run; no name filters.

Baseline artifacts, absolute root `/private/tmp/js2-5748-main7443-wide-control-20260927/`:

- `.tmp/5748-wide-baseline-first.json`: SHA256 `998674d9fa8a31497aa34d9a6f6f9ab3bcdc5960fd05421ba6a386e7450d825f`.
- `.tmp/5748-wide-baseline-first.log`: SHA256 `0d9e09e91aca387526d3205fa852636b5fa1520a7e26302d0c4c08db21235b76`.

Candidate JSON remains `.tmp/5748-bigint-after-deletion.json`, SHA256 `9a22e15505594d2aaa26b6deb327ee8375aa9c1ce0f56917960cf01701c7d02e`.

## Exact row/error comparison

Both fixture bytes hash to **`2a39e92b3f86823b15d75a0f4dd49098003bd17271d7f57efec8d392c27712cf`**. Candidate-owned `.tmp/5748-wide-paired-rows.json` contains all25 original full names, ordered pair statuses and full raw failure messages for both subjects. Comparison finds:

-25/25 ordered full names identical,25/25 outcomes identical; no missing or extra rows.
-24pass/pass,1fail/fail; no pass/fail delta.
-All error-message arrays equal after replacing ONLY each checkout's absolute root with `<subject>`. Raw stacks retained separately; no error signature bucketing or stripped semantic text.
-Sole failed case on both: `#6656 slice 4 — standalone BigInt past 64 bits narrowedString`, line170:31, `AssertionError: expected +0 to be 1 // Object.is equality`.

Original source computes `LoS(2n ** 64n) === "18446744073709551616" ? 1 : 0`, with LoS checking `typeof n === "bigint"` before String(n). Both observe0 where test expects1. Neither run reveals the actual String return text, so truncation/cast/provider attribution is NOT established.

This is positive evidence that the exact failed observation reproduces on pinned owning main; it is not introduced solely by needing the integration branch to reproduce. It does not prove identical internal causes or correctness of all untested String routes. No speculative repair made.

## Native status and remaining boundaries

This is standalone Wasm execution using the original fixture and expected-value assertions. There was no separately executed Node-native oracle comparison; “native” must not be confused with such a paired JS run. The same fixture has ordinary-number controls but no explicit unbranded numeric `type i64 = number` String case. That coverage remains unmeasured; no broad extra controls added.

Prior integration TS7/format pass and provisioned125/125 remain as previously recorded. The two original fixture-load failures and all first logs are preserved, not rewritten as pass. Hume review, original effect-order gap, broader BigInt limitations and PR hold/admission remain separate. All existing compiler processes terminal; exclusive slot returned, no further execution authorized by this receipt.
