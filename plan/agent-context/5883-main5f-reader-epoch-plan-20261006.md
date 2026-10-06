# PR5883 main5f historical-reader integration plan

## Demonstrated blocker and frozen evidence

Local HEAD e0068df255d8a77d1bdb641a88ea339c7dc7c6d0 is merging upstream
5f953c8e05919a304d5d3b8e3811e882962a9f33. The old 34 authenticated operands
and dependencies contain exactly seven changed paths:

- operand: src/codegen/builtin-value-read.ts;
- dependencies: src/codegen/carrier-bag-visibility.ts,
  src/codegen/context/create-context.ts, src/codegen/context/types.ts,
  src/codegen/object-runtime.ts, src/codegen/registry/error-types.ts,
  src/ir/types.ts.

Five equal the incoming main bytes; both context files compose main and the
checkpoint. A direct call to authenticateHistoricalPromiseSuccessors on this
tree exited 1 with `historical-promise successor dependency mismatch:
src/codegen/carrier-bag-visibility.ts`. It imported only the reader helper;
no compiler or heavy test suite was executed. Original fixture/helper/test
assertions are untouched. This is an authentication failure, not a measured
runtime regression and not permission to accept altered historical inputs.

## Proposed implementation contract (review before release)

Use a new narrowly scoped authentication layer before the existing historical
reader. Keep the old receipt bytes and its existing hash checks intact. The
new layer must authenticate actual composed-current bytes before reconstructing
the exact old bytes for these seven paths. Each path needs independently
reviewed changed spans, old/new offsets and hashes, all retained regions, and
producing-commit provenance. For context files, provenance must cover both merge
parents and the composed result; do not call the result identical to main.

No production changes, gate changes, relaxed assertions, fixture deletion,
whole-file stored-source substitution, or runtime Git fallback. Unchanged
paths pass through without rewriting. All original reader paths, explicit
source arguments and mutant readers must remain effective; a compatibility
adapter must not silently replace supplied sources. Authenticate the new
receipt itself independently and reject missing/extra/duplicate paths, changed
current content, forged spans, or mismatched retained regions before replay.

Review each of the seven diffs for its semantic scope. Inverse reconstruction
certifies historical source obligations only; it must never certify that
incoming main behavior equals the old behavior. Preserve current main semantics
and the Promise checkpoint production code. Keep failures and denominators.

## Acceptance and dispatch boundaries

Before implementation, parent reviews a seven-path span/provenance inventory
and selects the smallest adapter seam compatible with every existing caller.
Then dispatch Sol-6.1 Medium with an explicit test-only write list. Implementation
is not yet released by this document. No other agent owns the reader edits.

Require positive reconstruction of every original raw operand/dependency;
independent negative controls for current input tampering and receipt tampering;
unchanged original 892 reader assertions/identities plus separately counted new
controls. Re-run current-composition typecheck, original runtime population and
incoming affected tests once the shared heavy-test slot is available. Run
inventory, cycle, size and preservation gates without widening allowances.
Publish only through existing PR5883 and verify protected-queue/main delivery.
Legacy retirement and full IR equivalence remain separate, unproven obligations.

## Integration progress

Both merge conflicts are resolved and staged. The inventory retains all 15
unique move sources/destinations from both parents; issue history retains both
complete conflict blocks. No source conflict was resolved by choosing one side.
The new composition inventory check exits 0 with 1,841 modules,
inventoryValid=true and architectureComplete=false.

Current-composition static checks have fresh retained logs under
`.tmp/5883-main5f-static-20261006/` (session67024). Inventory, cycles, flat, LOC,
function, coercion and oracle exited 0. Dead-export preservation and orphaned
checks subsequently exited 0; session67024 completed successfully. Strict
modeled graph closure still fails at the two dynamic imports, so retirement
remains uncertified. The ES6 census processes69067/69088 were verified live,
so no competing compiler/typecheck suite was started.

