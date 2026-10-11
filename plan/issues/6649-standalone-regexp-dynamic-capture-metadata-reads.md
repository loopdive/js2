---
id: 6649
title: "standalone RegExp capture results: route dynamic string `index` / `input` reads through the existing physical metadata reader"
status: in-progress
sprint: current
created: 2026-09-20
updated: 2026-09-20
priority: high
horizon: s
feasibility: medium
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: regexp
goal: standalone
parent: 6648
related: [5198, 6648]
assignee: ttraenkler/codex-6648-dynamic-capture-metadata
requested_by: ttraenkler/fable-lead
loc-budget-allow:
  # The capture-only routing decision belongs at the existing vec element-read
  # dispatch seam.  Moving it would duplicate receiver/key staging and disturb
  # late-import ordering maintained by array-nonindex-key.ts.
  - src/codegen/property-access.ts
func-budget-allow:
  # The same dispatch seam keeps the capture-specific route adjacent to the
  # existing vec branches, avoiding a second receiver/key compilation path.
  - src/codegen/property-access.ts::compileElementAccessBody
---

# #6649 — standalone dynamic RegExp-capture metadata reads

## Problem and frozen residual

A standalone nonglobal capture result has physical `index` and `input` fields,
but computed string-key reads do not reach them.  The frozen witness is kept
identical across its baseline and candidate runs:

```ts
const source = /^(a)?(b)(c)$/.exec("bc");
if (source === null) return 0;
let metadataKey = "index";
let inputKey = "input";
return source[metadataKey] === 0 && source[inputKey] === "bc" ? 1 : 0;
```

The #6648 attribution triad observed the same failure on its exact #6004
parent `ae0a46be500e475e514b908361710e6ecbe563c6`, clean
`2f6c0f4f57db129c772a476345c28d85010cd175`, and the #6648 candidate: the
compiled witness returns `0`, not `1`.  Its three logs are retained at:

- `/private/tmp/js2-6648-baseline-ae0-node25-map-numeric-defined-controls-20260920.log`
- `/private/tmp/js2-6648-baseline-2f6-node25-map-numeric-defined-controls-20260920.log`
- `/private/tmp/js2-6648-candidate-node25-map-numeric-defined-controls-20260920.log`

Those receipts establish a pre-existing dynamic-key residual, not a regression
introduced by #6648.  This issue starts from fresh upstream
`3084b056fbd82bf3148395e1365834fb0ea7f422`, which does **not** contain the
unmerged #6648/#6008 numeric-capture-read repair.  It must therefore not take
credit for, depend on, or copy that repair.

## Exact source seam

`src/codegen/property-access.ts::compileElementAccessBody` recognizes
`$__regexp_match_vec` structurally as `isRegexMatchVec` (the extra field at
slot 2 is named `index`).  The ordinary dynamic-object-key branch deliberately
excludes that carrier before calling `emitDynamicVecElementGet`.  Later,
`emitDynamicStringVecElementGet` declines every standalone/WASI request, so a
computed `"index"` or `"input"` falls into numeric element lowering rather
than the capture metadata reader.

This issue does not need a new physical reader.  The existing
`array-nonindex-key.ts::emitDynamicVecElementGet` already:

1. saves the evaluated vec receiver exactly once;
2. compiles and canonicalizes the key exactly once with `ToPropertyKey`;
3. resolves `__extern_get` only after nested emission, then flushes late-import
   shifts; and
4. returns the runtime helper's `externref` result without checker-directed
   numeric coercion.

The runtime already registers `$__regexp_match_vec` as a concrete,
non-synthetic struct with physical `index` and `input` arms in `__extern_get`.
No `object-runtime.ts`, `array-nonindex-key.ts`, generic Array-property, IR,
context, or layout change is admitted here.

## Ownership and non-overlap

This branch owns only:

- the capture-specific dynamic-string routing hunk in
  `src/codegen/property-access.ts`;
- a new focused #6649 test fixture; and
- this issue record.

