---
id: 5131
title: "ES2015 strict native spread iterator materializer"
status: done
sprint: current
created: 2026-08-28
updated: 2026-08-31
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
recovery_branch: codex/5131-host-policy-recovery-20260831
pr: 5272
related: [5122, 681, 1592, 1970, 2159, 2651, 3643, 4275, 4768]
required_by: [5122]
files:
  - src/codegen/iterator-native.ts
  - src/codegen/literals.ts
  - src/codegen/map-runtime.ts
  - src/codegen/expressions/new-builtin-globals.ts
  - src/runtime.ts
  - src/runtime/strict-iterator-host.ts
  - tests/issue-5131-es2015-strict-spread-iterator.test.ts
  - plan/issues/5131-es2015-strict-spread-iterator.md
loc-budget-allow:
  # The strict provider adds measured, change-scoped growth to these existing
  # god-files. Keep the grant while the provider remains in its reusable
  # iterator/finalization seams; the unchanged map-runtime entry covers the
  # Map entry projection committed with this implementation branch.
  - src/codegen/iterator-native.ts
  - src/codegen/literals.ts
  - src/codegen/map-runtime.ts
  - src/codegen/expressions/new-builtin-globals.ts
  - src/runtime.ts
func-budget-allow:
  # These are intentional strict-provider additions to existing large seams,
  # not temporary debugging allowances. The stale finalizeNativeIteratorRuntime
  # key was removed because no such function exists.
  - src/codegen/iterator-native.ts::fillNativeIteratorLateArms
  - src/codegen/iterator-native.ts::buildIteratorBody
  - src/codegen/iterator-native.ts::buildIteratorNextBody
  - src/codegen/map-runtime.ts::ensureMapHelpers
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
- Standalone focused outputs contain zero host imports. The
  edition-classified 28-row ES2015 subset of the broad 76-row regression
  corpus is 28/28 in both host and standalone; the broad corpus is host 76/76
  and standalone 74/76 because of two ES2018 object-spread ordering residuals
  tracked under #5216. The authoritative 11,704-row ES2015 census remains
  required for the final edition-level claim and must have no fail, compile
  error, timeout, skip, or regression.
- Focused tests, TypeScript 5/7, lint, formatting, budgets, ratchets, issue
  integrity, numeric-local parity, full pre-push, current-main rerun, and an
  independent review all pass.
- Final evidence, exact commit, PR URL, and handoff are recorded in this file;
  the PR body cites this markdown path and no GitHub issue is created.

## Static boundedness checkpoint (2026-08-30)

PR 5147 is the already-merged plan-only checkpoint at
`2a354ba8944dbe260dd03f5211aff893e0ece1ad`; it cannot carry this later
implementation. PR 5272 remains the implementation draft:
<https://github.com/loopdive/js2/pull/5272>.

The current implementation worktree is
`/private/tmp/js2-es2015-strict-spread-iterator-20260828`, branch
`codex/5131-es2015-strict-spread-iterator`, at merge commit
`8a956dc827874ced063da547ffa525a38c192673` whose parents are the prior
implementation checkpoint `3b6f7682f675ef041426f0b8d0426179fbab0557` and the
exact fetched `upstream/main` head
`a62aacba5ccc154f6fc378235aaaeeb4a7204231`. The issue-scoped source and
focused-test edits remain dirty on top of that normal merge.

The working tree registers separate `__iterator_strict`,
`__iterator_next_strict`, and native strict materializer entry points, adds
strict object/callability checks, hole normalization, Map entry projection,
native-family admission, and keeps the compatibility iterator as a distinct
path. The focused matrix covers the required protocol controls and has now
been rerun on the current dirty revision (see the validation checkpoint below).

This remains an **unfinished, non-mergeable checkpoint**:

- The earlier `/private/tmp/issue5131-singleton.mjs` process produced no stdout
  or artifact before it was stopped after more than an hour, so it was blocked
  before its first post-compile/import/instantiate log. The separate
  three-worker Vitest invocation was also stopped by the census owner; its exact
  command was not preserved locally. A fresh one-worker focused run now
  completes successfully; the exact command and result are recorded below.
- Before the lock, the focused host/standalone pair passed (2 tests), while the
  broader legacy probe had the known #3643 callable-plain-object baseline
  failure and two stale #5122 standalone expectations. Those results do not
  prove the current dirty revision.
- The current static repair removes the reservation-time whole-module body
  scan, uses reverse declaration indexes for O(1) owner lookup, walks
  instruction DAGs iteratively with `WeakSet` guards, and makes late fill
  single-shot/cached. `git diff --check` is clean and temporary debug tracing
  and imports are absent.
- A source-only TypeScript no-emit invocation emitted no diagnostics but was
  stopped after roughly 210 seconds (exit 130) as a suspected compiler
  nontermination; it is not recorded as a passing typecheck. The focused test's
  host/standalone imports are explicitly typed to keep the host-only
  `setInstance` hook out of a union with `{}`.

The filename sweep remains a broad 82-row spread regression list in the pinned
Test262 checkout at `b363f29d3c43c626dc852744ad64a0b48a003693`; it is not an
authoritative ES2015 cohort. Independent `classifyEdition` results for the
owned 76-row list are 28 ES2015 rows, 32 ES2018 object-spread rows, and 16
unclassified `-3` rows. The authoritative 11,704-row census is recorded in
`/private/tmp/js2-es2015-11704-pr5008.txt`; the two fixed empty-spread rows are
unclassified and absent from that census artifact. The two owned empty-array
rows have since been rerun and pass in both targets; the authoritative
edition-scoped validation and repository-wide gates remain pending. Remaining
work is bounded corpus validation on the merged head, TS5/TS7 and all
repository gates, then a truthful commit/push and root review. No additional
validation process may start while another worker lane is reserved by root.

## Focused validation checkpoint (2026-08-30)

The owner-scope repair was preserved, and the focused suite was run from
`/private/tmp/js2-es2015-strict-spread-iterator-20260828` on branch
`codex/5131-es2015-strict-spread-iterator` with one compiler worker and one
Vitest fork:

```text
TEST262_WORKERS=1 COMPILER_POOL_SIZE=1 \
JS2WASM_QUICKJS_ARTIFACT_DIR=/private/tmp/js2-quickjs-artifact-2e2d7736713beeda \
pnpm exec vitest run tests/issue-5131-es2015-strict-spread-iterator.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism \
  --reporter=verbose
```

Result: 2/2 Vitest tests passed; the strict matrix passed 26/26 assertions in
the host lane and 26/26 in the standalone lane. The reported lane durations
were host 962 ms and standalone 668 ms; command wall time was 14.69 s. The
standalone WebAssembly module imported zero host functions (`[]`). There were
zero focused compile errors, runtime failures, timeouts, skips, or residuals.

## Owned empty-array validation checkpoint (2026-08-30)

After the focused suite, the two remaining provider-owned rows were run
sequentially, one fresh child per row, with the explicit `runTest262File`
target. The host and standalone commands used `TEST262_WORKERS=1`,
`COMPILER_POOL_SIZE=1`, the pinned artifact
`/private/tmp/js2-quickjs-artifact-2e2d7736713beeda`, and
`/private/tmp/issue5131-run-one.mjs`; the standalone invocation passed
`"standalone"` as its fourth argument. No other compiler/Test262 lane was
active.

| Test262 row | Target | Status | Total | Compile | Instantiate | Execute | CE/timeout/skip | wasm SHA |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| `language/expressions/call/spread-sngl-empty.js` | host | pass | 2109.26 ms | 1983.81 ms | 39 ms | 9.89 ms | 0/0/0 | `f41aeebb8d8f` |
| `language/expressions/call/spread-mult-empty.js` | host | pass | 1627.83 ms | 1585.76 ms | 10.66 ms | 4.84 ms | 0/0/0 | `7695ae27ead5` |
| `language/expressions/call/spread-sngl-empty.js` | standalone | pass | 2565.49 ms | 2531.32 ms | 8.76 ms | 18.71 ms | 0/0/0 | `cf6d1afe5b12` |
| `language/expressions/call/spread-mult-empty.js` | standalone | pass | 2543.42 ms | 2500.16 ms | 7.89 ms | 25.12 ms | 0/0/0 | `5f023b070e86` |

Totals: **4 pass, 0 fail, 0 compile_error, 0 timeout, 0 skip** across the
four target/row executions. The two pre-repair `TypeError: value is not
iterable` residuals are resolved. The six object-spread failures listed in the
root-triage section remain outside this provider-owned follow-up and were not
included in these runs.

## Pre-repair 82-row filename-sweep host checkpoint (2026-08-30)

