---
id: 4722
title: "ES2015 standalone Reflect.setPrototypeOf validates Symbol targets and non-nullish primitive prototypes"
status: done
sprint: current
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bug
area: codegen
es_edition: 2015
language_feature: reflect-setprototypeof-validation
goal: standalone-mode
assignee: codex/4722-es2015-reflect-setprototypeof-validation
related: [2046, 2175]
loc-budget-allow:
  - src/codegen/object-ops.ts
  - src/codegen/expressions/call-namespace-static.ts
---

# #4722 — Reflect.setPrototypeOf validation

## Scope

Own the one standalone validation cluster represented by:

- `test/built-ins/Reflect/setPrototypeOf/target-is-symbol-throws.js`
- `test/built-ins/Reflect/setPrototypeOf/proto-is-not-object-and-not-null-throws.js`
- `test/built-ins/Reflect/setPrototypeOf/proto-is-symbol-throws.js`

The successful primitive-target row and the successful object/null row are
controls. The standalone failures in `return-true-if-new-prototype-is-set.js`,
`return-false-if-target-and-proto-are-the-same.js`, and
`return-false-if-target-is-not-extensible.js` are excluded: they exercise the
native boolean/failure-channel semantics, not argument validation.

## Live baseline (upstream/main `778e4ae0f`, 2026-08-25)

Measured with the repository's assembled-harness probe, including structural
must-pass and must-fail controls. The host lane is the default `runTest262File`
target; standalone uses `--target standalone`.

| Test262 row | Host | Standalone |
|---|---:|---:|
| `target-is-symbol-throws.js` | pass | **fail** — expected TypeError, none thrown |
| `proto-is-not-object-and-not-null-throws.js` | pass | **fail** — expected TypeError, none thrown |
| `proto-is-symbol-throws.js` | pass | **fail** — expected TypeError, none thrown |
| `target-is-not-object-throws.js` (primitive target control) | pass | pass |
| `return-true-if-proto-is-current.js` (object/null control) | pass | pass |

The broader eight-row probe was host `7 pass / 1 fail` and standalone
`2 pass / 6 fail`; the four excluded failures all reported the existing
`Reflect.setPrototypeOf` native result/failure-channel gap. Both lanes' probes
observed the required positive and negative harness controls before reporting
rows.

## Root cause

The shared `emitNonObjectArgGuard` in `src/codegen/object-ops.ts` recognizes
undefined/null/boolean/number/string/bigint flags but omits TypeScript's
`ESSymbolLike` flag. A statically typed `Symbol(1)` target or prototype is
therefore lowered through the standalone native helper, which silently declines
non-`$Object` values instead of throwing. Separately, the
`Reflect.setPrototypeOf` call-site treats `undefined` as a legal nullish
prototype; §28.1.14 permits only `null`, so the first assertion in
`proto-is-not-object-and-not-null-throws.js` also falls through without a throw.

## Implementation plan

1. Extend the shared non-object guard with `ESSymbolLike`, preserving the
   existing side-effect evaluation and TypeError path for Object/Reflect users.
2. Make the Reflect.setPrototypeOf prototype exception explicit for `null`
   only; let the shared guard reject undefined, void, and all other primitive
   types. Do not change `__object_setPrototypeOf` or its separate boolean
   failure-channel residual.
3. Add focused host and standalone regression tests for Symbol target,
   Symbol prototype, undefined/number prototypes, plus object/null and ordinary
   primitive-target controls. Re-run the exact assembled-harness cohort and
   verify no excluded native-semantics row changes.

## Test Results

All commands used the pinned `pnpm 10.30.2` binary and the isolated worktree.

- Focused regressions: `pnpm exec vitest run tests/issue-4722.test.ts
  --reporter verbose` → **6/6 passed** (three host and three standalone cases).
- Exact assembled-harness validation cohort plus controls, using
  `scripts/harness-flip-probe.ts` with structural must-pass/must-fail controls:
  **host 5/5 pass**, **standalone 5/5 pass** for the three validation rows and
  two controls.
- Full eight-row guard: host remained **7 pass / 1 fail**; standalone moved
  from **2 pass / 6 fail** to **5 pass / 3 fail**. Exactly the three selected
  validation rows flipped `fail → pass`; the four excluded native
  boolean/failure-channel rows were unchanged.
- TypeScript 5: `pnpm run typecheck:ts5` → exit 0.
- TypeScript 7: `pnpm run typecheck` → exit 0.
- Lint: `pnpm run lint` → exit 0 (Biome reports the repository's existing
  diagnostic-summary warning, with no command failure).
- Format: `pnpm run format:check` → exit 0.
- Pre-push hook with the pinned PATH → typecheck/lint, format, oracle ratchet,
  coercion-site ratchet, numeric-local parity (18/18), conformance sync, and
  issue-integrity checks passed.

Baseline artifacts remain under `.tmp/` and are untracked by design:
`.tmp/4722-host-baseline.jsonl` and `.tmp/4722-standalone-baseline.jsonl`.