#5198 remains paused.  Its published/global-result work also uses
`__extern_get`, but its dirty boundaries are `native-regex.ts`,
`regexp-standalone.ts`, `index.ts`, `statements/variables.ts`, and
`string-proto-match-search.ts`; none may be edited here.  #6648's published
worktree remains frozen.  The nullable-map closure ABI and immediate-member
TypeError residuals recorded by #6648 are separate owners and out of scope.

## Implementation plan

1. Import the existing `isDynamicStringVecKey` predicate into
   `property-access.ts` and add a narrowly ordered branch for an exact
   `$__regexp_match_vec` receiver plus a string/any/unknown-capable computed
   key.  Reuse `emitDynamicVecElementGet` with the existing `compileExpression`
   callback.
2. Return the helper's result directly.  If it returns `null`, propagate that
   result rather than falling into legacy lowering: the helper may already have
   emitted receiver/key evaluation, so a fallback would evaluate user code
   twice.
3. Leave dynamic numeric and non-string keys, generic native-string vectors,
   dynamic writes, expando/prototype collision rules, and the generic
   standalone string-key classifier unchanged.
4. Add a focused fixture. `isDynamicStringVecKey` is type-fact based, not
   syntactically non-constant. Before the capture-only route, reuse the
   existing `arrayIndexConstantKey(ctx, fctx, key)` classifier: literal
   canonical array indices such as `"1"` stay on their prior positional lane,
   while literal bracket `"index"` / `"input"` and dynamic string/any/unknown
   keys reach `__extern_get`. The fixture will independently export each
   assertion so one failure cannot hide later rows:
   - the frozen dynamic `index` / `input` witness;
   - literal bracket `index` / `input` and `"1"` capture reads, documenting
     both the newly admitted metadata surface and the preserved static
     canonical-index lane;
   - direct `.index` / `.input` preservation;
   - a dynamic numeric-string capture element key (`"1"`) and a missing named
     key, preserving existing behavior rather than claiming a generic key fix;
   - capture `.length`, which must not route through the metadata arm;
   - a global `@@match` plain-vector dynamic `"index"` control, which must stay
     `undefined` rather than acquire capture metadata;
   - nonzero capture metadata, so `index === 0` cannot be mistaken for an
     element lowerer's default; and
   - side-effecting receiver and computed-key expressions to prove each
     evaluates once.

The fixture runs the same controls in standalone and host/GC modes. Only the
standalone module is required to have `imports=[]`; the host/GC control uses
the compiler-provided import object and guards against a routing regression in
the other lane.
5. Before publication, run the same frozen witness on a clean same-base
   `3084b056` checkout and on the candidate, then run the full focused fixture,
   the following maintained standalone Test262 preservation controls, TypeScript
   7, scoped static gates, and normal hooks. Report per-row counts; do not
   describe expected residual pins as semantic passes:

   ```text
   built-ins/RegExp/prototype/Symbol.match/builtin-success-return-val.js
   built-ins/RegExp/prototype/Symbol.match/g-success-return-val.js
   ```

   The first preserves a non-global capture's direct `index`, `input`, length,
   and element fields; the second preserves the global plain-array result's
   absence of `index` / `input`. Each must use the maintained one-row manifest
   runner with `--isolate --standalone`, not an ad hoc host oracle.

## Same-base focused A/B receipts (2026-09-20)

The clean baseline is the detached worktree
`/Users/thomas/Code/js2/.codex-worktrees/codex-6649-dynamic-capture-baseline-3084-20260920`
at exact source base `3084b056fbd82bf3148395e1365834fb0ea7f422`. The candidate
is this branch at the same base with only the #6649 source hunk and fixture.
The raw, strict 20-control fixture has SHA-256
`ea068b3f3a0501d3f2673975140307cd028c260941bf85f22e9ecca0b38aaa1b` in both
worktrees; the baseline copy remains unchanged as the A/B artifact.

