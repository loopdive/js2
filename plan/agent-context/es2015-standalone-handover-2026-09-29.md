---
agent: claude-lead (ES2015 standalone, #6651 lanes)
session: claude/es6-test262-standalone-g10c7u (session_01FEGi3DmyPRPD5dx4kWU8hs)
session_end: 2026-09-29
next_session_entry_point: >
  Read this file, then the A13 / C5 / H6 records at the end of
  plan/issues/6651-es2015-standalone-100pct-execution-plan.md (they land with
  PRs #6311 / #6321 / #6322). Then pick the next slice from "Where the 550
  rows are" below.
---

# ES2015 standalone — handover 2026-09-29

Goal: **100 % ES2015 test262 pass rate, standalone target**. Execution plan
and every slice record live in
[#6651](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6651-es2015-standalone-100pct-execution-plan).

## Where the number stands

| measurement | ES2015 standalone | ES5 standalone |
| --- | --- | --- |
| main `c4060cd97` (baseline promoted 2026-09-29 15:34 UTC) | **11,154 / 11,704 = 95.3 %**, 550 non-pass (521 fail, 29 compile_error) | 9,028 / 9,029; the one non-pass is the recorded exception `Array/prototype/toString/S15.4.4.2_A1_T4.js` |

Artifact: `test262-standalone-current.jsonl` from `loopdive/js2wasm-baselines`
at `67105d8` (baseline sha `c4060cd97`), classified with
`scripts/generate-editions.ts` (`classifyEdition`). The counts include every
PR merged today up to and including A14 (#6312). They do not include the three
lanes below.

## Scope decisions

- **21 Iterator-helper rows** (`built-ins/Iterator/prototype/**`) are out of
  scope per #6651 (proposal-era surface classified ES2015 by the edition map).
- **16 realm-isolation rows** are out of scope per #6651 (search "SCOPE,
  2026-09-26"). That decision reached the thread through an unquoted relay;
  **it still needs the project lead's explicit confirmation**. Asked again this
  session; no answer yet. 75 non-pass rows have "realm" in their path (for
  example 24 × `proto-from-ctor-realm.js`, 8 × `cross-realm.js`); most of those
  are fixable against the in-module `$262.createRealm()` and are NOT covered by
  the 16-row decision.

## What landed today (all through the merge queue)

| PR | what |
| --- | --- |
| #6290 | ES5 regressions fixed + the completed-edition rule (a 100 % edition may never regress; CLAUDE.md "Per-edition conformance ratchet") |
| #6274 | A9 — `%GeneratorFunction%` in standalone via the eval provider |
| #6285 | A11 — generator value-semantics rows |
| #6314 | ratchet failure deferred until after the #1897 guard, so the guard always names the moved rows |
| #6317 | revert of #6301 (it broke two ES5 async rows); files [#6761](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6761-standalone-async-closure-untyped-call-no-promise), #6735 back to ready |
| #6303 | root cause of the flaky host row `RegExp/named-groups/duplicate-names-matchall` (linked-lane closure dispatch) |
| #6310 | A12 — parameter writes lost at generator suspension |
| #6319 | [#6762](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6762-merge-queue-stacked-group-skip-merges-failed-entries) — a stacked merge group under an artifact-only PR no longer skips test262 and merges the failed entries beneath it |
| #6282 | A10 — generator host-import leaks, rest-param bails, compile crashes |
| #6312 | A14 — `%GeneratorFunction%` residuals (resume dispatch, poisoned `caller`/`arguments`, carrier `length`/`name`) |

## Lanes at wrap-up

At 17:40 UTC the user ordered "land this now"; all three lanes were told to
stop new work, keep only verified changes, run the gates, push, write their
#6651 record and PR body, and report. Their PRs carry the `wip` label until the
lead has verified the pushed head and replaced the PR body; removing `wip` hands
them to `auto-enqueue`. State at 20:35 UTC:

| lane | PR | target rows | result |
| --- | --- | --- | --- |
| A13 — generator singles (`instanceof` on a `function*`, `null` receiver fold, TypedArray from a generator, `super` in an object-literal method) | [#6311](https://github.com/loopdive/js2/pull/6311) | 8 | **merged** 18:30 UTC. Standalone 0 → 4 of 8; 0 pass → non-pass. The other four rows are design questions in the #6651 A13 record (closure `[[Prototype]]`, `delete` on a closed literal, `createRealm` generator) |
| C5 — subclassing built-in constructors | [#6321](https://github.com/loopdive/js2/pull/6321) | 22 under `class/subclass/**` except `GeneratorFunction/*` | **merged** 19:40 UTC (head `4fcbbb16d`, enqueued by the bot; no manual enqueue). Standalone 0 → 15 of 22, host 10 → 13. 75 changed binaries in a 448-file reach set, 0 pass → non-pass. Not done: constructor return override with an object, ArrayBuffer species, TypedArray subclass, `RegExp/lastIndex` |
| H6 — Array methods over a proxy | [#6322](https://github.com/loopdive/js2/pull/6322) | 15 under `Array/prototype/**` | **verified and released 20:35 UTC**, head `321e35f26` (merge with main `6fe1e9f56`); `[WIP]` and the `wip` label dropped, PR body replaced, checks running, left to `auto-enqueue` (confirm it merged). Lead re-run, standalone, `--isolate`: 15 target rows 0 → 5 (`{map,filter,slice,splice}/create-revoked-proxy.js`, `concat/is-concat-spreadable-proxy-revoked.js`), re-run on the merged tree still 5; the 137 changed rows show 0 pass → non-pass. 10 rows still fail (list and causes in the #6651 H6 record). Host lane not re-run |

## Where the 550 rows are (main `c4060cd97`)

After removing the 37 rows the three open lanes target, the 21 Iterator-helper
rows and every path containing "realm", the largest groups are:
`language/expressions` 68, `language/statements` 55, `built-ins/Proxy` 45,
`built-ins/Object` 42, `built-ins/Array` 25, `built-ins/TypedArray` 24,
`built-ins/Promise` 19, `built-ins/TypedArrayConstructors` 16,
`built-ins/Function` 15, `language/module-code` 14. The #6651 "Next levers"
lists (2026-09-28 wrap-up: H2, D8, I8, language-misc) still apply.

## Open follow-ups filed or reopened today

- [#6761](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6761-standalone-async-closure-untyped-call-no-promise) — an async closure called through `any` returns a raw value and throws synchronously in standalone (why #6301 broke ES5). #6735 waits on it.
- [#6763](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6763-ci-changes-job-stacked-merge-group-npm-compat-skip) — `ci.yml`'s `changes` job has the #6762 defect: an npm-compat refresh on top of a stacked merge group skips `equivalence-gate` for the whole stack. **High priority**: same failure class that merged broken PRs today.
- [#6764](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6764-dead-exports-gate-leaks-coverage-scratch) — `check:dead-exports` leaves ~80 MB of V8 coverage per run.
- [#6765](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6765-vitest-worker-heap-knob-undocumented) — vitest workers ignore `NODE_OPTIONS`; the knob is `VITEST_FORK_MAX_OLD_SPACE_SIZE`.

## Lessons worth keeping

1. **A merge queue merges everything under a passing group.** A failed entry
   still lands if the group on top of it passes. Two ES5 regressions reached
   `main` that way today (#6299, #6301). Fixed for test262 by #6762; #6763 is
   the same hole in `ci.yml`.
2. **"OOM even on main" was a harness setting, not the suites.** Check the
   worker's actual heap limit (the GC trace prints it) before calling a suite
   untestable. See #6765.
3. **QuickJS-backed pins skip silently** when the adapter cache misses for the
   current compiler hash. Read `skipped` in the vitest summary; force with
   `JS2WASM_EVAL_ENGINE=quickjs` after `npx tsx scripts/build-quickjs-eval-provider.mjs`.
4. **Container hazards** (this session's box, may recur): the disk under
   `/home/user/js2` itself returned I/O errors, so git ran only in clones under
   `.claude/worktrees/`. `scripts/provision-worktree-deps.sh`, triggered by a
   hook that matches the text "work"+"tree add" in any Bash command, replaces a
   bare `test262` symlink; keep `test262` a directory of per-entry symlinks.