The frozen cohort was verified before execution against Test262 gitlink and
checkout `b363f29d3c43c626dc852744ad64a0b48a003693`: 82 unique existing paths,
split into 41 `language/expressions/call/spread-*.js` and 41
`language/expressions/new/spread-*.js` rows. The canonical normalized list is
the call block followed by the new block, one path per LF-terminated line, with
SHA-256
`4cb102200e069d88810ab2dc9ef89076708bbbe29afd40698ad58506ae758849`.
The source list artifacts used to construct it were
`/private/tmp/issue5131-call-paths.txt` (normalized SHA-256
`54bd8105fc1140a4398f67e8e795ebcd54cf6930df481e9ca1ae6c45467bab4f`) and
`/private/tmp/issue5131-new-paths.txt` (normalized SHA-256
`96c0a2c28c676e5a21d85a3bb2b2548d9cbe84792270080c73d689f5d24abee3`).

The approved host lane ran from this worktree and branch with
`TEST262_WORKERS=1`, `COMPILER_POOL_SIZE=1`, the pinned QuickJS artifact
`/private/tmp/js2-quickjs-artifact-2e2d7736713beeda`, and the existing
`scripts/run-test262-paths.mts --isolate` runner. Each row ran in a fresh child
process; no other compiler/Test262 lane was active. Result: **74 pass, 8
fail, 0 compile_error, 0 timeout, 0 skip** (82/82 classified rows).

The eight residuals were:

- `language/expressions/call/spread-mult-empty.js` — `TypeError: value is not iterable` before the expected `arguments.length === 3` assertion;
- `language/expressions/call/spread-mult-obj-ident.js` — descriptor expected writable;
- `language/expressions/call/spread-obj-manipulate-outter-obj-in-getter.js` — expected `true`, got `false` in the getter closure;
- `language/expressions/call/spread-obj-override-immutable.js` — descriptor expected writable (`obj.a === 3`);
- `language/expressions/call/spread-obj-skip-non-enumerable.js` — expected `true`, got `false` in the getter closure;
- `language/expressions/call/spread-obj-symbol-property.js` — `RuntimeError: illegal cast`;
- `language/expressions/call/spread-sngl-empty.js` — `TypeError: value is not iterable` before the expected `arguments.length === 0` assertion;
- `language/expressions/call/spread-sngl-obj-ident.js` — descriptor expected writable.

All 41 `new` rows passed in this host lane. The helper's `--isolate` mode
does not pass a target argument, so this result is host-only; the standalone
lane is a separate sequential checkpoint below. These eight host residuals
are the complete non-pass set for this run; none was a compile error, timeout,
or skip.

## Pre-repair 82-row filename-sweep standalone checkpoint (2026-08-30)

After the host lane completed, the same 82-line list and canonical hash were
run sequentially in isolated child processes with the explicit
`runTest262File(..., 120000, "standalone")` target. The bounded command used
`TEST262_WORKERS=1`, `COMPILER_POOL_SIZE=1`, the pinned QuickJS artifact
`/private/tmp/js2-quickjs-artifact-2e2d7736713beeda`, and the scoped helper
`/private/tmp/issue5131-run-paths.mjs`; no other compiler/Test262 lane was
active. Result: **74 pass, 8 fail, 0 compile_error, 0 timeout, 0 skip** across
the 82 rows. All 41 `new` rows passed. The eight failing rows were exactly the
eight host residuals listed above, with matching error classes and assertion
locations; no additional standalone-only residual appeared.

The standalone runner rejects any non-empty host import manifest before row
execution. Since every row was classified as pass or runtime fail (and none as
`compile_error`/host-import leak), the complete cohort emitted zero host
imports. The explicit-target run therefore confirms host/standalone status
parity for this cohort, but the eight shared `call` residuals keep the issue
non-mergeable and require a narrower follow-up before claiming 100%.

## Broad 76-row spread regression corpus checkpoint (2026-08-30)

The semantically owned list was generated by removing exactly the six
call/object-literal-only paths assigned to #5216 from the 82-row filename
sweep. The resulting file is
`/private/tmp/issue5131-es2015-strict-spread-owned-paths.txt`: 76 unique
existing rows, preserving the original call block followed by the new block.
The normalized list was verified as exactly 82 minus those six paths, with
SHA-256
`117c770c690ff71aa3c0fcb6127839285f36cfe0b1071c186243a9065390c20d`.

This is a broad spread regression corpus, **not an authoritative ES2015
cohort**. Independent `scripts/generate-editions.ts::classifyEdition` output
for these 76 rows is 28 ES2015, 32 ES2018 object-spread, and 16 unclassified
`-3`. The two repaired empty-array rows are in the unclassified bucket and are
absent from the authoritative 11,704-row census list
`/private/tmp/js2-es2015-11704-pr5008.txt` (SHA-256
`45de809c6bfce7371cee1d20e327758246b0524ecd75481a08b8c03344fced8a`). The
edition bucket counts must not be conflated with the provider's strict spread
semantics or with the full census.

The host command ran all 76 rows sequentially in fresh child processes with
`TEST262_WORKERS=1`, `COMPILER_POOL_SIZE=1`, the pinned QuickJS artifact
`/private/tmp/js2-quickjs-artifact-2e2d7736713beeda`, and:

```text
TEST262_WORKERS=1 COMPILER_POOL_SIZE=1 \
JS2WASM_QUICKJS_ARTIFACT_DIR=/private/tmp/js2-quickjs-artifact-2e2d7736713beeda \
TMPDIR=/private/tmp/js2-tsx-5131 \
PATH=/private/tmp/codex-npx2:/private/tmp/codex-pnpm10/node_modules/.bin:/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/thomas/Code/js2/node_modules/.bin:/opt/homebrew/opt/llvm@18/bin:$PATH \
pnpm exec tsx /private/tmp/issue5131-run-paths.mjs \
  /private/tmp/issue5131-es2015-strict-spread-owned-paths.txt
```

Result: **76 pass, 0 fail, 0 compile_error, 0 timeout, 0 skip**. The
terminal-observed lane elapsed approximately 194.8 s; every row emitted a
successful timing object and no residual.

The explicit-target standalone command was run only after the host lane
completed, using the same controls and list with
`JS2WASM_ROW_TARGET=standalone`:

```text
TEST262_WORKERS=1 COMPILER_POOL_SIZE=1 \
JS2WASM_QUICKJS_ARTIFACT_DIR=/private/tmp/js2-quickjs-artifact-2e2d7736713beeda \
TMPDIR=/private/tmp/js2-tsx-5131 JS2WASM_ROW_TARGET=standalone \
PATH=/private/tmp/codex-npx2:/private/tmp/codex-pnpm10/node_modules/.bin:/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/thomas/Code/js2/node_modules/.bin:/opt/homebrew/opt/llvm@18/bin:$PATH \
pnpm exec tsx \
  /private/tmp/issue5131-run-paths.mjs \
  /private/tmp/issue5131-es2015-strict-spread-owned-paths.txt
```

Result: **74 pass, 2 fail, 0 compile_error, 0 timeout, 0 skip**. The
standalone runner rejects any non-empty import manifest before instantiation;
no host-import leak was reported. Its terminal-observed lane elapsed
approximately 355.3 s. The two residuals were both object-literal spread
ordering rows, outside the strict argument-list provider:

- `language/expressions/call/spread-obj-spread-order.js` — 1824.95 ms total
  (compile 1805.71 ms, instantiate 2.53 ms, execute 15.81 ms); actual call
  order `[a, z, 1, Symbol(foo)]`, expected `[1, z, a, Symbol(foo)]` at L43.
- `language/expressions/new/spread-obj-spread-order.js` — 1527.79 ms total
  (compile 1512.75 ms, instantiate 1.97 ms, execute 12.38 ms); the same order
  mismatch at L42.

The corresponding host row passed. These standalone-only residuals are a
separate object-spread ordering baseline and are not claimed as a strict
provider win; root should associate them with the appropriate object-spread
markdown issue before any edition-level 100% claim.

## Post-corpus scoped static gates (2026-08-30)

After both corpus lanes exited, the non-overlapping static checks were run
without starting another compiler/Test262 worker. `git diff --check`, targeted
Prettier, targeted Biome lint at error level, the LOC budget gate, and issue
spec coverage all completed without an error attributable to this patch. The
issue-spec checker printed its existing repository-wide warnings for unrelated
ready issues. Biome printed its existing capped-diagnostics notice (1,419
diagnostics not shown) but exited 0 with no error-level diagnostic.

The pre-extraction function budget gate reported a blocker: the new
`src/codegen/iterator-native.ts::collectStrictMethodDispatch` helper is 345
LOC, crossing the 300-LOC threshold by 45 lines. The other six changed
function keys are covered by this issue's existing allowances. Full hooks and
the remaining repository gates must wait for root's decision to split this
helper or add a justified, change-scoped allowance. The selected repair was a
mechanical extraction: keep the top-level orchestration small, move protocol
literal collection/owner indexing into one helper, move marker-field and
method-ID reservation into a second helper, and move bounded instruction-DAG
marker patching into a third helper. Preserve the existing Map/WeakMap side
tables, source-order sorting, fallback cursors, and inline-template mirroring;
no provider dispatch or carrier semantics should change.

