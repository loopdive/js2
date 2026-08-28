---
id: 5131
title: "ES2015 strict native spread iterator materializer"
status: in-progress
sprint: current
created: 2026-08-28
updated: 2026-08-28
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: conformance
area: codegen, runtime, iterators
es_edition: ES2015
language_feature: spread-getiterator-iteratorresult
goal: standalone-mode
assignee: "ttraenkler/codex-es2015-strict-spread-iterator"
branch: codex/5131-es2015-strict-spread-iterator
pr: 5147
related: [5122, 681, 1592, 1970, 2159, 2651, 3643, 4275, 4768]
required_by: [5122]
files:
  - src/codegen/iterator-native.ts
  - src/codegen/map-runtime.ts
  - src/codegen/expressions/new-builtin-globals.ts
  - src/runtime.ts
  - tests/issue-5131-es2015-strict-spread-iterator.test.ts
  - plan/issues/5131-es2015-strict-spread-iterator.md
loc-budget-allow:
  - src/codegen/iterator-native.ts
  - src/codegen/map-runtime.ts
  - src/codegen/expressions/new-builtin-globals.ts
  - src/runtime.ts
func-budget-allow:
  - src/codegen/iterator-native.ts::finalizeNativeIteratorRuntime
  - src/codegen/expressions/new-builtin-globals.ts::tryCompileBuiltinGlobalNew
  - src/runtime.ts::resolveImport
---

# #5131 — ES2015 strict native spread iterator materializer

## Scope and canonical tracking

This repository-local markdown file is the sole issue record for this work.
Issue ID 5131 was atomically reserved through
`node scripts/claim-issue.mjs --allocate` on `upstream/issue-assignments` for
`ttraenkler/codex-es2015-strict-spread-iterator`. Do not create a GitHub issue.
GitHub PR/issue number 5131 already names an unrelated object in GitHub's
shared number space and must never be used as shorthand for this tracker; PR
bodies and handoffs must cite
`plan/issues/5131-es2015-strict-spread-iterator.md` explicitly.

The work was separated from repository-local markdown issue 5122 after an
independent Luna-max review of draft PR 5138. That issue file is still carried
on its own draft branch and is therefore intentionally not linked as a path
from this current-main branch. The reviewed Proxy-specific dynamic-spread
lowering called the general native `__iterator` / `__iterator_next` bridge.
Those helpers intentionally accept internal flattenable carriers and degrade
some malformed protocol values, so exposing them as ECMAScript spread silently
changed observable behavior. The narrow Proxy fix will fail closed for that
dynamic path until this strict provider exists.

## Measured defects

The review reproduced these host/standalone disagreements at the spread
materialization boundary:

- array holes were emitted as the private `$Hole` carrier instead of the
  JavaScript `undefined` value, allowing an invalid Proxy target or handler to
  pass validation and reach a handler getter;
- a bare `{ next() {} }` object without `@@iterator`, an absent or non-callable
  `@@iterator`, and an iterator with absent or non-callable `next` were accepted
  as empty or flattenable inputs instead of throwing `TypeError`;
- a primitive IteratorResult was consumed, degraded, or polled again rather
  than throwing a catchable `TypeError` after exactly one `next()` call;
- native Map default iteration projected values instead of fresh `[key, value]`
  entry arrays;
- valid empty TypedArray and String-object iterables could be rejected, while
  some alternate routes introduced forbidden host imports.

The exact two Proxy Symbol rows owned by markdown issue 5122 are not the metric
for this provider. They already pass on its ordinary/static path. This issue
owns the strict dynamic-spread behavior matrix and any exact ES2015 rows found
by a fresh corpus scan to exercise that same mechanism. The implementation
must freeze that exact cohort and its pre-fix statuses before claiming a
Test262 gain.

## Root cause and architectural boundary

