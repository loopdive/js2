# IR native StringCreate handoff — 2026-09-30

Issue: 3518 — IR-only default and direct frontend retirement. This is one
construction prerequisite. The full migration remains open and the legacy
compiler stays operational until all IR behavior is tested and equal.

Branch: codex/3518-string-create-factory-20260930.
Worktree: /private/tmp/js2-ir-string-create-20260930.
Authoritative slice: 3518:string-create-factory-20260930, held by
`ttraenkler/codex-string-create-factory-20260930` on upstream issue-assignments.
Parent PR6343 delivered as 0388aad59f56a1e23ec99457857de0745abcf0c4;
all seven checkpoint file blobs verified identical on upstream main
54a85ebddabf396e9f1da1f6e0c2f68df9d16e72. Its scoped claim is complete.
Latest main was fast-forwarded without changing any of this increment's files.

The pure constructor retains the actual native AnyString payload in the String
subtype, allocates fresh ordinary storage, sets the explicit prototype, and
installs own length with all attributes false. Length uses unsigned UTF16 header
conversion and the authenticated native numeric boxing owner. Capacity must be
at least two, leaving an empty bucket for terminating missing-key lookup.
Explicit null uses the canonical null-prototype flag128; it is an internal
extension beyond StringCreate's spec Object prototype argument.

The backend owner authenticates exact layout, storage, native value plan/scanner,
shared String/Symbol/literals and String virtual own-descriptor dependencies,
rechecks mutable source records/plans, and requires real completed bodies.
Completion scope is `string-create-own-length`. It does not attest canonical
realm identity, installed DefineOwnProperty/OwnPropertyKeys, or public routing.

The fixture derives its numeric plan from a complete synthetic six-owner
prepared program. Canonical codec bytes are stored in the test fixture and
revalidated on decode, including regenerated runtime projections and the full
validator. It is not frontend-produced application evidence. The original
builder loaded src/ts-api.ts: the first fresh-process census refused it before
emission. That failure is retained in worktree receipts. The data fixture removes
that builder from runtime imports without relaxing frontend detection.

Tests cover real UTF8 and WTF16, astral/surrogate/rope/offset carriers, exact
length descriptors and sequencing, prototype and payload identity, fresh object
and table identity (including Wasm ref.eq), ordinary expandos and missing keys at
capacity two, invalid carriers, unsigned arithmetic and authenticated-owner
refusals. Large-header probes measure unsigned conversion only; they do not
claim physical allocation of multi-gigabyte strings.

Pre-refresh validation: 414/414, zero skips (StringCreate90, descriptor146,
wrapper-storage178), TS7 clean. Signed-length mutation fails8/8 selected tests;
implicit-null mutation fails4/4. All6527 source pins restored without drift.
The parent descriptor146 fixtures used WTF16 payloads under both layout
policies; actual UTF8 execution is proved by this constructor suite, not by
extrapolating from that parent denominator.

Fresh-process native fixture census: 145 unique modules, 141 repository source
modules, zero TS/frontend imports; real forbidden frontend control exits2,
blocks one import and emits zero bytes. This is a native resource fixture census,
not public prepared-IR replay coverage.

Next: authenticated String Define/Set/Delete and ordered OwnPropertyKeys,
canonical realm population and complete ToObject factory/provider/public
consumer wiring. Keep base ordinary lookup independent of the exotic owner to
avoid a completion cycle. Never convert unresolved implicit-prototype status2
into absence. The preserved public Number bar remains4/9 with seven physical
provider gaps in /private/tmp/js2-ir-public-number-712-20260928; preserve all
56 pending files, original nine-case fixture and failures. No retirement.

Normal signing/hooks, fork publication, exact-head protected queue and verified
main ancestry/content are still required for this increment. Queued or armed
state does not count as delivery. Detailed local receipts: .tmp/string-create/.


Final current-main validation on54a85ebd: TS7 passes and414/414 tests pass
with zero skips (90 constructor,146 descriptor,178 wrapper storage). Four
actual emitted fixture probes pass. Seven quality gates pass: LOC/functions,
oracle/coercion/tag seams, boundary inventory and moved-export preservation.
Inventory1714 modules is valid with zero errors; architecture remains incomplete.
All6527 source pins are unchanged. Conformance documentation sync reports
zero updates. Independent test262 corpus is clean at pinnedb363f29d,56970 files.


Constructor PR6345 CI setup repair: exact head7c78d759 failed quality in run
36682317965/job109780278178. Four default10s fixture hooks timed out;22 tests
passed,68 skipped, one worker RPC error. Preserve that original log; those rows
are not passing evidence. Disarmed auto-merge and verified no queue entry, then
held the existing PR before edits. The constructor slice claim remains ours.
Only its fixture hook now uses the repository's existing35s test budget and
yields after construction, like the definition fixture. Keep all90 semantic
checks, production providers, normal hooks and protected gates unchanged.
