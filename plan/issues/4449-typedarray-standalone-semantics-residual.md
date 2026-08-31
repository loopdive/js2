---
id: 4449
title: "standalone: TypedArray.prototype ES6 semantics residual (~556 non-reflection tests) — species protocol, detached-buffer checks, custom-ctor paths"
status: in-progress
sprint: current
created: 2026-08-15
updated: 2026-08-31
priority: high
horizon: l
feasibility: hard
task_type: conformance
area: codegen, conformance
es_edition: es6
goal: standalone-mode
related: [4444, 2159, 2175]
active_branch: codex/4449-species-live-20260831
loc-budget-allow:
  - src/codegen/array-methods.ts
  - src/codegen/dataview-native.ts
  - src/codegen/ta-dyn-mop.ts
  - src/codegen/expressions/call-receiver-method.ts
func-budget-allow:
  - src/codegen/array-methods.ts::compileArrayMethodCall
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  - src/codegen/ta-dyn-mop.ts::fillTaDynViewMopArms
  - src/codegen/ta-dyn-mop.ts::buildStringKeyArm
---

# #4449 — TypedArray.prototype standalone semantics residual

## Problem

556 non-passing ES2015-classified standalone tests under `built-ins/TypedArray*`
remain after excluding the reflection files (`length.js`/`name.js`/
`prop-desc.js`/`not-a-constructor.js`/`invoked-as-func.js` — those are
#2159/#2175's lane). Measured 2026-08-15 (`.tmp/es6-standalone-clusters.ts`,
baseline_sha `734fab88`):

| ~Tests | Sub-bucket | Symptom |
|---|---|---|
| 55 | `speciesctor-*` | `@@species` / custom-constructor protocol not consulted (`Expected a TypeError…`, `same constructor Expected SameValue(«undefined», «true»)`) |
| 41 | detached-buffer | operations must throw TypeError on a detached ArrayBuffer; no exception thrown |
| 22 | `custom-ctor` | result-constructor selection on map/slice/filter/subarray |
| 438 | other | per-method semantics under "Testing with FloatNArray and makeArray" — validation order, `ToInteger` coercion, callbackfn protocol observability, `arraylength-internal` |

Heaviest methods: `set` (37), `map` (35), `slice` (34), `filter` (32),
`subarray` (31), `copyWithin` (27), `fill` (20), `reduce`/`reduceRight` (38).

## Implementation Plan (2026-08-25)

Work in bounded commits; do not turn the 556-file residual into one rewrite.

1. **Freeze a current cohort.** Run the standalone TypedArray path filter and
   save the result file under `.tmp/`. Partition non-passes into reflection,
   detached-buffer, species/custom-ctor, and per-method semantics. Exclude the
   reflection filename families owned by #2159/#2175 and record the exact
   denominator used for every before/after claim.
2. **Trace the native carrier once.** Start in
   `src/codegen/dataview-native.ts`, especially the `%TypedArray%.prototype`
   helpers and the shared backing-buffer window. Confirm how a view reaches its
   backing vec and how detachment is represented (`buf.length < 0`). Reuse the
   existing DataView/ArrayBuffer detached-buffer throw builders; do not add a
   host import or a second detached-state representation.
3. **Land detached-buffer validation first.** Add a shared TypedArray
   `ValidateTypedArray` entry helper and call it at each affected prototype
   method at the specification-required point relative to argument coercion.
   Use representative tests that detach before entry and during `valueOf` /
   callback evaluation so a blanket early check cannot falsely pass the slice.
4. **Implement TypedArraySpeciesCreate.** Read `receiver.constructor`, then
   `constructor[Symbol.species]`; default on null/undefined, require a
   constructor otherwise, construct with the requested length/buffer tuple,
   and verify the result is a compatible non-detached TypedArray of sufficient
   length. Thread this through `map`, `filter`, `slice`, and `subarray` rather
   than duplicating lookup logic per method. If first-class method reflection
   is truly required, leave only those exact files on #2159/#2175 and record
   evidence; do not classify ordinary species lookup as reflection by default.
