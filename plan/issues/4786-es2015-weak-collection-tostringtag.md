---
id: 4786
title: "ES2015 standalone WeakMap and WeakSet prototype Symbol.toStringTag"
status: done
sprint: current
created: 2026-08-27
updated: 2026-08-28
completed: 2026-08-27
assignee: "ttraenkler/codex-es2015-next-bounded-fix-8"
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
es_edition: es2015
language_feature: weak-collection-prototype-tostringtag
goal: host-and-standalone
related: [2162]
files:
  - src/codegen/array-object-proto.ts
  - src/codegen/native-proto.ts
  - src/codegen/native-proto-own-props.ts
  - tests/issue-4786-weak-collection-tostringtag.test.ts
  - plan/issues/4786-es2015-weak-collection-tostringtag.md
loc-budget-allow:
  - src/codegen/array-object-proto.ts
  - src/codegen/native-proto.ts
  - src/codegen/native-proto-own-props.ts
func-budget-allow:
  - src/codegen/native-proto-own-props.ts::registerNativeProtoHasOwn
---

# #4786 — ES2015 standalone WeakMap and WeakSet prototype `Symbol.toStringTag`

## Scope and baseline

This issue owns the two exact maintained ES2015 Test262 rows:

```text
test/built-ins/WeakMap/prototype/Symbol.toStringTag.js
test/built-ins/WeakSet/prototype/Symbol.toStringTag.js
```

The source baseline is `upstream/main` at
`fb4efeaa5cb2a374d9b6ff87b4eca217a2ab78f1`, with Test262 submodule revision
`b363f29d3c43c626dc852744ad64a0b48a003693`. The exact baseline probe used
the assembled Test262 harness and QuickJS artifact
`/private/tmp/js2-quickjs-artifact-2e2d7736713beeda`, capped at two compiler
workers. Host passes both rows; standalone fails both rows at the first tag
read with `undefined` instead of the required string:

| lane | WeakMap prototype tag | WeakSet prototype tag |
| --- | --- | --- |
| host | pass | pass |
| standalone | fail (`undefined` vs `"WeakMap"`) | fail (`undefined` vs `"WeakSet"`) |

The nearby Map/Set prototype tag rows are not controls for this issue: Map is
still red on this current tip and has an independently allocated residual.

## Root cause

Standalone builtin prototypes are represented by `$NativeProto` values. Their
companion seeder currently models the glue's string-keyed method CSV, while
the native `__nproto_hasown` helper rejects all symbol keys except Function's
special `Symbol.hasInstance` arm. WeakMap and WeakSet therefore have no
companion entry for their required well-known `Symbol.toStringTag`, so a
computed read returns `undefined` and `verifyProperty` cannot observe the
required own descriptor.

## Specification basis

