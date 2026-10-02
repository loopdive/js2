# Native String own-descriptor handoff — 2026-09-30

Parent issue: 3518, “IR-only default and direct front-end retirement”.
The full migration remains open. Keep legacy execution until the complete
IR path is tested and equal; do not infer retirement from this component.

## Owned checkpoint

Worktree: `/private/tmp/js2-ir-string-exotic-20260930`.
Branch: `codex/3518-string-exotic-descriptors-20260930`.
Verified base: `28abc9a09761a00e11d2ecf5b15ba9b95b9cb5ba`.
Claim: `3518:string-exotic-own-descriptors-20260930`, held on upstream
issue-assignments by `ttraenkler/codex-string-exotic-own-descriptors-20260930`.
Commit/push/PR/queue results must be read from the publication receipts; this
handoff is written before those actions and does not claim a main delivery.

The pure recipes parse native canonical decimal indices through 2^32-2,
produce a descriptor for one UTF16 code unit from the immutable String
wrapper payload, and perform ordinary-first own lookup. The authenticated
backend owner grants only `string-exotic-own-descriptors`. It validates
exact wrapper, String/Symbol, flatten and ordinary lookup owners, issued
function identities, recipe data, phase and actual completed bodies.

Fixtures execute emitted native Wasm for UTF8/UTF16, shifted coordinates,
slices/ropes/surrogates, ordinary properties, and prototype cursor traversal.
Their wrapper prototype is explicitly supplied, not the canonical realm
String.prototype. The traversal fixture joins the production lookup body;
it does not authenticate public consumer completion.

## Evidence and preserved failures

- String suite: 146/146, no skips. Storage comparison: 178/178 in a separate
  run. Ordinary access comparison: 35/35 in a separate run.
- Signed-i32 maximum mutation: 8 selected tests fail; 138 rows filtered by
  selection. Original pure body restored and source pins unchanged.
- TS7 and LOC/function/oracle/coercion/tag/dead-export gates pass. Inventory
  is valid, zero errors, architectureIncomplete.
- Hardened fresh-process fixture census: 45 repository source modules,
  zero TypeScript library/frontend imports. Real forbidden frontend import
  exits2 with one blocked import and zero emission. Scope is the native
  recipe fixture, not public prepared-program replay.
- Loader internals depend on the tsx cache: cold81 versus warm48 total
  resolved modules, with exactly the same repository source closure. The
  failed original count-floor run is preserved; the corrected floor uses
  the repository closure and requires the new owner/body modules.
- The original unregistered-export setup failure and invalid inventory
  classification remain in `.tmp/string-exotic/validation2` and validation4.
  Corrected fixtures use reservation-ledger exports and the native-runtime
  layer; gates and original semantic fixtures were not weakened.
- Logs/receipts: `.tmp/string-exotic/{validation3,validation4,validation5,
  index-mutation,census,census2,census3,publication}` in the isolated worktree.

## Next implementation joins

1. StringCreate must use the real native payload length and create its own
   nonwritable, nonenumerable, nonconfigurable length property. Authenticate
   the actual realm String.prototype, including its own empty String payload.
2. Extend descriptor dependencies with an authenticated String own-lookup
   selection and exact dependency record. Require the same ordinary lookup
   pack as storage. Use shared findOwn for descriptor semantics, raw findOwn
   for storage growth/insertion and virtual-versus-table distinction.
3. Compatible virtual data/attribute definitions must preserve descriptor
   omissions and SameValue and return after preflight, before detached entry
   writes. Incompatible attributes/accessors reject before any mutation.
4. Extract authenticated Delete and receiver-threaded Set bodies. Virtual
   indices refuse deletion/writes; setters receive the original receiver and
   propagate exceptions. Extensibility is checked before new table entries.
5. Implement full OwnPropertyKeys ordering: virtual indices, remaining
   array indices ascending, other strings chronological, then symbols.
   Do not copy the legacy signed-i32 cap or append-length ordering defect.
6. Complete realm/provider/physical/public prepared-program joins and fresh
   frontend-free codec replay. Keep the original public Number nine fixtures
   and failure denominators; no status2-to-absence shortcut.

Do not make base lookup depend on String own lookup: completion already
requires base lookup. A separate traversal owner avoids the dependency cycle.
Controls must inspect table identity/count/tombstones/nextSeq after virtual
operations and cover nonextensible wrappers, explicit undefined, independent
SameValue character carriers, surrogate halves, inherited indices, distinct
receivers and setter exceptions.

## Other preserved migration work

Host UTF8 key repair PR6342 is delivered by main merge
`28abc9a09761a00e11d2ecf5b15ba9b95b9cb5ba`; ancestry and all16 blobs verified.
The Number integration's56 pending paths remain in
`/private/tmp/js2-ir-public-number-712-20260928`, original nine-case fixture
unchanged, last measured4/9 with five failures. Do not copy unrelated borrowed
work or retire legacy code. Wrapper storage PR6276 and ToObject body PR6273
are delivered prerequisites, not full Object realm or Number completion.

Reverify upstream main, authoritative claims and every page of all open PR
file lists before editing or publishing. Preserve the dirty canonical root.
Only verified main ancestry and content count as delivery.


Final validation on base28abc9a: 359/359 across the three named suites, zero
skips, TS7 and all seven gates pass, source pins unchanged. Receipt:
`.tmp/string-exotic/validation6/terminal.json`. Normal commit and push hooks
remain mandatory; exact publication state belongs in publication receipts.


Publication base refresh: main advanced to
88c33c80a89a2f722ada8882f69ae947d30d7180 with baseline/documentation promotion
artifacts only, no src/tests changes. Fast-forward preserved all seven pending
file hashes; the measured validation source graph remains identical.
