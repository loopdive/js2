---
id: 5198
title: "ES2015 standalone regexp — r2 residual pass"
status: in-progress
sprint: current
created: 2026-08-29
updated: 2026-09-13
priority: high
horizon: m
feasibility: hard
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude/fable-es2015
pr: 5296
loc-budget-allow:
  - src/codegen/regexp-standalone.ts
  - src/codegen/native-regex.ts
  - src/codegen/string-proto-match-search.ts
  - src/codegen/context/types.ts
  - src/codegen/type-coercion.ts
func-budget-allow:
  - src/codegen/native-regex.ts::ensureRegexSearch
  - src/codegen/native-regex.ts::ensureRegexReplace
  - src/codegen/native-regex.ts::ensureRegexMatchAll
  - src/codegen/regexp-standalone.ts::emitStandaloneRegExpMatchCore
  - src/codegen/string-proto-match-search.ts::emitMatchResult
  - src/codegen/regexp-standalone.ts::emitStandaloneRegExpReplaceCore
  - src/codegen/type-coercion.ts::coerceType
---

# #5198 — regexp r2: cluster and fix the residual regexp-bucket failures

## Problem

State after the 2026-08-29 session: wave 1 (#5142, part of PR #5179) plus a
second pass that yielded only +8 (PR #5213). The stopped r2 planning pass has
now been completed against exact upstream `main`
`4881206ab3001505fcfca875589aff8daf375ff9`.

The implementation branch is now based directly on upstream `main`
`a62aacba5ccc154f6fc378235aaaeeb4a7204231`, after a normal migration of the
static checkpoint on 2026-08-30. The earlier planning/census snapshots remain
isolated evidence below; the intervening upstream changes do not replace them.
The implementer must rerun Slice A on this integrated head before claiming a
fix.

The force-refreshed maintained artifacts supplied 165 ES2015 rows under
`built-ins/RegExp/**` and the String
`{match,replace,search,split}` symbol-protocol families whose standalone status
was not pass. Every row was then rerun in a fresh child process through
`runTest262File`, with two workers and the QuickJS eval adapter present. Fresh
standalone is **3 pass / 158 fail / 4 compile_error / 0 timeout / 0 skip**.
Fresh host is **126 pass / 39 fail**. Cross-lane classification is:

- 119 standalone-fail / host-pass;
- 4 standalone-compile-error / host-pass;
- 39 fail in both lanes; and
- 3 pass in both lanes.

The 123 host-pass rows are the authoritative standalone conformance delta. The
39 dual-lane failures are real regression controls, not shared-realm poison:
every row ran in a separate process. A provider fix must not hide them or make
the 126 currently passing host controls worse.

Related known defect, separate issue: the shared-realm strict-rerun regression
on `cstm-matcher-on-boolean-primitive.js` is #5200 (test-infra, not a codegen
gap). It is not part of this isolated 165-row corpus and must not be chased
here.

## Implementation Plan

### Fresh residual table

| Provider surface | Rows | Fresh standalone | Fresh host | Primary invariant |
| --- | ---: | --- | --- | --- |
| `RegExp.prototype[@@replace]` | 38 | 0 pass / 38 fail | 33 pass / 5 fail | observable RegExpExec result/coercion loop |
| `RegExp.prototype[@@match]` | 33 | 0 pass / 30 fail / 3 CE | 29 pass / 4 fail | RegExpExec loop plus runtime flags |
| `RegExp.prototype[@@split]` | 31 | 2 pass / 29 fail | 24 pass / 7 fail | SpeciesConstructor and sticky splitter loop |
| `RegExp.prototype[@@search]` | 15 | 0 pass / 15 fail | 14 pass / 1 fail | observable lastIndex save/restore and result index |
| String symbol-protocol dispatch | 15 | 0 pass / 14 fail / 1 CE | 10 pass / 5 fail | `GetMethod(searchValue, @@method)` before builtin fallback |
| RegExp constructor / regexp-like input | 8 | 1 pass / 7 fail | 3 pass / 5 fail | observable `IsRegExp`, constructor short-circuit, source/flags Gets |
| Cross-realm prototype/flag accessors | 7 | 0 pass / 7 fail | 0 pass / 7 fail | realm-correct builtin prototype identity and brands |
| `RegExp.prototype.exec` | 6 | 0 pass / 6 fail | 6 pass | observable g/y lastIndex Get/Set |
| Generic `flags` getter | 5 | 0 pass / 5 fail | 0 pass / 5 fail | generic ordered flag Gets, no receiver brand requirement |
| `RegExp.prototype.test` | 3 | 0 pass / 3 fail | 3 pass | same g/y lastIndex Set contract as exec |
| Runtime `u`-pattern syntax | 3 | 0 pass / 3 fail | 3 pass | reject restricted identity escapes in runtime compiler |
| `RegExp[Symbol.species]` | 1 | 0 pass / 1 fail | 1 pass | canonical species getter value |

The three fresh passes are
`call_with_regexp_not_same_constructor.js` and the two `@@split` undefined-
species rows. Keep them as controls; do not count them as new r2 yield.

### Implementation slices

Each completed slice is one separate mergeable upstream PR. Do not publish a
half-demotion that merely changes `compile_error` into `fail`; every claimed
row must pass the maintained runner. If a shared helper proves two table rows
are one invariant, combine only those rows and document the proof here.

1. **Slice A — observable builtin-exec lastIndex (9 rows).** Add the exact six
   `prototype/exec` and three `prototype/test` rows to
   `tests/issue-5198-es2015-regexp-r2.test.ts`. Centralize g/y lastIndex read
   and write around `emitRegexSearchCall` and `emitRegExpTestFromLocals` in
   `src/codegen/regexp-standalone.ts`: preserve the deferred raw assignment,
   perform `ToLength` at execution time, and honor the ordinary property
   descriptor/companion on Set so a non-writable `lastIndex` throws instead of
   silently mutating the struct. Reuse `__regex_search`; do not add a matcher.
   Acceptance for this PR is standalone 9/9 and host 9/9.
2. **Slice B — common observable RegExpExec substrate.** Implement one helper
   used by the four symbol methods: observable `Get(rx, "exec")`; call a
   callable override with `rx`; require Object-or-null; otherwise run the
   existing builtin exec path. Its Get/Set lastIndex behavior must reuse Slice
   A. Start with the exact invocation/error/invalid-result rows, then update
   this issue with the measured yield before rebuilding method-specific loops.
3. **Slices C1-C4 — one completed symbol-method loop at a time.** Rebuild
   `@@search`, `@@match`, `@@replace`, and `@@split` around the common helper,
   in that order of increasing surface area. Preserve observable coercion and
   error order. `@@match` must read flags at runtime rather than rejecting the
   three dynamic-flag rows; `@@replace` must read generic result properties;
   `@@split` must implement SpeciesConstructor and the sticky splitter walk.
   Existing closed static string-receiver paths remain performance controls.
4. **Slice D — String symbol-protocol dispatch (15 rows).** In the standalone
   String method dispatcher, implement the spec's `GetMethod(searchValue,
   @@match/@@replace/@@search/@@split)` and callable invocation before native
   regexp or string fallback. Close the custom-replace compile error rather
   than suppressing its diagnostic. Reuse the reified symbol-method closures;
   do not add host imports.
5. **Slice E — regexp-like constructor semantics (8-row corpus).** Implement
   observable `IsRegExp` via `@@match`, called-as-function same-constructor
   short-circuit, and ordered abrupt `source`/`flags` Gets. The already-passing
   `call_with_regexp_not_same_constructor.js` is the regression control.
6. **Slice F — generic flags getter (5 rows).** For `flags` only, accept any
   Object and perform ordered `ToBoolean(Get(R, global/ignoreCase/multiline/
   unicode/sticky))`; keep brand checks on the individual flag getters. Fix the
   shared host/open-object behavior too, since all five rows currently fail in
   both lanes.
7. **Slice G — runtime Unicode syntax (3 rows).** Tighten the emitted runtime
   RegExp compiler, not only `regex/parse.ts`, so `u` mode rejects the three
   restricted identity-escape rows with a catchable construction-time
   `SyntaxError`.
8. **Slice H — realm/species tail (8 rows).** Repair cross-realm RegExp
   prototype identity/brand handling for the seven isolated realm rows, then
   close the independent canonical `RegExp[Symbol.species]` getter row as a
   separate fix if it does not share the changed invariant.

For every slice, run the exact owned rows in isolated host and standalone
mode, the other 165 rows as a regression sweep, already-green RegExp controls,
TS5/TS7, zero-host-import assertions, formatting/lint, LOC/function budgets,
oracle/coercion ratchets, numeric-local parity, issue integrity, and the full
commit/pre-push hooks with at most two workers.

### Handoff

Planning/implementation worktree:
`/private/tmp/js2-es2015-regexp-lastindex-20260830`.
Planning/implementation branch: `codex/5198-regexp-lastindex`.
Exact candidate list: `/private/tmp/js2-regexp-r2-baseline165.txt`.
Exact owned Slice-A list: `/private/tmp/js2-regexp-lastindex9.txt`.
Fresh isolated results:
`/private/tmp/js2-regexp-r2-fresh-main-{standalone,host}.jsonl`.

### Slice A implementation checkpoint (pre-validation)

The implementation work is limited to the following nine rows, each pinned by
`tests/issue-5198-es2015-regexp-r2.test.ts` in both host and standalone lanes:

1. `built-ins/RegExp/prototype/exec/failure-lastindex-access.js`
2. `built-ins/RegExp/prototype/exec/success-lastindex-access.js`
3. `built-ins/RegExp/prototype/exec/u-lastindex-adv.js`
4. `built-ins/RegExp/prototype/exec/y-fail-lastindex-no-write.js`
5. `built-ins/RegExp/prototype/exec/y-fail-lastindex.js`
6. `built-ins/RegExp/prototype/exec/y-fail-return.js`
7. `built-ins/RegExp/prototype/test/y-fail-lastindex-no-write.js`
8. `built-ins/RegExp/prototype/test/y-fail-lastindex.js`
9. `built-ins/RegExp/prototype/test/y-fail-return.js`

The fresh isolated baseline recorded in
`/private/tmp/js2-regexp-r2-fresh-main-{standalone,host}.jsonl` is standalone
0/9 and host 9/9 for this exact slice. Static diagnosis identifies two
observable-exec gaps: non-g/y `exec`/`test` skipped the mandated
`Get(R, "lastIndex")` + `ToLength`, and g/y writeback bypassed the ordinary
non-writable descriptor state. The implementation centralizes one deferred
raw-aware read around `emitRegexSearchCall` (and the recovered-local test
helper), preserves raw values until execution-time coercion, and consults the
existing `ctx.nonWritableExternKeys` descriptor companion before strict g/y
writeback. The proof is intentionally narrow: it fires only for a statically
resolved identifier receiver whose explicit `writable: false` define was
recorded; a dynamic/recovered externref receiver has no expression-scoped
companion and declines this guard for the later common-substrate slices. No
matcher was added.

`src/codegen/regex/parse.ts` is intentionally part of this nine-row slice only
for `exec/u-lastindex-adv.js`: a lone BMP surrogate atom in `/u` mode must not
match the trail half of a valid input surrogate pair. It now lowers that atom
through the existing `CPCLASS` code-point boundary guard; the astral and
ordinary regex paths are otherwise unchanged. This is not ownership of the
broader runtime Unicode-syntax slice.

Validation and after-evidence remain pending while the authoritative census
holds both test-worker slots. The owner must rerun the exact nine rows on the
integrated current-main head, then append the measured standalone/host result
and regression evidence before claiming Slice A complete.

## Slice A completion evidence (2026-08-30)

Slice A is complete on the dedicated checkpoint worktree. The implementation
worktree is based on upstream/main `3e89b5f95318b45fd69c9cf8209da84a7a06351a`
(planning commit `3c89d8815cc9dd8fb1777de299218d33920ea1ac`, transplanted as
`05b08dff3e`), with the implementation and validation changes described below.
The umbrella issue remains `in-progress`; Slices B-H are still open.

Implementation summary:

- `emitRegexSearchCall` and the recovered-local test path now perform one
  deferred `Get(lastIndex)`/`ToLength` read for every exec/test call, including
  non-global/non-sticky expressions, and reuse that value for g/y starts.
- g/y writeback retains the raw assignment until execution and consults the
  existing statically-known non-writable descriptor companion before Set,
  preserving the required TypeError and evaluation order.
- Ref-like raw assignments use direct `extern.convert_any` so the exact RHS
  object survives `lastIndex` identity checks. A per-FunctionContext nominal-shape
  marker prevents only the later same-frame identity coercion from materializing
  a fresh `$Object`; it is not a module-wide context flag.
- The native-regex leading-literal prefilter is disabled for sticky searches,
  so it cannot advance past the sole permitted start position.
- Lone BMP surrogate atoms in `/u` patterns use the existing CPCLASS
  code-point-boundary guard and no longer match the trail half of a valid pair.

Exact nine-row command and result:

```text
PATH=/private/tmp/codex-npx2:/private/tmp/codex-pnpm10/node_modules/.bin:/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/thomas/Code/js2/node_modules/.bin:/opt/homebrew/opt/llvm@18/bin:$PATH \
JS2WASM_QUICKJS_ARTIFACT_DIR=/private/tmp/js2-quickjs-artifact-2e2d7736713beeda \
pnpm exec vitest run tests/issue-5198-es2015-regexp-r2.test.ts --pool=forks --maxWorkers=1 --minWorkers=1 --reporter=dot
```

`20 passed (20)`: host `9/9`, standalone `9/9`, plus two standalone
same-shape identity/reification controls. The standalone rows emitted zero
host imports and had zero compile errors, timeouts, or skips. The two focused
controls were also run A/B with and without the raw lastIndex assignment; both
returned the expected `8`.

The one-worker 165-row before/after sweep used the exact candidate list
`/private/tmp/js2-regexp-r2-baseline165.txt` and `runTest262File` in sequential
host and standalone lanes. Before: standalone `3/165 pass, 158/165 fail,
4/165 compile_error, 0 timeout, 0 skip`; host `126/165 pass, 39/165 fail`.
After: standalone `24/165 pass, 137/165 fail, 4/165 compile_error, 0 timeout,
0 skip`; host `126/165 pass, 39/165 fail`. There were 21 standalone
`fail -> pass` transitions (including all nine owned rows), zero
`pass -> non-pass` transitions in either lane, and zero host regressions. The
four unchanged standalone compile errors and all remaining failures belong to
Slices B-H; none are claimed by Slice A.

The existing focused controls also passed in one worker: `tests/issue-1525.test.ts`,
`tests/issue-1917-any-param-toprimitive.test.ts`,
`tests/issue-4208-ordinary-to-primitive-ir.test.ts`,
`tests/issue-3481-step3-toprimitive-field-number-hint.test.ts`, and
`tests/issue-3481-toprimitive-wrapper-unwrap.test.ts` — `5 files, 82 tests`.

Publication handoff: root replayed the planning and Luna implementation
checkpoints onto exact upstream `main` `c882d1b110`, producing planning commit
`a0f86cbaceda6e5e723f737cfc8447e88248394b` and implementation commit
`44c610a1016b1c1e413a93f14237d774e4f6d245`. The clean integrated worktree
repassed the focused matrix at `20/20`, the identity/coercion controls at
`82/82`, standalone at `24/165 pass, 137/165 fail, 4/165 compile_error`, and
host at `126/165 pass, 39/165 fail`; both 165-row sweeps had zero status drift
from the Luna checkpoint. TS5/TS7, lint, Prettier, budgets, ratchets, numeric
parity, issue integrity, and the normal pre-push hook were green.

The exact checkpoint was pushed without force to
`ttraenkler:codex/5198-regexp-lastindex-slice-a-final` and published as ready
upstream PR <https://github.com/loopdive/js2/pull/5296>. No GitHub issue was
created. The dedicated PR shepherd owns CI and merge-queue monitoring; do not
push after the PR receives a non-null queue entry. The umbrella remains
`in-progress` until Slices B-H close.

The implementation owner must use a separately provisioned worktree, update
this markdown issue with exact before/after evidence and remaining rows, push
checkpoints to `ttraenkler/js2` without force, and open a completed fix as a
non-draft PR on `loopdive/js2`. A semantically incomplete/non-mergeable
checkpoint may remain draft with explicit blockers. No GitHub issue is to be
created.

## 2026-09-12 current-census handoff: static `@@replace` / `@@match` cursor slice

This handoff supersedes the old temporary-file pointers for the next bounded
implementation slice. The planning branch is based on freshly fetched
`loopdive/js2` main `c645a7627e099173b0b3e0c5daa1d7b5a110a9d5`. The census
source is the retained authoritative standalone JSONL captured at main
`405dfb5cacac05f98aaf20d41c794034c6d9f41f`:

- artifact: `.test262-cache/test262-standalone-current.jsonl`;
- SHA-256: `45ff56e7570bba0a1bff6590d19d35de2525928adb7e3054789ba35aebb29360`;
- oracle: v13, honest standalone lane, semantic providers `auto`;
- raw/unique rows: 48,735 / 48,735;
- exact ES2015 edition-map slice: 11,704 rows, comprising 10,230 pass,
  1,144 fail, 329 compile errors, one compile timeout, and zero skips.

Under the exact non-Annex-B prefix `built-ins/RegExp/prototype/`, 238 ES2015
rows divide into 120 pass, 109 fail, and nine compile errors. The residual is
therefore exactly 118 rows: `Symbol.replace` 37, `Symbol.match` 25,
`Symbol.split` 30, `Symbol.search` 13, `flags` five, `exec` two, and six
cross-realm accessor rows. This is a census, not a claim that unrelated commits
between `405dfb5c` and `c645a762` preserve every status; the implementer must
rerun the exact A/B cohorts below on the integrated head before editing code.

The next independently bounded mechanism is the static/backend-created RegExp
global/sticky cursor loop. It excludes dynamic flags, custom `exec`, generic
result objects, species construction, cross-realm accessors, and the five
generic `flags` rows. It is independent of the generator, TypedArray, super,
and class-IsCallable workstreams.

### Slice C3a — static `@@replace` global/sticky cursor (seven owned rows)

Exact failing A cohort at the retained baseline:

1. `built-ins/RegExp/prototype/Symbol.replace/g-init-lastindex-err.js`
2. `built-ins/RegExp/prototype/Symbol.replace/y-init-lastindex.js`
3. `built-ins/RegExp/prototype/Symbol.replace/y-set-lastindex.js`
4. `built-ins/RegExp/prototype/Symbol.replace/y-fail-lastindex.js`
5. `built-ins/RegExp/prototype/Symbol.replace/y-fail-lastindex-no-write.js`
6. `built-ins/RegExp/prototype/Symbol.replace/y-fail-return.js`
7. `built-ins/RegExp/prototype/Symbol.replace/y-fail-global-return.js`

Exact passing B controls:

1. `built-ins/RegExp/prototype/Symbol.replace/g-init-lastindex.js`
2. `built-ins/RegExp/prototype/Symbol.replace/u-advance-after-empty.js`
3. `built-ins/RegExp/prototype/Symbol.replace/match-failure.js`
4. `built-ins/RegExp/prototype/Symbol.replace/replace-without-trailing.js`
5. `built-ins/RegExp/prototype/Symbol.replace/replace-with-trailing.js`
6. `built-ins/RegExp/prototype/Symbol.replace/length.js`
7. `built-ins/RegExp/prototype/Symbol.replace/name.js`
8. `built-ins/RegExp/prototype/Symbol.replace/prop-desc.js`
9. `built-ins/RegExp/prototype/Symbol.replace/not-a-constructor.js`
10. `built-ins/RegExp/prototype/Symbol.replace/this-val-non-obj.js`

Implementation plan:

1. Keep the change limited to static/backend-created RegExp receivers and
   string replacements in the direct `@@replace` path.
2. Perform the observable global initialization
   `Set(rx, "lastIndex", 0, true)` through the existing descriptor-aware guard.
3. For sticky non-global replacement, read `lastIndex` through the existing
   deferred raw/`ToLength` helper and search only at that position.
4. Write the match end after global/sticky success, write zero after sticky
   failure, and propagate non-writable-property errors in spec order.
5. Stop a global+sticky loop at its first gap. Apply `AdvanceStringIndex`,
   including the Unicode surrogate-pair rule, after an empty match.
6. Reuse `emitRegexSearchCall`, `ensureRegexReplace`, and the existing native
   search machinery. Add only a cursor-aware wrapper/helper if required; keep
   the ordinary closed string-receiver path unchanged.

### Optional same-mechanism extension — static `@@match` cursor (three rows)

Fold these rows into the same implementation PR only if the shared helper makes
them the same proved invariant. Otherwise leave them for the next separate PR.

Exact failing A cohort:

1. `built-ins/RegExp/prototype/Symbol.match/g-init-lastindex-err.js`
2. `built-ins/RegExp/prototype/Symbol.match/builtin-failure-g-set-lastindex-err.js`
3. `built-ins/RegExp/prototype/Symbol.match/y-fail-global-return.js`

Exact passing B controls:

1. `built-ins/RegExp/prototype/Symbol.match/g-init-lastindex.js`
2. `built-ins/RegExp/prototype/Symbol.match/g-match-empty-advance-lastindex.js`
3. `built-ins/RegExp/prototype/Symbol.match/builtin-failure-g-set-lastindex.js`
4. `built-ins/RegExp/prototype/Symbol.match/y-init-lastindex.js`
5. `built-ins/RegExp/prototype/Symbol.match/builtin-failure-return-val.js`
6. `built-ins/RegExp/prototype/Symbol.match/builtin-success-return-val.js`
7. `built-ins/RegExp/prototype/Symbol.match/length.js`
8. `built-ins/RegExp/prototype/Symbol.match/name.js`
9. `built-ins/RegExp/prototype/Symbol.match/prop-desc.js`
10. `built-ins/RegExp/prototype/Symbol.match/not-a-constructor.js`

The `@@match` extension has the same guarded initial Set(0), static sticky-bit
propagation, and correct stop/reset behavior. It explicitly excludes
`g-success-return-val.js`, whose remaining failure is the separate plain-array
result-shape defect.

### Acceptance and publication handoff

1. Run each exact A and B list in fresh isolated standalone and host processes
   with `scripts/run-test262-paths.mts` on current upstream main before and
   after the change. A must become all pass, B must remain unchanged, and the
   standalone cohort must have zero host imports, compile errors, timeouts, or
   skips.
2. Rerun the full 118-row current residual plus the established green
   `Symbol.match`, `Symbol.replace`, `Symbol.search`, `Symbol.split`, `exec`,
   and `flags` controls. Record every status transition; allow no pass loss.
3. Run TS5/TS7, lint/format, LOC/function/coercion/oracle/dead-export ratchets,
   numeric-local parity, issue integrity, and the complete repository hooks.
4. Update this issue with integrated-head before/after evidence and an explicit
   remaining-row handoff. Commit and push from a dedicated implementation
   worktree without force. Open one non-draft PR against `loopdive/js2:main`
   only when the completed fix is mergeable; otherwise publish a draft with
   its exact blocker. A dedicated shepherd must audit conflicts, review
   threads, CI, body/template, attribution, and readiness.

The six current `env::Object_set_constructor` species compile errors remain
owned by #4041. The five generic `flags` failures remain deferred until the
standalone open-object repeated-assignment defect has an independently viable
plan. No GitHub issue should be created for either family.

### C3a implementation checkpoint (2026-09-12; before final integration)

The bounded implementation branch starts at planning commit
`286d4ba5f22a234848783c6bdfd9f2cdd64ff327`, whose parent is freshly fetched
`loopdive/js2` main `c645a7627e099173b0b3e0c5daa1d7b5a110a9d5`.

Before editing, all 17 C3a A/B rows ran in fresh isolated child processes with
one compiler worker. Host was `17 pass`; standalone was `7 fail / 10 pass /
0 compile_error / 0 timeout / 0 skip`. The seven standalone failures were the
owned A paths listed above, while every B control passed.

The implementation keeps the ordinary closed
`String.prototype.replace`/`replaceAll` route at its existing zero-cursor
call. Only a direct, static/backend-created `@@replace` receiver now supplies
cursor inputs to the native replacement loop:

- a global receiver performs the descriptor-aware `Set(lastIndex, 0)` before
  the loop and returns the terminating zero cursor;
- a sticky non-global receiver reads the existing deferred raw lastIndex via
  `ToLength`, searches once from that position, and writes either the match end
  or zero through the existing non-writable guard;
- `g+y` uses the native sticky search on every iteration and therefore stops
  at the first gap; and
- empty global matches use Unicode `AdvanceStringIndex` for static `u`/`v`
  patterns, including a valid surrogate pair.

On this pre-integration branch, the same fresh isolated A/B rerun is `17 pass`
in host and `17 pass / 0 compile_error / 0 timeout / 0 skip` in standalone.
The standalone runner rejects a non-empty host-import manifest before
instantiation, so that pass count also proves zero standalone host imports.
Both TypeScript 5 and TypeScript 7 checks pass, as does lint; formatting was
applied to the three implementation/test files.

The optional three-row `@@match` extension is deliberately not folded in. Its
result collection still needs the separate `ensureRegexMatchAll` path and
would make cursor writeback observable across a different match-array helper;
that is not the same proved replacement-loop invariant. It remains the next
bounded handoff.

Two older Slice-A `RegExp.prototype.exec` access rows currently fail when
rerun in a fresh standalone process on the planning checkout despite the
minimal direct exec probe remaining correct. They are not reached by the
replacement helper and are recorded as an integrated-head control to remeasure
after the required merge, not claimed by C3a. Final evidence must be rerun
after a normal merge of exact upstream
`cbeffc55aaf12cd26a52fcae811d2efa224c4dce`.

### C3a final integrated-head evidence and handoff (2026-09-12)

The implementation branch was normally fast-forwarded through the requested
upstream integrations (including `cbeffc55aaf12cd26a52fcae811d2efa224c4dce`
and `d03c2248002723c01c412ec48c3b585851e38bd0`) to final exact
`loopdive/js2` main `ffb338c45b9ce26c0b430a7345f498c403d35441`; it was not
rebased or reset. That records both the planning branch point
`286d4ba5f22a234848783c6bdfd9f2cdd64ff327` (parent
`c645a7627e099173b0b3e0c5daa1d7b5a110a9d5`) and the publication head.

On that final head, `pnpm run build:compiler-bundle` passed. The exact seven A
and ten B paths were rerun in fresh isolated host and standalone processes
with one compiler worker:

- host: `17 pass` before and after; and
- standalone: pre-change `7 fail / 10 pass`, final `17 pass / 0 compile_error
  / 0 timeout / 0 skip`.

The standalone path runner rejects a non-empty host-import manifest before it
instantiates a module, so the final `17 pass` also proves zero host imports.
The exact standalone transition list is seven owned `fail -> pass` paths and
ten B-control `pass -> pass` paths; there is no pass loss in either lane.

The permanent pins are deliberately in the narrowly named
`tests/issue-5198-es2015-regexp-replace-cursor.test.ts`, rather than extending
the older Slice-A file. In one fork they pass `14/14` (the seven rows in each
lane). The small `afterEach` yield only lets Vitest drain reporter RPCs between
synchronous standalone compiles; it does not change test execution or verdicts.

TS5, TS7, lint, Prettier, `git diff --check`, LOC/function budgets,
coercion-site and oracle ratchets, dead-export check, numeric-local parity
(`18/18`), and issue integrity all pass on the final head. The LOC/function
allowances are limited to the two C3a helper functions already declared in
this issue.

The optional three-row `@@match` cohort remains deferred: its result-array
collection is still a separate `ensureRegexMatchAll` mechanism, so this
replacement-only helper does not prove the same invariant. The broad 238-row
RegExp-prototype remeasurement was begun on the earlier `cbeffc55` integrated
head but was stopped without an aggregate result when the required final
upstream advance arrived. The final `ffb338c4` validation is therefore
explicitly proportional (the exact A/B cohort and focused static pins), not a
claimed transition table for untouched residual rows.

Two pre-existing standalone controls remain outside this slice:

1. `built-ins/RegExp/prototype/exec/failure-lastindex-access.js`
2. `built-ins/RegExp/prototype/exec/success-lastindex-access.js`

They fail on final `ffb338c4` exactly as on the planning checkout, while the
replacement A/B cohort is green. They exercise `RegExp.prototype.exec` and do
not call the replacement helper; leave them to the existing Slice-A/exec
owner. No other full-residual status is inferred from this bounded fix.

### C3a publication refresh after upstream #5756 (2026-09-12)

Immediately before publication, `loopdive/js2` main advanced from the prior
`ffb338c4` publication target to
`b433de9ffe4e0c165fe65ff9d4a20bc91854cc1d` (merged #5756). The branch normally
merged that exact tip with no conflict or rebase. #5756 changes IR delay-source
admission files and has no overlap with either C3a implementation file; the
following fresh remeasurement nevertheless makes `b433de9f` the final
publication head and leaves the earlier `ffb338c4` result as intermediate
evidence only.

- `pnpm run build:compiler-bundle` passed;
- the exact isolated host A/B cohort was `17 pass` and the standalone cohort
  was `17 pass / 0 compile_error / 0 timeout / 0 skip / 0 host imports`;
- the dedicated C3a pin passed `14/14` in one fork;
- TS5, TS7, lint, Prettier, diff check, LOC/function, coercion/oracle,
  dead-export, numeric-local (`18/18`), and issue-integrity gates passed.

The two unrelated exec rows were also rechecked individually on `b433de9f` and
remain standalone `fail` with the same Test262 `SameValue` errors described
above. They are therefore residuals attributable to the pre-existing exec
path, not a status change from this replacement-only implementation.

### C3a final publication refresh after upstream #5854/#5855 (2026-09-12)

The live pre-push check then found current `loopdive/js2` main at final exact
`781915e21a1b1a71aae3b3aac7256813284af8f8`. The branch normally merged that
tip without a conflict or rebase. Its range from `b433de9f` contains the #6420
handoff document and npm-compat benchmark/website artifacts only; no compiler,
RegExp, or C3a test source changed. The `b433de9f` source-sensitive static
gates therefore remain applicable, and this final artifact-only integration
reran the proportional executable proof:

- `pnpm run build:compiler-bundle` passed;
- fresh isolated host A/B was `17 pass`;
- fresh isolated standalone A/B was `17 pass / 0 compile_error / 0 timeout /
  0 skip / 0 host imports`; and
- the dedicated C3a test passed `14/14` in one fork.

This supersedes `b433de9f` as the publication head while preserving all earlier
head evidence above. The unchanged two-row exec residual and deferred
three-row `@@match` handoff remain exactly as recorded; no broad residual
transition is inferred from the artifact-only merge.

### C3a live-PR refresh after upstream #5850 (2026-09-12)

After #5859 was published, live `loopdive/js2` main advanced to exact
`f84b3a3de56afd2f6ddd6c91a77ef407d92f4f19` through #5850. The original
implementation branch normally merged that tip as
`cd6ed08c8bb6bc3c1cadb158bc5f3e071e1d8a71`, without a conflict, rebase, or
reset. The new async-thenable lowering files did not overlap the C3a RegExp
source, but the bounded proof was rerun on that integrated head:

- `pnpm run build:compiler-bundle` passed;
- fresh isolated host A/B was `17 pass`;
- fresh isolated standalone A/B was `17 pass / 0 compile_error / 0 timeout /
  0 skip / 0 host imports`;
- the dedicated C3a pin passed `14/14` in one fork; and
- TS5, TS7, lint, Prettier, diff check, LOC/function, coercion, and oracle
  gates passed before the normal pre-push rerun.

The evidence commit `1a63c4ca6e36acc32102b4faba61cd46ad7c6944` recorded that
exact f84b handoff. The two known standalone exec residuals and deferred
three-row `@@match` cohort remained unchanged.

### C3a publication reconciliation after merged #5859 (2026-09-12)

The external queue merged #5859 as
`561b9d2003ed3e6d7bd27538437e4084f48369f0`, with parents current main
`23a0ddaa26e5db149a93e27db113dba17794c353` and the older PR head
`a58dd42412543b12ba81c0a3c4a50b6c08c97eae`. It therefore landed the C3a
implementation and dedicated pins, but omitted the later normal-merge
`cd6ed08c8bb6bc3c1cadb158bc5f3e071e1d8a71` and evidence-only
`1a63c4ca6e36acc32102b4faba61cd46ad7c6944` commits despite the PR metadata
showing that live head.

Required merge-group CI and Test262 passed for the merged #5859 snapshot. This
docs-only follow-up restores the missing provenance without changing source or
tests: the static/backend-created `@@replace` code is now landed in main, while
the two standalone `RegExp.prototype.exec` lastIndex-access residuals and the
separate three-row `@@match` cursor extension remain deferred. This is not a
claim of complete RegExp-prototype or whole-suite conformance.

## 2026-09-13 continuation plan — exact exec and `@@match` cursor residuals

The implementation branch starts at exact upstream `main`
`e0023dbbe6c37e15c1f56ed0c8bc8d15d0afbac3`. The coordinator's freshly
maintained ES2015 selection has 11,704 rows (`10,255` pass / `1,449` non-pass;
filter hash prefix `90d5e85a`), but this five-row plan is deliberately a
bounded conformance fix, not a whole-edition claim.

Fresh standalone evidence from that maintained JSONL identifies these exact
owned failures; host is the paired passing control for each:

1. `built-ins/RegExp/prototype/exec/failure-lastindex-access.js` — ordinary
   `Get(lastIndex)` invokes `valueOf`, but a later ordinary `lastIndex` read
   loses the assigned object's identity.
2. `built-ins/RegExp/prototype/exec/success-lastindex-access.js` — the same
   raw-slot identity loss after a successful non-global exec.
3. `built-ins/RegExp/prototype/Symbol.match/g-init-lastindex-err.js` — global
   `@@match` bypasses the descriptor-aware initial `Set(lastIndex, 0, true)`.
4. `built-ins/RegExp/prototype/Symbol.match/builtin-failure-g-set-lastindex-err.js`
   — the same missing global Set makes a required TypeError disappear.
5. `built-ins/RegExp/prototype/Symbol.match/y-fail-global-return.js` — the
   global match walker scans past a sticky gap and returns three matches where
   the mandated sticky cursor loop returns two.

An initial candidate tried to reuse `ctx.nonWritableExternKeys` for rows 3–4.
That metadata is compile-time rather than branch-aware: the bounded exported
`optionalWrite(flag)` probe passed on exact e002 as `false → 2, true → 2`, but
the candidate threw a `WebAssembly.Exception` for both values. An uncalled
later descriptor function alone did not throw, but the runtime-branch control
proved the static guard unsound. The rejected A/B is retained in the local
evidence log; do not ship or extend that guard.

The delivery is therefore intentionally split into three independently
reviewable PRs. The current PR claims only row 5, the sticky/global `@@match`
cursor. A later descriptor PR must solve rows 3–4 with runtime, branch-aware
property state. A third PR, from a fresh worktree after this one is published,
owns only rows 1–2 and must prove original-reference identity through aliases,
numeric overwrites, `exec` writeback, mutation in both directions, and
rebinding.

The current sticky-only delivery is limited to the native match-all loop and
its two callers:

1. Thread the statically known sticky bit into `__regex_match_all` so every
   iteration uses an anchored native search for `/gy`; the first gap terminates
   the loop. Keep the normal global scan and existing empty-match progression
   unchanged. The shared helper's dynamic `String.prototype.match` caller must
   pass its runtime sticky bit through the same ABI.
2. Add one narrowly named cursor pin for row 5 in both host and standalone
   lanes. Keep that pin small enough for the repository's default 512 MiB
   single-fork issue gate; validate ten established `@@match` passing controls
   through the maintained fresh-isolated runner manifest instead of retaining
   full-harness compilations in one fork. Add a borrowed
   `String.prototype.match.call` `/gy/` versus `/g/` pair so the second
   `__regex_match_all` caller is exercised with runtime, rather than static,
   flags.

The sticky-only PR is acceptable only if row 5 passes in both lanes, the
shared-helper controls pass, and rows 1–4 remain explicitly recorded as
non-claimed residuals. It does not close #5198 or infer a whole
RegExp-prototype/edition gain from this bounded cohort.

### Sticky-only evidence at the e002 dispatch baseline

The completed candidate keeps its evidence deliberately small and exact:

- `y-fail-global-return.js` passes `1/1` through a fresh isolated host runner
  and `1/1` through a fresh isolated standalone runner, with zero standalone
  host imports.
- Ten established `@@match` controls pass `10/10` in each fresh isolated lane.
  The checked-in three-test issue gate (the claimed row in both lanes plus the
  borrowed dynamic caller) passes `3/3` under the default 512 MiB single-fork
  configuration. A larger 27-test one-fork aggregation exhausted that heap and
  is not claimed as a passing result.
- The dynamic caller has structural WAT evidence: its runtime `RE_FLAG_Y` mask
  is read from the RegExp flags and supplied to the native match-all loop. Its
  standalone runtime controls return `2` for `/a/gy/.match("aaba")` and `3`
  for `/a/g/.match("aaba")`, so the second changed caller is not merely a
  static-pattern proof.
- Formatting, LOC/function budgets, oracle/coercion ratchets, issue integrity,
  and compiler-boundary inventory all pass locally. The 238-row ES2015
  RegExp-prototype intersection remains an authoritative-CI reconciliation,
  not a completed local cohort claim.

The candidate must still complete the normal pre-push hooks and CI at its PR
head. These baseline results are provenance, not a claim that the current
upstream integration or all #5198 residuals are solved.

### Deferred descriptor boundary

The rejected static guard does not make rows 3–4 safe to defer by adding a
branch test only around `@@match`. The later runtime-state implementation must
audit every reader and mutator that uses the existing
`standaloneRegExpLastIndexSetGuardInstrs` / `emitRegExpLastIndexWriteGuard`,
including the `exec` and `@@replace` consumers. The `optionalWrite(false)` /
`optionalWrite(true)` branch probe remains a shared acceptance control: only
the executed non-writable branch may throw.

The deferred identity delivery starts with the existing WAT proof: raw
assignment places the original closed-struct reference into the RegExp slot in
`__module_init_chunk_0`, while a later generic struct-to-`$Object` conversion
in `__module_init_chunk_1` materializes a copy. It must preserve that original
reference across the specific escaped binding boundary rather than cache a
value-copy object. No type-wide marker, raw-present-gated cache, or
shared-source-spelling policy is acceptable: aliases and already-observed
references must remain stable after a numeric overwrite or `exec` writeback.

For each delivery, run its exact rows and controls through fresh isolated host
and standalone `run-test262-paths.mts` invocations. The exact ES2015
`built-ins/RegExp/prototype/**` corpus is the 238-row intersection of the same
maintained JSONL and the checked-in `ES2015` edition map (baseline: `127 pass /
102 fail / 9 compile_error`). Under shared-worker load, publish a ready
sticky-only PR after its bounded proof and local quality gates, then reconcile
that fixed corpus through authoritative CI at the PR head; record every status
transition and allow no host or previously-passing loss. The standalone result
must have zero host imports, compile errors, timeouts, and skips for the
claimed cohort. Full TypeScript, formatting, ratchet, issue-integrity, and
repository-hook evidence remains required before publication.

## Acceptance criteria

- All 165 exact rows pass standalone with zero host imports; interim PRs pass
  every row they claim and do not lose any previously passing row.
- The 126 currently passing host controls remain green. Any of the 39 dual-lane
  failures touched by a shared provider fix pass in both lanes.
- The four current compile errors become passes, never merely runtime failures.
- Exact isolated sweeps, focused tests, equivalence checks, ratchets, issue
  integrity, and complete repository hooks are green for every completed fix.

## References

- #5142 (wave-1 plan), PRs #5179, #5213; #5200 (strict-rerun isolation).
