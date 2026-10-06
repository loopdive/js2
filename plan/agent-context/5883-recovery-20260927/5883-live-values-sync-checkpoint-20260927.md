# Live values local checkpoint before upstream synchronization

This is an incomplete implementation checkpoint, not acceptance or permission
to land. The old compiler remains required until full IR implementation and
equivalence are demonstrated. No fixtures, expectations, or gates are waived.

Starting head: `608be80f6beef338665fdcdb834e7d9b9f20b925`.
Requested upstream target: `2a58b9fe9f` (npm compatibility artifact refresh).

Completed conflict-free merge: `18f1bd831312b3f5805f1e176388aac449c2d389`.
Upstream ancestry verified; the merge itself changes only six benchmark
artifact files. The local implementation checkpoint is `5bdf4692b2`.

Post-merge exact six-case comparison: baseline 608be80 passes 1/6,
candidate 18f1bd8 passes 4/6 with identical fixture hashes. Full source,
hash, native and compiled values are preserved in
`5883-live-values-main-sync-pair-20260927.json`. Remaining failures are
primitive receiver boxing and the unchanged Node exhaustion assertion
(compiled result 1, native result -2). Neither is waived. Both runs reached
terminal status; no compiler process remains from these two runs.

## Preserved measurements

- First integrated standalone run: 18 cases, 13 pass and 5 fail.
  Substrate: 9/12; reflective values: 4/6.
- Outstanding compiler defects include primitive receiver boxing, shrink/regrow
  stale elements, and custom-prototype indexed reads.
- Two exhaustion diagnostics fail their unchanged Node reference assertions.
  The reflective diagnostic produces native -2 and Wasm 1. Node 22.23.2
  rereads length after exhaustion; the same six reflective source bodies in
  JavaScriptCore yield 6/6 expected results versus Node 5/6.
- Diagnostic logging was moved before the native assertion, not substituted for
  acceptance. Original fixture source and expectations remain unchanged.
- Full local receipts are under `.tmp/5883-live-values-integration-first.log`,
  `.tmp/5883-exhaustion-canary-diagnostic.log`, and
  `.tmp/5883-native-values-pair.jsonl`. These paths are local evidence, not
  published CI results.

## Resume

Run the identical six reflective cases in the immutable
`codex-5883-values-control-20260927` tree at 608be80. Keep compiler tests
serialized. Integrate the separately owned mutation and captured-iterator
repairs only after review and measurement. Do not claim acquisition/drive
integration or full IR equivalence from this live-cursor checkpoint.

## Published prerequisite and current continuation

PR https://github.com/loopdive/js2/pull/6181 is non-draft, based directly on
main 2a58b9fe9f, head bed38fc00a4dc3b3e7298a39c56c18d37cee9f03.
It contains only the seven-file array-length mutation prerequisite, twelve
focused controls, baseline receipts and issue/handoff updates. Protected auto
merge is enabled; it is OPEN, not landed. CI watcher handle 3809 watches its
running checks. The first push was rejected for three missing evidence-log LFS
objects; those exact objects were uploaded and the normal checked retry passed.

The same mutation source is integrated but uncommitted here. Combined run59264
finished: mutation10/10, live substrate10/12. Remaining live failures are custom
prototype lookup and the retained Node hint canary. Prototype storage controls
initially had an invalid result.wasm runner field; corrected result.binary run
25114 is native8/8, compiled0/8 with unchanged fixture bodies. Full corrected
receipts and both implementation plans are adjacent files in this directory.

Huygens now owns the bounded prototype metadata/storage slice in isolated
codex-5883-vector-prototype-storage-20260927 at bed38fc00a. Russell owns protocol
Get plus IterRec storage admission and dynamic-proto receiver propagation.
Turing owns frozen acquisition plus optional captured-source-vector drive.
Curie owns primitive ToObject; Mendel generator repairs; Singer class repairs.
Parent now holds the exclusive compiler slot. Mendel's frozen fifth generator
run75431 finished exit1: original10/12, additive0/6, receiver0/4. Its two
Symbol receiver cases improve over the fourth subject; all22 native controls
pass, six compiled cases stop at host-import guards. No broader success claim.
Singer released all six terminal handles
after typecheck passed, original3/3 passed, and focused36/47 passed (11 failures
retained). Singer continues source-only fixes; other lanes need an explicit
grant before compiler execution.
No old compiler retirement, original fixture change, or conformance waiver.

