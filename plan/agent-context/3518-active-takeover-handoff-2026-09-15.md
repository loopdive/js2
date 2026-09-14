# Active IR takeover handoff

## CI repair and integration receipt — supersedes earlier state

The revised sequential test file completed74306 successfully:12/12, no skipped
cases. Review confirmed original assertions/fixture retention; normal commit
hooks and push of this test-only repair remain required. The earlier beforeAll
timeout is retained below as a failed attempt, not a passing run.

Further validation: the first local split63911 failed its10-second beforeAll
hook (10 passed, one skipped after hook failure). Preserve that result; no
timeout override followed. The revised explicit sequential pair uses two normal
tests under the original35-second budget, publishes the actual captured fixture
only after acquisition assertions pass, and explicitly fails if the fixture is
missing. Ordinary cleanup remains between cases. Full12-case planning run74306
is live; inspect before mutation. This replaces the beforeAll design below.
Post-f585 PR5753 combinedfour-suite run81032 passed109/109, but repeated-
preparation review still blocks D1; passing tests are not acceptance evidence
for that missing contract. Planck acknowledged and is implementing its fix.

PR5939 is open at `c96759531d3ac6a980a6a3d191b5d6f34d889ee8`, directly
on loopdive/js2, with protected merge-when-ready enabled. It has NOT landed.
CI34909327931 quality104193078143 failed one compound planning test after
35,905ms against the unchanged35,000ms limit; the other9 planning rows and
the5 emission rows passed. Source inventory tests were not reached in that
quality step. Original evidence:
https://github.com/loopdive/js2/actions/runs/34909327931/job/104193078143
The source, fixtures, assertions and timeout stay unchanged. The pending test
repair separates genuine consumer-input acquisition into a scoped fixture and
keeps its positive/negative observation ordering in a separate test. Full planning
rerun63911 is live; inspect before mutating. Normal hooks/push remain required.

PR5748 is published at `4335a57cc7718bbb0d75ef7c1ad4506efefab8f7`, hold
preserved. A0 includes the wrong-instance negative,26/26 tests pass, normal
hooks/pre-push pass. A1 runtime consumption remains deferred. Volta's staged
completion/inliner/extractions now produce correct values but wrapper IR
falls back because propagation mistakes generator completion for call result.
Parent read the rejected initial proposal and exact-base evidence, then
explicitly authorized the complete bounded three-file repair with alias,
mixed-return/fallthrough safeguards and tests. No partial rejected patch was
applied or parity gate bypassed. Wegener is preparing A1 routing read-only.

PR5753 parent HEAD remains `2a528c8743`; D1 `0b99423312` + follow-up
`f5857656c3` and U1 `7fef9b7e1b` are staged locally with boundary registration.
Before f585, original23-file group passed322/322, combined four repair suites
107/107, typecheck and inventory1477 passed, unchanged layering gate85≤90.
Those results do NOT certify late-currentness. D1 repeated-preparation proof
population and U1 reused-provider sealing each have demonstrated review
blockers assigned to Planck/Tesla, reviewed by Nash. Neither may publish yet.
The seven timer failures pre-exist D1: exact22-test runs on pre-D1 `2a528c8743`
and initial D1 `0b99423312` both15/22, identical names/statuses/normalized
failure details. Logs: `/private/tmp/js2-5753-timer-attribution-logs.C6qeMY`.
Attribution is not a waiver or golden refresh.

## Current integration receipt — 2026-09-15, supersedes all older state

Targeted59678 finished successfully:2/2 selected cases,8 intentionally filtered
out. No live parent tests remain. Normal commit and publication are next.

