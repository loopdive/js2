# Linear forwarding provider: frozen paired qualification

Baseline production: canonical main `3146af9a349bb20a5a398fba37e8b69b16fb4ab9`.
Test-only execution HEAD: `da6d5ceed9bceb02c648a09801f5d186421db228`.
Candidate execution HEAD: `06533320a4a1a47414d953a6f1656eabb05d6ad6`.
Both execution trees were clean. Source extraction commit:
`f8d931b5ede5964ae1a536a16fa16a8ea1ed5431`, integrated as
`cea128a3b1c25eb15f62bf3cabb5dc97b9643ccb`.

Astra High authored the implementation specification and reviewed the completed
tests without findings. Independent Sol 6.1 Medium agents implemented the source
and thirteen-case test. Parent owns qualification, evidence and integration.

## Exact test command

Both arms ran the same command, from their isolated worktrees:

```sh
pnpm exec vitest run tests/issue-6914-linear-ir-array-forwarding-provider-body.test.ts tests/issue-6893-linear-ir-read-forwarding.test.ts tests/issue-1977.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=default --reporter=json --outputFile=.tmp/6914-validation/ARM51.json
```

Only output destination changes by arm. Both exit 0: 51/51 tests, three files,
zero skips. Raw console and JSON reports are losslessly compressed here. The
new test prints actual HEAD, clean-tree receipt, input hashes, Node/V8, worker
arguments, environment and complete source fixtures. No explicit external
deadline was configured for these two runs; its provenance field remains null.
Baseline duration65.54s; candidate56.46s. These timings are not a performance
claim. Preliminary source-only control runs also passed38/38 in both arms.

## Exact comparison

```sh
node plan/log/6914-linear-forwarding-20261007/compare-arms.mjs plan/log/6914-linear-forwarding-20261007/baseline51.log.gz plan/log/6914-linear-forwarding-20261007/baseline51.json.gz plan/log/6914-linear-forwarding-20261007/candidate51.log.gz plan/log/6914-linear-forwarding-20261007/candidate51.json.gz
```

Result: exact equality of all51 case identities and outcomes, all13 full named
observations,16 binary witnesses and10 full-memory witnesses per arm. The
verifier decodes and independently validates every binary, checks full byte
length and SHA-256, and checks full memory length/hash before comparing entire
records. It rejects absent/duplicate observations, skipped/failing cases,
incorrect input hashes, dirty execution trees and missing artifact populations.
Only provenance `head` and `runtimeSha256` are excluded, after separately
checking both against exact expected values. No observation is normalized.

## Strict test-inclusive typing: original instrument preserved

The candidate strict command exits1 with exactly two TS2339 diagnostics at
test lines622 and629: `TypeDef.name` is not present on `RecGroupDef`. Full
diagnostics, original test bytes and unchanged configuration are retained here.
Command: `node node_modules/typescript7/lib/tsc.js --noEmit -p
.tmp/6914-validation/tsconfig.test-inclusive.json`. The matching baseline also
exited1; its complete diagnostics are byte-identical, preserved as
`baseline-strict-v1.log.gz`. No repaired acceptance is claimed yet.
Astra plan `1e7cfd53e99f8d130fc33fe1f93244494c7fa33b` specifies two rec-group
discriminant guards. Sol implemented only those sites in
`034f8e39109b7e5c508ca0624bdb43de3c4cde50`, integrated as
`fab503f4ae`; repaired test SHA-256:
`59ccfd57937a8d5a15635e746247e83b714b60abebffab4853010bc22dd01a23`.
Fresh strict/runtime comparison is required before accepting this instrument.
Do not weaken typing or discard this original passing-runtime/failing-typing epoch.

## Integration boundaries

Only production changes: root runtime's private resolver callback/import and
`src/codegen-linear/runtime/arrays/forwarding-resolver.ts`. Caller supplies the
unchanged canonical layout data. Registration, ABI, typed helper resolution,
fresh instruction ownership, forwarding reads and generated artifacts remain
unchanged. No shared compiler/preparation/provenance/emitter/source-map edits.

This is a used target-provider architecture improvement, not new frontend array
admission, whole-program IR equality, a performance improvement or permission
to retire legacy code. Session A retains shared contracts and final queue
submission. Normal build/architecture/publication gates must be reported from
their own actual execution; older e1e build failures are not this3146 epoch's
build evidence. Keep the checkpoint HOLD until A accepts remaining gates.