The extraction is complete. The authoritative function-budget gate now passes
without adding an allowance for `collectStrictMethodDispatch`; all helper
functions remain below the 300-LOC threshold.

## Post-extraction validation checkpoint (2026-08-30)

The refactor was mechanical and limited to `src/codegen/iterator-native.ts`:
reverse-handle/literal collection, type marking, entry reservation, owner
indexing, allocation-marker patching, and inline mirroring are now bounded
helpers around the same orchestration. The broad 76-row corpus was not rerun;
its prior two standalone object-spread residuals are unchanged in scope.

The focused command used one compiler worker and one Vitest fork:

```text
TEST262_WORKERS=1 COMPILER_POOL_SIZE=1 \
JS2WASM_QUICKJS_ARTIFACT_DIR=/private/tmp/js2-quickjs-artifact-2e2d7736713beeda \
TMPDIR=/private/tmp/js2-tsx-5131 \
pnpm exec vitest run tests/issue-5131-es2015-strict-spread-iterator.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism \
  --reporter=verbose
```

Result: **2/2 tests passed**; host and standalone each passed all 26 matrix
assertions. The reported lane durations were host 3429 ms and standalone 2224
ms; command duration was 30.24 s. Standalone imports remained `[]`, with no
compile error, runtime failure, timeout, skip, or residual.

The two owned rows were then run sequentially in fresh children with the
explicit host/standalone target and the same one-worker/pinned-artifact
controls:

| Test262 row | Target | Status | Total | Compile | Instantiate | Execute | wasm SHA |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| `language/expressions/call/spread-sngl-empty.js` | host | pass | 2331.47 ms | 2243.71 ms | 28.18 ms | 8.66 ms | `f41aeebb8d8f` |
| `language/expressions/call/spread-mult-empty.js` | host | pass | 2637.49 ms | 2590.92 ms | 12.87 ms | 5.82 ms | `7695ae27ead5` |
| `language/expressions/call/spread-sngl-empty.js` | standalone | pass | 2913.81 ms | 2884.61 ms | 4.85 ms | 17.35 ms | `cf6d1afe5b12` |
| `language/expressions/call/spread-mult-empty.js` | standalone | pass | 3517.55 ms | 3483.28 ms | 6.16 ms | 19.47 ms | `5f023b070e86` |

Totals: **4 pass, 0 fail, 0 compile_error, 0 timeout, 0 skip**; no standalone
host-import leak was reported. The extraction introduced no observed
behavioral regression in the focused or owned-row controls.

## Root triage and completion plan (2026-08-30)

The 82-path filename sweep over-collected six tests whose spread syntax occurs
inside an **object literal**, not in the call argument list owned by this
strict iterator provider. Their shared host/standalone failures are valuable
ES2018 residuals, but changing object-property descriptors, getter side
effects, enumerable filtering, or Symbol-key copying in this PR would cross
the provider boundary described above. They must be moved to a separately
allocated repository-local markdown issue before implementation; no GitHub
issue is permitted. The six paths are:

- `spread-mult-obj-ident.js`;
- `spread-obj-manipulate-outter-obj-in-getter.js`;
- `spread-obj-override-immutable.js`;
- `spread-obj-skip-non-enumerable.js`;
- `spread-obj-symbol-property.js`; and
- `spread-sngl-obj-ident.js`.

The two remaining failures are directly owned here:
`spread-sngl-empty.js` and `spread-mult-empty.js`. Both expose the same strict
carrier-admission defect: an empty array has no sampled element from which the
current family ladder can infer its iterable representation, so `...[]`
throws `TypeError` instead of contributing zero arguments.

Completion sequence for this PR:

1. Preserve the array-family identity independently of element sampling and
   admit a length-zero array into the strict materializer without weakening
   malformed-object checks or the compatibility iterator.
2. Add focused host/standalone controls for single and trailing empty spread,
   evaluation order, exact zero contribution, and zero standalone imports.
3. Regenerate the semantically filtered argument-spread cohort (exclude rows
   whose spread is solely `PropertyDefinition: ...AssignmentExpression`) from
   the authoritative census, record its normalized path hash, and require
   every provider-owned row to pass in both lanes. Keep the broad 76-row
   regression result and its two standalone object-spread ordering residuals
   visible as a separate baseline, not as exemptions or claimed wins. The six
   #5216 object-spread statuses remain separate as well.
4. Run TS5/TS7, lint, formatting, budgets, ratchets, issue integrity,
   numeric-local parity, the full pre-push hook, and a clean current-main
   replay. PR 5272 stays draft until those gates and an independent review are
   green.

## Handoff

Continue only in the worktree and branch above. The normal merge of
`upstream/main` at `a62aacba5ccc154f6fc378235aaaeeb4a7204231` is recorded by
`8a956dc827874ced063da547ffa525a38c192673`; preserve the current dirty
issue-owned changes, do not mutate other worktrees, and keep PR 5272 draft while
the acceptance matrix is incomplete. The latest one-worker validation on this
dirty head is recorded above: the 26-assertion focused matrix passes in host
and standalone, and both owned empty-array rows pass in both targets (4/4
executions, no compile errors/timeouts/skips). The broad 76-row regression
corpus is also recorded above: host 76/76 pass, standalone 74/76 pass with
two object-spread ordering residuals, and the list classifies as 28 ES2015,
32 ES2018 object-spread, and 16 unclassified `-3` rows. Prettier, targeted
Biome lint, and `git diff --check` are clean. The authoritative
edition-scoped corpus, full repository gates, current-main replay, and
independent review remain pending; the object-spread baselines remain outside
this issue's provider scope. The post-corpus function-budget gate is still
clean after the bounded extraction of `collectStrictMethodDispatch`; no new
allowance was added. The post-extraction focused and owned-row evidence is
recorded above, while the authoritative edition-scoped corpus, full hooks,
current-main replay, and independent review remain pending.
The next publication must record the tested head, test-worker budget,
focused/corpus results, and any remaining baseline failures before root reviews
the ready-state decision. PR 5147 is the already-merged plan-only checkpoint,
not the implementation PR. Do not create a GitHub issue.

## Publication-blocker review and bounded repair plan (2026-08-30)

An independent review probe reproduced two blockers on this dirty head before
any repair. The probe was run from
`/private/tmp/js2-review-5131-baseline/tests/review-5131-probe.test.ts` with
one Vitest fork, one compiler worker, the pinned QuickJS artifact
`/private/tmp/js2-quickjs-artifact-2e2d7736713beeda`, and the host/standalone
compile conditions used by the focused suite. Its exact observable output was:

```text
markerCollision host 3
markerCollision standalone CompileError: WebAssembly.instantiate(): Compiling function #280:"__iterator_strict" failed: i32.eq[0] expected type i32, found struct.get of type (ref null 6) @+119440
markerNumericCollision host 3
markerNumericCollision standalone CompileError: WebAssembly.instantiate(): Compiling function #280:"__iterator_strict" failed: i32.eq[0] expected type i32, found struct.get of type f64 @+119384
typedParameter host invoke:RuntimeError: dereferencing a null pointer
typedParameter standalone invoke:RuntimeError: dereferencing a null pointer
optionalParameter host 2
optionalParameter standalone 2
```

The marker collision root cause is that finalization searched a user-visible
`$strict_method_id` field name and then treated that field as an internal i32
slot. A string-valued property produced an externref `struct.get`; a numeric
property produced an f64 `struct.get`; both were fed to `i32.eq` in standalone.
The host result `3` is not acceptance evidence because the host path did not
validate the generated Wasm in the same way. The repair plan is to make a
per-codegen-context/per-type side table the sole owner of the synthetic slot,
append one collision-free internal i32 field when absent, keep any registered
field table aligned at the same index, and make repeated finalization reuse the
side-table index without appending another field. The focused matrix will add
string and numeric user properties named `$strict_method_id` and assert both
lanes remain valid and observable.

The typed-parameter root cause is that `strictMethodMissingArg` synthesized
`ref.null` followed by `ref.as_non_null` for a declared non-null GC reference
parameter. GetIterator invokes the method with zero JavaScript arguments, so
that sequence is a guaranteed runtime null dereference rather than a valid
zero-argument call. The bounded repair will reuse the
`zero-arg-method-pad.ts` contract: nullable/reference and primitive parameter
shapes receive only safe pads; an unpaddable direct method arm declines the
direct typed call and takes the existing bounded TypeError/fallback route. The
exact per-literal dispatch arm remains selected, no synthetic argument is
observed by JavaScript, and no guaranteed trap is emitted. A typed-parameter
iterator control will assert the expected catchable Proxy `TypeError` result in
both lanes; the optional-parameter control remains a positive zero-argument
control. The six object-spread residuals tracked by #5216 remain out of scope.

