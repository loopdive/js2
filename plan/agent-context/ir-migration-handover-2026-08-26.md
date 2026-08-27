# IR migration handover — 2026-08-26

The standalone-first IR migration remains in progress. The objective is to
separate JavaScript inference and semantic planning from the codegen backends,
then retire the legacy direct frontend without losing any optimization. The
direct frontend is still reachable and must not be retired yet. This session
stops at frequent, signed PR checkpoints; no uncommitted compiler change is
being handed over.

The repository issue Markdown is authoritative. GitHub issue and pull-request
numbers share one namespace, so the historical GitHub objects numbered 1719,
3521, 4260, and 4755 are not these current compiler trackers. Continue from
the following files and their linked PRs rather than filing duplicate GitHub
issues:

- `plan/issues/3521-ir-r2-prepared-program-free-function-compile-once.md` —
  active linked-Parser R2 repair, draft PR
  [#5000](https://github.com/loopdive/js2/pull/5000);
- `plan/issues/1719-array-destructuring-ignores-overridden-array-prototype-iterator.md`
  — reopened standalone CPR iterator contract, plan PR
  [#4999](https://github.com/loopdive/js2/pull/4999);
- `plan/issues/4755-legacy-module-lexical-assignment-tdz.md` — completed direct
  TDZ prerequisite, implementation PR
  [#4997](https://github.com/loopdive/js2/pull/4997); and
- `plan/issues/4260-prepared-provider-plans-leak-across-aborted-component-seal.md`
  — atomic prepared-provider publication, draft PR
  [#4996](https://github.com/loopdive/js2/pull/4996).

Do not move the linked-Parser repair to #3522 or a new issue. The measured
failure is a #3521 pre-claim/prepare-before-emit gap; the later direct-call
reconciler never receives a caller plan because selection rejects the caller
first.

## Exact publication state

| Tracker | PR | State at handover | Exact implementation head before this handover |
| --- | --- | --- | --- |
| #3521 | [#5000](https://github.com/loopdive/js2/pull/5000) | draft, in flight | `9f9d978c743b054d05b01702639a914f268e3c6a` |
| #1719 | [#4999](https://github.com/loopdive/js2/pull/4999) | merged through the queue | `c8ca8466d18cf9f483a44f5ef5fa38cc2673f93f` |
| #4755 | [#4997](https://github.com/loopdive/js2/pull/4997) | ready, requeued normally at exact head | `06f80c1fe69a05b88a65d89783edee3dc43758f8` |
| #4260 | [#4996](https://github.com/loopdive/js2/pull/4996) | draft, waiting for #4755 and B.7 | `493ad47d316d69b16c0db802bb7bbe8eba6d269e` |

PR #4982 is deliberately held and unqueued. Its head
`497ea0a73c0a3efa77009243f0527ee7cf5eff1c` contains the forbidden 29-row
dead-export baseline expansion. Automation has repeatedly removed the `hold`
label and queued it; restore the label and dequeue it if that happens again.
Do not treat that PR as migration progress.

## #3521 linked Parser — exact stop point

Continue in the isolated worktree
`worktrees/codex-3521-linked-owner-closure-current` on branch
`codex/3521-linked-owner-closure-current`. The worktree and remote were clean
and synchronized at the implementation head above when the coding agent
stopped. Draft PR #5000 contains three signed checkpoints:

1. `39ee91a31704484a66a1496f80c4db0e3dfa214b` validates the dormant exact
   logical-to-physical standalone Parser layout. The handle is get-only;
   construction remains illegal.
2. `1b16d85e47266edb3f96805f0fe1eba4053b770d` observes that exact layout only
   after legacy standalone/native-string construction has finalized the
   `input`, `$constructor`, and `$bag` fields.
3. `9f9d978c743b054d05b01702639a914f268e3c6a` constructs dormant immutable
   preselection authority by joining the retained argument edge, the two exact
   `parser.input` reads in `.slice(0, parser.input.length)`, the get-only
   Program-ABI resolution, and the current `readNumber` handle/function/type
   slot.

The focused fnctor matrix is 102/102. TypeScript 7, IR layering/dialect and
optimization-retirement checks, LOC/function/oracle/coercion/issue ratchets,
and the complete unskipped precommit and prepush hooks passed for every local
checkpoint. These checkpoints deliberately do not change selector admission or
emitted routing. No compiler/runtime A/B or R2 replay was run or claimed.

The next implementation must remain serial and copy-on-write:

1. Construct the exact dormant parameter plan in late `planIrOverlay`.
2. Consult only that exact parameter in `makeIrImplicitParamTypeResolver`, then
   carry its authority through `IrOverlayPlan` without mutating shared
   signature or callee maps.
3. Activate only the two authenticated Parser field-read AST sites and retain
   the existing get-only physical field/refinement proof.
4. Add the source-qualified effective Parser signature, semantic-to-physical
   string parameter plan, the two exact parse builtin boundaries, and the
   exact `readNumber -> stringToNumber` direct-call plan.
5. Revalidate the live handle, function object, type, post-binding locator, and
   current index immediately before lowering/parity/patching.
6. Run the focused standalone/host/base/disabled matrix. The bounded late
   overlay may report `direct=1, IR=1`; it is not the final compile-once claim.

Do not add a one-line selector bypass, weaken #4612 globally, invent a
name-keyed fnctor ABI, use `funcMap` as authority, authorize `fnctor.new`, or
patch only the direct-call reconciler. The exact remaining mutation and replay
matrix is in the final L3 and acceptance sections of the #3521 issue file.

The R2 collector itself is statically hardened and independently approved, but
still has status `needs-runtime-replay`. Preserve both prior environmental
load-failure envelopes. After the compiler repair merges, relock the validation
bundle in a separate checkpoint, obtain another read-only static audit, and
run the full 16-pair/32-child collector exactly once at a new output root. Keep
C36/C37 scheduled for the final aggregate rerun. Do not report the unchanged
#4035 size ceiling as a regression.

For withdrawal tuples, the parser public diagnostic remains mandatory. The
caller public warning is optional only when absent through the prepared-source
filter; if present, it must be the exact paired cascade diagnostic. The caller
`irOutcomes` row remains mandatory in either case. Do not weaken that semantic
oracle while wiring the production route.

## #1719 standalone CPR iterator — ready to claim from merged plan

PR #4999 contains the root-authored reopened plan and merged through the queue
at 2026-08-26T11:44:05Z. Its exact PR head is
`c8ca8466d18cf9f483a44f5ef5fa38cc2673f93f`, and the main merge commit is
`9d87ffa4b557242f30afc6d09db1c24e387315dc`. All merge-group workflows were
genuine successes. The earlier normal claim attempt correctly returned exit 4
while main still described #1719 as done; it was not forced. No implementation
branch, compiler edit, commit, push, or implementation PR exists yet.

Start the implementation with these steps:

1. fetch live `main`, claim #1719 normally, and create an isolated
   `codex/1719-standalone-cpr-iterator-contract-impl` worktree;
2. first checkpoint the shared standalone-only CPR normalizer and strict
   fill/finalization parity with a non-receiver generator fixture proving all
   five consumers use `drive -> __iterator -> __iterator_next`; then open a
   draft PR immediately; and
3. in a second checkpoint add only the exact CPR receiver assignment admission
   plus the immutable call-time-`this` GenState snapshot and resume
   rehydration, including capture and two-array reentrancy controls.

The intended production ownership is recorded in #1719. In summary: add the
AST-only CPR assignment predicate; share the normalizer in
`expressions/proto-override.ts`; preserve the receiver slot through
`generators-native.ts` and context state; assert strict native iterator fill;
and mirror guarded multi-source finalization. Keep GC, WASI, unrelated
generators, and override-free artifacts byte-exact. The #4755 standalone row is
a required downstream ordering control.

## #4755 and #4260 landing order

#4755 is implementation-complete in regular PR #4997. Its final net diff is
the issue plan, seven codegen files, and two focused tests; generated reports,
budget baselines, and CI files are excluded. The changed-root proof is 48/48,
all ratchets and unskipped hooks passed, and no LOC/function allowance was
added. The branch was re-anchored without a force push. Never use
rebase-and-merge for #4997 because replaying its preserved pre-anchor history
can resurrect unrelated generated artifacts; use the merge queue, a merge
commit, or squash.

#4260 stays draft until #4997 is actually on main. Then merge live main into
`codex/4260-b-atomic-publication` without rebasing and review the result. Add
the missing B.7 matrix: sole `__new_ReferenceError` requester, injected
pre-seal failure and uninjected/direct controls in GC and standalone, exact
Unsupported/direct-only outcome, no stale host import or orphan standalone
constructor, and a healthy shared-provider control with one canonical
provider. Change production only if that literal matrix fails. The detached
`/private/tmp/js2-4260-baseline-debug` worktree contains deliberate diagnostic
edits; never use it as the implementation source or delete it as cleanup.

## Queue and CI handoff

#4999 subsequently merged through its genuine green merge group as recorded
above. #4997 remains normally queued at exact head
`06f80c1fe69a05b88a65d89783edee3dc43758f8`; it had no new merge-group head at
the final snapshot. Its earlier recovery cancelled only stalled workflow run
`32961095426`, dequeued the stale entry, verified the exact unchanged PR head,
and performed a normal requeue. Do not rebase or manually merge #4997.

Draft PR #5000 has one real GitHub `quality` failure in run `32964133636`, job
`98162790425`. `pnpm run check:dead-exports` reports all eight top-level
functions in the new `src/codegen/ir-fnctor-parameter-planning.ts` as newly
unreferenced because the deliberately dormant authority is imported only by
its focused test. This is not stale-main or baseline noise. Do not update the
dead-export baseline. The next L3 checkpoint must import and consume
`planIrFnctorParameterPreselection` and
`irFnctorParameterPreselectionIsCurrent` from the survivor-reachable
`planIrOverlay`/implicit-parameter/currentness route; that production edge
makes their six private helpers transitively live. Rerun the dead-export gate
as a stop condition. If that wiring is incomplete, keep #5000 draft/red.

Do not mark the draft ready merely because the focused and local hook matrices
are green. Keep #5000 unqueued until the dead-export failure, production
wiring, runtime acceptance, final R2 proof, and an exact-head CI audit are all
complete.

## Operating rules that remain load-bearing

- Before every heavy command, commit, or push, sample the one-minute load and
  require `Number.isFinite(sample) && sample >= 0 && sample < logicalCores - 2`.
  This host has 10 logical cores, so the limit is strictly `< 8`.
- Use fail-fast shell composition. A rejected load sample invalidates the
  entire following action; do not let a newline-separated command continue and
  then adopt its result.
- Before every mutating Git action, print `pwd` and
  `git branch --show-current`.
- Run `pnpm run check:loc-budget` and the function-growth ratchet immediately
  before every commit.
- Never skip precommit or prepush hooks. Do not use `--no-verify` or
  `SKIP_SLOW_PRECOMMIT`.
- Sign every agent commit with the user's identity,
  `Thomas Tränkler <git@thomas.traenkler.com>`, an SSH signature, a subject
  ending in `✓`, and exactly one
  `Co-authored-by: Codex <codex@openai.com>` trailer.
- Remove any worktree `node_modules` symlink after pushing.
- Do not rewrite a queued head. Land frequent signed checkpoints as draft PRs
  while behavior remains in flight; make only completed work regular/ready.

## Workspace safety

The primary checkout on branch `codex/4617-frontend-neutral-semantic-ir`
contains unrelated user/session state and must not be cleaned or reset. At
handover it includes a modified #3521 plan plus untracked `.capc-worktree`,
`.codex/artifacts/`, `examples/theprimetime/`, the 2026-08-24 standalone IR
checkpoint, `while.*` artifacts, and `worktrees/`. Continue only in isolated
issue worktrees and preserve those root bytes.

The four relevant isolated worktrees are:

- `worktrees/codex-3521-linked-owner-closure-current` — #3521 / PR #5000;
- `worktrees/codex-1719-standalone-cpr-iterator-contract-plan` — queued #1719
  plan / PR #4999, not an implementation worktree;
- `worktrees/codex-4755-legacy-assignment-tdz-impl` — #4755 / PR #4997; and
- `worktrees/codex-4260-b-atomic-publication` — #4260 / PR #4996.

On resume, verify each relevant branch, status, live PR head, queue state, and
absence of a leftover `node_modules` link before treating this snapshot as
current.

## Resume procedure

1. Read this handover and the four issue files above completely.
2. Fetch live `origin/main`; verify which queued PRs actually merged rather
   than inferring from a queue position.
3. Preserve #4982's hold and inspect #5000's exact CI failure before editing.
4. Continue #3521 from draft PR #5000 in the bounded order above, with one
   signed checkpoint per coherent authority/lowering slice.
5. Fetch merge commit `9d87ffa4b557242f30afc6d09db1c24e387315dc`,
   claim #1719 normally, and only then create its implementation worktree.
6. Refresh #4260 only after #4997 lands, then add the B.7 proof before changing
   production.
7. Keep the global migration goal open. R3 through R10 and final direct
   frontend deletion remain unfinished even after these focused lanes land.
