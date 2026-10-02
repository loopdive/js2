---
id: 6783
title: "ci: ~4,100 test files run under no required check, and main is red (2 of 8 random files fail on a clean checkout)"
status: in-progress
sprint: Backlog
created: 2026-09-30
updated: 2026-10-02
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
related: [3008, 3558, 3726, 3746, 3918, 6785]
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
