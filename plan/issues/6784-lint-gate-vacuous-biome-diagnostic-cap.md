---
id: 6784
title: "ci: the `lint` gate cannot fail — Biome's default 20-diagnostic cap is consumed by `noExplicitAny` warnings, so 11 real lint errors sit on main with exit 0; the cheap gate marks lint 'not blocking'"
status: done
sprint: Backlog
created: 2026-09-30
updated: 2026-10-01
completed: 2026-10-01
assignee: "ttraenkler/claude-dev-6784"
branch: "claude/issue-6784-lint-gate"
priority: high
horizon: s
feasibility: easy
reasoning_effort: low
task_type: infrastructure
area: ci
language_feature: n/a
goal: ci-hardening
related: [1399, 6783]
requested_by: ttraenkler/claude-review
origin: "2026-09-30 codebase review (plan/agent-context/claude-codebase-review-2026-09-30.md) — H15/H16"
# 2026-10-01 (#6784): +1 line each from behaviour-preserving lint fixes — _safeSet splits a comma expression into an if + assignment; resolveImport gains two biome-ignore lines (the IsConstructor probes must stay constructible) and loses one this-alias line.
func-budget-allow:
  - src/runtime.ts::_safeSet
  - src/runtime.ts::resolveImport
---

# #6784 — `pnpm run lint` is green with real errors in tree

## Problem

Measured on main `e303c5c7`, Biome 1.9.4:

```
$ pnpm exec biome lint src tests scripts --diagnostic-level=error          # the `lint` script
exit 0        ("Diagnostics not shown: 1870")
$ pnpm exec biome lint src tests scripts --diagnostic-level=error --max-diagnostics=100000
exit 1        Found 11 errors, 4633 warnings
```

Same tree, same rules. The 11 errors are real:

| file | rule |
|---|---|
| `src/runtime.ts:2861` | `complexity/noUselessCatch` |
| `src/runtime.ts:6000` | `style/noCommaOperator` |
| `src/runtime.ts:18993` | `complexity/noUselessThisAlias` |
| `src/runtime.ts:16243`, `:16300`, `src/runtime/boundary-object-adapter.ts:204` | `complexity/useArrowFunction` |
| `src/runtime/boundary-object-adapter.ts:89` | `suspicious/noShadowRestrictedNames` |
| `src/runtime/iterator-polyfills.ts:1199` | `style/noArguments` |
| `src/runtime.ts:713`, `:9661`, `:10825` | `useConst` / `useRegexLiterals` |

plus 22 `suppressions/unused` (stale `biome-ignore` comments).

## Root cause

Biome 1.9 counts *all* diagnostics (warnings included) against
`--max-diagnostics` (default 20) even when `--diagnostic-level=error` hides
them, and sets the exit code only from diagnostics it actually emitted. With
4,613 `noExplicitAny` warnings (`biome.json` sets it to `warn`), the first 20
slots are always warnings, so no error is ever emitted and the exit code is 0.
The gate has been vacuous since the warning count passed 20.

Second hole: `.github/workflows/test262-sharded.yml:301` in the
`cheap gate (main-ancestor + lint)` job:
`if [ "$lint_rc" -ne 0 ]; then echo "::warning::lint failed (rc=$lint_rc) — not blocking"; fi`
— the check named "lint" does not fail on lint.

## Correction

1. `package.json` `lint`: add `--max-diagnostics=100000` (or set
   `noExplicitAny` to `off`/`info` in `biome.json` so warnings stop consuming
   the cap — pick one and say why in the commit).
2. Fix the 11 errors and remove the 22 stale suppressions in the same PR
   (`biome lint --write --unsafe` handles most; review `noUselessCatch` and
   `noShadowRestrictedNames` by hand).
3. `test262-sharded.yml:301`: `exit $lint_rc`, or rename the check to
   `cheap gate (main-ancestor + typecheck)` — a check must not claim what it
   does not gate.
4. Add a test in `tests/` or a script assertion that runs the lint script on a
   fixture containing one error and asserts exit 1 (a gate that can fail has
   to be shown failing once).

## Acceptance

- `pnpm run lint` exits 1 on a tree with one injected lint error, 0 on main
  after the fixes.
- `cheap gate` fails when lint fails, or is renamed.
- Biome summary reporter shows 0 errors, 0 unused suppressions.

