---
id: 6797
title: "arch: codegen, ir and frontend form one 693-file strongly-connected component (40 % of src, 3,083 circular chains) — add an import-cycle ratchet and cut the 74 ir→codegen edges first"
status: suspended
sprint: Backlog
created: 2026-09-30
updated: 2026-10-02
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: refactor
area: compiler
language_feature: compiler-internals
goal: compiler-architecture
related: [912, 1172, 3113, 4601, 6793, 6808]
assignee: "ttraenkler/claude-dev-6797"
branch: "claude/issue-6797-import-cycle-ratchet"
requested_by: ttraenkler/claude-review
origin: "2026-09-30 codebase review (plan/agent-context/claude-codebase-review-2026-09-30.md) — arch #1/#2"
---

# #6797 — the documented IR retirement path cannot be executed layer-by-layer

## Measurements (2026-09-30, HEAD e303c5c7)

- `src/` = 904,803 lines / 1,738 files; 48 files > 3,000 lines;
  `src/codegen/` has **824 files (473,840 lines) flat** in one directory.
- Tarjan SCC over value imports (3,345 type-only imports excluded): 5 SCCs;
  the largest is **693 files** (681 codegen + 11 ir + 1 frontend); 105 mutual
  A↔B pairs. `madge --circular src/index.ts`: **3,083** circular chains over
  1,569 files. Example: `codegen/stdlib-selfhost.ts → frontend/builtins/build-ir.ts
  → ir/from-ast.ts → … → codegen/function-body.ts`.
- Directory-level two-way edges: codegen↔ir **310 / 74**, backend↔ir 97/20,
  frontend↔ir 17/7, codegen-linear↔ir 9/4, checker↔ir 1/8, ir↔runtime 7/1.
- Fan-out leaders: `codegen/index.ts` 279 imports, `expressions/calls.ts` 139,
  `ir/integration.ts` 109. God functions in `codegen/index.ts`:
  `generateModule` 1,909 lines (`:5229`), `generateMultiModule` 1,301
  (`:10552`), `planIrOverlay` 650, `emitIteratorMethodExport` 621,
  `resolveWasmType` 556. `check:godfiles` is **red on main** (two new
  mega-functions) and is not run in CI.
- `docs/architecture/codegen-axes.md` says the IR "replaces the hacks";
  `plan/log/ir-adoption.md`: 20 ir-owned / 31 mixed / 1 direct-only / 14
  deferred. The `*-native.ts` → `src/backend/wasmgc/` move
  (`target-architecture.md`) is half done: 42 files in `codegen/`, 49 in
  `backend/wasmgc/`, no progress marker. #912 (done) removed cycles once;
  nothing prevents them from returning.

## Correction

1. **Ratchet, not a big-bang.** `scripts/check-import-cycles.mjs`: Tarjan over
   `import … from` (value imports only), baseline
   `scripts/import-cycles-baseline.json` = {largest SCC size, total chains,
   per-directory two-way edge counts}. Fails on growth; `--update-on-decrease`
   banks improvements post-merge (same shape as `check:ir-fallbacks`). Wire
   into `quality`.
2. **Cut ir → codegen first (74 edges).** The IR must not import the legacy
   backend; each edge is either a shared type (move to `src/shared/`), a
   helper both need (move to `src/backend/wasmgc/`), or a real dependency
   inversion (inject via the `IrBackend` interface). List the 74 edges in a
   follow-up slice issue with an owner each.
3. **Directory budget for `src/codegen/`.** A `check:flat-dir-budget` that
   fails when `src/codegen/*.ts` (non-recursive) grows; new files go into the
   sub-directories the layout already has.
4. Put `check:godfiles` in `quality` (after refreshing its baseline in the
   same PR — it is red today), or delete it.

## Acceptance

- `pnpm run check:import-cycles` exists, is required in `quality`, and its
  baseline is committed with the numbers above.
- ir → codegen value-import count reaches 0 (tracked in the baseline);
  `docs/architecture/codegen-axes.md` gets a "how to verify" line pointing at
  the script.
- `src/codegen/` flat file count does not grow.

## Follow-up: `check:godfiles` stays out of `quality` (Correction item 4)

Not wired, and its baseline (`scripts/godfile-profile-baseline.json`) is not
refreshed: making it green would RAISE 24 per-function ceilings and add 23 new
ones, which is relaxing the gate, not refreshing it. Measured 2026-10-02 on
`39cc565790` with `node scripts/profile-godfiles.mjs --check` (exit 1,
47 regressions; the 2026-09-30 review's "two new mega-functions"
undercounts it). Old→new LOC, or `new` for a
function over the 150-LOC tracking floor that the baseline does not know:

- `src/codegen/index.ts` (20): generateModule 1269→1910, generateMultiModule 768→1302, planIrOverlay 554→651, emitIteratorMethodExport 169→622, resolveWasmType 380→557, emitToPrimitiveMethodExports 419→516, buildIrClassShapes 298→512, emitDispatchForMethod 411→479, ensureStructForType 380→453, emitMethodDispatch new 441, walkStmtForLetConst 208→284, planIrFirstBodyRouting 158→278, emitClassMemberKindExports new 264, registerImportBindingAliases new 245, buildDispatch 162→235, aliasOneBinding new 219, hoistVarDecl new 201, registerReassignedFunctionGlobals new 197, emitExternrefClassVarargDispatch new 160, preparedExactLexicalModuleInit new 152
- `src/codegen/object-runtime.ts` (9): ensureObjectRuntime 4234→4725, fillApplyClosure 477→704, fillExternArrayLikeStructArms 310→540, fillClosedStructExternGetArms 317→519, fillDynamicForinVecArms 302→435, fillConcatNativeHoleArms new 310, fillExternSetVecArms new 302, fillExternGetIdxVecArms 159→266, fillClassObjectNameArms new 153
- `src/codegen/array-methods.ts` (9): compileArrayMethodCall 531→723, emitDynViewSpeciesMethodTwoArm new 298, compileArraySplice 191→275, compileArrayReduceRight 221→265, compileTypedArraySet new 192, compileArrayMap new 172, compileArrayReduce new 169, compileArrayToSpliced new 168, compileArrayConcat new 165
- `src/codegen/expressions/calls.ts` (8): compileCallExpression 1811→2305, ensureFuncValueWrappersRegistered new 490, buildInlineDynamicDispatch new 454, compileIIFE 263→315, tryRuntimeEvalInterpretedBoundaryIntrinsic 189→239, emitReflectiveNativeProtoClosureCall new 193, tryEmitNativeProtoReflectiveCall new 192, emitDynamicSpreadCall new 190
- `src/codegen/native-strings.ts` (1): emitExceptionRenderExports new 211

