# Frame/delay three-arm comparison review plan

Status: PLAN ONLY. User authorized preparation, not execution or gate changes.
Tracks issue3518, **IR-only default and direct front-end retirement**. Publish
through existing PR5798; retain its hold. This plan does not waive issue5807's
Linux regressions, certify full IR execution, or authorize a merge.

## Claim and non-claims

For each of the two existing historical comparisons, use three distinct roots:
O = unchanged original; R = that original plus an independently reviewed,
hash-pinned minimal repair patch; C = the pinned cumulative candidate.
Require exact equality of R/C fixtures and complete artifact rows. Preserve
O/C differences as historical mismatch evidence, never relabel them preservation.
Only individually attributed deltas may be described as intentional repairs.
Do not normalize indices, WAT, function names, metadata, bytes, or observations.
The failed historical test and OOM logs remain immutable evidence.

The plan can fail. If narrow repairs do not produce exact R/C equality, record
the full mismatch and stop. Do not iteratively copy candidate files or broaden
the repair baseline until it passes. Any additional delta requires a new review.

## Immutable source pins

Source census means SHA256(JSON.stringify(sorted [relative path, file SHA256]
pairs)), using the existing sourceSnapshot implementation in
scripts/lib/promise-repair-source-manifest.mjs. Reject nonregular source entries,
extra/untracked source files, missing files, or changes before/during/after runs.

- Frame O: `0194b64c246d2b5beab2db00af33a73498e2eb6e`, 1306 source files,
  census `5670027d6b5815133f5058ef785a55f7522d82d1058676de532cbe933ab210b0`.
  Protected original: `/private/tmp/js2-3518-frame-baseline-0194-20260908`.
- Delay O: `1cb0f5c7f36be14d7be7eb4592973aea84a8c4e5`, 1311 source files,
  census `d37ac41c596e80e223a7576003cec7c9a9ec0968c8b497da8c35876cdc77562a`.
  Protected original: `/private/tmp/js2-3518-logical-vector-integration-20260908`.
- C for both: `63079597adbfa485a1201de9eecabd9482aac8ce`, 1379 source files,
  census `787d3bdc1ecaa8deb77939c0269ef8c6c380297681a4570595655f73491b6950`;
  Git src tree `360f3b82efb0a1aee71233122f9c8dd92e9331ef`.
- R: two NEW isolated roots, each based on its own O. Never patch either
  protected original, and never use C as R. Realpaths must be pairwise distinct.
  R postimage census and patch hashes must be computed and independently approved
  before any compile. They are not yet known; placeholders cannot authorize a run.

Use a detached copy of the exact C commit for measurement; publication of this
document does not silently advance the candidate pin. Later candidate changes
require explicit manifest renewal, even if only documentary.

## Original instruments and populations

Preserve the original test files and their historical mode. Prefer an additive,
separately reviewed three-arm driver over weakening original baseline admission.
Original SHA256 pins at C:

- tests/issue-3518-async-frame-body-source-preservation.test.ts:
  `985663fc40aded2a6e585e2e8a571b2dd433036b8dee78b2e95d40c0b3faa34b`.
- tests/issue-3518-native-delay-combinator-source-preservation.test.ts:
  `26cf721ece91a9d468a42555eaeac49f5375ded7a9bafec2775cad5efb07749c`.
- tests/helpers/native-delay-combinator-source-receipts.mjs:
  `dcb2101fbfbb4e7a03c38ac0ec097da725d9c9bd254c24541ac07b997a45143f`.
- tests/helpers/native-delay-combinator-b1-inverse.mjs:
  `2db08ac6dfb265df815f57a31f275dac1fa9887a740eb5b5ddd351afee8d575c`.
- tests/helpers/semantic-provider-source-receipts.mjs:
  `83e8424be0406fb84b81e72496b5602362d4ff20687f27f0d234ce180f0f9093`.

Frame: exactly 5 artifacts / 12 executions per arm, in original order:
family, multi-await, try-catch, try-finally, late-import.
Family retains eight scenarios: pending-70, non-i31, sequential,
parallel-reverse, empty, sequential-reject, parallel-reject, undefined.
Nonfamily expected values remain 4142, 42, 99, 130 respectively.

Delay: exactly 11 artifacts / 19 executions per arm, in original order:
family, delay, race-vector, all-settled-vector, any-vector, empty-all-settled,
empty-any, invalid-before-empty, grown-vector, thenable-all, poisoned-then-all.
Retain every existing source extraction, edit, derivation, expected value,
timer/microtask scenario and family scenario; no fixture replacement.

Across all six arms: 48 artifacts / 93 executions. Do not deduplicate the family
row between suites or count saved receipts as newly executed rows.
Pin the complete fixture arrays, including source text and derivation metadata:

- Frame SHA256(JSON.stringify(fixtures)):
  `ada123e98a8e5af9675bac070db2dfd1c1bf106792476264948d0fcb4b4c553f`.
