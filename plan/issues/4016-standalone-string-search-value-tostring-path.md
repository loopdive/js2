---
id: 4016
title: "standalone: String.prototype search-value methods refuse the spec's plain-ToString path"
status: in-progress
sprint: current
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
goal: standalone-gap
assignee: ttraenkler/M-regexp
created: 2026-08-01
updated: 2026-09-28
oracle-ratchet-allow: []
loc-budget-allow:
  - src/codegen/regexp-standalone.ts
  - src/codegen/string-ops.ts
  - src/codegen/expressions/calls.ts
func-budget-allow:
  - src/codegen/string-ops.ts::compileNativeStringMethodCall
  - src/codegen/expressions/calls.ts::emitReflectiveNativeProtoClosureCall
---

## 2026-09-27 recovery state

The saved implementation checkpoint
`1fb196048b26b9a686eaf5a4719cc646a1d1353a` is being reconciled with upstream
`44c2fb086278cd6d0b24efdaa061112452f901f1` in the persistent isolated
worktree `codex-4016-resume-20260927`. The old `/private/tmp` candidate and
baseline worktrees lost their Git links and their `.tmp/4016` receipts; the
cause is unverified. Path references below therefore label historical evidence
only, not files available for inspection or fresh measurements.

The raw-v1 fixture survives as Git blob
`6a182414d4cdb4c5b1511e055740314d75734497`. Its 42-row comparison remains
historical attribution, not a valid conformance denominator: one direct-object
receiver had no `.split` method. A versioned replacement must retain that row
as a separately Node-verified TypeError/order control and add valid direct,
borrowed, nullish, and abrupt-receiver controls before any new A/B claim.

The reconciliation keeps upstream's B6 reflective `separator[@@split]`
dispatch and the checkpoint's staged direct coercion path. The latter cannot
ship until its raw provider lookups move through a canonical shared coercion
engine API rather than a local vocabulary-only workaround. `registry/imports.ts`,
IR, context layout, and the separately owned undefined-global cache defect stay
out of scope. Fresh validation must use the maintained whole-assembly runner
with an explicit complete shard and recorded canonical verdict/callback counts;
the old single-file report is not conformance evidence.

### 2026-09-27 S2v3 paired control receipt and next narrow repair

The corrected S2v3 fixture retains raw-v1's direct-object boundary as a
Node-verified `TypeError`/`1234` observation, adds valid direct and borrowed
receiver cases, and applies only a TypeScript-overload cast to the borrowed
nullish separator (not to the receiver or runtime lowering). The current
fixture and the independent coercion-engine control were copied byte-for-byte
to a clean `44c2fb086278cd6d0b24efdaa061112452f901f1` baseline:

- `tests/issue-4016-standalone-search-value-tostring.test.ts` SHA-256
  `bb1612b4994bd598c7c1288a774ff3a3c41dcf20e4d93f88c31f84a116181e99`;
- `tests/issue-1917-coercion-plan.test.ts` SHA-256
  `86ecdb405346d7186842d26e0cd89587fe94e13cf5b358413128e4a3a994f437`.

With Node 24.19.0, one Vitest fork, and a 2 GiB worker cap, that exact
62-control pair is **48 pass / 14 fail** on clean base and **55 pass / 7
fail** on the resumed candidate: seven fail-to-pass transitions and no
pass-to-fail transition. The durable logs are
`.tmp/4016/focused-engine-s2v3-baseline-44c2-2gb-20260927.log` (SHA-256
`dd865472c638d1d086eb45a6ad711d74f2623357ab00bd619eab1620d33d6ca7`) and
`.tmp/4016/focused-engine-s2v3-candidate-2gb-20260927.log` (SHA-256
`a323dd1ba4e12c9fc74fa7e4d8a80ace97a7ca6d2d8c5e416b4493803fe4709f`).
These are focused compiler controls, not Test262 or whole-assembly evidence.

The seven observed gains are valid direct primitive staging; supplied
`undefined`/raw-`null` distinction; host bare-Symbol rejection; native
Symbol-limit rejection; suppressing separator coercion after a native
Symbol-limit; zero-limit Symbol-separator rejection; and finite `ToUint32`
modulo reduction. The remaining seven candidate failures stay ordinary red
assertions: two protocol-refusal pins, the raw-v1 TypeError identity/order
boundary, borrowed extra-argument order, borrowed abrupt completion, the
host post-primitive Symbol invalid-Wasm boundary, and the descriptor-before-
split host `TypeError` boundary. In particular, invalid-Wasm is a worsening
of an already failing result, not a pass loss or a success claim.

The shared coercion engine now preflights `ToPrimitive`/`ToNumber` providers
before arbitrary operands and rebuilds calls from post-staging handles. Its
`ensureExternrefToNumberProvider` return is fail-closed on a missing
post-flush `funcMap` entry; no fallback to a stale provisional index remains.
The accompanying non-split controls pass both arms for a runtime `any`
parameter and the same coercion before a later `Date.now` host builtin. They
are practical coverage of the raw provider contract, not proof by themselves
that every late-shift route was exercised.

Source review isolates the borrowed extra-argument failures to
`src/codegen/expressions/calls.ts::emitReflectiveNativeProtoClosureCall`:
its fixed ABI loop evaluates only `i < paramTypes.length`; surplus evaluation
exists only for `String.prototype.normalize`. Under the task-local ownership
clearance, extend that exact surplus loop to **standalone/WASI native
`String.prototype.split` only**. It must evaluate and drop trailing real
arguments after fixed raw slots but before `call_ref`, therefore before the
split closure coerces its receiver/limit/separator. Preserve the existing
padding policy, normalization behavior, direct split path, and every other
native method. Add an abrupt-extra control alongside the existing ordinary and
receiver-abrupt borrowed controls. This is a narrow source repair, not a
generic variadic-method change; the declared `calls.ts` LOC/function budget is
for that hunk only.

### 2026-09-27 S2v3b borrowed-argument repair and complete neighborhood receipt

The approved split-only surplus-argument hunk is now present in
`emitReflectiveNativeProtoClosureCall`. It applies only to standalone/WASI
native `String.prototype.split`, evaluates each real surplus argument after
the fixed raw slots and before `call_ref`, and leaves normalization, padding,
direct calls, and all other native methods unchanged. The S2v3 fixture gained
one independently executable abrupt-surplus control; the exact fixture
SHA-256 is
`92bd8d30a494c17e6d1e04c07c0498a51a61311a619303a48c1f5f2c7fc46efc`.

On Node 24.19.0 with one Vitest fork and a 2 GiB worker cap, the exact
63-control base/candidate pair is **48 pass / 15 fail → 58 pass / 5 fail**:
ten fail-to-pass transitions and no pass-to-fail transition. The current
receipts are
`.tmp/4016/focused-engine-s2v3b-baseline-44c2-2gb-20260927.log` (SHA-256
`34ee407d35504e68be7f1bc6fba10caa721adc2cc6ad8eaecfab56748af2d3ba`) and
`.tmp/4016/focused-engine-s2v3b-candidate-1fb196-2gb-20260927.log` (SHA-256
`71fbbc3152e5489880b4067d468c6b19bbcb676e2635c1a3516a4d6c0f6737e9`).
The three new gains are the existing ordinary borrowed surplus effect, the
existing borrowed receiver-abrupt order, and the new surplus-abrupt boundary.
They are focused compiler controls, not Test262 credit.

The maintained whole-assembly runner then executed the frozen 121-path
neighborhood manifest
`plan/agent-context/4016-split-neighborhood-20260927.txt` (SHA-256
`c01cf3440ad4c618e876013c31cc82894431bdcf1a2fa1e096f21954eebb734a`) as
one explicit standalone dynamic shard (`index=0`, `total=1`), QuickJS runtime
evaluation, pool size one, and the same 2 GiB caps. Both sides have complete
evidence: 121 registered paths, 121 canonical verdicts, 121 callbacks started
and settled, and zero exclusions. Completeness validation passed against the
same exact manifest on both sides.