`src/codegen/iterator-native.ts` implements a shared internal iterator bridge.
Its object arm deliberately supports a bare-`next` fallback for consumers that
need `GetIteratorFlattenable`, and `__iterator_next` currently terminates on
missing/uncallable steps or unreadable results instead of enforcing every
ECMAScript `IteratorNext` invariant. That is valid internal policy but is not
the `GetIterator` contract required by spread `ArgumentListEvaluation`.

The native vec step also reads array elements without translating `$Hole`.
The Map iterator helper records entry-kind iteration but its generic projection
still returns only the value. Native-family admission is representation-based,
so zero-length TypedArray and String-wrapper carriers can miss the family ladder
even though the language-level iterator is valid.

The host runtime has a nominally strict `__array_from_iter_strict` family, but
its manual Wasm-closure/known-method drain must be audited for the same object,
callability, single-poll, and IteratorResult checks. The host and host-free
providers must expose one semantic contract; a green host result may not mask
a standalone-only approximation.

## Duplicate and dependency audit

- `plan/issues/681-pure-wasm-iterator-protocol-eliminate.md` owns the broad
  native iterator substrate and intentionally retains the generic bridge. This
  issue adds a distinct strict consumer/provider rather than globally changing
  that bridge.
- `plan/issues/3643-array-like-and-heterogeneous-vec-gaps.md` introduced the
  host-only strict destructuring drain. It proves the need for a separate
  strict mode but explicitly avoids standalone host imports and does not supply
  native spread materialization.
- `plan/issues/4768-generator-argument-eagerly-drained-at-call-boundary.md` and
  `plan/issues/1592-ary-ptrn-elision-rest-holes-dstr.md` own generator buffering
  and destructuring step budgets. This issue must preserve their bounded/lazy
  decisions and does not replace their materializers.
- `plan/issues/1970-map-forof-destructuring-stale-buffer.md` fixed reuse of a
  Map entry conversion buffer. It does not implement the missing default-entry
  projection in this native iterator path.
- `plan/issues/2159-standalone-typedarray-dataview-buffer-residual.md` and
  `plan/issues/2651-builtin-constructor-prototype-as-value-substrate.md` own
  broader TypedArray representation and constructor-value gaps. This issue may
  admit existing zero-length iterable carriers, but must not invent a second
  TypedArray representation or claim those residuals.
- `plan/issues/4275-es2015-forof-array-assignment-iterator-ir.md` requires the
  same strict object checks for a future IR operation. It explicitly rejects a
  host-only materializer; this issue provides reusable provider semantics but
  does not select or lower that IR terminal.

## Implementation plan

1. Reproduce and freeze the strict spread matrix on freshly fetched
   `upstream/main` in both host and standalone targets. Include positive and
   designed-negative controls, exact TypeError identity, evaluation counters,
   and module-import assertions. Search the authoritative ES2015 snapshots for
   exact rows sharing the mechanism and record the selected path hash before
   source changes.
2. Add a separate strict native iterator acquisition/step/materialization
   contract. Reuse the existing carrier types, late-provider registration, and
   finalization ordering, but do not weaken or globally tighten the internal
   `__iterator` bare-`next` behavior. The strict path must require a callable
   `@@iterator`, require its result to be an Object, read and require callable
   `next`, and require every IteratorResult to be an Object.
3. Emit the engine's catchable exact `TypeError` for each failed invariant.
   Preserve abrupt-completion precedence and source order. Once a step returns
   an invalid result, do not read `done`/`value`, poll `next` again, validate
   later Proxy operands, or touch handler traps.
4. Normalize native array `$Hole` elements to canonical JavaScript `undefined`
   at the strict materializer boundary. Do not change hole semantics for
   internal vec consumers or destructuring step accounting.
5. Implement the provider-specific projections needed by strict default
   iteration. Map must materialize a fresh two-element `[key, value]` entry for
   each step; Set remains value projection. Admit existing zero-length
   TypedArray and String-wrapper iterable carriers without requiring an element
   sample and without adding host imports. If a carrier cannot meet the strict
   contract, decline before claiming the path rather than silently substituting
   another projection.
