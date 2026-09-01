---
id: 5259
title: "issue-3517-map-module-init.test.ts is red 5/14 on main and invisible to CI"
status: ready
sprint: current
created: 2026-09-01
updated: 2026-09-01
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