Independent queue progress was verified: PR6426 merged at
30cda609f0dd3c60b58c8377e9201b538cef4d54, and PR6501 merged at
61cc250361b7de540f3230e845735094d31d6737. Both commits are ancestors of fetched
main5f; the nested-stackification owner and zero-suspension regression test
are present there. These are delivered prerequisites, not completion of PR5883
or the IR migration. PR6195 remains open with its quality failure; no takeover
or speculative rerun was performed.

## Reviewed implementation release

Sol-6.1 Medium review verifies all 34 old inputs match e0068 and exactly seven
changed inputs reconstruct completely through 30 bounded spans and 37 retained
regions. Twenty-seven unchanged inputs need no new transform. Pure insertions
have zero-length old spans: replay must use authenticated offsets, never search
for an empty string. Parent inspected the three proposed integration functions
and the one incompatible existing control directly.

One plan requirement is amended explicitly: the control titled `keeps three
already-matching dependency sources raw, with no unnecessary inverse` assumes
carrier-bag-visibility is unchanged. Its old hash is
7a0820f193e2ddd2ac32488ebc99aaa7df9b6bf0370c096f36904dfeba3dc201;
current main hash is
a270964931213269b84a0bafcff221bbbe1b7c67863b7b739438355cdfcf2e06.
It cannot remain a true raw-equality assertion on intentional incoming changes.
Preserve the exact original test source as a non-executed historical fixture,
with its e0068 blob/hash and the observed mismatch. Update only this control:
retain both truly unchanged raw cases, and independently authenticate current
carrier bytes plus exact inverse recovery of its old dependency pin. Do not
rebind the raw reader or erase the old requirement/failure. All other existing
test programs/assertions remain unchanged; report this one amended control
separately rather than claiming 892 unchanged assertions.

Release test-only implementation in these exact paths:

- new tests/helpers/historical-promise-main5f-epoch.ts;
- new tests/fixtures/issue-5883-main5f-reader-epoch.json;
- new tests/fixtures/issue-5883-historical-reader-successors-e0068.ts.txt;
- new tests/issue-5883-main5f-reader-epoch.test.ts;
- existing tests/helpers/historical-promise-successors.ts, only integrations
  in authenticateHistoricalPromiseSuccessors, projectHistoricalPromiseSource,
  readHistoricalPromiseSuccessor and necessary imports;
- existing tests/issue-5883-historical-reader-successors.test.ts, only the
  control amendment described above and necessary imports.

The old receipt is immutable. Apply's explicit historical-endpoint contract,
flat-only public export reader, supplied readers and mutation refusals remain
unchanged. New receipt authentication must not recursively invoke the old
authenticator. Bind final actual composed endpoints separately from the two
parent endpoints, and retain producer/merge provenance. No whole source
snapshots in the reconstruction receipt; changed spans and retained hashes only.
The historical test fixture is evidence only, not a source replacement mechanism.

The coding agent may prepare generation scripts in its own .tmp directory but
must not run compiler/tests, stage, commit, push, or edit production/gates.
Parent owns validation and independent review. Incoming runtime coverage must
include object/Reflect6770, classes6772, expressions6774, collection-subclass6754
and Boolean-presentation3525 alongside original Promise/runtime controls.

## Independent data verification during implementation

Parent independently checked new receipt SHA256
0bf75a98f3c01b26359e67895dd32168f8775c5fb53e43beee6ffc932e9616a9:
all seven old/current/incoming endpoints match actual bytes, UTF-16 lengths,
SHA256 and Git blobs; all30 spans and37 retained regions form complete ordered
partitions, recover each old file exactly, and classify incoming equality
correctly. The receipt stayed byte-identical during this check. The preserved
original test is exactly e0068's13581 bytes, SHA256
a2590728bcaccb35821443b5c000d0112faa1448bd4dca2ea1e8bc81af0bbc38.
This is data verification, not acceptance of the still-in-progress helper/tests
or all producer provenance. Revalidate if the receipt changes.

All19 current-main static gate streams are saved in
5883-main5f-static-exact-20261006.json.txt, SHA256
ff49cd5c7d100e28bb4d848e3592c253cc1bfe1af4281d1dfc30bdcd800b97ba.
Every decoded stream was compared byte-for-byte with its raw input.