## Implementation Plan

1. **Lift the cap, keep the warnings.** `package.json` `lint` and the
   lint-staged biome command gain `--max-diagnostics=none` (Biome 1.9's
   documented "no limit" value — stricter than a large number). Chosen over
   setting `noExplicitAny` to `off`/`info`: turning one rule down only removes
   today's dominant warning, and any other warn-level rule that later passes 20
   hits would reopen the same hole. Lifting the cap closes it for every rule
   while keeping the `any` warnings visible in editors. The lint-staged command
   had the identical hole (`src/runtime.ts` alone carries more than 20 `any`
   warnings), so the per-commit lint was vacuous on exactly the large files.
2. **Fix the 11 errors, behaviour-preserving only.**
   - `src/runtime.ts` `_instanceofResult`: drop a `try { … } catch (e) { throw e; }`
     (`noUselessCatch`) — identical semantics.
   - `src/runtime.ts` `_safeSet`: `obj = (A && B, C)` → `if (A) B; obj = C;`
     (`noCommaOperator`) — same evaluation order, `C` still reads the original `obj`.
   - `src/runtime.ts` `_compiledAbToHostBuffer`: `let ab` → `const ab` (`useConst`).
   - `src/runtime.ts` `_tTzAnnotationRe`: `new RegExp("…")` → regex literal
     (`useRegexLiterals`); `String(old) === String(new)` and flags verified equal.
   - `src/runtime.ts` getter-callback bridge: `const self = this` removed, the
     arrow uses `this` (`noUselessThisAlias`) — an arrow inherits the same `this`.
   - `src/runtime/boundary-object-adapter.ts` `construct`: param `constructor` →
     `ctor` (`noShadowRestrictedNames`), a local rename.
   - `src/runtime/iterator-polyfills.ts` `reduce` polyfill: `arguments.length < 2`
     → rest parameter `...rest` + `rest.length === 0` (`noArguments`). The
     observable `.length` is pinned to 1 by `_installBuiltinMethod` either way;
     a probe with the native method deleted gives identical results before and
     after (`length`, sum with/without seed, explicit `undefined` seed, empty
     iterator TypeError).
   - **Kept, with a reasoned `biome-ignore`** (the auto-fix would change
     behaviour): the three `Reflect.construct(function () {}, [], x)`
     IsConstructor probes (`useArrowFunction` — an arrow is not constructible,
     so the probe would always throw) and `let mirrorSelf` in
     `_makeClassCtorMirrorForHost` (`useConst` — it is assigned at the end of the
     function and read under a `!== undefined` guard; a `const` there would turn
     those guarded reads into TDZ errors).
3. **Stale suppressions.** The summary reporter says "22 suppressions/unused",
   but the per-diagnostic output lists **20**; the other 2 are the summary
   reporter mis-bucketing the two `useConst` errors (Biome 1.9.4 quirk — its
   per-rule rows also show `useArrowFunction 4` for 3 sites). The 20 were
   `performance/noDelete` (18, test files) and `security/noGlobalEval` (2,
   `src/runtime/dynamic-function-import.ts`) — neither rule fires in Biome 1.9
   on that code. 17 became plain comments that keep their rationale. The
   other **3** (`tests/issue-743-derivation-defaults.test.ts:44,56`,
   `tests/issue-743-dts-entrypoint-seeds.test.ts:44`) are deliberately left:
   both files are **red on main** for unrelated reasons (3 failing #743
   flag-default assertions — "\"\" must disable: expected true to be false",
   "expected 'externref' to be 'f64'"), and the required changed-root step in
   `quality` runs every root test file a PR touches, so a comment-only edit
   would park this PR on someone else's regression. They are warning-level
   (`suppressions/unused`), so they do not affect the gate.
4. **Cheap gate.** `.github/workflows/test262-sharded.yml`
   `cheap gate (main-ancestor + lint)`: the `::warning::… not blocking` branch is
   now `::error::lint failed` + `exit "$lint_rc"`. #3677 had made lint advisory
   there because the failure was diagnostic-free and duplicated `quality`; the
   #3677 log dumps fixed the first, and `docs/ci-policy.md` §7 already describes
   this check as a lint + typecheck reject, so gating restores the documented
   contract. Not renamed: the name is in the branch ruleset.
