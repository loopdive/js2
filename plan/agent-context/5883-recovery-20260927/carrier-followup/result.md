# Early carrier registration: exact 49-case result

Handle 6411 TERMINAL exit 1; compiler slot explicitly RELEASED. One run only,
no kill/restart. 35/49 pass, 14/49 fail, no skipped cases. Duration 32.25s.
Native 49/49; compilation 49/49; zero imports 49/49. No native/import regressions.

Current parent HEAD 18f1bd831312b3f5805f1e176388aac449c2d389 plus integrated
uncommitted source was hash-verified against /private/tmp/5883-literal-instrument-8yuKQh.
All previous instrumentation removed. Sole source difference is the authorized
seven-line early-registration block in src/codegen/expressions/call-identifier.ts.
Parent source untouched. Existing fixtures/source/expectations unchanged.

Patch: plan/agent-context/5883-bigint-string-early-carrier.patch
SHA256: 9a816d69cb4a15a0db7ba5f899ea456f386529e537a86f0a7f186b7e8262c798
File before: 3ef6af6d5422230f328de5ae7f766629deff3112cc8805ff412c991b463ff904
File after: 07490912920174bf9219e96d9c6f695fdc102b87cd82ede0567a8a5652acc3b9

## Paired results

Local standalone/nativeStrings unchanged Vitest harness; compared by exact generated
source/hash with saved parent candidate logs and original608 baseline receipts.
Raw5 has saved candidate comparison only, no claimed original608 measurement.
Prior candidate total29/49 ->35/49: six gains, zero pass losses.

- String13: 8/13 ->12/13. Gains: wide positive literal; wide negative literal;
  wide unsigned64 edge; wide constant expression.
- raw5: 2/5 ->3/5. Gain: literal wide. Raw actual is now exactly
  "18446744073709551617", not merely a BigInt comparison result.
- valueOf31: 19/31 ->20/31. Gain: wide primitive formatting control without valueOf.

Preserved String13 controls pass: number; Symbol; boolean/nullish/string;
string hint with single evaluation; thrown conversion identity; ordinary conversion
preference; narrow BigInt and signed64 edge. Argument side effect once remains -1:
the combined assertion cannot isolate evaluation count from wrong formatted value.
No claim that this comma-expression wide case is fixed or that all side-effect
paths preserve full width. Reference-wide/provider-wide raw outputs remain "1";
closed-object storage narrowing remains a separate defect. Eight wide provider
matrix cases, runtime-wide wrapper, prototype override and local shadow remain red.
The broken six-case shift instrument was neither executed nor used as evidence.

## Evidence in own .tmp/5883-early-carrier-run

- input-manifest.json: complete per-file parent/copy input hashes and provenance.
- run-01.log: full stdout/stderr, native/actual rows, all five WAT outputs.
- paired-receipt.json: all49 exact source/hash/native/actual/import pairs,
  earlier candidate + saved baseline608 rows, summaries, WAT hashes/output bodies.
- collect.cjs: saved-log-only extraction; no compiler imports or execution.

Log SHA256: 174971f23a521a292c56e43d22aea4ff2e25b7139f33a7117110f6912d38fba9
Command: VITEST_MAX_FORKS=1 VITEST_FORK_MAX_OLD_SPACE_SIZE=2048
./node_modules/.bin/vitest run tests/issue-5883-bigint-string.test.ts
tests/issue-5883-bigint-string-raw-observation.test.ts tests/issue-5883-bigint-valueof.test.ts

No parent changes, production integration, broad tests, typecheck, commits or push.

Post-run verification checked3832 parent/copy entries. Every isolated-copy input
remained unchanged. The only parent change was call-identifier.ts advancing to
the exact tested074909... hash; parent confirmed its own integration. I made no
parent edits. Slot had already been returned before the conditional typecheck
offer, so no typecheck executed; parent must schedule that separately.