Parent subsequently verified all18 recorded producer commits against actual
Git parents/subjects and all86 recorded file versions against bytes, UTF-16,
SHA256 and Git-blob pins. Receipt0bf75a98 remains unchanged. This completes the
static recorded-provenance check, not execution or semantic certification.

## Frozen candidate execution

Candidate handoff is `.tmp/5883-main5f-epoch-codex/final-generation-receipt.json`.
Parent smoke session32151 exits0: current authentication succeeds, carrier
reconstructs its historical pin, and tampered actual input is refused. All7346
source/test/config inputs unchanged. New-suite session35994 exits0:276/276
controls pass in one file, all7346 inputs unchanged. Full invocation, raw output,
native report and terminal/pins remain in `.tmp/5883-main5f-new-readers-20261006/`.
These tests read/hash source text; they do not compile source programs or run
Test262. Existing-reader population is now being measured separately; no current
892-row passing claim is made yet. Independent Sol-6.1 Medium review is clear:
all six handoff hashes match, supplied sources/readers and old mutation errors
are preserved, and only the approved control/import changed. New276 controls
comprise132 span mutations,72 retained-region mutations,49 per-path controls,
19 receipt-tampering controls and4 general controls. Receipt mutations test
digest rejection, not downstream structural-validation branches. This review
does not claim execution or runtime acceptance.

## Normal formatter preflight

Scoped Prettier check passes all four TS candidates and rejects only the new
receipt JSON. Existing-reader session71439 is still running, so none of its
inputs were changed. Parent generated a separate formatting candidate at
`.tmp/5883-main5f-formatted-receipt-20261006.json`: 75,614 bytes, SHA256
c33cc1682761adb29ea8f1ca83b6682d265ab3533f6f4383e976734fc3479bcd,
deep JSON-equal to original75,954-byte receipt0bf75a98. Original input remains
unchanged. After that run terminates, retain its original receipt and measured
results, apply normal JSON formatting, update only the new helper authority
literal, and repeat acceptance on the final formatted epoch. No historical
receipt/pin, test assertion, gate, timeout or source delta is authorized here.

Execution-scope correction: the six existing suites in session71439 include
compiler-backed native-delay preservation, unlike the text-only new276 suite.
Observed output records11 artifacts/19 executions on current composition; its
optional historical pair was explicitly NOT RUN. This does not certify physical
acceptance or before/after semantic equality. No further compiler work is being
started alongside that live run. Keep inputs frozen until terminal status.

Session71439 subsequently completed exit0:892/892, zero pending/failed rows,
all7346 inputs unchanged. Suite counts remain31/145/216/24/56/420. Comparing
native result names with the previous accepted892 identifies exactly one
removed/added name: the approved carrier raw-equality control amendment.

Formatting was then released to the coding agent. Parent independently verifies
JSON data equality, only the new helper's authority-literal replacement, and
unchanged remaining preformat archive inputs. Initial inline parent verifier
had a syntax error; the saved corrected verifier exited0. All five scoped TS/JSON
files pass Prettier. Final receipt is c33cc168; final helper SHA256
e2537a95ba627ac9749fe7a5ba74353392b7d7c1514b17ba805869b28c9472b4.
The final text-only population (expected992 from prior measured populations)
is now running separately; the final compiler-backed176, runtime and canonical
checks remain pending. No final-epoch result is inferred from preformat passes.

## Final text-reader result and evidence dispatch

Session74445 completed exit0 on 2026-10-06: all992 controls passed, zero failed
or pending, and all7346 captured inputs remained unchanged. The result belongs
to final formatted receipt c33cc168 and helper e2537a95, not the preformat epoch.
Raw files remain under `.tmp/5883-main5f-final-text-readers-20261006/`.

Parent retains planning, issue updates, integration and serial heavy validation.
Resume the existing Sol-6.1 Medium implementation agent for evidence packaging
only: independently check all six final run streams, preserve them losslessly
in a new exact archive, and verify each decoded byte/hash against its source.
The sole new tracked output allowed is
`plan/agent-context/5883-main5f-final-text-results-exact-20261006.json.txt`;
agent scratch generation code stays in its existing `.tmp` directory. No source,
test, fixture, issue, old archive, commit, push, heavy test or claim changes.
Parent will review the artifact before publication through existing PR5883.