5. **Close method-semantic clusters by shared algorithm.** Attack in this
   order: `set` overlap/coercion, `map`/`filter` callback and result creation,
   `slice`/`subarray` bounds/species, `copyWithin`/`fill` index coercion, then
   reduce/reduceRight empty and traversal behavior. Each commit gets a focused
   unit test under `tests/issue-4449-*.test.ts` and a before/after path-filter
   delta.
6. **Regression audit.** Run the full TypedArray filter in standalone and GC
   modes, plus the focused tests. Report new passes, losses, remaining
   failures by cluster, and reassign only proven external blockers to their
   owning issues.

Primary ownership: `src/codegen/dataview-native.ts` and new focused tests.
Coordinate before editing shared reflection/prototype-object machinery owned
by #2159/#2175 or class/destructuring files owned by #4447/#4450.

## Implementation Update (2026-08-25)

This bounded slice implements step 3 for the shared-backing static view lane.
`emitTaViewValidate` checks the backing byte vector's shared detached marker
(`length < 0`), null backing references, and fixed-view out-of-bounds windows;
auto-length views retain their live-buffer semantics. It emits a catchable
standalone `TypeError` before materialization and therefore before method
argument/callback evaluation.

The guard is wired into the ordinary array-method dispatcher and the earlier
standalone packed-carrier `map`/`filter` and scalar-HOF fast paths. The latter
were the reason a validation helper in `array-methods.ts` alone missed the
highest-yield map/reduce cases. Species/custom-constructor result allocation
remains open and is not claimed by this slice; reflection-only filename
families remain attributed to #2159/#2175.

This closes only the detached/shared-view validation slice. The parent issue
remains in progress until species/custom-constructor and remaining per-method
clusters satisfy the acceptance criteria below.

## Test Results (2026-08-25)

- `CI=true node_modules/.bin/vitest run tests/issue-4449.test.ts --pool=forks --maxWorkers=1 --minWorkers=1 --reporter=dot`
  — **4 passed**. Covers detached `map` and `reduce` callback ordering,
  fixed-view OOB after resize, and an in-bounds resize regression.
- The standalone TypedArray filter was started from this worktree as run
  `20260825-012742` using `TEST262_TARGET=standalone`, the interpreter lane,
  `TEST262_PATH_FILTER='built-ins/TypedArray'`, and 16 weighted chunks. It was
  stopped after the runner's bounded retry budget (the partial report has 886
  rows: **191 pass / 886 total, 21.6%**). It is recorded as a before snapshot,
  not an after delta: compile-timeout retries and the unsupported
  `$262.detachArrayBuffer` interpreter harness dominate this broad cohort. The
  exact ES2015 baseline remains the plan's 556-test cohort;
  species/custom-constructor failures and reflection filename families are
  still open blockers.

## Acceptance

- Sub-bucket counts above driven to zero (or re-attributed to #2175 with
  evidence) with scoped-run measurements
  (`TEST262_TARGET=standalone TEST262_PATH_FILTER="built-ins/TypedArray"`).
## 2026-08-27 Luna/max wave plan — exact species cohort

The cached ES2015 baseline joins exactly 11,704 paths. Within it, the exact
`speciesctor` cohort contains 55 rows: cached host is 45 pass / 10 fail and
cached standalone is 0 pass / 55 fail. These counts select the cohort only;
the implementation branch must rerun all 55 rows on the combined PR head before
and after its change.

1. Freeze the exact 55 paths and separate constructor lookup, `@@species`
   lookup/defaulting, abrupt completion, invocation arguments, and returned-view
   validation by row. Do not treat the shared error text as a bucket boundary.
2. Implement the narrowest shared TypedArraySpeciesCreate path used by `map`,
   `filter`, `slice`, and `subarray`, preserving lookup order and abrupt values.
   Do not touch reflection-only method metadata or detached-buffer handling.
3. Add permanent focused coverage for one success, one default-species case,
   one abrupt constructor lookup, and one incompatible returned object.
