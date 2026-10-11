# IR migration delivery handoff — 2026-09-30

## Direction and coordination

Develop and test the complete IR path to parity before retiring legacy code.
Track work in plan/issues; acquire distinct slice claims using scripts/claim-issue.mjs
against CLAIM_ASSIGN_REMOTE=https://github.com/loopdive/js2.git. The authoritative
registry is issue-assignments. Inspect live owners and full open-PR file lists before
editing. Do not create GitHub issues, steal claims, weaken tests, or bypass hooks.
Only verified main merges count as delivery. Preserve the dirty root worktree.

## Delivered and pending publication

- Primitive wrapper layouts/storage: PR6276, reviewed head
  b7dc57b1fc98321a93c9bfa5febbb08029be781a, merged as
  1c38da1cc82be1917006136903cb8e70edd711ce. Merge ancestry verified against
  upstream eb57f327340aaecb4ffd664417ff15fe4ba13905. Storage is not complete
  canonical realm prototypes, String exotic behavior, or public Number parity.
  Isolated evidence: 633/633 runtime, 349/349 boundary, 864/864 normal commit
  tests and 18/18 push parity; six gates and typecheck passed.
- Root-finality fingerprint: PR6268, merge739a315456651d506622d1719899e4668b47ead0.
  Prior verification recorded actual 102/102 merge-group shards and content on main.
- ToObject: existing PR6273, branch codex/3518-to-object-body-20260928,
  worktree /private/tmp/js2-ir-to-object-body-20260928. Refresh from exact main
  eb57f327340aaecb4ffd664417ff15fe4ba13905 preserves both issue records and
  wrapper + ToObject inventory composition. Production and focused tests are
  byte-identical to published910fa58c572fd8d855383f07f239207e83819b42.
  Historical evidence: 96/96 focused, 349/349 boundary, six gates, typecheck,
  normal hooks. This body uses semantic bindings; native factory completion is
  not certified. Refresh evidence is under .tmp/to-object/wrapup-20260930.
  Verify the exact new head/checks and protected queue; do not open a duplicate PR.

## Preserved Number implementation — not ready to land

Integration worktree: /private/tmp/js2-ir-public-number-712-20260928,
branch codex/3518-public-number-object-get-712-20260928, base
b28388453f0b892c9718d0b4326b32215508c0d0. It contains 65 pending paths,
including already-delivered wrapper files. Do not blindly commit or replay all
paths onto current main. Existing detailed receipts are in .tmp/number-712.
A byte-hashed source archive is in .tmp/wrapup-20260930/pending-work.zip with
manifest.json. Files remain in place; no cleanup or destructive reset was done.

The original public fixture tests/fixtures/issue-3518-native-object-access-712.ts.txt
must retain SHA256 c0550b99175c0eb61afa7d5d110a287f3fe90e9fc8e581c6d58a19fe0a971ba9
and expected712. Historical public result: 4/9 pass, 5/9 fail, no skips.
One legacy host UTF8 result is NaN (also reproduced separately); four IR rows
refuse seven missing physical-materialization resources. Required bindings include
js.number.from-value, js.object.create-default and js.object.define-accessor.
Internal semantic-body execution is not public-path parity.

Effects worktree: /private/tmp/js2-ir-number-method-effects-20260928,
branch codex/3518-number-method-effects-20260928, base
f083fd4a9ad676cf08d69b7693954b1ca93c78e9. This owns only:
- src/ir/program/native-number-method-effects.ts (new)
- src/ir/program/native-number-callable-coverage.ts
- tests/issue-3518-number-method-effects.test.ts (new)
- tests/issue-3518-native-callable-classifier.test.ts

These four files have NOT been integrated. The other paths are borrowed inputs.
Its independent hashed archive is also .tmp/wrapup-20260930/pending-work.zip.
Final authoritative validation3 exited1: TS7 passed; effects28/28 and existing
source39/39 passed; classifier48/58 passed with10 skipped because lifecycle setup
timed out, plus an onTaskUpdate RPC timeout. All2262 pinned inputs unchanged.
Do not describe this as125/125 passing. Earlier failed runs remain preserved.
Read .tmp/number-method-effects/validation3/terminal.json and classifier.log.

Next proposed repair (not performed): split the oversized test lifecycle callback
into predicate fill, each actual non-abrupt source-unit fill with exact census,
and the unchanged missing-abrupt-body assertion. Preserve the actual throwing-body
fill and all10 execution controls. Do not increase timeouts or weaken production
proofs. Run focused controls then full suite/probe, one heavy process at a time.
The prior agent could not resume due to its usage limit; no successor test was started.

## Claims and continuation

Held slices use3518:<slice>-20260928 and distinct ttraenkler/codex-* owners.
Relevant slices: public-number-object-get-712, number-object-source-plans,
well-known-symbol-ir-contract, well-known-symbol-source, number-get-receiver-abi,
number-get-dispatch-grant, number-callable-coverage, number-method-effects,
to-object-body and primitive-wrapper-delivery. Verify the live registry; old local
continuation.json queue/live-process fields are historical, superseded by this record.
Do not release unfinished claims without transferring ownership. Complete delivered
claims only after upstream ancestry and reviewed content verification.

Canonical prototype work was considered, not claimed or implemented. Status2 from
ordinary Get means unresolved intrinsic prototype, not absence. Real canonical
Object.prototype needs completed constructor/member closures, descriptors and shared
realm identity. Legacy Object.prototype.valueOf returning primitives unchanged is a
known compromise, not a valid IR ToObject implementation. No empty companion or
signature-only provider may be marked complete. Strict closure remains open and
legacy retirement is not certified.
