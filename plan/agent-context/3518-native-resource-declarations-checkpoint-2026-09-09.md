# Shared native-resource declarations checkpoint

Base: ea0f05c36267939d5731e3d5e927ada071ae1780, PR #5782.
Worktree: /private/tmp/js2-3518-native-resource-declarations-checkpoint-20260909.
Claim: 3518:native-resource-declarations-checkpoint, verified upstream for
ttraenkler/codex-native-resource-declarations-checkpoint (session 20907 exit 0).

The nine frozen producer files are copied from the materialization worker, not
from its incomplete aggregate draft. Each copy was checked against the worker's
final SHA-256 before applying it. All four producers now consume the same pure
symbolic recipes used to describe resources before allocation. Existing shared
string constructors preserve physical shapes, and the declaration interpreter
preserves reservation/interner order and existing ledger authority. Descriptor
comparison is descriptive; it does not mint an ownership receipt.

High found two repairs: sparse arrays bypassed preflight, and the function
comparison positive supplied the whole FuncTypeDef rather than its actual
params/results. Dense own-slot checks and four pristine-twin negative controls
were added; both observation sites now read the actual flattened signature.
High approved both repairs at helper SHA-256
e86a07d636cafc169eae6f891243d940b6f4b868b9b6841e6aed66860de26350 and test
40053dbd4358fb80c65c2d3a29f7fa16eac64a0a7dbc6c5bce65e65c41c729d8.

Retained worker evidence: 34806 failed 15/16, 73656 passed 16/16, 24613 passed
20/20. Broader 21008 failed 270/302 because 32 scanner cases stopped at the
new imports absent from the pinned census. Unfiltered TS7 75375 failed with
eight diagnostics in frozen aggregate files with missing dependencies; it was
not a passing typecheck. Those aggregate files are not in this checkpoint.

Parent registration adds mandatory native-runtime declaration types and the
backend declaration interpreter, with two new activation records and all old
history/allowed edges preserved. The measured bounded census is 96 modules,
353 imports: 228 type-only and 125 runtime. Initial targeted 29875 exposed the
old edge expectation; no unresolved or forbidden edge was reported. Exact
counts are now pinned. Extra controls enforce that the type contract remains
erased and imports only the canonical model, stricter than the general layer.

Scanner evidence now includes both new dependencies. The erased declaration
types are hashed without pretending they are runtime loads; every original
runtime root plus the actual interpreter must still load under the source-free
guard. Parent session 98832 passes 140/140 scanner and declaration tests.
The final full boundary suite, clean-tree TS7 and complete caller rerun remain
pending; no composed-checkpoint readiness claim is made yet.

Subsequent parent session 54286 passed the full 250/250 boundary controls and
then the full, unfiltered TS7 check on this clean producer tree; the combined
command exited 0. The complete eight-suite producer/caller rerun was next.

Final caller session 46568 exited 0 with 322/322 across all eight selected
producer/caller suites in 57.48 seconds. Combined with 250/250 boundary
controls and clean unfiltered TS7, this closes the checkpoint validation items
above. The source hashes remain the frozen reviewed nine-file revision.

Consumer integration is separate: #5786 supplies the demand census and #5787
supplies opt-in source lowering. The parent/worker consumer draft still needs
complete ABI integration, actual consumer execution and negative controls.
Public direct-codegen cutover, all native families, strict graph closure and
direct retirement remain open. This resource checkpoint does not close #3518.