Validation after the source repair is limited to one worker lane: diff check,
targeted Prettier and Biome, the authoritative function-budget gate, the
focused host/standalone suite, both owned empty-array Test262 rows in both
targets, and the new marker-collision/typed-parameter controls. No commit,
push, merge, or GitHub action is performed in this worktree; root owns
publication and the PR shepherd.

## Bounded blocker repair evidence (2026-08-30)

The dirty checkpoint was repaired in the existing worktree without changing
the six ES2018 object-spread residuals. `strictMethodIdFieldByCtx` is now the
only owner of the synthetic marker index. Finalization allocates a
collision-free `$__strict_method_id_<type>` field, never searches or reuses a
source-visible property, and verifies the side-table field before reusing it.
When a distinct registered metadata array is present, its stale tail is
truncated to the emitted type layout and its entries are synchronized by
physical index before the marker is appended, so a registered array longer
than the emitted fields cannot shift the marker index. The first bounded repair
made nested instruction-DAG pairing follow the nearest source-function body,
which fixed the prior visited-before-finalization omission. The independent
publication review below then proved that any scope-and-ordinal pairing was
still unsound and replaced it with explicit allocation provenance. All
temporary debug symbols, logs, and traces were removed.

`strictMethodMissingArg` now delegates to `zeroArgPadInstrs`; unpaddable
non-null GC references produce an explicit status-2 refusal and a catchable
TypeError route instead of `ref.null` followed by `ref.as_non_null`. The
required-reference control is deliberately named `typedIteratorParameterNoTrap`:
it proves that the former null-dereference regression is gone, but does not
claim spec-correct invocation with zero arguments. The generic dynamic-call
route's failure to invoke a required typed parameter is pre-existing
under-application debt (the pristine host control observed one catchable
TypeError with zero method calls, while pristine standalone refused this
dynamic Proxy spread at compile time); it remains outside this bounded repair.
The optional-parameter control is positive and requires one iterator call with
`arg === undefined`, yielding the target and handler successfully.

The final one-worker focused command was:

```text
TEST262_WORKERS=1 COMPILER_POOL_SIZE=1 \
JS2WASM_QUICKJS_ARTIFACT_DIR=/private/tmp/js2-quickjs-artifact-2e2d7736713beeda \
TMPDIR=/private/tmp \
pnpm exec vitest run tests/issue-5131-es2015-strict-spread-iterator.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism \
  --reporter=verbose
```

Result: **2/2 tests passed** (host and standalone), covering all 30 exported
controls in each lane. The Vitest command duration was 11.93 s; reported test
durations were host 964 ms and standalone 652 ms. Standalone imports remained
`[]`; there were zero compile errors, runtime failures, timeouts, skips, or
residuals. The marker string and numeric collision controls each observed
exactly one iterator call before the expected later Proxy arity TypeError;
the optional control observed exactly one call with an undefined argument.

The final owned-row commands used the explicit target helper, sequentially,
with the same one-worker and pinned-artifact settings:

```text
for row in \
  language/expressions/call/spread-sngl-empty.js \
  language/expressions/call/spread-mult-empty.js; do
  node --import tsx /private/tmp/issue5131-run-one.mjs "$row" host
done
for row in \
  language/expressions/call/spread-sngl-empty.js \
  language/expressions/call/spread-mult-empty.js; do
  node --import tsx /private/tmp/issue5131-run-one.mjs "$row" standalone
done
```

Final result: **4/4 pass, 0 fail, 0 compile_error, 0 timeout, 0 skip**, with
no standalone host-import leak:

| Row | Target | Total | Compile | Instantiate | Execute | wasm SHA |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| `language/expressions/call/spread-sngl-empty.js` | host | 1357.96 ms | 1324.68 ms | 12.84 ms | 3.98 ms | `f41aeebb8d8f` |
| `language/expressions/call/spread-mult-empty.js` | host | 1323.88 ms | 1291.76 ms | 11.06 ms | 4.27 ms | `7695ae27ead5` |
| `language/expressions/call/spread-sngl-empty.js` | standalone | 2217.16 ms | 2191.56 ms | 4.40 ms | 16.09 ms | `cf6d1afe5b12` |
| `language/expressions/call/spread-mult-empty.js` | standalone | 2049.49 ms | 2025.38 ms | 3.94 ms | 15.65 ms | `5f023b070e86` |

Scoped static gates on this final dirty head are green: `git diff --check`,
targeted Prettier, targeted Biome lint at error level, and the authoritative
function-budget gate. No broad 76-row corpus or full repository hooks were
rerun; the previously recorded broad result remains host 76/76 and standalone
74/76 with only the two ES2018 object-spread ordering residuals. Full hooks,
current-main replay, and independent publication review remain root-owned
follow-up gates.

## Independent Terra publication review and provenance repair (2026-08-30)

The independent Terra Max review found a further publication blocker before
the branch was committed or pushed. Anonymous object structs are structurally
deduplicated, but only object-literal `MethodDeclaration` protocol members are
registered as strict method records. The first implementation grouped every
same-type `struct.new` in a source-function scope and assigned method IDs by
ordinal. An earlier same-shape PropertyAssignment or compiler-generated copy
could therefore consume the later method literal's identity even though it had
no strict record. PR 5272 remains draft until the integrated branch completes
the gates below.

The reviewed repair stamps the exact `struct.new` emitted by
`compileObjectLiteralForStruct` with a compiler-private primitive token. A
per-context registry resolves that token back to the exact source
`ObjectLiteralExpression`. Finalization now gives every augmented allocation
the required hidden i32 operand, but assigns a non-zero method ID only when the
token resolves to the matching registered literal and canonical type.
Untracked PropertyAssignments, manual allocations, and copies receive marker
zero and cannot consume another literal's identity. The primitive token is
preserved by normal shallow IR cloning, and the existing bounded inlining guard
remains in place for pre-finalization templates.

The focused matrix adds `allocationProvenancePredecessor`: an untracked
same-shape PropertyAssignment precedes two tracked method literals with
distinct iterator bodies. The first must remain empty, the second must
contribute Proxy target and handler, and each tracked iterator must run exactly
once. The corrected single-fork review command used `TEST262_WORKERS=1` and
`COMPILER_POOL_SIZE=1` and exited zero: **2/2 host/standalone tests passed**,
now covering 31 controls per lane. Reported durations were 2098 ms host and
1272 ms standalone, 20.98 s total; standalone imports remained `[]`.
`git diff --check` and targeted Prettier also passed, and no debug
instrumentation was introduced.

The independent reviewer did not rerun the two owned Test262 rows because the
global two-worker cap was occupied by unrelated worktrees. The earlier 4/4
owned-row result remains supporting evidence, not an independent rerun. Root
must still run the normal hooks, merge current upstream without force, replay
the focused and owned-row gates on the integrated head, push the exact
checkpoint, correct the upstream PR body, and obtain the shepherd's final
ready/queue decision. No GitHub issue was created.

### Root integration validation before commit

After mechanically applying only the reviewed provenance delta to the original
PR worktree, a second Terra read-only audit confirmed that
`iterator-native.ts` and the focused test byte-match the reviewed versions.
`literals.ts` contains only the provenance import/allocation hunks, with no
unrelated upstream #5212 content. The issue file and LOC allowance both include
`src/codegen/literals.ts`; target `git diff --check` and targeted Prettier are
green.

Root then reran the integrated target with one compiler worker and the pinned
QuickJS artifact. The focused suite exited zero: **2/2 host/standalone tests
passed**, covering 31 controls per lane; reported test durations were 2390 ms
host and 1908 ms standalone, 29.23 s total. The same target tree passed both
owned empty-spread Test262 rows in both lanes: **4/4 pass, 0 fail, 0
compile_error, 0 timeout, 0 skip**. Host Wasm hashes remain `f41aeebb8d8f`
and `7695ae27ead5`; standalone hashes remain `cf6d1afe5b12` and
`5f023b070e86`. Full normal hooks and current-upstream integration remain
required before publication.

### Final current-main integration replay (2026-08-30)

Root merged upstream main `77ac45d08afd350e60875c401d75e56c8f50f631`,
which contains the exact merged PR 5300 head, without conflicts or a force
update. Normal merge-commit hooks completed on integrated commit
`724ca41005`: the changed-root matrix passed 52/52 #3525 callable-binding
tests, 2/2 #5131 strict-spread tests, and 59/59 #5194 TypedArray tests. Vitest
reported one tolerated RPC `onTaskUpdate` timeout after all 59 TypedArray tests
had passed; the existing hook invocation used
`--dangerouslyIgnoreUnhandledErrors`, and no test failure was hidden.

