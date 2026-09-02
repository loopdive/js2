---
id: 5259
title: "issue-3517-map-module-init.test.ts is red 5/14 on main and invisible to CI"
status: done
sprint: current
created: 2026-09-01
updated: 2026-09-02
completed: 2026-09-02
priority: high
horizon: s
complexity: S
feasibility: easy
reasoning_effort: medium
task_type: test-fix
area: tests, ci
language_feature: compiler-internals
es_edition: multi
goal: ir-full-coverage
lane: ir-retirement-r4
---

# issue-3517-map-module-init.test.ts is red 5/14 on main and invisible to CI

## Problem

`tests/issue-3517-map-module-init.test.ts` fails 5 of 14 tests on `main`
(measured on `c62b9bc41d`, re-confirmed during the #3523 gap-3 probes and
recorded in that issue's 2026-09-01 checkpoint note, probe P2). The five red
tests are the `it.each` pins at `:146-157` — "keeps the Map module initializer
legacy-owned in %s" for native strings / fast / standalone / WASI / strict
no-host — each asserting `expect(result.irCompiledFuncs ?? []).not.toContain("<module-init>")`.

The pins are stale, not the compiler: the #3142 IR overlay (and, since gap 3,
the WASI prepared route) legitimately put `<module-init>` in `irCompiledFuncs`
on these lanes. The file froze a 2026-era routing assumption ("these lanes are
legacy-owned") that R4 has since retired lane by lane.

## Why CI never caught it

Three conditions compose (verified during the gap-3 implementation):

1. The only job that runs `tests/issue-*.test.ts` is **not a required check**
   (`issue-tests` in `ci.yml` does not gate; the required six are
   `cheap gate`, `quality`, `merge shard reports`,
   `check for test262 regressions`, `equivalence-gate`, `cla-check`).
2. That job's **pinned list is one file**, and
3. its changed-files step is **`continue-on-error`**, so even when the file IS
   selected, a failure does not fail the job.

So a test file can rot indefinitely with green CI. This issue covers the
minimal repair, not a CI redesign.

## Acceptance criteria

1. `npx vitest run tests/issue-3517-map-module-init.test.ts` is 14/14 green on
   main.
2. The five stale pins are **rewritten to assert current truthful routing**,
   not deleted: per lane, assert the module-init outcome row (kind,
   `legacyBodyEmitted`/`irBodyEmitted`) and/or `irCompiledFuncs` membership
   that current main actually produces — with the WASI lane asserting the
   prepared route (post-#3523-gap-3: `legacy 0 · IR 1`) and any lane that is
   genuinely still legacy-owned keeping a positive legacy assertion.
3. Each rewritten pin cites the PR/issue that changed the lane's routing
   (#3142 overlay, #3523 gap slices) in a one-line comment.
4. A short note in this issue file records whether `issue-tests`'s
   `continue-on-error` swallowed these failures on recent PRs (one run link),
   so the CI-gate question can be decided separately with evidence. Fixing the
   `continue-on-error` / non-required-check design is OUT of scope here — if
   the evidence warrants it, file a separate CI-policy issue.

## Context

- Found and evidenced during #3523 gap-3 planning (test-surface probe) and
  implementation (checkpoint note P2). The gap-3 PR deliberately did NOT adopt
  the rewrite: four of the five red lanes are unrelated to WASI, so bundling
  it would have widened that PR.
- The file's other 9 tests are healthy and must stay untouched.

## 2026-09-02 checkpoint note — Opus lane

Branch `claude/issue-5259-map-module-init-test-rot`, based on `origin/main`
`7f998ff873`. One test file changed (`tests/issue-3517-map-module-init.test.ts`);
no `src/**`, no baseline JSON, no other test file.

### Measured before-state (untouched base, `7f998ff873`)

`npx vitest run tests/issue-3517-map-module-init.test.ts` → **5 failed | 9
passed (14)**, every failure on the same line (`:155`,
`expect(result.irCompiledFuncs ?? []).not.toContain("<module-init>")`):

| # | Test | Message |
| --- | --- | --- |
| 1 | keeps the Map module initializer legacy-owned in **native strings** | `expected [ '<module-init>' ] to not include '<module-init>'` |
| 2 | keeps the Map module initializer legacy-owned in **fast** | `expected [ '<module-init>' ] to not include '<module-init>'` |
| 3 | keeps the Map module initializer legacy-owned in **standalone** | `expected [ 'memo', '<module-init>' ] to not include '<module-init>'` |
| 4 | keeps the Map module initializer legacy-owned in **WASI** | `expected [ 'memo', '<module-init>' ] to not include '<module-init>'` |
| 5 | keeps the Map module initializer legacy-owned in **strict no-host** | `expected [ 'memo', '<module-init>' ] to not include '<module-init>'` |

The pins' *second* assertion (`irPostClaimErrors` empty) was never reached and
is stale too: native strings and fast each report one post-claim demotion,
`build / memo / "semantic intrinsic js.number.unbox has no provider under
number-boundary policy box=unsupported/unbox=unsupported"`. Rewriting only the
`irCompiledFuncs` line would have left those two lanes red.

### Truthful routing, measured per lane

Probe: `compile(MAP_SOURCE, { experimentalIR: true, trackFallbacks: true,
trackIrOutcomes: true, skipSemanticDiagnostics: true, ...laneOptions })`, module-init
row = the single `irOutcomes` entry with `unitKind === "module-init"`. Re-run
with and without `trackIrOutcomes` — identical routing either way, so the flag
observes rather than perturbs.

| Lane | `irCompiledFuncs` | row kind | legacy · IR | post-claim | route |
| --- | --- | --- | --- | --- | --- |
| native strings | `["<module-init>"]` | `emitted@patch` | 1 · 1 | `["memo"]` | overlay |
| fast | `["<module-init>"]` | `emitted@patch` | 1 · 1 | `["memo"]` | overlay |
| standalone | `["memo","<module-init>"]` | `emitted@patch` | **0 · 1** | `[]` | prepared |
| WASI | `["memo","<module-init>"]` | `emitted@patch` | **0 · 1** | `[]` | prepared |
| strict no-host | `["memo","<module-init>"]` | `emitted@patch` | 1 · 1 | `[]` | overlay |

No lane is legacy-*owned* any more — every one IR-compiles `<module-init>`. What
still differs is which route claims the body, so the three overlay lanes keep a
**positive** legacy assertion (`legacyBodyEmitted: true`), not a vacuous one.

### The five rewrites and their citations

Each row of the new `MODULE_INIT_LANES` table carries a one-line
"Routing owner:" comment:

1. **native strings** → #3142 slice 2 (PR #3168), the IR module-init overlay.
   The prepared lane's host arm requires `!ctx.nativeStrings`
   (`src/codegen/index.ts:4270`) and its standalone arm requires `ctx.standalone`
   (`:4276`), so native strings on gc keeps the overlay's dual emission.
2. **fast** → #3142 slice 2 (PR #3168). `ctx.fast` is refused outright by the
   prepared lane (`index.ts:4292`), so fast mode can only reach `<module-init>`
   through the overlay.
3. **standalone** → #3523, `f58fdd279 feat(ir): retire standalone lexical
   module-init bodies` in **PR #4662** — the prepared lane's standalone
   native-first arm (`index.ts:4275-4280`). No legacy body at all.
4. **WASI** → #3523 gap 3 (**PR #5425**, `5ba19f8fb` admission +
   `bacf6a935` machinery) — the invocation-policy-driven `_start` guard
   (`index.ts:4281-4290`). Prepared route, `legacy 0 · IR 1`, exactly the
   success signature that slice's checkpoint note (probe P4) recorded.
5. **strict no-host** → #3142 slice 2 (PR #3168). An EXPLICIT
   `--no-host-imports` gc build stays refused by the prepared lane by design
   (`index.ts:4293-4299`, comment added by #3523 gap 3), so this lane keeps a
   legacy body alongside the overlay's IR body.

Commits found with `git log -S` / `git log --diff-filter=A` after
`git fetch --unshallow` (the session clone was shallow to 2026-08-31, which
hides every pre-gap commit — worth knowing before trusting a `git log -S` here).

After: **14 passed (14)**. The other 9 tests are byte-identical.

### Criterion 4 — did `issue-tests`' `continue-on-error` swallow this?

**No — the file was never selected, so the advisory step never had it in
scope.** Evidence: PR #5450's CI run
<https://github.com/loopdive/js2/actions/runs/33580595431/job/100094026969>
(`issue-tests`, conclusion `success`). Its fatal step ran the pinned list —
one file, `tests/issue-3529-selector-preclaim.test.ts` — and its advisory step
logged `select-changed-issue-tests: base=3ba791164e changed=1 running=1` →
`tests/issue-3523-module-init-single-pass.test.ts`. Neither list contains
`tests/issue-3517-map-module-init.test.ts`, and `git log -- ` that file shows a
single commit in its whole history (`16beee807 feat(ir): claim exact generic
Map module init`), so no PR since creation has touched it.

So of the three composing conditions in "Why CI never caught it" above, the
load-bearing pair is (1) non-required job and (2) a one-file pinned list.
`continue-on-error` (3) is a real hole but a **latent** one for this file: it
only becomes the swallowing mechanism on the first PR that touches the file —
which is this PR, where the advisory step now runs the file green. Gate
redesign remains out of scope, and per the dispatch brief no separate CI-policy
issue was filed here; the evidence above is left for that decision.