Native validation update: combined45508 finished36/38 with two new diagnostic
assertion mismatches (actual rejection correct, earlier descriptive validator).
Preserve that failure; no production fix or weakened acceptance followed.
Corrected full planning rerun46907 passes10/10; inventory unit file passed28/28
in45508 and separate emission7419 passes5/5. These are43 unique tests, not
multiple additive rerun counts. Last added explicit supported-host mismatch and
missing async attachment controls are running in targeted59678 (two selected
cases; other cases intentionally not selected). Inspect before committing.
High review found no source blockers. Rawls requested non-vacuous observer
ordering; parent now supplies a genuine producer input before injecting a
validator failure and proving observation is not reached. Final publication
and normal hooks remain pending. No parent source process other than59678 live.

Upstream fetched again: main remains `8c9b65b389194c8c8fc3e857e4b7316b0ae524e1`.
Open PR inventory is 16, not the historical 41. Relevant active integration
targets remain #5748 and #5753; no new merge this pass. #5748 remote head4b9a66
is mergeable but conformance hold remains; #5753 remote51590 is still conflicting.

PR5753 local HEAD `2a528c8743` now includes C1 `a55f9a856e48` above bd99.
Normal hooks and TypeScript7 pass. Parent seam30/30; Nash independently117/117,
no review blockers; agent original247/247 is separate overlapping evidence.
Boundary inventory1475 passes, architecture incomplete. Only remaining layering
failures are closure-support5→6 and undefined-provider5 new upward imports.
Planck continues D1; Tesla now implements U1 from its C1 checkout. Their isolated
integration.ts changes are disjoint by contract and parent must compose them.
No PR5753 checkpoint push yet: finish source repairs and composed tests first.

Native inventory delta `1a35d601d0ab972fe646b8ba8cb0052314a33f3c` applied
without commit above5949/6e. Nash approved the genuine dependency split.
Source collector is descriptive; live parent preflight owns whole-program
authentication before no-demand return or observation; backend observer takes
the current source census and actual producer input. Actual dependency removal
allows clean registrations; inventory1438 and TypeScript7 pass. Parent restored
both moved authority negatives (missing formatter support, present-undefined
encoding metadata), plus required/no-demand direct validation controls. Combined
test process45508 is RUNNING; inspect before any mutation. Nash/Rawls review
the checked-path integration read-only. No executable async acceptance added.

Volta is implementing the High-approved slot/frame-safe inliner eligibility
repair and substantive generator/import/initializer extractions, preserving
normal budgets. The slot failure reproduces on the exact base, but needs repair
to admit the original ignored-delegation specimen. Runtime remains Volta-owned.
Wegener now implements ONLY A0 raw-vector own-presence helper from array spec,
based on5748 head4b9a66; no runtime or guard writes. A1/A2 serialize after Volta.
The local5399 spec label is NOT GitHub issue ownership: GitHub5399 is an unrelated
already-merged docs PR and must not be updated for this array work.

## Latest receipt — supersedes older live-state notes below

Completion of recorded local processes: PR5753 commit process22470 finished
successfully at `bd99f7f7e1` (normal hooks passed, not pushed). Native run56945
finished with39/39 tests after6e was integrated. No parent process remains live.
Rawls has supplied a concrete clean-layer split proposal; Nash High is reviewing
it after the array spec. Rawls was told to hold implementation until that review.
The proposal keeps descriptive accounting in clean owners, authenticates in the
existing live parent preflight before no-demand return or producer observation,
and moves authority-negative tests to that actual checked path rather than
removing them. No automatic clean relabel or boundary-root evasion is authorized.

- PR5748 pushed and verified at `4b9a66d730b068893d716fbff645d94b6deeff13`.
  GitHub reports MERGEABLE, but hold remains. Current PR quality, issue tests,
  equivalence and parity checks passed; Test262 shards were skipped, so this
  is not a full conformance verdict. Public receipt:
  https://github.com/loopdive/js2/pull/5748#issuecomment-5671872644.
  Conservative integration passes 154 unique guard controls. One original
  enumeration case restored; four array and one generator case remain blocked.
