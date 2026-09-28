# V2.1 typed-copy maintenance: TS7pass, baseline1/2, integration2/2

2026-09-27. Parent authorized typed-copy harness maintenance only after all v2 processes were terminal. All v2.1 processes now terminal; **compiler slot explicitly returned after integration terminal7b977d**. No production semantic change, stage/commit/push, main refresh, hook bypass, policy relaxation or acceptance claim.

## Frozen artifacts and sole harness change

- Executed v1 moved byte-identically with apply_patch from tests into `.tmp/5748-numeric-i64-v1-705b-frozen.test.ts`; SHA256 `705bc72f648b977aed9aac6c3702710c2400701df34297cbb717352805d69184`. This was our additive failed diagnostic, NOT an old original fixture. It is no longer under default tests discovery. Publishable identical copy: `plan/agent-context/5748-frozen-numeric-v1-705b.test.ts.txt`.
- Executed v2 archived unchanged BEFORE editing in `.tmp/5748-branded-string-v2-f635-frozen.test.ts`; SHA256 `f635cd069727e3125c7b6c29b3327a9d3fedec324c37f6e1b762e234dc7dda74`. Publishable identical copy: `plan/agent-context/5748-frozen-branded-v2-f635.test.ts.txt`.
- V2.1 retains path `tests/issue-5748-branded-string-binary-routes-v2.test.ts`; SHA256 **`daa4b42dfb4dd54ec176dc8a1244ae46cba780320e63e2b9b68996ce3c8d6677`** on both subjects before/after.
- Sole change: construct `const binary: Uint8Array<ArrayBuffer> = new Uint8Array(result.binary)`, assert equal length and every byte, record binaryCopyVerified, use that SAME copy for hashing, Binaryen decode and WebAssembly.Module. No unsafe BufferSource assertion, no value/route expectation change. V2 first TS7 failure remains untouched.

## Subject and sequential commands

Candidate remains owned `codex-5748-main7443-integration-20260927`, PR HEAD60fb42a20c0c71e1f273527571170e38da9e5d1e plus uncommitted pinned main7443ab4826fde65b72f875e0af12337a35520932. No integration refresh to latest main45626.

Fresh baseline `/private/tmp/js2-5748-main7443-branded-v21-control-20260927`, detached exact7443ab4826fde65b72f875e0af12337a35520932. Normal worktree add after cwd/branch verification: session56411, terminal1f1599 exit0. No hook/config overrides. Existing node_modules symlink; no install. Only same-byte additive test supplied through apply_patch; prior baseline trees unchanged. Tracked src/tests/package/lock/runner/config diff against HEAD remains empty.

Node v22.23.2; Vitest3.2.4. Three processes sequential, no retries or killed/restarted processes:

1. `node node_modules/typescript7/lib/tsc.js --noEmit -p .tmp/5748-v2-tsconfig.json`: **session36426, terminal17c63a, exit0**. Temporary extends config from v2 unchanged: full src plus exact additive file, rootDir.., exclude[]. Log `.tmp/5748-v21-ts7-first.log`. This fixes the harness BufferSource type error without suppression.
2. Baseline FIRST, start11:16:39: **session21931, terminale35de6, exit1,1passed/2total,1failed**.
3. Integration SECOND, start11:17:09: **session11635, terminal7b977d, exit0,2/2passed**.

Exact test command in each subject, with BASENAME `5748-v21-baseline-first` / `5748-v21-integration-first`:

```sh
set -o pipefail; VITEST_FORK_MAX_OLD_SPACE_SIZE=2048 VITEST_MAX_FORKS=1 node node_modules/vitest/vitest.mjs run tests/issue-5748-branded-string-binary-routes-v2.test.ts --no-file-parallelism --maxWorkers=1 --maxConcurrency=1 --reporter=default --reporter=json --outputFile=.tmp/BASENAME.json 2>&1 | tee .tmp/BASENAME.log
```

No filters, unchanged2-case population, same standalone/nativeStrings/hostBridge off/optimize:false source. No decoder optimize/rewrite. Every compile says binaryCopyVerified:true.

## Results and byte/route equality to executed v2

Baseline still fails only branded constructor: **1152921504606847000** versus native **1152921504606846976**. Direct String exact, equality probe0. Integration both exact **1152921504606846976**, probe1. Native vm oracle exact on both. Physical binary export/signature assertions pass: i64 input (plus f64 index on unit functions), f64 result. No unbranded numeric-i64 coverage.

All four v2.1 receipts compared to corresponding v2 records in `.tmp/5748-v21-maintenance-comparison.jsonl`: binarySha256, native values, complete actual values/units and entire routes arrays identical; copyVerified true. Both arm compilations share the same binary per subject:

- Baseline `9534c0863845b78c750e1869892cc982ce74037aa5148a6b11c25264ac3b6be2`.
- Integration `100afe1d962f493e387499dc0015320d533443872cb7ceaafc094a10bee54ee3`.

Constructor decoded bodies retain baseline number_toString(f64.convert_i64_s(...)) versus candidate bigint_toString on i64. Direct String roots retain \_\_extern_toString. Static reachable paths are not dynamic branch coverage; ignored indirect/quoted helper edges remain the explicit v2 limitation. See full v2 receipt for route scope, not an acceptance upgrade from this type-only maintenance.

## Artifact hashes

Candidate:

- `.tmp/5748-v21-ts7-first.log`: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` (empty, terminal exit0 recorded above).
- `.tmp/5748-v21-integration-first.json`: `fc7222f5312217c22bdfa7c53497c90dca7d9d17dfb47d16b90717e7747102b1`.
- `.tmp/5748-v21-integration-first.log`: `c83d1cdf3a18f5d3ba34f544831e0f620c63dda718262c07c38ff17a9f82bdb6`.

Baseline fresh root above:

- `.tmp/5748-v21-baseline-first.json`: `39d21499e814468777830c275bb9c1d3c393e824583f59f26132906eb3b42f22`.
- `.tmp/5748-v21-baseline-first.log`: `6319ebd7e4a91eec90c98d44ed2f2fd5bdf7acec78b0b62ad56905e1ab8071bf`.

All first v1/v2 records preserved, including TS7 failure and wrong-ABI/parser failures. No original fixture changed; no broad git status/LFS filter. Four original array blockers, effect-order gap, numeric-i64 gap, Hume acceptance review, PR HOLD and compiler retirement remain separate. Slot returned; no active process. Parent owns staging/commit/push and later main45626 merge decisions.
