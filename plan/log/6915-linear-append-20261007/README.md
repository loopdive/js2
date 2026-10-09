# Linear owned ASCII append: original baseline evidence

This is failure-preserving test qualification, not source/performance acceptance
or completed IR migration. Production and fixtures were unchanged at canonical
main `c41bca2bc07e9d8fddbb38ca77904dd1f0cac438`, source tree
`68296a0d34ceea94dbc9ca9398f71bc8a1b742b8`.

The original isolated execution HEAD was
`ea9c2eced70508dbb130dacf52f80de531f1fd3c`, with only the new test uncommitted.
Its SHA-256 was `669d8dfb5150a6574eaef1bb0436884aad18cdf60fab87745cb41418f8571f84`.
Sol subsequently committed those identical bytes at
`276b10a1a7e16a521ed599d240ec3c5286c5aec2`; parent integrated them as
`27c2ecb0e6`. These later commits are not relabeled as the execution HEAD.

Command in `/private/tmp/js2-6915-linear-append-tests-20261007`:

```sh
pnpm exec vitest run tests/issue-6915-linear-owned-ascii-append-copy-kernel.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=default --reporter=json --outputFile=.tmp/6915-validation/original.json
```

Exit1, 28pass/8fail/36, no skips. Runtime16 fails a false construction floor
for genuine canonical self-aliasing. Four source cases and three source-based
negative controls fail during BigInt evidence serialization. The completion
record lists only Runtime16, missing the seven serialization failures; it is
not accepted as a correct successful evidence population. No runtime/source
bug attribution or full source qualification follows from this run.

`original-regression.log.gz` contains full stdout/stderr (uncompressed SHA-256
`0ca71197284f4179755ee4908ef82918fb35224609a8ae24da56ef6e7cef0539`);
`original-regression.json.gz` is the complete reporter output (uncompressed
SHA-256 `49729422755870a2a1f6f0dabbfe2cbbb953f4380b8a0b6a1ac138c124a206a0`).
No failure, fixture, assertion or case has been removed.

Strict typing command, same worker/source/test bytes:

```sh
node node_modules/typescript7/lib/tsc.js --noEmit -p .tmp/6915-validation/tsconfig.test-inclusive.json
```

Exit0, zero diagnostics; full empty output preserved in `strict-original.log.gz`.
The archived configuration is a byte-for-byte copy for that exact `.tmp/`
location: restore there to use its relative paths. `pnpm exec tsgo` was first
attempted and exited254 because the command is unavailable; its full diagnostic
is separately retained in `unavailable-tsgo.log.gz`. It is not a typing result.

The unchanged issue3502 controls ran in the planning worktree at ea9/c41:

```sh
pnpm exec vitest run tests/issue-3502-string-hash-four-lane.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=default --reporter=json --outputFile=.tmp/6915-controls-c41.json
```

Exit0, 2pass/1existing optional Porffor skip/3; complete stdout/stderr and JSON
are `controls-c41.log.gz` and `controls-c41.json.gz`. This is not four-lane equality.
Astra High instrument review/repair remains pending. Source two-loop ownership,
broader shared contracts and Session A's final integration authority stay held.

## First repaired snapshot: separate failed epoch

`repaired-v1.test.ts.gz` preserves frozen, uncommitted instrument bytes SHA-256
`7145be7f67a51d6817bc90117ebecc39cc9a7db6d0e84e16840d8015cebc4b32`.
Actual execution HEAD was `276b10a1a7e16a521ed599d240ec3c5286c5aec2`;
source/fixture remained c41. Exact parent-approved hashes, command and effective
flags are retained in `repaired-v1-parent-input.json.gz`; terminal status and
post-execution identical test digest in `repaired-v1-parent-receipt.json.gz`.

Strict test-inclusive TS7 exits1 with TS2345 at test line362, the unknown
prototype passed to `Reflect.get`. Full diagnostic is `strict-repaired-v1.log.gz`.
Vitest exits1 during the encoder self-check, before any observations: native
Error.stack is an accessor rejected by the data-only encoder. Reporter output
has36 skipped cases because the suite setup failed. No case executes, no
passing repaired population is accepted, and completion correctly records36
missing observations plus provenance/schema failure. These are not deliberate
skips or relaxed requirements. Complete output and JSON are `repaired-v1.log.gz`
and `repaired-v1.json.gz`. Original files above remain unchanged.

