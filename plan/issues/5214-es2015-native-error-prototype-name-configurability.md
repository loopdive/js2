---
id: 5214
title: "ES2015 standalone: NativeError prototype name configurability (6 rows)"
status: in-progress
created: 2026-08-30
updated: 2026-08-30
priority: high
horizon: s
feasibility: medium
model: gpt-5.6-luna
reasoning_effort: max
task_type: conformance
area: codegen
language_feature: native-errors
es_edition: ES2015
goal: standalone-mode
assignee: ttraenkler/codex-es6-native-error-name
related: [4444, 5156, 4248]
---

# #5214 — NativeError prototype `name` configurability

## Problem and exact scope

Issue #5156 added the ES2015 `name` data property and descriptor for each
NativeError prototype. The remaining propertyHelper failure is narrower:
deleting the configurable `name` property removes its own descriptor, but the
shared NativeProto presence path still reports `hasOwnProperty("name")` true.
The inherited `Error.prototype.name` keeps the `in` operator true, so that
disagreement makes the six exact ES2015 rows below fail their
`configurable: true` check:

```text
test/built-ins/NativeErrors/EvalError/prototype/name.js
test/built-ins/NativeErrors/RangeError/prototype/name.js
test/built-ins/NativeErrors/ReferenceError/prototype/name.js
test/built-ins/NativeErrors/SyntaxError/prototype/name.js
test/built-ins/NativeErrors/TypeError/prototype/name.js
test/built-ins/NativeErrors/URIError/prototype/name.js
```

The maintained 2026-08-28 host artifact reports **6/6 pass**. The fresh
standalone census on detached diagnostic source
`1f1004f3df195cc5f9e804efcbb2896d3871ca37` has so far recorded five of these
rows, all as `fail/assertion_fail` with the exact signature `name descriptor
should be configurable`; the sixth row had not yet been emitted when this task
was filed. This diagnostic source predates current upstream and is dispatch
evidence only. Before crediting a fix, the worker must establish the six-row
baseline on its current-upstream worktree after the shared census releases the
global test-worker lock.

## Root-cause seam

`src/codegen/native-proto-own-props.ts` already distinguishes immutable CSV
members from seeded mutable companion entries. A deleted seeded data property
must take its presence answer from the companion; a later CSV/spec shortcut
must not resurrect it. The #5156 handoff established that the `name` value,
descriptor, deletion, and `in` result are already correct, leaving the
NativeError `name` registration/routing through that authoritative companion
ladder as the bounded seam. The implementation must preserve the initial own
property and its ES2015 attributes while making deletion and subsequent
redefinition observable consistently across `hasOwnProperty`, `Object.hasOwn`,
`propertyIsEnumerable`, and `getOwnPropertyDescriptor`.

## Implementation plan

1. Reproduce one row with a reduced semantic probe that checks the initial
   value/descriptor, deletes `name`, then compares `hasOwnProperty`, `in`, and
   `getOwnPropertyDescriptor`; confirm which NativeError brand/member mapping
   bypasses the seeded-companion ladder.
2. Route exactly the six NativeError `name` data properties through the existing
   authoritative mutable-companion presence path in
   `native-proto-own-props.ts`/its registration source. Do not special-case the
   Test262 helper, make every prototype member mutable, or change unrelated
   `message`, method, constructor, or symbol-member behavior.
3. Add a focused regression test covering initial ownership and attributes,
   successful deletion, absence on every reflective surface, and a write or
   `defineProperty` revival. Include at least one unaffected builtin-prototype
   method/data-property control.
4. After the census releases the two-worker lock, run the exact six rows in
   standalone and host modes with at most two workers, then run the focused
   test, typecheck, formatting, budgets, and the normal hooks without skips or
   bypasses. Record exact commands, counts, artifacts, and any residual in this
   file.
5. Commit with the required Thomas Tränkler authorship, Luna Max model trailer,
   and Codex co-author trailer. Push only to `ttraenkler/js2` and open one
   separate, non-draft PR against `loopdive/js2:main` only when the fix is
   complete, current, tested, and mergeable; otherwise leave a truthful draft
   checkpoint and handoff.

## Implementation, evidence, and handoff checkpoint

Static implementation is now present in
`src/codegen/native-proto-own-props.ts`. The shared NativeProto presence arm
uses three results: `1` for a present advertised member, `0` for a known seeded
member whose companion entry is absent, and `-1` to decline so the original
predicate can continue handling non-prototype receivers and ordinary
expandos. The three own-property predicates preserve `0` as authoritative for
known deleted companion entries, preventing a later CSV/intrinsic fallback
from resurrecting a deleted NativeError `name`; the enumerable predicate
rechecks known entries through the companion so a later enumerable redefinition
is visible too. Its companion path tests for the `$Object` carrier before
re-entry, so an unseeded NativeProto receiver passes through without
recursing. This keeps the existing
`seededNativeProtoOwnMembersByBrand` data-property registration unchanged and
scopes the behavior to the shared presence seam.