The exact focused suite was then replayed with one fork and the pinned QuickJS
artifact: **2/2 host/standalone tests passed**, covering all 31 controls in
each lane; reported durations were 3351 ms host and 2437 ms standalone, 38.81 s
total. The two issue-owned Test262 rows were also replayed sequentially in both
targets: **4/4 pass, 0 fail, 0 compile_error, 0 timeout, 0 skip**. Host Wasm
hashes remain `f41aeebb8d8f` and `7695ae27ead5`. The integrated TypedArray
mainline changes legitimately alter the standalone module bytes; the new
passing standalone hashes are `ac2af3ffa2bf` and `54271b4fb43b`. The branch is
now behaviorally validated on current main and ready for the remaining normal
pre-push gate, exact-head push, and PR shepherd handoff. No GitHub issue was
created.

### Final pre-push TS7 narrowing blocker and repair plan (2026-08-30)

The first normal push attempt stopped before updating the fork because the
TS7 typecheck found three static regressions in the newly added marker
finalization code:

- line 713 reads `field.type.typeIdx` without independently narrowing the
  second `ValType` union;
- line 721 copies optional `field.mutable` into registry metadata whose field
  is a required boolean;
- line 838 reads `instr.typeIdx` in a helper whose parameter is the full
  `Instr` union rather than the already-selected `struct.new` variant.

No remote ref moved and no gate was bypassed. The bounded Terra Max repair is
to make both reference-type discriminants explicit, normalize missing
mutability to the repository's immutable default, and narrow the marker helper
parameter (or guard it locally) to `struct.new`. It must not change emitted IR
or marker allocation behavior. Acceptance requires TS7 typecheck, the exact
2/2 host/standalone focused suite, the 4/4 owned Test262 rows, and the complete
normal pre-push gate on the repaired integrated head. The repair stays in PR
5272 and this markdown issue; no GitHub issue was created.

### Terra TS7 repair result and handoff (2026-08-30)

On dedicated branch `codex/5131-ts7-type-narrowing-terra` at committed plan
head `cd9e30330e95025eb38b6dc27bdda11e69c9032a`, the repair changes only
`src/codegen/iterator-native.ts`: it independently narrows both `ValType`
operands before reading `typeIdx`, records an absent optional mutability as
immutable (`false`), and restricts the allocation-marker helper to the
already-selected `struct.new` instruction variant. It does not alter the
emitted IR or strict-marker allocation behavior.

The TS7 gate passed with `pnpm run typecheck` (exit 0, 61.6 s, no diagnostics).
The exact pinned-artifact one-fork focused command then passed **2/2**:
host 6167 ms and standalone 3424 ms, 79.81 s total. The standalone assertion
for `imports === []` passed, so this run observed no host-import leak. The
freshly audited sequential owned-row replay also passed **4/4**, with no
compile errors, timeouts, skips, or standalone host-import leak:

| Row | Target | Total | Compile | Instantiate | Execute | wasm SHA |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| `spread-sngl-empty.js` | host | 4550.57 ms | 4422.25 ms | 78.23 ms | 20.39 ms | `f41aeebb8d8f` |
| `spread-mult-empty.js` | host | 3855.69 ms | 3756.06 ms | 43.54 ms | 9.69 ms | `7695ae27ead5` |
| `spread-sngl-empty.js` | standalone | 10229.40 ms | 10134.29 ms | 14.46 ms | 46.02 ms | `ac2af3ffa2bf` |
| `spread-mult-empty.js` | standalone | 11777.80 ms | 11492.57 ms | 38.67 ms | 88.11 ms | `54271b4fb43b` |

`git diff --check`, targeted Prettier and Biome, and the function and LOC
budget gates all passed; this source/tracker delta was committed with normal
hooks in the Terra delivery worktree and awaits root cherry-pick/current-main
replay, with no push, PR mutation, or GitHub issue created here.

### Final latest-main replay after the TS7 repair (2026-08-30)

Root cherry-picked the exact validated Terra delivery and merged current
upstream main `275216c74c7299ea07a72c8d5479f7e1a477000c` without force or
conflicts. The resulting integrated head is
`0aa95ac3a498099c552d5130cb07dcd986a3ee2f`. TS7 typecheck passed with no
diagnostics. The exact pinned-artifact one-fork focused suite passed **2/2**
again: host 1918 ms and standalone 1824 ms, 25.86 s total, including the
standalone `imports === []` assertion.

The issue-owned rows also passed **4/4** on that integrated head, with no
compile errors, timeouts, skips, or host-import leak:

| Row | Target | Total | Compile | Instantiate | Execute | wasm SHA |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| `spread-sngl-empty.js` | host | 4343.68 ms | 4110.68 ms | 66.31 ms | 20.11 ms | `f41aeebb8d8f` |
| `spread-mult-empty.js` | host | 7284.24 ms | 7192.34 ms | 40.29 ms | 8.37 ms | `7695ae27ead5` |
| `spread-sngl-empty.js` | standalone | 11932.92 ms | 11774.46 ms | 37.78 ms | 50.41 ms | `ac2af3ffa2bf` |
| `spread-mult-empty.js` | standalone | 8321.63 ms | 8243.25 ms | 9.83 ms | 41.98 ms | `54271b4fb43b` |

The behavior, import surface, and Wasm hashes are unchanged from the
pre-integration Terra evidence. Only the final normal-hook documentation
commit, complete pre-push gate, exact-head push, and PR shepherd transition
remain. PR 5272 stays draft until those gates finish. No GitHub issue was
created.

### Environment-reset recovery plan (2026-08-31)

The uncommitted host-import-policy repair and its temporary QuickJS artifact
were lost when `/private/tmp` was cleared. The published PR head
`8e029466fc4a1bdb403b5d7dc4d5e913829414b0` remains intact, but the repair
must be reconstructed in the persistent worktree on
`codex/5131-host-policy-recovery-20260831`. Results recorded before the reset
are design and regression evidence only; none count as publication evidence.

Implementation is deliberately bounded to the reviewed repair:

1. Make the kind-2 Map entry projection allocate a fresh canonical two-slot
   `$Vec` containing `[key, value]`, eliminating `$ObjVec` reachability that
   pins the legacy `env::__iterator` import in a native-first Map program.
2. Add a non-vacuous focused import-inventory assertion for Map values:
   native-first output may use the JS-value bridge but must contain neither
   `env::__iterator` nor any legacy or unknown import.
3. Extract the strict iterator host implementation from `runtime.ts` into
   `src/runtime/strict-iterator-host.ts`, injecting its existing operations and
   delegating the strict imports plus the four array-iteration handlers. This
   is a behavior-preserving source-budget repair; it must not change an import
   name, ABI, dispatch condition, or compatibility behavior.
4. Do not change a host-policy baseline, allowance, threshold, or unrelated
   runtime/codegen path. Reconcile the tracker file list and measured LOC and
   function budgets against the reconstructed diff.

Acceptance requires a current-tree full `check:host-import-policy` run, the
focused host/standalone issue suite, all four owned Test262 target rows, TS7
typecheck, target static/format gates, and the complete normal commit and
pre-push hooks. Before any compiler/test lane, audit the full process tree and
keep the repository-wide worker count at two or fewer. Rebuild and pin a fresh
QuickJS artifact; the deleted artifact must not be referenced. After merging
the latest `loopdive/js2` main without force, replay every acceptance gate on
the exact integrated head. Only then may the repaired exact head be pushed to
the existing PR 5272 branch and marked ready if GitHub reports it mergeable.
No GitHub issue was created.

### Persistent-worktree reconstruction checkpoint (2026-08-31)

The reviewed repair has been reconstructed only in the persistent recovery
worktree on `codex/5131-host-policy-recovery-20260831`, based on the published
head `8e029466fc4a1bdb403b5d7dc4d5e913829414b0`. The owned source/test changes
are exactly:

- `src/codegen/map-runtime.ts`: kind-2 Map iterator projection now allocates a
  fresh canonical two-slot externref `$Vec` `[key, value]`, removing the eager
  `$ObjVec` builder reachability that pins compatibility `env::__iterator` for
  values-only native-first Map programs;
- `src/runtime/strict-iterator-host.ts`: a new injected strict-provider
  subsystem owns strict GetIterator, IteratorNext, bounded drain, and the four
  `__array_from_iter*` handlers;
- `src/runtime.ts`: delegates only strict iterator and array-materialization
  imports to that subsystem, leaving the compatibility `__iterator` bridge
  unchanged;
- `tests/issue-5131-es2015-strict-spread-iterator.test.ts`: adds a non-vacuous
  native-first Map-values inventory control requiring a JS-value bridge surface
  while forbidding `env::__iterator`, legacy-semantic, and unknown imports.