The separate ES6 census was verified live at this dispatch. Final compiler-backed
176 controls, current runtime population, canonical check, hooks and protected
publication remain pending;992 text controls do not replace those obligations.

The final text archive was produced and independently decoded by parent: all
six streams equal their original bytes, lengths and SHA256. Archive SHA256 is
00ae5a461653372d5b376bc3d529e6877f3c81f433bff62786c3add9090f2026.
Save this composition as a local signed checkpoint with normal fast hooks;
this does not waive the pending runtime, pre-push or protected-queue gates.

Actual local checkpoint is 2e313209222b475a9b7718be55f4508f701ed316, with
e0068 and5f953c as parents. Normal formatting/lint and LOC/function hooks passed;
all7346 source/test/config pins remain identical after the hooks. Issue integrity
also exited0. Contrary to the intended signing description above, the commit is
unsigned: this host has no commit.gpgsign, gpg.format or user.signingkey configured,
and the raw commit contains no signature. No signing setting or hook was disabled.
The remembered configured SSH signer belongs to a different Linux container,
not this Mac checkout. Do not claim signing or change shared Git configuration
based on that memory. Correct Thomas author and Codex co-author are present.

Remaining runtime selection retains all22 prior population files and adds the
six incoming coverage files specified above,28 unique files, all present. No
execution result is claimed from checking this selection. The shared ES6 census
processes69067/69088/69157 remain live; heavy validation has not restarted.

## Pending-run instrumentation repair (2026-10-06)

Independent Sol-6.1 Medium review found three gaps in the unexecuted final
sequence: file counts do not authenticate selected identities; per-child
before/after equality permits a different epoch between children; repository
script dependencies and the scratch runners are outside the earlier7346 pins.
No prior result is relabeled or discarded. Native Vitest JSON omits a complete
unhandled-error channel, so full raw-channel review remains mandatory.

Release a bounded Sol-6.1 Medium implementation task for new v2 scratch runners
and their local instrument controls only. Preserve both original runners and
all prior receipts. Authenticate the retained22 runtime path list and prior
assertion identities from their exact archived streams; authenticate the176
compiler-reader identities from their archived preformat result. Require exact
reported file sets, no duplicate file rows, and no lost/changed prior assertion
identities. Any genuine population change stops acceptance for parent review;
do not silently regenerate the expected population. The six incoming suites
have no historical accepted assertion manifest: require exact file identities,
nonempty assertion rows and complete passing execution, and label them fresh.

Freeze the complete current path/hash domain once, extending the unchanged7346
baseline with repository scripts and explicitly authenticated runner bytes.
Compare full maps (including added/deleted paths) and HEAD before and after
every stage against that one epoch. Reject source drift between stages. Record
the extended domain as a new provenance boundary, never imply it was measured
in historical runs. Keep serial execution and preserve each failed attempt.

Instrument controls may use synthetic report/maps in memory, without running
the compiler or Vitest: demonstrate rejection of swapped files, duplicates,
lost assertions, same-count identity changes, pending/failed rows, added paths,
between-stage changes and changed runner bytes. Parent reviews implementation
and controls before releasing heavy execution. No production/test/fixture/gate
changes, existing evidence rewrites, commits or pushes are delegated.

Fresh canonical-main read during implementation found6128dd8244b65028ea89a48eb7259efebd3c8fba,
nine commits ahead of5f953c. Server comparison includes source-provenance PR6520
(merge15d02b05a2ebfd1aecf1da8324e8bd4509a27115), splice U5 and benchmark
updates. Its changes include IR preparation, source contracts, shared inventory
and C1 reader helpers; this is not a documentation-only delta. Local2e313 is
still frozen. Finish reviewing the bounded instrument repair, then explicitly
reconcile the incoming main and establish a successor input manifest before
heavy validation. Do not run the old epoch and label it current-main evidence,
or let a runner automatically accept changed inputs. PR6521 remains a separate
held specialization follow-up; do not interfere with its current owner.