The focused regression is
`tests/issue-5214-native-error-prototype-name.test.ts`. It covers all six
NativeError prototypes, initial ES2015 descriptor attributes, deletion and
own-absence across `hasOwnProperty`, `Object.hasOwn`, gOPD, and
`propertyIsEnumerable`, preserves the inherited `in` result, checks assignment
revival, and includes unaffected Date-method and ordinary-expando controls.

Validation is complete on tested commit
`a62aacba5ccc154f6fc378235aaaeeb4a7204231` (the requested upstream base), with
`TEST262_WORKERS=1`, `COMPILER_POOL_SIZE=1`, and one canonical worker:

```text
focused Vitest regression: 1 file, 1 test passed
canonical FYI worker exact matrix: 12/12 passed
  gc host lane:         6/6 passed, runtime phase, reachedTest=true
  standalone lane:     6/6 passed, runtime phase, reachedTest=true
```

The exact matrix used the six paths above and forked a fresh canonical worker
realm for each intentional `verifyProperty` deletion (the expected
`TEST262_REALM_CANARY=recycle` drift reports were observed). A preliminary
direct in-process host diagnostic passed each primary variant but failed its
strict rerun after the destructive deletion; that runner-realm limitation is
not used as acceptance evidence. The canonical forked-worker run is the
authoritative host evidence.

Proportionate static gates also pass: targeted Prettier, Biome lint, both
TypeScript no-emit configurations, LOC and function budgets, oracle/coercion
ratchets, stack balance, codegen fallback checks, and issue-index integrity.
The compiler bundle was rebuilt before the final matrix. No commit, remote, or
PR state has been changed; commit hooks and delivery remain with the parent
agent after review authorization.

Commands recorded for this checkpoint (all from the isolated worktree):

```text
TEST262_WORKERS=1 COMPILER_POOL_SIZE=1 node node_modules/vitest/dist/cli.js run \
  tests/issue-5214-native-error-prototype-name.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=verbose

TEST262_WORKERS=1 COMPILER_POOL_SIZE=1 TEST262_REALM_CANARY=recycle \
  node --import tsx --input-type=module -e '<canonical FyiSourceExecutor matrix over the six paths above, target gc then standalone>'

node_modules/.bin/esbuild src/index.ts --bundle --platform=node --format=esm \
  --outfile=scripts/compiler-bundle.mjs --external:typescript --external:binaryen
node_modules/.bin/prettier --check src/codegen/native-proto-own-props.ts \
  tests/issue-5214-native-error-prototype-name.test.ts \
  plan/issues/5214-es2015-native-error-prototype-name-configurability.md
node_modules/.bin/biome lint src/codegen/native-proto-own-props.ts \
  tests/issue-5214-native-error-prototype-name.test.ts --diagnostic-level=error
node node_modules/typescript7/lib/tsc.js --noEmit -p tsconfig.ts7.json
node node_modules/typescript/lib/tsc.js --noEmit
node scripts/check-loc-budget.mjs
node scripts/check-func-budget.mjs
node scripts/check-oracle-ratchet.mjs
node scripts/check-coercion-sites.mjs
node --import tsx scripts/check-stack-balance.ts
node --import tsx scripts/check-codegen-fallbacks.ts
node scripts/update-issues.mjs --check
```

The omitted inline matrix body is the one-shot command used for the final
12-row result above; it assembled each raw Test262 file with
`parseMeta`/`assembleOriginalHarness`, then reused one
`FyiSourceExecutor(120000)` serially per target.

## Acceptance

- All six exact rows pass standalone with zero fail, compile error, timeout, or
  skip, and their six host controls remain passing.
- The focused test proves both deletion and revival rather than only the
  initial descriptor.
- Unrelated builtin-prototype own-property, descriptor, and deletion controls
  do not regress.
- The issue records the tested commit SHA and upstream PR URL/state. A separate
  shepherd verifies the exact head, body template, CI, reviews, conflicts, and
  readiness before landing.

## Handoff

This task owns only the six NativeError prototype-`name` rows and their shared
mutable-companion presence seam. It must not absorb #5156's remaining Symbol,
Function, Error-stack, realm, or NewTarget clusters. No GitHub issue is to be
created; this markdown file is the issue of record.
