---
id: 5122
title: "ES2015 standalone Proxy rejects Symbol target and handler"
status: in-review
sprint: current
created: 2026-08-28
updated: 2026-08-30
priority: high
horizon: s
feasibility: medium
reasoning_effort: max
task_type: conformance
area: codegen
es_edition: ES2015
language_feature: proxy-constructor-validation
goal: standalone-mode
assignee: "ttraenkler/codex/5122-proxy-spread-regression-main"
branch: codex/5122-proxy-spread-regression-main
pr: 5270
related: [5131]
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

## Reopen blocker: spread ArgumentListEvaluation

The published PR head has a remaining correctness defect: `new Proxy(...[{},
{}])` must construct a valid Proxy, but both host and standalone compiled
modules catch a `TypeError`. The Proxy-specific argument staging sees the
`SpreadElement` as one positional target instead of expanding its iterable
values, leaving the handler missing. This is a real evaluation/lowering bug,
not an acceptance-test narrowing: spread expansion must occur before the
constructor's target/handler validation and must preserve ordinary arguments.

The reopened implementation will first re-probe this shape on current
`upstream/main`, then trace and reuse the canonical spread/call/new lowering
and iterator evaluation path. It will cover static and dynamic spread sources,
mixed ordinary-plus-spread ordering, expanded extras, later abrupt evaluation
or iterator completion, valid object target/handler pairs, and Symbol
target/handler values after expansion in both host and standalone modes. The
regression suite will also assert function-index stability across late helper
registration, explicit outer timeouts and worktree-anchored corpus paths, and
zero standalone imports. Existing ordinary two-argument behavior, exact
TypeError identity, target-before-handler validation, trap-read suppression,
and nested-Proxy/object/array/function carriers remain required controls.

## Independent review decision: split strict dynamic spread

An independent Luna-max review of published checkpoint
`9f41bf3456585e12837945fba579451a5b2a0d85` passed the focused 6/6 suite but
found additional standalone regressions outside that matrix. These findings
supersede the ready handoff below and keep PR 5138 draft and dequeued:

- A dynamic array hole is captured as the native `$Hole` carrier instead of
  JavaScript `undefined`. `new Proxy(...([,,{}] as any))` and a hole in handler
  position can therefore construct a Proxy in standalone while host throws
  `TypeError`; a handler getter is observably read after the invalid value.
- The native iterator bridge accepts a bare `{ next() {} }` object that has no
  `@@iterator`, accepts an iterator object with no callable `next`, and treats
  those invalid spread sources as empty. ECMAScript spread must use strict
  `GetIterator`, not the bridge's internal `GetIteratorFlattenable` fallback.
- Primitive iterator results are not rejected as objects. A `next()` returning
  `1` is consumed or repeatedly polled instead of producing the catchable
  `TypeError` after exactly one call.
- Standalone Map default iteration projects values instead of entry arrays for
  this path, so `new Proxy(...new Map([[1, 2], [3, 4]]))` diverges from host.
  Empty typed arrays and String objects are also valid iterable sources in host
  but rejected in standalone; `.values()` can add a forbidden host import.
- Static array-literal flattening still bypasses an overridden
  `Array.prototype[Symbol.iterator]`. That is an inherited canonical lowering
  residual, not unique to this patch, but the repair must not broaden it.

### Scope decision

The review compared three repair shapes. Reusing the existing materializer is
not strict enough. Building the complete strict native provider here would add
roughly 200–400 cross-cutting lines across iterator acquisition, stepping, Map
projection, TypedArray/String admission, the host runtime, and this call site.
That substrate is now separately reserved as repository-local markdown issue
5131 (`5131-es2015-strict-spread-iterator.md`) and published as draft PR 5147.
No GitHub issue was created for it.

PR 5138 therefore takes the bounded fail-closed option:

1. Keep the ordinary no-spread Proxy fix and the correct static array-literal
   flattening/evaluation behavior already covered by this issue.
2. Remove the Proxy-specific generic iterator loop for non-literal or nested
   dynamic spreads. Do not expose the internal `GetIteratorFlattenable` bridge
   as ECMAScript spread and do not silently accept holes, malformed iterator
   records, value-projected Maps, or unsupported empty carriers.
3. When the strict provider is unavailable, decline the custom native path
   before emitting partial Wasm. Preserve an existing canonical host fallback
   when one is valid; standalone must fail closed with no new host import.