Read-only integration preview against fetched6128dd succeeds without conflicts:
`git merge-tree --write-tree --name-only HEAD upstream/main` returned tree
bdd443e8107b7be8494beb782070265bdf86b44d and exit0. This is not an actual
branch merge. All seven authenticated Promise receipt source paths and all22
retained runtime test files are unchanged in that tree relative to2e313.
Consequently no new Promise historical receipt is currently justified. The
incoming48 source/test files still require explicit successor provenance and
appropriate regression coverage; unchanged fixture bytes do not prove behavior.

Parent reviewed all four v2 scripts and independently reran their45 synthetic
controls: exit0, no compiler/Vitest execution. All seven returned artifacts and
both preserved original runner hashes match the handoff at
`.tmp/5883-handoff-v2-20261006.json`. Future v2 epoch55ee6b95e568c5c803fd5b5c57ae64ac0b00fc7c0108a8d30d194f9971b6e740
authenticates7727 inputs, including371 scripts compared with local HEAD.
It remains an instrument result for2e313, not a compiler acceptance result.
Native raw-channel review, dependency-byte limitations and endpoint-only drift
detection are explicit. Save these parent-owned plan/issue changes with normal
fast hooks, then merge the already previewed6128dd without rewriting this epoch.
Only after reviewing the actual composition may a new explicit manifest be
released. All original v1/v2 instrumentation and archives remain preserved.

## Explicit6128dd successor validation plan

Parent saved docs7ab9fdd4 and clean merge884d2fc58f40a28c391ef5cf238b49582329e55b.
Normal fast hooks passed. Comparing the committed tree with previewbdd443e8
finds only the two parent-owned documentation updates; all source/test/config
bytes equal the reviewed preview. No heavy acceptance result is claimed.

Release Sol-6.1 Medium to create new v3 scratch instrumentation only, preserving
all v1/v2 files and artifacts. Authority is exact HEAD884d2fc5, incoming6128dd,
prior2e313 and merge-preview treebdd443e8. Build a reviewable successor delta
from the authenticated7346 baseline: every changed/added/deleted repository
input must equal the exact committed composition and appear in the delta;
unchanged rows must still equal the archived baseline. Verify the full working
domain against that composition, and retain scripts/runner provenance from v2.
No silent expected-hash refresh or rewriting old epoch/results is permitted.

Preserve compiler176 and runtime22/330 assertion multisets, plus all992 final
text-reader identities decoded from the existing exact archive. Keep the six
already selected incoming runtime suites. Add exactly the23 top-level test
paths changed by2e313..884d2fc5 (the reviewed6128dd incoming source-provenance,
reader and splice-species population); record explicit paths in the new
manifest. These23 and prior six are fresh measurements, not authenticated
historical assertion populations. Each must have nonempty passing assertions;
all selected reported file sets must match exactly. Reject any duplicate or
unexpected cross-stage file. Run canonical, text readers, compiler readers,
runtime28, and incoming23 stages serially after parent releases the shared slot.

Reuse the reviewed v2 rejection logic and add synthetic controls for changed
successor rows, unlisted additions/deletions, and altered incoming selections.
No compiler, Vitest, typecheck, production/test/fixture/gate edits, commit or
push is delegated. Parent reviews the successor delta, script diffs and control
results before execution. Historical failures remain preserved; raw/native
error review and normal pre-push/protected-queue gates remain mandatory.

Parent reviewed the complete v3 library, entrypoint, wrapper delta and synthetic
control delta; independently reproduced all65 controls with exit0. Eight v3
artifacts and ten preserved v1/v2 artifact hashes match the handoff SHA256
a65c39a7bbd85bdac7cbb32b327b90c03cf62e575e57e780591c7f7c5d09d209.
Reviewed epoch SHA25606b0b09fa42d4ef3e1774e00a800dae88ea5c6546d9665b19b44219c3c576589
covers7750 inputs, with an exact48-path source/test delta (34 modified,14 added,
zero deleted) and unchanged371 scripts. The original flat-layout suite occurs
in both the retained text and runtime cohorts; that single explicit repeat is
preserved, not counted as additional distinct coverage. Compiler execution is
still NOT RUN. Release requires verifying the shared slot is actually free.

