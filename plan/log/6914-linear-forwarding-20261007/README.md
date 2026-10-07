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

## Repaired instrument qualification

Repaired baseline HEAD: `034f8e39109b7e5c508ca0624bdb43de3c4cde50`.
Repaired candidate execution HEAD: `20908326570526467ddd03c07afe97c4750ef2eb`.
Both clean execution trees used identical repaired test hash59ccfd, unchanged
source arms, options, workers and51-case command (output suffix `51-v2`).
Both exit0:51/51, three files, zero skips. Baseline94.75s; candidate67.71s;
these observations are not a performance claim. Strict test-inclusive TS7
exit0, zero diagnostics in BOTH repaired arms. Original failed strict checks
remain beside these losslessly compressed repaired logs.

Append the following arguments to the original comparison command:

```sh
plan/log/6914-linear-forwarding-20261007/baseline51-v2.log.gz plan/log/6914-linear-forwarding-20261007/baseline51-v2.json.gz plan/log/6914-linear-forwarding-20261007/candidate51-v2.log.gz plan/log/6914-linear-forwarding-20261007/candidate51-v2.json.gz --repaired
```

`instrument-repair-comparison.json` records exact equality across repaired arms
AND original versus repaired within each arm: all51 exact cases, all13 complete
observations,16 binary witnesses and10 memory witnesses each. Within-arm repair
exceptions are separately pinned revision/test hash only; no observation,
type-name output, resolver count, binary, memory or allocation is normalized.
The same verifier implements both epochs without duplicate comparison logic;
artifact populations are now checked as exactly16 and10, not merely lower bounds.

## Architecture and integration blocker

Fresh candidate gates at frozen3146: canonical dialect exit0 (27 declarations),
flat directory exit0 (829 existing codegen files), explicit-base file/function
budgets exit0 (two changed TS source paths; net+12 LOC), scoped format/lint exit0.
Raw logs are retained. The compiler inventory is NOT green:

- Candidate inventory exits1: `invalid-inventory`, inventoryValid=false,
  architectureComplete=false, graphComplete=false. Exactly three errors:
  unclassified README, unclassified module, unclassified target for the new
  runtime/arrays README and forwarding-resolver leaf.
- Matching unchanged production baseline inventory exits0:
  `inventory-valid-architecture-incomplete`, inventoryValid=true,
  architectureComplete=false, graphComplete=false, errors empty.
- Both use unchanged policy SHA-256
  `8f0fb0fd2992784747e5cb5673aec59f3bec7d76b36abe2c504f459bfbb141b1`.

This is demonstrated new-path shared-registry wiring debt, not an inherited
candidate failure or permission to exempt the paths. Session A owns
`scripts/compiler-boundaries.json`; B has NOT changed it. Exact wiring request:
https://github.com/loopdive/js2/pull/6582#issuecomment-6044655443.
Require explicit module/layer/target/documentation classification, preserving
real migration debt and graph incompleteness; no wildcard or completion claim.

Canonical main refreshed to `a6bf4654f7914f5a472ee22dd6c0358a92bbbc2c`, claims tip
`9596b786795b139e93d1fb9492b61a0c579f9f40`. Since frozen3146, only benchmark
artifacts and three unrelated issue documents changed: no source, test, compiler
policy or target contract change. These measurements remain attributed to their
frozen execution commits, never relabelled as a new-main run.

## Matched full-build failures

Candidate execution HEAD `891412c5eb84fbb7d2570976ca33b143e24d37d2` and
test-only baseline `034f8e39109b7e5c508ca0624bdb43de3c4cde50` both ran
`pnpm run build` with clean execution trees, Node22.23.2,
V8 12.4.254.21-node.56, empty NODE_OPTIONS and no external deadline.
The Vite configuration, package, lock and TypeScript configuration hashes match
exactly, as recorded in the two `*-build-provenance.json` files.

Both exit134 with `FATAL ERROR: Reached heap limit` during chunk rendering:
candidate1765 modules transformed; baseline1764. Complete failures are retained
in `candidate-build.log.gz` and `baseline-build.log.gz`. Decompressed SHA-256:

- Candidate: `50a8f1fb3f27418aaa16ca6dec4c3af5f7457508d235e1551db6a4c5e9fe80af`.
- Baseline: `486e0849dd4657d62201ab6ccc169663b77bdf23715f524f04baec9bf989e271`.

The failure also exists without the production change. Neither build passed;
later hidden errors remain untested. No heap/configuration override or gate
waiver is taken, and Session A's integration acceptance remains required.

## Owner-review inventory proposal replay

Sol6.1 Medium commit `a166aabbd3eff9bfef23111e8582f46bee742a52` supplies
`compiler-inventory-wiring.patch` and `compiler-inventory-proposal.mjs`.
Astra High static review found no actionable correctness findings. Parent ran:

```sh
node /private/tmp/js2-6914-linear-inventory-proposal-20261007/plan/log/6914-linear-forwarding-20261007/compiler-inventory-proposal.mjs --root /private/tmp/js2-6914-linear-forwarding-provider-20261007
```

Frozen source HEAD891412c5eb; canonical policy unchanged8f0fb0fd29. Exit0:
canonical checker exits1/three errors; temporary proposed policy exits0/no
errors; omit-README exits1/one, omit-leaf exits1/two, omit-both exits1/three.
Full reports equal only narrowly constructed classification/edge changes.
Three wrong-hash copied manifests reject runtime, leaf and test individually.
Complete source/test population is frozen against reference trees and checked
before/after every replay together with checker/configuration/toolchain inputs.

Archive `inventory-proposal-replay.tar.gz` contains complete policies, custody
and negative manifests, all five reports/streams and exit receipts. SHA-256:
`be23cd21610d926bab8377cb63e3b529737b3cc82b456e5086622ca0a4025a81`.
The temporary paths do not exist at the comparison base, so their
comparisonBase.policyPresent=false is required; canonical historical-policy
validation remains A's responsibility. Actual registry is NOT changed.
Architecture/graph remain incomplete, canonical acceptance remains false and
HOLD stays. The patch is for the designated owner to review and apply.

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
