# IR migration handover — 2026-08-27

The migration remains **in progress**. This handover records the exact state at
the end of the current Sol-led session; it does not claim global IR-only
completion, R2 compile-once acceptance, or a completed aggregate replay.

## Authoritative base and workflow

- Dispatch base/live main at the final local checkpoints:
  `5bdc209f0de611808a701d9b08a0b971d689f12f`.
- Every heavy command, commit, and push requires a fresh finite, non-negative
  one-minute load strictly below `logical cores - 2`. This host has 10 logical
  cores, so the exact limit is `< 8`.
- Run `pnpm run check:loc-budget` and `pnpm run check:func-budget` immediately
  before every commit. Never skip precommit or prepush hooks.
- Commits are SSH-signed, authored and committed by
  `Thomas Tränkler <git@thomas.traenkler.com>`, and carry exactly one
  `Co-authored-by: Codex <codex@openai.com>` trailer. Re-verify signing access
  in a new session; the current session used
  `/private/tmp/codex-3518-signing.sock`.
- Before every mutating Git action print `pwd` and
  `git branch --show-current`. Preserve the dirty root checkout on
  `codex/4617-frontend-neutral-semantic-ir`; use isolated worktrees.
- The root Sol agent owns every implementation-plan or issue-plan update. Use
  Sol subagents for implementation and independent review, and staff one
  dedicated Sol PR shepherd while this session's PRs remain open; root owns
  that sweep only until the dedicated slot is active.
- Temporary worktree `node_modules` links were removed after each push. Do not
  leave dependency links in frozen validation roots.

## Open IR pull requests

Queue positions are a point-in-time snapshot from 2026-08-27 at 22:30
CEST. Refresh them before acting; never use an admin/direct-merge bypass.

