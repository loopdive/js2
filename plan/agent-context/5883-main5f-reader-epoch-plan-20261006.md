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
