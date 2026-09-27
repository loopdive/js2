# R three-arm first measurements — not full acceptance

2026-09-27, owned tree `/private/tmp/js2-5883-main-6eac-20260927`.
Current source is C, not B. Parent holds the compiler slot.

## Subjects and unchanged observer

A originals saved byte-for-byte under `.tmp/R-three-arm-A/`: drive4533f252,
observablecd9f65ea. B originals saved under `.tmp/R-three-arm-B/`: drive3947caa7,
observabledf689ab4. Full hashes are in the adapter integration checkpoint and
`.tmp/R-three-arm-comparator.mjs`. All arms use constructor99253578 and
adaptera956217f; neither file changed between arms.

C is the source-reviewed explicit B-to-C patch01ab1483: drive
`19e15af978541faf779b4b9b0ce5d45156a00f642fc5b11db0446480d39d5813`,
observable
`d3dcae5d2e13375724ea6053d0c41b5fd0e211d44acf49a8ef08158a8e503e5b`,
new renderer9c6fd9c2. B's six-case test remains unchanged6d4b5ef7.

The original six-route observer was copied verbatim from the published recovery
artifact into `tests/issue-5883-real-drive-observer.test.ts`; its SHA256 remains
`38b6daeb30abf7d2805b0df63903044612c6cd560783dbc6902e588a903d6a1a`.
It retains sources, before/after identity graphs, WAT, binary, imports, native
and compiled outcomes, errors and provenance. No observer normalization.
This manual test requires DRIVE_OBSERVER_OUTPUT: remove it from default test
discovery by a recoverable move after measurements, before publication.

## Results

- A: session86833 exit0, 6/6; report SHA256
  `855e0be4b5cddee2f4435a496ea798c35a77b936a2b1f7a095d83b7b5b66fdda`.
- B: session25469 exit0, 6/6; report SHA256
  `4e21320565181284a713fa6b96365444ff6e03ebc3682f7858c49298aad1dffc`.
- C new tests first: session13574 exit0, 10/10, real all12/race1;
  report SHA256 `eff3213a9288bba7fdf42bf0869f0d7d22f0b1cda636f19b5d763e04313c17eb`.
- C unchanged observer: session53577 exit0, 6/6; report SHA256
  `f3a8b5d7054e228bd89e41091e32292c0927b059cf629ece534c227ba7ccb0c9`.
- A/B exact6/6 including physical identity; comparator report SHA256
  `f61cfce501f5fe9512cee155f4f4705dbe43335d72fe02b2302b4388f3fa2e9d`.
- B/C exact6/6 including physical identity; comparator exit0, report SHA256
  `29fdbd5d86d5cb1429462ea8ce1a588b02cb9a700dcc01cfa9b67a0a5fa5721d`.

Every case produced an observable emission delta, exactly one real drive call,
zero Wasm imports, native/Wasm all12 or race1. Comparisons verify exact drive,
protocol and observer hashes before excluding only the two differing source
provenance fields. Sources/native JS, complete selected entry graphs, WAT/binary
and the remaining receipts compare exactly. Internal loop-only interval remains
UNKNOWN; this is full exported-entry observation, not complete compiler proof.

## Important negative control

A/B showed NO identity difference in these six sources. Therefore they do NOT
exercise the proposed multi-root sharing repair. Preserve the separate first
identity diagnostic failure: expected two split leaf identities, actual zero,
with52920 graph definitions on both sides and no value differences. Its report
is `.tmp/R-three-arm-AB-all-identity.json`. The race diagnostic did not execute
after that first command exited1. No split claim is made for either case.
Curie is preparing an additive real multi-root positive control; original six
sources and observer stay unchanged. Six structural fake-provider controls are
not a substitute for this real producer positive control. Repair acceptance
remains qualified despite exactEqualityPassed=true.

## Typecheck and gate chronology

Size gate session6889 exit0, no new allowances. Source plus seven scoped test
files TS7 first failed session18898 exit1 only on the new test's unsupported
optimize0 type and Uint8Array<ArrayBufferLike> DOM BufferSource type. The first
diagnostic log remains SHA256
`5a11e0dbd7230acc4ad3c8dec9ef597ad43a44d4cae5d0512258a9ff86f945b1`.
Parent changed ONLY the new ten-case test to supported optimize:false (same
compiler falsy branch) and new Uint8Array(result.binary) to copy the same bytes
into an ArrayBuffer-backed view. Original observer/fixtures and production
source are unchanged. Current new-test SHA256
`9adf9cfed72be601c914c3f1240c99660959d58cdd2ba39b9bf269aaecbb7981`.
After-typecheck session47682 exit0, empty successful log.

Registered the renderer as explicitly unmigrated mixed physical-data debt in
the inventory; no graph-completeness/provider-readiness claim or waiver.

## Active next measurement

Parent session37283 runs the corrected ten new tests plus the unchanged original
136 across iterator-protocol-get, promise-vector-acquisition,
promise-vector-iterator and runtime-to-object. Output:
`.tmp/R-C-runtime136-plus10-first.{json,log}`. Re-poll that handle; do not restart
on observation timeout. Expected floor146 rows, of which original136 must be
paired by exact names/status/error arrays. Earlier original report has113pass,
23fail; retain all failures and null-message limitations. This command has NOT
been claimed complete in this checkpoint.

After C terminates, a fresh B runtime arm may require temporarily restoring the
two exact saved B files while preserving C snapshots. Do not run or edit a test
subject during a live process. Confirm the constructor/adapter basis and all
original fixtures unchanged. Pending: real multi-root control, constructor
correspondence on the whole renderer, full runtime pairing, remaining gates,
and publication through held PR5883. No canonical P activation or retirement.
