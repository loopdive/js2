---
id: 6784
title: "ci: the `lint` gate cannot fail — Biome's default 20-diagnostic cap is consumed by `noExplicitAny` warnings, so 11 real lint errors sit on main with exit 0; the cheap gate marks lint 'not blocking'"
status: ready
sprint: Backlog
created: 2026-09-30
updated: 2026-09-30
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
