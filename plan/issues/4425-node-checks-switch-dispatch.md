---
id: 4425
title: "runNodeChecks kind-indexed dispatch — mechanical restructure of the 95-block early-error guard chain"
status: done
completed: 2026-08-15
sprint: 78
created: 2026-08-15
updated: 2026-08-18
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: performance
area: compiler
goal: velocity
loc-budget-allow:
  - src/compiler/early-errors/node-checks.ts
---

# #4425 — kind-indexed dispatch for `runNodeChecks`

Follow-up to #4423 (PR #4519, merged) and its corrected rejected-early-out note
(PR #4521): restructure `src/compiler/early-errors/node-checks.ts` from a flat
chain of ~95 guarded checks evaluated for EVERY AST node into a
`SyntaxKind`-indexed dispatch table, so a node runs only the checks registered
for its kind.

## Why (measurements from this session, 2026-08-15)

All numbers from the corpus = test262 `language` + `annexB` + this repo's
`src/**/*.ts` (25,863 files, or a 1-in-3 sample of 8,621 files / 22.9 MB).
The box was heavily loaded (another session's 7 vitest workers + an acorn
compile), so wall-clock was abandoned in favour of process-CPU and
deterministic counting; treat CPU numbers as approximate, ratios as reliable.

- `detectEarlyErrors` baseline over the 8,621-file sample: **~38 s CPU** (best
  of 3, decreasing trend — treat as upper bound).
- Same with **all 95 check blocks removed, traversal + all other passes
  kept**: **~3.0 s CPU**. So the per-node check machinery is ~92% of
  detectEarlyErrors.
- CPU profile (1-in-9 sample): `runNodeChecks` **self** 5.7 s, the ~30
  distinct `ts.isX` guard calls ~2.5–3 s combined, the per-node recursion
  closure `(child) => runNodeChecks(ctx, child)` ~3.1 s, GC 1.15 s. The guard
  chain + traversal machinery is roughly **40% of detect CPU**; the remaining
  ~60% is fired check bodies (`isStrictMode` ancestor walks on every
  identifier, `isInsideClassWithPrivateName` 0.6 s, per-visit
  `new Set([...])`/array allocations, `getText`/substring).
- Context (PR #4521): a Set-based early-out that only SKIPPED no-check kinds
  measured **zero** on full compiles — most nodes have ≥1 registered check, so
  skipping alone buys nothing. The dispatch win must come from running ~1–6
  checks per node instead of evaluating 95 guards. The profile above says that
  guard-evaluation overhead is real (~40% of detect), unlike the skip-half.

## Design (implemented, NOT yet validated)

`on([kinds], (ctx, node) => { <original block, verbatim> })` registrations +
`NODE_CHECKS: NodeCheck[][]` indexed by `node.kind`; `runNodeChecks` hoists
one `visit` closure per file (was one per node) and runs only
`NODE_CHECKS[node.kind]`. Two safety invariants:

1. **Every block keeps its original top-level guard verbatim** — an
   over-registered kind is rejected by the guard, so the registered kind list
   can only LOSE diagnostics (caught by the differential), never admit new
   ones.
2. **Registration in original chain order** ⇒ per-kind execution order is
   exactly the original relative order (checks of other kinds could never fire
   on the same node anyway).
3. **Traversal is unconditional** — dispatch selects checks, never whether a
   subtree is visited. (The #4423 first early-out attempt returned before the
   recursion and lost 46% of diagnostics; that is the failure mode to avoid.)

The file was **generated, not hand-edited**: `.tmp/gen-dispatch.mts` (in the
worktree, gitignored) parses the original with the TS parser, slices each of
the 95 top-level if-statements out by exact source range (leading comments
included — no transcription of `  ` regexes or anything else), derives
each block's kind set from its own guard, and cross-checks against a
hand-written 95-entry catalog. Both derivations agreed on all 95 blocks.
Hand-transcription was attempted first and immediately produced a corrupted
`/[  ]/` regex — do not hand-edit this transformation.

## Resumed & validated (2026-08-15, remote session)

Work resumed on branch `claude/compiler-speedup-xqgm1z` (PR #4522's head merged
in; the old worktree's gitignored harnesses were lost and regenerated from the
descriptions below). Every checklist item ran green:

1. **Typecheck**: `pnpm run typecheck` (TS7, the CI `quality` lane) — clean.
2. **Prettier**: already clean (lint-staged formatted on merge).
3. **Differential**: regenerated `ee-diff.mts`; corpus test262
   `language`+`annexB` + `src/**/*.ts` = 25,861 files (main drifted from the
   25,863 recorded pre-suspend). Base (origin/main node-checks.ts) vs
   refactored, file-copy A/B: **23,983 diagnostics each, 0 exceptions,
   byte-identical JSONL** (`cmp` clean).
4. **Guard-evaluation counter** (measured, load-independent): 5,328,845 nodes
   visited; before = 95 guards/node = **506,240,275** evaluations; after =
   **15,521,510** check invocations (56 registered kinds, avg 2.91
   checks/node) — **32.6× fewer**.
5. **Early-error suites**: issue-4417 / issue-1931 / issue-2929 / issue-3632 —
   65/67 pass; the 2 failures (issue-3632 standalone `js2wasm:runtime-eval`
   wasm import) reproduce identically on the pre-refactor baseline —
   pre-existing, environmental, unrelated.
6. **Detect CPU A/B on a quiet 4-core box** (1-in-3 sample, 8,621 files,
   parse-once/time-detect-only, 3 iters × 2 interleaved rounds):
   base ~11.8–12.0 s CPU steady-state, refactored ~4.7–5.2 s —
   **~2.4× faster (−60% detect CPU)**, identical diagnostic totals. Better
   than the predicted ~40% guard-machinery share; the hoisted per-file visit
   closure accounts for the rest.

## Suspended Work (historical — resumed above)

- **Worktree**: `/workspace/.claude/worktrees/issue-4425-node-checks-switch-dispatch`
- **Branch**: `issue-4425-node-checks-switch-dispatch` (based on upstream/main
  at `adfa21c32`, with PR #4521's branch merged in)
- **State**: the generated dispatch version of
  `src/compiler/early-errors/node-checks.ts` is committed on this branch.
  **No gate has passed yet.** The PR carrying this is a DRAFT and must not be
  un-drafted until the checklist below is green.
- **Gitignored artifacts in the worktree's `.tmp/`** (lost if the worktree is
  deleted — regenerate as described):
  - `node-checks.base.ts` — pristine pre-refactor copy (= the file at merge
    base; recover with `git show <base>:src/compiler/early-errors/node-checks.ts`)
  - `gen-dispatch.mts` — the generator (rerun:
    `npx tsx .tmp/gen-dispatch.mts .tmp/node-checks.base.ts <out>`)
  - `ee-diff.mts` — diagnostics differential harness; dumps one JSONL row per
    diagnostic over the corpus in deterministic file order
  - `ee-base.jsonl` — **baseline differential output on the pre-refactor
    tree**: 25,863 files, 23,979 diagnostics, 0 exceptions
  - `ee-time.mts` — CPU-time harness (parse once, time detect only)
  - `ee-count.mts` — deterministic guard-evaluation counter (written, NEVER
    RUN — the box was taxed and the session was suspended here)

### Resume checklist (in order)

1. `npx tsc --noEmit` in the worktree — was started, killed before finishing;
   **completely unverified**. Fix any type errors (the generated wrappers use
   `(ctx, node)` params shadowing nothing; `node` is `ts.Node`, original
   guards narrow).
2. `pnpm exec prettier --write src/compiler/early-errors/node-checks.ts` (the
   generated layout is not prettier-clean).
3. Re-run the differential: `npx tsx .tmp/ee-diff.mts .tmp/ee-new.jsonl`, then
   `cmp .tmp/ee-base.jsonl .tmp/ee-new.jsonl`. **Byte-identical or the change
   does not ship.** If the baseline file is gone, regenerate it from the merge
   base's node-checks.ts (swap the file, run, swap back — file-copy A/B, no
   stash).
4. Run `.tmp/ee-count.mts` for the load-independent numbers (guard evaluations
   before = 95 × nodes; after = Σ registered checks per node; expected
   somewhere around 10–30× fewer — REPORT THE MEASURED NUMBER, this predicted
   range is not evidence).
5. Early-error test files: `npm test -- tests/issue-4417-early-error-false-positives.test.ts`
   plus grep `tests/` for other early-error suites.
6. On a quiet box (or CI), optionally re-measure detect CPU A/B for the PR
   body; under load use only CPU-time ratios and the counter.
7. Un-draft the PR, let auto-enqueue take it. The issue frontmatter status
   flips to `done` in that same PR (self-merge path).

### Known open questions

- Whether the ~40% guard-machinery share translates into a comparable
  detect-time reduction (indirect-call overhead of the closure array vs the
  inlined predicate chain is unmeasured).
- The remaining ~60% (check bodies) is untouched here and is the larger prize:
  `isStrictMode` memoization, hoisting per-visit `new Set`/array constants,
  `isInsideClassWithPrivateName`. Deliberately out of scope for this
  mechanical PR — file follow-ups with measurements.