5. **Test.** `tests/lint-gate-can-fail.test.ts` runs the real `lint` script
   string (and the lint-staged biome command) with `sh -c` in a temp directory
   laid out like the repo (`src/ tests/ scripts/` + a copy of `biome.json`).
   The script did not need a `$@` path parameter: its relative
   `src tests scripts` resolve against the temp cwd.
6. `plan/method/pre-commit-checklist.md` told devs to verify suppressions with
   capped `biome lint … --diagnostic-level=error` (same hole); it now says
   `pnpm run lint`.

## Resolution

Before (main `a2c2b2da`, Biome 1.9.4, measured 2026-10-01):

```
$ pnpm run lint            # biome lint src tests scripts --diagnostic-level=error
The number of diagnostics exceeds the number allowed by Biome.
Diagnostics not shown: 1872.
Checked 6710 files in 8s. No fixes applied.
exit 0
$ npx biome lint src tests scripts --diagnostic-level=error --max-diagnostics=100000
Found 11 errors.            × Some errors were emitted while running checks.
exit 1
$ npx biome lint src tests scripts --max-diagnostics=100000 --reporter=summary
suppressions/unused  22 (2 error(s), 20 warning(s))   noExplicitAny 4649 warnings
Found 11 errors.  Found 4669 warnings.
exit 1
```

After (this branch, merged with main):

| command | before | after |
|---|---|---|
| `pnpm run lint` (tree) | exit 0, 11 errors hidden | exit 0, 0 errors |
| `biome lint … --diagnostic-level=error --max-diagnostics=none --reporter=summary` | 11 errors | 0 errors |
| `biome lint … --max-diagnostics=none --reporter=summary` | 11 errors, 22 unused-suppression rows | 0 errors; 3 unused suppressions (warnings, kept on purpose — step 3); 4649 `noExplicitAny` warnings |
| `pnpm run lint` on the fixture (40 `any` warnings, then `debugger;`) | exit 0 | exit 1 |
| cheap gate on a lint error | `::warning` + pass | `::error` + fail |

`tests/lint-gate-can-fail.test.ts` (5 cases): passes on this branch; with
`package.json` reverted to main it fails 3 of 5 (the cap assertion, `pnpm run
lint` exit 1, lint-staged exit 1) — the two controls (warnings alone exit 0;
the pre-#6784 script exits 0 on the error fixture) pass both ways, proving the
fixture reproduces the hole. The pre-#6784 control is pinned to Biome 1.9's
behaviour; if an upgrade stops charging hidden warnings to the cap it flips,
and that case can be dropped.

Gates run on the final tree (merged with main `43abb4e1`+), each exit 0 unless
noted: `pnpm run lint`, `typecheck`, `format:check`, `check-loc-budget` and
`check-func-budget` (fork-point and `LOC_GATE_BASE=origin/main`),
`check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`,
`check-compiler-boundaries --mode inventory`, `check:ir-dialect`,
`check:ir-kind-neutrality`, `check:jstag-seam`, `check:ir-layering`,
`check:codegen-fallbacks`, `check:any-box-sites`, `check:speculative-rollback`,
`check:stack-balance`, `check:pushraw`, `check:host-import-policy` (first run
exit 1: `ownedAdapterLines 953 > 952` from the added biome-ignore — fixed by
joining a wrapped comment in the same file, no baseline edit), `check:ir-only`,
`check:ir-adoption`, `check:issues`, `check:done-status-integrity`,
`check:issue-spec-coverage`, `check:harness-compile-budget`,
`check:verdict-oracle`, `check:ir-fallbacks`, `test:guard` (20 files / 255
tests). Tests: every changed root test file run singly (14 suppression-edited
files + `lint-gate-can-fail`, all green); `tests/runtime-*.test.ts` (3 files)
and `tests/issue-4628-temporal-global.test.ts` (covers the TZ-annotation regex)
green.

Budget: `func-budget-allow` for `src/runtime.ts::_safeSet` (+1) and
`src/runtime.ts::resolveImport` (+1), rationale in the frontmatter.

Not done: `noExplicitAny` stays `warn` (deliberate, see step 1); the 3
stale suppressions in the two red #743 test files (step 3) — remove them when
those files are fixed.
