# Branded binary-root v2 first pair — baseline1/2, integration2/2

2026-09-27. Parent granted bounded diagnostic execution after push15325 terminal0. **All processes terminal; exclusive compiler slot returned after integration terminal4d1859.** No engine fix, test-byte correction, retry, decoder optimization/rewrite, merge, commit, push or hold change. Hume final acceptance review remains pending; results communicated for review.

## Frozen subjects and bytes

- Baseline fresh detached `/private/tmp/js2-5748-main7443-branded-v2-control-20260927`, HEAD `7443ab4826fde65b72f875e0af12337a35520932`.
- Candidate `/Users/thomas/Code/js2/.codex-worktrees/codex-5748-main7443-integration-20260927`, branch `codex/5748-main7443-integration-20260927`, HEAD `60fb42a20c0c71e1f273527571170e38da9e5d1e`, uncommitted MERGE_HEAD7443, same reviewed resolution/formatting and five-line deletion. No refresh to main45626.
- Same before/after test SHA256 on both: **`f635cd069727e3125c7b6c29b3327a9d3fedec324c37f6e1b762e234dc7dda74`**, `tests/issue-5748-branded-string-binary-routes-v2.test.ts`.
- V1 remains `705bc72f648b977aed9aac6c3702710c2400701df34297cbb717352805d69184`; all first instrument failures preserved. Coercion-engine unchanged `3796f9e6ebeae49de2a40fcd0bfaaffb7a4d8a42a8ba1f396854926e425c6b2b`; call-identifier unchanged `8341e693cb4d3e96c4dd553486eb718cd91a0682e2341e7ded5a41b1a07ee087`.
- Normal worktree creation (no overrides) session22556, terminal013e73 exit0. Only additive file installed using apply_patch and existing node_modules symlink. No dependency install. Baseline tracked src/tests/package/lock/runner/tsconfig diff against HEAD empty before/after. Earlier immutable baseline trees untouched.

## Actual execution sequence

Node v22.23.2, Vitest3.2.4. All three processes sequential. No interruption/restart on observation timeouts.

1. **Additive TS7 first failed**: session79529, terminalf869fd, exit1. Command `node node_modules/typescript7/lib/tsc.js --noEmit -p .tmp/5748-v2-tsconfig.json`, pipefail and tee `.tmp/5748-v2-ts7-first.log`. Temporary config extends ../tsconfig.ts7.json, rootDir `..`, includes ../src/\*_/_.ts plus exact v2 file, exclude[]. Error at test117:45, TS2345: Uint8Array<ArrayBufferLike> is not assignable to BufferSource (SharedArrayBuffer versus ArrayBuffer). No source or type suppression applied. Runtime pair continued with approved frozen bytes; a passing typecheck is NOT claimed.
2. **Baseline FIRST**, start11:12:26, session37420, terminal793dd9, **exit1**, **1passed/2total,1failed**.
3. **Integration SECOND**, start11:12:55, session79738, terminal4d1859, **exit0**, **2/2passed**.

Exact test command in each subject (BASENAME `5748-v2-baseline-first` / `5748-v2-integration-first`):

```sh
set -o pipefail; VITEST_FORK_MAX_OLD_SPACE_SIZE=2048 VITEST_MAX_FORKS=1 node node_modules/vitest/vitest.mjs run tests/issue-5748-branded-string-binary-routes-v2.test.ts --no-file-parallelism --maxWorkers=1 --maxConcurrency=1 --reporter=default --reporter=json --outputFile=.tmp/BASENAME.json 2>&1 | tee .tmp/BASENAME.log
```

Both full2-case files, no filters. Per case compile options standalone/nativeStrings, hostBridge off, optimize:false, emitWat:true. Binaryen only reads emitted bytes and emits inspection text; no optimize/pass/write invoked. Each arm separately compiles the identical source. Source hash in all four receipts: `b4bdfb827068cad39a5c2fc423812cf0566a65d44081ca54b21e40fcaae24574`.

## Native/actual observations and physical ABI

Native Node vm uses real BigInt1152921504606846976n, not Number. Both native strings are **1152921504606846976**, equality1. Actual Wasm imports empty on all four compilations. Raw BigInt host argument is passed only after decoded binary signature assertions.