No host-policy baseline, allowance, threshold, import name, ABI, or unrelated
runtime/codegen path was changed. Cheap static checks pass: `git diff --check`
and direct repository Prettier `--check` over all owned files. The worktree's
`pnpm exec` preflight attempted an interactive dependency purge and was not
used; direct Prettier did not alter dependency state. Static source counts are
`runtime.ts` **18,645** lines and `resolveImport` **7,480** lines, below the
fixed maxima of 18,776 and 7,680. The persistent QuickJS artifact has been
verified at
`/Users/thomas/Code/js2/.test262-cache/quickjs-artifact-2e2d7736713beeda` with
the pinned `libquickjs.wasm` and `qjs-abi.json` SHA-256 values stated above.

At the time of this reconstruction checkpoint, no compiler, Vitest, Test262,
typecheck, hook, commit, push, or PR mutation had run from the reconstructed
tree. The next step was a root-audited, one-worker
`check:host-import-policy` validation lane.

### Policy-launch setup failure (2026-08-31, zero evidence)

After a fresh full-process audit showed one external
`check-host-import-policy.ts` process and no second external compiler/test
lane, the released recovery command was launched with
`TEST262_WORKERS=1`, `COMPILER_POOL_SIZE=1`, and the required bundled PATH:
`pnpm run check:host-import-policy`. It exited **1** during pnpm's dependency
preflight before the policy script or a compiler child started:

```text
ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY
Aborted removal of modules directory due to no TTY
```

This produced no policy probes, import inventory, budget metrics, or gate
verdict, and is therefore a separate **zero-evidence setup failure**, not a
host-policy pass or fail. The recovery worktree's dependency view points at
the shared repository `node_modules`; no `CI=true` purge, dependency rewrite,
alternate runner, or policy workaround has been attempted. The next step is
root direction for a safe dependency preflight or an explicitly approved
equivalent launcher, followed by a freshly audited one-worker policy run.

### Direct host-import-policy result (2026-08-31)

With the recovery worktree still at source head
`8e029466fc4a1bdb403b5d7dc4d5e913829414b0` and only the five owned
reconstruction/tracker paths dirty, the root-approved direct package payload
ran successfully after a clear full-process audit:

```text
TEST262_WORKERS=1 COMPILER_POOL_SIZE=1 PATH=/private/tmp/codex-pnpm10/node_modules/.bin:… \
  node --import tsx scripts/check-host-import-policy.ts
```

This direct invocation is the exact `check:host-import-policy` script payload
and avoids only pnpm's unrelated interactive dependency-preflight refusal. The
policy process was observed as PID `26044` (parent `962`); a subsequent audit
confirmed it exited cleanly. It ran alongside at most one unrelated Test262
driver lane, with no third lane observed. Exit status was **0**.

The authoritative JSON result was non-vacuous and passed every policy gate:

- native-first: **33 probes**, **395 imports**, **0** legacy-semantic, and
  **0** unknown imports;
- `mapIteration`: **3** imports, all value-adapter / `js-value-bridge`, with
  no compatibility `env::__iterator` reachability;
- compatibility legacy-semantic debt remained **23**;
- fixed budget metrics: `runtimeTsLines=18645` (maximum 18776),
  `resolveImportLines=7479` (maximum 7680), `resolveImportCases=15`,
  `ownedAdapterLines=819`, and `explicitCapabilityLines=1194`.

No baseline, allowance, policy condition, import ABI, compatibility bridge, or
budget maximum was changed. Focused Vitest, owned Test262 rows, TS7, hooks,
commit, push, and PR mutation remain unrun from this recovery worktree and
require separate root-audited releases.

### Focused standalone validation blocker (2026-08-31)

The released pinned-artifact, one-fork focused suite ran as PID chain
`29236 → 29243 → 29252`, alongside only one unrelated cargo-test lane. It
completed in 12.54 s with exit **1** and a real **2/3** result:

- the non-vacuous native-first Map inventory control passed (734 ms);
- the host strict acquisition/step/projection/materialization control passed
  (520 ms);
- the standalone control failed during Wasm instantiation (588 ms), before its
  host-import assertion could run:

```text
WebAssembly.instantiate(): Compiling function #314:"__iterator_next" failed:
any.convert_extern[0] expected type externref, found struct.new of type
(ref 2) @+138418
```

This is not an import-policy regression or a Test262 verdict: the standalone
module is invalid before execution. No owned Test262 row, TS7, hook, commit,
push, or PR mutation was started after this failure. The bounded static repair
plan is to trace the moved strict iterator host callback boundary and restore
the pre-extraction reference conversion/order for the `__iterator_next` Wasm
path, without changing native-first import inventory, the compatibility
bridge, baselines, allowances, ABI, or strict provider selection. After a
reviewed source fix, replay the full host-policy gate before requesting a new
focused lane.

Static type-path audit confirmed the narrow cause and repair. Before the
recovery change, the kind-2 arm returned an `$ObjVec` as an `externref`, so its
tail `any.convert_extern` was required to meet the enclosing `anyref` result.
The reconstructed arm instead ends in `struct.new $Vec`, which is already a
WasmGC `(ref $Vec)` subtype of `anyref`; applying the inherited conversion made
the module invalid because `any.convert_extern` accepts only `externref`.
The repair removes that single stale conversion and leaves the fresh canonical
pair allocation and every other branch unchanged. The existing
`mapProjection()` control uses `[...map]` (the native Map default iterator,
kind 2) and checks distinct `[key, value]` pairs in both host and standalone,
so it directly covers this repaired path without adding a second duplicate
case. Only diff/format/static checks have run after the source edit; runtime
validation remains root-released.

### Post-fix policy replay capacity race (2026-08-31)

After the stale conversion removal, the direct one-worker policy replay began
as PID `30496` while the only audited external lane was cargo
`29184 → 30048`. A during-run audit then observed a newly started external
debug/Test262 lane (`30519`, with runner children `30510` and `30525`), so the
global cap was exceeded. A SIGINT was sent only to the verified #5131 terminal
session immediately; the policy had already completed before delivery and
returned exit **0** with complete JSON output.

That output repeated the expected non-vacuous result: native-first **33**
probes / **395** imports / **0** legacy-semantic / **0** unknown;
`mapIteration` **3** JS-value-bridge imports; compatibility debt **23**; and
`runtimeTsLines=18645`, `resolveImportLines=7479`,
`resolveImportCases=15`, `ownedAdapterLines=819`, and
`explicitCapabilityLines=1194`. Because it completed during a capacity race,
the race and verified own-session stop provenance are retained separately.
Root reviewed the complete output and exit status and accepted this as the
valid clean post-fix policy replay: the result had completed before SIGINT
delivery, so no partial output was promoted. No focused suite or owned row
followed it.

### Post-fix focused replay (2026-08-31)

With the pinned QuickJS artifact directory
`/Users/thomas/Code/js2/.test262-cache/quickjs-artifact-2e2d7736713beeda`,
`TEST262_WORKERS=1`, `COMPILER_POOL_SIZE=1`, and Vitest restricted to one
fork/no file parallelism, the exact focused suite passed **3/3** (exit **0**)
in 13.48 s. Its PID chain was `54326 → 54400 → 54521`; a during-run full audit
showed only the unrelated release cargo lane beside it.

- native-first Map import-inventory control: **pass**, 843 ms. Its non-vacuous
  JS-value-bridge assertion passed while `env::__iterator`, legacy-semantic,
  and unknown imports were absent;
- host strict acquisition/step/projection/materialization control: **pass**,
  580 ms;
- standalone strict acquisition/step/projection/materialization control:
  **pass**, 686 ms. The `imports === []` assertion passed, as did
  `mapProjection()`'s direct `[...map]` kind-2 fresh `[key, value]` pair
  checks.

This validates the one-instruction stale-conversion repair as well as the
native-first import fix and strict-host extraction under both host and
standalone targets. Owned Test262 rows, TS7, hooks, commit, push, and PR
mutation remain separately gated and unrun after this replay.

### Post-fix owned Test262 host rows (2026-08-31)

The approved isolated helper ran the two host-owned rows serially with the
pinned QuickJS artifact and one effective worker. Its verified terminal
session was `55796`. A during-run audit observed a capacity race: the existing
release cargo lane was joined by two unrelated Test262 scripts (`65712` and
`67141`), so SIGINT was sent only to the #5131 session. The helper had already
finished with exit **0** and complete JSON before signal delivery. Root
reviewed and accepted the completed result as valid, while retaining the race
and own-stop provenance.

| Row | Target | Status | Total | Compile | Instantiate | Execute | Wasm SHA |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| `spread-sngl-empty.js` | host | pass | 1848.08 ms | 1804.68 ms | 8.79 ms | 5.13 ms | `f41aeebb8d8f` |
| `spread-mult-empty.js` | host | pass | 2402.31 ms | 2356.79 ms | 12.44 ms | 6.06 ms | `7695ae27ead5` |

