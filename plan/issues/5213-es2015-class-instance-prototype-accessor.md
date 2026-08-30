---
id: 5213
title: "ES2015 class instance accessors named prototype stay on C.prototype"
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
pr: 5288
assignee: ttraenkler/codex-luna-class-prototype-accessor
requested_by: codex/es2015-closeout
loc-budget-allow:
  - src/codegen/property-access-dispatch.ts
---

# #5213 — instance `prototype` accessor key separation

## Problem

The exact generated ES2015 rows

- `test/language/expressions/class/elements/syntax/valid/grammar-special-prototype-accessor-meth-valid.js`; and
- `test/language/statements/class/elements/syntax/valid/grammar-special-prototype-accessor-meth-valid.js`

fail standalone with an illegal cast in the fresh #5195 class census. A class
constructor must retain its own non-writable data property `C.prototype`, while
an instance getter/setter literally named `prototype` is a distinct accessor
installed on that prototype object. The collision is at property-access
dispatch: `C.prototype.<name>` is a second-level read from the `$Object`
prototype carrier, but the generic class-accessor path describes its getter ABI
as receiving a `$C` instance. The reserved constructor-side `C.prototype`
read must remain its own lazy-prototype path. This is the independent two-row
accessor slice split from #5195; no GitHub issue is to be created.

The implementation worktree starts at fetched `loopdive/js2` upstream main
`a62aacba5ccc154f6fc378235aaaeeb4a7204231` on branch
`codex/5213-class-prototype-accessor`.

## Implementation plan

1. Add `tests/issue-5213-es2015-class-prototype-accessor.test.ts` pinning both
   exact rows in host and standalone, zero standalone imports, and focused
   declaration/expression controls that verify constructor/prototype identity,
   getter return `13`, setter invocation, descriptor flags, and no collision
   with a static member or ordinary differently named accessor. Run the
   focused source through the host too; the exact-row host controls do not
   exercise that expanded declaration/expression matrix.
2. Keep the implementation at the actual collision site:
   `src/codegen/property-access-dispatch.ts` must distinguish the constructor's
   reserved `C.prototype` read from the second-level instance accessor lookup
   without changing the existing class-member registry or inventing a wider
   kind-bearing key carrier. The class-member tables already distinguish the
   accessor/static sets; this slice only needs that existing invariant plus the
   prototype-object receiver shape.
3. Reuse the canonical accessor descriptor installation from
   `src/codegen/class-proto-accessors.ts` / `src/codegen/class-proto-object.ts`.
   For a getter reached as `C.prototype.prototype`, the typed getter ABI cannot
   receive the `$Object` prototype carrier. The new direct optimization may
   invoke it with a synthetic `$C` only after `genBodyReferencesThis` proves
   that the getter body observes neither `this` nor `super`; receiver-sensitive
   getters decline the arm and remain on the existing ordinary/fallback path.
   Preserve `{ enumerable: false, configurable: true }`, accessor identity, and
   the constructor's own `prototype` value; do not special-case Test262 or
   weaken brand/cast checks.
4. Keep builtin-subclass carrier work (#5195/#5212), generator issue #5199, and
   unrelated static `prototype` early errors out of scope.
5. Validation checkpoint (2026-08-30): with
   `TEST262_WORKERS=1 COMPILER_POOL_SIZE=1`, Vitest single-fork and
   `--no-file-parallelism`, the focused file passed all 3 tests. Both exact
   rows passed their host and standalone lanes; the expanded declaration /
   expression, descriptor, setter, adjacent/static, and receiver-sensitive
   controls also passed. TS5 and TS7 typechecks, targeted Prettier and Biome,
   LOC/function budgets, oracle/coercion ratchets, and issue-integrity gates
   all passed. Numeric-local parity and complete commit/pre-push hooks remain
   root-owned follow-up after integrating current upstream main.

## Delivery and handoff

Worktree: `/private/tmp/js2-es2015-class-prototype-accessor-20260830`.
Branch: `codex/5213-class-prototype-accessor`.
Parent planning issue: `plan/issues/5195-es2015-standalone-class-r2.md`.

This issue was atomically allocated with `scripts/claim-issue.mjs --allocate`.
The implementation remains confined to
`src/codegen/property-access-dispatch.ts` (the narrow second-level read arm),
this issue plan, and the focused test file. No class member key representation,
class-body collection, constructor materialization, or Map/Set provider file is
part of this slice. A receiver-sensitive getter is deliberately excluded from
the synthetic `$C` arm: `genBodyReferencesThis` rejects `this` and `super`, so
the guard never fabricates a receiver-visible value. The ordinary instance
control proves that receiver-sensitive access still returns the exact instance.

The two-row invariant is carried by existing state: `classAccessorSet`
identifies the instance accessor, `staticAccessorSet` keeps same-named static
members out of the arm, and `classMemberFuncKey` resolves the canonical getter
without expanding the member-key carrier. The constructor `prototype` path
remains the earlier `emitLazyProtoGet` path; only the second-level
`C.prototype.<name>` arm is narrowed. On this branch, the one-worker focused
run passed 3/3 tests (both exact rows in host and standalone plus the expanded
matrix); TS5/TS7, targeted formatting/lint, LOC/function budgets,
oracle/coercion ratchets, `git diff --check`, issue IDs, done-status, issue
spec-coverage, and issue-integrity checks passed. The direct package-manager
shim refused the typecheck subcommands, so the exact TypeScript compiler
commands from those scripts were invoked directly and passed. Root then
integrated current upstream main `c243892c7f`, and the complete commit hook
passed without a skip: lint-staged formatting/lint, budgets, the changed-root
focused suite (3/3), and the oracle ratchet. The complete pre-push hook passed
typecheck plus lint, repository Prettier, oracle/coercion ratchets,
numeric-local parity (18/18), conformance synchronization, and issue integrity.
Implementation commit `10f056cd549c9768851649a06880c0614c43c19e` was
published to the fork and read back at that exact SHA without rewriting
history.
A completed, current, mergeable fix gets one separate non-draft PR from
`ttraenkler/js2` to `loopdive/js2:main`. Only a genuinely incomplete/non-mergeable
checkpoint may be draft. The dedicated PR shepherd must verify the exact head,
body/CLA format, CI, mergeability, and ready/queue state before landing.

The single completed-fix PR is
<https://github.com/loopdive/js2/pull/5288>. It is non-draft, targets current
`loopdive/js2:main`, uses the exact repository Description/CLA format, and names
this markdown issue; no GitHub issue was created. A dedicated Luna Max PR
shepherd owns exact-head, body, readiness, conflict, review, CI, and queue
verification. Any later documentation-only handoff commit does not change the
validated code at implementation head
`10f056cd549c9768851649a06880c0614c43c19e`.

## Acceptance criteria

- Both exact rows pass standalone with zero host imports and pass host control.
- `C` keeps its own constructor `prototype` data property while `C.prototype`
  owns the paired instance accessor named `prototype` with correct flags.
- Adjacent instance/static accessors and class declaration/expression identity
  do not regress.
- The focused receiver control demonstrates that a getter which reads `this`
  is not lowered through the synthetic receiver arm; this-sensitive behavior
  remains an honest fallback rather than a fabricated class instance.
- The branch is integrated with then-current upstream main and all required
  focused and repository gates pass before publication.