- Base (`44c2fb086278cd6d0b24efdaa061112452f901f1`): **119 pass / 2 fail**;
  JSONL SHA-256 `9054587670af81949d2a0cb670fe1616cb148f2e3d7e362f5555dbd9ba35cc7e`.
- Candidate (`1fb196048b26b9a686eaf5a4719cc646a1d1353a` plus the uncommitted
  resumed source): **120 pass / 1 fail**; JSONL SHA-256
  `bd5182d347d1e19b583f401246d19f83af93c368c61df7646a88085d6bda82e0`.
- The sole row transition is unclassified/untagged
  `test/built-ins/String/prototype/split/separator-undef-limit-zero.js`,
  **fail → pass**. The remaining failure is Annex B ES2027
  `custom-splitter-emulates-undefined.js`, unchanged on both sides.

The 121-row manifest contains only 12 paths in the frozen ES2015 index. All
12 are **pass → pass**. Therefore this whole-assembly receipt proves no loss
inside the included ES2015 intersection, but it does **not** credit an ES2015
pass gain; do not present the unclassified row as an ES2015 completion.

Five ordinary focused red controls remain deliberately visible. Two are
historical refusal pins that fail on both arms and need semantic replacement
for upstream B6 rather than an expected-failure conversion. The others are:

1. raw-v1 direct-object member-call identity/order, where a statically native
   `receiver(): string` carrier turns the object into native `AnyString` null
   before split; `RequireObjectCoercible` must stay before arguments for real
   nullish receivers. The broader dynamic member-dispatch/return-carrier seam
   is outside this hunk (`src/index.ts:12641`,
   `control-flow.ts:545`, `type-coercion.ts:116,2724,2847`, and
   `call-receiver-method.ts:3331`);
2. host post-`ToPrimitive` Symbol, which still becomes invalid Wasm through the
   separately owned shifted `undefinedGlobalIdx` cache; and
3. the descriptor-before-split host `TypeError` boundary.

Do not move the ROC boundary after argument evaluation to make the first row
green, and do not patch the registry/global-cache or descriptor machinery in
this branch. The normal changed-root-test hook runs this ordinary-red fixture
and therefore currently fails; a finished/merge-ready PR is not defensible.
At most this state can be a clearly labelled draft checkpoint using the
repository-sanctioned slow-precommit policy, with the raw receipts and these
unresolved boundaries retained. No test is skipped, expected-failed, or moved
to obtain that status.

### 2026-09-28 final formatted checkpoint validation

The recovered merge checkpoint is now committed as
`ef0cad7dbe08458b9b3f23a9770ca23d65a56eac`, with the recovered checkpoint
and `44c2fb086278cd6d0b24efdaa061112452f901f1` as its two parents. The
working tree was clean before the final evidence run. The final formatted
candidate hashes are:

- `src/codegen/coercion-engine.ts`:
  `6804d725aff9f17a82195356ad59332df33673be2a929a351d22a4d331176ebb`;
- `src/codegen/expressions/calls.ts`:
  `641f39cf086d9f08dc64f403600cd6507947baf9167a621bc6c8827c50498665`;
- `src/codegen/string-split-coercion.ts`:
  `546d11e5a017f60f7d827fb5e10a006f4f5d6cc7056a2aaa4e9794268b59baf7`;
- the final S2v3b fixture:
  `92bd8d30a494c17e6d1e04c07c0498a51a61311a619303a48c1f5f2c7fc46efc`.

Normal fast pre-commit checks passed on that committed tree: lint-staged,
the LOC and function budgets against explicit base `44c2`, and the required
commit-message attribution. The sanctioned slow tier was skipped; that does
not turn the retained ordinary red assertions into passes.

Because Prettier changed `coercion-engine.ts` after the earlier 121-path
candidate receipt, the final candidate bundle and provider were rebuilt rather
than treated as source-identical. The official QuickJS artifact cache hit key
`2e2d7736713beeda` (Wasm SHA-256
`e9f8d30bc347dbc56f31b3389f7696eb6dedc9f05ea729781fc412f09a3e6b17`);
the final compiler bundle key was `116ca7f490f8c161`, and the newly compiled,
canary-verified adapter key was `f95dd8028e57742c`.

The same maintained one-shard runner, manifest, QuickJS lane, and 2 GiB
single-worker configuration then produced fresh final candidate evidence:

- final candidate JSONL:
  `benchmarks/results/issue4016-split121-candidate-results-4016split121candidatefinal20260928a.jsonl`
  (SHA-256
  `4e76229f9284767603ddfae37402adef3de6381135c5efdef0ce062c26673ac6`);
- runner result: **120 pass / 1 fail / 0 compile-error / 0 skip**, with the
  sole failure still Annex B ES2027 `custom-splitter-emulates-undefined.js`;
- completeness validation: **1 shard, 121 verdicts, 121 registered, zero
  explicit exclusions** (exit 0);
- exact comparison with the unchanged clean-`44c2` JSONL found no missing or
  extra paths and one transition only: the unclassified
  `separator-undef-limit-zero.js` row **fail → pass**;
- the 12 manifest members classified ES2015 remain **12 pass → 12 pass**.

This is fresh final-tree preservation evidence, not an ES2015 gain claim.

The post-merge changed-root command, with explicit `44c2` base, exited 1 as
intended by the current ordinary red fixture: `issue-1917` passed 16/16 and
the 47-test #4016 fixture passed 42 with the five residual assertions listed
above still red. Its receipt is
`.tmp/4016/changed-root-postmerge-ef0cad7d-20260928.log`. This transparent
failure prevents a ready-for-merge conclusion; a draft checkpoint may carry
the work without masking or weakening any of those assertions.

### 2026-09-28 proposed follow-up: stale standalone `undefined` global cache