Decoded binary export kind/function identity and full signatures pass for all five roots on both subjects: probe/length `[i64]→f64`, unit access `[i64,f64]→f64`. Binaryen numeric type codes in raw records are i64=3/f64=5; assertions use the API constants, not assumed numeric codes. This proves physical branded-control ABI, **not an unbranded numeric-i64 path**.

- Baseline constructor: length19, actual **1152921504606847000**, direct **1152921504606846976**, probe0. Constructor arm fails exact native comparison at139:32; direct arm passes its own native comparison and equality-consistency check. Constructor failure is retained even though direct passes.
- Integration: both length19 strings **1152921504606846976**, probe1; both arms pass.

Each full log retains complete UTF16 units, actual/native values, source/binary SHA, zero imports, decoded root bodies and formatter bodies/paths. These are actual measured values, not expected-text-only assertions.

## Real route evidence and limits

Binary exports now authenticate root names through getExportInfo/getFunctionInfo, fixing the v1 debug-handle assumption. Raw WAT export evidence explicitly contains handles2097219 through2097223, whereas decoded binary export values name the resolved functions. No guessed handle subtraction.

In **probe, ctorLength and ctorUnit**, decoded baseline body directly contains `number_toString(f64.convert_i64_s(local.get $0))`; integration body directly calls `bigint_toString` on the i64 operand and lacks that conversion. Root bodies and selected formatter implementations are retained. Thus the branded constructor measurement has concrete physical conversion/formatter evidence, not just a helper existing elsewhere in the module.

Direct String observation roots on both subjects call `__extern_toString` after existing boolean-dispatch checks and do not contain f64.convert_i64_s. Runtime direct output is exact on both. The bounded graph additionally finds static paths such as `callLength → __extern_toString → __extern_get → number_toString`. That path is **NOT evidence that this runtime input executed the number formatter**: generic helpers contain branches and indirect paths. Do not use it to contradict the observed exact direct result or to claim complete runtime dispatch coverage.

Decoder limitation explicitly retained: only unquoted direct symbolic call/return_call edges are traversed; indirect/quoted helper callees are not fully modeled. Missing roots/signatures/direct names/formatter paths fail; passing existence checks do not prove every branch or dynamic edge. Hume final review may impose stronger instrumentation for acceptance. Numeric-i64 v1 failure remains a gap, not rerun or relabeled a pass.

Within each subject both case compilations have identical binary hashes:

- Baseline **9534c0863845b78c750e1869892cc982ce74037aa5148a6b11c25264ac3b6be2**.
- Integration **100afe1d962f493e387499dc0015320d533443872cb7ceaafc094a10bee54ee3**.

These are identities of measured binaries, not baseline/candidate equivalence. Source was unchanged throughout. No claim of a minimal causal kill-switch experiment across the entire PR; no new repair made.

## Artifacts

Candidate root:

- `.tmp/5748-v2-ts7-first.log`: `fa5b55634943e0763fda007bf1ca48e3c2095665a4de2bf229c01864ae35b2f9`.
- `.tmp/5748-v2-integration-first.json`: `1c30dc75bdb4fba99755d01dee167e5fa78d1985ba61f2ab38429d3e093c0f1f`.
- `.tmp/5748-v2-integration-first.log`: `c06c36cf09ed133157e6122b4a44d05f3b021923fb801a0ae35bb98cb9038929`.
- `.tmp/5748-v2-pair-route-summary.jsonl`: read-only extraction of all four receipt identities/outputs/ABI/call paths; originals remain full in logs.

Baseline root:

- `.tmp/5748-v2-baseline-first.json`: `11b081f8864116d253a873fcf01dc616e9de1c1a61939e56eb2711527ba82a05`.
- `.tmp/5748-v2-baseline-first.log`: `29438d8922a9f68bfe8ddf254c28c94997ac6461a3301308beeae4c4fa7c6a22`.

No broad git status/LFS filter invocation. No source/test fix after failure, no retry, no engine brand gate added. All first reports remain. Next execution requires a new parent grant. Hume review, additive typecheck correction, numeric-i64 gap, original rest effect-order gap, PR hold/admission and retirement conditions remain separate.