- Delay SHA256(JSON.stringify(fixtures)):
  `e060ddbfe9c704bdcdc8c18798c84bcaf56935555090e9280f051672443d21cd`.

Every arm must independently re-extract these exact fixtures from pinned files.
Do not trust a candidate-generated expected fixture array. Include every fixture
file hash and extracted source hash in the reviewed machine-readable manifest.

## Allowed repair intent, not blanket commit permission

Only these three previously identified deltas are eligible for the proposed R:

1. Promise capture-once semantics from
   `00976e841109235a79991145ee5f0c30933bf3b1`: register a two-result then lookup
   in the same reservation position; capture the first callable then value
   synchronously, retain it in the existing scratch local, and pass it through
   the queued capability. Preserve poisoned-getter rejection and native-Promise
   own-then behavior. Historical roots have older owner layout: transplant into
   those owners, do not import later runtime extraction or prepared resources.
2. StringToNumber terminal malformed-exponent guard from
   `cf0026db2e926bf45c57204f6324fbae5fb168f7`: exact e/E/+/- terminal guard
   returning NaN. No other scanner, decoder, formatter, or parseFloat changes.
3. Vector scratch reload non-null refinement from
   `c5c87e4abdd58539e22c89d96c4259c344461d40`, also carried by
   `1e70f703325e95d410d318cd352f8652b7b05f3d`: exact `ref.as_non_null`
   before fixed-vector construction. No allocation-order or vector-layout edits.

A commit name is provenance, not a patch allowlist. Required review package:
one literal patch per historical root, exact file pre/post hashes, occurrence
counts and function anchors, source dependency justification for every hunk,
complete O/R difference enumeration and R census. Reject any unrelated file,
test, optimizer, export-order, diagnostic, config, or build-system change.
Do not transplant whole commits or copy current compiler modules wholesale.

### Exact historical owner inventory

The accompanying [review manifest](3518-frame-delay-three-arm-review-manifest-2026-09-09.json)
contains literal preimages, unique anchors, function hashes, and proposed
replacement fragments for both roots. It is a review artifact, NOT a runnable
execution manifest. Original artifact SHA256:
`10dcb36ef97aac31ad09654e6a9d1ee58f725e03823e131fa39469364a0332ee`.

Allow exactly four existing source files and zero new source files:

- `src/codegen/parse-number-native.ts`: insert the 29-line guard from donor
  string-number-bodies.ts lines204–232 after the Number-path exponent call at
  historical line928, never the parseFloat call at522. Both original blobs are
  `a9d23c444ef0dabfa5e7ca713bda20e6ba18c594`. In-memory proposed postimage SHA256:
  `7e3e0cc9ef44f0e9bc132103bf9b5cd65254163d85045d667d5904c3d27850f9`.
- `src/ir/backend/wasmgc-emitter.ts`: insert the one refinement between scratch
  local.get and struct.new at179–180 in emitVecNewFixed. Both original blobs are
  `d62446f4e1942b870fac851ffa71b8ee7a6cb438`. In-memory proposed postimage SHA256:
  `caba0379bf1a1515b5d8966d51a90064a572bd4c380370a57a2606eba4245e1b`.
- `src/codegen/async-scheduler.ts`: original frame blob
  `220df65e3a4fa8814aa2269e69a413622c376d1b`; delay blob
  `541d6abf642eab21b16662cb92dd3b7e8a3d450e`. Six anchored fragments add the lookup
  binding, reserve it, return its handle, alias capturedThenLocal=8, replace the
  classifier call/store, and replace only the non-Promise job capsule null.
  Required ordering: classifier, peel, lookup, publication flag, existing job
  prerequisites, job. Preserve every earlier prerequisite and cached binding.
- `src/codegen/closed-method-dispatch.ts`: both original blobs
  `feb6de718276cea09a3189148205e85d4a27b669`. P7 at2080–2208 must retain the old
  classifier and add a dual-result lookup over the same collected inventory.
  Preserve method/accessor/field/open-object order, accessor precedence and
  closure-root ordering. Capture mode adds externref local4 and local.tee before
  conversion; return (1,captured) for callable values, (1,null) for compiled
  methods, and (0,null) otherwise. Fill only the already reserved lookup, keep
  poisoned getter propagation, original guards and peel fill. Never allocate
  from finalization or substitute a different dispatch framework.

P7's literal replacement and Promise postimage hashes are deliberately unresolved:
the plan specifies their review contract but has not implemented them. The two
computed scanner/vector hashes describe in-memory proposals, not tested files.
No repaired census or driver hash exists. A fifth source file, new module,
optimizer change or altered collector/prerequisite requires a revised plan.
These explicit missing execution pins prevent this planning artifact from being
mistaken for approval to run.

## Proposed instrument contract