| PR | Head/checkpoint | Purpose | State at handover |
| --- | --- | --- | --- |
| [#5081](https://github.com/loopdive/js2/pull/5081) | `6f1e36da4eea1d9dda0c65422ae106cf0d47af40` | #3518 C2e: remove exactly 29 stale string-leaf dead-export rows | all checks green, protected queue position 5 |
| [#5082](https://github.com/loopdive/js2/pull/5082) | `040e32dbbc5a709f430613d78db74267ee47f068` | close #4260's already-landed atomic provider transaction | all checks green, protected queue position 6 |
| [#5083](https://github.com/loopdive/js2/pull/5083) | `87df9e41895fc5479165bd8d78920607ee0830b5` | #3525: default bounded callable components on | all checks green, protected queue position 8 |
| [#5086](https://github.com/loopdive/js2/pull/5086) | `927687236765accc1e27dde350ae069b3b4c1ca7` | #3521 R2-v2 validation-contract plan | all checks green, protected queue position 11 |
| [#5087](https://github.com/loopdive/js2/pull/5087) | `4e7d9bde1ec7b5a3048742464520a40369fc4785` | #1719 checkpoint 1a standalone CPR normalization | all checks green, protected queue position 12 |
| [#5090](https://github.com/loopdive/js2/pull/5090) | `88fd8b5b1c0abb2fbf3d54c8e5f8143c01ca7235` | #3522 F2 exact-owner source direct calls | corrective provenance relock pushed; checks rerunning, auto-merge armed |

The queue itself was healthy. Queue-head #5079 had merge-group CI and
differential checks green while Test262 Sharded run
[33108907711](https://github.com/loopdive/js2/actions/runs/33108907711)
was still in progress; its `AWAITING_CHECKS` state was not an unexplained stall.
Shepherd #5081/#5082/#5083/#5086/#5087/#5090 through actual merge and verify
their merge commits are ancestors of refreshed main before dispatching
dependent successors.

## #3521 — R2 linked-Parser validation

No runtime replay was run in this session. The approved R2-v1 collector and
the recorded classifications and hashes for its three historical failures
remain immutable ledger history. Their cited `/private/tmp` raw artifact roots
are no longer present, so the raw streams are not durable evidence and must not
be validated, reused, or grounded by a later session. The authoritative v1
source hashes are:

- README `b8fd4aabf2fa2178d1cba2e0fd39461de931a8b3be394875aa1a4c6b0bc2f0d3`;
- manifest `337b6b28239ed9ac046ec171434cb78ffc71f1846d3af81b5373e077215f4531`;
- driver `bb9108e9d63b2f1f1649719c8ec389d4ec1c72cc16e207e2b1136ed4a06a150d`;
  and
- worker `d26cbfe63a59cf107e2a44a3eba5579ed3dfa4e086749040477280407524245a`.

Those four matching adapter bytes exist only as an ignored/untracked static
reference in the shared root at `.tmp/ab-drafts/r2-linked-parser`; they are not
in the `5bdc209...` Git tree or this isolated handover worktree. Do not clean,
rewrite, promote, or loosen that root-only reference into v2. Its presence does
not restore any of the three absent raw failure artifact roots.

PR #5086 replaces only the stale replay plan. The new
`r2-linked-parser-ab-collection-v2` has one wrapper and exactly 24 children:
16 children compare pre-#5000 main `de35a52d978e328d46a9929b5438837385ddea5b`
with #5000 merge `fcede269da81724397dd00bd854e3830446620f5`, and 8
children pin the same matrix on a frozen live-main side. The nonexistent parser
switch is forbidden. Host uses GC/native strings off; standalone uses native
strings on.

The current multi-source graph-global module-init exception is real, not stale:
the exact one unitless `entry.mjs` physical row with
`structurallyComplete:false` remains the bounded R5-M0 behavior. V2 derives and
joins inventory-owned module-init terminals route-conditionally, then validates
that one exception separately. #3525 M2 owns removing it in production.

Next action after #5086 merges: implement the v2 adapter and manifests in fresh
artifact roots as a new static checkpoint, obtain independent read-only
source/bundle/pin review, and only then schedule its one exactly-once runtime
collection under the strict load gate. A pass accepts only linked-Parser L3
(`direct=1, IR=1`), not R2 compile-once. Keep C36/C37 scheduled for the final
aggregate rerun; unchanged #4035 size evidence is a control, not a new
regression.

## #1719 — standalone Array iterator override

PR #5087 is the independently approved checkpoint 1a. The shared CPR producer
now normalizes its raw generator result exactly once through `__iterator`
before the five existing declaration, parameter, for-of-head, assignment, and
#1749 spread consumers use `__iterator_next`. It adds one exact AST-only direct
assignment predicate and no consumer-local workaround.

Current-main evidence is 19/19 focused tests, TypeScript 5/7, layering,
vacuity, LOC/function ratchets, and all normal hooks. GC and WASI clear/Symbol/
values plus override-free standalone artifacts are parent-byte-identical;
WASI/standalone retain zero imports. Only standalone Symbol/values move, each
by the intended 12 binary bytes.

After #5087 actually merges, continue the numbered #1719 plan as separate
ready checkpoints: add only immutable call-time receiver state to GenState with
resume/re-entrancy proof, then add guarded multi-source iterator/proto-driver
finalization parity. Do not broaden ordinary receiver-bearing generator
admission, reopen the rejected intactness-gate design, or absorb #1750.

## #3522 — R3 exact-owner direct calls

PR #5090 is the independently approved F2 checkpoint. It adds a distinct
identity-aware direct-call collector requiring exact AST ancestry, source,
active self-owned owner/target terminals, checker resolver, declaration,
source-qualified unit, binding, name, and canonical signature. The legacy
context-free collector remains for non-unit compatibility routes. Single- and
multi-source overlay/integration share one resolver and exact async callable
signatures. Full/remaining plan-map collisions reuse only a canonically equal
row and fail closed on owner/binding/name/signature drift.

F2 is behavior-neutral: the field-call gate remains closed. The changed-root
tests pass 20/20 (#3520 13/13, #3522 7/7), both TypeScript versions and all
normal hooks pass, and exact-parent GC/standalone artifacts are byte-identical
within direct and experimental options. The corrected host-callback fixture
uses the exact four-externref `HTMLElement_addEventListener` ABI; it passes
9/9 on the exact parent and does not grant generic capability authority.

The first #5090 CI run found only a stale kind-neutrality evidence location.
Follow-up `88fd8b5b1c0abb2fbf3d54c8e5f8143c01ca7235` moves the unchanged
`forof.string` provenance from `src/ir/integration.ts:5109` to line 5146. The
row, `js` verdict, `dialect` placement, rationale, declaration, evidence
cardinality, and all census counts are unchanged. The relocked baseline
SHA-256 is
`42686323c13fcb8539e82b179efd89a4d2feba10edefc7d4772ca65130a91a42`.

After #5090 merges, F3 may retain dormant source-qualified field-call evidence
without admission. The natural positive implicit-constructor field-call is
deliberately F4 because any such call currently makes the class unbounded; do
not fabricate a terminal implicit constructor in F2/F3. F4 remains a separate
bounded admission checkpoint after its exact predecessors merge.

## Other migration state and next dispatch

- #3518's C2e baseline contraction is PR #5081: exactly 29 obsolete
  `multi-prepared-string-leaf.ts` dead-export rows are removed; 23 unrelated
  rows remain. Do not broaden the baseline.
- #4260 is closed by PR #5082 documentation because atomic publication landed
  in #4996 and the 21/21 B.7 acceptance landed in #5031. This does not close
  parent #3521.
- #3525's callable-default checkpoint is PR #5083. Keep its graph-global
  module-init M2 boundary explicit.
- #3526 R6 A1 remains a possible next independent behavior-neutral slice under
  the already-landed root-authored A1 plan in
  `plan/issues/3526-ir-r6-semantic-runtime-contract.md`, signed commit
  `1565e070d3985734641734b9c6676c9efd230361`: publish each manifest's selected
  exact records from the closed seven-record async catalog and remove the
  consumer's global `ALL_ASYNC_HOST_ADAPTERS` refilter. Full host async selects
  six mandatory records, `value.undefined` adds only the optional seventh, and
  Math-only/standalone-native select zero. The issue remains `blocked` for
  production R6 routing; this bounded static authority consolidation does not
  bypass #3521. Live `issue-assignments:3526.json` is reserved and unassigned,
  so allocate #3526 to the exact A1 implementation branch before spawning its
  implementation.
- Claims for #1719, #3521, and #3522 are held by `ttraenkler/codex` on their
  named branches. Keep them until the corresponding PR/checkpoint state is
  reconciled; release or reallocate explicitly afterward.

Suggested next-session order:

1. Staff a dedicated Sol PR shepherd, refresh main, and shepherd the six IR PRs
   above through protected merge; root owns the sweep until that slot is live.
2. Verify signatures, exact commit ancestry, checks, and issue/claim state.
3. Have root Sol write or update every implementation plan, then dispatch
   #1719 receiver-state and #3522 F3 to Sol implementation/review subagents only
   from their merged parents.
4. Implement and statically relock R2-v2; do not run its runtime collector
   before independent approval and a fresh strict load gate.
5. Use any remaining parallel slot for the bounded #3526 R6 A1 static slice,
   not for a speculative migration-wide cleanup.

Isolated worktrees used for the three new checkpoints were clean after push:

- `/private/tmp/js2-3521-r2-v2-plan-20260827`;
- `/private/tmp/js2-1719-cpr-standalone-normalizer`; and
- `/private/tmp/js2-3522-f2-owner-aware-direct-calls`.

Do not clean or reset the shared root worktree; its unrelated changes belong to
other work.
