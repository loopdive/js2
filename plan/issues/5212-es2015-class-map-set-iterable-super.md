---
id: 5212
title: "ES2015 standalone class Map/Set subclasses preserve iterable constructor state"
status: done
sprint: current
created: 2026-08-30
updated: 2026-08-30
completed: 2026-08-30
priority: high
horizon: s
feasibility: medium
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
pr: 5286
assignee: ttraenkler/codex-luna-class-collections
requested_by: codex/es2015-closeout
loc-budget-allow:
  - src/codegen/class-bodies.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/literals.ts
func-budget-allow:
  - src/codegen/class-bodies.ts::compileClassBodiesInner
  - src/codegen/literals.ts::compileArrayLiteral
  - src/codegen/class-bodies.ts::compileSuperCall
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/codegen/class-bodies.ts::collectClassDeclaration
---

# #5212 — faithful Map/Set subclass iterable construction

## Problem

The exact ES2015 rows

- `test/language/statements/class/subclass/builtin-objects/Map/regular-subclassing.js`; and
- `test/language/statements/class/subclass/builtin-objects/Set/regular-subclassing.js`

pass on the host lane but fail standalone on the pre-fix evidence recorded by
#5195. `class M extends Map {}` and `class S extends Set {}` already allocate a
correctly branded native `$Map` carrier, but
`emitStandaloneCollectionSuperCtor` drops every forwarded constructor argument.
The resulting subclasses therefore begin empty instead of consuming their
array-literal iterables. This issue is the isolated Map/Set provider slice from
#5195; no GitHub issue is to be created.

The implementation worktree starts at fetched `loopdive/js2` upstream main
`a62aacba5ccc154f6fc378235aaaeeb4a7204231` on branch
`codex/5212-class-collection-super`.

## Implementation plan

1. Add `tests/issue-5212-es2015-class-collection-super.test.ts` pinning the two
   exact Test262 files in host and standalone, zero standalone imports, and
   focused controls for iterable evaluation order, Map key/value retention, Set
   de-duplication, `.size`, inherited mutation, subclass identity, and parent
   brand identity.
2. Make implicit and explicit builtin-subclass construction forward the actual
   statically observed `super(...)` value at the correct externref arity. Do not
   recompile or re-evaluate the argument in the provider.
3. Reuse or extract the existing native `new Map([[k, v], ...])` and
   `new Set([v, ...])` seeding invariant from
   `src/codegen/expressions/new-super.ts`. The subclass route must initialize
   the same branded carrier through `__map_set` / `__set_add`, then retain that
   carrier while the class path applies subclass prototype and user-brand
   metadata. Do not introduce a parallel fake collection representation.
4. Preserve the collection constructor's nullish/no-argument behavior and
   observable argument ordering. Unsupported general/dynamic iterables must
   decline explicitly for later work rather than silently masquerading as a
   completed implementation. WeakMap/WeakSet and the other builtin providers
   remain outside this issue.
5. After the authoritative census releases the global two-worker lock, run the
   two exact rows and focused matrix in standalone and host with at most two
   workers, then run adjacent existing Map/Set constructor and subclass controls,
   TS5/TS7, formatting, lint, LOC/function budgets, oracle/coercion ratchets,
   numeric-local parity, issue integrity, and the complete commit/pre-push hooks.

## Delivery and handoff

Worktree: `/private/tmp/js2-es2015-class-collection-super-20260830`.
Branch: `codex/5212-class-collection-super`.
Parent planning issue: `plan/issues/5195-es2015-standalone-class-r2.md`.

This issue was atomically allocated with `scripts/claim-issue.mjs --allocate`.
The Luna Max implementer works only in this worktree, must not run validation
while the full census owns both test workers, and must update this file with
exact evidence and remaining limitations. A completed, current, mergeable fix
gets one separate non-draft PR from `ttraenkler/js2` to `loopdive/js2:main`.
Only a genuinely incomplete/non-mergeable checkpoint may be draft. The
dedicated PR shepherd must verify the exact head, body/CLA format, CI,
mergeability, and ready/queue state before landing.

## Acceptance criteria

- Both exact rows pass standalone with zero host imports and pass host control.
- Map and Set subclass iterable values, sizes, inherited mutation, and brands
  agree with their direct native constructors.
- No regression in no-argument/nullish direct Map/Set construction or existing
  subclass identity behavior.
- The branch is integrated with then-current upstream main and all required
  focused and repository gates pass before publication.

## Static implementation checkpoint (2026-08-30)

The bounded provider slice is authored on the allocated worktree/branch. The
implementation invariant is:

> The first `super(...)` externref is evaluated exactly once by the caller. For
> Map/Set, the defined per-arity native subclass helper consumes that same
> value only when it is one of the compiler's native array carriers, walking it
> through finalized `__extern_length` / `__extern_get_idx` readers and seeding
> the fresh correctly branded `$Map` with `__map_set` / `__set_add`. The helper
> never receives or re-evaluates the source AST.

The call-site seam in `class-bodies.ts` and `expressions/new-super.ts` forces
only a statically visible Map/Set array literal (including nested Map entry
pairs) to remain a native vec carrier in standalone/WASI. Its collection-only
nested-carrier mode uses `vec<externref>` recursively, avoiding the contextual
tuple representation that the provider cannot index while leaving host
lowering and later constructor arguments unchanged. The same seam keeps an
explicit subclass constructor's first parameter at the open `externref`
boundary, so a typed `ReadonlyArray<readonly [K, V]>` annotation cannot coerce
the lossless carrier back into a tuple ABI before the provider sees it.
Nullish/no-argument forwarding remains empty. A non-array carrier takes the
explicit native TypeError path; general iterator protocol, dynamic typed tuple
arrays, WeakMap/WeakSet, and other builtin providers remain outside this issue.