Before publication, delegate lossless packaging only to the same Sol-6.1 Medium
agent. Sole allowed new tracked output:
`plan/agent-context/5883-validation-instrument-v3-exact-20261006.json.txt`.
Archive each file from both handoffs, both handoffs themselves and the original
runners exactly once, as path/byte-count/SHA256 plus gzip+base64 bytes. Independently
decode and compare every row to its original. Preserve all existing files;
scratch packager code must be new and outside the frozen runner/input list.
No compiler run, source/test change, manifest refresh, commit or push is released.

Packaging completed and parent independently decoded every row:19 unique files,
210881 original bytes, all byte-count/hash/content equal to their originals.
Exact archive SHA256281b3f93dfa11014392d59c3d6186aaae405ef3f46f18be22bc52aa8fa09ff35.
The archive includes both handoffs and both original runners; v3 epoch remains
unchanged. Keep HEAD884d2fc5 frozen until the serial validation sequence ends.
This archive and subsequent documentation updates are outside its declared
source/test/script domain and will be committed with the actual result record.

## V3 execution and preserved reporting failure

After the shared census terminated, parent released the unchanged v3 sequence
at HEAD884d2fc5 and epoch06b0b09f. Canonical typecheck exited0. Text readers
passed992/992 across the exact five files, with preserved assertion identities,
verified endpoint pins and reviewed clean raw output. Compiler readers reported
176/176 passing assertions across two files, but exited1 with one unhandled
`[vitest-worker]: Timeout calling "onTaskUpdate"`. This attempt is FAILED, not
accepted: native passing counts cannot override the raw error and process exit.
Runtime28 and incoming23 were not started. Preserve every original output in
`.tmp/5883-main5f-final-v3-compiler-readers-20261006`.

Parent found no surviving Vitest/typecheck worker after terminal. Release one
same-settings compiler retry through the existing frozen v3 wrapper, using new
output `.tmp/5883-main5f-final-v3-compiler-readers-retry1-20261006` and identical
two-file selection, memory settings, epoch and assertions. Do not increase
timeouts, weaken error acceptance or modify dependencies/source/tests. A clean
retry must independently verify all176 identities and complete raw/native output;
it does not erase or explain away the first failure. Sol6.1 Medium independently
audits the original failure read-only while parent owns execution. If the error
recurs, diagnose it rather than starting repeated blind retries. Only accepted
compiler evidence permits proceeding to the remaining unchanged stages.

Retry1 also exited1:176/176 assertions passed, but the same unhandled
`onTaskUpdate` timeout recurred. No further blind retry is released. Both
attempts remain failed and preserved. Independent review of the first attempt
found the exact145+31 identities, unchanged7750 endpoint pins, successful
preservation child and no additional recorded error; this does not prove the
timeout harmless or attribute it to resource pressure. Parent delegates bounded
read-only diagnosis of the test/child-wait and installed Vitest reporting paths
to the same Sol6.1 Medium agent. A repair must preserve every fixture/assertion,
retain strict unhandled-error rejection and not increase timeout budgets.
Runtime28/incoming23 remain NOT RUN. Implementation requires a concrete causal
finding and explicit successor plan rather than editing the frozen epoch.

## File-local reporting fairness repair plan

Read-only diagnosis found144 synchronous reader controls preceding the async
execution test, consuming74.23s and84.33s in the two attempts. Installed Vitest
uses a60s reporting RPC deadline and IPC acknowledgements; a continuous chain
of already-resolved test promises can starve that IPC. The execution helper
already uses asynchronous spawn/close; changing its wait is not indicated.
This explains a plausible mechanism, not identification of the expired request:
there are no per-RPC timestamps and no proven resource-pressure attribution.

