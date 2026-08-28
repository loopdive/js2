---
id: 5123
title: "ES2015 escape and unescape reject Symbol arguments in standalone"
status: in-progress
sprint: current
created: 2026-08-28
updated: 2026-08-28
priority: high
horizon: s
feasibility: medium
reasoning_effort: max
task_type: conformance
area: codegen
es_edition: ES2015
language_feature: annex-b-escape-unescape-tostring
goal: standalone-mode
assignee: "ttraenkler/codex/5123-es2015-escape-symbol-tostring"
branch: codex/5123-es2015-escape-symbol-tostring
files:
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/standalone-global-functions.ts
  - tests/issue-5123-es2015-escape-symbol-tostring.test.ts
  - plan/issues/5123-es2015-escape-symbol-tostring.md
---

# #5123 — ES2015 `escape`/`unescape` strict Symbol `ToString`

## Scope and ownership

This markdown issue owns exactly these two ES2015 Test262 rows:

- `test/annexB/built-ins/escape/to-string-err-symbol.js`
- `test/annexB/built-ins/unescape/to-string-err-symbol.js`

The edition map classifies both rows as ES2015. Issue ID 5123 was atomically
reserved with `node scripts/claim-issue.mjs --allocate`, then claimed for this
branch on `upstream/issue-assignments`. This file is the canonical tracker; do
not create a GitHub issue.

## Current-main A/B evidence

The branch starts from freshly fetched `upstream/main` at
`abf224159c32447eff7e36d51849278bb07ddf83`. The authoritative snapshots are:

- standalone: `/private/tmp/js2-baseline-standalone-current-20260828.jsonl`
  (SHA256 `260a57b7fb4d53516fa81e1c949d81337968e30ce790d457bcc2d3945c2e9e1e`);
- host: `/private/tmp/js2-baseline-host-current-20260828.jsonl`
  (SHA256 `a395f2a88d289a8e0fd78ccd76e090215ef3a85f1960aa8fe96f7d3a0445bd49`).

Both exact host rows pass. Both standalone rows reach the test and fail with
`assertion_fail`: `Expected a TypeError to be thrown but no exception was
thrown at all`. Neither row is a compile error, timeout, or skip.

## Root cause

The native-first direct-call route in
`src/codegen/expressions/call-identifier.ts` compiles the first argument and
passes it through the general `emitToString` machinery before calling
`__escape` or `__unescape`. The first-class/global-object function closures in
`src/codegen/standalone-global-functions.ts` similarly call
`__extern_toString` before the native transform.

That general string boundary is intentionally permissive for the explicit
`String(Symbol())` operation, which produces a descriptive string. Annex B
`escape` and `unescape`, however, invoke the abstract `ToString` operation;
`ToString(Symbol)` must be abrupt. A native Symbol is otherwise rendered rather
than rejected, so both exact rows silently continue.

The direct fast path also compiles only argument zero. JavaScript evaluates
every supplied argument expression before entering the builtin. Consequently
ignored extra arguments must still run once in source order, and a later abrupt
completion must win before the Symbol `TypeError`.

## Implementation plan

1. Add one narrow strict-Symbol string boundary shared in behavior by the
   direct native `escape`/`unescape` calls and their standalone first-class
   closures. Reuse the existing native Symbol carrier and catchable TypeError
   machinery; do not globally change `emitToString`, `__extern_toString`, or
   explicit `String(Symbol())` semantics.
2. For direct native calls, complete `ArgumentListEvaluation` before builtin
   coercion: evaluate every supplied argument exactly once in source order,
   retain argument zero as an externref/native carrier, discard ignored extras,
   then perform the strict Symbol guard and existing string transform. Preserve
   the omitted-argument result (`"undefined"`) and re-resolve any helper index
   shifted by later argument compilation.
3. Ensure the Symbol carrier/discriminator before a standalone `escape` or
   `unescape` closure body is minted whenever its dynamic argument channel can
   carry Symbol. This must cover a function value or helper compiled before the
   caller creates a Symbol, direct identifier calls, aliased value calls, and
   `globalThis.escape`/`globalThis.unescape`, without introducing host imports.
4. Add `tests/issue-5123-es2015-escape-symbol-tostring.test.ts` with mandatory
   compiler controls independent of Test262 and existence-guarded exact rows.
   Cover exact TypeError identity for both functions; direct, first-class,
   aliased, global-object, dynamic-`any`, and callee-before-caller forms;
   complete extra-argument evaluation and later-abrupt priority; omitted and
   ordinary string/number controls; explicit `String(Symbol())` remaining
   valid; and zero standalone imports. Include host controls for any shared
   argument-evaluation path changed by the fix.
5. Run fresh exact host/standalone A/B with the authoritative runner and pinned
   QuickJS artifact, focused regressions with at most two workers, TypeScript
   5/7, lint, Prettier, oracle/coercion and LOC/function budgets, issue
   integrity, numeric-local parity, and the complete pre-push hook. Integrate
   current upstream non-destructively and push every checkpoint to
   `ttraenkler/js2` without rewriting published history.

## Acceptance

- Both exact rows pass in host and standalone lanes.
- All direct and first-class native forms throw the engine's exact `TypeError`
  for static and dynamic Symbol arguments, including callee-before-caller.
- Every supplied argument expression executes exactly once in source order;
  a later abrupt extra argument wins before Symbol coercion.
- Omitted, string, and numeric inputs retain their correct results, and
  explicit `String(Symbol())` remains printable.
- Focused standalone modules emit zero host imports.
- Focused/exact tests, TypeScript 5/7, lint, format, budgets, ratchets, issue
  integrity, numeric-local parity, and full pre-push pass.
- This markdown issue records final evidence, final SHA, handoff, and the
  single non-draft upstream PR URL; no GitHub issue is created.

## Handoff

Work only in `/private/tmp/js2-es2015-escape-symbol-tostring-20260828` on branch
`codex/5123-es2015-escape-symbol-tostring`. Push checkpoints to the fork without
force. Do not open the PR from the worker; root will review the final clean
branch and open exactly one non-draft PR against `loopdive/js2:main` when it is
mergeable.