What is still enforced: the required `check:func-budget` gate (#3400) already
blocks any change-set that grows a function over 300 LOC or adds a new one,
so the functions above 300 cannot grow further. The 150–300 LOC band is
unguarded. Options for whoever picks this up: shrink the listed functions
back under their recorded LOC and then wire the gate, or delete
`profile-godfiles.mjs --check` as redundant with `check:func-budget` and keep
the profiler for its report. Either needs a decision, not a baseline refresh.

## Implementation Plan

**Scope (orchestrator decision, 2026-10-02):** this PR does Correction items
1, 3 and 4 — the measurement and ratchet tooling. Item 2 (cutting the 74
ir → codegen edges) is NOT in it; the cut list it asks for is filed as
[#6808](6808-ir-to-codegen-edges-cut-list.md), with every edge grouped by
remedy. The issue stays `in-progress` until #6808 lands.

1. `scripts/check-import-cycles.mjs` (`pnpm run check:import-cycles`).
   Graph: every `.ts` under `src/` (no `.d.ts`); an edge per importer →
   imported file pair with at least one VALUE reference (static import,
   re-export, side-effect import, dynamic `import()`, `require`). The
   value/type split reuses `references()` from
   `scripts/check-compiler-boundaries.mjs` (now exported), so `import type`,
   all-inline-`type` imports, `export type … from`, `import("x").T` and
   `/// <reference>` are skipped exactly as that gate classifies them.
   Tarjan (iterative) gives `largestSccSize` and `sccCountOver1`;
   `twoWayDirEdges` holds both directions of every pair of first path
   segments under `src/` that import each other (a root-level file is its own
   segment, so leaf modules like `ts-api.ts` do not pair with everything).
   Baseline `scripts/import-cycles-baseline.json`; any growth or a new
   two-way pair fails; `--update-on-decrease` banks drops (min per number);
   `--update` (re)seeds; `--verbose` prints the SCC and every cross-directory
   edge. Wired into `quality` (`ci.yml`) and banked by `promote-baseline`
   (`test262-sharded.yml`) inside its re-anchor loop only — never through
   the pre-loop snapshot, because the PR gate reads this baseline and a
   value from an older checkout could undercut main. No post-merge job runs
   `check:ir-fallbacks -- --update-on-decrease` today, so the call sits next
   to the `check-func-budget --update-on-decrease` one instead.
2. `scripts/check-flat-dir-budget.mjs` (`pnpm run check:flat-dir-budget`):
   counts `src/codegen/*.ts` (non-recursive), baseline
   `scripts/flat-dir-budget-baseline.json`, fails on growth,
   `--update-on-decrease` banks drops (promote-baseline and
   baseline-summary-sync re-anchor loops). Wired into `quality`.
3. `check:godfiles`: run, not refreshed, not wired — see the follow-up
   section above.
4. `docs/architecture/codegen-axes.md`: "How to verify the layering"
   section pointing at the three layering scripts.

Tests: `tests/check-import-cycles.test.ts` (3-file cycle; three type-only
forms not counted; multi-line `import x, { y }`, `export … from` and dynamic
`import()` counted; growth fails; decrease passes and `--update-on-decrease`
banks it; missing baseline refuses) and `tests/check-flat-dir-budget.test.ts`.

## Resolution

### Numbers (measured 2026-10-02)

| metric | issue (review, e303c5c7) | this script at e303c5c7 | baseline, 39cc565790 |
|---|---|---|---|
| largest SCC | 693 | 691 | 697 (685 codegen, 11 ir, 1 frontend) |
| SCCs with > 1 file | 5 | 5 | 5 |
| type-only excluded | 3,345 imports | 3,338 statements (3,517 refs incl. `import("x").T`) | 3,596 refs |
| codegen → ir / ir → codegen | 310 / 74 | 295 / 74 | 295 / 74 |
| backend ↔ ir | 97 / 20 | 97 / 20 | 115 / 22 |
| frontend ↔ ir | 17 / 7 | 17 / 7 | 17 / 7 |
| codegen-linear ↔ ir | 9 / 4 | 9 / 4 | 9 / 4 |
| checker ↔ ir | 1 / 8 | 1 / 8 | 1 / 8 |
| ir ↔ runtime | 7 / 1 | 7 / 1 | 9 / 1 |
| `src/codegen/*.ts` | 824 | 824 | 829 |

The remaining pairs in the baseline are root-file pairs the review did not
list (`compiler ↔ deadcode-elide.ts`, `frontend ↔ ts-api.ts`,
`runtime ↔ timer-capability-contract.ts`, `runtime.ts ↔ runtime-eval.ts`,
1–2 edges each).

**Why codegen → ir is 295, not 310, and the SCC 691, not 693, at the same
commit.** Re-scanning e303c5c7 with `import("x").T` type queries counted as
dynamic imports gives 308 and 692, so the review's scanner most likely
matched those type positions as `import(…)` calls; the last 2 edges and 1
file are not reproduced (its scanner was not committed). Counting import
statements instead of file pairs gives 303. The ir → codegen count (74) and
all the other pairs match exactly. **madge's 3,083 chains are not ratcheted**:
an elementary-cycle count depends on traversal order and grows
combinatorially with one new edge; SCC size and count carry the same signal
deterministically (orchestrator's choice of `sccCountOver1`).

**Drift since the review:** the SCC grew 691 → 697 and the flat directory
824 → 829 in two days. Replaying the gate over every first-parent commit
from e303c5c7 to 39cc565790 (46 PR merges): 8 merges would have failed —
4 by new codegen files joining the SCC (each also +1 or +2 flat files:
PRs #6394, #6396, #6399, #6416) and 4 by two-way edge growth from the #3518
boundary work (backend → ir 97 → 115, ir → backend 20 → 22, ir → runtime
7 → 9: PRs #6371, #6378, #6386, #6388). ir → codegen and codegen → ir did not
move. So expect roughly one PR in six to trip it until the SCC is cut; a
new codegen file joins the SCC whenever it imports anything in it and is
imported from it.

**Intended growth.** Like `check:ir-fallbacks` and `check:ir-layering`, the
gate reads a committed baseline, so a PR whose growth is deliberate runs
`node scripts/check-import-cycles.mjs --update` and commits the bump for
review. That is the opposite of the change-scoped gates
(`check:loc-budget` etc.), whose baselines PRs must not touch; whether this
gate should become change-scoped (frontmatter allowances, no baseline bumps)
is a follow-up decision if the bump churn hurts.

### Gates (all run bare, exit codes)

All exit 0 on `39cc565790` + this branch: `check:import-cycles`,
`check:flat-dir-budget`, `check:ir-dialect`, `check:ir-kind-neutrality`,
`check:jstag-seam`, `check:ir-layering`, `check:codegen-fallbacks`,
`check:any-box-sites`, `check:speculative-rollback`, `check:stack-balance`,
`check:pushraw`, `check:host-import-policy`, `check:ir-only`,
`check:ir-adoption`, `check:issues`, `check:done-status-integrity`,
`check:issue-spec-coverage`, `check:harness-compile-budget`,
`check:verdict-oracle`, `lint`, `format:check`, `typecheck`,
`check:dead-exports`, `check:issue-ids:against-main` (GATE_BASE=origin/main),
`check-compiler-boundaries.mjs --mode inventory`, `check:ir-fallbacks`,
`check-loc-budget`, `check-func-budget`, `check-coercion-sites`,
`check:oracle-ratchet`. Tests (single fork): `tests/check-import-cycles.test.ts`
6/6, `tests/check-flat-dir-budget.test.ts` 4/4; the type-only test fails when
the type-only skip is mutated out. `tests/issue-3518-compiler-boundaries.test.ts`
and `tests/issue-6418-boundary-verdict-in-log.test.ts` pass with `references()`
exported. `tests/issue-3113-ir-layering-gate.test.ts` fails one case on main
already (its committed baseline says 90 lines, the tree has 87 — an unbanked
decrease); this PR touches no `src/` file.

### Left out

- Correction item 2 → [#6808](6808-ir-to-codegen-edges-cut-list.md).
- `check:godfiles` → not wired (see the follow-up section above).
- `baseline-summary-sync.yml` installs no `node_modules`, so it banks only
  the flat-dir budget; its existing `check-func-budget --update-on-decrease`
  call already fails there (non-fatally) for the same reason.

## Suspended Work — follow-up PR (2026-10-02, lead handoff)

PR 6430 landed the ratchets **baseline-scoped**, and within four hours that
scoping parked two unrelated PRs for growth other PRs had landed (6431 for
5883, 6419 for 6422 — see #6823 item 5). dev-6797 had the change-scoped
version ready when the shared repository went bare (#6822); the agent cannot
be resumed until `core.bare` is repaired
(`plan/agent-context/claude-review-wave-handoff-2026-10-02.md`).

- **Worktree**: `/home/user/js2/.claude/worktrees/agent-adc6ee3039d92814a`,
  branch `claude/issue-6797-import-cycle-ratchet` at `c60ee5f34d` (17 local
  commits past its origin ref; 6430 merged from an older head, so this branch
  can no longer carry the work — create a NEW branch from the current HEAD,
  e.g. `claude/issue-6797-change-scoped-allowances`, then
  `git merge origin/main`).
- **Staged (10 files, 4 also modified unstaged; +530/−132)**:
  `scripts/check-import-cycles.mjs` and `scripts/check-flat-dir-budget.mjs`
  become CHANGE-SCOPED like `check:loc-budget` (fail when the metric is
  higher at HEAD than at the change-set's own base — HEAD^1 of the synthetic
  merge, merge-base fallback; growth granted by `import-cycles-allow:` /
  `flat-dir-budget-allow:` entries in the PR's own `plan/issues/*.md`, format
  `- largestSccSize: 699 # <date> (#N): <why>` / `- src/codegen/foo.ts # <date>
(#N): <why>`; the committed baselines stay the post-merge low-water mark and
  no-git fallback), plus GIT*\* hardening (`CLEAN_ENV` for every spawned git);
  `tests/check-import-cycles.test.ts` and `tests/check-flat-dir-budget.test.ts`
  (allowance, malformed-entry and GIT*_-stripping cases, their `git init`
  runs with GIT\__ removed); `.github/workflows/ci.yml` (both steps gain
  `git fetch --no-tags --depth=200 origin main` for the merge-base fallback,
  comments rewritten); `baseline-summary-sync.yml` and `test262-sharded.yml`
  (banking comments: the import-cycle twin needs `typescript`, which only
  promote-baseline installs); `docs/architecture/codegen-axes.md` (how to
  verify the layering, allowance syntax); this issue file (plan + Resolution
  §"Intended growth" updated) and `6808-…md` (+4).
- **Remaining**: new branch; merge `origin/main` (6430 already contains the
  baseline-scoped originals — take main's side only where the staged change
  does not supersede it); gates per the common brief incl.
  `check:import-cycles` / `check:flat-dir-budget` themselves and both test
  files; commit `feat(#6797): change-scoped allowances … ✓` with
  `Model: Claude Opus 5.5 Medium` trailers; push; PR (base main, not draft).
  Then set `status: done` here; items 2 (#6808) and 4 (godfiles, #6826) stay
  separate.
