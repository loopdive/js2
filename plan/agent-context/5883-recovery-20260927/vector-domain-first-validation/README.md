# DomainV1 first validation — complete, slot returned

Subject /private/tmp/5748-domain-v1-55d1-validation.njCMzp:
55d1c3731bb1c5b219d12709e90b42e12dbf0a4e + approved dormant production v2
35976d7e475a830bc74b7d257fa3150733a1cd9b0fda0274cbe659bc9f960945,
original30 tests and separate supplement1. No source edits/retries during batch.
Dependency symlink only, no install. No activation/commits/push.

## Terminal handles

- 38596 canonical TS7: exit0.
- 33705 supplemental TS7: exit1, exactly two TS2540 test errors.
- 48359 authored tests: exit0, original30/30 and supplement1/1 (31/31).
- 22221 existing suites: exit1, 230pass47fail /277, five files; 53.00s.
All terminal; exclusive slot explicitly returned to parent.

Canonical command:
node node_modules/typescript7/lib/tsc.js --noEmit -p tsconfig.ts7.json
Supplement:
node node_modules/typescript7/lib/tsc.js --noEmit -p .tmp/5748-domain-validation.tsconfig.json
Supplement includes src plus both authored tests, overrides rootDir and excludes.
Each Vitest command used VITEST_MAX_FORKS=1 VITEST_FORK_MAX_OLD_SPACE_SIZE=2048,
node node_modules/vitest/dist/cli.js run with --reporter=verbose.
Authored command selected both issue-5748-vector-domain test files.
Existing command selected precisely the five paths listed below.

## Existing per-file counts and failure records

- tests/issue-3518-module-reservations.test.ts: 149pass0fail.
- tests/issue-3518-reservation-completion-assertion.test.ts: 15pass0fail.
- tests/provider-manifest.test.ts: 5pass0fail.
- tests/issue-3518-native-argument-vector-resources.test.ts: 34pass43fail.
  42 stop at prepared forward span missing or duplicated: peer-terminal-import.
  One source hash mismatch: expected
  c0714b5385bdf02bdb901f1bbab76fcdcf7b92a5adea182588b3eb34adf42728;
  actual 24ef1173d8fe92682f26a259332ceec65ac37945345d687e7b93af9645617d22.
  Readonly verification: actual object-runtime.ts is byte-identical to exact
  55d1 object-runtime.ts (same actual hash). The test loads this file at line137,
  inverses historical spans at212, and compares checkpoint hash at933.
  No source or fixture hashes replaced; no full legacy reconstruction claim.
- tests/issue-3518-native-vector-resources.test.ts: 27pass4fail.
  Four GVN/replay combinations fail line221's expected diagnostic substring
  scheduler/promise runtime materialization. Actual detail is a 39-gap refusal
  including missing native Promise runtime configuration/producer associations/
  dispatch evidence/construction contracts/composition. Full detail retained.

These are failures, not waived passes. No baseline runtime suite rerun was
authorized/performed. New DomainV1 modules have no pre-existing production
importers; this and exact object-runtime source identity support a source-receipt
mismatch diagnosis, not a measured full baseline equivalence claim.

## Narrow proposed repair (not applied)

The two authored supplemental TS7 errors are lines257 and290 assigning to the
readonly body member of VectorDomainFunctionFill in negative-test setup.
Replace the corresponding array ENTRY with a new {...entry, body: instructions}
record (findIndex for the rawLength case), rather than assigning entry.body.
Do not change the exported readonly API, cast away readonly, or change the invalid
instruction/result expectations. Production needs no demonstrated repair from this batch.

Existing-suite source receipt mismatch needs independent authenticated historical
forward evidence if parent assigns that repair; do not accept a fresh digest.
Native-vector diagnostic mismatch needs baseline comparison and actual refusal
contract review, not suppression or automatic expectation replacement.
No unchanged retry or additional suite requested by this receipt.

## Exact frozen source hashes (verified before and after)

- src/ir/program/vector-domain-plan.ts:
  30d44b414ba0bbe0dfacbbe2a40de255c7cbed5ec446cf04b1b699500fd91287
- src/backend/wasmgc/resources/native-vector-domain-types.ts:
  3cc3fd2587196754b1080313edfbbeae16c19314ece3bfb1df1b2702d769c03a
- src/backend/wasmgc/resources/native-vector-domains.ts:
  81ddba825e87efd7ccddb37fab1b5d974f3a65c96a1313c6b2af17d7646b741f
- tests/issue-5748-vector-domain-reservations.test.ts:
  4db4c575dbd064fd3246ce457729f994987179af9fa8c6e93a3b8c81944d16b3
- tests/issue-5748-vector-domain-service-slots.test.ts:
  1257aecd047c8ddfe20ff9d125bee22fc5f0b40398a49ffb69f4d50adf495569

Full first logs in candidate .tmp (retained unchanged):
- 5748-domain-first-canonical-ts7.log:
  e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
- 5748-domain-first-supplemental-ts7.log:
  990d6f07d924dc07b26697ba46d61b5b072c52a94ccccbe68d6e055ab8de8036
- 5748-domain-first-controls.log:
  eeabc6f9cbd9c9ba29983b23f896e2f57ba79b1e9101556436f2406bb221bb71
- 5748-domain-first-existing.log:
  8efceb1e3e3402c49e237561a0213e6448e5a20ae39e5d165ab55a11d8d6b7e2

31 passing tests prove their physical controls only. Service bodies deliberately
trap. Exact service-slot structure is checked separately; no runtime provider
authentication, semantic readiness, field2 activation or lifecycle acceptance.