This section remains source-proof provenance for the published checkpoint.
The implementation is now split into
[#6715 — standalone: shift the cached undefined singleton global index after a late host import](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6715-standalone-undefined-global-index-late-import-shift),
which has its own managed worktree, dedicated ownership record, and future PR.
No registry source belongs in this #4016 branch.

The earlier temporary, environment-gated host trace is a concrete but bounded
mechanism receipt. Immediately before `prepareHostRuntimeToPrimitive` inserted
the real host `"number"` string global, `numImportGlobals` was `0` and the
cached `undefinedGlobalIdx` was `11`. Immediately afterward,
`numImportGlobals` was `1`, while that cache still held `11`; slot 11 then
named `__symbol_counter:i32`. That type mismatch matches the retained host
failure (`global.get i32; extern.convert_any`). The trace did **not** print the
particular `canonicalUndefinedExternInstrs` body that later reaches Wasm
validation, so it proves a stale absolute cache rather than every link of the
failing emitted route. Its temporary tracing edits were removed byte-exactly;
the historical trace file named earlier in this issue is not a replacement for
a new paired measurement.

Current source inspection establishes why this is a credible narrow repair:

- `ensureAnyValueType` in `src/codegen/any-helpers.ts` records
  `ctx.undefinedGlobalIdx` as the absolute
  `ctx.numImportGlobals + ctx.mod.globals.length` slot for `__undefined`.
  `canonicalUndefinedExternInstrs` later bakes
  `global.get(ctx.undefinedGlobalIdx); extern.convert_any`.
- `addHostStringConstantGlobal` in `src/codegen/registry/imports.ts` inserts
  an import global and invokes `fixupModuleGlobalIndices` when module globals
  already exist.
- `fixupModuleGlobalIndices` shifts emitted `global.get`/`global.set`
  instructions and comparable cached module-global indices
  (`newTargetGlobalIdx`, `holeGlobalIdx`, the Symbol registry globals, and
  others), but currently omits `undefinedGlobalIdx`.

The dedicated #6715 candidate change is one guarded cache update in
`fixupModuleGlobalIndices`: when the cached
`undefinedGlobalIdx` is at or beyond the same `threshold`, add the same
`delta`. It must not rewrite the global-index walker, rebuild helper bodies,
add a source-order workaround, alter `context/types.ts`, or touch IR/layout
code. Existing emitted bodies remain the responsibility of the established
walker; this slice only keeps the later cache lookup synchronized with it.

Fresh regression plan, after a coordinated execution slot:

1. Add a focused codegen regression that reserves `__undefined`, inserts a
   late host string import, then emits canonical undefined. It must prove that
   the later `global.get` names an `anyref`-compatible `__undefined` slot, not
   the adjacent `__symbol_counter:i32` slot, and that the module instantiates.
2. Re-run the existing host post-`ToPrimitive` Symbol-limit control together
   with its positive undescribed-Symbol construction control. It must invoke
   the Number hint once, reject with a JS-visible `TypeError`, and not reach
   `extern.convert_any` validation; the separator must remain uncoerced after
   that abrupt completion.
3. Pair the changed fixtures against a clean common base and retain the
   existing host dynamic-undefined/raw-null and standalone native-Symbol
   controls. Record exact source/fixture hashes and all transitions; a green
   compile alone is not sufficient evidence.

This is the next real semantic candidate among the five focused residuals.
The direct-object receiver needs broader dynamic return-carrier/member-dispatch
work, the descriptor failure belongs to the existing descriptor-runtime
boundary, and the two historical `@@split` refusal pins are stale after B6
protocol dispatch and need positive semantic replacements rather than a
cosmetic expectation update.

### 2026-09-28 compiler-boundary inventory registration

The draft PR's completed `quality` job found one separate mechanical blocker:
`src/codegen/string-split-coercion.ts` was absent from
`scripts/compiler-boundaries.json`. The checker consequently reported one
unclassified module and two unclassified targets—exactly the two imports from
the already-classified `string-search-value.ts` and `string-proto-split.ts`.

The registration is not merely copied from its neighbours. This helper accepts
the legacy `CodegenContext`/`FunctionContext`, stages compiler-originated
values, allocates locals and defined helpers, and provisions native runtime
imports while also consuming Wasm instruction types and an IR integer-coercion
emitter. It therefore genuinely spans AST/context-driven generation and the
physical WasmGC runtime seam: existing migration policy classifies that shape
as `unmigrated` `mixed-needs-split` debt with `backend-wasmgc` as its eventual
destination. The new record uses exactly that established layer, owner, and
next-boundary policy. It does not add a layer, relax an edge, or change source
semantics.

The CI artifact is `compiler-boundaries-36355885419-1` (id `10944515410`).
Lint, format, and typecheck completed successfully; omitted Biome diagnostic
text in the aggregate job log is not a second failure. The registration still
needs the ordinary quality rerun when the coordinated execution slot returns.
The scoped static inventory check exited 0 with `errors: []`, zero untracked
modules, and the expected `inventory-valid-architecture-incomplete` status; it
is the only local validation required before normal commit/push hooks, not a
compiler or conformance claim.

## 2026-09-20 reopened: observable split coercion order

The original refusal-removal slice completed on 2026-08-02. A remaining
plain-search-value correctness defect reopens this issue; none of the earlier
measurements below are being withdrawn or relabelled as current measurements.

### Evidence and scope

The frozen **standalone, FYI original-harness** census at
`f3520ca177960f49c006edc3fd7acce8bebf58d9`, Node 25.9.0, reports
`built-ins/String/prototype/split/limit-touint32-error.js` failing because
separator coercion throws `Test262Error` before limit coercion can throw the
expected `ExpectedError`. Receipt:
`/private/tmp/js2-4444-full-es2015-manifest.i16PO6/full-f352.json`.
This is a historical failing row, not a candidate or current-main rerun.

Source inspection at verified upstream
`de232b80e43dc82c2fafc331cc10d658f26a8897` finds the corresponding order in
`tryCompileStandaloneSplitSeparator` (`src/codegen/string-search-value.ts`):
`emitReceiver`, then `emitArgAsNativeString(separator)`, then `emitLimit`.
Its comment calls the deviation non-observable, but the original test supplies
two throwing coercions specifically to observe it. Attribution still requires
an exact-current baseline and emitted-route proof: the error signature alone
does not prove which emitter the original selected.

The reflective body in `src/codegen/string-proto-split.ts` already places limit
coercion before separator coercion. Do not change that order or conflate this
repair with the separate missing custom `@@split` dispatch. The census also
contains custom-protocol failures, so the old out-of-scope note's assertion
that those rows are absent from goal scope is historical, not true of the
current ES2015 manifest.

### Implementation plan

1. In this isolated branch, reproduce the exact original with a passing split
   control under the same maintained lane on clean base. Trace the admitted
   direct plain-value route; leave expectations and original source unchanged.
2. Separate expression evaluation from coercion. Evaluate receiver, separator,
   limit, and every trailing argument exactly once in call-site order into raw
   locals. For a direct nullish member base, retain the member-access
   `RequireObjectCoercible` boundary before any argument evaluation; after the
   ordinary argument list has run, perform strict `ToString(this)`, limit
   `ToUint32`, then strict
   `ToString(separator)`. The narrow shared value-level seam lives in
   `string-split-coercion.ts` and is reused by the existing reflective split
   closure; it receives an already-staged externref, performs
   `ToPrimitive(number)` plus the existing exact IEEE-decomposition
   `ToUint32` lowering, and never reconstructs an AST expression. Reuse
   `emitStringProtoToStringFlat`
   with post-primitive Symbol rejection. Do not change IR, context types,
   layouts, global coercion policy, custom `@@split` dispatch, or the existing
   string-like direct arm.
3. Preserve the undefined-separator arm's observable argument evaluation and
   the zero-limit rule (separator coercion still precedes the empty result).
   `compileStringIntegerArg` is a `ToIntegerOrInfinity`/saturating-index helper,
   not a reusable `ToUint32` operation; do not use it for this staged limit.
   Keep modulo wrapping, Symbol rejection, and object `ToPrimitive(number)` in
   the extracted reflective-path operation.
4. Add unannotated controls distinguishing expression effects from receiver,
   limit, and separator coercion; throwing limit versus throwing separator;
   zero limit; explicit undefined; finite fractional/negative limits; a finite
   `2**64` modulo control; and independent Symbol-limit/Symbol-separator
   boundaries. Include reflective controls so fixing the direct path cannot
   conceal a loss in the other route.
5. Validate exact original + same-base controls, focused tests, and the complete
   ES2015 split-family intersection. Record every transition, count and source
   revision; do not extrapolate a whole-suite gain. Run normal repository hooks
   before opening one ready upstream PR for this completed fix. An unfinished
   checkpoint remains draft.

### Handoff

Preparation worktree: `/private/tmp/js2-4016-split-coercion-order-20260920`,
branch `codex/4016-split-coercion-order-20260920`, base `de232b80e4`.
Source-only draft currently changes `string-search-value.ts`, the raw receiver
seam in `string-ops.ts`, and the extracted shared staged limit operation in
`string-split-coercion.ts` / `string-proto-split.ts`. No compiler, test, build,
hook, commit, or push has run in this worktree. The direct arm provisions every
helper, `__str_split`, the result vec/array type, the strict ToString helpers,
and both string hint constants before it stages user operands. It reserves only
stable type indices at that point; arbitrary receiver/argument compilation can
add late imports, so it re-resolves all numeric function indices after raw
staging/externalization and the direct receiver's ROC boundary. A post-
evaluation missing helper is an internal compilation failure, never a fallback
that evaluates the call again.

The direct raw-argument path has an exact-undefined predicate distinct from
the reflective closure ABI's padded-argument predicate: explicit `null` must
reach `ToNumber`/`ToUint32(0)`, while an omitted or canonical-undefined limit
is unbounded. The reflective closure keeps its historical null-as-omitted
conflation because its ABI carries no presence bit. Focused controls include
explicit-null direct semantics, a native-string host `void Date.now()`
undefined-separator late-import case, and guarded-`any` primitive-string
receivers for the undefined and plain-separator arms.

`String`-wrapper receiver overrides arrive from `call-receiver-method.ts` after
their own upstream `ToPrimitive(string)` bridge, so they cannot prove the new
raw receiver-versus-argument coercion order. This draft preserves their
existing admission rather than turning supported guarded overrides into
refusals; wrapper receiver ordering remains a separately measured residual.

### 2026-09-20 source-review correction: finite `ToUint32`

The first extracted draft copied the reflective body's `i64.trunc_sat_f64_s`
plus `i32.wrap_i64` shortcut. Source inspection proves that shortcut is wrong
for finite magnitudes at or above `2**63`: for example, `ToUint32(2**64)` must
be `0`, while saturation followed by wrapping yields `-1`. The direct and
reflective paths must not claim complete `ToUint32` coverage from that shortcut.

The shared staged operation now delegates to the existing
`emitWasmInt32Coercion` IEEE-754 decomposition used by `__toUint32`, which is
documented in `src/ir/backend/wasm-int32-coercion.ts` as avoiding that exact
saturation-before-wrap defect. This is source-level evidence only until the
focused finite-large control runs. The dedicated `2 ** 64` split-limit control
is therefore retained as an independently attributed acceptance check, along
with fractional and negative finite controls; do not collapse its result into
the original abrupt-order receipt or silently mark it expected-failing.

Node 24 reference probes (outside the compiler/test lease) establish expected
values only: explicit `null` limit and `2 ** 64` both yield length `0`;
`1.9` yields length `1`; `-1.5` yields length `3`; an ordinary primitive
receiver observes receiver/separator/limit/extra evaluation before
limit/separator coercion (`rsleLS`) and yields length `2`; a Symbol returned by
separator conversion still throws under a zero limit; and a null direct member
receiver throws before its argument side effect. These are native-JS reference
expectations, **not** candidate compiler passes or a substitute for a leased
standalone receipt.

The exact frozen ES2015 split-family intersection contains **12 originals**
(historical FYI result: **8 pass / 4 fail**). Its local preparation manifest is
`.tmp/4016-root-es2015-split-paths.txt`, SHA-256
`16e3ad56f9b75acf1403a9f6b2258717c95c4d96b86672ee7ea39a893f5b390f`.
The four historical failures are `cstm-split-get-err.js`,
`cstm-split-invocation.js`, `limit-touint32-error.js`, and
`this-value-tostring-error.js`. The eight passing rows include
`valueOf-is-called-for-limit-argument.js`; preserve that ordering control.
Implementation is queued for a Terra Max agent in this worktree after its
current bounded task. The #6648 regression repair and #4759 active validation
retain priority; acquire the shared compiler lease before any test/build/hook.

### 2026-09-20 paired validation receipt — implementation remains blocked

Both comparison worktrees were detached at
`de232b80e43dc82c2fafc331cc10d658f26a8897`. The baseline fixture was copied
byte-for-byte from the candidate solely to run the same assertions against
unchanged source; its SHA-256 in both worktrees was
`f3faca3de08df2e7a04ea49b9a6f48415ddc4ee7ad74cb92849915841e8092da`.
The 12-row manifest was also copied byte-for-byte at the recorded
`16e3ad56...f5b390f` SHA. Both worktrees were provisioned from the canonical
`/Users/thomas/Code/js2` dependency and Test262 trees before the leased runs.

The first focused baseline log is retained separately as a **zero-executed
fixture syntax setup failure** (an unescaped backtick inside an embedded source
comment); it is not semantic evidence. The corrected one-worker receipts are:

- baseline focused: 28 pass / 6 fail,
  `/private/tmp/js2-4016-split-coercion-order-baseline-20260920/.tmp/4016/focused-baseline-de232b80e4-valid-20260920.log`;
- candidate focused: 31 pass / 3 fail, source-files SHA-256
  `3bdefa1e78b04d224a27f1c1b9fb7675d174e2a1f40d0e6655105cdbf3ac2cac`,
  `/private/tmp/js2-4016-split-coercion-order-20260920/.tmp/4016/focused-candidate-de232b80e4-valid-20260920.log`.

The focused transition is **4 baseline failures → pass, 1 baseline pass →
failure, and 2 failures retained**. The gains include the abrupt limit-before-
separator ordering control, undefined/extras evaluation, the post-primitive
Symbol separator boundary, and the finite `2 ** 64` ToUint32 control. The
native-string host late-import control is the new pass→fail: after its ordinary
TypeScript overload diagnostic, candidate codegen reports an unresolved
`funcIdx=undefined`; this blocks publication. The two retained failures are a
complex receiver-order Wasm exception and a Symbol-limit path that still fails
to throw. Do not relabel these residuals as expected failures or remove their
assertions.

The maintained exact original runner (`node --import tsx
scripts/run-test262-paths.mts <manifest> --standalone --isolate`) gives
`limit-touint32-error.js` **0P/1F baseline → 1P/0F candidate**:
`original-limit-touint32-{baseline,candidate}-de232b80e4-20260920.log` in the
respective `.tmp/4016` directories. The frozen 12-row cohort gives **8P/4F
baseline → 9P/3F candidate** with only that original improving and no cohort
pass loss:
`split12-{baseline,candidate}-de232b80e4-20260920.log`. These results validate
the narrow original gain but do not approve this branch while the focused host
regression exists.

### 2026-09-20 host compatibility dependency repair (source-only)

The host regression is not yet a descriptor-semantics conclusion. A temporary
catch-boundary diagnostic on the exact native-string host control recorded the
first unresolved target in `__defineProperty_value`, at
`body[21].else[9].then[36].then[17].then[5]`, with the resolver stack ending in
`ir-inline.ts`. Its durable receipt is
`.tmp/4016/host-undefined-funcidx-catch-diagnostic-de232b80e4-20260920.log`
(SHA-256 `285d020f1bb167cb05bc94d0b466467a42de5e38f60efcb32607a63f316a1895`).
The trace was removed byte-exactly from `src/codegen/index.ts` afterward.

Source mapping makes the callee high-confidence: the only `__object_is` call
in `__defineProperty_value` is the S4 non-configurable, non-writable,
data-value SameValue preflight in
`object-runtime-descriptors.ts:485–492`; its nested `else`/`then` structure
matches the diagnostic path. `object-runtime-enumeration.ts` supplies the
native provider only for `semanticProviders === "native-first"`, while the
host compatibility import list does not supply it. The default GC profile with
`nativeStrings: true` remains `host-assisted`, so the newly admitted direct
split preflight can mint the descriptor helper with an undefined target.

The first repair experiment reserved and flushed canonical host
`env::__object_is : (externref, externref) -> i32` before calling
`ensureObjectRuntime`. It was deliberately narrow and left native-first output
unchanged, but the follow-up scan below proved that it was insufficient. The
descriptor-before-split fixture remains a semantic compile/instantiate/runtime
witness in this fix's focused suite, but its implementation-specific assertion
that `__object_is` must be imported is removed. It exercises the wider
compatibility descriptor/proxy family and must be attributed against base if it
still fails; it is not proof that the direct split repair should provision that
family. Neither the experiment nor the revised assertion claims universal
SameValue correctness for opaque WasmGC values. The strict Symbol-limit
residual remains separately red until the host-only path is measured.

### 2026-09-20 follow-up: host compatibility boundary remains blocked

The narrow `__object_is` reservation repaired the *first* observed descriptor
dependency, but did not repair the host control. Two targeted candidate
controls still ended in `absoluteFuncIndex: unresolved call target
(funcIdx=undefined)`. A second temporary catch-boundary scan, removed
byte-exactly after its one leased run, recorded `__object_is=0` as present and
instead found two malformed defined-call owners:
`__proxy_ownkeys_keys_dispatch` and `__proxy_ownkeys_names_dispatch`, both at
`body[12].else[36].body[0].body[14].body[0].body[9]`. Receipt:
`.tmp/4016/host-undefined-funcidx-all-owner-diagnostic-de232b80e4-20260920.log`.
This is evidence that the newly introduced unconditional
`ensureObjectRuntime` reaches a wider compatibility-proxy family; it is **not**
evidence that either proxy helper or general object runtime should be
provisioned for split.

The replacement candidate is deliberately narrower and has not yet been
compiled. In the host-assisted native-string arm, which currently admits only
a definitely-undefined separator (plain object separators remain
`noJsHost`-only), do not call `ensureObjectRuntime` or the generic native
`emitStringProtoToStringFlat` path. Preflight only these host-compatible
dependencies before operand staging:

- `__to_primitive(externref, externref) -> externref` and
  `__unbox_number(externref) -> f64` for `ToNumber(limit)`;
- a **real host** `"number"` global from `addHostStringConstantGlobal`, never
  `stringConstantExternrefInstrs`' opaque `$AnyString` carrier (the host
  runtime's hint comparison is by real JS string);
- host `__extern_is_undefined` plus a small defined exact-undefined predicate
  that also applies `buildIsUndefinedExternBody` to the native singleton.
  This preserves raw `null !== undefined`, including a limit that crosses from
  host code as actual JavaScript `undefined`, without pulling in the object
  runtime.

The host arm retains RequireObjectCoercible using that exact predicate and the
existing catchable TypeError constructor, then handles its direct native
receiver as the pre-existing `$AnyString` carrier and flattens it. It must not
send that opaque carrier to host `__to_primitive`. The separator expression has
already been evaluated once; because this arm is admitted only for a proven
`undefined`, its `ToString(undefined)` has no further observable operation.
The limit uses the real host `"number"` hint, then host `__unbox_number`, whose
ordinary `Number(Symbol)` behavior rejects both a bare Symbol and one returned
by `ToPrimitive`.

`__extern_toString` is not a substitute for this plan: it invokes primitive
`.toString()` before `String(...)`, so prototype overrides make it too weak for
abstract ToString. The host `__concat_3` import does use `String(primitive)`
and explicitly rejects Symbols, so it is the candidate strict renderer only if
a future slice admits an arbitrary host separator after `ToPrimitive(string)`.
It is intentionally not added to this undefined-separator repair, avoiding
both a broader admitted surface and an unproven opaque-native-carrier crossing.

The next bounded comparison, after source review and a lease grant, is the
existing minimal host witness `"abc".split(void Date.now(), 0)` plus matched
dynamic-undefined and explicit-null limit controls. It must record the same
fixture/source hashes on candidate and base. No proxy/runtime/IR expansion,
test expectation relaxation, or publication claim follows from this plan.

### 2026-09-20 targeted host receipt correction: described-Symbol probes were confounded

The first host-only candidate receipt passed the minimal undefined-separator
control and the dynamic-undefined-versus-raw-null control, removing the prior
unresolved-call failure on those paths. Its matched clean-`de232` fixture
instead returned `0` for the dynamic/null control. The descriptor-before-split
semantic witness failed identically on candidate and base in
`_normalizeDescKey(String(key))`; it is a retained host descriptor boundary,
not a new split-provider regression. The witness stays in the focused suite
without the superseded implementation-specific `__object_is` import assertion.

The two original Symbol-limit probes used `Symbol("limit")`. A catch-free
candidate diagnostic proved that both escaped at host symbol-description
registration (`symbolDescRegistry.set(id, String(desc))`), before direct split
or `ToNumber` limit coercion. Their prior `instanceof TypeError` failure
also re-entered an opaque native-error bridge. Therefore those receipts are
**not** evidence that the new host limit path correctly rejects Symbol, and no
such claim is made here. They remain preserved diagnostic logs:
`host-provider-targeted-candidate-de232b80e4-20260920.log`,
`host-provider-targeted-baseline-de232b80e4-20260920.log`, and
`host-provider-symbol-raw-error-candidate-de232b80e4-20260920.log`.

The replacement matched fixture constructs `Symbol()` without a description
as an independent positive control, checks the bare Symbol rejection at the
JS/Wasm boundary, and uses a precreated no-description Symbol returned by
`[Symbol.toPrimitive]` while checking one `"number"`-hint callback. It must
be measured on both base and candidate before strict-Symbol behavior is
credited. This is an instrumentation correction only; it makes no compiler
source change.

### 2026-09-20 exact post-`ToPrimitive` instantiation blocker

The corrected same-fixture pair establishes two host-arm gains: dynamic
`undefined` versus raw `null` is now distinct, and an undescribed bare
`Symbol()` limit escapes as the required JS-visible `TypeError`. It does
**not** establish the post-`ToPrimitive` case: that candidate fixture fails
at instantiation with `extern.convert_any expected anyref, found global.get of
type i32`. The matching base returns normally instead. The descriptor witness
remains an unchanged base/candidate failure.

One temporary, env-gated post-`ToPrimitive` trace gave a concrete stale-cache
receipt without changing emitted semantics:
`host-provider-post-toprimitive-global-trace-candidate-de232b80e4-20260920.log`.
Immediately before the new real host `"number"` string import,
`numImportGlobals = 0` and `undefinedGlobalIdx = 11`. After the import,
`numImportGlobals = 1` but `undefinedGlobalIdx` remained `11`, which now
resolves to `__symbol_counter:i32@11`. This matches the invalid
`global.get i32; extern.convert_any` shape. The trace did not print a
`canonicalUndefinedExternInstrs` emission line, so it proves the stale cached
slot—not the exact undefined-emitter body that reaches validation. All trace
edits were removed byte-exactly after the one run.

The bounded repair candidate is an `undefinedGlobalIdx` shift in
`fixupModuleGlobalIndices`, alongside its other absolute module-global cache
updates. It requires explicit ownership clearance and a new paired measurement;
do not use a source-order workaround or broaden the general relocation logic.

### 2026-09-20 source-only follow-up: standalone post-`ToPrimitive` Symbol limit

This is a separate native/standalone correction, not a workaround for the
host-only stale-global diagnostic above. The staged limit helper currently
performs `__to_primitive(limit, "number")` followed by `__unbox_number`.
The latter must remain permissive because ordinary property-key probes use it
to classify nonnumeric keys; therefore an object whose `@@toPrimitive` returns
a `$Symbol` carrier can reach `ToUint32` as `NaN` instead of throwing the
required §7.1.4 `TypeError`.

The approved source-only draft in `string-split-coercion.ts` mirrors the
canonical `tonumber-fast-paths.ts` guard in this one consumer: for the
standalone native-provider lane it reserves the `$Symbol` carrier and native
`TypeError` constructor/message before any direct caller stages operands. At
the value-level emission boundary it saves the post-`ToPrimitive` externref,
tests the carrier, throws `Cannot convert a Symbol value to a number` when it
matches, and only then calls `__unbox_number`. Function handles are still
recaptured after arbitrary staged expressions. The host-assisted limit path is
unchanged; the immutable host diagnostic receipts and their source-hash
attribution above remain separate from this native draft. No registry,
context, IR, layout, or global `__unbox_number` behavior changes are proposed.
For clarity, the retained host post-primitive diagnostic variant remains tied
to its pre-follow-up source hashes: `string-search-value.ts`
`7701724bc72c7a761837e0461d6c786138747a9befb0e94718d722667c8babda`,
`string-split-coercion.ts`
`97f98d75fb9e0bd2001909988a6a8dbdd9da72706f72a57acf62107cde893f5f`, and
`string-proto-split.ts`
`9d9ea588fcc23cc0ccf7bcaaae11977c194b159a4a6753578aec49629201bde1`.
Those historical variant hashes are evidence labels, not hashes for the
current native draft.

The standalone controls use **undescribed** `Symbol()` values so
the known description-provider boundary cannot satisfy a conversion assertion:

- a positive Symbol-construction control;
- an object `@@toPrimitive` that returns a precreated Symbol, with one
  observable `"number"`-hint callback; and
- the same dynamic limit with a separator `toString` counter, proving that the
  limit's abrupt completion prevents separator coercion.

These controls are not expected-failure pins. Their first matched Node 24,
single-fork receipt used byte-identical fixture SHA
`49ab2f32f2a2fb3f5e04c7335008acb21576ed427f423593444793e9c0111353` on
clean `de232` and the candidate: baseline **2 pass / 3 fail** and candidate
**5 pass**. The three flips are the direct Symbol limit, the post-primitive
Symbol limit that must suppress separator coercion, and the zero-limit
Symbol-returning separator. The positive construction control and the
post-primitive callback/hint control already passed on baseline, so they are
preservation evidence rather than newly attributed gains. No selected passing
control regressed.

The frozen 12-row ES2015 split preservation cohort supplies the broader
non-loss check. Its manifest is
`.tmp/4016-root-es2015-split-paths.txt` (SHA
`16e3ad56f9b75acf1403a9f6b2258717c95c4d96b86672ee7ea39a893f5b390f`), with
the maintained Node 24 command
`node --import tsx scripts/run-test262-paths.mts <manifest> --standalone --isolate`.
The existing compatible clean-`de232` baseline receipt is **8 pass / 4 fail**;
the candidate receipt is **9 pass / 3 fail**, retaining the same three
custom-`@@split` residuals. It is compatible by base, Node version, command,
isolate mode, and manifest hash, so it is reused rather than needlessly
rerunning unchanged base source. This cohort's one historical flip is the
earlier `limit-touint32-error.js` ordering improvement; it is not attributed
to this Symbol guard.

The candidate cohort log originally printed the pre-cycle-removal source hash
`4991dae970f296aaea19eea52cf244eb8bce5a22b75614ed04c8159b1d9e3f0f` in its
header. The log is preserved and has an appended correction receipt: the
actual candidate `string-split-coercion.ts` hash at launch/current terminal
check was
`ed7f9af98d71a5e7712f790039728164fccee847c0e66e97b56514a55d3f787b`.

The pending `undefinedGlobalIdx` relocation ownership decision still governs
the separate host post-primitive fixture; do not merge its outcome into this
native acceptance claim.

### 2026-09-20 raw full-42 A/B audit and fixture correction

Before the raw comparison, both isolated #4016 worktrees fast-forwarded from
`de232b80e43dc82c2fafc331cc10d658f26a8897` to
`ac76d8c6cd63864e04de4592a5179050ff1b1f91`. The target diff was empty across
the six owned paths, so the candidate's dirty sources, tests, handoff, and
receipts—and the baseline's byte-identical focused fixture and receipts—were
retained without a stash or reset. The raw fixture is SHA
`49ab2f32f2a2fb3f5e04c7335008acb21576ed427f423593444793e9c0111353`, preserved
before any correction as immutable Git blob
`6a182414d4cdb4c5b1511e055740314d75734497`.

The raw Node 24 single-fork pair at common `ac76…b1f91` had exact 42-name set
equality: clean baseline **31 pass / 11 fail**, candidate **39 pass / 3 fail**,
or **8 fail-to-pass / 0 pass-to-fail**. The eight measured flips were:

- limit abrupt completion before separator `ToString`;
- supplied-`undefined` evaluation plus `ToUint32` wrapping;
- dynamic `undefined` versus raw `null` in the host undefined-separator arm;
- bare undescribed host Symbol limit rejection;
- direct native Symbol limit rejection;
- suppressing separator coercion after a native limit becomes Symbol;
- Symbol-returning separator rejection even with zero limit; and
- finite `ToUint32` modulo reduction above the inherited i64 range.

This raw 42-result is **not a valid conformance or publication denominator**.
Its first S2 row asserted that a direct call on an object possessing only
`@@toPrimitive` should reach `String.prototype.split`. Node 24 proves the
opposite: `receiver(...).split is not a function`, after all four expression
evaluations (`order === 1234`). The candidate JSON records that failure as
`failureMessages: [null]`; it is therefore not evidence of a compiler
receiver trap and must not be called a residual. The oracle correction is
preserved in `.tmp/4016/root-receiver-oracle-correction.md`.

The raw candidate's two actual unresolved failures remain verbatim:

- host post-`ToPrimitive` Symbol: `CompileError: WebAssembly.instantiate():
  Compiling function #56:"f" failed: extern.convert_any[0] expected type
  anyref, found global.get of type i32 @+22244`; this is the unresolved
  stale-`undefinedGlobalIdx` cache defect, a change from the previous wrong
  result—not a corrected conversion outcome; and
- descriptor-before-split: `TypeError: Cannot convert object to primitive
  value` at `_normalizeDescKey`, the retained host descriptor boundary.

The current fixture remains **raw-v1 (42 controls)**; no wrap-up test edit was
made. A future corrected fixture must retain the direct-object TypeError/order
control as a separately versioned semantic observation, then add Node-verified
valid direct-primitive (`1234672`) and borrowed receiver (`12345672`) controls
plus borrowed-nullish and receiver-`ToPrimitive`-abrupt boundaries. It needs a
fresh matched A/B pair on the then-current common base; no historical raw42
count can be reused as its denominator.

At the raw A/B run, candidate source provenance was
`string-search-value.ts`
`7701724bc72c7a761837e0461d6c786138747a9befb0e94718d722667c8babda`,
`string-proto-split.ts`
`9d9ea588fcc23cc0ccf7bcaaae11977c194b159a4a6753578aec49629201bde1`,
`string-split-coercion.ts`
`ed7f9af98d71a5e7712f790039728164fccee847c0e66e97b56514a55d3f787b`, and
raw-v1 fixture `49ab2f32f2a2fb3f5e04c7335008acb21576ed427f423593444793e9c0111353`.

The draft checkpoint subsequently removed one redundant TypeScript object
literal discriminant before a spread that already supplies the same
`kind: "native"` value; the normal pre-push `TS2783` gate rejects the duplicate
property even though the emitted runtime object is unchanged. The current
checkpoint source hashes are `string-search-value.ts`
`7b7511b4f1e08a8725246adf869e618bbb659943f4799e2e251fa6b6c3f6a49b`,
`string-proto-split.ts`
`85fdde472d451a01ce45af0725df9479daf82eff39f8a58504cb2f4573bce36f`, and
`string-split-coercion.ts`
`3c6275a4bc6db55c43af1ce77e1aed60c820effcb6d9fac6e5a1cc33ecbf5f5c`.
The raw receipts retain their launch-time hashes above; neither the typecheck
correction nor hook formatting is substituted into their evidence claim.

Publication is not ready as a merge-ready fix: in addition to the pending
registry ownership clearance, the only full-suite receipt has an invalid oracle
row and exits nonzero; the corrected suite needs its own A/B result and normal
scoped gates. The two host residuals above must remain visible—no forced
expected-failure conversion or source-order workaround is authorized. The
earlier `de232` receipts remain historical attribution evidence, not this
corrected suite's baseline.

### 2026-09-20 draft checkpoint publication

The current branch is intentionally publishable only as a **draft checkpoint**.
It preserves the six owned source/test/handoff paths and raw-v1 fixture without
repairing that fixture's invalid direct-object expectation or altering any
assertion to make the branch green. The draft PR must prominently retain all of
the following before it can be reconsidered for review or merge:

- raw-v1 is evidence, not a valid conformance denominator; immutable fixture
  blob `6a182414d4cdb4c5b1511e055740314d75734497` and the original A/B JSON
  receipts remain reproducible;
- the corrected receiver controls require a new versioned fixture and a fresh
  matched A/B run on a common base;
- the host post-`ToPrimitive` invalid-Wasm error awaits separately owned
  `undefinedGlobalIdx` relocation work; and
- the descriptor-before-split host boundary remains an ordinary unresolved
  result, not an expected-failure pin.

`src/codegen/string-ops.ts` is allowed its measured five-line LOC growth for
the existing native string-call boundary only: `emitRawReceiver` keeps the
new staged split entry point from prematurely flattening a raw receiver, and
the adjoining comment records the already-coerced wrapper limitation. The
decision and coercion implementation remain in the new subsystem helper; this
allowance is not permission for additional split logic in the god-file.
The matching five-line `compileNativeStringMethodCall` allowance covers the
same boundary and avoids duplicating the shared caller just to satisfy a
mechanical split; it does not raise the budget for any other function.

For this unfinished checkpoint, repository-sanctioned
`SKIP_SLOW_PRECOMMIT=1` may be used for the documented slow known-red
pre-commit portion, while all normal pre-push checks still run. No
`--no-verify`, test weakening, merge-queue action, or ready-for-review claim is
authorized.

## Problem

In `--target standalone`, six `String.prototype` methods share one refusal:

```
Codegen error: String.prototype.<m>(...) with a RegExp or symbol-protocol search
value is not supported in --target standalone (#1474).
```

It fires from `src/codegen/string-ops.ts` for `match` / `matchAll` / `search`
unconditionally, and for `replace` / `replaceAll` / `split` whenever the first
argument is not *statically* a string.

**The refusal conflates two different things.** Every one of these methods
begins the same way (§22.1.3.11/.12/.13/.14/.19/.23, step 2 in each): *if the
search value is neither `undefined` nor `null`, `GetMethod(searchValue,
@@<protocol>)`, and if that is not `undefined`, call it.* Only when that lookup
comes back `undefined` does the method fall through to its own **string** path:

| method | fall-through when there is no `@@` method |
| --- | --- |
| `split` / `replace` / `replaceAll` | `ToString(searchValue)` — a plain string operation, **no regex at all** |
| `search` / `match` | `RegExpCreate(ToString(searchValue), undefined)` |
| `matchAll` | `RegExpCreate(ToString(searchValue), "g")` |

So "the argument is not a statically-known backend RegExp" is *not* the same
question as "this needs a JS host". `"a1b".split(123)` needs no regex engine and
no host; `"abc".search("b")` needs a regex built from a runtime string — and the
standalone backend has had a **runtime pattern compiler** since #2161
(`ensureDynamicStandaloneRegExpCompiler`, the same one `new RegExp(dynamicSrc)`
goes through). Verified before writing any code: a standalone probe doing
`new RegExp("A" + "B").exec("ssABB")` returns `["AB"]` at index 2.

### Measured population — stamp every number with this

| | |
| --- | --- |
| Baseline | `test262-standalone-current.jsonl`, `--force`-refetched |
| `oracle_version` / lane | 12 / `honest` |
| Row timestamps | `1.8.2026, 22:26:58` → `22:32:46` |
| Rows / bad JSON / duplicate `file` keys | 48,619 / 0 / 0 |
| Official scope | **43,505 run / 25,929 pass (59.6 %)** |
| Goal scope (`es5id` present, or none of `es5id`/`es6id`/`esid`) | **8,545 run / 6,242 pass (73.0 %) / 2,303 non-pass** |
| Corpus files that failed to open | **401** — all newer-proposal areas (Iterator helpers 140, `AsyncDisposableStack` 52, `Promise.allKeyed` 39, …). The baseline's test262 checkout is NEWER than `/workspace/test262`. **0 of them are in this population**, and none carry `es5id`, so goal scope is unaffected (it reproduces the census's 8,545 exactly). |

