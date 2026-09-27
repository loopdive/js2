---
id: 5198
title: "ES2015 standalone regexp — r2 residual pass"
status: in-progress
sprint: current
created: 2026-08-29
updated: 2026-09-20
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
  - src/codegen/index.ts
  - src/codegen/statements/variables.ts
  - src/codegen/context/types.ts
  - src/codegen/type-coercion.ts
  - src/codegen/tonumber-fast-paths.ts
  - tests/issue-5198-toprimitive-object-carrier.test.ts
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

## 2026-09-20 wrap-up handoff — Annex B compile syntax

This section records an unfinished implementation, subsequently published as
draft [PR #6014](https://github.com/loopdive/js2/pull/6014), head
`5cc07c7dd33eea2830cfac7fdcb5faf8eb27dea2`. This handoff PR changes
documentation only and does not mark the RegExp umbrella complete.

- Current candidate worktree:
  `/Users/thomas/Code/js2/.codex-worktrees/codex-5198-annexb-syntax-on-main-20260920`,
  branch `codex/5198-annexb-syntax-on-main-20260920`, based on
  `ac76d8c6cd63864e04de4592a5179050ff1b1f91`. The older
  `codex-4444-annexb-regexp-compile-audit-20260920` worktree is preserved.
- Only the 50-line direct `RegExp.prototype.compile` syntax guard was
  reconciled onto the newer source, alongside the complete 12-control test
  and an appended issue plan. The incoming global-match changes were retained;
  the direct compile function itself was unchanged upstream. No IR, layout,
  or `expressions.ts` change was made.
- Production file SHA256:
  `243d13a6230714cfee2420fb64e1b6f7c68c208be1f90b3537671a8700b462f9`.
  `tests/issue-5198-regexp-compile-syntax.test.ts` SHA256:
  `872287be75fd47de8b0fdb9b6e27c32802af44a279237212b416b5b4d65cf871`.
- Current ac76 candidate compact run: **8P/4F**. Both lanes retain failures
  for shadowed `undefined` and abrupt receivers. The standalone abrupt case
  refuses a RegExp value not created by the backend; the other three return
  wrong values. Invalid-pattern state preservation, receiver evaluation, and
  valid-but-unsupported poison controls pass. Candidate log:
  `.tmp/5198-annexb-compile-syntax-candidate-ac76-rerun-20260920.log`.
  An earlier missing-dependency attempt ran no tests and is setup evidence only.
- The new clean-ac76 baseline fixture is prepared but **not run**. Historical
  f352 comparisons were compact **6P/6F to 8P/4F** and four originals
  **2P/2F to 4P/0F**; do not substitute those for a current paired comparison.
- The exact 20-file goal subset is frozen at
  `.tmp/5198-annexb-compile-es2015-20.txt`, SHA256
  `67d0af1ee37b488d35ff76dd543c02021f58b7092e4d65a95529cce8536ebef3`.
  It is the verified directory intersection of the frozen 11,778-file ES2015
  manifest (SHA256 `f2fdd4e4544a44608f0b53d89d343526cfa9c9044ca263e860da949dc1a2f59f`)
  with corpus `b363f29d3c43c626dc852744ad64a0b48a003693`; all paths exist.

On resume: first complete the byte-identical current compact A/B, then run
`tests/issue-4439.test.ts` and the frozen original paths with the maintained
isolated standalone runner. The current poison suite, original-four rerun,
and full20 A/B remain unrun. Preserve all raw failures; obtain ownership
clearance before any `expressions.ts` fix for shadowed undefined. Do not touch
the separate old strict-nonglobal #5198 worktree whose extraction awaits
approval. Before marking the checkpoint ready, finish the missing validation
and repair the residuals; never claim focused checks establish 100% ES2015
conformance. Checkpoint publication used the repository-sanctioned fast
pre-commit mode after the full hook reproduced the recorded 8P/4F result.
Mandatory pre-push typecheck, lint, formatting, oracle/coercion ratchets,
numeric-local regression tests (18/18), and issue integrity passed. The raw
expectations were not weakened. Publication readback was draft and behind main.

Completed adjacent work is already in upstream PRs #6007, #6008, #6009, and
#6010. The validated dynamic capture-index slice is in ready PR
[#6012](https://github.com/loopdive/js2/pull/6012), head
`58cd381ff24e580c55f9c2449aba74b591a75e24`; its local gates passed, with
69 semantic fixture passes, four explicit expected failures, and two original
Test262 preservation passes. The subsequent user-requested shepherd read
confirmed it clean and mergeable, with all active CI checks successful and no
unresolved review threads. A subagent performed that one-shot audit, but this environment has no webhook
subscription tool; no polling, enqueueing, or merging is scheduled.

The last complete goal census remains **10,377/11,778** at `f3520ca177`.
These subsequent focused fixes are not a replacement full census. All local
test processes were terminal at wrap-up; implementation work stops here until
requested again.

## 2026-09-20 global `@@match` plain-array result-shape follow-up

### Scope and original evidence

This follow-up is isolated in
`/Users/thomas/Code/js2/.codex-worktrees/codex-5198-global-match-result-shape-20260920`
on `codex/5198-global-match-result-shape-20260920`, created from upstream
`62221769a87acdc32759c656702eede64936feb5`. It is deliberately separate
from the completed String normalization candidate and from the active #5198
nonglobal subject-coercion lane.

The owned original is
`built-ins/RegExp/prototype/Symbol.match/g-success-return-val.js`. The latest
#5198 candidate receipt is
`.tmp/5198/original-190-standalone-isolate-candidate-after-postlock-carrier-20260920.log`:
the 190-row run is `99 pass / 84 fail / 7 compile_error`, and this original
fails its final `result.index === undefined` assertion with actual `0`.
Its preceding `hasOwnProperty(result, "index") === false` assertion has already
passed, so this is evidence of a typed property-read leak rather than proof
that the generic own-property reflection path exposes an own descriptor.
The original's top-level binding is:

```js
var result = /.(.)./g[Symbol.match]("abcdefghi");
```

No compiler, test, build, or hook was run from this worktree before this plan.

### Source diagnosis and source-only implementation checkpoint

Before this patch, `native-regex.ts::ensureRegexMatchAll` used
`$__regexp_match_vec` as its result carrier solely to unify it with a
nonglobal capture result. It records `FIRSTMS` and `SUBJ`, then constructs
the subtype's `index`, `input`, `groups`, and `indices` fields
(`native-regex.ts` pre-patch global-all body). This contradicts the global branch of
RegExp.prototype[@@match], which returns a plain Array of full-match strings;
it must have no result metadata.

The static direct producers both consume that helper:

- `String.prototype.match(re)` through
  `regexp-standalone.ts::emitStandaloneRegExpMatchCore` at 4177-4253; and
- `re[Symbol.match](str)` through `tryCompileStandaloneRegExpSymbolCall` at
  4872-4925, which calls the same core.

The specialized result reader had a second independent error:
`tryCompileStandaloneRegExpMatchResultRead` used a static
`RegExpExecArray`/`RegExpMatchArray` checker type as its route and blindly
`ref.cast` every ref receiver to `$__regexp_match_vec`. A base native-string
vec must not be treated as a capture result merely because it is statically
typed as a match array. Returning a statically typed numeric fallback is also
wrong: the generic reader's `undefined` would become `NaN` during a later
checker-directed coercion.

The prepared patch fixes both boundaries without adding a parallel descriptor
reader. `ensureRegexMatchAll` now constructs the ordinary native-string base
vector; `exec`, non-global `match`, and `matchAll` retain the capture subtype.
For `.index` / `.input` / `.groups` / `.indices`, the specialized front-end
reader now returns the canonical `__extern_get` result as `externref`. The
existing runtime helper already distinguishes `$__regexp_match_vec` through
its concrete field arms, then lets plain vectors reach their sidecar and
Array/Object-prototype lookup. This preserves a capture's real metadata,
exposes a pristine global result's canonical `undefined`, and leaves ordinary
global-vector expandos/prototype values observable. It also guards a nullish
receiver with a catchable TypeError before the property lookup. No checker
annotation is used as a runtime brand.

### Coordinated implementation plan

User clearance covers the following narrow, non-IR source set. No
`declarations.ts` change is planned: its module-global chooser already delegates
to `inferStandaloneRegExpMatchGlobalType` and can consume that helper's revised
return type.

1. **`src/codegen/native-regex.ts`** — make `ensureRegexMatchAll` return the
   ordinary native-string vector (`{ length, data }`), removing the
   first-match metadata construction only from this global-all helper.
   `ensureRegexCaptureArray` and `ensureRegexMatchAllArrays` stay on the
   `$__regexp_match_vec` capture subtype.
2. **`src/codegen/regexp-standalone.ts`** — preserve the output distinction in
   the two static direct producers; classify direct global vs capture calls;
   revise module-global match-result inference to use the common base vector
   when all allowed writes are backend match producers/nullish; and replace the
   static-type-only result metadata reader with an exact provenance gate plus
   the existing runtime `__extern_get` field/vec dispatch. This must not turn
   arbitrary checker-asserted arrays into global matches.
3. **`src/codegen/index.ts`** — update the authoritative function-local
   let/const pre-hoister (`nativeStringVecTypeForStandaloneRegExp`,
   `inferStandaloneRegExpMatchArrayType`, used at 14946) so a global direct
   `match`/`Symbol.match` binding is allocated as the base string vector,
   while `exec` and non-global `match` keep the metadata subtype.
4. **`src/codegen/statements/variables.ts`** — keep declaration lowering and
   the var retype rule in lockstep with that pre-hoister, including the missing
   computed `Symbol.match` inference. This is necessary for local `var`,
   `let`/`const`, and alias paths; it is not a broad annotation override.
5. **`src/codegen/string-proto-match-search.ts`** — required consumer of the
   shared helper. Its runtime-flag reflective `String.prototype.match` body
   currently has an `if` whose global and nonglobal arms are both declared as
   match-vec. After the global helper returns the base vec, each arm must be
   converted at the external boundary rather than downcasting the global
   plain-array value. This preserves the reflective dynamic `/g/` versus
   non-global capture distinction.

No context-type, declarations, IR layout, or generic object/property runtime
change is admitted by this plan. If exact provenance cannot be represented
inside the listed source set without a new context registry, stop and request
that narrower ownership rather than accepting a checker-type-only shortcut.

### Focused acceptance design (source preparation; unrun)

A new focused #5198 fixture will use actual standalone compilation and assert
an empty Wasm import section before instantiation. It will cover:

- the exact original's top-level `var` `re[Symbol.match](str)` path;
- direct `str.match(re)` and `re[Symbol.match](str)` global results at a
  nonzero first position, with elements/length retained but `index`, `input`,
  `groups`, and `indices` absent/`undefined`;
- function-local `var`/`let`/`const` and an alias of each admitted global
  result, ensuring no hoister-slot cast recreates metadata;
- null no-match for both direct callers;
- non-global `match`/`Symbol.match` and `exec` positive controls retaining
  their actual index/input/capture metadata;
- reflective `String.prototype.match.call` with runtime `/g/` and non-global
  receivers, preserving the same flat/capture distinction;
- global lastIndex reset/control behavior; and
- both caller families' zero-import proof.

The prepared fixture observes property absence separately from a direct value
read, and its exact/direct/top-level/local/mixed cases deliberately avoid
`: any` so a `RegExpMatchArray` checker annotation cannot hide the
`undefined`-to-`NaN` route. It also covers a match-producing binding read while
it still holds a capture before a later foreign reassignment, and a null capture
result whose metadata access must throw TypeError. The assignment,
`defineProperty`, and inherited-Array-prototype metadata cases are retained as
ordinary-reader probes; if any is unsupported on the untouched base, it must be
reported as a paired baseline limitation rather than silently relabeled as a
conformance result. The fixture remains unrun until the exclusive compiler/test
lease is granted.

### Handoff state

The source-only patch is now confined to the approved five implementation
files plus the focused fixture and this issue record. It includes full
declaration write-set joins for local/global result-slot inference: a
capture-only binding gets the capture subtype, while a global or mixed binding
gets the base vector; unknown/foreign writes decline concrete-slot inference.
A separate candidate gate permits the ordinary runtime reader for a binding
that started as a native result but later widened, so a currently held capture
still reaches the helper's physical metadata arm. No compiler, test, build, or
hook receipt had been taken at that source-only checkpoint. The #5198 nonglobal
subject-coercion owner remains independent; this work neither edits nor
subsumes that lane.

### Bounded post-patch measurement receipts (2026-09-20)

The source-only checkpoint above was measured before any upstream sync on
working base `ea8d7f87ff6799b2bbdcb648f761ad162b5e4bf3`. The candidate has an
uncommitted scoped diff; it is not itself a commit at that SHA. The one-row
manifest has SHA-256
`cb3c22547da83fc173fd6085d7efad9ac8c481592e0ea56190b47bdf9948b352` and
contains only the owned original.

With Node 24, `COMPILER_POOL_SIZE=1`,
`JS2WASM_ROW_TIMEOUT_MS=120000`, `--isolate`, and `--standalone`, the patched
candidate is **1 pass / 0 non-pass** for
`built-ins/RegExp/prototype/Symbol.match/g-success-return-val.js`. The first
attempt caught and fixed a narrow missing import:
`ensureObjectRuntime` was referenced by the new canonical-reader wrapper but
was not imported from `object-runtime.js`. That failed receipt is retained as
`original-g-success.log`; the corrected authoritative receipt is
`original-g-success-rerun.log`.

A clean detached worktree at the same `ea8d7f87` base, with no patch source,
ran the identical manifest/options and is **0 pass / 1 fail**. Its only
failure is the original assertion that `result.index` must be `undefined`,
with actual `0`:

```text
Expected SameValue(«0», «undefined»)
```

This establishes a same-base one-row gain; it is not a broad #5198 or ES2015
claim. The candidate and baseline logs are respectively
`.tmp/5198-global-shape/original-g-success-rerun.log` and the detached
worktree's `.tmp/5198-global-shape/original-g-success-base-ea8d.log`.

The import-free focused candidate fixture then completed with **1 file / 4
tests passed**. It covers the exact unannotated global `@@match` shape,
direct/top-level/local/alias/mixed result carriers, reflective dynamic global
and nonglobal match, null/no-match and lastIndex controls, plus ordinary
assignment/`defineProperty`/prototype metadata probes. Each compiled module
asserts `WebAssembly.Module.imports(module) === []`. Receipt:
`.tmp/5198-global-shape/focused-full-four.log`. The earlier relative-Vitest
entrypoint lookup failure is retained separately as setup evidence and was
not interpreted as a test result.

Implementation file hashes before the required formatter pass are:

```text
77e6d70cfcaddcd44bee7d84d18e6909cc98217891a7ce78925540be2ca75e8a  native-regex.ts
5500de08b80fc812bf864c5cc00aac4d3f9b7d41c43832a61e7bad2bf4019f7a  regexp-standalone.ts
4f168d3d23eaf52570bf897f1aaed031d62c4f9762ed5967a18cbbf627aa9e75  index.ts
4ad0e54ba6eb1bef616e011a3842cb7a682522d6ea84e9fbef2b48047c66663d  variables.ts
c2392a4baed16369d64916985511bfd03304a1b89707d2db7af30265a806e0ff  string-proto-match-search.ts
4d931222352f97d9a1a5cc8e317a32af5771b71325981146753e0a6f9527b95e  issue-5198-global-match-result-shape.test.ts
```

Before publication the branch must safely merge `upstream/main` at
`ae0a46be500e475e514b908361710e6ecbe563c6` and repeat proportionate scoped
validation. Its source changes since `ea8d7f87` are only the independently
owned `carrier-bag-delete.ts` and `iterator-native.ts` lanes; this is a
non-overlap inventory, not a substitute for revalidation.

The next bounded blast radius is deliberately limited to the relevant existing
groups in `issue-4439.test.ts`,
`issue-5198-es2015-regexp-match-cursor.test.ts`, `issue-1914.test.ts`,
`issue-1913.test.ts`, and `issue-2161-regex-symbol-protocol.test.ts`, plus six
frozen originals: global `g-success-return-val.js`, nonglobal
`builtin-success-return-val.js`, `builtin-success-return-val-groups.js`,
`g-zero-matches.js`, `exec-return-type-valid.js`, and
`String/prototype/match/invoke-builtin-match.js`. No broad default suite is
authorized by this receipt. The existing-test command is a single-fork direct
Vitest invocation over only those five files; the original command uses the
six-line manifest above with the maintained `run-test262-paths.mts --isolate
--standalone` runner and the same Node 24/pool/timeout environment as the
one-row A/B.

### Post-sync semantic receipt (`ae0a46be50`, 2026-09-20)

The dirty scoped branch fast-forwarded cleanly to
`ae0a46be500e475e514b908361710e6ecbe563c6`; no stash or conflict resolution
was needed. The five implementation hashes and the focused-fixture hash above
were unchanged by that upstream sync. The six-row manifest was then rerun with
the same Node 24 standalone/isolate runner settings:

```text
candidate: 4 pass / 2 fail / 0 skip
```

The four passing rows include the owned global plain-array original. The two
non-passes are **not** counted as green or hidden: they are
`Symbol.match/exec-return-type-valid.js` (overridden `exec` identity) and
`String/prototype/match/invoke-builtin-match.js` (RegExp receiver identity).
A clean detached `ae0a46be50` baseline ran those exact two paths with the
identical options and failed with the identical assertion messages. They are
therefore recorded as known baseline residuals outside this global-result-shape
patch, not repaired or weakened here. Candidate receipt:
`.tmp/5198-global-shape/post-sync-six-originals.log`; clean baseline receipt:
`post-sync-red-originals-base-ae0.log` in the detached comparison worktree.

The narrow existing regression slice completed **5 files / 58 tests passed**:
`issue-4439`, `issue-5198-es2015-regexp-match-cursor`, `issue-1914`,
`issue-1913`, and `issue-2161-regex-symbol-protocol`. The post-sync new
fixture also completed **1 file / 4 tests passed**, retaining import-free
module assertions. Receipts are
`.tmp/5198-global-shape/post-sync-existing-regression-controls.log` and
`.tmp/5198-global-shape/post-sync-focused-full-four.log`.

This is a bounded no-regression receipt: original coverage is accurately
**4 pass / 2 known-baseline failures**, plus the separately paired one-row
gain and focused controls. It is not a full #5198 regression or conformance
claim. Remaining publication work is TS7/style/issue-budget gates and the
normal commit/pre-push hooks.

### Final pre-commit gate receipt (2026-09-20)

Prettier reformatted only `index.ts`, `regexp-standalone.ts`,
`variables.ts`, and `string-proto-match-search.ts`; it made no intended
semantic edit. The initial post-format four-control fixture remains green
(`post-format-focused-full-four.log`). A final fifth control then verified
capture metadata across both a `RegExpExecArray` typed function parameter and
a `matchAll` iterator entry; its targeted receipt is
`typed-param-matchall-control.log`, and the final full fixture is **5/5
passed** (`final-focused-full-five.log`).
TS7 and full Prettier check are green. Repository-wide Biome exits zero but
caps 1,868 unrelated diagnostics, so the meaningful owned receipt is the
changed-file Biome invocation: **6 files checked, no diagnostics**. The LOC,
function-budget, oracle, coercion-site, pushRaw, and issue-integrity gates all
pass. The budget gates grant only the existing #5198 scoped allowances
(`regexp-standalone.ts`, `string-proto-match-search.ts`, and
`emitMatchResult`).

Final implementation/test SHA-256 values are:

```text
77e6d70cfcaddcd44bee7d84d18e6909cc98217891a7ce78925540be2ca75e8a  native-regex.ts
6102ad02ad1cfdf6674518ac9b7c3f0077fec3d2d5b72ff5a1b7b53e19aa0337  regexp-standalone.ts
4a10e019ac887ac70a8409746a9b23e05836edf792db6631cb05895c8881deeb  index.ts
a37cc3802aae447f48dafe95a3b0f8f8ba32682a6d35bbc35aefc81ad5f33ddf  variables.ts
c5693b98643b86fb248313b285604bd2b24d9da4e9e88cfebda711178e9d57e6  string-proto-match-search.ts
25042e0be2e55994232091990803c1518730e0b75cc8f0b3fa7653aab4a52529  issue-5198-global-match-result-shape.test.ts
```

## 2026-09-20 upstream sync and declaration-slot diagnostic

The frozen 190-original candidate run is now terminal: **99 pass, 84 fail,
7 compile errors, zero skips** (190 total; 91 enumerated non-pass rows).
Candidate-local maintained runner, standalone, fresh process per original,
Node 24, unchanged manifest SHA-256
`567987a2f7b705a318ce45a003c5bd8e05543a2b2da5718b6ab73dc430105890`.
Receipt: `.tmp/5198/original-190-standalone-isolate-candidate-20260920.log`.
Process exit 0 is not conformance success; the counts above are authoritative
for this scoped run. The matching untouched-main 190 run remains pending,
so do not infer gains or regressions from historical cohort totals.

Baseline setup correction: the first launched baseline command used the
coordinator CWD without the corpus redirect, although that worktree's
`test262/` directory is empty. Its eventual output is invalid tooling, not
test failures. Preserve it separately and do not compare it to the candidate.
The valid retry must reproduce the prior base-nine arrangement: physical
candidate-worktree corpus as CWD, absolute coordinator runner/compiler path,
absolute frozen manifest, and inherited
`NODE_OPTIONS=--require /private/tmp/js2-5152-coordinator-test262-redirect-20260920.cjs`
for coordinator-relative harness reads. The preload changes only readFileSync,
not directory discovery. A fresh parent/child read-only control confirmed
the first original file matches the physical corpus byte-for-byte (767 bytes,
SHA-256 `e73c725992eedbe1bc513ee76d21c4158ce00331a967095d1f1426896821c43a`).
This file-read check is not a substitute for runner verdicts.

Fresh `git fetch upstream main` and independent `git ls-remote upstream
refs/heads/main` agree on `4a6cbdf1ee80b5d1618a7c87b014bc792f0fddc7`,
also the coordinator and protocol candidate base. No merge or stash is needed;
all uncommitted work remains intact.

The candidate-local split diagnostic
`.tmp/5198/result-boundary-probe-split-20260920.log` reports valid Wasm with
no imports: direct match and lastIndex identity checks pass, while saving
either value in a declaration initializer fails. Emitted saved-local types
are a nullable match-result struct and `f64`, respectively, not `$AnyValue`,
despite explicit `: any`. The writer's second diagnostic
`.tmp/5198/local-slot-probe-20260920.log` reports the same initializer failures
but passing identities when assignment follows a separate `let snapshot:any`
declaration; those locals are `externref`.

Implementation plan: identify the declaration-initializer/preallocation rule
that selects the narrowed representation, coordinate the exact ownership seam
with the parallel IR migration, and add focused initializer-versus-assignment
regressions before changing that rule. Do not expand the generic boxing adapter
based on these failures: these receipts identify a different transport path.
These diagnostics do not establish any additional Test262 pass-rate gain.

Follow-up kill-switch evidence from the writer: disabling either usage
inference or numeric-local specialization changes the saved lastIndex local
from `f64` to `externref` and restores its identity. Saved match remains a
native-result reference and still fails. Source inspection separates the
causes: `numeric-property-analysis.ts` accepts an oracle numeric fact before
syntactic proof, while `index.ts::inferStandaloneRegExpMatchArrayType` treats
computed `Symbol.match` as a native vector result. Its variable-declaration
counterpart does not include that computed-key branch.

Do not fix this with a blanket annotation override: that could bypass required
typed-array view and fresh-factory representation rules, and Test262 inputs
are unannotated JavaScript. Next acceptance evidence must include unannotated
initializer/assignment variants. Prefer a shared producer-specific carrier
decision, preserving unrelated numeric properties and the IR migration's
typed-view/factory handling. The original 190-path candidate/base comparison
is requested before this work can be considered regression-checked.

Unannotated receipts are now available in the candidate worktree:
`unannotated-regexp-slot-probe-20260920.log` and its
`-no-numeric-locals-20260920.log` counterpart, both under `.tmp/5198/`.
Both produce valid import-free Wasm and fail all four const/var saved-identity
checks. LastIndex slots remain `f64` and match slots remain nullable native
references even with numeric-local specialization disabled. Consequently an
oracle-only veto is insufficient for real JavaScript: default checker-derived
slot resolution also needs the producer-specific dynamic-carrier decision.
The earlier kill-switch improvement is restricted to the annotated probe.

## 2026-09-20 corrected candidate execution checkpoint

Latest flags-repair validation: the unchanged full focused matrix is now
**20/30 pass, 10 fail**, terminal exit 1, 16.26 seconds, in
`.tmp/5198/protocol-flags-after-finalizer-20260920.log`. Comparing the actual
failure names against the preceding 17/30 log shows three improvements:
throwing flags getter order, i32-sized lastIndex advancement, and MAX_SAFE
lastIndex advancement. No previously passing focused case became red in this
comparison. Original-nine revalidation is running separately; these controls
do not substitute for original Test262 cases or full-cohort regression checks.

Runner-provenance correction: the first `original-nine-standalone-isolate-after-flags-20260920.log`
reports 0/9 but was invoked through the coordinator runner, whose compiler
imports resolve to untouched upstream source. It is not candidate evidence
and must not be interpreted as eight candidate regressions. Preserve the log
and rerun the writer-local runner against the identical corpus/manifest;
verify the absolute runner and compiler paths before accepting the result.

Corrected candidate-local original-nine run is terminal **9/9 pass**, zero
non-pass, in
`.tmp/5198/original-nine-standalone-isolate-candidate-after-flags-20260920.log`.
The writer-local maintained runner imported the candidate compiler and used
its existing corpus checkout, with no preload. The same manifest on untouched
`4a6cbdf1ee80` is 0/9. Thus all nine exact originals now improve on that base;
the previous remaining `g-get-result-err.js` failure is resolved by the flags
repair. This is not full 190-row clearance, focused-matrix completion, or an
edition-wide pass-rate claim. Ten focused cases still fail; TS7 is running.

The writer's expanded protocol/runtime candidate on base
`4a6cbdf1ee80b5d1618a7c87b014bc792f0fddc7` completed the focused matrix:
**22 tests: 13 passed / 9 failed**, terminal exit 1. Evidence in the writer
worktree: `.tmp/5198/protocol-after-correction-20260920.log` (15.56 seconds
Vitest duration). This is not a Test262 population measurement and cannot be
compared numerically with the smaller historical matrices as a net gain.

Natural argument/getter ordering, abrupt coercion, rebinding fallback, search
ordering/restoration, initial null global result, and lazy descriptor setup
controls pass. Remaining failures are the cast-string order probe (`29`, not
`123`), both large-lastIndex advance probes, raw search index preservation
(undefined/object identity and Symbol), throwing flags getter, runtime-global
custom exec, and custom exec object-result identity. Those are acceptance
failures, not tests to exclude. The writer retains the compiler lease for TS7
and tracing dispatch/receiver behavior; the peer continues source review.
The original frozen 190-path comparison and broader regression gates remain
required before a completed-fix PR.

TS7 subsequently completed successfully (terminal exit 0, 13.67 seconds;
`.tmp/5198/typecheck-ts7-after-correction-20260920.log`). Independent review
found a missed mutator: the literal descriptor-map arm in
`compileObjectDefineProperties` still directly stores a RegExp `lastIndex`
value. The writer is authorized to add the same narrow intrinsic-property
fast-path veto used by singular `defineProperty`, with plural descriptor
transition controls. Identifier descriptor maps already delegate through the
singular route. This is a concrete remaining runtime correctness fix; the
typecheck result does not establish descriptor conformance.

Second independent review finding: the direct assignment entry point currently
uses the same throwing setter as intrinsic RegExp algorithms. Sloppy writes
to a non-writable `lastIndex` must instead evaluate the RHS, leave the property
unchanged, and preserve the assignment expression result; strict writes and
internal protocol Set operations must throw. The original target AST is already
available in `tryCompileStandaloneRegExpLastIndexWrite`, so the existing
`helpers/is-strict-function.ts` service can determine strictness there without
editing the assignment lowering owned elsewhere. Add paired strict/sloppy
tests, retain one-time evaluation, and leave internal throwing setters intact.

The plural fallback also drops the descriptor helper's null rejection sentinel.
For the newly routed native lastIndex case it must perform
`emitDefinePropertyRejectionThrow` before dropping the successful result;
otherwise an illegal `configurable: true` update would falsely succeed.
Preserve Reflect's false-return convention and keep unrelated generic
descriptor behavior outside this repair.

The targeted strict/sloppy/plural follow-up completed terminal exit 1:
**2/3 selected tests pass** (dot-assignment strict and sloppy controls);
the plural descriptor control passes its host comparison but still returns
0 in standalone. Writer log:
`.tmp/5198/protocol-descriptor-plural-strictness-20260920.log`. The compiler
lease is explicitly handed to String.raw while RegExp diagnosis continues
source-only; this result does not replace the full 22-test matrix.

Additional peer finding: computed writes reach the generic physical-field
store in `closed-struct-extern-set.ts`, bypassing raw identity and writable
state. A narrow native lastIndex route is required, not a surface restriction
to dot assignments. Exact ownership has been requested from the IR task
before editing that shared setter (including the related Reflect.set path).
The pure native global-match arms also perform their checked initial zero
after native batching; moving it before the batch restores exact ordering.
The custom-exec slow path is already ordered correctly. Native batching has
no JS callback/coercion after input materialization, so this latter review
item concerns allocation/trap timing rather than the observed custom-exec
failures.

IR ownership reply verified published #5397 head
`165ea50bf3deb7c36d8844d5ac12173583d4f30d`: its only changes in
`closed-struct-extern-set.ts` forward `local.get 0` as actual receiver before
two `__extern_set_decide` calls (absent-field and bag-owned decisions).
Preserve those hunks with their matching helper ABI; do not import isolated
callsites. Published #5753 and #5748 have no delta in that file. No prior
claimed native RegExp store seam was identified, but the owner could not
certify vanished unpublished temporary worktrees; this is not a blanket
whole-file release.

The exact native lastIndex route is released subject to the peer's bounded
plan: preserve raw RHS, reuse the existing success/refusal outcome protocol
(`externSetResultGlobalIdx` values 1/2), prove result-global reservation for
strict/sloppy/Reflect callers, and reserve dependencies before the late fill.
Do not allocate new helpers/types during final filling or refactor generic
setters. The plural-control hypothesis is separate: its native predicate
lacks the singular route's actual Wasm receiver-type fallback, so the checker
name `RegExp` can make the `__StandaloneRegExp` guard false. Verify that
correction with the existing failing control rather than assume success.

Reservation audit found a concrete scanner counterexample:
`const dp = Reflect.defineProperty; dp(r, "lastIndex", {writable:false});`
can lock the intrinsic through the first-class builtin implementation while
the descriptor scanner misses the captured Reflect method. Consequently
`__extern_set_result` is not guaranteed to exist. Do not base strict computed
write correctness on its optional allocation.

Revised admitted plan: prepend fresh native-RegExp/lastIndex arms to the three
already-provisioned helpers during final fill. `__extern_set` stores or silently
refuses; `__reflect_set` returns 1/0 and updates the result global only if it
exists; `__extern_set_strict` stores or directly throws through its existing
TypeError constructor, tag, and message. Allocate no new helper/type/global
there and do not share mutable instruction objects across function bodies.
Test the captured-Reflect lock plus strict computed assignment explicitly.
Keep four-argument `__reflect_set_receiver` unchanged: it checks target and
receiver descriptors and writes the receiver through `__extern_set`, preserving
target/receiver separation. Add different-receiver controls to verify that
the native specialization does not mutate the target incorrectly.

The independent peer found no source blocker in the completed three-arm
checkpoint, but execution remains red: the direct Vitest retry reports
**17/30 pass / 13 fail**, terminal exit 1, in
`.tmp/5198/protocol-computed-lastindex-direct-vitest-20260920.log`.
Locked sloppy computed assignment and captured-Reflect strict assignment
pass. Computed raw identity, three-argument/alternate-receiver Reflect,
branded values, plural descriptors, and prior protocol failures remain.
The earlier `protocol-computed-lastindex-20260920.log` is a package-manager
auto-install/purge-abort failure with **zero tests**, not a candidate result;
the retry used the existing Vitest entry directly without modifying shared
dependencies. Original nine-row execution is next before further fixture
expansion. Source review is not a substitute for these runtime failures.

The original nine-row candidate run is now terminal: **8 pass / 1 fail**,
zero skips/timeouts/compile errors, via the maintained standalone isolated
runner. Evidence: `.tmp/5198/original-nine-standalone-isolate-20260920.log`.
The frozen list is `plan/agent-context/5198-protocol-original-nine-20260920.txt`,
SHA-256 `ca46424e94845d5046924d11c463311ad2e4fb2282972da37e6dff3cab987e52`.
Only `Symbol.match/g-get-result-err.js` remains red: the result index getter's
expected Test262Error is not observed. A fresh untouched `4a6cbdf1...` nine-row
comparison is required before calling these eight candidate passes net gains
against the older pinned census. All 30 focused acceptance controls and the
frozen 190-row cohort remain in scope. The peer is independently tracing the
throwing-flags control while the writer isolates computed raw-value identity.

Boundary isolation in `.tmp/5198/computed-lastindex-boundary-20260920.log`
reports literal and dynamic raw-read identity probes returning **1**, while
their deferred-exec probes return **0**; all four binaries validate and have
empty imports. Thus the combined raw-identity fixture's failure is not evidence
that the new setter loses the object on assignment. Trace the later exec /
deferred conversion and its observer separately before redesigning the store.

Fresh same-base original comparison is now verified: untouched
`4a6cbdf1ee80b5d1618a7c87b014bc792f0fddc7` reports **0/9 pass**, candidate
reports **8/9 pass**, with no skip/compile-error/timeout rows on either side.
Untouched log:
`.tmp/5198/original-nine-standalone-isolate-untouched4a6-source-redirect-20260920.log`.
The untouched compiler and runner were imported from the coordinator worktree,
with writer CWD supplying the same corpus and an inherited read-only preload
redirecting coordinator harness reads to that corpus. No compiler source or
checkout was changed. Earlier ENOENT runs are tooling failures and excluded.
This proves eight fail-to-pass transitions in the exact nine-row cohort, not
a broader regression-free result or an update to the edition-wide census.

Peer flags trace found a concrete generic-read defect: the selected slow
protocol correctly emits Get(flags) before exec, but
`fillClosedStructExternGetArms` returns the native RegExp physical i32 flags
field before any own accessor overlay. Correct public Get(flags) needs both
runtime own-property precedence and the public string-valued fallback, not
the internal bitmask. A narrow helper/reader composition plan is being
coordinated with the frozen String.raw reader changes; no type-wide accessor
global or literal/closure expansion is authorized.

Causal hypothesis to test first: converting the internal global bitmask to
`"1"` lacks `"g"`, so the slow match takes its non-global arm and returns a
custom object without ever reading index `0`. This could explain the sole
original getter-error failure without a literal-accessor construction defect.
IR confirms no known retained fix for numeric literal accessor dispatch, but
that ownership fact is not proof that construction is the cause. Fix/measure
the public flags read before widening that separate subsystem.

Further conversion isolation in
`.tmp/5198/computed-lastindex-valueof-boundary-20260920.log`: direct
`marker.valueOf()` succeeds (1), but the numeric-conversion probe returns 0.
Both dot and descriptor-based raw-lastIndex deferred-exec probes return mask 100:
matching succeeds, but the pre-exec snapshot identity and expected valueOf
call count fail. Immediate raw-read controls still pass. This points to
generic deferred conversion/representation rather than a uniquely computed
store defect; it is not yet a same-base proof that all residuals pre-exist.
No compiler process remains; the lease has been transferred to String.raw's
publication gates while RegExp source diagnosis continues.

Native flags repair is now authorized within the RegExp writer's isolated
worktree: pre-reserve the existing public flags-string helper during protocol
setup, then compose a no-allocation finalizer builder before the native
physical `flags` field arm. Consult the receiver's existing closure bag with
own-property presence and `__reflect_get_receiver` before the public string
fallback. Preserve String.raw's separate user-declared bag prefix. The writer
confirmed that native RegExp accessor definitions reach the identity-bag
descriptor producer; do not substitute type-wide accessor globals. Prototype
flags mutation remains an explicit semantic limitation, not covered by this
own-overlay repair. Runtime validation is pending the compiler lease.

Source tracing identifies the deferred numeric-conversion seam: nominal raw
objects can return unchanged from `__to_primitive` when the non-`$Object`
probe's arguments-length-brand reservation is absent. This explains why a
direct valueOf call can work while deferred conversion does not. Materializing
the raw object during assignment would sacrifice required identity and is not
an accepted workaround. Ownership of that shared seam has been requested from
the verified same-repository `IR migration` task; no edits there are released.

Conversion-plan review correction: the proposed native-first expansion of
`classToPrimIdx` reservation cannot by itself explain the recorded standalone
failure, because `ctx.standalone` already enables that predicate. The peer is
reconciling actual compile options and the standalone reserve/fill/dispatch
path before implementation. Treat the native-first finding as a separate
hypothesis/defect, not a proven repair for this goal's failing rows. Also split
direct-expression identity from identity after saving a result in a local:
ambient RegExp signatures may still describe a numeric result even when the
protocol emitter deliberately returns an externref. No new setter/conversion
change is justified until the losing boundary is measured.

The mismatch is now source-verified: the focused fixture's `run` explicitly
passes `target: "standalone"`, and `reserveArgumentsLengthBrand` only returns
undefined outside standalone; inside it always returns an existing or newly
reserved handle. Therefore absence of that reservation is **not** the cause
of this standalone fixture's conversion failure. Withdraw that causal claim
for this lane and inspect the actual driver/closure/local representation.
The independent native-first gap must not inflate this task's progress.

Next authorized protocol-local implementation plan: `__apply_closure` can
return an externref-wrapped `$AnyValue` for `exec(): any`; its tag-6 object
payload is not yet the raw object expected by protocol property reads and
identity. Reuse (minimally export) the existing
`dyn-ops.ts::ensureDynamicCallBoundaryExtern` rather than duplicate tag-5/6
conversion. Pre-reserve it before late-import flushing. At the custom-exec
result boundary, guard the externref's actual `$AnyValue` type before casting
and unwrapping; leave raw results untouched and perform the existing
Object-or-null validation afterward. Do not modify the generic closure ABI.
Inspect import-cycle initialization and use the live helper index at emission.
Measure direct versus saved-local result identity, all invalid primitive
results, null, raw search index values, full 30 controls, original nine, then
the 190-row cohort. This is a source-supported hypothesis pending runtime
validation, not a credited fix.

Adapter source-review corrections before measuring: resolve the bridge's live
function index at emission, not the number captured before subsequent late
imports/flush. Remove the extra result-local push before `buildIsObjectOrNull`,
which already loads its own operand; leave one final result on the stack.
Also check source-order admission: testing only whether `$AnyValue` already
exists during protocol setup can miss a closure compiled later. Keep a
late-defined `exec(): any` control rather than assuming an absent early type
means the runtime cannot return that carrier.

First shared-adapter run remained **20/30**, recorded in
`.tmp/5198/protocol-result-boundary-after-shared-adapter-20260920.log`.
It preceded the live-index, extra-stack-value and source-order review
corrections, so it is preserved as an intermediate result, not credited as
an improvement. Those three corrections are applied and the same matrix is
being rerun. Generic helper null-payload behavior is not widened speculatively.

Corrected-adapter rerun is also terminal **20/30 pass**, 16.48 seconds, with
the identical ten failure names:
`.tmp/5198/protocol-result-boundary-corrected-20260920.log`.
Thus neither adapter version demonstrates a conformance gain. Do not widen
the patch based on the wrapper hypothesis alone. The next diagnostic must
prove helper selection/execution and the input/output representation, with
direct-expression versus saved-local controls. Retain or remove the adapter
based on that evidence; keep the already-proven flags fix independently
identifiable. The original-nine and broader cohort still require revalidation
after any retained source change.

Post-adapter original-nine revalidation remains **9/9 pass**, verified in
`.tmp/5198/original-nine-standalone-isolate-candidate-after-result-boundary-20260920.log`.
The writer reports direct TS7 terminal exit 0; its corresponding log is empty,
so the exit result, not absence of text, is the typecheck evidence. No focused
gain is established. A diagnostic-only helper-selection/direct-versus-saved
probe is now being prepared before any further adapter change.

The diagnostic is now terminal in
`.tmp/5198/result-boundary-probe-20260920.log`: successful valid standalone
binary, no imports, encoded result **201010**. Its source defines decimal
positions, not aggregate test counts: direct `Symbol.match` result identity
passes, the saved-result identity fails; direct `lastIndex` identity passes,
the saved-lastIndex identity fails. The two Symbol.match calls invoke custom
exec; the separate static direct-exec control does not. This confirms a
saved-local transport boundary can lose identity despite correct immediate
protocol output. Inspect the chosen local type/coercion against the emitter's
actual externref result, with separate minimal functions to avoid conflating
static exec dispatch. The initial WAT name filter found the bridge definition
but does not prove a runtime bridge call; inspect numeric call targets before
claiming that adapter was exercised. Any declaration-lowering change needs
exact IR ownership coordination.

Source tracing now identifies the saved-local candidate: explicit `any`
locals resolve to `$AnyValue`; `statements/variables.ts` coerces an actual
externref initializer through `type-coercion.ts` to `boxToAny(..., 'unknown')`,
whose generic externref branch in `value-tags.ts` uses the string-tag boxing
helper. A split-function emitted-site receipt is still required before a
shared lowering change. The exact ownership query has been sent to IR; no
generic coercion edit is released.

Separately, the reviewer's candidate-imported standalone behavioral receipt
returns mask **3**: direct `marker.valueOf()` and a saved-method call both
work, while `Number(marker)` fails (expected full mask 7). This rules out a
general saved-method-dispatch failure for that source and isolates a distinct
numeric-conversion boundary. It does not prove the runtime method-slot tag.
The reviewer is preserving its terminal receipt; the compiler lease returns
to the writer for split-local/plural diagnosis.

Revised conversion hypothesis from source review: an own `valueOf` method can
be read from an open object as an externalized tag-6 `$AnyValue`; the ordinary
ToPrimitive walker tests callability without the dynamic-call boundary's
unwrapping. This would explain direct-call success versus Number conversion
failure, unlike the withdrawn standalone-reservation theory. Obtain emitted
runtime-path evidence before implementation and reuse shared boundary logic
where possible, preserving the original receiver and one observable Get.

## 2026-09-19 recovery and review plan (Codex)

Resume from upstream `4a6cbdf1ee80b5d1618a7c87b014bc792f0fddc7`, not by
replaying the frozen Sep13 identity/allocation work. Recovered upstream branch
`claude/es6-5198-regexp-exec-protocol` at
`3b41aeec2824dc51309658fbd0e6a966b8d3761d` contains the later unreviewed
implementation and its measured handoff. Preserve its original authorship and
evidence; do not rebuild that work from memory.

Pre-dispatch evidence: the parent issue is reserved with no live owner; the
only active related slice claims are this task's existing exec identity and
sticky-cursor claims. Open #5393 is a tests-only, intentionally failing custom
exec checkpoint, not a production implementation. IR owner confirms #5748
touches `regexp-standalone.ts` only for two Boolean result annotations in
`tryCompileStandaloneRegExpTest`; preserve those annotations. Protocol edits
elsewhere in that file are unclaimed by IR. Its shared generator/class/closure,
Promise/vector and layout owners remain out of scope.

The subsequent `5198:exec-protocol-recovery` claim is now verified on the
upstream registry for `ttraenkler/codex-5198-protocol-recovery`, branch
`codex/5198-protocol-recovery-20260919`. Separate Terra Max reviewer and writer
worktrees are assigned. The writer is initially authorized only for current-main
integration inspection and portable red tests; importing/correcting production
code waits for the completed review and an explicit coordinator release.

### Completed independent review and correction contract

The read-only review of `3b41aeec28` found five concrete blockers in
`regexp-protocol-slow.ts`:

- `emitProtocolTwoArm` gets `exec` before argument evaluation/coercion and
  re-dispatches the original AST in the fallback. A getter may mutate even an
  identifier binding, so neither receiver nor argument may be evaluated twice.
- The search arm reads/resets lastIndex before coercing the string argument.
- Search coerces `Get(result, "index")` to f64 instead of returning the raw
  property value, losing undefined, strings, Symbols, and object identity.
- Match uses initializer flags without observable `ToString(Get(rx, "flags"))`;
  this misses abrupt accessors and dynamically selected global behavior.
- An arm can decline after outer instructions/context changes were emitted;
  falling back without complete rollback can corrupt compilation state.

Implement the full protocol correction, not just an order swap: evaluate the
receiver and raw argument once into locals, then coerce once at the algorithm's
entry point. Native fallback must consume those values without AST replay.
For search, perform lastIndex operations in specification order and retain the
raw externref result; box the native numeric result at the join. For match,
honor runtime flags and the custom-exec global loop rather than treating a
statically non-global initializer as proof of runtime behavior. Preflight all
possible declines before emission or provide complete transactional rollback,
including mutated compilation context, not merely a body-array truncation.

Required red/green controls: argument/exec-getter event ordering, abrupt string
coercion before exec access, fallback receiver mutation, coercion mutating
lastIndex, raw search index undefined/object identity, dynamic/throwing flags,
global custom exec termination/empty-match advance, and arm-decline safety.
Retain null/object/primitive exec-result and noncallable fallback controls,
zero-host-import checks, original nine-row evidence, and non-escaping byte
inertness. No removing the match path merely to relabel a smaller passing set
as completion of this recovery. If full correction requires another owner's
files, report the exact seam and coordinate before editing it.

The coordinator now releases integration and correction within the three
owned production files after the writer incorporates this plan and establishes
the red tests. Publication still requires independent peer review and the
previously listed candidate gates; no weakened tests or compiler inventory
claims are authorized.

First portable regression execution on untouched upstream `4a6cbdf1ee80`:
`tests/issue-5198-regexp-exec-protocol.test.ts` failed **1/1**, terminal exit 1,
expected coercion/getter/call trace `123`, observed `0`. Durable writer log:
`.tmp/5198/red-order-current-main.log`. This establishes a failing source pin,
not by itself which steps were bypassed: the local trace is captured by
callbacks, so independent Node and compiled-host observer controls are required
before attributing the zero solely to protocol lowering. The receiver remains
an inferred RegExp, not `any`. Candidate-import red evidence and the remaining
matrix are pending; no production correction or passing result is claimed.

Observer follow-up on the same untouched head is terminal exit 1, **2 passed /
1 failed**: direct Node and compiled-host controls each return `123`; the
standalone pin still returns `0`. Durable log:
`.tmp/5198/red-order-controls-current-main.log`. This corroborates the
observer and narrows the mismatch to standalone lowering; it does not replace
candidate-import ordering evidence or the remaining regression matrix.

Expanded untouched-main matrix is terminal exit 1, **6 passed / 3 failed**
(`.tmp/5198/red-matrix-order-abrupt-fallback-current-main.log`, inspected by
the coordinator). Both cast-string and natural-object input variants return
`0` instead of `123` standalone; abrupt coercion returns `900` instead of
`1`. Node/compiled-host controls pass, as does the noncallable getter-rebind
fallback control in both compiled lanes.

After source-only candidate import, the writer reports terminal exit 1,
**5 passed / 4 failed** in `.tmp/5198/red-candidate-precorrection.log`.
Natural-object ordering becomes `213` (exec getter, coercion, call), abrupt
coercion becomes `21` (getter before the thrown marker), and getter-rebind
fallback returns `0` after switching to the rebound receiver. The cast-string
variant returns `29`, exposing a separate wrong-subject observation. These
are pre-correction candidate failures, not completed fixes; correction work
is released within the owned files and the remaining acceptance matrix still
applies.

The coordinator inspected the candidate failure log, and the independent peer
reviewed the current portable pins: expected semantic outcomes are sound and
every standalone run validates the module and asserts an empty import list.
Both cast-string and natural-object variants retain positive compiled-host
controls. Align the Node abrupt-control getter's callable shape with the
compiled source; further observer instrumentation is optional, not a reason
to defer the now-established production correction. This pin review does not
replace final source review or original Test262 verification.

The subsequent source checkpoint implements local-based builtin fallback
through the existing `emitRegexExecArrayCall` override API, preflight-only
declines, and explicit match/search protocol emitters. It remains untested.
The peer identified that rollback regions cannot provision helpers across
`flushLateImportShifts`; all decline decisions must precede that boundary.
The writer released the compiler lease with no live process to allow #5152's
red controls, and continues source-only correction until handback. In the
global empty-match loop, retain full observable ToLength/lastIndex precision;
an i32 string-addressing representation must not wrap a large lastIndex.
The peer confirmed this blocker in the new checkpoint: `emitToLengthI32`
saturates to signed i32 and the empty-match advance writes an i32 increment.
Replace it with F64 ToLength clamped through `2^53 - 1` and F64 advancement;
only narrow after an in-bounds proof for UTF-16 surrogate reads. Required
custom-global-exec controls observe `2147483649` after advancing `2147483648`
and `9007199254740992` after advancing `9007199254740991`, then return null.
These are peer-confirmed source defects and planned regression controls, not
measured runtime results yet.

The writer subsequently implemented F64 advancement and added both boundary
pins; they remain untested pending compiler-lease handback. Another reviewed
boundary remains: a real RegExp's nonconfigurable lastIndex data property can
transition writable from true to false during a custom exec. Direct native
field reads are compatible with that data property, but direct writes plus
static `nonWritableExternKeys` cannot enforce temporal writability. The prior
rejected branch-insensitive guard below must not be reintroduced.

The independent peer is identifying the smallest runtime writable-state seam
and exact owners before expanding implementation. No new descriptor scanner
or preflight decline will be used to exclude originals or controls, and no
dynamic descriptor correctness is claimed. The two previously documented
global-match residuals remain explicit while that runtime plan is evaluated.

### Runtime lastIndex writability: peer design before expanded dispatch

The read-only peer found no reusable authoritative runtime writable bit:
regexp flags and raw/present fields encode other semantics, and carrier-bag
descriptors are bypassed by physical intrinsic reads and engine writes.
Proposed minimal representation is appended mutable i32
`RE_FIELD_LASTINDEX_WRITABLE = 9`, initialized to 1, preserving fields 0–8.
All NativeRegExp constructors must initialize it, including poison/dynamic,
literal and clone sites in `regexp-standalone.ts` and the constructor in
`dyn-ops.ts`. This is an ABI change requiring source-owner coordination and
constructor coverage, not an already released edit.

Central local-based Set guards in `regexp-standalone.ts` must check runtime
writability on every actual Set, including protocol restore/advance, direct
assignment, exec/search reset/update, match/matchAll, replace, test and compile
reset, and `string-proto-match-search.ts`. Do not cache a check across custom
exec; update numeric/raw/present fields consistently after the guard.

Definition must route intrinsic RegExp lastIndex before generic carrier-bag
substitution. Exact proposed seams are `compileObjectDefineProperty`,
`emitExternDefinePropertyNoValue`, and `emitDefinePropertyDescRuntime` in
`object-ops.ts`, plus `__defineProperty_value` and `__obj_define_from_desc`
construction in `object-runtime-descriptors.ts`. Preserve nonconfigurable,
nonenumerable data semantics: legal value updates and true-to-false writable
transition; reject accessor/configurable/enumerable changes, false-to-true,
and non-SameValue updates after locking. Omitted/no-op descriptor fields are
legal. Object.defineProperty throws where Reflect.defineProperty returns false.
The coordinator has requested exact IR ownership before expanding dispatch;
no changes to closure/carrier-bag allocation are part of this proposal.

Required controls include locked-zero search doing no Set; locked-nonzero
search throwing before exec; exec locking before search restore; custom global
empty match locking before advancement; g/y builtin update/reset while locked;
assignment RHS evaluation then rejection preserving the old raw value; and
legal/illegal descriptor transitions, including SameValue and Object/Reflect
differences. Treat this as a runtime correctness dependency, not optional
hardening or permission to skip failing originals.

Expanded release after exact ownership review: `dyn-ops.ts` constructor,
`string-proto-match-search.ts` lastIndex write, the three listed `object-ops.ts`
functions and native-RegExp value/accessor/from-desc routes in
`object-runtime-descriptors.ts` are available to the same writer. Preserve
#5753 at `cddba56b768f30eb5d9af29d2954dd69e2b534b5`: marker-local accounting
after bag/boundary locals, authentication, commits, appended marker locals,
and accessor non-extensibility helper extraction. Do not hardcode new scratch
offsets or replace whole descriptor functions. Preserve #5063 at
`d070b5583e66be23903031e4bed0556559026d34`: its actual-carrier-type gate and
getLocalType/localGlobalIdx imports in compileObjectDefineProperty. No other
open PR listed the four expansion files at this dispatch milestone. Closure,
carrier-bag allocation and held index/post-layout finalization remain excluded.

Coordinator decision: use the explicit appended runtime field rather than
packing mutable writability into regexp flags. This intentionally changes
bytes for standalone RegExp users, even without a protocol escape. The older
non-escaping-RegExp byte-identity expectation therefore cannot describe this
expanded ABI repair and is explicitly superseded by semantic-equivalence and
regression checks for those programs; retain byte-identity controls for
unrelated no-RegExp programs. Do not waive repository equivalence gates or
claim byte neutrality. Preserve fields 0–8 and non-observability of the new
internal slot. Keep the runtime-state diff separately reviewable within the
coherent #5198 fix. Peer follow-up is checking descriptor-helper initialization
before first RegExp allocation without changing held finalization owners.

Initialization-order audit confirmed helpers may exist before the RegExp type.
Accepted bounded design: an idempotent
`installNativeRegExpLastIndexDescriptorRoutes(ctx, regexpTypeIdx)` in
`object-runtime-descriptors.ts`, backed by per-context WeakMap state. Install
from both the descriptor-builder end when the type already exists and after
`ensureStandaloneRegExpStruct` publishes its maps/fields. Resolve live helper
functions through `ctx.funcMap`/`definedFuncAt`; preflight all three helpers
before mutation, append scratch locals using their actual parameter/local
counts, and prepend intrinsic receiver/key branches before boundary/vector/bag
dispatch. Mark installation complete only after all routes exist. Do not mint
RegExp types/functions for unrelated programs or change finalization owners.

The third route is `__getOwnPropertyDescriptor`, which must report the physical
raw/numeric lastIndex value, runtime writable bit, and false enumerable/
configurable. This route is now explicitly in scope. Data/accessor invariant
rejections return null from the low-level define helpers, preserving Object's
existing rejection throw and Reflect's false conversion; malformed descriptor
and key coercion errors still throw normally. `__obj_define_from_desc` already
forwards to these helpers, so do not replay conversion through a new route.
Required ordering control provisions ordinary-object descriptor helpers first,
then allocates/locks a RegExp and checks gOPD plus Object/Reflect rejection.
Enumerate every constructor from actual source, including dynamic poison and
normal, literal, both clone branches and dyn-ops, rather than trusting a count
in a prior checkpoint message.

The nine exact target originals from the Sep18 handoff remain standalone
**0/9 pass** and host **9/9 pass** in pinned baseline commit
`6c51eb29ef12208ac8f53ae99eea900b53f51a76`, oracle 14 (standalone `honest`,
host `linked-harness`). Seven are the candidate's claimed gains; two are its
explicit global-match declines. This cross-lane observation is not a fresh
candidate run or a claim that the two harnesses are equivalent.

The historical 190-row acceptance corpus is now explicitly reconstructed at
`plan/agent-context/5198-protocol-original-paths-20260919.txt`: every `.js`
file other than `_FIXTURE` under RegExp prototype `Symbol.match`,
`Symbol.replace`, `Symbol.search`, and `Symbol.split`, sorted, exactly 190
unique paths. SHA-256:
`567987a2f7b705a318ce45a003c5bd8e05543a2b2da5718b6ab73dc430105890`.
The actual Test262 repository and this branch's gitlink both identify corpus
`b363f29d3c43c626dc852744ad64a0b48a003693`. Reuse the exact manifest on both
frozen test heads rather than reconstructing a convenient subset during
validation; this is corpus preparation, not a completed candidate test run.

Plan before implementation/publication:

1. Independently review recovered source and its full dated implementation
   record in an isolated worktree. The review has already confirmed that
   `regexp-protocol-slow.ts` reads `exec` before string coercion, contrary to
   required observable ordering. Do not publish the recovered patch unchanged.
2. Finish the review's minimal correction plan, including single evaluation of
   receiver/argument, coercion and property-access exception order, fallback
   correctness, custom-result validation, and search lastIndex preservation.
   Record further defects rather than assuming seven green rows establish
   correctness. No production edits before the review and slice claim.
3. Integrate in a new implementation worktree based on current upstream,
   preserving the two Boolean annotations and the original red checkpoint.
   Add portable failing regression tests before corrections, then verify the
   claimed original rows with the maintained runner and passing controls.
4. Preserve the two global-match failures as explicit remaining work unless
   their full loop/descriptor semantics are implemented and verified. Neither
   skipped tests nor a half-implemented fallback counts as conformance progress.
5. Re-run the recorded 190-row comparison and appropriate byte-inertness,
   equivalence, typecheck, inventory, and normal repository gates on the actual
   integrated candidate before a ready upstream PR. Attach a separate peer
   shepherd. Whole-ES2015 acceptance remains the full #4444 goal.

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

### 2026-09-20 narrow `$Object` ToNumber repair plan

This is a prerequisite for the remaining dynamic `lastIndex` / custom-`exec`
controls, not a claim that any additional RegExp Test262 row has passed. The
standalone receipt's direct `marker.valueOf()` and saved-method call both pass,
but `Number(marker)` returns `0`. The receiver is deliberately the small
CS1a carrier shape:

```ts
const marker: any = { valueOf: function () { return 7; } };
Number(marker);
```

The explicit `any` context selects the open runtime `$Object` builder
(`literals.ts::objectLiteralTakesStandaloneAnyObjectPath`), and the CS1a slot
rule preserves it as `ref $Object` (`statements/variables.ts`,
`objectLiteralIsStandaloneAnyObjectCarrier`). `coerceType`'s `ref -> f64`
arm, however, only enters its ToPrimitive lowering when
`typeIdxToStructName` names a nominal struct. `$Object` is published through
`ctx.objectRuntimeTypes.objectTypeIdx` but deliberately has no such name-map
entry, so the current arm falls through to `drop; f64.const 0` without a
`Get(valueOf)`.

ECMA-262 [ToNumber](https://tc39.es/ecma262/multipage/abstract-operations.html#sec-tonumber)
requires an Object operand to first perform
[ToPrimitive(argument, number)](https://tc39.es/ecma262/multipage/abstract-operations.html#sec-toprimitive).
Absent an exotic `@@toPrimitive`,
[OrdinaryToPrimitive](https://tc39.es/ecma262/multipage/abstract-operations.html#sec-ordinarytoprimitive)
uses `valueOf` before `toString`, calls each with the original receiver, returns
the first primitive result, and propagates an abrupt completion unchanged.

#### Narrow implementation contract

1. In `src/codegen/type-coercion.ts::coerceType`, retain the existing
   native-string arm unchanged. Immediately after it, before the
   `__insideValueOfCoercion` flag is set and before the nominal
   `typeIdxToStructName` lookup, recognize exactly
   `typeIdx === ctx.objectRuntimeTypes?.objectTypeIdx`.
2. For that one runtime type in standalone with the numeric hint, call a new
   narrowly exported `emitStandaloneObjectToNumber(ctx, fctx, hint)` from the
   existing `tonumber-fast-paths.ts` module and return only when it accepts the
   already-present struct ref. It must prove/prepare every dependency before
   emitting `extern.convert_any`, so an unavailable provider falls through with
   the original stack untouched. With fused ToNumber enabled it invokes the
   existing native `__to_number`; with fusion disabled it emits the same
   `__to_primitive` path followed by the existing `symbolThrowArm` and only then
   `__unbox_number`, using a fresh externref scratch local rather than the
   fused helper's fixed local 2. `emitToPrimitiveHostCall(..., "f64", ...)`
   alone is insufficient: it sends a Symbol primitive straight to
   `__unbox_number`, whose deliberate result is NaN for property-key probing,
   while ToNumber must throw TypeError.
3. Do not add a nominal name-map entry, generic any boxing, runtime map
   registration, a host import, or a new acceptance/refusal gate. The runtime
   `__to_primitive`, fused `__to_number`, union helpers, and Symbol throw
   machinery are native dependencies already owned by the standalone route.
   This must be confirmed with the zero-host-import receipt, not assumed from
   source spelling. The raw `$Object` branch must not invoke the SMI-only
   fast-path when fusion is disabled: that representation cannot be i31, and
   that fast path's existing slow arm owns a fused-helper-specific local-index
   contract.
4. The branch deliberately precedes the re-entrancy bookkeeping, so it has no
   cleanup state to restore. It delegates all observable method order,
   `@@toPrimitive` precedence, receiver identity, and abrupt completion
   handling to the current `$Object` `__to_primitive` helper rather than
   replaying any AST expression.

The only production files intended for this repair are
`src/codegen/type-coercion.ts` and the existing
`src/codegen/tonumber-fast-paths.ts` provider module; this issue document and
one focused regression test are the accompanying evidence. The branch is not a
generic `ref -> f64` change: native strings, nominal structs, vectors, classes,
unrelated refs, and the host compatibility lane retain their existing paths.

#### Required receipt and controls

Before source mutation, compile the exact standalone carrier source with
`emitWat: true`, map WAT numeric call targets by import count plus defined
function ordinal, and record both the runtime result and the producer/consumer
mapping. Named-string searches alone are invalid evidence because WAT prints
numeric call targets. The pre-change receipt must show that the `Number` body
does not reach `__to_primitive`; the post-change receipt must map it to
`__to_primitive`, then its `$Object` `__extern_get` / callable dispatch, and
must show no `env` imports.

The focused source matrix must separately assert:

1. `valueOf -> 7` returns `7`, invokes only `valueOf`, and retains the
   original `$Object` receiver;
2. `valueOf -> "8"`, `true`, `null`, and `undefined` produce respectively
   `8`, `1`, `0`, and `NaN` after the existing number frontier;
3. an object result from `valueOf` continues once to `toString`, whereas a
   primitive `valueOf` result does not call `toString`;
4. an own `@@toPrimitive` has precedence and observes the literal hint
   `"number"` where the admitted carrier representation supports it;
5. a thrown object from `valueOf` is caught as the same object and does not
   execute `toString`; and
6. both methods returning objects throw the existing catchable `TypeError`; and
7. a `Symbol` returned from either `valueOf` or `@@toPrimitive` throws the
   existing catchable `TypeError`, both with default tuned flags and with
   `JS2WASM_FUSED_TONUMBER=0`.

Fresh-main receipt correction (2026-09-20): the original one-function source
was compiled verbatim against both the recovery candidate and fresh
`35e040c08ed10f793faf26bb0f0eac55be662627`. Both returned bitmask `3` (direct
and saved method calls pass; `Number` fails), with zero imports. Its emitted
`marker` local is `(ref null 77)`, the runtime `$Object` type, rather than the
generic `externref` produced by a multi-export control that reuses a growable
binding name. With `optimize: false`, the `try_table` producer for `coerced`
is already `f64.const 0`; source inspection identifies the pre-peephole cause
as this arm's `drop; pushDefaultValue(..., f64)`. Earlier `__to_number` calls
in the same emitted function belong to the direct/saved-call bookkeeping and
are not evidence that the `Number(marker)` expression reached that helper.

The focused regression must also sequence one raw `$Object` coercion and one
unrelated closed/nominal-object coercion in the same compilation under distinct
binding names. That proves this branch neither changes the latter producer nor
leaves `__insideValueOfCoercion` set for later lowering.

Run those controls in standalone with `WebAssembly.Module.imports(...) === []`,
then preserve an unrelated ref/numeric coercion control plus host and WASI
compile/instantiation controls. The host/WASI cases are non-claims for the
CS1a `$Object` branch itself (that carrier is standalone-only); they establish
that the exact type-index predicate neither changes their producer selection
nor introduces a host dependency. The original raw-lastIndex/custom-exec
receipt remains a downstream integration control, not a substitute for this
isolated ToNumber proof.

#### Deferred independent FUSED-off SMI validation defect

This is a separate compiler-validation defect recorded here pending allocation
of its own indexed issue. It is **not** part of the narrow raw-`$Object`
repair, does not relax its controls, and must not be presented as a RegExp
protocol gain.

With the exact one-function receipt above compiled in standalone mode on Node
`v24.19.0`, `emitWat: true`, `optimize: false`,
`JS2WASM_FUSED_TONUMBER=0`, and default SMI settings, both fresh
`35e040c08ed10f793faf26bb0f0eac55be662627` and this repair candidate fail
before execution with the same error:

```text
CompileError: WebAssembly.Module(): Compiling function #52:"directNumberTrace"
failed: any.convert_extern[0] expected type externref, found local.tee of type
(ref null 77) @+56305
```

The repair candidate changes the `Number(marker)` body from `f64.const 0` to
the intended `$Object` `__to_primitive`, Symbol guard, and `__unbox_number`
sequence, but the validation error is identical on the clean baseline. It is
therefore an independent existing path. With
`JS2WASM_SMI_FASTPATH=0`, the candidate's unfused focused matrix passes on the
same Node runtime.

The source cause is confined to
`src/codegen/tonumber-fast-paths.ts::tryEmitFastToNumber`: its SMI-enabled,
FUSED-off slow arm calls `slowChainInstrs`, which uses
`symbolThrowArm(ctx)`'s fixed local `2`. That local is valid only in the fused
helper, where it is the preallocated `externref` primitive. In an ordinary
function it can be an application local such as `(ref null 77)`, so the arm
emits `local.tee 2; any.convert_extern` against the wrong type.

The bounded follow-up is to retain the fused helper's default local contract,
but build the FUSED-off slow arm after its existing `tmp: externref` is
allocated and pass that index through `slowChainInstrs` to `symbolThrowArm`.
It must retain the Symbol-to-Number TypeError path, leave the `!smi && !fused`
decline byte-identical, preserve detached-IR dynamic ToNumber lowering, and
add no imports or generic-boxing changes. Until that separately scoped repair
exists, the focused raw-`$Object` test scopes `JS2WASM_SMI_FASTPATH=0` only for
its FUSED-off control; default-fused coverage retains normal SMI settings.

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

## 2026-09-24 — Annex B `compile` literal syntax check re-landed from draft PR #6014

The narrow static syntax check from draft PR #6014 (Codex) was ported onto
current main unchanged: when both `RegExp.prototype.compile` arguments are
side-effect-free primitive literals (or `void 0`), an invalid pattern/flags
pair throws SyntaxError after receiver and argument evaluation and before any
receiver mutation. Standalone rows gained (measured by the triage run on
2026-09-24, fail on main, pass with the change): `annexB/built-ins/RegExp/prototype/compile/pattern-string-invalid.js`,
`pattern-string-invalid-u.js`, `duplicate-named-capturing-groups-syntax.js`.
Its two unfixed cases stay open here rather than pinned as failing tests: a
shadowed `undefined` parameter passed as flags, and an abrupt receiver before
an invalid literal.