6. Audit and align the host runtime's strict manual-drain paths with the same
   acquisition, callability, Object-result, and single-poll rules. Preserve
   ordinary `Array.from`/destructuring array-like fallbacks on their non-strict
   helpers.
7. Wire the strict provider into the dynamic spread consumer only after it is
   prepared and available in both targets. Preserve complete
   `ArgumentListEvaluation`: callee/target/handler/extra expressions and every
   iterator action occur once in source order, later abrupt completion wins,
   and target validation precedes handler validation/trap reads. Resolve late
   function indices after provider registration.
8. Add focused tests for holes in target and handler positions; missing,
   non-callable, or throwing `@@iterator`; iterator returning a primitive;
   missing/non-callable/throwing `next`; primitive IteratorResult with exact
   call counts; done-with-value-getter suppression; Map entry order and
   identity; Set values; empty/non-empty arrays; empty TypedArrays and String
   objects; multiple/nested spreads; later abrupt steps; valid object/function
   Proxy operands; and zero standalone imports.
9. Run the focused suite and exact corpus cohort with at most two workers and
   the pinned QuickJS artifact. Then run TypeScript 5/7, lint, Prettier,
   stack/issue/oracle/coercion/LOC/function/ratchet checks, numeric-local parity,
   and the complete pre-push hook. Merge current upstream non-destructively,
   rerun the focused and exact gates, and obtain an independent final review.

## Explicit exclusions

- Static array-literal spread flattening currently ignores a runtime override
  of `Array.prototype[Symbol.iterator]`. That is a pre-existing canonical
  spread-lowering residual, not created by the reviewed Proxy path. It remains
  out of this issue unless a separately atomically allocated markdown issue and
  measured plan are added first.
- General IteratorClose/completion machinery, generator laziness, TypedArray
  constructor-value identity, and IR for-of selection remain with their
  existing markdown issues.
- No GitHub issue creation, filename-based compiler behavior, Test262-only
  special case, target-mode host import, or global change to internal
  `GetIteratorFlattenable` consumers is permitted.

## Acceptance

- Every strict acquisition and step invariant above agrees between host and
  standalone, throws a catchable exact `TypeError`, and has the expected call
  counts with no repeated poll after an invalid result.
- Array holes contribute `undefined`; invalid target/handler values cannot
  reach handler traps or Proxy allocation.
- Map default iteration contributes ordered fresh entry arrays; Set contributes
  values; valid empty TypedArray and String-object sources are accepted.
- Ordinary/static Proxy construction and the exact two rows owned by markdown
  issue 5122 remain green, with complete argument evaluation and no function
  index shift.
- Standalone focused outputs contain zero host imports. The exact selected
  ES2015 cohort has no fail, compile error, timeout, skip, or regression.
- Focused tests, TypeScript 5/7, lint, formatting, budgets, ratchets, issue
  integrity, numeric-local parity, full pre-push, current-main rerun, and an
  independent review all pass.
- Final evidence, exact commit, PR URL, and handoff are recorded in this file;
  the PR body cites this markdown path and no GitHub issue is created.

## Handoff

Use only `/private/tmp/js2-es2015-strict-spread-iterator-20260828` on branch
`codex/5131-es2015-strict-spread-iterator`. The branch starts from
`upstream/main` `b02345bc590dffc76e914f58731ad783834e868b`. The validated plan
checkpoint is published in upstream draft PR 5147 from fork branch
`ttraenkler:codex/5131-es2015-strict-spread-iterator`; its pre-PR head is
`cfd9d3d1ccbbf42254096f02c1a3f267042a5ee8`. Keep the PR draft while the strict
provider or its dependent dynamic consumer is incomplete; mark it ready only
when the complete acceptance matrix is mergeable. Push every checkpoint
without force, preserve unrelated work, and never create a GitHub issue.