Release Sol6.1 Medium for exactly this test-local repair: import `setImmediate`
from `node:timers/promises` under a clear yield name, import Vitest `afterEach`,
and register a file-local async hook awaiting that immediate between tests.
Use a genuine event-loop turn, not `Promise.resolve()`. Preserve all test
bodies, ordered names, assertions, fixtures, child harness, test timeouts,
Vitest configuration, dependency bytes and strict unhandled-error rejection.
Preserve the original test bytes as a new exact text archive before editing.
No test execution, commit, push or existing epoch/runner edit is delegated.

Parent will inspect the minimal diff and byte-compare all unaffected test text.
This changes a pinned test input, so v3 remains immutable and cannot certify
the successor. Explicitly record the one-file delta and preserved original,
then produce/review a new successor validation authority retaining every
original identity and failed run. Re-run the complete compiler176 cohort with
unchanged settings and review raw/native channels, exit status and exact pins.
If the reporting error recurs, stop and revisit the cause; do not relax gates.
Only clean evidence permits remaining runtime28/incoming23 checks and ordinary
publication gates. This scheduling repair is not IR equivalence evidence.

Parent reviewed the exact patch and independently reversed its two import
changes and hook addition to recover the entire original byte-for-byte.
Original/archive SHA256036534f9d24152746c58f305dee8c3405f05788b4f48a47296b51cbe1d62f3ae;
successor SHA2562ec6925119fcc55004718bd1525af3b1d5d5cdcd3f8642983b3df6294dc85c82.
No test body changed. The original resides at
`plan/agent-context/5883-compiler-reader-before-yield-20261006.ts.txt`.

Release a small new v4 execution wrapper, never edits to v1-v3: authenticate
the unchanged v3 epoch06b0b09f, apply exactly the above one-path replacement
to an explicitly labeled successor expected map, and compare actual complete
maps before/after each child. Require the archived original hash to equal the
old pin, unchanged HEAD884d2fc5/Node/settings, and explicit parent-provided
SHA256 pins for the new wrapper itself and any new helper. Do not recompute
expected hashes from live inputs or present the modified map as original v3.
Reuse the existing strict report validator and v3 stage selections unchanged.
Use new exclusive v4 output directories, preserve raw/native/invocation and
terminal records, reject child errors/signals and any raw unhandled channel
on parent review. Run canonical, compiler176, text992, runtime28, incoming23
serially, stopping at the first failure. Retain original full-population
identities; the ordering change only puts the demonstrated blocker first.
Agent implements scratch wrapper only and does not execute compiler/tests.
Parent reviews the complete small wrapper and then releases execution.

Parent reviewed the complete v4 wrapper (SHA256
9d91e8814035f6a89da9171d78ba72e2aa71cc30dbe9e608fb7d256c0606ca36)
and started session29467. Launch coordination error: the resource probe and
launch were dispatched sequentially in one tool call without a model decision
between them; the probe showed another session's React Vitest job still live
(PIDs60628/60637/60910/61385). Thus the supplied slot flag does NOT prove an
exclusive start. The next authoritative probe found all four PIDs gone. Keep
this disclosure with the run, do not interrupt either job, and do not attribute
any timeout to contention without evidence. Endpoint pin/error checks still
apply; a clean result cannot be described as an exclusively scheduled run.

V4 canonical typing exited0. The complete compiler cohort then exited0 with
176/176 exact identities across two files and all7752 successor pins unchanged.
Parent read the entire compiler raw channel: no unhandled/RPC error. The file-
local yield therefore has a clean observed result where both original attempts
failed, without changing test bodies or deadline settings. This is not a proof
of the particular expired RPC's cause. The same11 artifacts/19 executions are
retained; optional historical pair remains NOT RUN and physical acceptance is
not certified. Text992 is now running; runtime28/incoming23 remain pending.

V4 text readers completed992/992 with clean full raw output. Runtime28 then
exited1:495/505 passed, ten failures all in issue-6794-cli.test.ts. Several
retained errors explicitly show `listen EPERM` at tsx's temporary local IPC
socket; version/help-dependent checks also failed. All7752 pins remained
unchanged. This is a failed runtime attempt, not proof all ten are environmental.
Incoming23 did not start. Preserve its complete native/raw records.

