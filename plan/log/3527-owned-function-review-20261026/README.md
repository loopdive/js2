# Owned function publication — isolated main-based evidence

Base: eef2ba9c3cef97d383f4f93658291f04fde75a2d. This change adds the explicit
copying API plus four existing main producers: Boolean, string output, BigInt to
Number, Number classifier. Integration-only ToBoolean and other pending changes
are excluded. Full IR migration, native graph adoption and retirement remain open.

## Results

- Unchanged original seven producer suites: 485/485 (baseline.log).
- First candidate: 576/577. One copied fixture referenced an integration-only
  batch API; two existing single-reservation checks replace it, retaining the
  cross-function mutation witness. No batch method is introduced.
- Ledger: 148/149 on candidate and exact-main overlay. The same stale declaration
  hash fails. Carry the provenance-backed FieldDef.optional receipt correction
  from pending PR6925, retaining all old controls and adding exact field-type and
  documentation witnesses. Source declaration itself is unchanged.
- Before byte repair: 726/726 across ten files; independent review nevertheless
  found a hidden byte callback violation. This green result was insufficient.
- Final corrected source: **728/728**, ten files. Configured TS7, lint and all five
  ratchets exit 0. Inventory check exit 0: inventoryValid=true, graphComplete=false.
  Strict graph closure FAIL and retirement NOT CERTIFIED remain visible in gates.
- Three default compiler inputs produce exact identical binary and WAT output
  between exact-main source overlays and candidate. No host lane behavior change
  is intended. These are three controls, not broad backend equivalence.
- Input hashes are post-run snapshots, not pre/post immutability evidence.

## Adversarial review

Fresh read-only review owned_publication_review found one P1: copied byte views
were extensible, allowing non-enumerable length/iterator callbacks. Reviewer ran
actual-emitter witnesses: Wasm result changed 0 to 99, then bytes were restored;
completion audits before and after emission accepted. Hidden iteration also
changed WAT. No additional source/quality or producer-test findings were reported.

Fix: captured own immutable non-enumerable length/iterator and preventExtensions
on private byte copies. Indexed bytes remain mutable and recursively audited.
Legacy fillFunction is unchanged. The two added witnesses fail on the pre-fix
copy module (0/2), pass after correction; full final suite is 728/728. The same
repair in the larger integration worktree passes its focused 31/31 controls.
Independent reviewer follow-up did not complete because the reviewer tool turn
failed; do not describe this repair as independently reverified. Keep hold until
C reviews the published head and an explicit release decision is recorded.

## Reproduction

Node used: /Users/thomas/.nvm/versions/node/v25.9.0/bin/node.
Copy the archived configs to .tmp, then run vitest with --config
.tmp/vitest.owned-review.config.mjs. Final tests use production source directly.
For exact-main comparison, copy base-inputs and legacy-identity.test.ts to .tmp;
the baseline config overlays only the five named source files. To reproduce the
historical ledger failure, restore that test from the recorded base in an isolated
checkout; its repaired pin is intentionally different now. Set
REALM_CLOSE_BASELINE=1 to record the three default-output snapshots, then run the
legacy candidate config without that variable. The archived byte-preimage config
references the original integration preimage path: substitute the archived
owned-function-data.before-byte-fix.ts path and select the two new byte tests
with -t 'blocks hidden byte|keeps byte length'.

No production speedup or full migration completion is claimed by these checks.
