---
id: 7014
title: "ci: the post-merge `issue-tests` detector has not passed since 2026-07-19 — single-fork shards OOM, missing compiler bundle, 66 unpromoted it.fails sentinels, ~800 files red against a July baseline"
status: in-progress
sprint: Backlog
assignee: "ttraenkler/issue-tests-red"
branch: "issue-7014-issue-tests-red"
created: 2026-10-16
updated: 2026-10-16
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: infrastructure
area: ci
language_feature: n/a
goal: ci-hardening
related: [3008, 3340, 6783, 6785, 4258, 4481, 4484]
requested_by: ttraenkler/issue-tests-red
---

# #7014 — make the `issue-tests` detector measure again, then get it green

## Problem

`.github/workflows/issue-tests.yml` (#3008) runs the whole root test suite
(`tests/*.test.ts`) post-merge in 12 shards and gates against a known-failures
baseline in `loopdive/js2wasm-baselines`. Its last green run was 2026-07-19
(`gh api repos/loopdive/js2/actions/workflows/issue-tests.yml/runs?status=success`);
the last 1,000 runs on main are 612 `failure` / 387 `cancelled`. The baseline
was last ratcheted 2026-07-24 (1,403 known failing tests in 477 files).

### Inventory — run 38797187257 (main `a59521114b`, 2026-10-15)

| shard | result | cause | class |
|---|---|---|---|
| 1, 3, 5, 8, 10 | partial written | — | — |
| 2, 4, 6, 7, 12 | exit 2 | one vitest fork for all ~392 files (`singleFork=true`); heap grew to the 1,024 MB limit ("Ineffective mark-compacts") → `ERR_IPC_CHANNEL_CLOSED`; the built-in JSON reporter writes only at the end, so no report, shard lost | infra (runner) |
| 9, 11 | exit 2 | same OOM, plus 3 / 27 `ERR_MODULE_NOT_FOUND: scripts/compiler-bundle.mjs imported from scripts/test262-worker.mjs` — the workflow never builds the bundle that root tests spawning the test262 worker need | infra (runner) + infra (missing artifact) |
| `gate` | skipped | `needs: shard` | — |

The single-fork OOM is accumulation, not one file: no file name is attached to
the crash because the JSON reporter had not written anything yet.

Results inside the five shards that did report (1,405 failing / 16,331 passing
tests): **1,127 failing tests in 254 files are not in the July baseline**, and
**12 `it.fails` tests unexpectedly pass** — which the gate (#3340) fails on by
itself. The whole-suite picture comes from #6783's seed-mode gate in `ci.yml`
(PR run 38810051166, 2026-10-15): **1,271 red files of 4,057**, and **66
unexpected passes**. Of those 66, 60 reproduce on main (this branch, run file
by file locally with `JS2WASM_EVAL_ENGINE=interpreter` and the bundles built);
the other 6 (`issue-4479.test.ts` ×3, `issue-4479-s2.test.ts` ×2,
`issue-4623.test.ts` ×1, all host-lane) pass only on that PR's branch
(#6705, which deletes host-semantic emitters), not on main.

Also measured:

- The population included the 75 test262 corpus entry points
  (`tests/test262-chunk*.test.ts` etc.). They are in the July baseline only as
  `<collect>` failures (no submodule); with the submodule they are whole
  conformance runs, which `test262-sharded.yml` already owns.
- #6783's replacement lane never seeds its baseline: every
  `promote merged report to main baseline` run looked at here (`8923daa27b`,
  `bfd1c6ac62`, `ee58c1aa26`) logs "no issue-tests-partials-<sha> artifact yet —
  the known-failures bank skips this promote", because promote runs ~2 min after
  the push while the ci.yml issue-tests lane takes over an hour, and the
  merge_group runs for those SHAs were cancelled. Its bank also refuses while any
  unexpected pass exists.

## Fix in this change

1. **Runner (infra).** `scripts/issue-tests-gate.mjs` no longer runs a shard in
   one fork. It runs files through `known-failures-gate.mjs`'s crash-safe
   `runFiles` (#6783): one fork per file, batches of 150, a reporter that records
   each finished file as it happens, in-flight files of a dead batch re-run
   alone at 4 GB, and a file that dies alone too becomes one red
   `<file> :: <crash>` id. A file that reaches no result is `<file> :: <not-run>`.
   The per-test reduction is `scripts/lib/issue-tests-ids.mjs`
   (`tests/issue-7014.test.ts`). Partials now carry the first error line of every
   failing id, and the gate prints it next to each REGRESSION.
2. **Population.** Uses `known-failures-gate`'s `ROOT_EXCLUDE`, so the test262
   corpus entry points are left to `test262-sharded.yml`.
3. **Missing artifact (infra).** The shard job now prepares exactly what ci.yml's
   `issue-tests-shard` prepares: the `test262` and `test262-fyi/data`
   submodules, `build:compiler-bundle`, the runtime bundle, and the runtime-eval
   refusal provider.
4. **Self-test.** The workflow runs on `pull_request` when its own machinery
   changes (the workflow, the two gate scripts, the reporter, the id module),
   reading the public baseline over https and never pushing it. Concurrency is
   per-PR for those runs, so they do not queue behind main.
5. **Sentinels.** 57 `it.fails` pins that pass on main are promoted to `it`
   (25 files): 54 of the 60 measured locally, plus 3 more the PR's own full run
   found (`issue-4465` R3, `issue-4480` R1, `issue-4655-concat-carrier`
   absent-tail). Their companion tests that recorded the old wrong value are
   updated to the JS-correct value where the companion said so:
   - `issue-2107`: the #4258 erasure-recording twin is deleted, as its own
     comment required; the kill-switch now asserts `=== null` is `false` (0)
     in the legacy `JS2WASM_UNDEF_SINGLETON=0` regime too.
   - `issue-4484` A: asserts the spec `true` (1) instead of "no throw" (2).
   - `issue-4481`: the instance value-call of `join` now runs (was a catchable
     refusal), both `.call` sites agree (`11`, was `21`), and the
     builtin-prototype-write row asserts the JS identity
     `a.valueOf === Array.prototype.valueOf` (it asserted `!==`, which is false
     in JS). A NEW residual found there is pinned `it.fails`: calling the user
     function installed on `Array.prototype` does not return its value.

## After — the PR's own full run (issue-tests run 38837528175, PR #6710)

All 12 shards `success`: every shard wrote its partial, 0 `ERR_MODULE_NOT_FOUND`,
0 heap-limit deaths. Shard wall-clock 14–68 min (shard 6 hit the 30-min batch
timeout once; its 7 in-flight files were re-run alone and finished). The suite
measured end to end for the first time since July: **6,431 failing / 49,845
passing tests** over 4,622 files.

The `gate` verdict (advisory on PRs) is still red, for two reasons:

1. **14 unexpected passes** were measured on that run. 3 are promoted by the
   follow-up commit (above), so **11 remain**, each in a file that also has an
   unrelated red test (touching the file would fail the fix-on-touch
   changed-root gate in `quality`):

   | file | pins left | the file's other red test |
   |---|---|---|
   | `issue-4491-wave4` | 2 | "reads an array-index ACCESSOR through a narrowed parameter" — uncaught `WebAssembly.Exception` (standalone) |
   | `issue-4655` | 4 | `Array/prototype/toString/S15.4.4.2_A1_T4.js` — `fail: Test262Error` |
   | `issue-4492-wave5` | 4 | R1 CONTROL "a NAMED array receiver DOES honour the override" — `expected false to be true` |
   | `issue-4489` | 1 | "a name that is both a `var` and a function declaration keeps the function" — CE `Duplicate identifier 'f'` |

2. **5,622 failing tests in 599 files are not in the July baseline**
   (classified by first error line, `.tmp/classify.mjs`-style regexes over the
   partials' new `messages`):

   | class | files | tests |
   |---|---|---|
   | `issue-3518-*` / `issue-4376-*` source-hash and source-inventory pins (assert SHA256/length/counts of `src/` files; stale on any edit by construction) | 111 | 4,325 |
   | other source-hash/inventory pins | 18 | 241 |
   | value assertions (`expected X to be Y`) — real behaviour changes, unclassified | 307 | 673 |
   | compile errors | 35 | 84 |
   | `TypeError`/`ReferenceError` inside the test harness | 24 | 84 |
   | source-grep / snapshot assertions (`toContain`, `toMatch`) | 33 | 59 |
   | missing host import at instantiate (`Import #N … module is not an object`) | 18 | 44 |
   | Wasm traps (`RuntimeError`, `illegal cast`, uncaught `WebAssembly.Exception`) | 9 | 14 |
   | worker crash even alone at 4 GB (`test262.test.ts`, `test262-errors.test.ts`, two #3518 files) | 2 | 2 |
   | other | 41 | 94 |

   The detector was blind for this whole window, so none of it was triaged.

## Residuals (not fixed here) and the plan to green

1. **Source-pin suites (129 files / 4,566 tests, 81% of the backlog).**
   `issue-3518-*`/`issue-4376-*` pin raw source hashes, lengths and inventory
   counts of `src/` files. They are not compiler regressions, and they will go
   red again on the next edit to a pinned file. They need an owner decision:
   retire them, or move them to a lane that runs only when the pinned files
   change. Fixing them by updating hashes would only last until the next merge.
2. **Value / CE / trap / host-import classes (~420 files / ~950 tests).** These
   need real triage. Run the gate, take its REGRESSION lines (they now carry the
   error), bucket them by the issue number in the test file name, and route each
   bucket to that issue's owner. Wasm traps and CEs come first.
3. **The 11 remaining sentinels**: fix the four "other red test" rows above,
   then promote.
4. **Getting the detector green.** Once 1–3 shrink the backlog, either a
   maintainer re-baselines `issue-tests-baseline.json` in js2wasm-baselines from a
   complete run, with this issue holding the absorbed list, or this workflow is
   retired for #6783's ci.yml lane (which #6783 already proposes). The #6783
   lane cannot seed today: `promote merged report to main baseline` runs ~2 min
   after the push, before the ci.yml issue-tests partials exist (its log says
   "no issue-tests-partials-<sha> artifact yet" on every promote checked). Its
   bank also refuses while any unexpected pass exists.
- Also seen while doing this (not in a touched file): `issue-4623` "does NOT fold
  when the program installs its own isPrototypeOf".

## Acceptance

- Every issue-tests shard writes a partial (no exit 2 from a lost report).
- No `ERR_MODULE_NOT_FOUND` for `scripts/compiler-bundle.mjs` in shard logs.
- The promoted pins pass in CI (node 25).
- The gate's remaining failures are named (REGRESSION lines with error text,
  and the remaining unexpected passes above), not a skipped job.
- Done (green on main) only after the "plan to green" steps above.