The same Node22.23.2/V812.4.254.21-node.56 descriptor probe verifies native
Error/AggregateError.stack own native getter/setter; fresh Error objects share
those getter/setter identities. Message/errors are own data properties. The
next repair must retain all stacks/error contents and continue rejecting
arbitrary accessors. Production, fixtures,36IDs,33transitions and eight
same-validator negatives remain unchanged; no source acceptance follows.

## Complete repaired epochs, strict comparison and remaining CI dependency

Second frozen snapshot b5bbd82d37305a43691ad8197374bc79b2f681d2f8e0879502d97def3865b669
and third c63e83104b42104c0ea9e7d5d3fb3f6f2cce960a65973cbf342698e8e79d7f8d
both pass configured36/36 with no failures/skips and strict0/zero diagnostics.
Each actual log has38 graph envelopes (provenance1/observations36/completion1),
87,692 nodes. Full test copies, stdout/stderr, JSON, parent identity/receipt,
exact runner and strict logs are separate repaired-v2/v3 archives. Both
execution HEADs remain276b10a1 with the separately hashed uncommitted test.
The third test was subsequently committed by Sol as0a9122245c and integrated
by parent asd2741617be; those later commits do not replace execution provenance.

Parent strict deep equality compared ALL36 complete observation graphs and
completion between v2 and v3; every field/reference node matches, no filtering
or normalization. New test SHA/command provenance remains separate. Astra's
full2,227-line source review clears exact third-repair requirements only.

Independent Sol audit compared29 surviving ORIGINAL observations/34 proof
objects, including Runtime16's original failed witness. Binaries, append-kernel
bodies, complete memory/payload/header/heap and host/import evidence match.
Additional construction.canonicalPointer is recipe-checked. Strict decoded
equality to originalJSON is FALSE: three charCodeAt NaNs were JSONnull and four
empty Map/Set collections were JSONarrays per proof. These representation
differences are explicit; no retrospective original reference-identity claim.

`original-codec-projection-audit.mjs.gz` plus JSON/log preserves the parent's
replayable29/29 ORIGINAL-CODEC projection check and its limitations. It explicitly
retains the original codec's NaN/collection-kind losses, not evidence of exact
decoded equality. Only added canonicalPointer is excluded AFTER89 recipe
checks; all negative rejection strings match and are retained. Original seven
missing records are not recovered or credited. Four newly observed source
result/owner/batch/completed-consumer/session/physical-call joins and all eight
same-validator negatives are present; Runtime22 retains33 transitions.

The ordinary changed-root CI invocation does not supply mandatory parent
identity/command/Linear-IR inputs and uses its existing4096MiB worker policy,
versus local1024MiB. Its actual wiring is still A/designated-owner work. No
exemption, missing-input skip, self-approval or shared hook/workflow change was
taken. Configured36/36 is NOT default-CI, protected-queue, performance or full
IR migration acceptance. Source-loop scope and broader contracts remain held.

## Composed canonical main and actual CI failures

`composed-main` artifacts qualify execution HEAD352accfce5618a44edc4e2f659dcb38c4b7a5d93
with main8452732f included, source tree953f74f80cf2f8085b8e1c93489fcdd357929b37
and unchanged c63 test. Configured36/36, zero failures/skips; strict typing0,
zero diagnostics. All36 complete observation graphs and completion strictly
match repaired-v3 without field filtering or normalization. Distinct execution
provenance is retained, not relabeled as the previous epoch. Comparison script
and JSON, full stdout/stderr/reporter JSON, parent input/receipt, runner and
strict output are archived separately. This does not prove default CI or full IR.

`ci-changed-job-113044032212.log.gz` retains the advisory SUCCESS job whose actual
test setup fails and skips all36. `ci-quality-job-113043352038.log.gz` retains
the separately required FAILURE job propagating the same missing parent-input
defect. Both are run37694677932 on published f99, not the local composition.
No shared workflow/hook was changed and no missing-input exemption granted.