4. Rerun the exact 55 paths in host and standalone. Record every denominator,
   any losses, and residual handoff here; integrate only a net-correct proven
   slice into draft PR #5010.

## 2026-08-27 exact-cohort control and handoff

The exact cohort is frozen at `/private/tmp/js2-4449-species-55.txt` (55
non-BigInt ES2015 paths covering `map`, `filter`, `slice`, and `subarray`
`speciesctor-*`, `get-ctor-*`, and `get-species-*` cases). Fresh controls were
run from combined-PR base `114f8a95a` with
`pnpm run test:262 --official-scope-only`, two workers, and the pinned
standalone artifact directory
`/private/tmp/js2-quickjs-artifact-2e2d7736713beeda`:

| Lane | Run | Pass | Fail | Compile errors | Timeouts | Skips | Denominator |
|---|---|---:|---:|---:|---:|---:|---:|
| host | `20260827-035118` | 52 | 3 | 0 | 0 | 0 | 55 |
| standalone | `20260827-035511` | 0 | 55 | 0 | 0 | 0 | 55 |

The host failures are the two `slice`/`subarray` custom-constructor identity
cases (the ordinary array result is rejected by the TypedArray receiver path)
and the `subarray` custom invocation-arguments case. The standalone failures
are assertion failures rather than compile/runtime errors: constructor and
`@@species` getters are not observed, custom constructors receive no calls,
default results have the wrong identity, and custom result lengths/values are
not honored.

### Root cause

The standalone test262 shim passes each `TA` constructor through the dynamic
`$__ta_ctor`/`$__ta_dyn_view` carrier. `compileArrayMethodCall` currently
materializes that carrier to an ordinary f64 vector and routes `map`, `filter`,
and `slice` through ordinary vector allocation; `subarray` creates a shared
dynamic view directly. None of these producer paths performs
`Get(O, "constructor")`, `Get(C, @@species)`, defaulting, `Construct`, or
returned-view validation. In addition, the dynamic MOP's intrinsic named
`constructor` arm precedes expando lookup, so an own `sample.constructor`
override cannot reliably reach the species object. This is a shared
TypedArraySpeciesCreate gap, not a reflection-only metadata failure.

### Handoff

No source or test change is claimed in this checkpoint. Implementers should
first make dynamic-view own `constructor` shadowing observable, then add one
shared species-create helper for the four producer methods. The helper must
preserve lookup/abrupt-completion order, invoke custom constructors with the
method-specific argument tuple, reject incompatible/non-TypedArray results,
and write producer values into the returned view. Rerun the exact 55-row host
and pinned standalone controls before claiming a gain; host's 52/55 result is
the regression floor. Detached-buffer and reflection work remain out of scope.

## 2026-08-27 clean-delivery resumed species plan

This branch is the clean upstream delivery branch behind draft PR #5022.

1. Add focused dynamic-view controls for own `constructor` shadowing and
   `constructor[Symbol.species]` lookup/defaulting, including original abrupt
   value propagation, before modifying producer algorithms.
2. Implement one reusable TypedArraySpeciesCreate seam, then wire a single
   producer method first. Preserve method-specific constructor arguments and
   validate returned dynamic views before widening to the other methods.
3. Land only independently proven producer slices; keep detached-buffer,
   reflection metadata, and BigInt carriers out of scope.
4. Rerun the frozen 55-row cohort in standalone and host after every completed
   slice. Draft PR #5022 may be marked ready only when the owned implementation
   is complete, standalone is 55/55 with zero non-passes, and host is 55/55.

### 2026-08-27 dynamic constructor control checkpoint

The dynamic-view MOP now checks an own `constructor` expando before walking the
selected prototype, preserving original getter abrupt completions and explicit
own values. The focused standalone controls in
`tests/issue-4449-species-controls.test.ts` pass 5/5 with zero `env` imports:
own constructor shadowing, abrupt constructor getter, inherited constructor
getter, own `Symbol.species`, and abrupt `Symbol.species` getter. The existing
`issue-3058-dyn-view-proto-methods` regression suite remains green (11/11).