## Follow-up sync and integration boundary

Fetched upstream main again on 2026-09-27 and verified the remote tip remains
`2a58b9fe9f95dc17bd5d2ba44ecd564b9695356b`. Explicit merge in this owned branch
returned Already up to date; HEAD remains `18f1bd831312b3f5805f1e176388aac449c2d389`.
The dirty shared root checkout was not merged, staged, reset or stashed.

PR6181 remains OPEN. CI run36288166719 completed SUCCESS. Fresh queue state
shows position5, QUEUED, with no unresolved review threads. Do not push a
refresh while queued. PR test262 stubs are not the protected merge-group floor,
and neither PR checks nor queue enrollment prove main delivery.

The ToObject source proposal is integrated locally. Terminal run77445 exited1:
the original six reflective cases now have Wasm actual1 in all six, but only
5/6 native-plus-Wasm assertions pass. The unchanged Node exhaustion canary is
still red. Exact receipt: `5883-runtime-to-object-first-20260927.json`.
Curie's additive primitive/wrapper controls remain unexecuted in Wasm. Native
validation completed 20/20 (including null/undefined rejection), every result1
on Node22.23.2. The fixture and full native receipt are integrated here; fixture
SHA256 is `e73543291685e76f60d99fc14391be787bf23b8eb2ef84da05425566e2acd2f2`.
Receipt: `5883-runtime-to-object-native-20260927.json`. No acceptance
expectation was replaced with the JavaScriptCore comparison.

Huygens froze the three-file vector storage slice at patch SHA256
`3abbb1b5dff4abee7421a1231fbb0964418c78bbabd42fb64711913d81729bd1`.
It is NOT independently runnable: default-prototype and ordinary cycle
providers are required. Huygens now owns that follow-up in the same isolated
tree, including object-runtime-prototype.ts; the parent retains pipeline,
frontend and indexed property integration. Russell retains object-runtime.ts,
instance-props.ts and dynamic-proto.ts, so these owners must not overwrite
one another's shared-runtime changes. Original eight prototype controls remain
native8/8 and compiled0/8 until an integrated run demonstrates otherwise.

## Captured iterator integration, not yet runnable acceptance

Integrated frozen A/B/D sources and their 56/32/28 authored tests into this
working tree, using tracked diffs against each owned lane's unchanged base.
Verified A, all three D files and B's instance/dynamic-prototype extensions
match their handoff hashes exactly. Existing mutation and ToObject changes
were preserved. Added the final receiver-entry hook in BOTH index.ts pipelines
after fillNativeReflectOwnPropertyMop and before late function-reference census.
The frozen legacy promise-combinators.ts remains SHA256
`4c14d929347b28e46cd5b6fe050d14f40baec1313881506db9619fbf59c7aa1a`.

Combined TypeScript check87878 completed exit0; log
`.tmp/5883-captured-integration-typecheck-first.log`. This is not runtime proof.
Parent run33478 finished exit1: original reflective5/6 (Wasm actual1 in all6,
unchanged Node exhaustion assertion red), additive ToObject11/20. Nine additive
failures cover primitive BigInt/wideBigInt/Symbol, String indexing, existing
BigInt/Symbol wrappers, String-wrapper Proxy, array and function receivers.
These are not attributed to one cause or called integration regressions without
a paired control. Full source/hash/outcome receipt is
`5883-to-object-combined-first-20260927.json`; raw log is
`.tmp/5883-to-object-combined-first.log`. Curie resumed source-only diagnosis;
the compiler slot is released with no live parent processes.
Early protocol registration/demand planning remains UNIMPLEMENTED: exact
original-vector admission depends on transactional lowering, while the
prototype-store flag must precede the first object-runtime registration.
A checker-only array guess is not an equivalent admission proof. Turing is
reviewing a shared demand/admission solution; do not silently activate all
standalone modules or claim cross-file override parity without evidence.
Huygens's new prototype-storage/default/cycle work is NOT integrated yet.
These are required integration steps, not waived acceptance cases. Prior
ToObject 5/6 evidence describes the pre-A/B/D state only.

## Exact ToObject baseline pair

Ran the identical additive20 fixture on unchanged compiler608be80 in the
values-control tree; only the untracked test was added. Handle38880 exited1,
18 failures and2 passes. Verified all20 generated source strings and SHA256
values against combined candidate33478. Baseline2/20 -> candidate11/20,
nine gains and zero pass losses. Both native references are20/20.
Full pair: `5883-to-object-baseline-pair-20260927.json`.