Both runs used Node `v24.19.0`, `COMPILER_POOL_SIZE=1`,
`VITEST_FORK_MAX_OLD_SPACE_SIZE=3072`, Vitest's fork pool with
`singleFork=true` and `--no-file-parallelism`, and no `NODE_OPTIONS`:

```bash
node node_modules/vitest/vitest.mjs run \
  tests/issue-6649-standalone-regexp-dynamic-capture-metadata.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=dot
```

| source | result | receipt |
| --- | --- | --- |
| clean `3084b056` | **13 semantic pass / 7 fail** | `/private/tmp/js2-6649-dynamic-capture-baseline-3084-20260920.log` (SHA-256 `e0bee0e904401692cc17913430263a35d7e88b616d6601d5cfc68c27b1e07702`) |
| first candidate route | **17 semantic pass / 3 fail** | `/private/tmp/js2-6649-dynamic-capture-candidate-3084-20260920.log` (SHA-256 `03eac0b5ad5397870cac4e0b39d35badbbc355cf12c27b96c48b452b522bf22f`) |
| corrected candidate | **18 semantic pass / 2 fail** | `/private/tmp/js2-6649-dynamic-capture-candidate-canonical-index-3084-20260920.log` (SHA-256 `85184b0acbe4ce9351f73edfea045f6dec9da4e6c19a624e5e630d830df012b2`) |

The first candidate accidentally routed literal canonical `"1"` through the
new property path, producing the only P→F regression. The corrected hunk uses
the existing `arrayIndexConstantKey(ctx, fctx, key)` classifier and restores
that established positional lane. The retained raw receipt makes this
correction auditable rather than erasing it.

Against the clean base, the corrected candidate has **five F→P**, **zero
P→F**, and **two F→F** rows:

- **F→P:** zero and nonzero dynamic `index` / `input`, literal bracket
  `index` / `input`, a missing dynamic named key, and dynamic `length`.
- **F→F:** a dynamic string `"1"` capture-element read and a global-flat
  `@@match` dynamic `"index"` read.
- Every one of the ten host/GC controls passes in both baseline and candidate;
  the seven baseline failures and two final residuals are standalone-only.

The two F→F controls are retained as `it.fails` pins in the committed fixture,
not removed or re-expected. The final framework result is therefore expected
to be **20/20 framework passes comprising 18 semantic controls and 2 expected
standalone failures**, not 20 semantic passes. The dynamic numeric-string
capture element path belongs to the broader #6648 numeric-read follow-up (not
present on this fresh-main branch); global-flat dynamic metadata remains a
paused #5198/generic standalone string-key residual. Neither is repaired or
claimed by #6649.

## Post-sync raw verification (2026-09-20)

