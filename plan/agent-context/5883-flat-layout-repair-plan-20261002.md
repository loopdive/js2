# PR5883 flat-directory repair

Parent plan for Sol-6.1 Medium D, same isolated owned worktree. Published head
5b954c36e6c68ee5178a1d71780e8a836ce96746. Quality36988376465 job110778543146
passes import-cycle then rejects codegen832>829. Parent reproduced the exact
unchanged gate. Do not change any gate, baseline or allowed edge to admit growth.

## Move exactly three new owners

- src/codegen/promise-combinator-observable-protocol.ts ->
  src/codegen/promises/promise-combinator-observable-protocol.ts
- src/codegen/promise-observable-combinators.ts ->
  src/codegen/promises/promise-observable-combinators.ts
- src/codegen/vec-pop-body.ts -> src/codegen/vectors/vec-pop-body.ts

Use apply_patch moves, no compatibility files at the old paths. Change only
relative module specifiers; preserve bodies, public names/signatures, callback
laziness, type-only boundaries and direct sibling protocol import. Update five
production consumers: promise-combinator-drive, call-namespace-static, context
types/creation and vec-access-exports. Update only import paths in the four
existing protocol/service/cache/pop tests; retain104 identities/programs/options.

Inventory: replace exactly the three files[].path values and add three unique
old->new moves. Preserve classifications, owners, boundary text, floors and
activation history. This is organization of existing unmigrated code, not a
migration-state promotion. Parent transfers the existing issue5197 LOC grant
to the new observable-combinators path, with no extra grant or widened policy.

## Exact preservation and the indirect source reader

Add a new receipt/helper/test for this relocation only, authenticated to the
published5b954 source bytes. Four records: the three moved full modules and
the changed promise-combinator-drive import. Record full before/after SHA256
and Git blob identities, exact paths, ordered unique changed spans with offsets
and per-span hashes. Inverse/replay must reconstruct every original byte, not
substitute a whole historical file. Use enough retained context for unique spans;
reject duplicate/missing/changed/reordered spans, retained-byte edits, wrong
direction, changed receipts and unknown transform paths. Pin raw dependencies
through the injected raw reader; no runtime Git, fallback or disk bypass.

promise-earlier-main-port pins the drive module. Introduce the authenticated
pre-relocation view at readPromiseExportSource's default raw-read boundary for
that single path only. Never normalize explicit strings or callbacks inside an
authenticator. New helper must be independent of old reader imports to avoid
cycles. Other paths retain exact existing raw reading. Authenticate current moved
module bytes as dependencies before accepting the drive import inverse; reject
missing/changed moved owners with positive-first controls. Original receipts and
their declared authority remain byte-identical. Do not repin them.

Parent pre-move run88642/child26359 is terminal1:85/176passed,91failed across
four original earlier/export/layout/native-delay suites, unchanged inputs. Their
existing source-authentication failures are retained, not called runtime bugs or
waived. Post-move compare every original test name/outcome and exact first error,
alongside new receipt controls; this slice must add no new failures. Do not
expand into those older preservation repairs without another parent plan.

## Validation and dispatch boundary

Parent owns all execution/format/staging/commit/push. D may edit only moved files,
their listed consumers, four import-only tests, inventory, new receipt/helper/
controls and the one default reader seam. Parent owns issue grant/plan/docs.
No historical archive edits. Return exact path/hash diff and test populations.

Acceptance: flat829, unchanged SCC697 and directory-edge metrics (modulo exact
path rename), complete1785-module inventory preserving20layer policy, canonical,
104existing tests plus new controls, original176-row outcome parity, LOC/function
gates and normal hooks. Recheck inventory denominator from current files rather
than assuming the declared count. Full legacy/IR equivalence remains separate.

## Additional demonstrated evidence-path blocker

Published-head preflight reproduced check:tracked-ignored rejecting the saved
5883-observable-vector-review-20260915.jsonl under the existing *.jsonl rule.
Rename that evidence file to .jsonl.txt without changing any byte: 9516 bytes,
SHA-256 d9d792883c09853383845195ca9868ed97e506c6526b2434384c49a7f2d5f806.
Update its human-facing pointer; preserve historical patch archives and recorded
old paths. No ignore-rule exception, deletion of observations or outcome changes.
Verify exact bytes and the tracked-ignored gate after staging the explicit rename.

The published-head downstream preflight changed no existing pinned input:
1396 additions are generated dogfood package/report artifacts in the isolated
snapshot only. Five checks stopped on tsx IPC EPERM and are being rerun with
the required execution permission; original failures remain recorded.