Population = official rows, non-pass, whose `error` matches the refusal string:

- **99 files** all-official — `search 25 · match 20 · split 19 · replace 17 · matchAll 11 · replaceAll 7`
- **43 files** in goal scope
- Negative control: the refusal is absent from 17,477 of the 17,576 official
  non-pass rows, so the detector is not vacuous.

### What this REFUTES about the framing it was dispatched under

1. **The "51 files in goal scope" figure does not reproduce.** Cutting goal
   scope by the refusal string directly on a 5.5 h fresher baseline gives
   **43**. The "~98 all-official" figure does reproduce (**99** now).
2. **The overlap with the census's RegExp buckets is ≤ 2 files, not unknown-and-large.**
   Only 2 of the 99 live under `built-ins/RegExp/` (both
   `named-groups/groups-object-subclass*`) and 1 under `built-ins/JSON/`; the
   other 96 are under `String/prototype`. The census's *RegExp unsupported
   pattern/arity* bucket (21) is Tier-1, keyed on a **different** refusal
   string, so it is disjoint by construction — a row carries exactly one error.
   *RegExp engine semantics* (68) is Tier-2 and the census is an ordered
   first-match-wins partition, so no file can be in both. **Nothing here should
   be discounted for double-counting beyond those 2.**
3. **This is not one cluster, it is two mechanisms with very different costs**,
   and the goal-scope half is almost entirely the *cheap* one. Of the 99, the
   ~40 `cstm-*` / `custom-*-emulates-undefined` files are genuine
   `GetMethod(@@protocol)` **dispatch on a user object** — and **not one of them
   is in goal scope** (they are all `esid`-tagged ES6+ tests). Every one of the
   43 goal-scope files is the plain-`ToString` arm.
