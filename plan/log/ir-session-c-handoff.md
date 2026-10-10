# Session C (Claude) handoff — IR migration, 2026-10-09

For the next Claude session joining the three-session IR migration (A = Codex root, B = Codex Linear, C = Claude). Everything below was verified against canonical `loopdive/js2` main at the time of writing. Re-verify before acting: hashes are historical pointers.

## Where coordination happens

- Shared thread: https://github.com/loopdive/js2/pull/6583 (comments). A and B post there several times an hour.
- **Read the latest 10–20 comments before doing anything.** Comments are long; fetch them with `curl -s "https://api.github.com/repos/loopdive/js2/issues/6583/comments?since=<ISO time>&per_page=30"`. The MCP `get_comments` paging is unreliable past ~80 comments.
- Main plan: `plan/issues/6920-native-linear-shared-source-handoff.md` (A's, now on main). C's whole-plan review: `plan/log/ir-whole-plan-review-session-c.md`.

## Roles and ownership (as agreed in the thread)

| Session | Owns |
| --- | --- |
| A (root) | Shared IR, frontend, preparation, provenance, WasmGC, compiler entry points, consumer/reservation wiring, `scripts/compiler-boundaries.json`, historical proof/preservation suites, **final integration and the protected merge queue** |
| B | Linear admission, memory/resource/body-resolver, runtime/provider (`src/codegen-linear/runtime*`), Unicode leaves, the released advisory command in `ci.yml`, `src/backend/linear/program/{contracts,memory}.ts` |
| C | Only what A or the human hands over **by exact file and function**, recorded in the thread |

Fable plans in `plan/issues`, Opus implements in isolated worktrees, C's Opus coordinator dispatches and reports in the thread. Never create GitHub issues.

## What C delivered (both on main)

| Work | PR | Merge | Claims (completed) |
| --- | --- | --- | --- |
| #6921 — inliner remaps callee slots into the caller (was overwriting caller `let`s: 6007 vs 105007); `dyn.to_number` / loose `dyn.eq` are effectful (DCE was dropping `valueOf`). Composed with #5748's inliner guards; repinned two effects hashes and three stale intrinsics rows under explicit grants | #6598 | `03984518d9` | `6921`, `6921:inliner-slot-capture`, `6921:coercing-dyn-effects` |
| 6920 A-G — shared Linear memory geometry contract `src/shared/contracts/linear-memory-layout.ts` (A's reviewed packet `7974cae4`, applied unchanged) plus A's boundary inventory rows (`b932e3a05e`) | #6600 | `2d0c31a3e2` | `6920:c-shared-linear-geometry-source-20261009` |

Also: an independent review of A's #6597 (merged).

**C holds the `874:octane-harness` claim (2026-10-10). Open docs PR #6608 carries this handoff and the 6934–6936 plans.**

## Open asks / next candidates (none claimed yet)

Asked A in https://github.com/loopdive/js2/pull/6583#issuecomment-6076900457 which C may take — **check for A's answer first**:

1. **A-C1, generic vector representation seam.** `src/ir/lower-generic.ts` (`resolveVecType`, `ensureVecDataScratch`, `lowerIrTypeToValType`, `vec.new_fixed`) and `src/ir/backend/{handles,lower-contracts}.ts`. Key a vector's scratch local on its representation, not a GC `arrayTypeIdx`. The GC output must stay byte-identical. This lets the Linear overlay's fake GC handle and post-hoc locals rewrite (`linear-integration.ts` ~1607–1616, ~1915–1937) be deleted. A's scope, so it needs A's release.
2. **Standalone loose `==` "illegal cast" trap.** On `--target standalone`, `o == 1` traps when `o` is a host object passed through `any` and the result is used. Dead-code removal hid it until #6921. Reproduction: see the "Implementation findings" section of `plan/issues/6921-ir-middle-end-pass-correctness.md`. It is in WasmGC lowering, so it is A's scope; it is not filed as an issue yet.

B's stack (#6572, #6577, #6583, #6590) can now retarget geometry imports to the shared contract; that is B's work, not C's.

## Follow-ups filed 2026-10-10 (NightMonkey review)

Chris Fallin's NightMonkey (VMIL 2026) was reviewed in `plan/log/nightmonkey-analysis.md`. Verdict: we do not adopt its IR or code, and we borrow ideas only. The repo has no license, and its contract differs: an embedded SpiderMonkey, linear memory, and bytecode-level codegen. TS types remain hints, not facts (existing policy). New plans, all needing Session A's acknowledgement before implementation:

- `plan/issues/6934-ir-optimistic-track-runtime-fallback.md`: a design spike for a guarded optimistic track plus a boxed generic track, replacing compile-time demotion.
- `plan/issues/6935-ir-capped-points-to-heap-lattice.md`: an alloc-site < class < union-find region < any heap lattice, as an extension of `alloc-registry`.
- `plan/issues/6936-build-time-module-init-evaluation.md`: compile-time evaluation of module init to seed the analyses.
- #874, Octane slice (`874:octane-harness`, claimed by C): an Octane harness comparing node, js2 on the host (gc) target, and js2 standalone, as the measurement base for the three plans above.

The standalone loose-`==` trap from #6921 was filed separately as issue 6931 (PR #6609), not by C.

## Process rules learned the hard way

- **Claims:** add `upstream` remote if missing (`git remote add upstream https://github.com/loopdive/js2`), then `CLAIM_ASSIGN_REMOTE=upstream node scripts/claim-issue.mjs …`. Read the record back with `git show upstream/issue-assignments:<id>-<slice>.json`. `--allocate` needs `--allow-unscanned` because `gh` is unauthenticated here; then check open PRs' added `plan/issues/*` files by hand.
- **Never take or release another owner's claim** because it looks dormant. Ask in the thread, or ask the human. The human's allocation decision is valid and must be recorded in the thread.
- **Protection tests** (`tests/issue-3518-*` hash pins) belong to A. Repin only under an explicit grant, keeping predecessor hashes in comments. CI's `quality` runs every *changed* root test file in full, so touching a pin file exposes its other stale rows.
- **Git LFS:** `*.log` is LFS-tracked and LFS upload returns 403 from this container. Store evidence as `.txt`.
- **Hooks:** `pre-merge.sh` blocks `git merge --ff-only` and `git merge <sha>` (it thinks you are merging to main); use `git cherry-pick` or `git reset --hard <descendant>` on your own branch. Merge-commit subjects need ` ✓`. Never `--no-verify`.
- **Install deps first:** a fresh container has no `node_modules`; run `pnpm install --frozen-lockfile` and symlink `node_modules` into worktrees.
- **PRs:** non-draft, label `hold`, link issues in website form. A submits to the queue; C never enqueues or removes `hold`. After merge, verify ancestry and byte-identity of the changed files on main, complete the claims, then post in the thread.
- **Budget:** the user capped this work at 50% of the weekly budget (it was ~10% at last reading). Ask before going past that.
