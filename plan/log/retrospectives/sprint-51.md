# Sprint 51 Retrospective

**Sprint**: 51
**Dates**: 2026-05-08 → 2026-05-20 (closed mid-sprint due to context limit + repo restructuring)
**Theme**: Spec-completeness wave + IR retirement gate

---

## Results

| Metric | Value |
|--------|-------|
| test262 at start | 26,777 / 43,160 (62.0%) |
| test262 at close | 28,147 / 43,160 (65.2%) |
| Net gain | **+1,370 passes** |
| PRs merged | 70 |
| Issues completed | 34 / 50 |
| Issues carried to S52 | 16 |

---

## What landed

**Spec-gap closures (high impact):**
- #1358–#1369, #1377–#1382 wave: array callbacks, string methods, iterator helpers, promise combinators, class subclass builtins, private fields, array sort/splice/concat, for-of iterator close
- #1366a extends-error builtin subclassing
- #1370–#1374 IR slices: class methods/constructors, extern whitelist, destructuring params, async bridge, string for-in/for-of
- #1376 IR fallback telemetry gate

**Codegen fixes:**
- #1379 unary ++/-- on null/undefined/string (ToNumeric)
- #1380 equality/symbol/BigInt + ReferenceError propagation
- #1384 static async method private name CE
- #1385 Temporal duration hang, #1386 promise.race hang
- #1388 null next yield* in async gen class methods
- #1389 false CE var/function redecl top level
- #1390 import.defer no-test-export CE
- #1391–#1393 CI staleness detection, content-hash cache, baseline pipeline fixes
- #1395 bare class identifier resolves through classExprNameMap

**Infrastructure:**
- IR fallback telemetry gate (#1376) with baseline enforcement
- CI compile_timeout classification groundwork
- fetch-ecma262.sh script for spec pulls to labs

---

## Not completed (carried to S52)

| Issue | Reason |
|-------|--------|
| #1396 forof-dstr externref OOB | Ready, full impl plan — dispatched S52 day 1 |
| #1431–#1438 spec-gap cluster (8) | Added late (May 11); dispatched S52 day 1 |
| #1373 IR async function | Depends on #1326c microtask queue |
| #1373b IR async CPS | Blocked on #1373 |
| #1382 wasm closure bridge | No impl plan written; needs architect |
| #1394 method closure caching | No impl plan written |
| #1387 with statement | Hard; deprioritized |
| #1392 benchmark browser hang | Infra; low priority |
| #1400 ESLint valid wasm | Medium; not started |
| #1326c microtask queue standalone | Prerequisite for #1373 |
| #1364 class descriptors | Blocked on #1334 |

---

## What went well

- **70 PRs merged** in one sprint — the batch dispatch model with dev self-merge worked at scale.
- IR retirement gate (#1376) is now enforced in CI — concrete gate keeps progress honest.
- Spec-gap issues were well-scoped and high-impact; the architect audit approach created actionable work.
- Branch audit (done this session) recovered 10 unmerged compiler fix branches and opened PRs #341–350.

---

## What went wrong

- **Context limit hit mid-sprint** (May 11–12): Sprint paused due to exhausted context + simultaneous Codex restructuring attempt on the public repo. 16 issues remained unstarted.
- **Codex restructuring overlap**: Codex force-pushed to origin/main while S51 was active, requiring manual rollback and audit. Cost ~3 hours of this session.
- **Sprint file drift**: 4 issues (1375, 1378, 1381, 1395) were done but still marked `in-progress`/`ready` — sprint.md wasn't updated post-merge. The 70% statusline figure was stale for the same reason.
- **10 issue files missing from origin**: S51 issue files #1431–#1438 + #1400 + #1392-benchmarks existed only in labs, not in origin/main. Had to be manually added.

---

## Process improvements

1. **Sprint file hygiene**: After each PR merge, the dev should always update `status: done` in the sprint issue file as part of the post-merge checklist. Currently the step exists in the checklist but devs are missing it.
2. **Codex/parallel edit guard**: Any restructuring attempt on origin/main must be coordinated with active sprint. The pre-push hook needs to gate force-pushes more aggressively.
3. **Issue file parity check**: Sprint issue files should be present on origin/main from the moment they're created, not just in labs. The planning workflow should include a step to push new issue files immediately.
4. **Context budget tracking**: With a weekly token budget, sprint planning should include a "context burn check" at 50% sprint completion to decide whether to compact and continue or close early.

---

## S52 start state

- 7 dev agents dispatched on day 1: #1396, #1431, #1432, #1433, #1434, #1437, #1438
- 10 audit PRs in CI queue: #341–350
- Baseline: 28,147 / 43,160 (65.2%)
- Target for S52: +1,500 passes → 29,600+ / 43,160 (68.6%)
