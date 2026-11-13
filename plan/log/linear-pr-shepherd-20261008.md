# Session B Linear PR shepherd handoff — 2026-10-08

## Scope and result

Read-only queue triage, not implementation or IR migration completion. Checkout
`/private/tmp/js2-linear-pr-shepherd-20261008`, branch
`codex/6915-linear-pr-shepherd-20261008`, local HEAD/canonical main
`8452732f0b88c14c5c7634ece58f83240970ea4c`. Only this handoff and generated
worktree-local `.tmp/linear-pr-shepherd-20261008/` evidence were written.
No author branch, production/test/registry/hook/workflow, commit, push, GitHub
comment, review resolution, hold, merge queue or auto-merge was changed.
No local tests, build or typechecking were run.

Fresh claim effect-read at ledger
`7c09197b155d47ed34f9036934c701d48a46f353`: exact file
`6915-linear-pr-shepherd-20261008.json`, owner/requested_by
`ttraenkler/codex-linear-b-pr-shepherd-sol61-20261008`, status in-progress,
write_id `31946-4po3larl`, branch as above, updated `2026-10-08T07:54:55Z`.
Ledger in-progress entries are reservations, not evidence of live processes.

Read checkout AGENTS.md, canonical `.claude/memory/MEMORY.md`, relevant claim,
partition, author-handoff, testing, retained-data and CI-stub/fail-fast memories,
the complete parent issue6915 plan including shepherd amendment, and the complete
autopilot skill. Applied conflict → unresolved review → actual CI log priority,
with the user's narrower write/mutation restrictions taking precedence.

**No independently fixable B-owned blocker demonstrated.** Five current failed
quality jobs require A's compiler inventory ownership; append CI has a verified
trusted-parent wiring dependency from its prior head. Do not reimplement any
existing issue or dispatch source repairs merely because these PRs are held.

## Fresh inventory and ancestry

Final eight-PR snapshot completed `2026-10-08T08:01:02Z`; server canonical main
still `8452732f0b88c14c5c7634ece58f83240970ea4c`. Follow-up refreshed only moving
PR6593 ancestry/reviews. All eight are OPEN, non-draft at initial read, hold
labeled and GitHub MERGEABLE. Zero reported merge conflicts. All eight have
**0 total review threads / 0 unresolved threads**, pagination hasNextPage=false;
thread heads matched inventoried heads (6593 separately refreshed).

GitHub's reported baseRefOid is recorded separately from server-side compare
merge-base. In particular, PR6570/6572/6575 reported bases differ from their
actual canonical-main merge bases. CLEAN does not establish current-main ancestry.
Compare counts below are canonical-main...actual-head, ahead/behind respectively.