4. Keep bounded controls proving the supported static/ordinary path, source
   ordering, later-abrupt priority, exact Symbol TypeErrors, trap suppression,
   index stability, and zero imports. Move the strict dynamic behavior matrix
   to markdown issue 5131 rather than weakening its expected outcomes here.
5. Re-run both exact rows and all focused controls on current main, TypeScript
   5/7, lint, format, budgets, ratchets, numeric parity, and full pre-push. A
   second independent review must confirm that no unsupported dynamic path is
   silently claimed before PR 5138 becomes ready or enters the queue.

## Implementation plan

1. Before minting the native Proxy runtime, use the repository type oracle to
   decide whether either required argument can carry a native Symbol
   (`symbol`, `any`, `unknown`, `unresolvable`, or a union containing one).
   Ensure the existing Symbol carrier/classifier in that case so
   `__proxy_create` bakes a stable Symbol primitive discriminator even when the
   Proxy callee is compiled before the caller that creates the Symbol. Do not
   add raw TypeScript-checker queries or a Proxy-specific Symbol representation.
2. Complete `ArgumentListEvaluation` for ordinary arguments and the bounded
   static array-literal spread shape. Compile every supported argument exactly
   once in source order, retain the first target and handler values in
   externref locals, evaluate and discard extras, then invoke the existing
   provider. Missing target/handler still become the engine's
   undefined/nullish carrier and the runtime retains its established TypeError
   identity. Re-resolve defined function indices after argument compilation to
   avoid late-registration shifts. Decline non-literal/nested dynamic spreads
   before the custom native path until markdown issue 5131 supplies the strict
   provider.
3. Keep validation inside the shared native `__proxy_create` path so direct
   `new Proxy` and any existing native caller agree. Preserve valid ordinary
   objects, arrays, functions, nested Proxies, trap ordering, constructibility,
   and the zero-host-import standalone contract. Avoid globally tightening
   opaque externref or object classifiers.
4. Add `tests/issue-5122-es2015-proxy-symbol-targets.test.ts` with mandatory
   compiler controls independent of Test262 plus existence-guarded exact rows.
   Cover exact TypeError identity for target and handler; static and ordinary
   Symbol carriers; callee-before-caller ordering; complete evaluation of the
   supported ordinary/static argument shapes including extra side effects and
   later abrupt completion; target-before-handler validation; no trap read
   after invalid validation; valid object, array, callable, and nested-Proxy
   siblings; explicit fail-closed controls for unsupported dynamic spread; host
   controls for the changed argument path; and zero standalone imports.
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
- Unsupported non-literal/nested dynamic spreads are not routed through the
  internal flattenable iterator bridge and cannot become silent standalone
  successes or add host imports. Their complete strict semantics remain owned
  by repository-local markdown issue 5131.
- Invalid values do not trigger handler trap reads or allocate a usable Proxy.
- Focused standalone output has zero host imports.
- The focused suite, exact cohort, TypeScript 5/7, lint, format, budgets,
  ratchets, issue integrity, numeric-local parity, and full pre-push gate pass.
- The markdown issue contains final evidence and handoff details; no GitHub
  issue is created.

## Superseded validation checkpoint

The evidence in this section predates the independent strict-iterator review
above. It remains useful as the A/B record for the first spread repair, but it
is not a ready or mergeable handoff.

The reopened spread fix is implemented and validated on the fetched current
`upstream/main` `3ea0547d42d372d9c44cc9498fb7a019f48aafbc`, integrated
non-destructively by merge commit `7b01f19e9d6d4f26a3344d1792b1b30db3140fff`
with the earlier Proxy merge `ffbe9a8ba4def364079abe2a722a3e64ecc2b3a4`
and that upstream head in its ancestry. The published pre-merge checkpoint is
`9f41bf3456585e12837945fba579451a5b2a0d85`; the original implementation/test
checkpoint is `f37dfdec147595ea530097c9f3c16ca2bf13a2e0`; the plan-only reopen
checkpoint is `865f2f3863ff3c621135697b54944489f018031b`. All new commits are
authored by Thomas Tränkler and carry real newline-separated Codex trailers.
The branch remains unpublished after this merge for root's review and
external remote-head verification.

- Before the fix, the direct `new Proxy(...[{}, {}])` probe returned the
  caught-TypeError code in both host and standalone; after the fix it returns
  the success code in both lanes. Dynamic array sources likewise succeed.
