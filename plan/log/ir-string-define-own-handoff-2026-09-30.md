# IR native String DefineOwnProperty handoff — 2026-09-30

Issue: 3518 — IR-only default and direct frontend retirement. This increment
implements String property-definition compatibility. Full IR migration remains
open; retain the legacy compiler until all IR behavior is tested and equal.

Branch: codex/3518-string-define-own-20260930.
Worktree: /private/tmp/js2-ir-string-define-own-20260930.
Authoritative claim: 3518:string-define-own-20260930, held by
`ttraenkler/codex-string-define-own-20260930` on upstream issue-assignments.
Dependency: constructor checkpoint7c78d759, ready parent PR6345. Do not edit
that armed branch. Last publication-base audit: main54a85ebd,13 open PRs,
792 file rows; only owned parent fixture overlap, no competing definition owner.
Registry read verified771 active claims and the exact held slice.

String definition checks its virtual descriptor first, unlike ordinary-first
String GetOwnProperty. The existing generic descriptor owner optionally consumes
an authenticated String owner joined to the same ordinary layout/lookup/String
resources. It reuses canonical attributes and SameValue preflight, then returns
without table growth, insertion, sequencing or detached-entry writes. Virtual
accessor conversion throws through the genuine native TypeError/exception owner.
Ordinary-only behavior and the existing five-function/three-void-binding ABI
remain unchanged. Ordinary owners cannot claim String definition completion;
selected owners revalidate issued dependencies and completed bodies.

The canonical codec fixture is actual prepareWholeIrProgram output for:
`export function run() {const object = {get value() {return 7;}, set value(value: number) {}}; return object.value;}`.
Source SHA256:f629eed5050ed2cbfd63fd6704956edfdac31541c3e992dd2ced616c202890cf.
Codec SHA256:747653f268bcda6643587da70492d299e213e80f75613d6f62cfb470e0fcfc2b;
30346 bytes, one terminal unit. Decode regenerates projections and performs full
validation. This is real source-produced program data plus native resource
execution, not complete public prepared-IR emission or realm/provider coverage.

Strict current-root cohort:962/962, zero skips/errors: new definitions473,
unchanged ordinary descriptors75, constructor90, String own descriptors146,
wrapper storage178. Four layouts exercise actual UTF8 and WTF16 payloads and
shifted physical indices. The matrix covers descriptor field presence, SameValue
characters, surrogate halves, nonextensibility, immutable length, ordinary
expandos/accessors, raw-storage shadowing and genuine native boundary errors.
Source-only TS7 passes. All6975 source/test file pins were unchanged.

Preserved first probe failure: helper used a signature row instead of its issued
.binding; fixed before emission. Preserved first cohort failure: default10s hook
limit rejected roughly22s fixture construction and skipped464 cases. Only the
new fixture hook now uses the existing repository35s test budget and yields
between layouts; no existing timeout or expectation changed.

Negative control disables both virtual lookup and the compatible early return:
8/8 selected semantic tests fail (nonextensible compatibility and virtual-first
raw-storage shadowing), with no hook timeout or unhandled worker error. Source
restored; all6975 pins match. Other465 rows were intentionally excluded by the
name filter. The first receipt script mistook Vitest's `skipped` status for a
selected row; actual eight failure records were reconciled without rerunning or
changing tests, and both receipts remain preserved.

Next: String Set/Delete/ordered OwnPropertyKeys, canonical realm population,
full ToObject and exact native Object/provider/public consumer joins. The
preserved public Number bar remains4/9 with seven physical provider gaps in
/private/tmp/js2-ir-public-number-712-20260928; preserve all56 pending files,
original fixtures/failures and held claims. Never treat implicit-prototype status2
as absence or retire the old path from these prerequisite results.

Normal signing/hooks, fork publication and dependency-first protected queue
remain required. Only verified main ancestry and file content count as delivery.
Detailed local evidence: .tmp/string-define/.


Fresh-process native fixture census:168 unique modules,163 repository source
modules, zero TS/frontend; actual forbidden frontend probe exits2, blocks one
resolution and emits zero bytes. Both actual UTF8 and WTF16 execution pass.
Pinned test262 checkout is independent and clean atb363f29d,56970 tracked files.
Fresh upstream main54a85ebd is already an ancestor of the dependency checkpoint.


Seven quality gates pass: LOC/function budgets, oracle/coercion/tag seams,
boundary inventory and moved-export preservation. The first inventory run
refused two new rows missing required classification state; metadata corrected,
failure preserved and all seven rerun. Inventory is valid with zero errors;
architecture remains incomplete. All6531 TypeScript source/test pins unchanged.


Dependency refresh: parent quality failed on its own default10s fixture hooks,
not production semantics. Parent was held/disarmed with no queue entry, then
repaired as signed52b389d1656b1a5a26e571f9d6242e6adf490db6; normal hooks
pass90/90. This unpublished definition branch fast-forwarded to that repair;
all13 other pending file hashes match and both issue append records are retained.
The first definition commit attempt passed all normal hooks (90+473) but could
not sign because the configured SSH agent socket was omitted from the command.
No commit object was written; staged work retained and the socket is restored.
Only verified upstream main merges count as delivery. Hold this dependent PR
until constructor PR6345 is actually merged and its ancestry/content verified.


Definition delivery repair (2026-09-30): constructor PR6345 is verified on
main as5b2210af; its nine checkpoint blobs match mainfe8fecd4. Refresh held,
unqueued PR6346 against that exact main. Preserve quality job109795406561:
8/473 passed,1 failed,464 skipped plus one worker error; four complete-runtime
hooks and one authentication test exceeded35s. Split fresh native fixture
reservation/fill/emit setup into individually bounded35s phases, following
the existing native Object Get test pattern. Retain each real owner check,
all473 tests, original failures, and unchanged production semantics. Require
strict zero-skip validation and normal signed hooks before existing-PR push.


Refreshed definition evidence:962/962 strict assertions pass across five files,
zero skips/failures, strict Vitest exit0, all6975 source/test pins unchanged.
The receipt wrapper subsequently asserted against a field absent from Vitest3;
preserve its failure and reconcile all962 actual assertion records and five
passed suite records directly, without rerunning or changing tests. Twenty
real runtime setup phases were measured on the WTF16/unshifted fixture; slowest
7.430s locally. Every phase keeps35s; other layouts are measured by the full
cohort, not extrapolated from that profile. Seven preservation quality gates
pass; inventory valid, architecture incomplete, retirement not certified.
Fresh process repeats168 modules/163src, zero TS/frontend; real forbidden
import exits2, blocks one resolution, emits zero bytes. Both UTF8/WTF16 rows
and byte lengths match the prior census exactly (not a byte-identity claim).
Constructor delivery independently verified: merge5b2210af,102 successful
conformance shard jobs, successful regression/CI/differential gates.
Fresh audit:16 open PRs/827 file rows, only owned6346 overlaps these test files.
Normal full signed commit/push hooks and exact-head protected admission remain
required; do not call the definition slice delivered or complete its claim
until its real main ancestry and content are verified. Downstream key-list
work and the public Number4/9 root remain preserved; legacy stays operational.