- [PR6563 — repeat copy kernel](https://github.com/loopdive/js2/pull/6563):
  head `704493e668809f1d96d5d5ff282938973042618a`; reported base and verified
  merge-base `a5c5689f9c85090d44f940204ae3c65605f01ce5`; diverged **10/86**,
  main845 not ancestor; MERGEABLE/CLEAN. Checks **39 success,19 skipped**.
- [PR6570 — f32 store prerequisite plan](https://github.com/loopdive/js2/pull/6570):
  head `b8f534f40eb68b5fc7f7a0431a97a45e9bf3e051`; reported base
  `1ee04b0e3785b46ab281e5c76f4b93d6b79355ed`, verified merge-base
  `c0a314636dfcaa437df1468f922bf0d6b0c5bcae`; diverged **2/93**, main845 not
  ancestor; MERGEABLE/CLEAN. Checks **8 success,13 skipped**. One plan file only.
- [PR6572 — array allocation guards](https://github.com/loopdive/js2/pull/6572):
  head `63ad33f865b0d9c2204d2cd7254e3d61210beb8a`; reported base
  `a5c5689f9c85090d44f940204ae3c65605f01ce5`, verified merge-base
  `c0a314636dfcaa437df1468f922bf0d6b0c5bcae`; diverged **5/93**, main845 not
  ancestor; MERGEABLE/BEHIND. Checks **37 success,18 skipped,1 failure**.
- [PR6575 — slice bound normalization](https://github.com/loopdive/js2/pull/6575):
  head `2ca9e12af199c1d0c4b4fe446e8c99149b2b83af`; reported base
  `26091eabd4561e5be154741e7e18143070d3ce59`, verified merge-base
  `8f3b70b37a37d5f475f759d155391621d79ffc92`; diverged **6/79**, main845 not
  ancestor; MERGEABLE/BEHIND. Checks **37 success,19 skipped,1 failure**.
- [PR6577 — vector initializer extraction](https://github.com/loopdive/js2/pull/6577):
  head `54e235eb04a7e1dedca95f7f83ebd1563a99a250`; reported base and verified
  merge-base main845; ahead **13/0**, main845 ancestor; MERGEABLE/BLOCKED.
  Checks **31 success,19 skipped,1 failure,8 in progress**.
- [PR6583 — charCodeAt provider extraction](https://github.com/loopdive/js2/pull/6583):
  head `abe2db03bd680114e83e27ffd6134d50d62e5b68`; reported base and verified
  merge-base main845; ahead **12/0**, main845 ancestor; MERGEABLE/BLOCKED.
  Checks **31 success,19 skipped,1 failure,8 in progress**.
- [PR6590 — forwarding provider extraction](https://github.com/loopdive/js2/pull/6590):
  head `82e9517ae762b0f53811b62e8ad6fe5cf34b38cd`; reported base and verified
  merge-base `fefc9c0e79f4fbf70191f69ab0fdd76a07cc1206`; diverged **14/12**,
  main845 not ancestor; MERGEABLE/BEHIND. Checks **41 success,19 skipped,1 failure**.
- [PR6593 — append qualification/plans](https://github.com/loopdive/js2/pull/6593):
  initial head `ea16b5f3451ff15b18750c3237074647b0a55c41`, ahead **17/0**;
  final head `af0fdbb5cf466bf96e4e13143081dfebe5e19330`, ahead **18/0**,
  reported base and verified merge-base main845, main845 ancestor;
  MERGEABLE/BLOCKED. Final checks **17 success,1 skipped,17 in progress**.
  Exact old→new compare is one commit changing ONLY
  `plan/issues/6915-linear-owned-ascii-append-copy-kernel.md`.
  Prior-head quality failure below is historical evidence, not a verdict on
  the new head's unfinished checks. Initial ea16 counts were37 success,2 skipped,1 failure.

Final aggregate: **8/8 held;3/8 contain main845;5/8 behind;5 current failed
quality jobs;33 in-progress check entries;0/8 merge-ready declarations**.
SUCCESS/SKIPPED counts include advisory/stub/status-context rows and are not
acceptance counts. Six actual failed quality logs were read: five current,
one superseded by the author's append documentation push. No CI run cancelled
or restarted by shepherd; unfinished jobs stay unfinished in this report.

## Real failed required checks, after conflict/review triage

Each of the five registry failures stops at quality step9, "Compiler inventory
and activated boundaries (#3518)", invalid-inventory exit1. Job API head_sha
matches the exact PR head above. **43 subsequent skipped steps in each job**,
including changed-root tests, do not establish passing downstream gates.

- PR6572: [quality112787955708/run37620118252](https://github.com/loopdive/js2/actions/runs/37620118252/job/112787955708),
  **2 diagnostics**: unclassified-module and unclassified-target for
  `src/codegen-linear/runtime/array-allocation.ts`.
- PR6575: [quality112825247503/run37631093706](https://github.com/loopdive/js2/actions/runs/37631093706/job/112825247503),
  **2 diagnostics**: unclassified-module and unclassified-target for
  `src/codegen-linear/runtime/string-slice.ts`.
- PR6577: [quality113207971848/run37746140871](https://github.com/loopdive/js2/actions/runs/37746140871/job/113207971848),
  **3 diagnostics**: unclassified-nonmodule `src/codegen-linear/runtime/README.md`;
  unclassified-module and unclassified-target
  `src/codegen-linear/runtime/vector-initialization.ts`.
- PR6583: [quality113205030884/run37745234680](https://github.com/loopdive/js2/actions/runs/37745234680/job/113205030884),
  **4 diagnostics**: unclassified-nonmodule runtime/README.md and
  `src/codegen-linear/runtime/strings/README.md`; unclassified-module and
  unclassified-target `src/codegen-linear/runtime/strings/char-code-at.ts`.
- PR6590: [quality112995067370/run37680524981](https://github.com/loopdive/js2/actions/runs/37680524981/job/112995067370),
  **3 diagnostics**: unclassified-nonmodule
  `src/codegen-linear/runtime/arrays/README.md`; unclassified-module and
  unclassified-target `src/codegen-linear/runtime/arrays/forwarding-resolver.ts`.

This is14 per-job diagnostics, involving **8 unique missing policy paths**:
five implementation modules and three documentation files (runtime README
appears in two PRs). Exact A-owned change request: `scripts/compiler-boundaries.json`
normal `files` entries with state=unmigrated/layer=legacy-linear plus normal
Linear target membership for those five modules; normal `nonModules` entries
for the three README paths. Preserve main845's existing constructor entries,
all hashes, bounds and activated-edge policy. Reuse PR6590's published owner-ready
`plan/log/6914-linear-forwarding-20261007/compiler-inventory-wiring.patch`
for its existing two-entry proposal; compose the other paths under A ownership.
No exemption, borrowed allowance, gate weakening or inferred blanket release.

PR6593 PRIOR head ea16:
[quality113054821806/run37698137475](https://github.com/loopdive/js2/actions/runs/37698137475/job/113054821806)
fails step48 "Changed root test files must pass (#3008)":
`JS2WASM_APPEND_EXPECTED_PROVENANCE is required`; one failed suite,
**36 setup-skipped/0 completed observations**, exit1,5 later steps skipped.
Cleanup/diagnostic failures and missing-population errors remain retained.
New af0 CI is pending, not presumed repaired by its docs-only amendment.

The exact designated-owner request remains `scripts/hooks/changed-root-tests.sh`
ONLY its invocation branch for
`tests/issue-6915-linear-owned-ascii-append-copy-kernel.test.ts`, and prerequisite
trusted-parent preparation in `.github/workflows/ci.yml`'s named changed-root
step ONLY if A explicitly delegates it. Actual checkout HEAD/source tree,
runtime/consumer/integration/test/fixture identities, matching TEST_COMMAND,
EXPECTED_PROVENANCE, approved actual worker flags and Linear IR=1 must come
from trusted parent input scoped to that invocation. Preserve selection,20-file
cap, default4096MiB fork policy, every other selected test, failure propagation
and not-run reporting. Local1024MiB configured qualification is a different epoch.
No missing-input skip or test self-approval. This is a shared owner dependency,
not a B regression relaxation or source repair release.

Actual advisory logs were also read:

- [6577 changed-job113208701321](https://github.com/loopdive/js2/actions/runs/37746140871/job/113208701321):
  outer SUCCESS, actual **7pass/1fail/8**, shared-allocation fails
  `array-representation-unsupported`, compiler pipeline stops in preparation,
  accept=0/emit=0. Wrapper explicitly warns failed test is advisory.
- [6583 changed-job113205799210](https://github.com/loopdive/js2/actions/runs/37745234680/job/113205799210):
  actual **10/10 new provider tests** pass; no inference that required inventory
  or complete original control population passes.
- [6593 prior-head changed-job113055429755](https://github.com/loopdive/js2/actions/runs/37698137475/job/113055429755):
  outer SUCCESS, actual one failed suite/**36 setup-skipped/0 observations**,
  same provenance refusal; advisory warning. No regression-readiness credit.

## Preserved qualification and A dependencies

Read exact-head published main-845 comparison records, without running them:

- PR6577 baseline execution `3fee634ae67f23f57085ce6b792e584cd78e85ac`,
  candidate `14aa145dd9ca39bff986dd1626e78f6e12e8da6d`, frozen test SHA256
  `0afcb36a4cb3e783a06191bfe6356d568d96791d7aeca8249bfcdd580eac8d77`:
  **24pass/1fail/25 each;8 complete observation rows equal;5 binary witnesses
  each;1,561 characters of complete failure text equal**. Seventeen scalar
  controls pass; genuine shared allocation remains a positive failed requirement.
  A must deliver actual representation/admission, detached allocation facts,
  reservation-safe runtime reuse and planner/consumer/signature/body/scratch
  wiring before its promised Prepared acceptance. Do not invent unused adapters.
- PR6583 baseline execution `a2e5f2c5af0ae9a2209a444a5ac4c70ea2e009d1`,
  candidate `62a0cf9294e3743319188790b5866375d7bccde3`, frozen test SHA256
  `a3e5d6fa5389615c2fe97faedb6f2f2228098ee6175ce53fb1cfc0a036b996b9`:
  **38pass/3fail/41 each;10 full provider rows equal;14 binary witnesses each;
  6,316 complete failure characters equal**. Three original selector requirements
  stay failed: vector construction, core Linear string surface and UTF-16
  charCodeAt capability. Provider reuse needs A's authentic helper reservation
  and five-local ABI; an index alone grants no ownership.

These are bounded preservation facts, not current CI/full migration passes.
Comparison paths are each PR's `plan/log/.../main-845/`; gzipped published
reports were retained in shepherd `.tmp` under6577/6583 filenames.

Other PR descriptions/parent plan record historical qualifications; no new
measurement or independent replay is claimed here: array21/21 candidate with
37pass/2existing fail unchanged controls; slice47/47 candidate with
45pass/3existing fail unchanged controls; forwarding51/51 paired and69/69
fefc composition (main845 refresh still required), plus both full builds exit134
default-heap exhaustion; append configured36/36 with38 graph envelopes and
33 transitions/eight negatives, ordinary CI inputs unresolved. Repeat61/61
paired capture and448/448 replay batches do not overcome mixed performance
in6/8 cases; HOLD remains. f32 plan has no implementation: A must establish real
semantic admission and explicitly release `src/ir/backend/linear-emitter.ts::emitElemSet`.

Read [A's full scope comment](https://github.com/loopdive/js2/pull/6583#issuecomment-6049709582),
updated `2026-10-08T07:49:42Z`, including latest native admission reservation;
final re-read has the same update timestamp. A's prior preserve-JS-host
interpretation is superseded: JS host mode will retire and is not supported in
the IR path. Native standalone/WASI and genuinely explicit native policies
remain scope; unknown Linear policy must not be relabeled native.

A retains final integration, registry/API/source wiring, physical body/cache,
stack/constant-box/inline-origin paths and latest admission/preparation/public
routing reservation. Specifically latest A paths include
`src/ir/target-admission.ts`, `src/shared/contracts/ir-preparation-failure.ts`,
the src/ir program-source/preparation/prepare-ir/consumer leaves,
runtime/intrinsic-preparation and backend/legality, plus compiler presentation,
compiler.ts, compiler/source-text-preparation.ts, index.ts, codegen/index.ts,
codegen-linear/index.ts, codegen-linear/invocation-options.ts and
ir/backend/linear-integration.ts. Read [B's existing acknowledgment](https://github.com/loopdive/js2/pull/6583#issuecomment-6054418671)
as coordination context, not a new source release. Its pending-main845 wording
for6577/6583 is superseded by their actual fresh published pairs above.

Fresh B file lists contain no source/test intersection with A's explicitly
listed reservations. B runtime.ts callbacks/provider leaves remain reserved;
shared runtime.ts occurs in five B PRs (6572,6575,6577,6583,6590). Distinct
callbacks do not authorize whole-file overwrite or arbitrary concurrent repair.
Append's two addLinearIrStringRuntime copy loops remain behind the older exact
claim exclusion/handoff gate. No absence, age or held status releases ownership.

## Dependency-first landing proposal (A/parent decision, no submission)

1. A reviews/adopts the docs-only f32 prerequisite PR6570 without claiming
   implementation; current-main refresh is still needed for any landing decision.
2. A composes the eight normal inventory classifications against canonical
   policy and supplies the separately scoped trusted append CI invocation.
   No B implementation repair is proposed; no file/function release has been
   obtained. Re-run required routes only under normal owner protections.
3. Owner-coordinated main refresh/requalification of array guards6572 then
   slice bounds6575; this is a serial integration preference for shared runtime.ts,
   not a demonstrated code dependency. Preserve original failed controls.
4. Forwarding6590 refresh onto main845 plus canonical registry verification;
   retain full-build failures until genuinely resolved/qualified by owner.
5. charCodeAt6583 after registry and original source-control dependencies;
   initializer6577 after genuine shared allocation/admission/resource wiring.
   Fresh preserved pairs are useful checkpoints, never a reason to waive
   their failed positive requirements. Integrate each disjoint callback intact.
6. Append qualification6593 after trusted CI route executes all36 observations
   and propagated negative failures correctly; retain original/repaired epochs.
   Its proposed production optimization requires separate exact ownership release
   and performance acceptance, neither provided by this handoff.
7. Repeat6563 remains behind an explicit performance decision/relevant workload
   benefit and fresh composition. Mixed6/8 results cannot justify queue release.

Items3–6 have parallel owner prerequisites, not a proven total code dependency
chain. Each actual composition needs fresh source identity, required checks and
failure-preserving evidence. A's unpublished repair results are not main delivery.
All eight holds stay in place. No claim that existing slices satisfy complete
native IR migration, legacy retirement or protected-queue acceptance.

## Evidence custody and checkout caveat

Generated evidence directory contains initial/final PR JSON, eight compare API
ancestries, complete paginated-thread census responses, six raw failed-job logs
and job-step metadata, three raw advisory logs, exact A comment snapshots,
existing B acknowledgment, claim record/tree, moving-head compare, and four
published preservation reports. Read-only API used because sandbox network was
unavailable; no git fetch/ref mutation used (origin is fork; upstream is canonical).
A log download initially refused terminal escapes; explicit escape-preserving
read succeeded. One report-read shell variable shadowed zsh's path; corrected
command retrieved the reports, no result credited from the failed attempt.

Initial ordinary git status hit the shared LFS clean-filter write restriction.
Read-only per-command filter-disabled status showed acorn.wasm modified because
checkout contains expanded LFS content. Actual SHA256
`2a15807615450606f15c52535c67a70d779da265d6447d5cf4a7ce4245c41309`
matches HEAD's LFS pointer exactly (size377758). Shepherd did not modify/revert
that file or shared LFS configuration. Preserve it; do not stage it as this work.
Parent inspects/integrates only this handoff into the existing PR.