Before retaining those two expected-failure wrappers, the private #6649
checkpoint was noninteractively rebased from `3084b056` onto fresh upstream
`05b994b0cc5f7780cb9c7e5fc37c2b73339ba453` (which includes #6008). The
rebased source contains both the landed #6648 numeric capture-read hunk and
this issue's disjoint dynamic-string route. The strict, wrapper-free 20-row
fixture then produced **18 semantic pass / 2 fail**: exactly the same dynamic
capture `"1"` and global-flat dynamic `"index"` residuals, with no newly
masked pass or regression.

- receipt: `/private/tmp/js2-6649-dynamic-capture-raw20-postsync-05b994-20260920.log`
- receipt SHA-256: `a5a28025cc13aae64c3d3a48779a1344ebd895d8ad166746580b8df38aef8a4e`
- rebased candidate checkpoint: `e210bd5eaa83a568f3bafba809c9285b50dac1b9`

Only after this receipt were the two existing `it.fails` wrappers restored for
the final framework-level assertion run.

## Post-sync focused preservation receipts (2026-09-20)

On the same rebased `e210bd5eaa83a568f3bafba809c9285b50dac1b9` source:

- the final focused fixture passed **20/20 framework rows**: **18 semantic
  controls plus 2 expected standalone residual pins**, not 20 semantic passes;
  `/private/tmp/js2-6649-dynamic-capture-final20-postsync-05b994-20260920.log`
  (SHA-256 `56c58ebdc47fe011a5c7318e926e5c9efc8e8ca60180b86ebe7467e12638cd85`);
- the maintained isolated standalone Test262 manifest passed **2/2** with
  **0 non-pass** rows:
  `built-ins/RegExp/prototype/Symbol.match/builtin-success-return-val.js` and
  `built-ins/RegExp/prototype/Symbol.match/g-success-return-val.js`;
  `/private/tmp/js2-6649-test262-two-originals-postsync-05b994-20260920.log`
  (SHA-256 `d9d4ec3acafe5ff8122f1ff5f4a66eec8bce562707f2b669ed7a883309571ae8`).

The Test262 manifest SHA-256 is
`a0737d44d5c68e00d0ff304a180e9dbbaa2c074db8301997eaff5f1cab0755ce`.

## Static-gate receipts and paired boundary inventory (2026-09-20)

The diff-sensitive static checks passed on the rebased candidate: owned-path
Prettier, oracle ratchet, coercion-site ratchet, LOC budget, function budget,
and `check:issue-ids --against-main`. The latter receipt is
`/private/tmp/js2-6649-issue-ids-postsync-05b994-20260920.log` (SHA-256
`914be0609264b3ba3b9113833befc990fcc35a2b54c1d3d2ac1884b038284568`).

`check:compiler-boundaries` intentionally remains a repository-wide
non-green gate and was **not** relabeled or weakened for this issue. To
attribute it rather than assume, it was paired against an untouched detached
`05b994` worktree:

| source | status | inventory | receipt |
| --- | --- | --- | --- |
| clean `05b994` | `inventory-valid-architecture-incomplete` (exit 1) | valid; 1471 tracked modules, 1320 unmigrated / 146 clean / 5 compatibility-adapter | `/private/tmp/js2-6649-compiler-boundaries-baseline-05b994-20260920.log` (SHA-256 `10ffd6808c5d8ae0f4881541676a349262608fd2a5f8acc05681b5a5c3ce17bd`) |
| #6649 candidate `e210bd` | `inventory-valid-architecture-incomplete` (exit 1) | identical valid inventory and state counts | `/private/tmp/js2-6649-compiler-boundaries-candidate-05b994-20260920.log` (SHA-256 `2a2dd08ca55c3ebcbc3196c1b5a9924e37095c973e8e65329a4927a6353786f5`) |

That matched nonzero architecture-completeness state is a pre-existing
repository-wide limitation; it is retained as a failing required gate in the
publication record, not claimed as a #6649 pass.

## Current state

Issue #6649 was atomically allocated through `claim-issue.mjs --allocate`
against `upstream/main`, open PRs, and `upstream/issue-assignments` before this
file was created. The raw focused A/B, post-sync strict fixture, final
expected-failure fixture, and Test262 preservation rows above are complete.
TypeScript 7, scoped static checks, and normal hooks remain pending this
publication lease.

## #6648 follow-up context — not #6649 acceptance

The separate #6648 `map(value => value)` unmatched-capture residual is a
closure-return ABI issue, not an Array-result-carrier or dynamic-key issue.
`closures.ts` pins Array-map parameter 0 to the real nullable element at about
line 2047; its concise callback body compiles the expression around line 3317
and then coerces it to the checker-declared closure return around line 3325,
which inserts the `ref_null` to non-null narrowing. `compileArrayMap` consumes
the already compiled `closureInfo.returnType` around line 7648, so widening an
output vec cannot remove that callee trap.

Any follow-up needs separate ownership of closure inference and must establish
a sound nullable return ABI across wrapper, self-call, declaration, and body
sites, including block, conditional, and captured returns. It must not add an
identity-map peephole or a checker-only arbitrary widening. This context is
owned by #6648's residual handoff and is deliberately neither implemented nor
counted as #6649 acceptance.
