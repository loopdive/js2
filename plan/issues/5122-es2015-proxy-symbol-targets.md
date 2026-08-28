---
id: 5122
title: "ES2015 standalone Proxy rejects Symbol target and handler"
status: ready
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
language_feature: proxy-constructor-validation
goal: standalone-mode
assignee: "ttraenkler/codex/5122-es2015-proxy-symbol-targets"
branch: codex/5122-es2015-proxy-symbol-targets
files:
  - src/codegen/expressions/new-builtin-globals.ts
  - src/codegen/object-runtime-proxy.ts
  - tests/issue-5122-es2015-proxy-symbol-targets.test.ts
  - plan/issues/5122-es2015-proxy-symbol-targets.md
loc-budget-allow:
  - src/codegen/expressions/new-builtin-globals.ts
  - src/codegen/object-runtime-proxy.ts
func-budget-allow:
  - src/codegen/expressions/new-builtin-globals.ts::tryCompileBuiltinGlobalNew
  - src/codegen/object-runtime-proxy.ts::ensureProxyRuntime
---

# #5122 — ES2015 standalone Proxy Symbol target/handler validation

## Scope and ownership

This markdown issue owns exactly these two ES2015 host-pass/standalone-fail
Test262 rows:

- `test/built-ins/Proxy/create-target-not-object-throw-symbol.js`
- `test/built-ins/Proxy/create-handler-not-object-throw-symbol.js`

Issue ID 5122 was atomically reserved through
`node scripts/claim-issue.mjs --allocate` and verified on
`upstream/issue-assignments`. This file is the canonical tracker; do not create
a GitHub issue. GitHub PR number 5122, if encountered, is an unrelated object
in GitHub's shared issue/PR number space and is not this tracker.

## Current-main A/B evidence

The branch starts from freshly fetched `upstream/main` at
`f8a9017448468a216fe2a12dde768101a90785ca`. The authoritative snapshots are:

- standalone: `/private/tmp/js2-baseline-standalone-current-20260828.jsonl`
  (SHA256 `260a57b7fb4d53516fa81e1c949d81337968e30ce790d457bcc2d3945c2e9e1e`);
- host: `/private/tmp/js2-baseline-host-current-20260828.jsonl`
  (SHA256 `a395f2a88d289a8e0fd78ccd76e090215ef3a85f1960aa8fe96f7d3a0445bd49`).

Both exact host rows pass. Both standalone rows reach the test and fail with
`assertion_fail`: `Expected a TypeError to be thrown but no exception was
thrown at all`. Neither row is a compile error, timeout, or skip.

## Root cause

`tryCompileBuiltinGlobalNew` handles native-first `new Proxy(target, handler)`
in `src/codegen/expressions/new-builtin-globals.ts`. It currently calls
`ensureNativeProxyRuntime(ctx)` before compiling either constructor argument.
The native `__proxy_create` body is minted at that moment in
`src/codegen/object-runtime-proxy.ts`; its `requireObject` primitive
classifier list is a one-time snapshot of the `__typeof_*` functions already
registered in `ctx.funcMap`.

The native Symbol carrier and `__typeof_symbol` classifier are registered
lazily while a later `Symbol(...)` argument is compiled. Because the Proxy
runtime body was already baked, its object validation never calls that new
classifier. The Symbol carrier therefore reaches trap reads and proxy
allocation as though it were an Object.

The call site has a second conformance gap at the same seam: it compiles only
the first two arguments. JavaScript `ArgumentListEvaluation` must evaluate all
supplied expressions in source order before Proxy constructor validation, so
ignored extra arguments must still run and a later abrupt completion must win
over the target/handler `TypeError`.

## Implementation plan

1. Before minting the native Proxy runtime, use the repository type oracle to
   decide whether either required argument can carry a native Symbol
   (`symbol`, `any`, `unknown`, `unresolvable`, or a union containing one).
   Ensure the existing Symbol carrier/classifier in that case so
   `__proxy_create` bakes a stable Symbol primitive discriminator even when the
   Proxy callee is compiled before the caller that creates the Symbol. Do not
   add raw TypeScript-checker queries or a Proxy-specific Symbol representation.