The additive driver must accept explicit O/R/C roots and an externally supplied
manifest path plus SHA256. No implicit roots, self-approved hashes, broad dirty
allowance, patch application during measurement, or automatic manifest renewal.
An independently reviewed driver diff must pin its own bytes and all imported
helpers before execution. Its only semantic extension is explicit R admission
and three-arm orchestration; compile options, fixtures and oracles are unchanged.

Run six fresh child processes serially under one integration owner. Record exact
Node executable/hash/version, OS/arch, TypeScript/tsx versions and resolved paths,
dependency hashes, compiler flags, environment and memory settings before launch.
Use the same reviewed environment for all arms; reject unexpected compiler flags.
Pin compiler/runtime imports to each arm root; fixture/instrument provenance is
separate and explicit. No pnpm install or mutation of shared dependency caches.

Retain the existing 2048 MiB child heap; explicitly set 2048 MiB for any Vitest
outer worker. This avoids the prior implicit 512 MiB worker, but is not a remedy
for artifact differences. Persist complete arm receipts before comparison and
write a compact mismatch index rather than rendering megabytes through Vitest.
No automatic timeouts/kills, retries, or selection of a passing attempt. OOM,
signal, missing terminal, invalid receipt or incomplete population means INCOMPLETE.

## Verdicts and controls

Keep separate fields: originalEvidencePreserved, originalCandidateExact,
repairedCandidateExact, completePopulation, semanticOracles, sourceAdmission,
and instrumentIntegrity. Overall comparison PASS requires every admission,
population, semantic oracle and R/C exact comparison to pass. An O/C failure
does not become PASS; it is recorded separately with original complete differences.

Compare complete `fixtures` and `rows` structurally, preserving all fields and
array order. This includes complete result/resource metadata, binary/base64,
WAT, outcomes and every observed value; each instantiatedBinary must equal that
arm's actual compiled binary. Root/arm/URL/census envelope fields differ by design
and are independently validated against their exact arm manifests, not erased
from the receipt. Keep late-import exactly equal across all three arms.

Retain all existing historical reconstruction and mutation controls. Add driver
negative controls that must reject: aliased roots, stale HEAD, extra/missing
source, wrong patch hash, an unapproved hunk, fixture source drift, omitted or
duplicate row/scenario, missing terminal, fabricated executed result, altered
binary/WAT/metadata/instantiated bytes, reordered resources, unknown receipt
field loss, and stale driver/helper/environment pins. A zero-test control fails.
These controls supplement, never replace, the 48-artifact/93-execution population.

Previously passing independent Promise repair, scanner and vector controls remain
separate supporting evidence. New frame/delay rows do not establish the entire
repair's semantics; do not infer broad correctness from unchanged observations.
closureCertified, physicalAcceptanceCertified and retirementCertified remain false.

## Original evidence that must survive

Under the integration worktree:

- `.tmp/frame-body-preservation-ObO2Sg/baseline.json` SHA256
  `41578b8c1fc9df2b8b803d5bd6e97d5c71f473dcff6ab89a9679588a2654195a`;
  candidate SHA256 `cf24823ed7f2b2ddc26e111c9088b3cc9f9b09757437cadd162bb538d2b267c4`.
- `.tmp/delay-combinator-preservation-uGms5w/baseline.json` SHA256
  `48afb8db8e7b20bea3b63ecdc837acfe53a7588581eda554dbd5db1a5f521977`;
  candidate SHA256 `b9b71337846e7dc82ecefcbe525a76019dc6763a5486efb2a3acc05eb004d33b`.
- Frame session93831 EXIT1: 20/21 tests; paired comparison failed in four of five
  artifacts. Delay session39853 EXIT1: both child processes exited zero, outer
  worker OOM, all 11 saved artifact rows differ. Never describe it as a completed
  passing comparator or replace the OOM receipt with a later run.
- `.tmp/attribution-9qxM8J/attribution-v2.json` SHA256
  `9593ec6d38588d5c182d36c2f69fc7ac338795418cf57ff3c090041b43bd2f9c`;
  `followup.json` retains export/start and source attribution.
- `.tmp/attribution-wabt-probe-ZwQHhy/probe.json`: installed WABT1.0.39 failed
  the original family artifact with zero instruction-offset lines. No byte-ledger
  acceptance was produced. Preserve this unsuccessful diagnostic too.

## Review and execution boundary

1. Review this comparison design and the exact proposed source patch inventory.
2. Prepare literal R patches and additive driver in isolated implementation scope
   only after approval. Do not alter O or C. Publish patch/driver hashes, all
   pre/post images, dependency census and expected source differences for review.
3. Obtain approval of that complete execution manifest before running any arm.
4. Execute controls and all six arms, retain terminals and immutable evidence;
   fail closed on every mismatch. Report O/C and R/C separately.
5. Only a successful, reviewed result can resolve this preservation blocker.
   Normal PR review, main refresh and real merge-group regression gates remain.

No adapted driver or repaired root exists as a deliverable of this planning
checkpoint. There is no claimed R/C result. The next approval is implementation
of the bounded design, not permission to broaden patches or merge.