This checkpoint intentionally does not claim producer-method progress; the
55-row species cohort remains at the 0/55 standalone baseline until the shared
species-create seam is wired.

## 2026-08-27 clean-delivery producer checkpoint (partial)

The resumed branch wires one shared standalone `TypedArraySpeciesCreate` seam
for dynamic-view `map`, `filter`, `slice`, and `subarray`. It now performs the
constructor/`@@species` lookup and nullish defaulting, preserves abrupt getter
completion, invokes custom constructors with the method-specific argument
tuple, validates a returned dynamic view and minimum length, and copies the
ordinary producer vector into the species result. The dynamic MOP own
`constructor` shadow path remains in front of prototype lookup. Detached
buffers, reflection metadata, and BigInt value carriers remain out of scope.

Focused evidence from this worktree:

- `tests/issue-4449-species-controls.test.ts` plus
  `tests/issue-4449-species-producers.test.ts`: **12/12 passed**, zero
  standalone `env` imports.
- An all-nine non-BigInt-constructor pin covering custom `map`, `filter`,
  `slice`, and shared-buffer `subarray` passed **36/36**.
- Tracked source delta at checkpoint: `array-methods.ts` +318 lines,
  `dataview-native.ts` +366 lines, `call-receiver-method.ts` +13/-2, and
  `ta-dyn-mop.ts` +41/-7; the added focused producer test is 197 lines. The
  dataview addition is the single shared protocol and dynamic-kind copy seam;
  the array-method addition is the four producer-specific argument/order arms
  plus one runtime two-arm wrapper. No debug instrumentation is retained.

The exact frozen cohort remains `/private/tmp/js2-4449-species-55.txt` (55
rows). Fresh bounded runs used `COMPILER_POOL_SIZE=2`,
`--official-scope-only`, and the exact path-file filter:

| Lane | Run | Pass | Fail | Compile errors | Timeouts | Skips | Denominator |
|---|---|---:|---:|---:|---:|---:|---:|
| standalone (pinned QuickJS artifact `2e2d7736713beeda`) | `20260827-074318` | 20 | 35 | 0 | 0 | 0 | 55 |
| host | `20260827-075040` | 52 | 3 | 0 | 0 | 0 | 55 |

The standalone run is a **partial improvement only**, not an acceptance
claim. Its 35 residuals are concentrated in constructor/default identity (8),
invalid constructor/species and returned-view handling (11), custom invocation
`this`/result copying (12), and the same-buffer offset/subarray cases (4), with
method totals `map 9`, `filter 8`, `slice 10`, `subarray 8`. Host remains at
the 52/55 control floor; its three failures are the pre-existing Float64
`slice`/`subarray` custom-constructor receiver and invocation-argument rows.
Draft PR #5022 must remain draft and this issue remains in progress until a
future checkpoint reaches standalone 55/55 and host 55/55 with zero nonpasses.

## 2026-08-30 detached-buffer compile-timeout handoff

