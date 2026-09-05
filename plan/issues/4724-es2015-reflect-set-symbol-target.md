---
id: 4724
title: "ES2015 Reflect.set rejects Symbol targets in standalone mode"
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
language_feature: reflect-set-target-validation
goal: standalone-mode
assignee: codex/4724-es2015-reflect-set-symbol-target
related: [2046, 4722]
loc-budget-allow:
  - src/codegen/object-ops.ts
  - src/codegen/expressions/call-namespace-static.ts
func-budget-allow:
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
---

# #4724 — Reflect.set Symbol-target validation

## Scope

Own the bounded standalone validation residual represented by
`test/built-ins/Reflect/set/target-is-symbol-throws.js`. The nearby primitive
target control (`target-is-not-object-throws.js`) and the valid
Symbol-key/value control (`symbol-property.js`) are included only to ensure
the target guard does not change valid keys or ordinary primitive values.
Property-key conversion failures (`return-abrupt-from-property-key.js`) are a
separate native ToPropertyKey residual and are excluded. Explicit-receiver
rows remain out of scope because standalone Reflect.set with a receiver is an
existing #2046 compile-time refusal.

## Live baseline (upstream/main `c6a44181d`, 2026-08-25)

The exact Test262 source was measured in the isolated worktree with
`scripts/harness-flip-probe.ts`, which runs the assembled Test262 harness and
requires structural must-pass/must-fail controls before emitting rows. The
default host lane passes both rows; standalone incorrectly returns native
refusal results for primitive targets:

| Test262 row | Host | Standalone |
|---|---:|---:|
| `target-is-symbol-throws.js` | pass | **fail** — expected TypeError, none thrown |
| `target-is-not-object-throws.js` (primitive-target control) | pass | **fail** — expected TypeError, none thrown |
| `symbol-property.js` (Symbol key / primitive value control) | pass | **compile_error** — existing explicit-receiver refusal (#2046) |

The structural controls were both observed in each lane (`control-must-pass` →
pass and `control-must-fail` → fail), so the four-row status output is
measured rather than a silent-empty result. Raw baseline rows are retained in
`.tmp/4724-host-baseline.jsonl` and `.tmp/4724-standalone-baseline.jsonl`.

## Root cause

The standalone `Reflect.set` lowering in
`src/codegen/expressions/call-namespace-static.ts` emits the three arguments
directly to `__reflect_set`. That native helper implements the supported
property-write subset but does not enforce Reflect's §26.1.13 step 1
`Type(target) is Object` precondition. Statically primitive targets therefore
reach the helper and return a false/refusal result instead of throwing. The
shared `emitNonObjectArgGuard` is the established call-site validation path;
its `ESSymbolLike` coverage is supplied by the open stacked validation PR
`#4945` (the #4722 fix). This child therefore depends on #4945.

## Implementation plan

1. Stack on #4945 so the shared non-object guard recognizes statically typed
   Symbols, then invoke that guard for the standalone `Reflect.set` target
   before emitting native arguments. Preserve argument evaluation side effects
   and leave keys/values untouched.
2. Add focused host and standalone tests for Symbol and ordinary primitive
   targets, plus valid object + Symbol-key/primitive-value controls. Confirm
   the explicit-receiver refusal and existing native write semantics stay out
   of scope.
3. Re-run exact target/control probes, then TS5/TS7 typecheck, lint, format,
   and pre-push checks. Record measured results here before opening the PR.

## Test Results

All probes used the pinned project toolchain and this isolated worktree.

- Exact assembled-harness cohort with structural controls: host **3/3 pass**;
  standalone **2/3 pass** with the existing explicit-receiver control still a
  compile error. Compared with the pre-fix local arm, standalone had exactly
  **2 fail → pass** flips (Symbol target and ordinary primitive target), zero
  losses, and one unchanged excluded control. Host had zero flips.
- Focused Vitest regression passed after the final upstream merge: **1 test
  file, 6 tests**. Direct host/standalone source probes also covered Symbol,
  number/null/undefined/string primitive targets and an object target with a
  primitive string key/number value; every case returned the expected `1`
  verdict.
- TypeScript 5 and TypeScript 7 `--noEmit` checks passed after the final
  `upstream/main` merge. Focused Biome lint and Prettier checks passed; the
  repository-wide lint and `format:check` also passed. The lint command still
  reports the repository's existing diagnostics summary (1,672 diagnostics
  suppressed by its configured display limit), while the three changed files
  were clean at error level.
- `check:oracle-ratchet`, `check:coercion-sites`, loc budget, function budget,
  `git diff --check`, and the pinned pnpm 10 pre-push fast lane all passed.
  The pre-push lane also ran the numeric-local parity smoke test (18/18).
- The implementation remains stacked on #4945 because its shared
  `ESSymbolLike` addition is required for the Symbol target guard. The exact
  source delta is 10 lines in `call-namespace-static.ts`; no unrelated
  dependency/setup files are included.

Raw local measurements remain under `.tmp/4724-*.jsonl`; they are untracked by
design.
