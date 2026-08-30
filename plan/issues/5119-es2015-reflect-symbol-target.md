---
id: 5119
title: "ES2015 standalone Reflect.get/has reject Symbol targets"
status: done
created: 2026-08-28
updated: 2026-08-28
completed: 2026-08-28
priority: medium
horizon: s
feasibility: medium
reasoning_effort: max
task_type: bugfix
area: codegen
es_edition: 2015
language_feature: reflect-target-validation
goal: standalone-mode
pr: 5133
assignee: ttraenkler/codex/5119-es2015-reflect-symbol-target
related: [4722, 4724]
files:
  - src/codegen/expressions/call-namespace-static.ts
  - tests/issue-5119-es2015-reflect-symbol-target.test.ts
  - plan/issues/5119-es2015-reflect-symbol-target.md
loc-budget-allow:
  - src/codegen/expressions/call-namespace-static.ts
func-budget-allow:
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
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

## Implementation checkpoint

The native standalone route now evaluates every supplied get/has argument once
into temporary externref locals, then tests only the native `$Symbol` carrier
before invoking `__extern_get`, `__extern_has`, or the explicit-receiver helper.
This intentionally does not reuse the broader `$Object` guard: arrays,
callables, typed arrays, and other native object carriers are sibling heap types
and must continue to reach their existing helpers. The host route uses the same
argument-local evaluation and rejects statically known Symbol targets before its
host wrapper's property-key conversion; no runtime helper or unrelated Reflect
method was changed.

The Symbol-carrier guard is lazily emitted only when the oracle's `TypeFact`
for the target can contain `symbol`, `any`, `unknown`, or an unresolvable value
(including a union containing one of those facts). Concrete object, array, and
function targets do not add a second guard or direct checker query; the
oracle-ratchet gate remains net-neutral. A read-only standalone compile probe
confirmed that the existing native Reflect/object runtime already registers
the shared `$Symbol`/`__box_symbol` and TypeError machinery for any Reflect
get/has call, while the new guard contributes only the conditional call-site
instructions for Symbol-capable targets.

Post-change assembled-harness A/B arms (each with the mandatory pass/fail
controls and 120 s per-file timeout) are `.tmp/5119-after-host.jsonl` and
`.tmp/5119-after-standalone.jsonl`. Host remains **2/2 pass**. Standalone is
**2/2 pass**, with local-vs-local partition `fail -> pass: 2`, `pass -> fail: 0`,
and no other status changes. The focused suite's 24 tests (20 controls and
four existence-guarded corpus arms) pass in both host and standalone lanes;
the controls include a callee-before-caller dynamic `any` target for both
methods. Every compile-heavy control has a 150 s Vitest timeout and every
corpus arm has a 150 s timeout with a 130 s runner timeout.

## Final integrated-head evidence

The implementation was integrated without rewriting its earlier commits:
merge commit `6ad04842a76d15a13d5da89985c61578c93d5415` has parents
`e7eae37185ffcf9b1899d3ec54475d9c64d35f0d` and freshly fetched
`upstream/main` `f8a9017448468a216fe2a12dde768101a90785ca`. On that head:

- The focused Vitest suite passed **24/24** (20 controls plus four
  existence-guarded exact-row arms), with host and standalone lanes, dynamic
  callee-before-caller targets, later abrupt arguments, no-key-coercion,
  receiver, object, array, and callable controls.
- The final assembled harness passed both exact rows in both lanes: host
  **2/2**, standalone **2/2**. Compared with the retained local arms, host is
  pass→pass for both rows and standalone is fail→pass for exactly both rows.
- TypeScript 5 and 7, Prettier, changed-file Biome lint, LOC/function budgets,
  oracle-ratchet, coercion-sites, synchronization, issue integrity, issue spec
  coverage, and the pinned numeric-local pre-push test passed. Full lint exits
  successfully with the repository's pre-existing capped **1,749**
  diagnostics (the two changed files are clean).
- The full equivalence gate passed with **1,680** passing and **24** failing;
  all 24 failures are in the committed known-failure baseline, so there were
  no new regressions.

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

The dedicated worktree is clean on `codex/5119-es2015-reflect-symbol-target`.
Root pushed the exact validated head to `ttraenkler/js2` and opened the single
non-draft upstream PR: <https://github.com/loopdive/js2/pull/5133>. It targets
`loopdive/js2:main`, uses the repository template with the CLA checked, and was
audited as mergeable with no comments, reviews, or unresolved review threads
at creation. No GitHub issue was created.