- Array diagnosis now proves a prototype-write defect too: the four original
  tests can pass under a diagnostic filter even though the requested prototype
  is not installed. Numeric reads return NaN and generic reads undefined where
  Node returns 7. Do not use their filtered passes to justify an exemption.
  Nash is specifying canonical prototype mutation/Get/HasProperty repair.
- PR5753 composition committed locally at `b7521221b4`, including the duplicate
  bytecode-proof import fixed after the normal hook caught it (23/23 tests).
  F1 `0550cb77841d1a1fbb175c9da2d10930b9f1d6d9` and S0/S1 through
  `4085860f7a06415650fa5ef68ad0d58f0c88c8f0` are integrated locally with parent
  G1 repairs. All five original structural suites are now live and passing;
  exact inverse donor hashes retained, no broad golden refresh or skipped
  relocation proof. Combined nine-suite run: 252/252, zero skipped. Typecheck
  and inventory pass (1472 files, architectureComplete false). Remaining
  layering: prepared-closure-support 5→6, component-sealing 3→5, undefined
  provider five new upward imports. Local combined commit process 22470 was
  running when this receipt was written; inspect it before mutating that tree.
- Native inventory commits `5949bc90541cff99fa26cf93176cb150473eaf9d` and
  review fix `6e40ae8f53ddc31229a852bfc15383d325ea50cf` are applied WITHOUT
  COMMIT in the migration parent, alongside the actual planner wrapper/tests.
  Rawls fixed no-demand re-export rejection, mutable support locators, and
  invalid literals-mode producer observations. Combined three-suite run 56945:
  39/39, zero skipped. Existing output consumer rerun 24092: 24/24 clean.
  Earlier combined 30/30 had an RPC timeout; preserved, not counted as clean.
  TypeScript 7 passed. The helper formerly called require was renamed
  noteObligation to avoid false CommonJS dependency detection.
- Native inventory is NOT ready to publish: both new modules retain unclean
  program-validator/facade dependencies inside active roots. Honest unmigrated
  records correctly fail unclean-active-layer. Rawls is proposing a real split
  between canonical descriptive accounting and coordinator-owned admission.
  Do not relabel the modules clean or move them outside the gate for convenience.
- Volta host completion work: `/private/tmp/js2-5398-host-completion-20260915`,
  branch `codex/5398-host-completion-20260915`, base4dff299, seven files staged,
  uncommitted. 37/39 reported includes TWO known-wrong observations, not
  conformance credit; two ignored-delegation numeric-return controls fail IR
  slot verification. Existing controls45/45. Normal hooks rejected LOC growth.
  Volta is doing exact-base attribution and proposing meaningful decomposition,
  not budget allowances or hook bypass. Parent retains guard admission.
- Planck `01a0a211-24dc-79f1-ba52-d7d13454152c` now implements D1 in its
  `/private/tmp/js2-5753-s0-s1` checkout from4085860; parent must cherry-pick
  only the new D1 delta. Tesla `01a0a211-8e37-7aa3-9e0c-16a57210ed29` now
  implements C1 in a new isolated checkout from4085860. U1 follows C1 and is
  not assigned yet. Their complete High contract is the adjacent
  `5753-composed-boundary-repair-2026-09-15.md`.
- Hypatia completed its saved High specs and was closed to free concurrency.
  Do not restart it blindly. Other agent IDs below remain valid; Wegener's
  latest array diagnosis is complete, Rawls is on architecture proposal, Nash
  is on array implementation specification, Volta on host completion blockers.

Automatic safety review first rejected a bundled policy/test refresh. Read-only
proof established the new object-layout module was unclassified (not relabeled)
and its sole edge was allowed. A narrower additive inventory entry and bounded
fixture repairs were accepted afterward. All production floors/allowed edges
and historical records remain unchanged; new required entries tighten coverage.

Not completion. Goal remains shepherding existing IR PRs to main, then completing
the migration. Root `/Users/thomas/Code/js2` is dirty user state; do not modify it.

## Pinned state