- Focused Vitest with the pinned QuickJS artifact and at most two workers:
  **6/6 passed** after the upstream merge. Both exact host rows and both exact
  standalone rows passed. Host and standalone controls cover static/dynamic
  spread sources, mixed ordinary-plus-spread ordering, empty and multiple
  spreads, nested spread expansion, expanded extras, later abrupt argument
  evaluation and iterator steps, target-before-handler validation with no trap
  reads, Symbol target/handler after expansion, callee-before-caller
  index stability, and valid ordinary object, array, function, and
  nested-Proxy carriers. The standalone compiler asserted `imports === []`,
  including the direct `any`-to-externref/ref.test fallback controls.
- TypeScript 5 and TypeScript 7 typechecks passed. Full Biome lint and
  Prettier checks passed. Oracle and coercion-site ratchets passed with zero
  net growth. LOC/function budgets passed using only this issue's narrow
  allowances. Stack-balance, dead-export, issue-spec, done-status, committed
  issue-integrity, conformance-sync, and IR-adoption checks passed. Numeric-
  local parity passed **18/18**.
- The corpus guard is worktree-anchored through `import.meta.dirname` and the
  exact Test262 rows remain existence-guarded. No source outside the owned
  files was changed by this fix, and no host import is emitted by standalone
  controls.

## Current-main regression repair (2026-08-30)

Upstream PR 5138 merged its initial implementation at published head
`772dd0a24ffd30cff0a2cc8995632416b28e3c22`. The later independent review found
that its Proxy-specific dynamic-spread loop exposed the permissive internal
iterator bridge as ECMAScript spread. That is a landed correctness regression,
so the bounded fail-closed repair is a separate follow-up fix rather than a
continuation of the already-merged PR.

The shared upstream reference was force-refreshed from `loopdive/js2` on
2026-08-30 to `4881206ab3001505fcfca875589aff8daf375ff9`. A Git patch-equivalence
audit (`git cherry -v upstream/main HEAD`) identified
`d37893746de821ec9363d5fcdea31aa038040b4f` as the sole reviewed repair not
already represented on main. Replaying that commit onto a fresh branch from
the exact upstream head was conflict-free and produced synchronized checkpoint
`0055e7cf6866e54cc1e3a74cf699eb65c5748364`. The replayed commit now carries
the repository-required `Model: Codex GPT-5.6 Luna Max` attribution in addition
to the Thomas author identity and real Codex co-author trailer.

The repair removes the permissive `__iterator`/`__iterator_next` route from
Proxy ArgumentListEvaluation. Host-mode dynamic and nested spreads use the
canonical strict materializer; standalone reports a sticky compile error for
those still-unsupported shapes before emitting a partial body. Ordinary and
statically flattenable array-literal spreads retain complete source-order
evaluation, Symbol validation, trap suppression, and zero-import native
behavior.

Focused validation on the synchronized checkpoint used the pinned QuickJS
artifact and at most two workers: `vitest run
tests/issue-5122-es2015-proxy-symbol-targets.test.ts --maxWorkers=2` passed
**10/10**. That includes both exact Test262 rows in host and standalone modes,
the ordinary/static ordering and sibling matrix in both modes, the canonical
host dynamic/nested-spread controls, and the standalone fail-closed controls.
TypeScript 5 and TypeScript 7 no-emit checks passed. Numeric-local parity passed
**18/18**. Focused Biome and Prettier checks, LOC/function budgets,
oracle/coercion ratchets, issue integrity, the full commit-hook changed-root
suite, and the complete pre-push chain also passed.

## Handoff

Continue only in
`/private/tmp/js2-es2015-proxy-spread-regression-20260830` on branch
`codex/5122-proxy-spread-regression-main`. The implementation checkpoint is
`0055e7cf6866e54cc1e3a74cf699eb65c5748364`; the first published combined head
is `86494ad1c16d4f38c7c92a4cd9879a670e770eca`, and local/fork heads were
verified equal before publication. The non-draft upstream follow-up is PR 5270:
<https://github.com/loopdive/js2/pull/5270>. Its live audit confirms base
`loopdive/js2:main`, head
`ttraenkler:codex/5122-proxy-spread-regression-main`, the required
Description/CLA body, and a checked CLA box. CI and merge-queue validation are
now the remaining blockers to `done`; freeze the exact head once queued. Do not
create a GitHub issue; this markdown file remains the canonical tracker.
