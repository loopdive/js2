---
id: 6783
title: "ci: ~4,100 test files run under no required check, and main is red (2 of 8 random files fail on a clean checkout)"
status: in-progress
sprint: Backlog
created: 2026-09-30
updated: 2026-10-06
assignee: "ttraenkler/claude-dev-6783"
branch: "claude/issue-6783-known-failures-gate"
priority: critical
horizon: l
feasibility: medium
reasoning_effort: high
task_type: infrastructure
area: ci
language_feature: n/a
goal: ci-hardening
related: [3008, 3340, 3558, 3726, 3746, 3918, 5232, 6785]
requested_by: ttraenkler/claude-review
origin: "2026-09-30 codebase review (plan/agent-context/claude-codebase-review-2026-09-30.md) — C6"
---

# #6783 — make `issue-tests` a required known-failures ratchet, then clean up main

## Problem

On HEAD `e303c5c7` (clean checkout, deps installed), a deterministic random
sample of 8 root test files (`shuf --random-source=<(yes 42)`) fails in 2
files / 9 tests:

- `tests/native-i32-type.test.ts` — 8/8 fail:
  `WebAssembly.instantiate(): Import #0 module="string_constants": module is
  not an object or function`. The test instantiates with `{ env: {} }` (line
  11); the compiler now emits a `string_constants` import. Never re-run in CI.
- `tests/issue-3526-string-boundary-schema.test.ts` — 1/32:
  `expected '// Copyright…' to contain 'asCallableRuntimeHostCapabilityRecord('`
  (line 791) — a source-grep assertion against a file that was reorganised.

Nobody noticed because nothing required runs them. What a PR must actually
pass before it can enter the merge queue:

| what runs | how | gated? |
|---|---|---|
| 16 pinned files | `scripts/select-changed-issue-tests.mjs --pinned` | yes |
| 20-file guard suite | `tests/guard-suite.json` | yes |
| `tests/equivalence/` (223 files) | `scripts/equivalence-gate.mjs`, ratcheted, 22 known failures | yes (but see #6785) |
| tests the PR touched | `scripts/hooks/changed-root-tests.sh` — PR event only, root dir only, **>20 changed files → `exit 0`**, `--dangerouslyIgnoreUnhandledErrors` | partially |
| "issue tests this PR touched" | `ci.yml:805` `continue-on-error: true` | **no** |
| `issue-tests` job | not in the required-checks ruleset | **no** |
| 25 linear/simd files | `linear-tests` | no |

`docs/ci-policy.md:63` states the suite "is not clean on main today". 3,872
`tests/issue-*.test.ts` + 21 `tests/ir/` files are therefore advisory. #3008
(done) was meant to wire them in uniformly; it did not stick.

## Correction

1. **Triage pass** (one PR, mechanical): run the whole root suite once
   (`scripts/equivalence-gate.mjs`-style single fork, 1 GB heap, sharded by
   file list) and classify every red file: stale mechanism (fix the assertion
   or delete the file), real bug (open an issue, add to the known-failures
   list), infra (fix). Record the counts in this issue.
2. **Ratchet**: generalise `scripts/equivalence-gate.mjs` into
   `scripts/known-failures-gate.mjs` with a baseline per suite
   (`scripts/issue-tests-baseline.json`), run it sharded in `test262-sharded.yml`
   or `ci.yml` alongside `equivalence-gate`, and add the check to the
   `main` ruleset (`scripts/enable-branch-protection.sh`, `docs/ci-policy.md` §7).
3. Remove `continue-on-error: true` from `ci.yml:805` and the `>20 files →
   exit 0` skip in `changed-root-tests.sh` (replace with "run the first 20 +
   warn").
4. Post-merge job runs the same gate with `--update-on-decrease` so newly
   fixed files leave the baseline automatically (mirrors `check:ir-fallbacks`).

## Acceptance

- `node scripts/known-failures-gate.mjs --suite issue-tests` exits 0 on main
  with a committed baseline that lists every currently red file by name.
- A PR that turns one green file red fails the required check; a PR that
  fixes a listed file is reported as "newly fixed".
- `docs/ci-policy.md` §7 lists the new required check; the ruleset query in
  CLAUDE.md returns it.
- The two files above are fixed or deleted in the triage PR.

## Implementation Plan

Orchestrator decisions (2026-10-02), recorded here because they reshape the
Correction:

- **No local triage pass.** The ~4,400-file root suite cannot run on a shared
  4-core dev box (hours, OOM). CI seeds the baseline instead, in two phases:
  1. **Seed** — while `scripts/issue-tests-baseline.json` is absent the gate
     prints the full red list as the proposed baseline and exits 0; only the
     post-merge bank (`--update-on-decrease --seed-if-missing`) writes it, from
     a complete merged run on main, and it refuses while that run has an
     integrity failure or an unexpected pass (#3340).
  2. **Enforce** — from the first seeded commit the gate fails green→red files
     and reports red→green ones as newly fixed (banked post-merge).
  The triage counts (Correction 1) are recorded when the first seeded
  baseline lands.
- **Correction 2** — `scripts/known-failures-gate.mjs --suite issue-tests`
  reuses `scripts/equivalence-gate.mjs`'s exported `summarizeReport`,
  `mergeSummaries`, `toPartial`/`fromPartial`, `evaluateGate` and
  `bankBaseline` (two additive, default-preserving options there: a `toRel`
  mapper for `summarizeReport`, `floors: false` for `evaluateGate` /
  `bankBaseline`). It scores per FILE. Run sharded 8 ways in `ci.yml` (`issue-tests-shard` → partials →
  `issue-tests-gate`), mirroring #6785; a missing, duplicated or cross-commit
  partial, or a file on disk that reached no report, fails it.
- **Ruleset** — not touched by this PR. `scripts/enable-branch-protection.sh`
  gains a `REQUIRED_AFTER_SEEDING` list it appends only when the baseline
  file exists; `docs/ci-policy.md` §7 documents the check as
  REQUIRED-AFTER-SEEDING (prose, so the six-context table tests still hold).
- **Correction 3** — the new gate steps are fatal once seeded; in seed mode
  they are `continue-on-error` so a not-yet-required job cannot make a PR
  `UNSTABLE`. The existing advisory "issue tests this PR touched" step keeps
  its semantics until seeding (comment says so). `changed-root-tests.sh` runs
  the first 20 of >20 changed files with a warning and, on the first failure,
  lists every changed file it did not reach.
- **Correction 4** — `test262-sharded.yml` promote-baseline fetches the merged
  partials (`issue-tests-partials-<sha>`, kept by `issue-tests-gate` on
  merge_group/push runs) and runs the bank inside the re-anchor loop, on the
  tip, next to the other banked baselines. `baseline-summary-sync.yml` is not
  wired (no deps, and it would need its own artifact lookup).
- **Allowances** — `known-failures-allow:` items in the PR's own issue
  frontmatter (`"<path> <YYYY-MM-DD> <reason>"`; undated items grant nothing),
  found via `scripts/lib/change-scope.mjs` like `loc-budget-allow`. Because the
  baseline lags main (the bank is deferred while the queue is busy), the gate
  also honours allowances from every issue file changed since the baseline's
  `measuredAt`; the bank adds an allowed red file to the baseline.
- **The two named red files** — both fixes were mechanical (stale harness /
  stale source pins), so both are fixed here.

Files:

- `scripts/known-failures-gate.mjs` (new) — suite population, round-robin
  sharding, crash-safe runner, per-file scoring, partial merge, allowances,
  seed/bank.
- `scripts/lib/known-failures-reporter.mjs` (new) — vitest reporter that
  appends one JSON line per file as it starts/ends, so a worker OOM loses only
  the in-flight files (re-run alone at 4 GB; red only if they die alone too).
- `scripts/equivalence-gate.mjs` — the additive options above.
- `.github/workflows/ci.yml` — `issue-tests-shard` ×8 + `issue-tests-gate`;
  advisory-step comment; changed-root step comment.
- `.github/workflows/test262-sharded.yml` — partials fetch step + bank call in
  the re-anchor loop.
- `scripts/hooks/changed-root-tests.sh` — first-20 + not-run listing.
- `scripts/enable-branch-protection.sh`, `docs/ci-policy.md` §1/§7.
- `tests/known-failures-gate.test.ts` (new); `tests/native-i32-type.test.ts`,
  `tests/issue-3526-string-boundary-schema.test.ts` (fixed).

## Resolution

Status stays `in-progress`: the gate lands in seed mode, and the issue's first
acceptance line (a committed baseline listing every red file) is met only when
the post-merge bank seeds `scripts/issue-tests-baseline.json` from a complete
CI run on main. Record the triage counts (red files by class) here then.

**The two named files** (measured here, single fork, before → after):

| file | before | after |
|---|---|---|
| `tests/native-i32-type.test.ts` | 8/8 fail (`string_constants` import vs `{ env: {} }`) | 8/8 pass (`buildImports`) |
| `tests/issue-3526-string-boundary-schema.test.ts` | 1/32 fail (source pins on re-export shims) | 32/32 pass (pins follow the code to `src/ir/runtime/`) |

**Found on the way.**

- The post-merge detector `.github/workflows/issue-tests.yml` (#3008) has not
  gated in its recent history: 18 of 18 completed non-cancelled runs on
  2026-10-01/02 ended `failure`. In run 36962288398, 4 of 12 single-fork shards
  died "Reached heap limit" → `ERR_IPC_CHANNEL_CLOSED` → "vitest produced no
  JSON report", so `gate` (which `needs` every shard) was skipped. The new
  runner's crash-safe reporter exists for exactly this. The detector and
  `scripts/issue-tests-gate.mjs` are superseded by `issue-tests-gate` and
  should be retired once the baseline is seeded (left in place here, out of
  scope; note its local default baseline path is the same file name, CI points
  it at the baselines repo instead).
- `tests/array-capacity.test.ts` is red on main too (4/4 tests, probe run
  below) — not named by this issue; left for the seeded baseline.

**Probes of the gate itself** (this box, real vitest):

- 3-file shard (`SHARD=5/1463`, seed mode): 56 s, 1 red / 2 green, partial
  written; reporter test ids equal vitest's JSON reporter's.
- Crash + collect error + green file, seed mode: the parallel pass lost vitest
  to the crash (2 files in flight); the serial re-run reported the import error
  as a red file and confirmed the crash alone ("worker died even when run alone
  at 4096 MB heap"); exit 0 with both in the proposed list.
- Same files in enforce mode against a baseline: the crash file is a
  REGRESSION (exit 1), the baseline-red green file is "newly fixed" after its
  confirming re-run.

**Deliberately left out.** The local triage run (orchestrator decision); the
ruleset change (an admin runs `scripts/enable-branch-protection.sh` after
seeding); wiring `baseline-summary-sync.yml`; retiring `issue-tests.yml`. The
shard wall-clock on CI is not measured yet — estimate from the detector's
single-fork shards (10–53 min for ~366 files): ~10–30 min for ~550 files at 3
forks.

## Transplant (2026-10-06, lead)

The implementing agent's tree (worktree `agent-a46f6d39cacfb28ed`, checkpoint
`c8cb97e5` plus its uncommitted files) was moved onto the PR branch by the
lead as a patch, because the shared repository is still bare (#6822) and the
agent cannot be resumed. The gates listed under Resolution are the agent's
runs before the breakage; the git-based gates (budgets, oracle ratchet,
dead exports, compiler boundaries) run in CI on the PR. On merging `main`,
its new `issue-tests-select` / `issue-tests-changed` / `issue-tests`
aggregator jobs were kept and the `issue-tests-shard` / `issue-tests-gate`
jobs of this change appended after them; this change's edit of the old
"issue tests this PR touched" step was dropped with that step.