The full ES2015 diagnostic on detached source
`1f1004f3df195cc5f9e804efcbb2896d3871ca37` finished all 16 shards. A separate
runner-completeness defect (#5215) dropped 19 non-TypedArray verdicts from shard
10, so the preserved dispatch artifact contains 11,685 unique rows rather than
the selected 11,704: 8,974 pass, 2,258 fail, 447 compile errors, six compile
timeouts, and no skips. Every recorded timeout is in this issue's existing
detached-buffer family:

- `test/built-ins/TypedArray/prototype/byteLength/detached-buffer.js`;
- `test/built-ins/TypedArray/prototype/lastIndexOf/detached-buffer.js`;
- `test/built-ins/TypedArray/prototype/findIndex/predicate-may-detach-buffer.js`;
- `test/built-ins/TypedArray/prototype/every/callbackfn-detachbuffer.js`;
- `test/built-ins/TypedArray/prototype/indexOf/detached-buffer.js`;
- `test/built-ins/TypedArray/prototype/buffer/detached-buffer.js`.

The first two timings were observed while an accidental competing focused-test
pool was being terminated; the later four occurred with the census alone and
make the shared detached-buffer compile path the primary diagnosis. None of
the 19 missing #5215 rows is a TypedArray path, so the six-row list is exact for
the emitted artifact. This remains dispatch evidence, not a final regression
count.

The census has released the global two-worker lock. The current validation
lanes remain capped at one worker each; when one returns, a Luna Max handoff on
this existing markdown issue must rerun each path alone with one bounded
compiler worker, record whether compilation or strict rerun stalls, and fix the
shared lowering rather than increasing retry budgets.

## Live d60 constructor-carrier/species reconstruction (2026-08-31)

This is a repository-local markdown issue only; do not create a GitHub issue.
The current narrow port is based on exact live `loopdive/js2` main
`d60aa73f9b3405dcdc1f832a511acb2366c7de00` in
`codex/4449-species-live-20260831`. It owns only these four paths:

- `plan/issues/4449-typedarray-standalone-semantics-residual.md`;
- `src/codegen/array-methods.ts`;
- `src/codegen/builtin-static-globals.ts`; and
- `tests/issue-4449-species-producers.test.ts`.

The older recovery worktree
`codex/4449-species-recovery-20260831` at
`c39de6dac8c376482b4f2cd628e445c6d8441728` is read-only design evidence. Its
tracked `benchmarks/results/test262-report.json` mode change is a
runner-generated symlink side effect and is explicitly **not** part of this
port. Do not copy, stage, or otherwise mutate that report path.

### Preserved recovery evidence — diagnostic, not publication evidence

On the unchanged recovery head, the one-fork focused species matrix passed
**13/13**. The exact LF-normalized constructor/default eight-row manifest had
SHA-256
`619d16ee99f70d0af2969bf7951e034d6d022b1d4e4314872614a4ee0cc594cf`; its
maintained host run `20260831-175504` passed **8/8**, and its pinned-QuickJS
standalone run `20260831-175554` passed **8/8**, all with zero fail, compile
error, or skip. Both runners reconciled eight callbacks and eight verdicts.
Those results remain recovery-head evidence only and must not be promoted to
the live d60 reconstruction.

### Bounded d60 implementation plan

1. Publish a fresh builtin TypedArray constructor carrier immediately after
   allocation and before its own-property/prototype seed. Preserve d60's
   `liveBodies.add(initBody)`/cleanup ordering so late-import index repair still
   covers the detached initializer. This prevents a re-entrant native-prototype
   companion from minting a second carrier and splitting `result.constructor`
   identity.
2. Thread `skipArraySpecies` only through the three nested dynamic TypedArray
   materialized-vector re-entries (`map`, `filter`, `slice`). The outer
   TypedArray species path owns result construction; the inner ordinary Array
   lowering must produce only the f64 payload. Ordinary Array #5145 species
   lowering remains enabled, including `concat`, `splice`, ordinary vectors,
   `subarray`, detached-buffer, reflection, and BigInt paths.
3. Retain the focused TypedArray custom/default species controls and add the
   ordinary Array `map` custom-species control to prove the narrow suppression
   does not disable #5145 outside those three inner calls. Preserve standalone
   zero-`env` import assertions.
4. Before publication, replay focused tests, the exact host and standalone
   eight-row manifest, static/typecheck/hook gates, and required pre-push work
   on the exact integrated live head. Do not broaden a policy baseline or
   convert recovery results into a d60 claim.

### Current-main overlap audit and handoff

From recovery base `c39de6...` to d60, current main changes
`array-methods.ts` only in the unrelated Temporal closure-safety set near line
446. It changes `builtin-static-globals.ts` in the same initializer region by
registering both `savedBody` and `initBody` in `liveBodies`; the port must
preserve that #5239-safe bookkeeping while moving only publication order.
Neither the #4449 tracker nor focused producer test changed upstream in that
range. On the dirty d60 reconstruction, targeted `git diff --check`, Prettier,
and Biome error-level lint all exited 0; the LOC and function budget gates also
exited 0 using the existing #4449 allowance (`array-methods.ts` +70 LOC and
`compileArrayMethodCall` +24 lines). The owned-path conflict-marker inventory
is empty. No compiler, focused-test, Test262, TypeScript, hook, or policy
command has run on d60. The resulting static snapshot requires independent
review and an exact-head replay before any commit, push, or PR action.