4. **`replace`/`replaceAll` is NOT reachable by removing this refusal**, even
   though it contributes 24 files to the population. Measured on a standalone
   probe: `"gnulluna".replace("null", function(a1,a2,a3){return a2+"";})` —
   which uses the *already-supported* string search value — fails today with
   `RuntimeError: illegal cast`. **Function replacers are a separate,
   pre-existing defect.** 7 of the 8 goal-scope `replace` files pass a function
   replacer (two of them via `Function("…")`, i.e. also blocked on #2928), so
   widening the gate here would convert a loud compile-time refusal into a
   runtime illegal cast. `replace`/`replaceAll` therefore keep the refusal.

## Fix

Split the one conflated question into the two the spec actually asks.

### 1. `TypeOracle.wellKnownSymbolMemberOf` (`src/checker/oracle.ts`)

The gate needs "can this value carry `@@split`?", which no existing oracle fact
expresses (`factOfType` returns a bare `{kind:"object"}` with no shape). Rather
than reach for the raw checker in `src/codegen/**` — which is exactly what the
#1930/#3273 ratchet exists to stop — the question is added to the oracle, where
it belongs. It is **tri-state on purpose**:

- `true` — present (`RegExp` carries all five);
- `false` — **provably** absent (every constituent resolved, none declared it);
- `undefined` — unknowable (`any`/`unknown`, or a union with such a part).

Only a provable `false` licenses the ToString path. TypeScript models
`[Symbol.split]` as a late-bound property with escaped name `__@split@<declId>`
(bare `__@split` in some ambient shapes); both spellings are matched. No checker
object escapes, so this respects the oracle's no-leak contract. **The change-set
adds zero `getTypeAtLocation`/`ctx.checker` sites under `src/codegen/**`, so no
`oracle-ratchet-allow` is claimed.**

### 2. `isPlainToStringSearchValue` (`src/codegen/regexp-standalone.ts`)

The shared admissibility predicate. Deliberately conservative in three places,
each of which is a correctness requirement rather than caution:

- **`undefined`/`void` is excluded**, and routed by a separate predicate
  `isDefinitelyUndefinedExpr`. Every method special-cases an undefined search
  value *differently*: `split(undefined)` returns `[S]` **without splitting**,
  while `search(undefined)` builds the **empty** pattern. Folding them together
  would be a silent wrong answer. `isDefinitelyUndefinedExpr` also widens the
  pre-existing purely-syntactic test to any expression whose type is exactly
  `undefined`/`void` — test262 writes an undefined separator as
  `function(){}()` (S15.5.4.14_A1_T9), which the syntactic test misses.
- **`symbol` stays refused** — §7.1.17 `ToString(symbol)` throws, and this lane
  cannot raise it (same carve-out as #3724).
- **`any`/`unknown` stay refused.** The single exception is a *syntactic* `null`
  literal, which is `any` under `strictNullChecks: false` yet is unambiguously
  the null value, and `null` skips the protocol lookup by inspection.

### 3. `search` / `match` — `RegExpCreate(ToString(arg), "")` at runtime

`emitCoercedRegExpToLocal` builds the regex through the existing runtime pattern
compiler and parks it in a local. `emitRegexSearchCall` /
`emitRegexExecArrayCall` gain a `regexpOverride` option, symmetric with the
`inputOverride` that was already there, so the shared emitters are reused
untouched rather than duplicated.

The override exists **for evaluation order**, not just for plumbing. The spec
runs `ToString(this)` (step 3) *before* `RegExpCreate` (step 4) evaluates the
search value's `toString`, and both can be observable. The shared emitter loads
the regex first, so both operands are materialised into locals by the caller,
at the caller's chosen point, and the emitter only ever sees `local.get`s.

A coerced regex is non-global by construction, so `match` always takes the
`.exec`-shaped arm; static group/`d`-flag recovery is skipped outright rather
than being trusted to decline on a search-value expression that is not a regex
source at all.

### 4. `split` — `ToString(separator)` into the existing native helper

The new arm mirrors the string-like arm operand-for-operand (receiver →
separator → limit) so **argument** evaluation stays left-to-right as at any call
site; the only difference is `emitArgAsNativeString` (the #2598 ToString engine)
in place of the raw `compileExpression`, which would feed a mistyped ref to a
helper expecting `ref $AnyString`.

*Not* changed: the spec coerces `ToUint32(limit)` (step 4) before
`ToString(separator)` (step 5), which is the reverse of the operand order here.
Reordering the two coercions would require holding an un-coerced arbitrary value
across the limit coercion; more importantly it would invert **argument**
evaluation for `s.split(f(), g())`, trading a non-observable deviation for an
observable one. The existing string-separator arm already ships this order, so
this arm introduces no new deviation. No file in the population distinguishes
the two orders (the `-throws` variants throw under either).

The undefined-separator arm now also **evaluates and discards** a non-syntactic
separator expression. It matched only side-effect-free syntactic forms before;
with the type-level widening it can match `f()`, and folding the value away must
not delete the call.

### Where the code lives, and the LOC ratchet

Both files this touches — `regexp-standalone.ts` (4,261) and `string-ops.ts`
(3,795) — are god-files already at their #3102 cap, and the gate's instruction
is *"add code to the subsystem module, not the barrel/driver"*. The first
version ignored that and grew them **+255 / +55**.

The §22.1.3 search-value dispatch is a genuine subsystem, so it now lives in
**`src/codegen/string-search-value.ts`**: the admissibility predicates, the
`RegExpCreate(ToString(v))` lowering, and the coerced `search` / `match` /
`split` entry points. The split is meaningful, not cosmetic — *this* module owns
the **decision** (is the spec's plain-ToString path the whole of the semantics
here?), `regexp-standalone.ts` keeps the **engine plumbing** it calls into.

A **third** gate then caught what the first extraction still left behind: the
per-function ceiling (#3400 / R-FUNC) failed on
`string-ops.ts::compileNativeStringMethodCall` (+18 on a 1,135-line function).
The honest reading is that only *my* arm had moved while the decision it belongs
to was still split across the god-function. So the **whole** §22.1.3.23 step-2
separator decision moved — the pre-existing undefined-separator arm (#2161 B2)
along with the new ToString one — behind a single
`tryCompileStandaloneSplitSeparator` entry point that declines for a string-like
separator so the byte-identical existing arm still handles it.

Final state:

| file | cap | before | after | |
| --- | ---: | ---: | ---: | --- |
| `src/codegen/regexp-standalone.ts` | 4,261 | 4,516 (+255) | **4,280 (+19)** | allowance |
| `src/codegen/string-ops.ts` | 3,795 | 3,850 (+55) | **3,755 (−40)** | **below cap — no allowance** |
| `src/codegen/string-search-value.ts` | — | — | 391 | new |
| `compileNativeStringMethodCall` | 1,135 | 1,153 (+18) | **under** | — |

`string-ops.ts` ends up **smaller than before this change**, and the per-function
gate passes without an allowance. The one remaining `loc-budget-allow` covers the
seam in `regexp-standalone.ts` and nothing else: one import line, four `export`
keywords on primitives the subsystem calls (`stripStaticWrapper`,
`ensureDynamicStandaloneRegExpCompiler`, `emitRegexSearchCall`,
`emitRegexExecArrayCall`), the `regexpOverride` option field on the two shared
emitters, and a two-line delegation at each call site. It is not a licence for
the logic, which lives in the new module.

Worth recording as a process point: three independent budget gates
(LOC-regrowth, per-function ceiling, oracle ratchet) each rejected a different
shortcut here, and following all three produced a **better** decomposition than
the design I started with — the two split arms are now one decision in one place
instead of two arms 50 lines apart inside a god-function.

## Test Results

Instrument validated in both directions before the change, on the harness used
for every number below (`runTest262File(..., "standalone")` — **status only**;
its error category and line are not the CI path, and it does not apply the
#2961 host-import refusal):

- **Positive control** — 6 files the baseline records as standalone `pass` in
  `String/prototype`: **6 / 6 pass**.
- **Negative control / kill-switch-removed measurement** — the 43 goal-scope
  population files on unmodified `upstream/main`: **0 / 43**, all 43 failing
  with exactly this refusal. This is the attribution proof: the "before" arm is
  the same harness, same corpus, same files, with the change absent.
- **Regression guard** — the 166 files the baseline records as standalone `pass`
  across the six touched directories (`String/prototype/{search,match,matchAll,`
  `split,replace,replaceAll}` and `annexB/.../String/prototype`): **166 / 166**,
  re-run after the subsystem extraction. The extraction moved ~280 lines, so it
  was re-measured rather than assumed.

Node was used as the oracle for every hand-written probe **before** it was run
against the compiler.

### Flips

| Set | before | after |
| --- | ---: | ---: |
| **Goal-scope population (43)** | 0 | **35** |
| — `search` (15) | 0 | **15** |
| — `match` (11) | 0 | **11** |
| — `split` (9) | 0 | **9** |
| — `replace` (8, deliberately out of scope) | 0 | 0 |
| **All-official population (99)** | 0 | **47** |
| **Guard set — 166 files the baseline records as standalone `pass` in the six touched directories** | 166 | **166** (0 regressed) |

**Every file in the three lanes this change addresses now passes: 35 / 35.** The
only goal-scope residuals are the 8 `replace` files that are deliberately out of
scope.

**File counts are not flip ceilings**, and the project's measured reference point
is 103 reachable → 34 flipped (33 %). This one is far higher because the
population was cut by a **Tier-1 refusal string**: every member is *conclusively*
gated on this one mechanism, so the usual "gated ≠ reachable" discount does not
apply. That is a property of how the population was selected, not a claim that
levers generally behave this way.

#### A refuted intermediate claim, kept as a warning

An earlier revision of this file reported **31 / 43** and explained the 4
residuals as "an argument whose static type is `any` — the conservative boundary
of `wellKnownSymbolMemberOf`". **That explanation was wrong**, and it was wrong
in the most seductive way: it was a *plausible* story that matched the intended
design, so it read as a finding rather than as a symptom.

The real cause was a **silently no-op edit**. A scripted `str.replace()` meant to
switch the `search`/`match` gates from `isStaticallyUndefinedExpr` to
`isDefinitelyUndefinedExpr` did not match (whitespace), printed `ok`, and changed
nothing — so those two gates kept the narrower syntactic predicate while the
`split` gate got the wider one. The 4 residuals were exactly the type-level
`undefined` cases (`var x;` and `function(){}()`), which the wider predicate
handles. They flipped the moment the intended edit actually landed, during the
LOC extraction.

Two things to carry forward: a scripted source edit must **assert its match
count** (the later extraction script did, which is how this surfaced), and a
residual that has a tidy explanation still needs the explanation *checked*
against the failing file rather than inferred from the design.

## Deliberately out of scope

- **`replace` / `replaceAll` string-coercion** — blocked on function replacers
  (see refutation 4 above), a separate pre-existing defect. Follow-up.
- **`matchAll` string-coercion** — needs `RegExpCreate(x, "g")` plus the
  iterator result shape, and §22.1.3.14 makes a non-global regexp argument a
  runtime `TypeError`, which this lane has no path for yet.
- **The `cstm-*` symbol-protocol arm (~40 files, 0 in goal scope)** — genuine
  `GetMethod` dispatch on an arbitrary object. Different mechanism, different
  cost; it is the reason this issue's title says *search-value*, not *RegExp*.
