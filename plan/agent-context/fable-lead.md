# fable-lead session handover — 2026-08-21/22 (IR migration completion lane)

Session role: Fable-lane orchestrator on epic #3518 (plan/implement split:
Fable plans, Opus subagents implement, orchestrator releases PRs). This file
is the resume point for the next orchestrator session.

## What landed (28 PRs merged this session)

Highlights on the #3518 spine, all on `main`:

- **R1 #3520**: C34 per-field accessor identity (PR #4729) — generic
  positional ABI bucket 40 → 15; corrections + census de-pinning (#4733);
  the +16 grant figure fix (#4742). Residue enumerated in the issue's
  `## Resume checkpoint`.
- **R3 #3522**: static members on nested classes compile once — the
  sealing-order transaction (PR #4739). Remaining boundary list at the end
  of the issue file.
- **R4 #3523**: host-deferred startup adapter owned by prepared module init
  (PR #4741) — invocation matrix now 3 of 4 lanes; four remaining gaps
  ordered in the issue's `## Resume checkpoint` (next: the #3142 overlay).
- **#2949**: concrete-arg-at-dynamic-param selector arm (PR #4730) — acorn
  driver 27 → 31/42; the linked-lane preparation gap recorded (PR #4732):
  `compileProject` emits 1/43 with 21 `late-preparation-unsupported` —
  selector-accepted units dropped in final-context preparation.
- **Verifier**: module-level declared-type tables (#4605, PR #4725);
  checkInstr roadmap earlier in-session (#4523/#4603 via PRs #4690/#4704).
- **Hygiene**: equivalence baseline ratcheted 36 → 24 with a mutation-proven
  gate (#4609, PR #4738); #2949's 5 rotted assertions re-grounded on
  invariants (#4613, PR #4743 — in the merge queue at handover); conformance
  bugs #4606/#4607 fixed (PR #4736).

## In flight at handover (running Opus agents)

- **#3520 C35** — branch `claude/issue-3520-c35-residue`: semantic owners
  for the 15 remaining generic rows + the 17-red-census-file re-baseline
  (cause-first, per #4733's warning). Will open a draft PR; release it
  after reviewing its report (see release pattern below).
- **#4612** — branch `claude/issue-4612-tokenizer-abi-parity`: bisect of the
  main-acquired `tokenizer` abi-signature-parity withdrawal (IR=182 vs
  legacy=151) on the #2949 driver. Same release pattern.

If these agents died before opening PRs, their worktrees under
`/workspace/.claude/worktrees/agent-*` carry the state; check
`git log origin/main..HEAD` there before re-dispatching.

## Claims held on `origin/issue-assignments` (this lane)

#3520 #3521 #3522 #3523 #2949 (ttraenkler/fable-lead, force-claimed
2026-08-21 from dead codex/opus lanes with project-lead approval);
#4612 (opus-4612), #4613 (opus-4613 — done, PR #4743). Release or re-claim
as the next session sees fit.

## Dispatch queue (planned, unstarted)

1. **R4 next slice**: the #3142 overlay (`legacy=1, ir=1` for
   statement-bearing modules) — prerequisites and order in #3523's
   checkpoint.
2. **#4615** (filed by the #4613 agent, with bisect evidence): fast-lane
   `any[]` ABI parity divergence; fixing it flips PR #4743's deliberate
   red-pin back to zero-demotion.
3. **#4608**: production `declaredGlobals` producer — plan in the issue;
   verify its post-R1 data source exists before dispatch.
4. **#3521 R2**: unstarted. First slice should be the linked-lane
   late-preparation gap (see #2949's "linked-lane preparation gap" section
   and PR #4732) — it unblocks 21 already-selector-accepted units and is
   `reconcileIrOverlayOutcomes` bookkeeping territory.
5. **R3 #3522 next boundary**: field initializers carrying call edges.

## Operating notes that cost time to learn (verify against current state)

- **Release pattern**: agents open draft PRs and never enqueue; the
  orchestrator validates the report, un-drafts, arms auto-merge
  (`enable_pr_auto_merge`). Tell the agent "released #NNNN, leave it" —
  otherwise its draft-flag re-check may convert the PR back to draft
  (happened on #4741; GitHub also sometimes ignores `draft: true` at
  creation, so agents verify after creating).
- **Spawn gate**: `pre-agent-spawn.sh` blocks new agents at 1-min load ≥ 2
  on this 4-core box; ~3 concurrent implementers is the practical ceiling.
  The `.claude/max-load` override was denied by the permission classifier
  this session — ask the user if more parallelism is wanted.
- **Equivalence**: 8 shards always; unsharded OOMs 16 GB.
  `VITEST_FORK_MAX_OLD_SPACE_SIZE=4096` for singleFork vitest commands
  (config pins 512 MB and OOMs regardless of the change under test).
- **No pattern-based pkill** — one agent's `pkill -f equivalence-gate.mjs`
  killed a sibling lane's run.
- Commit auth: author `Thomas Tränkler <git@thomas.traenkler.com>`, `✓` in
  every subject, `Co-Authored-By: Claude <noreply@anthropic.com>` trailer.
