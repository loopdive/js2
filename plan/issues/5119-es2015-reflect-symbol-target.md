---
id: 5119
title: "ES2015 standalone Reflect.get/has reject Symbol targets"
status: in-progress
created: 2026-08-28
updated: 2026-08-28
priority: medium
horizon: s
feasibility: medium
reasoning_effort: max
task_type: bugfix
area: codegen
es_edition: 2015
language_feature: reflect-target-validation
goal: standalone-mode
assignee: codex/5119-es2015-reflect-symbol-target
related: [4722, 4724]
files:
  - src/codegen/expressions/call-namespace-static.ts
  - tests/issue-5119-es2015-reflect-symbol-target.test.ts
  - plan/issues/5119-es2015-reflect-symbol-target.md
---

# #5119 — Standalone Reflect.get/has Symbol-target validation

## Scope

Own exactly the two current standalone residual rows:

- `test/built-ins/Reflect/get/target-is-symbol-throws.js`
- `test/built-ins/Reflect/has/target-is-symbol-throws.js`

The corresponding host rows are passing. This slice does not change the
native object helpers, property-key conversion, optional receiver semantics,
or unrelated Reflect methods. Ordinary object targets and valid property keys
remain controls.

## Live baseline and source review

The authoritative snapshots are `/private/tmp/js2-baseline-host-current-20260828.jsonl`
and `/private/tmp/js2-baseline-standalone-current-20260828.jsonl`, recorded on
2026-08-28 with `oracle_version: 13` and `oracle_lane: honest`, at the current
`upstream/main` head `796d8c2cd28648d21de2ada5a0b662e758f7dda3`:

| Test262 row | Host | Standalone |
| --- | ---: | ---: |
| `Reflect/get/target-is-symbol-throws.js` | pass | **fail** — `Expected a TypeError to be thrown but no exception was thrown at all` |
| `Reflect/has/target-is-symbol-throws.js` | pass | **fail** — `Expected a TypeError to be thrown but no exception was thrown at all` |

The current-main A/B was independently re-run in the dedicated worktree with
the assembled-harness `scripts/harness-flip-probe.ts`, using the host lane and
`--target standalone` lane separately, with a 120 s per-file timeout. Each run
first observed `control-must-pass -> pass` and `control-must-fail -> fail`.
The local arms are retained as `.tmp/5119-base-host.jsonl` and
`.tmp/5119-base-standalone.jsonl` (untracked): host **2/2 pass**; standalone
**2/2 fail**, matching the authoritative rows and error text.

In `src/codegen/expressions/call-namespace-static.ts`, the native standalone
`Reflect.get(target, key)` and `Reflect.has(target, key)` arms currently call
`emitReflectArgs` directly and then invoke `__extern_get` / `__extern_has`.
Unlike the neighboring `Reflect.set` arm, they have no call-site validation for
the ECMAScript requirement that `target` be an Object. The shared
`emitNonObjectArgGuard` already recognizes `ESSymbolLike` (from the landed
Reflect validation work), so the missing piece is the narrow get/has call-site
ordering.

The governing algorithms are ECMAScript §28.1.5 (`Reflect.get`) and §28.1.8
(`Reflect.has`): after `ArgumentListEvaluation`, step 1 rejects a non-Object
target, step 2 performs `ToPropertyKey`, and `Reflect.get` then supplies the
implicit receiver. `ArgumentListEvaluation` is §13.3.8.1; all supplied
argument expressions are evaluated in source order before the Reflect method
body runs.

## Implementation plan

1. In the native standalone `Reflect.get` and `Reflect.has` call routes, first
   evaluate every supplied argument expression exactly once, in source order,
   into temporary externref locals. This includes an optional receiver and any
   extra arguments (which the built-in ignores after evaluation), so a later
   abrupt argument expression wins over target validation as required by
   §13.3.8.1.
2. After argument evaluation, validate the saved first argument with the
   existing TypeError path, including statically typed Symbols, before loading
   the key into any native helper or using the optional receiver. Keep later
   property-key/receiver coercion hooks untouched when the target is invalid.
3. Invoke the existing native get/has helpers with the saved values, preserving
   current object-target behavior. Add focused Vitest coverage for exact
   TypeError identity, Symbol targets, argument ordering/abrupt completion,
   no post-validation key coercion, optional receiver behavior, ordinary
   object targets, and zero standalone imports. Add an existence-guarded exact
   corpus check only if the Test262 checkout exposes both target rows; use a
   Vitest timeout greater than 120 s for that optional check.

## Acceptance

- Both named Test262 rows flip standalone `fail -> pass`; host remains pass.
- Invalid Symbol targets throw the engine's exact TypeError in both methods.
- All supplied argument expressions still run once in source order; a later
  abrupt argument expression wins over invalid-target validation.
- For an invalid Symbol target, property-key conversion and optional-receiver
  coercion hooks do not run after argument evaluation.
- Positive object-target get/has behavior and optional receiver behavior remain
  correct; no unrelated Reflect row changes.
- Standalone output has zero host imports for the focused cases.
- Structural host and standalone controls pass, and the focused Vitest suite,
  TypeScript 5/7 checks, lint, Prettier, budget/oracle/coercion gates, and
  pinned pre-push checks pass.

## Handoff

The plan checkpoint is intentionally separate from the implementation commit.
After pushing it, continue on `codex/5119-es2015-reflect-symbol-target` in
`/private/tmp/js2-es2015-reflect-symbol-target-20260828`; push each subsequent
checkpoint to `ttraenkler/js2`. Do not create a GitHub issue or PR. Report the
final source review, exact host/standalone rows and controls, full gates,
clean status, branch, and head SHA to the coordinating agent for review and
the single upstream PR.