There were no compile errors, timeouts, skips, or runner errors. The two
standalone rows, TS7, hooks, commit, push, and PR mutation remain held for
separate root-audited releases.

### Post-fix owned Test262 standalone rows (2026-08-31)

After a fresh broad audit found one unrelated one-fork Vitest lane, the
isolated helper ran only the standalone target with the same pinned artifact,
one-worker environment, and approved PATH. The run completed exit **0** with
both full result JSON records; no capacity race occurred and no further
validation command followed it.

| Row | Target | Status | Total | Compile | Instantiate | Execute | Wasm SHA |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| `spread-sngl-empty.js` | standalone | pass | 2495.78 ms | 2470.66 ms | 4.05 ms | 16.17 ms | `ac2af3ffa2bf` |
| `spread-mult-empty.js` | standalone | pass | 2402.32 ms | 2378.12 ms | 3.64 ms | 16.24 ms | `54271b4fb43b` |

Together with the accepted host replay, the exact issue-owned matrix is
**4/4 pass**: no compile errors, timeouts, skips, runner errors, or standalone
host imports. TS7, final static/pre-push hooks, commit, push, and PR mutation
remain separately gated and have not been started.

### TS7 typecheck capacity-race result (2026-08-31)

The exact package `typecheck` payload
`node node_modules/typescript7/lib/tsc.js --noEmit -p tsconfig.ts7.json` began
in verified #5131 session `11285` after an audit that showed only the external
release cargo lane. A during-run audit then found the cargo lane plus a new
unrelated six-fork Vitest pool (`79121` and children), exceeding the global
cap. SIGINT was sent only to session `11285`; it subsequently exited **0**
with no diagnostics or output. The command had therefore completed cleanly,
but a silent exit after SIGINT cannot establish whether `tsc` completed before
the interrupt. This is explicitly **non-authoritative / zero publication
evidence** and must be rerun in a clean slot; it is not an acceptance result.
No subsequent validation command was launched.

### Independent Terra review and P2 resolution (2026-08-31)

Independent Terra review found no P0 or P1 findings. Its sole P2 noted that
the recovery-plan wording said the native-first inventory assertion covered
Map values/entries, while the focused assertion intentionally compiles only
`values.values()`. The wording above now precisely says **Map values**; no
test scope was expanded. Default Map entries remain separately exercised by
the host/standalone `mapProjection()` matrix through `[...map]`, including its
fresh `[key, value]` pair checks. This resolves the documentation overclaim
without changing implementation, policy, acceptance scope, or behavior.

### Post-review static source gates (2026-08-31)

After the P2 wording correction, the static-only checks passed without
starting a compiler, Vitest, Test262, or hook worker:

- `git diff --check`: pass;
- targeted Prettier check over every owned source/test/tracker file: pass;
- LOC budget: pass, with no unallowed growth in six changed source files
  (`net +2147 LOC` against the configured merge-base and only the existing
  #5131 change-scoped grants);
- function budget: pass, with no unallowed growth in six changed source files
  and only the existing #5131 change-scoped grants;
- static #5131 import-inventory source contract: pass. It confirms the
  focused probe is precisely `Map.values()`; its non-vacuous JS-value bridge
  requirement and `env::__iterator`/legacy/unknown exclusions remain present;
  default Map entries are separately covered by `mapProjection()`; the
  `__map_iter_next` source region uses the canonical `$Vec` without the eager
  `$ObjVec` dependency or stale `any.convert_extern`; and the strict-provider
  wiring remains distinct from the compatibility `__iterator` bridge.

The static inventory check originally used an overbroad source-region boundary
that included later unrelated `Map` helpers; it was corrected to the actual
`__map_iter_next` region before passing. This was a checker-boundary adjustment
only, not a source or behavior change. The clean uninterrupted TS7 rerun is
still the next runtime gate and requires a fresh empty-worker audit.

### Current-main reconciliation audit (2026-08-31)

This persistent recovery worktree remains on published PR/recovery head
`8e029466fc4a1bdb403b5d7dc4d5e913829414b0`; fresh upstream/main is
`c97a51a7bd039d543b232a2735a6ec6afe487bb4`. Their merge base is
`275216c74c7299ea07a72c8d5479f7e1a477000c`; the exact divergence count is
**14** commits unique to the old PR head and **102** commits unique to current
main. No merge, rebase, cherry-pick, push, or PR mutation was attempted here.

The initial two-tip diff was corrected with a three-way path audit. Relative
to merge base `275216…`, the old PR head changes the tracker, `map-runtime.ts`,
and `runtime.ts`, and **adds** the focused test; current main changes
**only** `src/runtime.ts` among these paths. Thus current main did not delete
the focused test or modify the tracker/map runtime: the test is branch-only,
introduced by old-PR commit
`6bc798395864b95cee1ef354c80507473a620b30`
(`fix(iterators): enforce strict spread materialization ✓`), and absent from
main because that commit is not merged. Likewise,
`strict-iterator-host.ts` is a recovery-only new file, absent from both
committed sides rather than removed upstream.

The sole committed three-way conflict risk is `src/runtime.ts`. Current-main
commits touching it are:
`73200f1b004f7a578edbe4ccee2f3eb45b86deec` (#5203),
`34f48c3df2d6a9f4d94e28bc63c063fb1f2009aa` (#5204),
`fb1b49883057479cd8a97aeac21be9d973b082a0` (#5205),
`3d8b21ea625062a3f9ea7635b05608239e82b5d7` (#5209),
`3a320a8e7ffa35d91adcc18162f13116865ed2f3` (#5211),
`05ea44e818c6242695611fec181fd76d205e7d47` (#4628),
`62d5174e5d75c22a58c5f2b9564da322e2193997` (#5222), and
`df90a2c17de6b8ac67c0bc8753caac226e866e25` (linked-provider boundary
reconciliation). Read-only `git merge-tree --trivial-merge` reports exactly
one `changed in both`: `src/runtime.ts`, base blob
`b4382f21ed83ae28c1fc07d4629d414173587792`, old-PR blob
`988c17e8713a22d7027d265c1a30cf91a40f199d`, and current-main blob
`4ca156d4c4ca822637961fc4191f0f3bfbbcb082`. The map, tracker, and test are
not current-main textual conflicts in that committed three-way merge.

Current main does retain the older host strict materializer:
`__array_from_iter_strict` / `__array_from_iter_n_strict` feed
`_arrayFromIter(..., true)`, and `new-builtin-globals.ts` uses that host
fallback. It has no `__iterator_strict`, `__iterator_next_strict`,
`__call_@@iterator_strict`, or `__call_next_strict` source occurrence, and it
still emits the standalone diagnostic that dynamic/nested Proxy spreads are
not available without the strict iterator provider. Its `__map_iter_next`
kind-2 arm returns the value field with entry packing deferred, not a fresh
canonical pair. Therefore the recovery's semantic requirements remain: native
strict-provider wiring for standalone/dynamic spread, fresh canonical Map
entry pairs, and the values-only import-inventory regression control. They
must be reconstructed against the linked-provider runtime changes, not copied
blindly as old runtime hunks.

Ancestry checks return false in both directions (`8e029…` is not an ancestor
of `c97a…`, and `c97a…` is not an ancestor of `8e029…`), so PR #5272 cannot
fast-forward to current main. A normal update would require at least the
documented `runtime.ts` three-way resolution, while the uncommitted recovery
repair is outside that virtual merge. The safe course is a fresh
current-main-based reconstruction/new integration head; the existing PR may
only be updated after that deliberate normal merge/rebase and exact-head
replay, never by blindly carrying forward the old head.

The recovery worktree currently has only its five owned paths dirty: tracker,
`map-runtime.ts`, `runtime.ts`, new `strict-iterator-host.ts`, and the focused
test. It must not be published from this old head. After root integrates the
bounded repair with exact current main (or a newer recorded main), rerun on
that exact integrated SHA: full host-import policy, focused host/standalone
suite, four owned Test262 rows, uninterrupted TS7, targeted static gates,
normal hooks, and the required pre-push suite. Earlier evidence remains
diagnostic only until that exact-head replay completes.

The required post-reconciliation static replay also passed on the recovery
tree: `git diff --check`; targeted Prettier; LOC budget (no unallowed growth
in six changed source files, `net +2147 LOC` against its configured base);
function budget (no unallowed growth in six changed source files); and the
source-only #5131 import-inventory contract. The latter confirms the exact
values-only probe, separate `mapProjection()` entry coverage, canonical `$Vec`
pair/no eager `$ObjVec` dependency, no stale conversion, strict-provider
wiring, and preserved compatibility bridge. These source checks do not resolve
the current-main runtime conflict and are not substitutes for the required
exact-integrated-head runtime replay.

A fresh broad post-static census was not clean, so TS7 was deliberately not
started: an external runtime-provider compiler (PID `5443`), standalone
Test262 driver `7664 → 15845`, and a live ES5 census `11540` with four active
row children (`15847`–`15850`) were already active. This worktree remains
process-free; the earlier interrupted TS7 result remains non-authoritative.

### Second TS7 release capacity race (2026-08-31, zero evidence)

An initial release audit observed a standalone Test262 driver (PID `22093`),
so no TS7 process was launched at that point. Root confirmed that a single
external lane may coexist with #5131 under the two-lane cap. The immediate
follow-up full census was clear, and the exact direct TS7 payload then began
as verified own PID `22953` (terminal session `87989`):

```text
PATH=/private/tmp/codex-pnpm10/node_modules/.bin:... \
  node node_modules/typescript7/lib/tsc.js --noEmit -p tsconfig.ts7.json
```

A during-run census then found two independent external Vitest lanes
(`23025 → 23031` and `23397 → 23405`) plus a cargo test lane
(`23408 → 23412`), exceeding the global cap. SIGINT was sent only to the
verified #5131 session. The session disappeared before an exit status,
diagnostic stream, or trustworthy elapsed duration could be collected.
Consequently this attempt is explicitly **non-authoritative / zero publication
evidence**; it does not count as a TS7 pass and must be rerun uninterrupted on
the eventual exact current-main integration head. No subsequent #5131
validation command was started.

### Integration-review P1: strict-host marshal authority (2026-08-31)

Independent integration review identified a P1 in any naïve current-main
reconstruction. The strict-iterator host extraction must not give its
`_wrapForHost`, Wasm-`$Vec`, native-carrier, or empty-tuple marshalling paths
only the raw `state.getExports()` view. That view is intentionally a
post-instantiation protocol-availability channel: it is appropriate for
strict `__call_*` / iterator dispatch once instance exports exist, but it is
undefined while a module start function is running.

The current-main reconstruction must instead inject a distinct,
`marshalExports`-backed view into `createStrictIteratorHostRuntime` for all of
those marshalling operations. This retains the init-registered helper fallback
needed before `WebAssembly.instantiate` returns, while leaving direct
`state.getExports()` restricted to the post-instantiation iterator protocol
paths. In particular it must preserve the start-export behavior supplied by
#5203 and #5209, rather than treating a temporarily unavailable direct export
view as evidence that a Wasm value is not a vec/carrier/empty tuple.

This is a reconstruction requirement, not a source edit to the stale recovery
head. The rebuilt `runtime.ts` must also retain every one of the eight
current-main fixes listed in the reconciliation audit above: #5203, #5204,
#5205, #5209, #5211, #4628, #5222, and the linked-provider boundary
reconciliation (`df90a2c7…`). The integration review otherwise found no new
runtime source patch to apply here; current-main reconstruction and the full
exact-head replay remain mandatory.

### Third TS7 release capacity race (2026-08-31, zero evidence)

Root released one second lane while the sole external family was the one-fork
Vitest run `39768 → 39773 → 39781`. The mandatory #5131 re-audit confirmed
that topology, then the exact direct TS7 payload started as verified own PID
`40257` in terminal session `56358`. A during-run census immediately found
additional independent compiler/test lanes: TypeScript processes `40261` and
`40267`, plus new Vitest families rooted at `40268`, `40271`, and `40272`
(with their respective fork children). SIGINT was sent only to the verified
#5131 session.

The own PID subsequently vanished and the terminal session later returned a
silent exit `0`, with no diagnostics or complete timing/output evidence. Since
the interruption raced the command, that silent status cannot establish a
completed TS7 check. This third attempt is therefore **non-authoritative / zero
publication evidence**, not a TS7 pass; the exact current-main integration
head still requires a clean uninterrupted TS7 replay. No further #5131
validation command was launched.

### Current-tip reconciliation update: `b9952e3` (2026-08-31)

Upstream/main advanced from
`c97a51a7bd039d543b232a2735a6ec6afe487bb4` to
`b9952e353cc1616933b2b035b4d49b33350e86df`. The recovery worktree remains
at old PR head `8e029466fc4a1bdb403b5d7dc4d5e913829414b0`; its merge base with
the new main remains `275216c74c7299ea07a72c8d5479f7e1a477000c`. Exact
divergence is now **14** old-PR commits versus **117** main commits. The
incremental `c97a…b995` range contains 15 commits, headed by merge #5340 and
including CI/QuickJS-worker caps, npm-compat artifact refreshes, issue/docs
filings, baseline retry automation, the website refresh, and
`78d583250bcfa7a123c09655da1c9a0727c2b5e7`
(`fix(runtime): preserve QuickJS boolean mirror values`).

The complete incremental name-status list changes CI workflows, npm-compat
benchmarks and website mirrors, issue/log markdown, the QuickJS provider,
QuickJS/test262 tests, and only these codegen paths:
`src/codegen/coercion-engine.ts`,
`src/codegen/expressions/call-identifier.ts`, and
`src/codegen/expressions/calls.ts`. There is **no** `c97a…b995` path overlap
with the #5131 tracker, `map-runtime.ts`, `runtime.ts`, recovery-only
`strict-iterator-host.ts`, or the focused test (`git diff --quiet` over those
paths exits 0).

The three changed codegen files belong solely to `78d583…`: native dynamic
boolean `ToString` handling and the runtime-eval boolean result carrier. Their
source diff contains no #5131 map iterator, strict iterator provider,
strict-host-runtime, compatibility `env::__iterator`, `mapProjection`, or
spread lowering change. The #5131 values-only native-first inventory control
uses `Map.values()` / numeric accumulation rather than those `String` or
runtime-eval paths, so this range does not alter the recovery tree's static
source claims. It can still affect global generated-code/ratchet state, so it
does not replace any exact-head policy, focused, Test262, or TS7 replay.

The committed three-way topology is unchanged: `git merge-tree` still reports
only `src/runtime.ts` as `changed in both`, with the same main blob
`4ca156d4c4ca822637961fc4191f0f3bfbbcb082`; none of the #5131
map/tracker/test paths newly conflict. The current-main reconstruction must
therefore retain the documented marshal-authority P1 and all eight existing
main fixes, integrate against `b9952…` (or a newer recorded main), and rerun
the complete acceptance set on that exact integrated SHA. No merge, rebase,
or validation command was performed for this static reconciliation.

### Fourth TS7 direct-gate result (2026-08-31, pre-integration evidence)

The released pre-launch census had one external Test262 family
(`48388 → 48564`). The exact direct payload then started as verified own PID
`49140` in terminal session `93912`:

```text
PATH=/private/tmp/codex-pnpm10/node_modules/.bin:... \
  node node_modules/typescript7/lib/tsc.js --noEmit -p tsconfig.ts7.json
```

The ordered during-run census observed PID `49140` at `00:12` elapsed. At that
moment the released Test262 lane had exited and no other compiler/test lane
was visible (only Codex sandbox control processes, which are not test
workers). The next ordered session poll returned normal exit **0**, with empty
diagnostics/output and no SIGINT. The direct payload emits no elapsed-time
summary, so the only observed timing is the `00:12` in-flight census; its exact
completion duration is not available from the executor result.

The immediate post-exit census showed new unrelated work: `test:changed-root`
PID `49668` (`00:27` then), Vitest `49793 → 49799 → 49808` (`00:15` then),
and TypeScript PID `49813` (`00:12` then), along with an unrelated stack-balance
check. Those PIDs had exited before a follow-up `ps -o lstart` query, and the
earlier tool outputs contain no absolute wall timestamps. Their start times
relative to the final seconds of PID `49140` are therefore indeterminate.

Root classifies the normal no-signal exit as **authoritative pre-integration
TS7 command evidence**, but explicitly not as a clean/uncontended lane. It
does not discharge the mandatory uninterrupted TS7 replay on the eventual
exact current-main integration head.

## Completion evidence (2026-09-01)

The draft head's focused strict-spread matrix was already green 3/3; its stale
PR description and unresolved `src/runtime.ts` merge conflict were the visible
blockers. The branch is now integrated with current `upstream/main`. The sole
textual conflict was the runtime import list and was resolved by retaining both
the strict-iterator host extraction and main's class-primitive bridge.

The integration also closes the prior P1 marshal-authority review finding.
Strict iterator protocol dispatch still reads the post-instantiation export
view, while vec/carrier/empty-tuple marshalling uses `marshalExports`, including
the init-registered helper fallback available during a Wasm start section. A
focused init-window control proves a strict spread materializes a Wasm vec when
`getExports()` is unavailable and only `getStartExports()` is populated.

On the integrated tree the focused suite passes 4/4 and TypeScript 7 typecheck
passes without diagnostics. Final policy gates, normal hooks, and pushed-head
CI evidence are recorded by the finishing commit and PR checks.