### Root d60 focused runtime checkpoint (2026-08-31)

Root released one compiler lane and ran the two focused files serially from the
unchanged d60 snapshot with `TEST262_WORKERS=1`, `COMPILER_POOL_SIZE=1`, one
Vitest fork, and no file parallelism:

- `tests/issue-4449-species-producers.test.ts`: **8 / 8 passed** in 29.06 s
  total (12.41 s test time), including the new ordinary Array `map` species
  guard;
- `tests/issue-4449-species-controls.test.ts`: **5 / 5 passed** in 12.70 s
  total (3.63 s test time), preserving own/inherited constructor and
  `Symbol.species` lookup/abrupt behavior.

The exact current-head focused denominator is therefore **13 / 13**, and the
files' standalone zero-`env` assertions passed. One unrelated long-running
optimizer occupied the other shared lane; root did not exceed the global
two-worker limit. This is checkpoint evidence only: independent review, the
exact eight-row host and pinned-QuickJS standalone manifests, TypeScript,
hooks, pre-push checks, commit, push, and a separate non-draft PR remain
required. No GitHub issue was created.

### Root d60 exact eight-row replay (2026-08-31)

The fresh worktree initially had an uninitialized Test262 gitlink. The harness
self-controls both returned setup errors and correctly aborted before emitting
any row result; that attempt is discarded and is not counted below. Root then
attached the already-present exact repository gitlink
`b363f29d3c43c626dc852744ad64a0b48a003693` as a detached local worktree. No
corpus file was edited.

The canonical LF-normalized manifest still has SHA-256
`619d16ee99f70d0af2969bf7951e034d6d022b1d4e4314872614a4ee0cc594cf` and
contains exactly the eight recorded constructor/default rows. Both valid runs
used `TEST262_WORKERS=1`, `COMPILER_POOL_SIZE=1`, a 120 s per-row bound, the
real assembled harness, its must-pass/must-fail structural controls, and a
second execution of every row for determinism:

- host: **8 / 8 pass**, zero fail/compile error/timeout/skip/error,
  `nondeterministic: 0`, with eight callbacks and eight JSONL rows;
- standalone: **8 / 8 pass**, zero fail/compile error/timeout/skip/error,
  `nondeterministic: 0`, with eight callbacks and eight JSONL rows.

The standalone run pinned
`/Users/thomas/Code/js2/.test262-cache/quickjs-artifact-2e2d7736713beeda`;
`libquickjs.wasm` has SHA-256
`073742801ba76347371be277f6d275488badce1df6bfb480741548ec2a279d45`.
The local evidence files are `.tmp/4449-d60-host-8.jsonl` and
`.tmp/4449-d60-standalone-8.jsonl`; they are diagnostic outputs, not tracked
changes. Independent review and final quality/commit/publication gates still
remain. No GitHub issue was created.

### Pre-publication upstream advance (2026-08-31)

Immediately after the d60 review and runtime replay, live `loopdive/js2` main
advanced to `c281669805ea987c0c5c08e4681370d199b77a34`. The complete
`d60aa73f9b..c281669805` delta changes only generated benchmark/npm-compat
artifacts; it does not touch this issue's tracker, two source files, focused
test, Test262 gitlink, runner, or quality configuration. The d60 results remain
valid checkpoint evidence, but root must normally integrate c281 (or newer)
without force operations, rerun the scoped static/focused/exact-row gates on
the resulting head, and record that exact integrated SHA before publication.
No GitHub issue was created.

### c281 integrated-head acceptance replay (2026-08-31)