2. Complete `ArgumentListEvaluation` for both native-first and host Proxy
   construction. Compile every supplied argument exactly once in source order,
   retain the first target and handler values in externref locals, evaluate and
   discard extras, then invoke the existing provider. Missing target/handler
   still become the engine's undefined/nullish carrier and the runtime retains
   its established TypeError identity. Re-resolve defined function indices
   after argument compilation to avoid late-registration shifts.
3. Keep validation inside the shared native `__proxy_create` path so direct
   `new Proxy` and any existing native caller agree. Preserve valid ordinary
   objects, arrays, functions, nested Proxies, trap ordering, constructibility,
   and the zero-host-import standalone contract. Avoid globally tightening
   opaque externref or object classifiers.
4. Add `tests/issue-5122-es2015-proxy-symbol-targets.test.ts` with mandatory
   compiler controls independent of Test262 plus existence-guarded exact rows.
   Cover exact TypeError identity for target and handler; static and dynamic
   Symbol carriers; callee-before-caller ordering; complete argument evaluation
   including extra side effects and later abrupt completion; target-before-
   handler validation; no trap read after invalid validation; valid object,
   array, callable, and nested-Proxy siblings; host controls for the changed
   argument path; and zero standalone imports.
5. Run fresh exact host/standalone A/B with the authoritative runner and pinned
   QuickJS artifact, focused regressions with at most two workers, TypeScript
   5/7, lint, Prettier, oracle/coercion and LOC/function budgets, issue
   integrity, numeric-local parity, and the complete pre-push hook. Integrate
   current upstream non-destructively, push every checkpoint to
   `ttraenkler/js2`, and hand the exact final SHA/evidence back to root.

## Acceptance

- Both exact rows pass in host and standalone lanes.
- Static and dynamic Symbol targets/handlers throw the engine's exact
  `TypeError`; valid object-like sibling carriers remain accepted.
- Every constructor argument expression is evaluated once in source order,
  and a later abrupt extra argument wins before Proxy validation.
- Invalid values do not trigger handler trap reads or allocate a usable Proxy.
- Focused standalone output has zero host imports.
- The focused suite, exact cohort, TypeScript 5/7, lint, format, budgets,
  ratchets, issue integrity, numeric-local parity, and full pre-push gate pass.
- The markdown issue contains final evidence, handoff, final SHA, and upstream
  PR URL; no GitHub issue is created.

## Final validation and handoff

Implementation and validation completed on the synchronized branch. The final
validated tree is rooted at `upstream/main` `abf224159c32447eff7e36d51849278bb07ddf83`
through merge commit `b88aef9ae77872680316a79dddfa2fdd6fde63f4`; the final
implementation/test head before this status update is
`896030a58aa2d2ded1ce3d6147d958eb73f159db`. All three commits are authored by
Thomas Tränkler and carry real newline-separated Codex trailers.

- Focused Vitest with the pinned artifact and two workers: **6/6 passed**;
  both exact host rows and both exact standalone rows passed, and host-free
  controls passed for static/dynamic Symbols, callee-before-caller ordering,
  all-argument evaluation and later abrupt completion, target-before-handler
  validation, trap-read suppression, and ordinary object/array/function/
  nested-Proxy carriers. The standalone compiler result asserted `imports ===
  []`.
- TypeScript 5 and TypeScript 7 typechecks passed. Full Biome lint and
  Prettier checks passed. Oracle and coercion-site ratchets passed with zero
  net growth. LOC/function budgets passed using only this issue's two narrow
  source/function allowances. Issue-spec coverage, done-status, full issue
  integrity, and conformance-sync checks passed. Numeric-local parity passed
  **18/18**.
- The complete `.husky/pre-push` hook passed locally with the fixed toolchain
  PATH, including parallel typecheck/lint, format, oracle/coercion ratchets,
  numeric-local parity, conformance sync, and committed issue integrity.
- The fork push is pending explicit external-write authorization from the
  environment; no remote state was changed and no PR was opened. Once
  authorized, push this exact branch without force and verify the remote SHA
  equals `896030a58aa2d2ded1ce3d6147d958eb73f159db` before root opens the one
  non-draft upstream PR.

## Handoff

Work only in `/private/tmp/js2-es2015-proxy-symbol-targets-20260828` on branch
`codex/5122-es2015-proxy-symbol-targets`. Push checkpoints to the fork without
force. Do not open the PR from the worker; root will review the final clean
branch and open exactly one non-draft PR against `loopdive/js2:main` when it is
mergeable.
