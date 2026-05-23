# Sprint 53 Retrospective

**Sprint**: 53
**Dates**: 2026-05-20 → 2026-05-23
**Theme**: Async-model groundwork + Wasm-closure bridge + ESLint Tier 1d/1e unblockers

---

## Results

| Metric | Value |
|--------|-------|
| test262 at start | 28,233 / 43,160 (65.5%) |
| test262 at close | 28,842 / 43,159 (66.8%) |
| Net gain | **+609 passes** (+1.3 pp) |
| Sprint 53 issue files | 28 (14 done, 5 carried to S54, 9 artifacts) |

(Net gain reflects baseline at sprint start vs. the latest sharded baseline on
`main` at sprint close — not isolated to S53-only issues.)

---

## What landed (sprint 53 issue files)

**Spec/protocol gaps:**
- #1129 ToObject (§7.1.18) — primitive auto-boxing
- #779b class/elements multi-definition parsing
- #779c String.prototype.split result `.constructor` is `Array`
- #820a RegExp Symbol.match/replace/search/matchAll/RegExpStringIterator null deref (~148 fails)
- #820b object-literal computed-property accessor names no longer silently dropped (~30 fails)
- #820c async-gen object-method yield* iterator-protocol null deref (~39 fails)

**ESLint critical path (Tier 1d/1e unblockers):**
- #1557 ESLint config.js `__obj_meth_tramp` arity mismatch
- #1558 ESLint linter.js `Linter_verifyAndFix` f64.eq i32→f64 coercion
- #1559 ModuleResolver bare-package import resolves to impl, not .d.ts
- #1560 CJS class re-export linkage to compiled class

**Destructuring refactor foundation:**
- #1553a thread `mode:'decl'` + `bindingKind` through `destructureParamObject/Array`
- #1553e f64-array literal with explicit `undefined` element triggers dstr default

**Codegen reshape:**
- #804 extract new-expression handling from `expressions.ts`
- #806 extract increment/decrement from `expressions/unary.ts`

Plus extensive infrastructure work that landed alongside (visible in the
~2,200 commits between 2026-05-20 and 2026-05-23): CI shard parallelization,
auto-retry on `compile_timeout`, `#1589` hot-spot diagnosis + skips, gate-check
parallelization, sharded baseline pipeline, async-cluster architect spec
written, and dozens of S52-carry-over spec-gap PRs (#1042, #1116, #1151,
#1373, #1373b, #1382, #1394, #1400, #1438, #1455, #1482-#1484, etc.).

---

## Not completed — carried to S54

| Issue | Reason | Status |
|-------|--------|--------|
| #1553b | Typed-struct decl-mode delegation; depends on #1553a foundation already landed | in-progress |
| #1553c | Externref-fallback decl-mode delegation; blocked on #1553b | blocked |
| #1553d | Array decl-mode delegation (largest slice, ~1,100 LOC consolidation); blocked on #1553c | blocked |
| #820d | class/dstr async-gen-meth default-init `unresolvable` illegal cast (104 fails); needs param-list closure rework | ready |
| #1580 | string-hash benchmark wasm-validator + uncompetitive perf | ready |

The destructuring cluster (#1553b/c/d) is the major structural carry-over —
the foundation (#1553a) is in, but the actual call-site delegation work
(replacing ~1.5 kLOC of hand-rolled branches with shared helpers) was not
attempted this sprint. #820d hangs off the same param-list closure machinery
that #820a/b/c touched.

---

## What went well

- **ESLint Tier 1d/1e unblocked.** Four targeted fixes (#1557/#1558/#1559/#1560)
  landed cleanly, all referenced in the sprint goal. This unblocks downstream
  Tier 1e harvesting in S54.
- **820 cluster decomposition worked.** Splitting #820 into #820a/b/c/d before
  dispatching gave four small parallel-safe issues; three of four shipped.
- **CI shard infrastructure.** Bumping to 115 shards and auto-retrying
  compile_timeout in isolation (#1589 series) makes the gate both faster and
  less flaky.
- **+609 test262 passes** in three days, with the underlying spec-gap and
  destructuring work compounding.

---

## What went wrong

- **Status drift was severe.** Nine sprint-53 issue files had stale
  `status: in-progress` / `ready` / `needs-spec` frontmatter at sprint close
  despite their PRs having merged. The dev-self-merge protocol updates the PR
  but does not always touch the issue file. This closeout swept those nine
  back to `done`; the underlying pattern needs a post-merge hook.
- **The original sprint goal (async-model groundwork) did not really land in
  S53 files.** #1042 / #1116 / #1151 / #1373 / #1373b were tracked under
  s52/backlog and progressed there, but their relationship to sprint 53 was
  not maintained in `plan/issues/sprints/53/`. The sprint goal section
  described work that was happening elsewhere in the repo.
- **Carry-over cluster (#1553b/c/d) didn't move.** All three are still
  `in-progress`/`blocked` after three days — the dependency chain
  (b → c → d) means a single dev's bandwidth gates the cluster. Sprint 54
  should either parallelize by spinning off #1553b/c/d into independent slices
  or assign dedicated single-thread ownership for the chain.
- **No begin/end sprint tag pushed during S53.** `sprint-53/begin` was not
  tagged at start (the closeout cannot retroactively compute durations from
  tags). `sprint/53` is created locally as part of this closeout but not
  pushed — tech lead to push if appropriate.

---

## Process suggestions

1. **Post-merge issue-status hook.** After `gh pr merge --auto` lands, scan
   the PR title / body for `#N` references and offer to flip
   `plan/issues/sprints/*/N*.md` frontmatter to `status: done`. The drift
   we saw is mechanical, not judgment-based.
2. **Sprint goal vs. sprint dir alignment.** Either move all goal-issues into
   the sprint dir at planning time, or document explicitly in the goal section
   that "these issues live in other dirs but their work counts toward this
   sprint." Today the goal section mentioned issues whose files were in s52.
3. **Dependency-chain ownership.** For cluster-style refactors with hard
   serial dependencies (like #1553a→b→c→d), assign a single dedicated dev
   for the whole chain at planning time rather than spreading across the
   pool — the inter-issue dependency cancels parallelism gains.
4. **Tag at sprint start, always.** Add `git tag sprint-N/begin && git push
   origin sprint-N/begin` to the sprint kickoff checklist; this enables the
   `build:pages` sprint-stats generator to work.

---

## Carry-over summary (for S54 planning)

5 issues moved into `plan/issues/sprints/54/`:
- #1553b/c/d (destructuring decl-mode delegation chain)
- #820d (async-gen-meth unresolvable cast)
- #1580 (string-hash benchmark perf)

S54 should treat #1553b/c/d as a sequential chain (one dev), and #820d / #1580
as independent parallel-safe work.
