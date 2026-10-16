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
5. **Sentinels.** 54 of the 60 `it.fails` pins that pass on main are promoted to `it`
   (22 files). Their companion tests that recorded the old wrong value are
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

## Residuals (not fixed here)

- **6 sentinels left as `it.fails`**: `issue-4491-wave4.test.ts` (2) and
  `issue-4655.test.ts` (4) pass on main, but each file also has a red test
  unrelated to the pins, so touching it trips the fix-on-touch changed-root
  gate in `quality`:
  - `issue-4491-wave4` "reads an array-index ACCESSOR through a narrowed
    parameter" — an uncaught `WebAssembly.Exception` in standalone.
  - `issue-4655` `built-ins/Array/prototype/toString/S15.4.4.2_A1_T4.js` —
    `fail: Test262Error`.
  Both need their own fix (or a decision) before those pins can be promoted.
  Until then the detector's gate keeps failing on these 6 unexpected passes.
- **The regression backlog against the July baseline** (~800 files that went red
  between 2026-07-24 and now, plus files added since). The detector was blind
  for that whole window, so none of it was triaged. This change makes the shards
  report it with error lines; it does not fix or re-baseline it. Green needs one
  of: triage + fixes, a maintainer-approved re-baseline of
  `issue-tests-baseline.json` in js2wasm-baselines, or retiring this workflow
  for #6783's lane once that lane seeds (which #6783 already proposes, and which
  needs the promote/partials ordering above fixed first).
- Other red tests seen while doing this (not in touched files):
  `issue-4623` "does NOT fold when the program installs its own isPrototypeOf".

## Acceptance

- Every issue-tests shard writes a partial (no exit 2 from a lost report).
- No `ERR_MODULE_NOT_FOUND` for `scripts/compiler-bundle.mjs` in shard logs.
- The 54 promoted pins pass in CI (node 25).
- The gate's remaining failures are named (REGRESSION lines with error text,
  and the 6 unexpected passes above), not a skipped job.