Verified upstream main: `8c9b65b389194c8c8fc3e857e4b7316b0ae524e1`.
Parent worktree: `/private/tmp/js2-ir-takeover-20260914.uLEULx/worktree`.
Branch: `codex/ir-takeover-20260914-uLEULx`.
Reviewed specification commit: `c7f7252fe1` (normal hooks passed).

Parent has uncommitted wrapper/planner changes and new inventory-planning tests,
awaiting Rawls's infrastructure. They are not typechecked or executable yet.
Do not publish them separately from their real dependencies. The full contract
and normative connection amendment are in the adjacent native-promise-inventory
document. Existing refusal and full fixture must remain intact.

## PR5748 — do not publish proposed guard repairs yet

Published head: `9b36161f94ab1108b1ed0e1917a828ee3d3dad58`.
Fork head branch: `ttraenkler/js2:codex/5387-unsoundness-audit`.
Parent integration worktree: `/private/tmp/js2-ir-takeover-20260914.uLEULx/pr5748`.
Local merge commit: `4dff299fd80f0cefaae70fd5b2f33b0594664754`.
Normal hooks passed; 203/203 focused integration tests, typecheck, inventory and
IR layering passed before semantic repair integration. No push. Hold retained.

Wegener's `9bde5d289efaa941d661c9b541e12fc03f6115ee` restored five original
regressions but MUST NOT LAND AS-IS. Adversarial validation found array prototype
variants returning NaN instead of 7 and enumeration alias/descriptor effects
returning an empty string instead of b. Across 14 specimens at two optimization
levels: 14 wrong results, 10 refusals, 4 matches. Original guards refused the
newly wrong specimens. Wegener is repairing this conservatively in its own
worktree; do not cherry-pick until the follow-up is reviewed and validated.

Remaining generator failure: consumed array delegation returns 0 instead of
undefined. A whole-program non-execution certificate has no established closed
execution boundary and is NOT approved for implementation. Hypatia now specifies
the actual completion-value repair instead. Preserve the refusal until supported.

## PR5753 — conflict composition exists, architecture still red

Published head: `51590be38131c959990eb6f146ff0717c33551c5`.
Fork head branch: `ttraenkler/js2:codex/1058-typescript-standalone`.
Volta worktree: `/private/tmp/js2-5753-published-composition-20260915`.
Branch: `codex/5753-published-composition-20260915`.
Nine conflicts resolved, staged uncommitted merge; exact resolved tree:
`634a5e1e1b89a28fbbfa76a8e6c971742f825d11`.
90/90 initial runtime tests and 30/30 final generator/composition tests pass;
27 structural assertions, inventory and deeper layering remain red. No push.
Read its `.tmp/HANDOFF.md` and raw logs before action. Missing unpublished older
checkpoints remain unavailable; no results from them apply to this candidate.

Nash is specifying dependency-first architectural repairs. Do not relabel
unmigrated modules, refresh golden receipts broadly, or raise gate baselines.

## Live native agents

- Volta `01a0a1e9-51ea-78f1-ae68-e70d7a8928ac`: composition finished; preserve
  staged tree while parent/Nash review. Await next bounded implementation slice.
- Wegener `01a0a1e9-5262-7683-8cab-8a1af0d50563`: conservative guard follow-up
  and adversarial correctness tests; no generator edits or publication.
- Hypatia `01a0a1eb-e396-7ba1-9347-d23bc2a11b55`: actual array-delegation
  completion repair specification, including PR5753 overlap.
- Rawls `01a0a200-8090-7c83-90c7-0b6b62fa4d50`: Low A inventory implementation
  in isolated worktree; owns two new inventory modules and two unit-test files.
- Nash `01a0a202-9bfb-7833-b3af-7c73c6b14fe9`: High PR5753 boundary repair spec;
  may write only its named agent-context document in parent worktree.

Parent remains the sole integration/publication owner. Resume these agents, do
not spawn duplicate writers. No parent test/commit process remained running when
this handoff was written. Agent activity may still be live.