Root committed the reviewed four-path fix as
`dc431dd80065f1cc07b97325ea792789b1734e8c`, then normally merged exact live
upstream `c281669805ea987c0c5c08e4681370d199b77a34`. The resulting tested merge
head is `d03d77e419bfcb4e46edc1699c662b606330bb08`; its two parents are the fix
checkpoint and c281. No rebase, force, or skipped hook was used.

Exact-head results:

- focused lookup + producer files: **2 / 2 files, 13 / 13 tests passed** in
  34.71 s total (18.66 s test time), one fork and no file parallelism;
- canonical host manifest: harness positive/negative controls passed,
  **8 / 8 rows passed**, counts summed to eight, `nondeterministic: 0`;
- canonical pinned-QuickJS standalone manifest: harness controls passed,
  **8 / 8 rows passed**, counts summed to eight, `nondeterministic: 0`;
- TS7 `--noEmit -p tsconfig.ts7.json`: exit 0 with no diagnostics;
- targeted Prettier, Biome error lint, LOC budget, and function budget: exit 0;
- both fix and merge commit hooks passed. Each changed-root hook reran the
  eight producer controls successfully, and oracle ratchet reported zero net
  checker-usage growth.

The integrated row captures are `.tmp/4449-d03d77e-host-8.jsonl` and
`.tmp/4449-d03d77e-standalone-8.jsonl`; both contain exactly eight pass rows.
The manifest and QuickJS hashes remain the pinned values above. This tracker
update changes documentation only; the accepted code/test tree is exactly the
tested d03d merge. A fresh upstream-head check, required pre-push hook, remote
push, compliant PR body, and independent PR shepherd remain before
publication. No GitHub issue was created.

### Final documentation-only main sync (2026-08-31)

The last pre-push check found upstream
`207793dd444e17215db38c955ce3baaca5f85c7a`. Its sole change from c281 is the
new unrelated repository-local `plan/issues/5247-uncaught-throw-host-bare-exception.md`;
no #4449 source, test, runner, corpus, configuration, or evidence path changed.
Root merged it normally as `59bb198317da139e912cd4c98c7a7613bb759760`.
The accepted code/test tree is therefore byte-identical to tested merge
`d03d77e419bfcb4e46edc1699c662b606330bb08`; the later commits add only this
issue's evidence and unrelated upstream markdown. No GitHub issue was created.

### Fresh live-main sync before publication (2026-08-31)

Root freshly fetched `loopdive/js2` main at
`932341cc7d01547bf6b0065d766a31cdf3478d9f`. The complete incremental
`207793dd444e17215db38c955ce3baaca5f85c7a..932341cc7d01547bf6b0065d766a31cdf3478d9f`
range changes only nine generated landing benchmark artifacts. It has no
overlap with this tracker, either #4449 source file, the focused test, the
Test262 runner or gitlink, quality configuration, or the accepted evidence
artifacts.

The completed branch normally merged that exact upstream head as
`87cd03f8c3efe9ca989ac43052d3c0ddb5882aba`. Its #4449 code/test tree is
byte-identical to the fully tested `d03d77e419bfcb4e46edc1699c662b606330bb08`
checkpoint, and the pull-request diff remains exactly this tracker, the two
source files, and the focused producer test.

The first local pre-push invocation stopped before validation because this
worktree had an incomplete generated `node_modules` tree without the
`typescript7` package link. Root preserved that ignored tree under
`.tmp/4449-node_modules-incomplete-20260831`, installed the standard
worktree-to-root dependency symlink, and reran the unchanged hook without a
remote write or gate bypass. On checkpoint
`96ebf11e93eb90bcd8460b2e437c5c681acbbd25`, the complete hook passed:

- TS7 typecheck and lint passed in parallel;
- repository-wide Prettier `format:check` passed;
- oracle and coercion-site ratchets both reported zero net growth;
- numeric-local IR parity passed **18 / 18**; and
- conformance synchronization made no tracked change and issue integrity
  passed.