Next action: same full runtime28 cohort under approved unsandboxed execution,
retaining one fork/2048 settings, all original330 identities and six fresh
suites. No source/test/config/dependency change. A fresh continuation wrapper
may copy the reviewed v4 logic with only its SELF path, exclusive new output
prefix and stage order reduced to runtime then incoming23 (already completed
canonical/compiler/text evidence remains separately attributed). Parent pins
and reviews those exact differences before execution. If the permission error
persists, inspect it; do not rewrite fixtures or weaken assertions. Claim an
environmental cause only to the extent the unchanged rerun demonstrates it.

Parent reviewed the continuation's exact changes: SELF path, two-stage selection,
exclusive permission-attempt output prefix, and truthful two-stage completion
message. Final SHA256c166538f19f8e83943386fdf601d293fd3cf59193a53d95b67d78f92f247434f.
After authoritative process probes found prior jobs gone and no replacement
Vitest/typecheck processes, parent launched session17214 with approved elevated
execution for the local CLI IPC socket. Source/test/settings remain unchanged.
Output prefix is `.tmp/5883-main5f-final-v4-permission-`; results remain pending.

Permission continuation runtime completed505/505 across28 files with exit0
and unchanged7752 pins. Parent reviewed native identities and the complete raw
channel, including all30 embedded receipts. Historical runtime failures remain
retained; this successful unchanged rerun supports the local socket-permission
diagnosis. Incoming23 remains live; its progress markers include failures but
are not an attributed native result. Do not change pinned inputs until terminal.

### Completed-attempt preservation implementation plan

Delegate to Sol6.1 Medium, while parent owns the live run and acceptance: create
one lossless tracked archive of the completed v3/v4 attempt records and both v4
wrappers under `plan/agent-context/5883-validation-completed-attempts-20261006.json.txt`.
Include raw logs, native reports, invocation, before/after and terminal records
only for already-terminal attempts; preserve failed attempts as failures. Use
an explicit source-file manifest with byte lengths and SHA256, gzip/base64
payloads, and validate every decoded payload against its source bytes. Exclude
the still-running permission incoming23 directory entirely; do not snapshot a
partial log as terminal evidence. This is preservation, not acceptance proof.
No source/test/config/script changes, tests, git operations or publication are
authorized for this side task. Parent reviews the archive and retains control
of its eventual checkpoint. No new validation authority is implied.

Sol6.1 Medium completed this archive; parent independently decoded all54
sources (17465237 bytes), checked unique/exact directory inventory, every length,
SHA256 and source-byte equality. Archive SHA256:
64972eb0b0b9ca975d4861ababa2386838e6101e85146ff6efc0afdc16aea2d0.
All three failed attempts remain failed. Incoming23 is excluded and still live.
Live PR5883 remains open, ready, DIRTY at published6f73c8ed; no publication or
merge readiness is claimed for the local successor.

### Live queue triage while incoming23 runs (2026-10-06)

Sol6.1 Medium's read-only GitHub inventory found main at
cdc0255882d45181072342d9fd57f291aca93092, newer than the frozen validation base.
Do not merge it into the running worktree or call these results current-main
acceptance. Refresh/integrate only after preserving terminal evidence.
PR6195 (head0f858c60e17bc0718f39e2653a4adb5666143d9e) is a lifecycle
prerequisite before5748, not a solution to its four array-prototype controls.
Its quality failure remains ownedAdapterLines988 over952; repair ownership,
not the limit or accounting boundary. Constructor scaffolding already exists
in the separate constructor lane; reconcile that work before any new dispatch.
PR5748/5753/5784/5883/5911 remain conflicting and held. PR5942 remains an
experimental do-not-merge spike, not a landing candidate. PR6521 is mergeable
but queue-held after null_deref37-to38; attribution and the other owner's
control remain unresolved. PR6468 is a draft atop6341, not an independent base.
Ten inspected PRs had zero unresolved review threads; that does not remove
semantic, conflict or CI blockers. This inventory authorizes no gate waiver,
owner takeover, hold removal or merge. Parent still owns D's live validation.
