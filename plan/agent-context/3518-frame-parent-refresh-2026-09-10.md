# Frame extraction parent refresh

Refresh PR5755 from `9505d0860529cf6bedf887d68c2670130d8422b3` onto its
immediate parent PR5754 at `e72b5acfcb02852f356a814497a6d2d06dd6e3d0`.
Merge preview: `7e57cdc2e0581825d685e9b2e9bf3f56711859b4`.
Only appended issue3518 history conflicted; both complete sections remain.
All nine PR-owned source/test files match the original head exactly. The
native-delay standard-EH repair matches the parent byte-for-byte.

The three-file frame ownership, source-preservation and semantic-provider
boundary run completed EXIT0 on Node25.9.0/macOS ARM64. Full test receipt:
`/private/tmp/js2-5755-parent-refresh-tests-20260910.json`.
No fixture or expected outcome was changed. This is current execution evidence,
not historical byte equality: the historical frame comparator still requires
its original baseline and complete five-artifact/twelve-execution population.
All original failure and three-arm evidence remains preserved.

Keep the conformance hold. Continue parent-first through PR5756, PR5757,
PR5758 and PR5759. At PR5759, deliberately carry the standard-EH repair into
the extracted runtime delay body, preserving both tagged and foreign catches;
do not restore its legacy try or reseed original preservation receipts.


## 2026-09-12 queue-drain continuation

The earlier temporary worktree is unavailable on this host, and published
comment 5646241014 contains only its local pathname. This continuation starts
from existing PR5755's published a42660c8974d75a06586cd7ce890e1c61d73c0f2.
Current main 06f4cfa4aca3cfa20f1e5c03738956407ec2fedb merged cleanly in
`.claude/worktrees/codex-5755-queue-drain-20260912`. The root worktrees and all
old corpus links, probe fixtures and untracked additions remain preserved.

Main's async wrapper changes are intentional: preserve host Promise.all
suspension, host-aware spill planning, and the optional four-argument
Promise_then2_frame reaction ABI with the three-argument fallback. Eight of
nine original frame source/test files were byte-identical immediately after
the merge; the wrapper alone incorporates these main changes. The extracted
engine and native-delay standard-EH implementation remain unchanged.

The independent corpus is pinned to
b363f29d3c43c626dc852744ad64a0b48a003693, with 53,889 test and 44 harness files
verified against raw Git blob hashes and exact file sets/modes, no extras,
no alternates or shared hardlinks. The original corpus's 25 untracked and
seven ignored records are preserved. Manifest SHA256:
fcaaff56a78c134e3875a00b743d5e6435939c38f304eeec1ffb35bc3c611ffb.
Before/after verification and the retained first verifier refusal live under
`.tmp/5755-queue-drain/corpus-*` in the owned worktree.

Fresh Node25.9.0/macOS ARM64 single-fork validation passed 178/178 across
frame ownership (29), semantic-provider boundary (113), inline Promise.all
(8), and conditional-await operands (28), with no skipped or failed tests.
The separate public-source comparator passed its one selected test: five
artifacts and twelve executions, including eight family scenarios. Its
verdict explicitly says historicalPair NOT_RUN, physical acceptance false,
and retirement false. Evidence: `.tmp/frame-body-preservation-k5FiOC`.
Do not combine those facts into historical byte equality. The original 0194
baseline retains legacy native-delay EH, while main deliberately repairs it.
All old historical receipts and failures remain authoritative records.

Source typechecking, explicit-main-base LOC/function budgets, coercion,
oracle and preservation-v1 dead-export checks passed. The latter still
reports strict modeled closure OPEN for getBinaryenModule and
resolvePlatformCapabilityImport nonliteral dynamic imports; preservation
witnesses are 6/6 in both full and cut graphs. Conformance synchronization
changed zero files. Normal commit/push hooks remain mandatory; final source-preservation
validation is recorded below.

Delivery order remains 5755 → 5756 → 5757 → 5758 → 5759 → 5760. Retarget the
existing PR5755 to main before its normal push, then require CI and protected
queue delivery at the exact verified head. Do not open a duplicate PR.
Use published e3a01efa44f68da1b93c16b1a728d0ba099183f9 for PR5756, never
fea8c3f413. Preserve PR5760's existing expanded integration scope, including
its merged PR5763 work. At PR5759 carry signed standard-EH delay repair
561853c00d76c72eb44dbee14340dc15e9841e41 with both tagged and foreign catches.
New result-adapter and other migration scope remain paused.

No callable passive GitHub subscription exists in this session. The local
ci-status writer workflows are disabled/manual-only. Existing instructions
prohibit scheduled polling; name this event-delivery limitation rather than
installing a poller or treating an unobserved run as passed.


The forward source-preservation repair is now validated: 41/41 tests pass,
including all 20 original source controls, 20 additional forward-provenance
controls and the unchanged public-source oracle. The seven admitted spans
are verified against pinned a42660c8/06f4cfa4 Git blobs and recorded line
ranges; the full ordinary async-cps import includes its module source and
import kind. Reverting, corrupting or duplicating a forward span is refused.
The inverse projection matches the complete original a426 wrapper SHA256
before the unchanged 0194 donor receipts are checked. No original historical
or bridge receipt was reseeded; the public comparator is byte-identical.
Fixture raw SHA256:
3f01c4d7c04f39f8be68e00bc34025228e759287292bcb7739f5292c266ddbb7.

The final scoped population is 219/219 across five files (178 existing
ownership/boundary/main regressions plus 41 preservation tests), no failures
or skips. Full normal commit/push hooks remain mandatory. The default
pre-commit selector currently sees 26 inherited root test changes relative
to its old merge base and therefore self-skips its >20-file lane; the 219
scoped tests were run directly and are not a claim that those 26 files ran.
Actual signed commit, push-hook and CI/queue outcomes will be recorded in the
existing PR follow-up. Preserve the retained original positive failure and
all corpus verification artifacts.