This documentation commit is followed by one final unchanged pre-push replay
so the eventual publication SHA, rather than only the preceding evidence SHA,
is verified. Remote publication remains blocked by the execution environment's
external-destination safeguard until the user explicitly authorizes pushing
the completed branch to the configured public `ttraenkler/js2` fork; no push
or pull request has been attempted around that guard. No GitHub issue was
created.

## Live-main integration plan — 2026-09-01

The completed #4449 checkpoint is clean at
`2ae828c69708179679cc13ae7bbe63583667824f`. Current shared
`upstream/main` is `a4d141321daf7f8874e540d7b75f58f8c3e2c2a7`, five commits ahead of merge
base `932341cc7d01547bf6b0065d766a31cdf3478d9f`. The complete upstream delta is
limited to npm/Test262 benchmark mirrors and `scripts/loc-budget-baseline.json`;
it has no direct overlap with this issue's tracker, two implementation sources,
or focused test.

Before integration, refresh `loopdive/js2:main` once more and re-audit that
boundary. Use a temporary worktree-only `.prettierignore` block for the four
public/website Test262 report mirrors so the normal merge hook cannot reformat
generated upstream bytes into this four-path PR. The block must be applied and
removed with `apply_patch`, never staged or committed. Merge with `--no-commit`,
run the complete normal attributed commit hook, remove the guard, and prove the
PR range is again exactly four intended paths with no benchmark or `labs/`
leakage.

Then serially repeat the focused **13/13** suite, the exact species-producer
host **8/8** and standalone **8/8** manifests with deterministic path/row
reconciliation, TS7/typecheck, and the complete synthetic-ref pre-push hook on
the actual final HEAD. Stop on any regression or generated-path leak. No push
or GitHub mutation is authorized by this plan; publication remains blocked on
explicit permission to push the completed branch to the public
`ttraenkler/js2` fork for a non-draft PR against `loopdive/js2:main`.

### Live-main integrated validation handoff — 2026-09-01

The plan commit is `c9a661d5d2`; its normal hook passed the producer matrix **8
/ 8**, the exact LOC/function grants, and the zero-growth oracle ratchet. Fresh
fetch still resolved live main to
`a4d141321daf7f8874e540d7b75f58f8c3e2c2a7`. The attributed merge is
`9eaf563d934bdf25520a3a2b4611f10e02c2fb4f`; its unskipped hook repeated the
same gates and producer **8 / 8** result.

The temporary four-path Prettier guard was never staged or committed and was
removed immediately after the merge. `.prettierignore` is byte-identical to
`HEAD`; `git diff upstream/main...HEAD` contains exactly this tracker, the two
implementation sources, and the producer test, with no benchmark, public,
website, or `labs/` path.

The integrated one-fork replay of the unchanged five lookup controls plus the
eight producer controls passed **2 / 2 files and 13 / 13 tests** (19.79 s
total, 10.03 s test time). One serial host harness process then passed the
mandatory must-pass/must-fail controls and all **8 / 8** exact rows, with total
`8` and `nondeterministic: 0`; its artifact is
`.tmp/4449-a4d-host-8.jsonl`. The pinned-QuickJS standalone process repeated
the structural controls and passed **8 / 8**, total `8`,
`nondeterministic: 0`, writing `.tmp/4449-a4d-standalone-8.jsonl`.

Both artifacts contain exactly eight distinct requested paths, eight callbacks,
and only `pass` rows in their respective target. Their LF-normalized sorted
manifest SHA-256 is the canonical
`619d16ee99f70d0af2969bf7951e034d6d022b1d4e4314872614a4ee0cc594cf`.
Standalone used the pinned QuickJS artifact whose `libquickjs.wasm` SHA-256 is
`073742801ba76347371be277f6d275488badce1df6bfb480741548ec2a279d45`.
Direct TypeScript 7 exited **0** with no diagnostics.

This handoff note must pass the normal commit hook, after which the complete
synthetic-ref pre-push hook must pass on the actual final HEAD. No push or
GitHub mutation has occurred; explicit public-fork authorization remains the
only publication-permission blocker.