ECMA-262 (June 2020) §23.3.3.5,
[`%WeakMap.prototype%[@@toStringTag]`](https://tc39.es/ecma262/2020/#sec-weakmap.prototype-@@tostringtag),
requires the value `"WeakMap"` with writable `false`, enumerable `false`, and
configurable `true`. Section 23.4.3.5,
[`%WeakSet.prototype%[@@toStringTag]`](https://tc39.es/ecma262/2020/#sec-weakset.prototype-@@tostringtag),
requires the corresponding `"WeakSet"` value and attributes.

## Implementation plan

1. Extend the native-prototype glue contract with optional well-known-symbol
   tag metadata and register the WeakMap/WeakSet tags without changing their
   method closure sets or instance collection runtime.
2. Seed the tag as a companion data property with the exact non-writable,
   non-enumerable, configurable descriptor flags, and make the native-proto
   own-property path recognize the symbol by identity and consult that mutable
   companion. Existing dynamic reads and descriptors will then use the normal
   companion table, including deletion/override semantics.
3. Add focused coverage for the exact two rows and controls for values,
   descriptors, identity, and a non-tag symbol. Run exact host/standalone A/B,
   repeats/determinism, and scoped repository gates.

## Acceptance criteria

- Both exact rows pass in host and standalone, with no compile errors,
  timeouts, skips, or unrelated control losses.
- `WeakMap.prototype[Symbol.toStringTag]` and the WeakSet twin retain their
  specified own descriptors; wrong symbols and ordinary collection methods are
  unchanged.
- The standalone output remains host-free and focused TypeScript/lint/format,
  issue metadata, budget, and hook checks pass.
- The implementation stays confined to native-prototype glue/seeding and the
  issue's regression test; no changes to WeakMap/WeakSet instance insertion or
  constructor behavior are included.

## Test Results

Final evidence below was collected after merging the current `upstream/main`
tip `76c47838e19f82932d8d17825512c673ce750ca4` into the branch (merge commit
`af522aff3c0e77cf93fd5d31fde2a97042085dc4`). The Test262 submodule remained
at `b363f29d3c43c626dc852744ad64a0b48a003693` and every run used the required
QuickJS artifact `/private/tmp/js2-quickjs-artifact-2e2d7736713beeda` with two
compiler workers.

- Clean baseline (source `fb4efeaa5cb2a374d9b6ff87b4eca217a2ab78f1`): exact
  standalone A/B was 0/2 (both rows failed); exact host control was 2/2.
  Baseline JSONL SHA-256: standalone
  `e4df36f897308af6a7b2e0818269045e5a86d0ba818b13918fbc240ea516c204`, host
  `7ee917934c709e699c6e7b726e98bdb15cc8b69628ae872eba5fc6da17019eab`.
- Final exact harness A/B on `76c4783`: standalone 2/2 and host 2/2, with no
  compile errors, timeouts, skips, or control loss. JSONL SHA-256: standalone
  `737ef305b80435fbaaaee2beb31759ee78099c5f41bddaedacfad395caaa4449`, host
  `7ee917934c709e699c6e7b726e98bdb15cc8b69628ae872eba5fc6da17019eab`.
- Final repeat/determinism probes on `76c4783`: standalone 2/2 and host 2/2,
  each with `nondeterministic: 0` (JSONL hashes match the exact A/B outputs
  above).
- Focused Vitest regression file
  `tests/issue-4786-weak-collection-tostringtag.test.ts` on `af522aff3c`: 6/6
  tests passed (both exact rows in both lanes plus descriptor/identity
  controls in both lanes).
- Authoritative maintained runner, narrowed only to this official cohort with
  `TEST262_PATH_FILTER_FILE` and two matching local shards:
  `TEST262_TARGET=standalone TEST262_WORKERS=2 COMPILER_POOL_SIZE=2`
  `pnpm run test:262 --official-scope-only` on `af522aff3c` — 2/2 pass, 0
  fail, 0 compile errors, 0 timeouts, 0 skips, 2 host-free passes. Results
  JSONL SHA-256
  `9de51735e322e277e31dc64876b0202ee0efb6622986192d59fa029421aab6d9` and
  report SHA-256 `a8091a34fd707ee9489f93ca39ce58faaf8ccc4bdea7cd82ca94b8abf31fa30d`.
- An unfiltered `pnpm run test:262 --official-scope-only` invocation was also
  started as a full-scope diagnostic. The two-worker local run spent over 17
  minutes in pre-existing shard-10 generator/Unicode/TypedArray failures and
  timeouts before interruption; it had not reached either #4786 row. The
  complete scoped authoritative run above is the acceptance result for this
  bounded cohort.

## Handoff

Worktree: `/private/tmp/js2-es2015-next-bounded-fix-8`.
Branch: `codex/es2015-next-bounded-fix-8`.
Source commits: `fae00a578a` (plan/claim) and `019109f311` (implementation);
current-main merges: `3f01cf7191`, then `af522aff3c`.
The branch is ready for the separate upstream PR for #4786. No WeakMap/WeakSet
instance insertion or constructor code was changed.

## Post-merge follow-up: optional Test262 corpus guard

PR #5085 (`698ecb8f1661454037eaed810cb2a6770f6acf7f`) merged the compiler
implementation and its focused regression file on 2026-08-27. The later
optional-corpus checkpoint (`2be342f92ebb108910fa451f15de86e4e37013fc`) was
not included in that merge: it is not an ancestor of the merge commit or the
current `upstream/main`. Consequently, a checkout that intentionally omits
the Test262 submodule tried to execute the four exact-row assertions against
missing files, so it could not reach the two self-contained compiler controls.

### Implementation plan

1. Detect only the optional corpus fixture
   `test262/harness/assert.js`, using a worktree-independent path derived from
   the test module.
2. Apply `it.skipIf(!TEST262_AVAILABLE)` to each of the two exact-row tables
   (host and standalone), yielding four conditional corpus assertions.
3. Keep both descriptor/identity compiler controls as ordinary mandatory
   `it` tests. Do not skip the enclosing suite or alter `runTest262File`.
4. Give the exact-row tables the same explicit 120-second Vitest budget as
   `runTest262File`; otherwise a valid standalone result can be preempted by
   the suite's 35-second default timeout under normal concurrent load.

### Follow-up evidence

- Validation source: `upstream/main` `eafd6700ac` when the focused checks ran,
  with the pinned Test262 gitlink
  `b363f29d3c43c626dc852744ad64a0b48a003693`; compiler worker count was capped
  at two. The branch was then synchronized with upstream merges
  `18785a67c6`, `0ccc264fa1`, and current `upstream/main` `63e80e3928` before
  handoff (the latter was recorded by merge checkpoint `10695cabd5`).
- Corpus present: the focused Vitest file passed **6/6** — four exact
  host/standalone rows and both mandatory controls.
- A frozen-head publication rerun reproduced a latent timeout mismatch: both
  standalone rows exceeded Vitest's 35-second default (44.2s and 36.9s) even
  though `runTest262File` already allowed 120 seconds. The follow-up now applies
  the same 120-second budget at the Vitest case boundary; final evidence below
  supersedes that diagnostic run.
- Final frozen-head publication rerun after aligning the case timeout: **6/6**
  passed in 129.53s (four exact corpus rows plus both mandatory controls); the
  standalone rows completed normally in 20.5s and 22.9s.
- Hermetic no-corpus shape (only `harness/assert.js` was temporarily moved in
  this worktree and restored): **2 passed, 4 skipped**. The four skips were
  exactly the host and standalone WeakMap/WeakSet rows; both controls ran and
  passed.
- `git diff --check` passed. The submodule remained at the pinned revision and
  is not part of the follow-up diff.

### Handoff

This follow-up changes only
`tests/issue-4786-weak-collection-tostringtag.test.ts` and this canonical
issue file. It does not change the already-merged WeakMap/WeakSet compiler
implementation, instance insertion, constructors, or the Test262 gitlink.
The focused test remains fully enforced when the corpus is present while
CI-style no-corpus checkouts still exercise the two mandatory controls.

Final follow-up branch: `/private/tmp/js2-4786-optional-corpus-guard`,
`codex/4786-optional-corpus-guard`, at fork head
verified with `git ls-remote fork refs/heads/codex/4786-optional-corpus-guard`.
PR creation was blocked by the external approval policy; the exact authorized
command is:

```text
gh pr create --repo loopdive/js2 --head ttraenkler:codex/4786-optional-corpus-guard --base main --title 'test(test262): guard optional WeakCollection corpus rows ✓' --body-file /private/tmp/issue-4786-pr-body.md
```

No Test262 submodule content or pointer is included.