All nine remaining candidate failures were already failing cases on baseline;
this is not a waiver or evidence of matching behavior. Existing BigInt/Symbol
wrapper failures move from -1 to -2; String-wrapper Proxy moves from -2 to a
Wasm JS exception. Array receiver throws on both. Primitive BigInt/wide/Symbol
remain -2, String remains -1 and function receiver remains -2. Raw logs retain
the exceptions, while an absent structured actual means no returned value was
logged. Curie has the pair for causal diagnostics. No parent compiler is live.

Activation architecture review found that early helper reservation is NOT
inert: helper-presence gates and prototype seeder registries change emitted
behavior. Hume proposes a fresh-context retry at exact admission instead of
unsafe broad activation, but context isolation and enclosing speculative/
discovery emission are still unproven. Neither retry nor deferred activation
is approved for implementation yet. Hume is auditing those concrete seams.
Turing owns only behavior-preserving pure override-scan extraction and scanner
controls in its existing lane; no production admission widening is authorized.

## Semantic index Get repair and diagnostics

Paired12 supplemental diagnostics completed: baseline20226 exit1, 2/12;
combined candidate14417 exit1, 3/12. Native12/12 on both, source/hash equality
verified. Full receipt: `5883-to-object-diagnostic-pair-20260927.json`.
The Symbol inherited getter works without valueOf; direct Symbol and BigInt
slot/valueOf/Object.is controls fail independently. Direct function/array
Reflect.get controls pass while iterator reads fail. This does not identify
every failure as one defect.

Parent changed only the live iterator's element read to canonical
number_toString(index) followed by __extern_get. The previous storage-index
helper does not cover the full callable/descriptor receiver domain required
by ArrayIterator Get(ToString(index)). Original iterator source hash was
`de04572d428e1e27304e2461d7362117414ce8744f9e22b5705020a343cabda5`.

Run72096 exited1: 31/50 pass. ToObject12/20 (function identity newly passes),
diagnostics4/12 (function iterator newly passes), original reflective5/6 and
live substrate10/12 unchanged. Array iterator still throws despite its direct
property control passing. Do not claim that this fixes arrays, BigInt, String
or all indexed access. Raw receipt: `.tmp/5883-live-semantic-get-first.log`.
Post-change iterator hash:
`d8c0a0ac271039179e5f30460c3d68f2daf5586a4df2a33e5234662fcc878e31`.
Typecheck97704 exited0; `.tmp/5883-live-semantic-get-typecheck.log` is empty.
All parent compiler processes are terminal; slot is free, not auto-granted.
Fresh PR6181 queue position is4, still OPEN/QUEUED, not merged.
Curie owns the separate narrow BigInt wrapper prototype-classification fix in
proto-index-store.ts, source-only; no other shared runtime edits granted there.

## BigInt classification and scanner extraction

Integrated Curie's narrow existing-carrier BigInt wrapper classification arm in
proto-index-store.ts. Run44569 completed exit1: ToObject12/20 unchanged,
diagnostics6/12 (two BigInt getter controls newly pass), total18/32. Direct
BigInt/Symbol valueOf/Object.is controls remain failing; this is not a full
wrapper repair. Log: `.tmp/5883-bigint-proto-first.log`.

Integrated Turing's pure member-override-facts extraction plus compatibility
wrappers and36 controls. Run14199 completed exit0, 36/36. No per-source
observable gate, prototype flag, registration or admission rule was widened.
Log: `.tmp/5883-member-override-facts-first.log`. New helper has only ts-api
dependency; public wrappers retain old syntax, per-SourceFile cache identity
and short-circuit/source lookup behavior.

Read Hume's full retry feasibility audit: immediate retry is NOT selected.
Inner admission can occur in discarded probes/discovery bodies, and fresh
CodegenContext does not isolate reused AST mutations/caches/global telemetry.
No private restart signal, retry wrapper or broad early activation is added.

Read Huygens's full provider blocker: Object.proto stores only Object refs,
so Object->vector proposals lose identity before SameValue/cycle checks.
Vector metadata alone cannot fix that. Hume now plans a lossless single Object
prototype authority and all-reader/writer migration; storagev1 remains frozen,
unintegrated, and no default/cycle success stubs were added. All parent test
handles are terminal; no compiler slot is currently granted to an agent.
