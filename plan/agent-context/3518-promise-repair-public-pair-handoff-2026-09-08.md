# Promise getter repair: separate public comparison instrument

Static handoff; no compiler, test suite, typecheck or claim hook was run.
The parent owns execution scheduling and non-draft held PR publication.

## Frozen scope

Instrument checkout: `/private/tmp/js2-3518-promise-repair-public-20260908`.
Branch: `codex/3518-promise-repair-public-20260908`.
Base: `5118637e0e9b34291465230428447e511958faa1` (PR #5766).
Only two new scripts and this handoff are changed. No production, old runner,
fixture, historical expectation or previous receipt is modified.

- `scripts/verify-promise-resolution-repair-public-pair.mts`
  SHA256 `760b072fe1288f428cfbd786da8ac5d4a0673c7191b6ff9a43fab075f183869d`.
- `scripts/lib/promise-repair-source-manifest.mjs`
  SHA256 `7843ccc549c1eacb31d4252cda4e0e619ead2133e329c401fafacb37fcbe8b87`.

The original extraction runner remains byte-identical, SHA256
`13f3ef003d15cecdee9c9f8fc2263f2c2f7170ae63a3fc7fd49b31a41d62ba40`.
The reused, unchanged 12-recipe JSON remains SHA256
`fb38fbd8180ba54b029b5ec8034929b301d9ab5831f4879385aaebcb417fa0b8`.
The repair runner authenticates both rather than importing/executing the old
runner or changing its four-path extraction-candidate admission.

## Exact experiment and separate verdicts

Lane: actual public `src/index.ts` compile, standalone WasmGC, native strings,
IR false and true. Existing options retain semantic diagnostics, exact source
strings and required real module-init/drain/export actions. No host fallback,
synthetic subscription, source instrumentation or positional WAT classifier.

Original baseline is the clean read-only checkout
`/private/tmp/js2-3518-explicit-rec-integration-20260908`, exact
`2b9cb408c18446361fcf9837045067d1fd97c642`. Its complete `src` census is pinned:
1,316 regular files, SHA256
`48f52a45be1b9b37622d146297ec630dd4a2e3d8458852e804f30d57951bff18`.

Repaired candidate is read-only Pauli checkout
`/private/tmp/js2-3518-promise-getter-capture-20260908`, currently based at
`a7fbc6eb6fa8ebcde29529d67e55408592672fee`. **Its final producer freeze and
independently reviewed cumulative manifest SHA are still required.** No current
draft hash is silently selected by the compiler run. This is not the older
four-file extraction candidate, nor the instrument checkout's compiler.

Denominator is unchanged: **12 recipes × 2 modes = 24 pairs / 48 compiles /
96 fresh instances / 184 external action observations**. Failed/refused rows
remain in the fixed matrix with full errors and phase. Every successful compile
is instantiated twice using exactly its recorded full binary. Full WAT, resource
order, import/export order, IR outcomes, string pool and values are retained.

`preservationOK` requires raw deep equality of all rows. Nothing is normalized,
including intended binary/WAT changes or checkout prefixes in errors.
`semanticOK` still means both arms meet the unchanged fixture oracle, so the
expected baseline defect makes it false. `candidateSemanticsOK` is independent
of baseline values. `repairAcceptanceOK` requires all candidate semantics,
the exact expected baseline defect, every comparator control and no provenance
drift. A successful repair may (and likely will) report `preservationOK:false`.
It never constitutes general physical acceptance, cutover or retirement proof.

The independently read old baseline report SHA256 is
`0021d12520b0ae0b1e0c8da639a4a655dc1047cd1bcbd79bd27d5b0e89329744` at
`/private/tmp/js2-3518-vector-grow-store-20260908/.tmp/promise-resolution-public-parent-r1/baseline.json`.
The original comparison report SHA256 is
`880909fc1e0f89f2cdb5ff98913c597f6649ef5c0228b8d5e8d6f4f46361cbb3`.
Both getter-trace modes, both repetitions, actually observed action values
`[1, 0, undefined, 2, 0, 1, 99, 13184]`. The unchanged correct oracle is
`[1, 0, undefined, 1, 1, 0, 42, 1324]`. Exactly those 20 value discrepancies
are required from the baseline; the other 22 baseline rows must meet semantics.
Historical defects are labeled as defects, not converted to correct expectations.

## Source manifest protocol

The plain-Node helper never imports the compiler. After Pauli's final freeze,
the parent supplies its independently verified producer receipt path and SHA.
The current producer shape is `{worktree, base, sha256: {path: digest}}`, with
exact four production owner paths: scheduler, closed-method-dispatch, resolution
bodies and thenable bodies. The helper verifies their hashes, root and current
HEAD against that receipt. A committed/moved candidate needs an updated explicit
producer receipt; there is no fallback to an old base or another checkout.

Capture records the *entire* baseline/candidate `src` inventories and every
added/removed/modified source path with both hashes. The cumulative difference
can exceed four because the repaired candidate has published prerequisites.
The parent must review this census before pinning its SHA; it does not imply
all differences are attributable to the four-file repair.

The compiler runner requires both `--candidate-manifest` and an explicit
`--candidate-manifest-sha256`. It never regenerates admission during execution.
Both arms' HEAD/status/source censuses, producer receipt, runtime binary,
tsx/esbuild implementations/native binary, configuration, helper and runner
identities are rechecked before/after. Baseline and candidate use identical
runtime/loader/configuration identities, distinct selected-root dynamic imports,
and explicit scrubbed launch environments. Each actual child launch/terminal
is bound to its positional root, arguments, report hash and clean exit.

## Exact proposed commands (UNRUN)

Run from `/private/tmp/js2-3518-promise-repair-public-20260908`. The parent must
first provide `REPAIR_PRODUCER_SHA256` from the final Pauli freeze and explicitly
grant the heavy slot before the second command. No install is required; the
controller below uses the already provisioned baseline tsx loader. Each child
resolves its own selected-root loader independently.

```sh
mkdir -p .tmp
node scripts/lib/promise-repair-source-manifest.mjs \
  --baseline /private/tmp/js2-3518-explicit-rec-integration-20260908 \
  --candidate /private/tmp/js2-3518-promise-getter-capture-20260908 \
  --producer-receipt /private/tmp/js2-3518-promise-getter-capture-20260908/.tmp/promise-getter-capture-manifest.json \
  --producer-receipt-sha256 "${REPAIR_PRODUCER_SHA256:?supply independently verified final freeze SHA256}" \
  --output /private/tmp/js2-3518-promise-repair-public-20260908/.tmp/promise-repair-candidate-manifest-r1.json
```

Read/review the generated complete census, then independently pin its SHA in
`REPAIR_MANIFEST_SHA256`. A fresh output directory is required; preserve all old
reports. Capture does not grant a heavy slot or execute any compiler.

```sh
NODE_OPTIONS=--max-old-space-size=2048 \
TSX_TSCONFIG_PATH=/private/tmp/js2-3518-promise-repair-public-20260908/tsconfig.json \
TSX_DISABLE_CACHE=1 \
node --import /private/tmp/js2-3518-explicit-rec-integration-20260908/node_modules/tsx/dist/esm/index.mjs \
  scripts/verify-promise-resolution-repair-public-pair.mts \
  --baseline /private/tmp/js2-3518-explicit-rec-integration-20260908 \
  --candidate /private/tmp/js2-3518-promise-getter-capture-20260908 \
  --candidate-manifest /private/tmp/js2-3518-promise-repair-public-20260908/.tmp/promise-repair-candidate-manifest-r1.json \
  --candidate-manifest-sha256 "${REPAIR_MANIFEST_SHA256:?supply independently reviewed census SHA256}" \
  --output /private/tmp/js2-3518-promise-repair-public-20260908/.tmp/promise-repair-public-r1 \
  > .tmp/promise-repair-public-r1-controller.log 2>&1
```

The controller records a fresh finite nonnegative load check, then runs baseline
and candidate sequentially with 2 GiB heaps. No deadline kill or retry exists.
Expected outputs: `expected.json`, per-arm progress/full/launch/terminal reports,
stdout/stderr logs and `comparison.json`, containing raw differences, row
transitions, actual denominators, all semantic gaps and separate verdicts.

## Controls and static checks

All six original comparator negatives remain: dropped row, wrong root, stale
provenance, substituted instantiation bytes, wrong value and changed outcome.
The last two now compare mutated candidate to the unmutated candidate rather
than relying on the already-different baseline; intended changes cannot make
these controls vacuous. Eight additional controls cover stale manifest digest,
changed census, missing source difference, changed producer freeze, missing /
nonzero / signalled terminal, and a baseline with its defect removed.

Static checks only: both new scripts parse, all 12 unchanged source fixtures
parse, and the fixed denominator is 184 actions. Ten retained function
declarations (including actual `measure`, artifact capture and serialization)
are identical after applying the same normal formatter to both versions.
An initial raw TS-printer comparison stopped on formatting-only multiline
`observation`; the formatter-normalized comparison then passed 10/10. No receipt
was reseeded. Normal formatting and `git diff --check` pass.

All 14 comparator controls, manifest capture and the complete compiler comparison
remain **unrun**. No final candidate hash/acceptance is claimed. Wait for parent
freeze review and explicit execution grant; do not duplicate its running jobs.
