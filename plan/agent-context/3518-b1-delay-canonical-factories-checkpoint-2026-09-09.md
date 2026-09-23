# B1 canonical delay/combinator factory checkpoint

Model: Codex GPT-6 Astra Low. Base c2e2fa87ea59562fbc9b9386a51e45b7971d1bd9,
branch codex/3518-b1-delay-canonical-factories-20260909. Canonical claim
3518:b1-delay-canonical-factories-20260909, write98042-qkshn6r7,
assignee ttraenkler/codex-pr-shepherd. Original Boyle adapter handoff is
parent-recorded; preserved old tree/claim never overwritten. High's full B
contract was read before implementation; only B1's five source/test files changed.

## Behavior and actual evidence

Three full-reference layout factories retain ordered names, scalar kinds,
mutability and absent parent keys; delay uses the actual canonical closure
header factories. All-provider locals derive names/slots from actual caller
placement. Old adapters consume the shared factories while preserving registry
mutations, cache behavior, allocation order, localMap effects and finally restoration.
No body builder is duplicated and no B2/B3 or parent activation change is included.

The new test reconstructs all three complete old adapters with mandatory unique
inverse patches and unchanged frozen full-source hashes, then invokes the original
historical verifier. It executes independently reconstructed old adapters against
actual dependencies and compares module/registry/local/cache traces. Thus the
provenance assertion is checked against live source, not inferred from this report.
Mutations cover bridges, fields/header delegation, local allocation and restoration.
Both delay arms register the real env.__timer_set_timeout import through the
existing registration/shift API. No fake function body or hand-authored handle.

## Terminal validation and retained failure

- First session61547: source TS7 passed; B1 test29/31, EXIT1. Both delay tests
  stopped in reconstructed old adapters because their contexts omitted the
  required timer import. These failures were not deleted or labeled passes.
- Test-only repair uses the existing body-ownership fixture's actual timer
  registration in BOTH arms. High approved repaired hashcb18b105 below.
- Corrected session54477: Prettier unchanged, full source TS7 passed,
  B1 test31/31,1/1file,no skips,EXIT0,total15.80s,test5.673s.
  Command: VITEST_FORK_MAX_OLD_SPACE_SIZE=2048 node node_modules/vitest/vitest.mjs
  run tests/issue-3518-delay-combinator-layout-ownership.test.ts --maxWorkers=1 --no-file-parallelism.
  TS7: node --max-old-space-size=4096 node_modules/typescript7/lib/tsc.js --noEmit -p tsconfig.ts7.json.
- Scoped blast-radius session73477: EXIT0,57/57 across4/4files,no skips,
  total25.61s,test10.69s.
  Exact suites: issue-3518-native-delay-combinator-body-ownership,
  issue-4573-standalone-native-promise-delay,
  issue-4102-ir-promise-delay-closure-compile-once, promise-combinators
  (all under tests/, .test.ts), one worker/no file parallelism,2GiB fork.
- Normal commit/push hooks not yet run at handoff preparation; actual terminal
  receipts will be attached to PR publication, not anticipated here.

Original test bytes remain locally under.tmp/b1-review-v1, SHA256
7e2f4d10f40f8b520167ec14ad4321726475f19412be278d13eac59cb3eb31fe.
Failed61547 bytes remain under.tmp/b1-validation-61547, SHA256
685a8223b78aefe482b45f146559707e75fdc33b297fe784758eacfa1b0835d6.
Original factory bytes also preserved, SHA256
9806baa0b5b9adbcef954e154387d7a3e67584f463bfb8f32ff54ecfb17f2d0e.
These snapshots are NOT committed as active tests. Original manifests/handoffs
remain in the isolated worktree; no failing original evidence is overwritten.

## Original passing worker five-file SHA-256 manifest

```text
003f81b2004d3724a7706be792ffae348b1eb66ab86167cb89ac0b4d9cb295ff  src/runtime/wasmgc/promise/delay-combinator-layouts.ts
86ac9135fa5b0febe6a8dd7a19556d973c9fe2c88827a0b2a0230e94746399be  src/codegen/ir-native-promise-delay.ts
4c14d929347b28e46cd5b6fe050d14f40baec1313881506db9619fbf59c7aa1a  src/codegen/promise-combinators.ts
dd8137b09701fe144e95c328bf4a6affccc779a1a6f76e416258f0430e0afa29  src/codegen/ir-native-async-runtime.ts
cb18b105cdadfb067a20282f32418558d58d3433bfa7b8880d5a7537a579741b  tests/issue-3518-delay-combinator-layout-ownership.test.ts
```

## Authorized historical integration and B1-only boundary activation

Parent received explicit original Boyle handoff for the existing receipt helper
and historical test (original blobs b11067d359 and848e6b843f), frozen/no pending
writer. Parent implemented a separate checked B1 inverse and delegated these
four exact files for this checkpoint; no global claim release was inferred:

```text
2db08ac6dfb265df815f57a31f275dac1fa9887a740eb5b5ddd351afee8d575c  tests/helpers/native-delay-combinator-b1-inverse.mjs
dcb2101fbfbb4e7a03c38ac0ec097da725d9c9bd254c24541ac07b997a45143f  tests/helpers/native-delay-combinator-source-receipts.mjs
26cf721ece91a9d468a42555eaeac49f5375ded7a9bafec2775cad5efb07749c  tests/issue-3518-native-delay-combinator-source-preservation.test.ts
203f5e68a90a8bf6e39e04c5dfe92ace3e06a66fbb4d7522b27b47ef8bf211ea  tests/issue-3518-delay-combinator-layout-ownership.test.ts
```

Current new ownership test replaces its private inverse with that shared checked
inverse. Original passing worker testcb18b105 remains under.tmp/b1-passing-54477.
All four production hashes in the prior manifest remain unchanged. The helper
retains every original body/semantic/bridge/declaration hash and exact proof;
it checks the mandatory live factory before inverting the bounded B1 extraction.
There is no fallback to old input when the new owner is missing or changed.

The parent explicitly delegated B1-only boundary activation in this tree:
native-runtime mandatory factory entry/classification, minimum31->32, one new
history record and four positive-first deletion/demotion/type-import/value-import
controls. All other policy roots, minima, histories and allowed edges unchanged.
Parent E2/generic-concat policy/test changes were NOT copied.

Parent reported53336 EXIT0 299/299 and39682 sourceTS7 EXIT0 on its larger
composition; those are not this isolated checkpoint's result. This tree's own
session49192 EXIT0: full sourceTS7 and279/279 across3/3suites,no skips,
109.30s total. Population:120boundary,128historical-preservation,31B1ownership.
Candidate preservation executed11artifacts/19executions; optional old-compiler
pair NOT RUN. Artifact directory:.tmp/delay-combinator-preservation-6jEqt6.

## Hold and explicit limits

Non-draft checkpoint on codex/3518-number-format-consumer-20260909, held for
parent composition. Only the explicitly delegated B1 boundary activation is
included; parent retains aggregate integration. Historical helper integration is
now included under explicit handoff, with old proof populations preserved.
Candidate artifact execution is not an optional old-compiler-pair run: absent
that explicit pair, no new old-versus-candidate full compiler equivalence claim.
This is not complete native B-family execution, async acceptance, public cutover
or direct-codegen retirement. No main merge, hold removal, bypass or force push.
