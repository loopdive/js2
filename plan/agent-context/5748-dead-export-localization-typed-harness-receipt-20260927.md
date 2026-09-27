# Typed harness follow-up: supplemental TS7 and 26/26, slot returned

2026-09-27. Parent authorized three minimal typed harness corrections after the
first validation was terminal. The preceding receipt and first failed TS7 log
remain unchanged: `5748-dead-export-localization-first-validation-20260927.md`.
No production change beyond the already reviewed unused accessor removal; no
fixture, test name, expected result, identity assertion, gate or baseline change.

## Corrections and source proof

In `tests/issue-5399-vec-own-index-export.test.ts` only:

- Keep optimize variant labels and parameter `0 | 2`; pass
  `optimize: optimize === 0 ? false : optimize` to the typed API. At pinned HEAD,
  `src/compiler.ts:723` returns without optimizing when `!options.optimize`,
  and its other optimizer arm at line 1497 requires truthiness. Both 0 and false
  skip these arms. The ground-call preprocessing wrappers in
  `src/compiler/ground-call-fold.ts:820,1172` require exactly 4, so neither
  enables preprocessing. This is a supported typed spelling of the same off
  mode, not dropping the unoptimized fixture or changing optimize=2.
- Instantiate `Uint8Array.from(result.binary)`, an owned copy with the same byte
  elements, instead of passing the broadly typed buffer directly. No unsafe
  type assertion or compiler binary transformation; runtime now selects the
  same bytes overload with a valid static buffer type.
- Annotate the existing mock function's `this: ProgramAbiCallableRegistry`.
  Its original forwarding, deliberate failure and finally restoration remain.

## Sequential executions

Same owned integration tree and HEAD `d6f4da7029f06ea81ac20f6271a285fa6179d9a9`.
Both commands used pipefail and tee for stdout/stderr; no concurrent compiler,
retry, killed process, commit, push or hooks.

1. `node node_modules/typescript7/lib/tsc.js --noEmit -p .tmp/5748-own-index-localization-tsconfig.json`
   - Session `8654`, terminal `045228`, **exit 0**.
   - `.tmp/5748-own-index-localization-test-ts7-typed.log` is empty.
   - Same config as first failure: full src plus complete own-index test,
     extending canonical TS7 with rootDir `..` and exclude `[]`.
2. `VITEST_FORK_MAX_OLD_SPACE_SIZE=2048 VITEST_MAX_FORKS=1 node node_modules/vitest/vitest.mjs run tests/issue-5399-vec-own-index-export.test.ts --no-file-parallelism --maxWorkers=1 --maxConcurrency=1 --reporter=default --reporter=json --outputFile=.tmp/5748-own-index-localization-typed.json`
   - Session `25332`, terminal `6a8e44`, **exit 0, 26/26 pass, 0 skipped**.
   - Log `.tmp/5748-own-index-localization-typed.log`.
   - Read-only JSON comparison confirms all 26 ordered full names and outcomes
     match the first 26/26 run exactly. Both optimization variants retain exact
     function/descriptor identity assertions; all five corruption controls pass.

All handles terminal. Exclusive slot explicitly returned immediately after the
test terminal result. No execution after return; receipt/hashes only.

## Hash subjects

- Unchanged production source: `8812aafce8326c6fd4d2f26d40136fb9e221b3bdc8818a97d6efe757ce657f69`
- Typed test: `b313023bc6720b3814f12d3ac2231ff774fc214dbb6294381943d273ddd088ee`
- Empty typed TS7 log: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
- Typed test JSON: `14bfe1fe11edc28a772e06ca6423e673c18f06a5712647e7edc90eaa5be20375`
- Typed test log: `9899fa30e0e3977d57c65ea4ad8d05a416d492bc76590abb5b3a55410493c452`

First reviewed test SHA `2453d4b30f0b2433fdab4016c78bac7c441b903a659b402b5ec798ebfac3f3c4`
belongs to the preceding execution. Focused format exit 0 likewise measured those
earlier bytes; no post-correction formatter rerun is claimed. Canonical source
TS7 and the exact dead-export gate passed before these test-only type corrections;
the supplemental rerun includes full source as well. No new remote CI result is
claimed. Strict graph closure, compiler retirement, four array blockers and all
historical BigInt limitations remain separate; publication awaits parent review.

## Parent publication review

Parent reviewed the complete two-file diff and both validation receipts. The
post-correction formatter left production and test bytes unchanged, so the
typed test hash and 26/26 validation above still identify the publication
subject. JSON reports independently contain 26 assertions, 26 passes and zero
failures in both runs. Documentation formatting does not replace the retained
first logs. This checkpoint repairs the demonstrated CI blocker only; the PR
remains held for the existing behavioral blockers. No gate, baseline, original
fixture, expected outcome or legacy compiler path is removed or weakened.

### Commit attempt blocked by existing function-size growth

The normal commit attempt (session 31111, terminal 8b1c1c, exit 1) passed
formatting, lint and the LOC gate, then failed the function-budget gate:
`src/codegen/expressions/call-identifier.ts::compileBoundIdentifierCall: 3755 > 3753 (+2)`.
The intended five files remain staged, and HEAD remains
`d6f4da7029f06ea81ac20f6271a285fa6179d9a9`; nothing was committed or pushed.
The hook completed cleanup of its own temporary backup.

Source comparison shows the existing Boolean-result fix wraps two early
`boolean: true` returns onto extra lines. The issue allowances still name
`compileIdentifierCall`, not the extracted `compileBoundIdentifierCall` body.
No allowance or baseline was changed and no hook was bypassed. A bounded
intrinsic-emission extraction is being reviewed to address the function size
without cosmetic compression or changing behavior. The successful gate and
26-case evidence above remain scoped to the earlier two-file repair subject.