Changed files:

- `src/codegen/standalone-subclass-ctors.ts` — per-arity Map/Set carrier walk,
  native seeding, nullish/unsupported-input handling, and provider rationale.
- `src/codegen/class-bodies.ts` — first-argument-only array-carrier seam for
  explicit Map/Set `super(...)` calls.
- `src/codegen/expressions/new-super.ts` — matching seam for direct local
  subclass construction.
- `src/codegen/literals.ts` — collection-only recursive `vec<externref>` mode
  so contextual tuple pairs stay indexable as native nested array carriers.
- `tests/issue-5212-es2015-class-collection-super.test.ts` — exact-row hooks
  plus host/standalone controls for state, ordering, de-duplication, mutation,
  identity, brands, and empty forms.

No tests, probes, compiles, typechecks, builds, hooks, or other CPU-heavy
validation were run while the full census owned both workers. Root should run
the exact rows and focused matrix after the census lock is released, then
review the remaining limitation around dynamic/general iterables before any
publication.

## Bounded validation (2026-08-30)

The census lock was later released and root authorized one worker for this
lane. The focused command was run directly through the provisioned local
Vitest entrypoint (the worktree's shared `node_modules` link is present, but
`pnpm exec` attempted an unavailable registry install because its package
manager metadata differs):

```text
TEST262_WORKERS=1 COMPILER_POOL_SIZE=1 VITEST_FORK_MAX_OLD_SPACE_SIZE=4096 \
  node node_modules/vitest/vitest.mjs run \
  tests/issue-5212-es2015-class-collection-super.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism \
  --reporter=verbose
```

Result: 1 file and 6 tests passed. Both host and standalone controls passed;
both exact Map/Set Test262 rows passed in both lanes, and standalone reported
zero imports as asserted.

Adjacent one-worker command:

```text
TEST262_WORKERS=1 COMPILER_POOL_SIZE=1 VITEST_FORK_MAX_OLD_SPACE_SIZE=4096 \
  node node_modules/vitest/vitest.mjs run \
  tests/issue-3972-standalone-subclass-builtins.test.ts \
  tests/issue-2620-extends-set-standalone-refusal.test.ts \
  tests/issue-1103a-standalone-map.test.ts tests/issue-2162-standalone-set.test.ts \
  tests/map-set-basic.test.ts tests/map-set.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=dot
```

Result: 4 suites passed (60 tests). `tests/map-set-basic.test.ts` could not
collect because its existing `../../src/runtime.js` import is absent in this
source checkout. Three `tests/map-set.test.ts` cases retain the pre-existing
strict `Map.get` possibly-undefined diagnostic. These failures are outside the
changed subclass provider seam.

For before/after evidence, the identical adjacent command was run from a
source-only tar snapshot of clean commit `a62aacba5c` (the sandbox disallowed a
second Git worktree because shared `.git` metadata is read-only). It produced
the same 4 passing suites / 60 passing tests and the same four failures: the
`map-set-basic` collection error and the three strict `map-set` diagnostics.
Therefore the adjacent failures are pre-existing and unchanged by #5212.

Additional bounded gates, all run serially with `COMPILER_POOL_SIZE=1` where a
compiler/test process was involved:

- TypeScript 5 (`node node_modules/typescript/lib/tsc.js --noEmit`) passed.
- TypeScript 7 (`node node_modules/typescript7/lib/tsc.js --noEmit -p
  tsconfig.ts7.json`) passed.
- Prettier repository check passed after formatting only the changed files.
- Full Biome lint and focused Biome lint for all five changed TypeScript files
  exited 0.
- LOC and function-budget ratchets passed with the explicit allowances above.
- Oracle and coercion-site ratchets passed with no net growth.
- Numeric-local parity passed: 18 tests.
- `update-issues.mjs --check`, committed issue integrity, done-status
  integrity, and IR optimization retirement checks passed.
- Verdict-oracle bump check passed; no oracle bump was required.
- Final focused rerun passed: 1 file / 6 tests.

The complete commit hook was subsequently invoked without a skip and passed:
lint-staged formatting/lint, LOC and function budgets, the changed-root focused
suite (6/6), and the oracle ratchet all completed before implementation commit
`08ca50d78fffc359204afe57e7ead75ec3ff58b6` was created. The complete pre-push
hook was also invoked without a skip and passed typecheck plus lint, repository
Prettier, oracle and coercion ratchets, numeric-local parity (18/18), conformance
synchronization, and committed/working-tree issue integrity. The published
`ttraenkler/js2` ref was read back and matched that exact implementation head.

The all-issues coverage audit remains red only for the repository's pre-existing
missing references; #5212 has its permanent test reference and is not among
those failures.

## Publication handoff (2026-08-30)

The single completed-fix PR is
<https://github.com/loopdive/js2/pull/5286>. It is a non-draft PR from
`ttraenkler:codex/5212-class-collection-super` to `loopdive/js2:main`; no GitHub
issue was created. Its description uses the repository's exact Description and
CLA sections and links this markdown issue. A dedicated Luna Max PR shepherd
owns exact-head, body, readiness, conflict, review, CI, and queue verification.
Any later documentation-only handoff commit does not change the validated code
at implementation head `08ca50d78fffc359204afe57e7ead75ec3ff58b6`.
