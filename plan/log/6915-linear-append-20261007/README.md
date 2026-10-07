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
