---
id: 3526
title: "IR-only R6: typed semantic runtime contract and frozen feature manifest"
status: in-progress
sprint: Backlog
created: 2026-07-21
updated: 2026-09-02
assignee: ttraenkler/fable-ir-takeover
branch: claude/issue-3526-f2s5-string-concat
priority: critical
horizon: xl
complexity: XL
feasibility: hard
reasoning_effort: max
task_type: refactor
area: ir, codegen, runtime, compiler
language_feature: compiler-internals
es_edition: multi
goal: ir-full-coverage
lane: ir-retirement-r6
model: gpt-5.6-sol
parent: 3518
depends_on: [3521]
required_by: [3527, 3528, 4382]
related: [1713, 2094, 2514, 2520, 2855, 2954, 2956, 3090, 3143, 3226, 3233, 3518, 3678, 4382]
origin: "#3518 R6 — replace AST-driven lazy runtime registration with typed semantic intents"
files:
  - src/ir/intrinsics.ts
  - src/ir/runtime-manifest.ts
  - src/ir/async-runtime-providers.ts
  - src/ir/async-plan.ts
  - src/ir/nodes.ts
  - src/ir/intrinsic-support.ts
  - src/ir/extern-support.ts
  - src/ir/math-runtime-providers.ts
  - src/ir/types.ts
  - src/ir/effects.ts
  - src/ir/select.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/lower.ts
  - src/ir/backend/legality.ts
  - src/ir/backend/linear-integration.ts
  - src/ir/backend/emitter.ts
  - src/codegen/context/types.ts
  - src/codegen/index.ts
  - src/codegen/declarations/import-collector.ts
  - src/codegen/registry/imports.ts
  - src/codegen/expressions/late-imports.ts
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/expressions/builtins.ts
  - src/codegen/ir-async-runtime-adapters.ts
  - src/codegen/math-helpers.ts
  - src/codegen/stdlib-selfhost.ts
  - src/stdlib/math.ts
  - src/compiler/import-manifest.ts
  - src/runtime.ts
  - src/index.ts
  - tests/issue-3526-ir-runtime-manifest.test.ts
  - tests/issue-3526-ir-math-intrinsic-integration.test.ts
  - tests/issue-3526-ir-linear-math-intrinsics.test.ts
  - tests/issue-4103-ir-async-runtime-providers.test.ts
  - tests/issue-4104-ir-async-plan-runtime-consumer.test.ts
  - tests/issue-3526-string-boundary-compare.test.ts
  - tests/issue-3526-string-boundary-schema.test.ts
  - tests/issue-3526-string-boundary-eq.test.ts
  - tests/issue-3526-string-boundary-len.test.ts
  - src/ir/string-support.ts
loc-budget-allow:
  - src/ir/integration.ts
  - src/ir/builder.ts
  - src/ir/nodes.ts
  - src/ir/lower.ts
  - src/ir/verify.ts
  - src/ir/select.ts
  - src/ir/from-ast.ts
  # 2026-08-31 F1-S1: owner-local number-boundary partition + policy projection
  # + attached-provider materialization trigger (integration.ts); the linear
  # adapter's explicit disabled number-boundary policy (linear-integration.ts).
  - src/ir/backend/linear-integration.ts
  - src/ir/intrinsics.ts
  - src/ir/runtime-manifest.ts
  - src/ir/intrinsic-support.ts
  - src/ir/async-runtime-providers.ts
  - src/ir/async-prepare.ts
  - src/codegen/stdlib-selfhost.ts
  - src/ir/math-runtime-providers.ts
  # 2026-09-01 F1-S2 (boolean boundary, +176 net LOC measured against
  # origin/main dcb6eba6): the `js.boolean.box` intrinsic + feature rows
  # (intrinsics.ts); the `boolean.box` capability record (the central
  # catalogue, new in F1-S1 and named here so the grant is not implicit);
  # the `booleanBoundary` policy, its provider and policy-driven selection
  # (runtime-manifest.ts); the caller policy projection, the owner-local
  # boolean partition and the widened materialization trigger
  # (integration.ts); the explicit disabled policies in the linear and
  # self-hosted-stdlib adapters. All four cited files already carry an
  # F1-S1 grant; this line records the F1-S2 rationale against it.
  - src/ir/runtime-host-capabilities.ts
  # 2026-09-01 F1-S3 (generator setReturn boxing, +294 net LOC measured against
  # origin/main 009b8127): the `generatorNumberBox` policy, its two provider
  # rows and their policy-driven selection (runtime-manifest.ts); the
  # freeze-time demand hook and the manifest-to-callable derivation
  # (intrinsic-support.ts); the caller policy projection, the owner-local
  # generator partition and the threaded attach call site (integration.ts);
  # the shared demand enumeration and the required provider parameter
  # (generator-support.ts); the retired `?? __box_number` fallback at the
  # `gen.setReturn` lowering arm (lower.ts); the explicit disabled policies in
  # the linear and self-hosted-stdlib adapters. Every cited file except
  # generator-support.ts already carries an F1-S1/F1-S2 grant; this line
  # records the F1-S3 rationale against them and adds the one new path.
  - src/ir/generator-support.ts
  # 2026-09-01 F1-S4 (boundary residuals, +265 net LOC measured against
  # origin/main 96f7a3c0): the `js.extern.is_undefined` intrinsic + feature
  # rows (intrinsics.ts); the `extern.is_undefined` capability record
  # (runtime-host-capabilities.ts); the `externIsUndefined` policy, its TWO
  # provider rows and their policy-driven selection (runtime-manifest.ts,
  # which crosses the 1500-line god-file threshold with this slice); the
  # migrated strict-undefined arm and the deleted resolver contract entry
  # (from-ast.ts); the caller policy projection, the owner-local probe
  # partition and the widened materialization trigger (integration.ts); the
  # retired `?? irRuntimeFuncRef(<spelling>)` fallbacks on all four `gen.*`
  # lowering arms (lower.ts); the explicit disabled probe policies in the
  # linear and self-hosted-stdlib adapters. Every cited path already carries
  # an F1-S1/F1-S2/F1-S3 grant; this line records the F1-S4 rationale against
  # them and adds no new path.
  #
  # 2026-09-01 F2-S1 (string.compare under manifest policy + the forof.string
  # fallback retirement, +301 net LOC measured against origin/main bee8a149):
  # the `(externref, externref) -> i32` compare signature (intrinsics.ts); the
  # `string.compare` capability record — family 2's first, and the first record
  # whose physical import is a BASE import minted by the legacy import
  # collector rather than a union or late registration
  # (runtime-host-capabilities.ts); the `stringCompare` policy, its TWO
  # provider rows and their policy-driven selection (runtime-manifest.ts); the
  # freeze-time demand hook and the manifest-to-arm derivation
  # (intrinsic-support.ts); the caller policy projection, the call-population
  # demand predicate, the owner-local compare partition and the prepared
  # manifest threaded to the resolve-time provider table in place of its
  # `ctx.nativeStrings` read (integration.ts); the retired
  # `?? irIntrinsicFuncRef(IR_STRING_ITERATOR_CHAR_AT_FN)` fallback on the
  # `forof.string` lowering arm (lower.ts); the explicit disabled compare
  # policies in the linear and self-hosted-stdlib adapters. Every cited path
  # already carries an F1-S1..F1-S4 grant; this line records the F2-S1
  # rationale against them and adds no new path.
  #
  # 2026-09-01 F2-S2 (capability-record schema widening, +278 net src LOC
  # measured against origin/main dc29e1f1): the kind-discriminated record
  # union — two closed id halves, per-kind module unions, the global field
  # scheme, the `ref_extern` value type, the `funcRecord`/`globalRecord`
  # factories, the six new `wasm:js-string` / `string_constants*` rows, the
  # per-kind validator arms and the shared `asCallableRuntimeHostCapabilityRecord`
  # guard (runtime-host-capabilities.ts, +239 net — the whole slice); the
  # `host-callable` capability narrowed to the func id half plus its
  # `#indexProviders` runtime twin (runtime-manifest.ts, which is over the
  # 1500-line god-file threshold and carries an F1-S1 grant); the three
  # func-assuming derivations routed through the func resolver
  # (intrinsic-support.ts); `AsyncHostAdapter` retargeted to the func arm and
  # the kind guard placed before the value-type walk
  # (async-runtime-providers.ts); the one adapter-parity guard
  # (async-plan.ts, the single new path, 1285 lines and far under the
  # threshold). This slice moves NO boundary: no provider references a new
  # row, so every frozen manifest, import and emitted body is byte-identical
  # (35/35 measured cells).
  #
  # 2026-09-02 F2-S3 (string.eq under manifest policy + the emitStringEquals
  # fallback retirement, +260 net src LOC measured against origin/main
  # 0f801557): the `stringEq` policy, its TWO provider rows and their
  # policy-driven selection (runtime-manifest.ts, +113 — the file is over the
  # 1500-line god-file threshold, 1690 -> 1803, and carries an F1-S1 grant;
  # the growth is one more independent policy field beside five existing ones,
  # each row of which is the same nine-part shape, so the file grows by
  # repetition of a settled pattern rather than by new mechanism — splitting it
  # is F2's own tail, not this slice's); the freeze-time demand hook and
  # `preparedStringEqProvider`, which returns the record's MODULE as well as its
  # field because the host arm is a `wasm:js-string` BUILTIN located by
  # import-section position, not a `ctx.funcMap` lookup (intrinsic-support.ts,
  # +58); the SPLIT of the three-symbol concat/eq resolve arm plus the migrated
  # eq half, the caller policy projection, the `string.eq` instruction-scan
  # demand, the owner-local eq partition, and the retired no-provider
  # `ctx.nativeStrings` fallback in the WasmGC `emitStringEquals` adapter
  # (integration.ts, +85); the explicit disabled eq policies in the linear and
  # self-hosted-stdlib adapters (+2 each). Every cited path already carries an
  # F1-S1..F2-S2 grant; this line records the F2-S3 rationale against them and
  # adds no new path. Byte-neutral: 55/55 measured cells identical, WAT text
  # included.
  #
  # 2026-09-02 F2-S4 (string.len under manifest policy + the emitStringLen
  # fallback retirement, +334 net src LOC measured against this branch's base
  # 33c3afc4 — MORE than the plan's +150 estimate, and the two reasons are
  # structural rather than incidental, so they are named here: (1) the slice
  # introduces a new provider IMPLEMENTATION KIND (`carrier-field`), which
  # costs a union arm plus a THREE-rule validation triad that no previous
  # family-2 slice needed; (2) `string.len` has no resolve-table arm to edit,
  # so the migration is a whole new function (`prepareStringLength`) rather
  # than a rewrite inside an existing branch. Breakdown: the `stringLen`
  # policy, the `carrier-field` kind, the TWO provider rows on the reused
  # `(externref) -> i32` signature, their policy-driven selection and the
  # carrier-field validation rules (runtime-manifest.ts, +164 — the file is
  # over the 1500-line god-file threshold, 1803 -> 1967, and carries an F1-S1
  # grant; as in F2-S3 the growth is one more independent policy field beside
  # six existing ones plus one union arm, i.e. repetition of a settled pattern,
  # and splitting the file is F2's own tail, not this slice's); the freeze-time
  # demand hook and `preparedStringLenProvider`, which returns the ABI ROLE and
  # field index for the native arm because a frozen manifest cannot honestly
  # carry a physical type index the carrier planner has not chosen yet
  # (intrinsic-support.ts, +53); the caller policy projection, the `string.len`
  # instruction-scan demand, the owner-local length partition, the MOVED
  # attachment (`prepareStringLength`, which runs inside the freeze because
  # this seam's provider IS the physical choice), the deleted `prepareStrings`
  # decision block and the retired no-provider `ctx.nativeStrings` fallback in
  # the WasmGC `emitStringLen` adapter (integration.ts, +113); the explicit
  # disabled length policies in the linear and self-hosted-stdlib adapters
  # (+2 each); and the LENGTH-ONLY attachment pass
  # `attachIrStringLengthProvider` (string-support.ts, +47, the one new path
  # this slice adds and far under the god-file threshold at 202 lines). That
  # pass exists because of a MEASURED defect, not a preference: reusing the
  # omnibus `attachIrStringSupport` a second time re-derives the provider for
  # five other string seams, which rebinds a counted-native `string.repeat` to
  # the generic helper and fails 4 corpus cells that the 60-cell byte matrix
  # cannot see. Every other cited path already carries an F1-S1..F2-S3 grant;
  # this line records the F2-S4 rationale against them.
  # Byte-neutral: 60/60 measured matrix cells and 104/104 corpus cells
  # identical, WAT text included.
  #
  # 2026-09-02 F2-S5 (string.concat under manifest policy + the emitStringConcat
  # fallback retirement, +353 net src LOC measured against origin/main 7f998ff8
  # — MORE than the plan's +170 estimate, and the reason is structural: this is
  # the catalogue's first seam with TWO features under ONE policy, so every
  # per-seam artefact the three predecessors minted ONCE is minted twice here
  # (two feature rows, FOUR provider rows, a two-argument selector, a PAIR-shaped
  # demand) and it is also the first seam that could not reuse an existing ABI.
  # Breakdown: the `stringConcat` policy, the two features, the four provider
  # rows and their policy-and-feature-driven selection (runtime-manifest.ts,
  # +164 — the file is over the 1500-line god-file threshold, 1967 -> 2131, and
  # carries an F1-S1 grant; as in F2-S3/F2-S4 the growth is one more independent
  # policy field beside seven existing ones, i.e. repetition of a settled
  # pattern, and splitting the file is F2's own tail, not this slice's); the ONE
  # new signature constant `EXTERNREF_PAIR_TO_REF_EXTERN_INTRINSIC_SIGNATURE`
  # (intrinsics.ts, +26 — 437 -> 463 lines, far under the threshold), which had to be
  # minted because `wasm:js-string.concat` returns a non-null `(ref extern)` and
  # no existing signature carries that result; the freeze-time demand PAIR and
  # `preparedStringConcatProvider`, which takes the concat MODE as well as the
  # prepared manifest because the policy chooses the authority and the mode
  # chooses the helper on it (intrinsic-support.ts, +65); the caller policy
  # projection, the `string.concat` instruction-scan demand pair, the
  # owner-local concat partition, the migrated resolve arm and the retired
  # no-provider `ctx.nativeStrings` fallback in the WasmGC `emitStringConcat`
  # adapter (integration.ts, +94); the explicit disabled concat policies in the
  # linear and self-hosted-stdlib adapters (+2 each). Every cited path already
  # carries an F1-S1..F2-S4 grant; this line records the F2-S5 rationale against
  # them and adds no new path. Byte-neutral: 65/65 measured matrix cells and
  # 104/104 corpus cells identical, WAT text included, the BATCHED many-arity
  # cells (F2-S6's seam) among them.
  #
  # 2026-09-02 F2-S7 (charCodeAt under manifest policy + the
  # emitStringCharCodeAt fallback retirement, +351 net src LOC measured against
  # this branch's own base — the F2-S5 tip 6d6425c8e3 merged with origin/main —
  # against a plan estimate of +230. The overshoot is structural and named
  # here: this is the family's first seam with TWO PRODUCERS, so the migration
  # is not one arm but three (the instruction path's arm re-decides from the
  # frozen row; the two plan-path arms keep their materializers and gain a
  # fail-closed VERIFY against it), and the demand scan has to enumerate an
  # instruction kind AND two intrinsic call symbols instead of a single
  # `instr.kind` test. Breakdown: the `stringCharCodeAt` policy, the ONE feature
  # and the TWO `runtime-callable` provider rows with their policy-driven
  # selection (runtime-manifest.ts, +139 net — the file is over the 1500-line
  # god-file threshold, 2131 -> 2270, and carries an F1-S1 grant; as in
  # F2-S3/F2-S4/F2-S5 the growth is one more independent policy field beside
  # eight existing ones, i.e. repetition of a settled pattern, and splitting the
  # file is F2's own tail, not this slice's); the ONE new signature constant
  # `EXTERNREF_I32_TO_F64_INTRINSIC_SIGNATURE` (intrinsics.ts, +20 — 463 -> 483
  # lines, far under the threshold), minted because the seam's SEMANTIC shape is
  # the guarded `(externref, i32) -> f64` and no existing constant carries those
  # params — deliberately NOT the `string.char_code_at` record's trapping
  # `(externref, i32) -> i32` ABI, which is the first such divergence in the
  # catalogue; the freeze-time demand flag and `preparedStringCharCodeAtProvider`,
  # the family's first twin that discriminates on the provider ID rather than
  # the implementation kind because BOTH arms are `runtime-callable` defined
  # helpers rather than imports (intrinsic-support.ts, +46 net); the caller
  # policy projection, the TWO-PRODUCER demand scan, the owner-local charCodeAt
  # partition, the migrated instruction-path resolve arm, the two plan-path
  # verify arms and the retired no-provider `ctx.nativeStrings` fallback in the
  # WasmGC `emitStringCharCodeAt` adapter (integration.ts, +142 net); the
  # explicit disabled charCodeAt policies in the linear and self-hosted-stdlib
  # adapters (+2 each). Every cited path already carries an F1-S1..F2-S5 grant;
  # this line records the F2-S7 rationale against them and adds no new path.
  # Byte-neutral: 65/65 measured matrix cells and 104/104 corpus cells
  # identical, WAT text included, the hoist/trusted LOOP and LOOPSUM cells —
  # the fence proving the proof-licensed arms were not touched — among them.
  #
  # 2026-09-02 F2-S6 (batched many-arity string concat under manifest policy,
  # +738 net src LOC measured against this branch's base 9e466d4b — well over
  # the plan's +400-500 estimate, and the two reasons are structural rather
  # than incidental, so they are named here. (1) The slice introduces a new
  # CAPABILITY RECORD KIND (`func-family`), not just a provider implementation
  # kind: that is a third id list with its own type and guard, a field-scheme
  # list of its own, a params SCHEME type, a record type, a factory, a full
  # validator arm and a synthesizing resolver — F2-S2 spent +239 lines on the
  # global kind for exactly the same reasons and this is the same shape again
  # (+247). (2) It introduces TWO provider implementation kinds at once
  # (`host-callable-family` and `runtime-callable-family`), each with its own
  # validation triad, where F2-S4 introduced one. Breakdown: the `func-family`
  # record kind, the `RUNTIME_HOST_CAPABILITY_FUNC_FAMILY_IDS` third list and
  # its guard, the `arity-suffix` field scheme list, the repeat-params scheme,
  # the `string.concat.many` row, the validator arm and
  # `resolveRuntimeHostCapabilityFuncFamilyRecord`
  # (runtime-host-capabilities.ts, +247 — 503 -> 750, far under the 1500-line
  # god-file threshold, and it already carries an F1-S2 grant); the
  # `stringConcatMany` PASS policy and its cross-policy rule, the two family
  # implementation kinds with their validation, the one feature, the two
  # provider rows, the `stringConcat`-keyed selector and the derived
  # `stringConcatManyArityCap` (runtime-manifest.ts, +283 — the file is over
  # the god-file threshold, 2131 -> 2414, and carries an F1-S1 grant; as in
  # F2-S3/F2-S4/F2-S5 the growth is one more independent policy field beside
  # eight existing ones plus two union arms, i.e. repetition of a settled
  # pattern, and splitting the file is F2's own tail, not this slice's); the
  # post-pass arity demand scan and `preparedStringConcatManyProvider`, which
  # derives the CONCRETE import or symbol from the frozen family row at the
  # requested arity (intrinsic-support.ts, +78); the caller policy projection,
  # the batched-arity demand scan, the owner-local batched partition, the pass
  # selection rewritten off the frozen policy with its ceiling derived rather
  # than copied, and the two resolve arms folded onto one manifest-reading
  # lowering (integration.ts, +121); the native arity range imported instead of
  # restated (native-batched-concat.ts, +5 — 190 -> 195, the one new path this
  # slice touches, far under the threshold and below the gate's grant
  # requirement, recorded here so the growth is not implicit); the explicit
  # disabled pass policies in the linear and self-hosted-stdlib adapters
  # (+2 each). Every other cited path already carries an F1-S1..F2-S5 grant;
  # this line records the F2-S6 rationale against them.
  # Byte-neutral: 85/85 measured matrix cells identical (the census's 84-cell
  # grid plus the wasi edge cell), bytes, sha256, ordered import lists,
  # demotions and WAT text, with `check:ir-fallbacks` output byte-identical to
  # a base-tree run.
  #
  # 2026-09-02 F2-S8 (string.const under manifest policy — family 2's last
  # slice; +594 net src LOC measured against this branch's own base
  # c3f50982, MORE than the plan's +420 unmeasured estimate. Three structural
  # reasons, none of them sprawl, and all three are why the plan called this
  # the hardest slice of the family: (1) it adds TWO provider implementation
  # kinds at once (`host-global`, `native-global`) with a validation rule
  # apiece, where F2-S4 added one; (2) it is the only seam in the catalogue
  # whose arms are VALUES rather than callables, so it needs a signature the
  # catalogue has no shape for (`() -> externref`, the first empty-parameter
  # one) and a record resolver of its own; and (3) like F2-S4 it MOVES an
  # attachment behind the freeze rather than editing a resolve arm, which is a
  # whole new function plus a new attach pass rather than a rewrite inside an
  # existing branch — and it does that for a seam that has no resolve arm at
  # all. Breakdown: the `stringConst` policy, the two features, the two
  # implementation kinds with their validation, the FOUR provider rows and the
  # feature-and-policy-driven selector (runtime-manifest.ts, +239 — the file is
  # over the 1500-line god-file threshold, 2553 -> 2792, and carries an F1-S1
  # grant; as in F2-S3..F2-S7 the growth is one more independent policy field
  # beside nine existing ones plus two union arms, i.e. repetition of a settled
  # pattern, and splitting the file is F2's own tail, not this slice's); the
  # one new signature (intrinsics.ts, +21); the GLOBAL record resolver, the
  # fail-closed twin of the func one every sibling takes
  # (runtime-host-capabilities.ts, +22); the PAIR-shaped literal-storage demand
  # and `preparedStringConstProvider`, which returns the import MODULE and the
  # field SCHEME because there is one field per literal
  # (intrinsic-support.ts, +73); the caller policy projection, the
  # two-producer demand scan (`string.const` AND `extern.regex`), the
  # owner-local storage partition, and the MOVED attachment
  # (`prepareStringConst`, which runs inside the freeze because this seam's
  # `IrGlobalRef` IS the physical choice) with the deleted `prepareStrings`
  # decision block (integration.ts, +176); the explicit disabled storage
  # policies in the linear and self-hosted-stdlib adapters (+2 each); and the
  # CONST-ONLY attachment pass `attachIrStringConstStorage` (string-support.ts,
  # +59, 261 lines total and far under the threshold). That pass exists for the
  # reason F2-S4 measured rather than a preference: the omnibus
  # `attachIrStringSupport` re-derives six other seams' providers on every run,
  # and a caller settling one seam through it rebinds a counted-native
  # `string.repeat` to the generic helper. Every cited path already carries an
  # F1-S1..F2-S7 grant; this line records the F2-S8 rationale against them and
  # adds no new path. Byte-neutral: 90/90 measured matrix cells and 104/104
  # corpus cells identical — bytes, sha256, ordered import lists with indices,
  # demotions, the linear IR report and full WAT text — with
  # `check:ir-fallbacks` output byte-identical to a base-tree run.
  #
  # 2026-09-02 F3-S1 (host callback maker under manifest policy — family 3's
  # first slice; +440 net src LOC measured against origin/main 77ca8fba).
  # Breakdown: the `hostCallbackWrap` policy, the `js.callback.wrap` feature,
  # the NEW `native-dispatch` implementation kind with its validation rule, the
  # two provider rows and the policy-driven selector (runtime-manifest.ts,
  # +170 — the file is over the 1500-line god-file threshold, 2792 -> 2962, and
  # carries an F1-S1 grant; as in F2-S3..F2-S8 the growth is one more
  # independent policy field beside eleven existing ones plus one union arm,
  # i.e. repetition of a settled pattern, and splitting the file is not this
  # slice's work); the PAIR-shaped callback demand and
  # `preparedHostCallbackWrapProvider`, which returns the maker's import module,
  # field and ABI on the host arm and the dispatcher ROLE on the native one
  # (intrinsic-support.ts, +66); the caller policy projection, the
  # `closure.new`-shaped demand scan, the two-sided owner-local partition and
  # the post-freeze `admitAttachedHostCallbackMaker` recognition
  # (integration.ts, +164); the maker crossing built from the capability record
  # instead of spelled by hand (from-ast.ts, +8); the module-scope
  # `HOST_CALLBACK_WRAP_CAPABILITY_RECORD`, the seam between Phase-1's static
  # authority and the post-freeze one (runtime-host-capabilities.ts, +16); the
  # overlay's final-context ABI proof reading that record instead of a
  # hand-written `(i32, externref) -> externref`
  # (ir-overlay-finalize.ts, +12 — sub-B); the explicit disabled callback
  # policies in the linear and self-hosted-stdlib adapters (+2 each).
  #
  # `native-dispatch` is a NEW implementation kind rather than a new
  # `native-managed.service` value, and the reason is measured, not stylistic:
  # `projectRuntimeBackendRequirements` treats every `native-managed` row as a
  # member of the native ASYNC family — measured, it adds
  # `["async.native.drive","async.native.number-boundary"]` to the frozen vector
  # and throws `invalid-backend-requirement-projection` the moment such a row
  # shares a manifest with a host async provider — which would have changed the
  # frozen vector on exactly the lane this slice must keep byte-identical.
  #
  # Every cited path already carries an F1-S1..F2-S8 grant except
  # `src/codegen/ir-overlay-finalize.ts`, which is added below. Byte-neutral:
  # 21/21 measured matrix cells identical — bytes, sha256, ordered import lists,
  # errors, IR outcomes and full WAT text — with `check:ir-fallbacks` OK and the
  # linear baseline untouched.
  - src/codegen/ir-overlay-finalize.ts
  - src/codegen/native-batched-concat.ts
  - src/ir/async-plan.ts
func-budget-allow:
  - src/ir/integration.ts::compileIrPathFunctions
  - src/ir/lower.ts::lowerIrFunctionBody
  - src/ir/lower.ts::emitInstrTree
  - src/ir/backend/linear-integration.ts::compileLinearIrFunctions
  - src/ir/from-ast.ts::lowerMethodCall
  - src/ir/integration.ts::makeResolver
  - src/ir/passes/inline-small.ts::renameInstrOperands
  # 2026-09-02 F2-S7: `resolveAndObserveCallableProvider` crosses the 300-LOC
  # threshold (300 -> 330). The plan estimated only `loc-budget-allow` growth,
  # so this grant is a recorded divergence rather than a planned one. The cause
  # is the seam's TWO producers: unlike every family-2 predecessor the
  # migration lands THREE arms in this one dispatcher — the instruction path's
  # arm now materializes whichever authority the frozen `stringCharCodeAt` row
  # names, and the two plan-path arms keep their materializers while gaining a
  # fail-closed VERIFY that the plan-time symbol matches that row. Splitting the
  # dispatcher is not this slice's work: it is one long `else if` chain over
  # callable symbols whose arms are individually small, and every family-2 slice
  # so far has added to it under the same discipline (#3399 tracks the split).
  #
  # 2026-09-02 F2-S8: no NEW path crosses a threshold. The one function this
  # slice grows past the gate's notice is
  # `integration.ts::compileIrPathFunctions` (3178 -> 3242), which already
  # carries an F1-S1 grant; the growth is the owner-local literal-storage
  # partition block and its policy projection, in the same pass as the nine
  # existing ones. `resolveAndObserveCallableProvider` is UNTOUCHED by this
  # slice — `string.const` has no resolve arm at all, which is the whole reason
  # the attachment had to move behind the freeze instead.
  #
  # 2026-09-02 F3-S1: no NEW path crosses a threshold. Two already-granted
  # functions grow: `integration.ts::compileIrPathFunctions` (3242 -> 3277),
  # which is the owner-local callback partition block and the two freeze
  # arguments, in the same pass as the ten existing ones; and
  # `from-ast.ts::lowerMethodCall` (919 -> 926), which is the maker crossing
  # now built from the capability record plus the comment that says why. A
  # third, `integration.ts::preregisterDynamicSupport`, was measured at 330
  # (> 300) on a first cut and is NOT granted: the maker recognition was
  # extracted into `admitAttachedHostCallbackMaker` instead — the same shape
  # F1-S4 gave `attachedExternIsUndefinedArm` — which leaves the function under
  # the threshold with no grant needed.
  - src/ir/integration.ts::resolveAndObserveCallableProvider
---

# #3526 — IR-only R6: typed semantic runtime contract and frozen feature manifest

## Objective

Establish one typed, immutable contract from prepared semantics to runtime and
host requirements:

```text
Prepared IR -> IntrinsicId -> RuntimeFeature -> HostCapability
```

The complete transitive runtime-feature manifest is computed to a fixed point
and frozen before backend lowering or function-body emission. `ImportIntent`
becomes a public projection of the final `HostCapability` set, not a string
classifier that reverse-engineers semantics from emitted import names.

R6 rewires runtime entry points family-by-family. It deletes AST dispatch and
lazy registration edges only after a typed IR intent reaches the same provider.
Runtime, builtin, scheduler, coercion, collection, regex, and host adapter
implementations remain single-sourced providers; their behavior is not deleted
with the old front-end.

## Baseline evidence and current seam

Before C0, there was no `IntrinsicId`, `RuntimeFeature`, or `HostCapability`
type. Semantics and concrete imports were discovered during emission:

- `src/index.ts:39-92` exposes a broad string-shaped `ImportIntent` union for
  math, console, extern classes, strings, builtins, callbacks, await, boxing,
  Date, Node, timers, and other families.
- `src/compiler/import-manifest.ts:8-248` infers those intents from final import
  name prefixes and a fallback `{ type: "builtin", name }`.
  `buildImportManifest` at `:251-263` walks only final `env` imports, after
  binary/WAT/declaration/helper emission in `src/compiler.ts:1080-1139`, so the
  manifest reports registration side effects rather than governing them and
  omits non-`env` semantic import namespaces.
- `src/codegen/registry/imports.ts:52-116` mutates imports, `funcMap`, and
  indices in `addImport`; host restrictions can refuse registration after a
  caller has started resolving indices.
- `src/codegen/expressions/late-imports.ts:387-406` lets expression emission
  call `ensureLateImport`. It rejects only after `ctx.indexSpaceFrozen`, whose
  contract at `src/codegen/context/types.ts:2162-2172` describes a final
  index-space freeze, not a semantic preparation freeze.
- `src/codegen/index.ts:2883-3021` and its multi-source counterpart collect
  source imports, emit deferred Math/helpers, and perform several registration
  phases before and during bodies. Single/multi paths set
  `indexSpaceFrozen` only at `:3654-3660` / `:5545-5549`, after instruction
  emission has already shaped demand.
- `src/ir/from-ast.ts:120-518` defines a large callback-rich resolver contract.
  `src/ir/integration.ts:1350-1545` implements it by reading and mutating legacy
  codegen registries for strings, externs, host globals, module bindings,
  console variants, methods, and helper names.
- `src/ir/integration.ts:777-917` preregisters and later mutates deferred
  resolver shells. Its resolver at `:1619-1964` can materialize helpers, intern
  types, create vector/dynamic layouts, Promise/exception/string support, and
  other registry state during resolution. `src/ir/lower.ts:101-304` explicitly
  advertises lazy/memoizing resolver operations.
- `src/codegen/stdlib-selfhost.ts:227-504` can build provider IR but still lowers
  and registers providers against the live codegen context, including helper
  materialization, type interning, slot allocation, and `funcMap` mutation.

The first safe semantic slice has a bounded vocabulary:

- `src/ir/select.ts:176-189` defines exactly twelve certified, exact-arity,
  proven-f64 `IR_MATH_METHOD_TABLE` specializations: five direct deterministic
  operations and seven symbolic self-host helpers.
- `src/ir/from-ast.ts` now lowers those calls to versioned semantic intrinsic
  nodes with no provider attached. Final IR preparation selects the provider
  from the frozen runtime manifest.
- `src/codegen/math-helpers.ts:71-87` emits deterministic inline/self-host Math
  providers. They are runtime substrate to retain. `Math.random` at `:89-153`
  adds host/WASI randomness and is deliberately not part of the first pure
  slice.

## Typed contract

### `IntrinsicId`

An exhaustive semantic operation identifier carried by prepared IR. It names
meaning such as deterministic `math.sqrt`, string concatenation, property get,
iterator close, Promise settle, or host-console write. It never contains a
concrete import/function index, backend representation, magic helper spelling,
AST node, or callback.

Each intrinsic has a versioned signature over `IrType`, supported target
policy, and source location at each use. Throw/allocate/suspend behavior reuses
the existing `IrEffects`/`effectsOf` authority rather than creating a second
effect table. Unknown IDs/signature mismatches are verifier failures.

### `RuntimeFeature`

A typed provider requirement selected from one or more intrinsics. Features
form an explicit dependency graph: requesting one feature may add coercion,
allocation, string, exception, iterator, scheduler, or adapter dependencies.
The graph is expanded to a deterministic fixed point before freeze. Cycles are
legal only when declared and produce one canonical provider component.

Backend-specific provider choice happens below this level. WasmGC and linear
may lower the same feature with different representations, but neither may
reinterpret source AST or invent a semantic feature during body lowering.

### `HostCapability`

The minimal external capability required after all in-module/self-host
providers are chosen. It records typed module/name/signature/permission and
mode availability. Host, strict-no-host, standalone, and WASI validate this set
before lowering. A missing capability is typed source `Unsupported` when it is
an intentional target limitation; a missing adapter for an advertised feature
is an `Invariant`.

### Projection and freeze

The immutable manifest owns sorted intrinsic uses, transitive features,
provider choices, host capabilities, imports, types, globals, literals,
helpers, exports, and backend adapter requirements. `ImportIntent` is derived
from `HostCapability` for the public compile result; non-`env` semantic imports
such as string builtins/constants receive an explicit typed projection rather
than disappearing. `classifyImport` may remain temporarily as a debug parity
oracle, but it is never production authority.

The same immutable contract exposes a stable read-only decision projection for
#4382. That public report may add source-facing explanations and #3678
diagnostics, but it cannot maintain a second support table or infer capability
from emitted helper/import names. `unknown` is the required public result when
an internal decision has not yet received a schema projection.

After freeze, resolver/import/type/global/helper registration is lookup-only.
Any lazy mutation, undeclared intrinsic, transitive feature, host import, type,
literal, helper, or slot is an R0 `Invariant`; no catch/retry or direct fallback
is permitted.

## Bounded landing sequence

### C0 — contract, fixed point, and freeze

- Define closed ID vocabularies, signatures, existing-`IrEffects` integration,
  provider dependencies,
  target policies, deterministic ordering, manifest builder, and verifier.
- Collect intrinsic uses from `PreparedIrProgram`, expand provider dependencies
  to a fixed point, choose host/self-host adapters, validate policy, allocate
  through `ProgramAbiMap`, and freeze before lowering.
- Add a legacy parity adapter that compares planned vs observed imports/helpers
  without granting authority to observed strings. Add poison seams for every
  late mutation path.

#### C0 foundation landing (2026-08-02)

The isolated schema seam now defines the exact twelve certified pure-Math
`IntrinsicId`s, their fourteen-entry transitive `RuntimeFeature` vocabulary
(including `math.atan` and `math.reduce-trig` provider dependencies), and the
deliberately empty `HostCapability` vocabulary for this host-free family.
Signatures are versioned f64 contracts; effect evidence is opaque and can only
be created through the existing `effectsOf` authority. The runtime-manifest
builder verifies intrinsic uses and provider signatures/adapters, expands
dependencies to a deterministic fixed point, requires explicit declarations
for cycles, emits canonical dependency components, and rejects both mutation
and unplanned lookup after deep freeze.

Focused anti-vacuity coverage proves all twelve methods against
`IR_MATH_METHOD_TABLE`, canonical output under reversed use/provider traversal,
the shared `pow -> exp + log`, `atan2 -> atan`, and `sin/cos -> reduce-trig`
closure, an injected declared cycle, all eight target/backend policy pairs,
zero host capabilities, provider-name independence, and typed failures for bad
IDs/signatures/effects/providers/adapters and late requests.

This landing intentionally stops before M1 routing. The exact follow-up is to
add the semantic intrinsic use to prepared IR in the sequential owner of
`nodes.ts`/`effects.ts`/`from-ast.ts`, collect it into this builder before ABI
publication, and make backend lowering resolve only the frozen provider plan.
Until that shared integration lands, the existing `Math_*` discovery and
providers remain unchanged and authoritative for production emission.

### M1 — deterministic pure Math

- Convert the exact twelve deterministic, exact-arity, proven-f64 methods in
  `IR_MATH_METHOD_TABLE` to typed intrinsic IDs: direct abs/sqrt/floor/ceil/
  trunc plus self-host sin/cos/exp/log/log2/pow/atan2. Exclude `Math.random`,
  extra/wrong arity, Symbol/dynamic/ToNumber coercion, other Math methods, and
  host state; those retain typed hybrid direct routing until their later slice.
- Make IR preparation request the semantic operation, fixed-point planning
  request any provider/helper, and lowering consume its preplanned ABI entry.
- Delete the Prepared M1 route's magic `Math_*` reference and dependency on
  text-matched AST collection/`pendingMathMethods`/live `funcMap` discovery
  after zero-direct and late-mutation tests pass. Retain selector/from-AST
  recognition, provider bodies, and legacy direct Math dispatch needed by
  non-Prepared unit kinds/coercive shapes until their migration or R9/R10.

#### M1 production landing (2026-08-02)

The exact twelve certified Math calls now enter IR as a closed, versioned
`intrinsic` instruction. AST/type lowering records only the semantic ID,
arguments, result signature, and source location. It no longer selects a Wasm
opcode or names a `Math_*` helper. The builder and verifier reject arity, type,
version, result, or callable-binding drift.

After all current middle-end passes, `prepareIrRuntimeManifest` collects the
final reachable intrinsic uses, expands and freezes their provider graph, and
attaches lookup-only provider choices before callable discovery and prepared
component sealing. Unprepared nodes are explicit dependency failures and
lowering invariants. Provider attachment is recursive and idempotent, including
nested instruction buffers and pass-created functions.

Provider behavior and existing optimizations are preserved:

- WasmGC still emits native `f64.abs`, `f64.sqrt`, `f64.floor`, `f64.ceil`, and
  `f64.trunc` instructions without boxing or calls.
- `sin`, `cos`, `exp`, `log`, `log2`, `pow`, and `atan2` still use the same
  self-hosted `Math_*` provider bodies and the same dependency helpers.
- Provider materialization is driven by the frozen manifest rather than the
  legacy pending-Math AST scan. Self-hosted provider IR uses the same manifest
  preparation recursively, so its own `Math.abs`/`floor`/`trunc` operations do
  not depend on ambient registry mutation.
- Linear IR admits exactly the five native backend operations at its legality
  boundary. The seven callable-backed operations remain fail-closed until the
  linear backend has an explicit self-host provider ABI.

Focused integration coverage proves all twelve source methods become semantic
nodes without magic helper calls, provider-free lowering fails before emission,
the frozen manifest attaches the exact five native and seven callable choices,
all twelve production bodies emit through IR with
`legacyBodyEmitted:false`, no Math host imports appear, native opcodes remain in
WAT, the established self-host helper names remain reachable, and runtime
results match the direct backend. Shadowed, coercive, wrong-arity, and
`Math.random` shapes remain outside M1.

M1 changes semantic authority but does not widen the selector, so the strict
fixed-corpus census is unchanged. The legacy direct Math route remains only for
non-Prepared shapes until their owning family slices and final R9/R10 deletion.

### A1 implementation plan — frozen async capability catalog (2026-08-26)

The first dependency-safe async checkpoint is a behavior-neutral schema
consolidation. The current async provider graph closes over typed capability
IDs, but `prepareIrRuntimeManifest` later filters the module-global
`ALL_ASYNC_HOST_ADAPTERS` table again to recover the concrete import records.
That second lookup is deterministic today, yet it leaves the frozen manifest
unable to prove the exact adapter ABI consumed by the prepared async runtime.

This documentation checkpoint may land immediately. The A1 implementation is
a separate, independently reviewed PR based on fresh `main` after this plan
lands. It does not unblock production R6 routing: public `ImportIntent`
projection, import allocation, provider transactions, lazy-registration
deletion, and any new async lowering remain blocked on the #3521 migration and
the #4260 transaction boundary. Re-ground live overlap with #4976, #4980,
#4956, and #4898 before editing; do not stack an implementation on an unmerged
compiler branch.

#### Exact closed catalog

Keep `src/ir/async-runtime-providers.ts` as the sole authority for the seven
already-shipped async capability records. Promote the existing adapter objects
themselves into the typed capability catalog; do not copy their fields into a
second table:

1. `async.callback.wrap` is `env.__make_callback`, a function with
   `(i32, externref) -> externref` and exact exception policy
   `module-tag-payload`.
2. `async.promise.capability.create` is `env.Promise_new_pending`, a function
   with `() -> externref`.
3. `async.promise.react` is `env.Promise_then2`, a function with
   `(externref, externref, externref) -> externref`.
4. `async.promise.resolve` is `env.Promise_resolve`, a function with
   `(externref) -> externref`.
5. `async.promise.settle.fulfill` is `env.Promise_settle_resolve`, a function
   with `(externref, externref) -> externref`.
6. `async.promise.settle.reject` is `env.Promise_settle_reject`, a function
   with `(externref, externref) -> externref`.
7. Optional `async.value.undefined` is `env.__get_undefined`, a function with
   `() -> externref`.

The catalog is closed, canonically ordered by capability ID, and deeply frozen
through each parameter/result array. Arbitrary input traversal order is
normalized to that canonical order; non-canonical record contents are rejected.
Capability IDs stay the provider-edge currency so the runtime-feature fixed
point remains target-neutral. The frozen manifest resolves each selected ID
exactly once. Keep
`FrozenRuntimeManifest.hostCapabilities` as the sorted ID compatibility
projection and add `hostCapabilityRecords` as the correspondingly sorted exact
records consumed by prepared runtime projection. Each host
`PreparedIrAsyncHostAdapter` carries the exact selected frozen record alongside
its symbolic target, so codegen materialization receives the manifest authority
instead of reconstructing it. Missing, duplicate, unknown, or non-canonical
definitions are preparation-time invariants; no consumer may silently skip
them or refilter a different global catalog.

Do not invent `permissions`, compile-mode availability, ABI versions, digests,
or policy defaults in A1. The repository's root
`src/capability-registry.ts` has a broader permission/version contract and an
unsafe dependency direction for direct reuse here. A later checkpoint may
extract dependency-neutral primitives after the permission and compile-mode
vocabularies are designed, but A1 must neither create empty permissions as
authority nor introduce a cyclic IR-to-root registry dependency.

#### Production ownership

The implementation owns only these schema and projection seams:

- `src/ir/async-runtime-providers.ts`: define the one closed capability record
  catalog and its fail-closed ID resolver by reusing `AsyncHostAdapter` as the
  record type; do not introduce a parallel record interface. Publish an exact
  structural validator plus an identity-based canonical-record guard over the
  factory-created frozen objects. Validation rejects missing or extra keys and
  any unexpected `exceptionPolicy`, not only wrong field values. The guard may
  authenticate an attachment but must not return a second record or let
  codegen rediscover ABI fields by ID.
- `src/ir/runtime-manifest.ts`: resolve selected provider capability IDs to the
  exact records during `freeze()`, retain `hostCapabilities` as the canonical
  ID projection for provider assertions, publish the exact records as
  `hostCapabilityRecords`, and deep-freeze both views. A test-only builder
  catalog option may supply reversed or malformed records; production always
  uses the single async catalog.
- `src/ir/async-plan.ts`: extend `PreparedIrAsyncHostAdapter` with the exact
  frozen capability record selected by the manifest under required field
  `record`. Keep the existing capability ID and symbolic `IrFuncRef` as
  explicit joins; do not flatten or recopy record fields into the attachment.
- `src/ir/intrinsic-support.ts`: in the existing async adapter-selection block
  only, consume the resolved records published by the frozen manifest instead
  of filtering `ALL_ASYNC_HOST_ADAPTERS`, and attach that exact record to the
  prepared host runtime.
- `src/codegen/ir-async-runtime-adapters.ts`: remove the
  `ALL_ASYNC_HOST_ADAPTERS` catalog reconstruction. Authenticate that each
  attachment carries a canonical catalog record whose ID and import binding
  match the attachment, deduplicate by exact capability ID, sort selected
  records canonically, and derive type/import materialization only from those
  attached records. Existing imports are still byte-exactly validated and
  reused.

Do not edit `src/ir/integration.ts`, `src/ir/from-ast.ts`, lowering, backend
legality/emission, Program ABI planning, public `src/index.ts`, or
`src/compiler/import-manifest.ts`. A1 changes the internal authority consumed
by async import materialization and deliberately adds the internal `record`
field to each host runtime attachment, but changes no provider choice, target
policy, concrete import spelling/order/signature, semantic async plan, Wasm,
declaration, or public compile-result shape. The host path still materializes
exactly the existing six mandatory imports; the standalone-native path still
materializes none.

#### Anti-vacuity and mutation matrix

Keep the test ownership bounded to
`tests/issue-3526-ir-runtime-manifest.test.ts`,
`tests/issue-4103-ir-async-runtime-providers.test.ts`, and
`tests/issue-4104-ir-async-plan-runtime-consumer.test.ts`.

- Prove forward and reversed feature/provider traversal publish byte-equivalent
  canonical ID and record projections. Every manifest, catalog record, and
  nested parameter/result array must be frozen.
- For the full host async feature set, require the exact six mandatory records,
  unique IDs, and the current adapter order/signatures. Requesting the optional
  undefined feature adds only its seventh exact record. Math-only and
  standalone-native manifests retain zero capability records.
- Prove the prepared host runtime's import bindings are derived from the
  manifest records and remain the exact six current `env` imports. Supply a
  poisoned or reversed catalog through the explicit test-only builder seam;
  after freeze, the published plan must remain immutable and lookup-only.
- Replace the current assertions that the entire serialized manifest omits
  concrete adapter fields. The target-neutral `IrAsyncPlan`, feature closure,
  and provider edges must remain free of module/field spellings, while the new
  `hostCapabilityRecords` projection intentionally contains the exact concrete
  ABI selected before materialization.
- Substitute, drop, duplicate, or cross-wire an attachment's record, capability
  ID, or symbolic target after preparation. The canonical attachment check in
  materialization must reject before type or import allocation. Reordering
  functions or attachments must retain canonical import order and the same
  Program-ABI dependencies.
- Reject a dropped or duplicated record; an unknown or mismatched capability
  ID; wrong module, field, kind, parameter, result, or callback exception
  policy; a provider that names an unregistered capability; an optional record
  appearing in the selected `hostCapabilityRecords` projection without a
  provider edge that requests it; and any late capability request after freeze.
  The complete closed catalog legitimately retains the optional definition
  even when no manifest selects it.
- Retain strict-no-host and missing-linear-adapter failures, scheduler features
  with no concrete capability, native-managed providers with no host
  capability, async owner/currentness failures, exact Program-ABI planning of
  the six imports, and all existing M1 Math controls.

Run `tests/issue-4106-ir-async-fetch-user.test.ts` and
`tests/issue-4167-async-rejection-identity.test.ts` unchanged as affected
regression controls; they do not widen A1 test-file ownership.

The tests must demonstrate that deleting the manifest-to-record join or
restoring either the prepared-runtime or codegen consumer-side global filter
fails. A renamed or reordered concrete adapter may affect only the
catalog-backed ABI projection; it cannot change semantic feature/provider
closure or be rediscovered from an emitted import string.

#### Landing and hold gates

Run focused tests first, then TypeScript 7 and 5, formatting, IR layering,
fallback/dialect/oracle checks, and the function and LOC regrowth ratchets. Run
the LOC ratchet again immediately before the signed commit, followed by every
normal pre-commit and pre-push hook without skips. Each heavy boundary uses a
fresh finite, non-negative one-minute load sample strictly below
`logical cores - 2` (10 cores means `< 8`). Obtain an independent read-only
audit of the exact signed head before push, open the implementation PR ready
for review, and keep production R6 routing blocked until its upstream
transactions and typed permission/mode contract are separately approved.

#### A1 implementation evidence — 2026-08-28

The bounded A1 checkpoint is implemented without opening production R6
routing. `async-runtime-providers.ts` now owns one exact, deeply frozen
seven-record catalog. Manifest freeze validates that complete catalog, resolves
each selected provider capability ID once, and publishes the corresponding
canonical record identities beside the compatibility ID projection. Prepared
host attachments retain those exact records, and codegen authenticates their
identity, capability, and symbolic binding before any type/import allocation.
ABI materialization reads only the attached records; the semantic provider
graph supplies only the expected capability-ID census, including a focused
control proving that a valid two-capability plan is not widened to all six
imports.

The three owned suites pass 26 focused tests covering reversed provider,
feature, catalog, function, and attachment traversal; full and partial provider
closure; the optional seventh record; exact record/target joins; Program-ABI
dependencies; deep freeze; and malformed, missing, duplicated, cloned,
substituted, or cross-wired catalogs and attachments. TypeScript 7 and 5,
Prettier, IR layering, IR/codegen fallback, IR dialect, and oracle ratchets pass.
The unchanged #4106 and #4167 affected controls each retain one
standalone-native `WebAssembly.validate` failure that reproduces identically on
clean `fb4c01e6ad4f00c116897d7686d5c96c31426465`; their other 13 assertions pass.
That preserved baseline is not A1 acceptance evidence, was not weakened, and
A1 makes no standalone-native runtime acceptance claim.

The checkpoint changes no provider choice, public compile result, semantic
async plan, concrete import spelling/signature/order, lowering, or Wasm policy.
The issue remains `blocked`: public import-intent projection, provider
transactions, lazy-registration deletion, and typed permission/mode authority
still require their separately approved upstream checkpoints.

### A2 implementation plan — per-owner provider and backend-requirement attachment (2026-08-28)

A1 freezes exact host capability records, but it does not yet preserve the
complete provider decision consumed by each async function. During
`prepareIrRuntimeManifest`, the implementation resolves each plan's
`runtimeIntents` to exact provider records, derives a temporary host/native
projection, and then discards those records. The global manifest is a union
across functions. Backend code consequently re-filters the global
`ASYNC_RUNTIME_PROVIDERS` catalog from `fn.asyncPlan.runtimeIntents`, and both
the adapter materializer and frame lowerer reread `runtimeIntents` to decide
whether native `undefined` support is required. A multi-function manifest can
therefore describe a strict superset of one owner's needs, while the backend
is again responsible for reconstructing the per-owner semantic choice.

A2 is a behavior-neutral authority transfer. It retains the exact selected
provider records and a closed backend-requirement projection on each prepared
async runtime, then makes both codegen consumers use only that attachment. It
does not change async selection, runtime semantics, target policy, public
`ImportIntent`, provider choice, import spelling/order/signature, Wasm output,
or runtime results. It also does not delete the existing scheduler, native
Promise, number-boundary, or canonical-undefined provider implementations;
turning those mutable registries into a fully staged transaction is a later
#4260/R6 checkpoint.

#### Closed attachment contract

Add the canonical backend requirement vocabulary:

```ts
type RuntimeBackendRequirement =
  | "async.native.drive"
  | "async.native.number-boundary"
  | "async.native.undefined";
```

The order above is canonical. Host providers project no backend requirements.
Every standalone-native async owner projects `async.native.drive` and
`async.native.number-boundary`; only an owner whose exact selected provider set
contains `native.value.undefined` also projects `async.native.undefined`.
Unknown, duplicate, missing, extra, or reordered requirements are invariants.

`FrozenRuntimeManifest` publishes `backendRequirements` as the deeply frozen,
canonical union selected by all manifest providers. `PreparedIrAsyncRuntime`
retains, for one exact owner:

- the exact frozen manifest object used for selection;
- the exact frozen `IrAsyncPlan` object it authenticates;
- the exact provider objects selected for that plan, in their canonical
  manifest order;
- the exact per-owner backend requirements; and
- the existing attached state bodies, type layouts, and host adapters.

Do not clone provider definitions into a new async catalog. Each attached
provider must be the exact object in `manifest.providers`, and each host
adapter record must remain the exact object in
`manifest.hostCapabilityRecords`. A shared IR-side validator must prove, before
any backend allocation, that the plan and manifest objects are current; the
provider feature set is exactly the plan's canonical intent set; every
provider ID, feature, dependency, implementation, target, backend, and host
capability belongs to the frozen manifest record; the per-owner requirements
are exactly the projection of those providers; and the runtime kind, adapter
set, and target policy agree. This validator owns the semantic join. Codegen
may call it but may not inspect `runtimeIntents` or a global provider catalog.
The attachment envelope, state array and state records, and every attached
state-body instruction tree must remain frozen; trusted copy-on-write passes
re-seal only the exact body they rewrote, while final consumers reject mutable
post-authentication evidence.

The global union is evidence and a freeze-time late-request guard, not
permission to widen an owner. In a two-function standalone manifest where only
one function returns `void`, the global manifest contains
`async.native.undefined`, the void owner contains it, and the non-void owner
does not.

#### Exact production ownership

The A2 implementation owns only:

- `src/ir/runtime-manifest.ts`: define and canonicalize the closed backend
  requirements; derive the frozen global union from the selected provider
  objects; and expose one shared exact projection helper.
- `src/ir/async-plan.ts`: extend the prepared runtime attachment and own its
  fail-closed plan/manifest/provider/requirement currentness validator. The
  target-neutral `IrAsyncPlan` schema and `runtimeIntents` remain unchanged.
- `src/ir/intrinsic-support.ts`: retain each owner's selected manifest provider
  objects, attach the exact plan/manifest references, and derive the per-owner
  requirement vector through the shared helper.
- `src/ir/extern-support.ts`: preserve the attachment's frozen-container
  contract when its trusted copy-on-write pass adds extern provider references
  to prepared async state bodies. This is the only post-manifest pass in A2's
  production order that otherwise returns mutable runtime/state containers;
  the final frame consumer remains fail-closed and never repairs evidence.
- `src/codegen/ir-async-runtime-adapters.ts`: delete
  `expectedHostCapabilities`, the `ASYNC_RUNTIME_PROVIDERS` import, and the
  `IrAsyncRuntimeIntent` import. Validate every function and build a complete
  allocation-free request census first; only then materialize attached host
  records or reserve the three attached native requirements. One malformed
  later function must leave imports, types, scheduler state, Promise boundary,
  and canonical-undefined state untouched.
- `src/codegen/ir-async-frame.ts`: remove the semantic-intent read. Derive
  canonical-undefined frame behavior only from the authenticated
  `async.native.undefined` attachment. The existing idempotent drive-runtime
  lookup may remain to resolve its already-reserved Promise type; it cannot
  become a fallback semantic selector.
- `tests/issue-3526-ir-runtime-manifest.test.ts` and
  `tests/issue-4104-ir-async-plan-runtime-consumer.test.ts`: own all A2
  attachment, mutation, allocation-boundary, and two-owner controls.

Do not edit `src/ir/async-runtime-providers.ts`, `src/ir/verify.ts`,
`tests/issue-4103-ir-async-runtime-providers.test.ts`,
`src/codegen/async-frame.ts`, `src/codegen/async-scheduler.ts`,
`src/ir/integration.ts`, `src/codegen/index.ts`, context files, public compiler
APIs, or backend emitters. The in-flight Deno integration branch owns several
of those adjacent files. Recheck open PRs and dirty Claude worktrees before
every mutation; stop rather than expanding this slice into a live owner.

#### Anti-vacuity and mutation matrix

Positive controls must cover full host, partial host, standalone non-void, and
standalone void provider projections. Reverse input function, feature, and
provider traversal and require identical frozen manifestations, per-owner
attachments, concrete imports, Program ABI dependencies, and runtime output.
Repeating structurally identical manifest preparation must publish another
current authenticated attachment rather than fail on stale object identity.
Use a two-function host control to prove each owner receives only its selected
capability records, and a two-function standalone control to prove optional
undefined support does not leak from the broader owner through the global
union. Host keeps the exact current imports; standalone keeps zero host
imports. Add a static source assertion that both codegen consumers contain
neither `runtimeIntents` nor `ASYNC_RUNTIME_PROVIDERS`.

Reject before the first allocation:

1. a dropped, duplicated, reordered, cloned, substituted, or cross-wired
   provider object;
2. provider ID, feature, dependency, implementation, supported-target,
   supported-backend, or host-capability drift;
3. a dropped, duplicated, unknown, reordered, or extra backend requirement;
4. `native.value.undefined` without `async.native.undefined`, or the
   requirement without that exact provider;
5. a host provider with native requirements, a native provider with host
   adapters, a mixed host/native owner, or a host attachment presented to a
   strict-no-host or linear-backend context;
6. a cloned/cross-wired plan or manifest, plan-intent drift, a dropped whole
   runtime attachment, a runtime without a plan, both plan and runtime authority
   dropped from an async owner, and one owner receiving another owner's broader
   provider set;
7. the existing malformed host record/target/ABI cases; and
8. a valid first function followed by a malformed second function, proving the
   materializer validates the full request census before mutating any registry.

Provider and requirement arrays, their nested provider fields, the manifest,
every prepared runtime attachment, and attached state-body instruction trees
must be frozen. Canonical reordering of input traversal may not change digests
or output; reordering an already prepared attachment is corruption and must
fail.

#### Validation and landing boundary

The signed A1 baseline is 26/26 across the runtime-manifest, async-provider,
and async-consumer suites (7 + 9 + 10). Retain those and run unchanged controls:
#2864 terminal undefined (5), #2895 async frame (8), #4574 standalone native
async family (14), #4106 async fetch user (7), and #4167 async rejection
identity (5). The last two each retain one known standalone
`WebAssembly.validate` failure from A1; compare exact current-main signatures
instead of relabelling them as A2 fixes or weakening their assertions.

Refreshed `main` at `48abcb949c9d1b539cb58472256e4545cacd9dc8` under Node
24.4.1 has a broader environment/runtime baseline than A1. In a clean detached
control with exnref disabled by Node's default, these five unchanged files total
18 passing and 24 failing tests: all five #2864 cases stop at Node compile with
`Invalid opcode 0x1f (enable --experimental-wasm-exnref)`; #2895 has three
standalone `WebAssembly.validate(...) === false` controls; #4106 and #4167 each
retain one; and all fourteen #4574 standalone-native cases retain the same
false validation result. The A2 branch must reproduce that exact membership and
failure signature with zero net drift; it may not mark those rows green, delete
them, weaken assertions, or claim them as A2 defects. The extra #4110
vector/async diagnostic likewise remains exactly 18/19 on both current main and
the A2 branch, with only its existing standalone validation row false.
The final A2 refresh to `f727d529abb40cdb63803a802b1502f91e4e9016`
changes only documentation and benchmark data, so this source/test control
membership remains the applicable final-main baseline.

The A2-owned authority tests remain independently green: require the refreshed
runtime-manifest, async-provider, and async-consumer set to pass 34/34, plus the
trusted extern-support controls 9/9. Full repository hooks and CI remain the
landing authority in their configured environment; current-main equivalence is
diagnostic evidence, not permission to bypass a hook or accept a new branch-only
failure.

No LOC or function-budget allowance is authorized. Keep every touched source
file below 1,500 lines and every function below 300 lines by extracting bounded
helpers inside the owned files. Before the signed commit and push, take a fresh
finite, non-negative one-minute load sample strictly below
`logical cores - 2`; run focused and affected tests, TypeScript 7 and 5,
formatting, IR layering/dialect/fallback/oracle/optimization gates, then LOC and
function ratchets immediately before committing. Run complete precommit and
prepush hooks without bypass. Obtain an independent read-only audit of the
signed head, and open the PR ready only when its scoped diff and required gates
are mergeable; otherwise keep it draft with the exact blocker.

### Later measured family slices

Land each as an independently ratcheted child/slice, in dependency order:

1. **Scalar/coercion/value carriers:** numeric/boolean/bigint/symbol/nullish,
   boxing/unboxing, equality, conversion, dynamic tagged values, errors.
2. **String/text:** allocation, UTF encoding, concatenation, comparison,
   methods, templates, regex-facing text adapters.
3. **Callable/closures/callbacks:** direct/indirect calls, bound functions,
   host callbacks, closure environments, constructor/callable ABI.
4. **Object/property/classes:** get/set/delete/define, prototype/reflection,
   class/member/private/super semantics and dynamic objects.
5. **Collections/iterators:** arrays, typed arrays, Map/Set, iterators,
   destructuring/spread, iterator close, generators' non-async substrate.
6. **Host/DOM/Node/console/timers/linking:** ambient externs, fs/process/event
   adapters, callback imports, strict-no-host policy, WIT/link capabilities.
7. **JSON and RegExp:** parse/stringify, regex compilation/execution and host
   versus native provider selection.
8. **Promise/async scheduler:** Promise capability/reaction/settle/adoption,
   microtask/timer/async-iterator features required by #3527.

Every slice records before/after census, Prepared units, host capabilities,
provider reachability, direct emissions, and late-mutation attempts. Family
completion is structural, not a decrease in one fallback bucket.

## File ownership and locks

C0 and M1 require one owner for new intrinsic/manifest modules, the named IR
core/select/effects files, `src/codegen/declarations/import-collector.ts`,
`src/codegen/registry/imports.ts`, `src/codegen/expressions/late-imports.ts`,
the Math call/collector/provider files, `src/codegen/stdlib-selfhost.ts`, and
`src/compiler/import-manifest.ts`. Splitting the fixed-point/freeze invariant
across parallel writers is unsafe. #3525 overlaps `index.ts`, integration, and
context; land C0's new-module schema first or assign one sequential integration
owner rather than parallel-writing those shared hooks.

Later family slices may run in parallel only when their provider files and
intrinsic IDs are disjoint and C0's manifest schema is frozen. Coordinate the
Promise/iterator slice with #3527 and all backend adapter changes with #3528.

## Anti-vacuity tests

`tests/issue-3526-ir-runtime-manifest.test.ts` must prove:

1. A hand-built Prepared program produces the same sorted intrinsic/feature
   manifest under reordered maps and source traversal; fixed-point dependencies
   appear once and cycles terminate canonically.
2. Host, strict-no-host, standalone, and WASI derive the expected minimal
   `HostCapability` sets before emission. Public `ImportIntent` exactly projects
   that set and is unchanged by concrete helper spelling or function index.
3. An undeclared intrinsic, bad signature, missing provider, missing backend
   adapter, forbidden capability, or provider dependency added after freeze
   fails with the correct typed outcome before any body is published.
4. Poison `addImport`, `ensureLateImport`, type/global/helper/literal insertion,
   and resolver mutation after freeze. Prepared lowering remains green only
   when every lookup was planned.
5. M1 exercises all twelve certified direct/self-host Math entries and proves
   JS equivalence, zero Math host capability/import, canonical transitive
   provider closure, and `legacyBodyEmitted:false`. `pow -> exp+log`,
   `atan2 -> atan`, and `sin/cos -> reduce_trig` dependencies occur once;
   `Math.random` remains visibly outside M1.
6. A test-only provider-name change leaves the semantic manifest stable while
   the concrete ABI projection updates; a string-prefix classifier cannot
   become the source of truth.
7. Dead-edge reachability proves migrated Math AST dispatch is unreachable,
   while the corresponding `math-helpers.ts` provider remains reachable from a
   typed `RuntimeFeature`.
8. A locally or parametrically shadowed `Math` requests no intrinsic/provider.
   Extra/wrong arity and Symbol/dynamic coercion remain typed non-M1 cases; an
   unused provider is absent and reordered uses/maps retain canonical order.
9. Provider TypeScript IR and signatures are prepared before freeze. Poisoning
   `pendingMathMethods`, live `funcMap`, or provider/type/helper insertion during
   lowering cannot affect a Prepared M1 unit.
10. Typed projections include intentional non-`env` string import namespaces;
    they cannot vanish merely because the old manifest filtered to `env`.

Run M1 with `tests/math-inline.test.ts`, `tests/math-minmax.test.ts`,
`tests/issue-2856-builtins-component.test.ts`,
`tests/equivalence/math-builtins.test.ts`,
`tests/equivalence/math-constants.test.ts`,
`tests/equivalence/math-minmax-spread.test.ts`,
`tests/equivalence/math-pow-coercion.test.ts`,
`tests/issue-1732-math-symbol-coercion.test.ts`,
`tests/issue-2933-variadic-math-value.test.ts`,
`tests/issue-3141.test.ts`, `tests/issue-3226.test.ts`,
`tests/issue-3233.test.ts`,
`tests/host-import-allowlist-gate.test.ts`,
`tests/host-import-allowlist-budget.test.ts`, and standalone import-leak checks.

## Acceptance criteria

- [ ] Prepared IR carries typed `IntrinsicId`s whose signatures/effects are
      verified without concrete imports, indices, helper names, or callbacks.
- [ ] One deterministic fixed-point manifest maps all intrinsic uses through
      `RuntimeFeature` providers to minimal `HostCapability`s and freezes before
      backend/body lowering.
- [ ] `ImportIntent` is solely a projection of the frozen capability manifest;
      emitted-import string classification is not production authority.
- [ ] The manifest exposes deterministic decision IDs and source/provenance data
      sufficient for #4382 to generate its capability report without a parallel
      feature table or post-emission inference.
- [ ] Resolver/import/type/global/literal/helper state is lookup-only after
      freeze. Every undeclared or late request is a fatal typed Invariant.
- [ ] The exact twelve-method pure-Math M1 uses typed intents, has no legacy
      collector/name/dispatch authority on the Prepared route or Math host
      import, and retains its shared runtime providers. Coercive and not-yet-
      Prepared direct units remain explicitly outside this deletion boundary.
- [ ] Each later family lands with explicit census, target matrix, transitive
      feature closure, zero-direct evidence, and reachability/deletion proof.
- [ ] Runtime/provider behavior remains single-sourced and callable from both
      WasmGC and linear adapters; no provider is copied into IR lowering.
- [ ] IR-only, equivalence, cross-backend, import-allowlist/leak, standalone/
      WASI validity, typecheck, format, and merge-group Test262 gates are
      net-non-negative.

## Deletion boundary

R6 deletes only Prepared-route AST semantic dispatch/string inference/lazy
registration edges after a family is proven exhaustive and compile-once. Since
R6 depends only on R2, M1 does not delete global legacy `compileMathCall` or
dispatch used by Unsupported coercive forms, classes/closures/module init, or
other not-yet-Prepared owners; those survive until their migration or R9/R10.
R6 explicitly retains runtime provider implementations, coercion/collection/
regex/scheduler substrates, and backend adapters. Final general direct-
frontend deletion remains #3090/R10.

## Out of scope

- Reimplementing runtime behavior inside `src/ir/` or duplicating providers per
  backend.
- Treating concrete helper/import names as stable semantic IDs.
- Folding host capability policy into the selector or backend emitter.
- Claiming all ~47K runtime lines migrate in one unreviewable commit.

## Risks and mitigations

- **Dependency under-approximation:** one missing transitive helper appears only
  during lowering. Verify provider graphs to fixed point and poison all late
  mutation paths.
- **Provider/front-end confusion:** deletion could remove behavior rather than
  dispatch. Maintain a reachability ledger with separate FRONTEND and RUNTIME
  classifications from #3090.
- **Target leakage:** host capability may be requested in standalone/WASI.
  Validate the frozen set per mode before slots exist and run import leak gates.
- **Index/order drift:** replacing lazy discovery can reorder ABI entries.
  Canonically sort typed IDs, allocate once through `ProgramAbiMap`, and compare
  non-semantic output changes explicitly.
- **Math slice widening:** `Math.random`, dynamic coercion, or variadic calls can
  make M1 impure. Define M1 by the exact deterministic table entries and reject
  unlisted shapes until their later family slice.

## 2026-08-29 F1-S1 implementation plan — number-boundary intrinsics (family 1, slice 1)

**Fable lane.** Grounded on `origin/main` merged at `fe3fe11e52`. This is the
first slice of "Later measured family slices" item 1 (scalar/coercion/value
carriers). It follows the A1/A2 shape: a behavior-neutral authority transfer
with an exact ownership list, no provider-choice change, no Wasm delta on any
clean lane. Opus implements against this plan; every cited line number must be
re-located by symbol before editing.

### Measured facts (verified on the grounded tree)

- The family-1 beachhead already exists and is wired end-to-end:
  `NUMERIC_COERCION_INTRINSIC_IDS = ["js.to_uint32"]`
  (`src/ir/intrinsics.ts:51`), feature (`:98`), signature row (`:194`,
  `F64_TO_U32_INTRINSIC_SIGNATURE`), provider `backend.js.to_uint32`
  (`src/ir/runtime-manifest.ts:105`, `:324`), backend composite `"to-uint32"`
  (`src/ir/intrinsic-support.ts:37` — the composite table also carries
  `math.clz32/imul/max/min`). Copy this pattern, do not invent a parallel one.
- The number boundary is the widest un-migrated coercion carrier, and its IR
  authority is currently split across name-symbolic emission and resolver mode
  proxies:
  - **Box arm** — `coerceToExpectedExtern` (`src/ir/from-ast.ts:6929-6947`):
    f64→externref emits `emitCall(irImportFuncRef("env", "__box_number"))`
    gated on `cx.resolver?.hasHostNumberBox?.()`. Standalone has NO
    `__box_number` (its boxing is the `$AnyValue` family) so the predicate is
    false there and the arm falls through to the demote throw.
  - **Unbox arm** — the declared-f64 return coercion
    (`src/ir/from-ast.ts:8936-8948`): both lanes own `__unbox_number`
    `(externref) -> f64`; the PROVIDER choice is inlined in from-ast —
    `hasHostNumberBox()` → `irImportFuncRef("env","__unbox_number")`, else
    `hasNativeNumberUnbox()` → `irRuntimeFuncRef("__unbox_number")` (the
    native function `addUnionImports` registers under
    `semanticProviders: "native-first"`, #4461), else return unconverted.
  - The predicate implementations are one-line mode reads on the
    integration resolver: `hasHostNumberBox(): !ctx.nativeStrings`
    (`src/ir/integration.ts:4722`), `hasNativeNumberUnbox():
    ctx.targetProfile.semanticProviders === "native-first"` (`:4749`). #2955
    moved these OUT of from-ast precisely so the front-end reads no mode
    flags; F1-S1 finishes the move by making the answer a frozen-manifest
    fact instead of a live mode read.
  - These two arms are the ONLY from-ast consumers of the two predicates
    (measured: `from-ast.ts:6939`, `:8936-8938`; every other hit is doc
    text). `hasHostBooleanBox` (boolean boxing) is a separate consumer family
    and stays untouched.
  - Name-symbolic joins elsewhere in IR:
    `src/ir/compiler-timer-shim-preparation.ts:42,244-278` resolves
    `__box_number`/`__unbox_number` by `ctx.funcMap.get(name)`;
    `src/ir/async-prepare.ts:805-808` authenticates a carrier unbox by target
    NAME `"__unbox_number"`. Both are in-scope consumers of the new records
    (join by attached record, keep the name as diagnostic), IF the join is a
    mechanical substitution; otherwise record them as follow-up rows — do not
    widen.
- `prepareIrRuntimeManifest` runs at `src/ir/integration.ts:752`, after
  lowering and before prepared-component sealing (the M1 ordering), so
  provider choice at freeze-time and intrinsic emission at lowering-time is
  the established order. `IrInstrIntrinsic` (`src/ir/nodes.ts:867`) is the
  node to reuse.
- A2 already publishes `RuntimeBackendRequirement` including
  `async.native.number-boundary` for async owners — the number boundary is
  already a named backend concept; F1-S1 gives it a family-owned intrinsic
  identity for the two synchronous coercion arms.

### Contract

Add to the closed vocabularies (canonical order, versioned signatures):

- `js.number.box` — `(f64) -> externref`. Target policy: HOST-ONLY for this
  slice. A native-first/standalone request is a preparation-time typed
  `Unsupported` naming the intrinsic — exactly the population that demotes at
  the box arm today, moved to a typed reason. The `$AnyValue` standalone
  boxing family is explicitly NOT this intrinsic and NOT this slice.
- `js.number.unbox` — `(externref) -> f64`. Target policy: host AND
  native-first. Two providers, chosen at freeze exactly as the from-ast
  inline pick does today:
  - `host.js.number.unbox` → host capability record `env.__unbox_number`
    `(externref) -> f64`;
  - `native.js.number.unbox` → the union-native `__unbox_number` function
    (symbolic runtime funcref; NO host capability).
- `host.js.number.box` → host capability record `env.__box_number`
  `(f64) -> externref`.

The two host records are the FIRST non-async `HostCapability` records. Reuse
A1's record machinery (`AsyncHostAdapter`-style exact frozen records,
`hostCapabilityRecords` projection, canonical-record guards) — generalize the
record type's name if needed, but do NOT create a second record table or a
second resolver. Feature rows mirror 1:1 (the `js.to_uint32` pattern); the
callable-backed provider attachment follows the seven self-host Math
methods, not the five native-opcode ones.

### Production changes (exact ownership)

1. `src/ir/intrinsics.ts` — the two IDs, signatures, features.
2. `src/ir/runtime-manifest.ts` — the three providers, target policies, host
   capability records, freeze/verification rows.
3. `src/ir/from-ast.ts` — the two arms emit `intrinsic` nodes (id, args, f64/
   externref result, source location) with NO provider and NO predicate read.
   Delete `hasHostNumberBox`/`hasNativeNumberUnbox` from the from-ast
   resolver contract ONLY if the final trace confirms no other consumer;
   otherwise leave the contract entries and delete just these two reads.
4. `src/ir/intrinsic-support.ts` — provider attachment for the two IDs
   (callable-backed pattern); the host arm attaches its exact capability
   record, the native arm its runtime funcref.
5. `src/ir/integration.ts` — provider selection at manifest preparation from
   the target profile (the SAME `!ctx.nativeStrings` /
   `semanticProviders === "native-first"` facts, now consulted exactly once,
   at freeze); the resolver predicate implementations are deleted with their
   contract entries or left for non-from-ast callers per the trace.
6. Timer-shim and async-prepare joins per the measured-facts caveat.

Do NOT touch: legacy codegen emission of `__box_number`/`__unbox_number`
(`coerceType`, deno-api, generators-native-consumer, builtin-value-read — the
direct-route substrate stays until R9/R10), `addUnionImports` registration,
`__box_boolean`/`__box_symbol`, `__any_to_f64`/`__to_primitive`/equality
(later F1 rows), the #2108 coercion-sites gate baseline, and the public
`ImportIntent` projection.

### Behavior-neutrality obligations (each is a test)

1. **Host lane byte-parity**: fixtures whose IR bodies box (f64→externref
   argument/return) and unbox (the #4461 `Map.get` return-hit shape) compile
   byte-identically before/after — same `env` imports, same call sites.
2. **Native-first unbox parity**: the standalone `Map.get` shape still
   IR-emits and calls the union-native `__unbox_number`; runtime parity.
3. **Standalone box parity**: every shape that demotes at the box arm today
   still demotes — now as preparation-time typed `Unsupported` naming
   `js.number.box`. The strict fixed-corpus census
   (`pnpm run check:ir-fallbacks`) must be unchanged in every unintended
   bucket; a reason-string migration inside the same bucket is acceptable,
   a bucket count change is not.
4. **Freeze discipline**: a post-freeze request for either intrinsic is an
   invariant; provider substitution/duplication/cross-wiring on the
   attachment rejects before materialization (A2's mutation matrix shape).
5. **Canonicalization**: reversed traversal publishes byte-equivalent
   manifest projections; the two new records appear in
   `hostCapabilityRecords` only when a provider edge requests them —
   async-only and Math-only manifests keep their current record sets.
6. **Non-vacuity**: reverting only the from-ast arm changes (keeping the
   schema) must fail the new tests (the intrinsic path, not the old inline
   path, carries the fixtures).

### Required pre-implementation verifications (record answers in the checkpoint note)

- Full-repo trace of `hasHostNumberBox`/`hasNativeNumberUnbox` consumers
  (expected: the two from-ast arms + integration implementations only).
- The `gen.setReturn` boxing path (`from-ast.ts` ~2010, throws to legacy when
  the box helper is unresolvable): confirm whether it routes through
  `coerceToExpectedExtern` (then it is covered) or emits its own
  `__box_number` join (then it is an explicit follow-up row, not silent
  scope).
- Who guarantees the union-native `__unbox_number` exists when a prepared
  body calls it (materialization trigger for `irRuntimeFuncRef` resolution)
  — the manifest records the choice; materialization must keep its current
  owner.
- Whether `IrInstrIntrinsic` lowering for callable-backed providers already
  handles externref args/results (the Math seven are all-f64).

### Validation

Focused suite (`tests/issue-3526-ir-runtime-manifest.test.ts` ownership +
a new `tests/issue-3526-number-boundary-intrinsics.test.ts`), the M1/A1/A2
suites unchanged, `tests/issue-4106-ir-async-fetch-user.test.ts` and
`tests/issue-4167-async-rejection-identity.test.ts` as controls; typecheck;
`pnpm run check:ir-fallbacks` bare; ratchet chain bare + `LOC_GATE_BASE`
CI-base simulation; hooks without bypass. Acceptance: all six neutrality
obligations green, census unchanged, the two arms free of predicate reads.

## 2026-08-30 Sol correction — F1-S1 provider and preparation authority

The 2026-08-29 F1-S1 plan is not implementation-ready as written. This
correction is grounded on `origin/main`
`4881206ab3001505fcfca875589aff8daf375ff9` and supersedes its inaccurate
facts and incomplete ownership list. No source implementation may begin until
the overlapping Claude IR PR #5218 has merged, this branch has been rebased on
the resulting `origin/main`, and the exact-file collision census has been
repeated.

### Corrected facts and retained control paths

- Standalone does define native `__box_number` and `__unbox_number` through
  the union-native family. The current f64-to-externref Prepared arm is
  host-only by *policy* (`!ctx.nativeStrings`), not because standalone lacks a
  helper. F1-S1 must preserve that policy and may not infer support from helper
  presence.
- `RuntimeManifestPolicy` currently carries only `target` and `backend`.
  `prepareBuiltFnRuntimeManifest(...)` maps ordinary GC and GC native-first to
  the same host target, while the existing choice additionally depends on
  `nativeStrings` and `semanticProviders`. Provider selection therefore
  requires one frozen number-boundary policy projection containing those exact
  facts; target alone is insufficient. In particular, distinguish ordinary
  host-assisted GC, GC native-first, and host-assisted GC with explicit native
  strings. Do not read the live codegen context after freeze.
- Executable `hasHostNumberBox` implementations exist in integration, the
  linear adapter, and the self-hosted stdlib adapter; `hasNativeNumberUnbox`
  exists in integration. Removing the resolver contract requires updating all
  implementations, not only integration. The linear adapter must keep the new
  externref intrinsics rejected/demoted unless it receives an exact supported
  provider policy.
- `gen.setReturn` does not flow through `coerceToExpectedExtern`. It attaches a
  direct runtime `__box_number` reference through `boxProvider`; that path is a
  named control/follow-up and remains unchanged in this slice.
- `src/ir/async-prepare.ts` recognizes its exact numeric-return roundtrip as a
  raw call to `env.__unbox_number`. Once from-ast emits a provider-free
  intrinsic, that optimization would stop firing. Update this consumer
  mechanically to accept the exact intrinsic ID, version, argument, and result
  shape while retaining its existing raw-import form for legacy owners.
  `compiler-timer-shim-preparation.ts` is a different dynamic box/to-number
  family and remains unchanged unless a later exact trace proves a mechanical
  join.
- A physical union import is shared by several raw consumers. Do not replace
  its `irImportFuncRef` identity with a capability-only identity. Retain the
  canonical host-capability record as manifest authority while lowering to
  the same physical import target.

### One host-capability catalogue

Generalize the existing async-only capability authority into one central
runtime host-capability catalogue, for example
`src/ir/runtime-host-capabilities.ts`; do not add a second table.

1. The closed ID and record unions contain the existing async capabilities and
   the two number-boundary host records. Value types gain `f64` alongside
   `externref` and `i32`. Records retain canonical object identity, exact
   namespace/name/signature, and exception-policy semantics.
2. `async-runtime-providers.ts` must expose narrowed compatibility aliases and
   derive its complete async-only projection from the central table.
   `AsyncHostAdapterValueType` remains exactly `externref | i32`, and
   `AsyncHostAdapter` excludes every new f64 record. Do not re-export the
   widened central union under either async name: the existing async adapter
   materializer treats every non-i32 row as externref and would silently
   mislower f64. Existing async manifests must remain byte-for-byte and
   record-for-record unchanged.
3. `FrozenRuntimeManifest.hostCapabilityRecords` carries the generalized
   record union. Canonicalization validates the complete central catalogue,
   while an individual manifest includes only the exact records requested by
   its provider closure. Math-only, async-only, and empty manifests may not
   acquire number records.
4. No intrinsic instruction duplicates a capability record. The manifest is
   the record authority; the attached provider/target retains enough exact
   identity for verification and lowering.

### Synchronous callable provider implementations

The existing callable intrinsic plumbing is ABI-generic enough for externref,
but its provider model is not. `RuntimeProviderPlan` and
`IntrinsicRuntimeProviderImplementation` currently admit backend/self-hosted
implementations only; `providerAttachment(...)` always constructs an
`irIntrinsicFuncRef`, and provider resolution only accepts the prepared Math
index for an intrinsic target. Copying the seven Math rows is therefore not a
valid implementation.

Add two explicit synchronous callable implementation kinds:

- `host-callable`, naming an exact central host-capability ID and deriving the
  canonical physical `irImportFuncRef`; and
- `runtime-callable`, naming the exact runtime symbol and deriving the
  canonical `irRuntimeFuncRef`.

Keep the existing async `host-capability` implementation non-callable and keep
self-hosted Math unchanged. Extend intrinsic nodes/provider equality,
verification, attachment, provider observation, and lowering only as required
to recompute and authenticate these exact target kinds. A wrong capability,
wrong runtime symbol, cloned/mismatched binding, wrong signature, provider
substitution, duplicate attachment, or post-freeze request is an Invariant
before materialization. The semantic instruction identity remains the
versioned `IntrinsicId`; the physical target remains the existing import or
runtime funcref so legacy consumers and byte order do not drift.

### Exact policy and owner-local preparation

Freeze an explicit, already-resolved number-boundary provider policy per
preparation caller with the runtime manifest. Global target/mode facts are
inputs only; they are not the final policy because adapters deliberately expose
different support. The caller projections are exact:

- integration derives the current host/native truth table from its exact
  `nativeStrings` and `semanticProviders` facts;
- linear resolves both number-boundary arms disabled; and
- stdlib selfhost resolves both arms disabled, even when an ambient host
  context has `nativeStrings === false`.

Within the integration projection, preserve the current decisions exactly:

- host box and host unbox are selected only when `nativeStrings === false`;
- native unbox is selected only when
  `semanticProviders === "native-first"`; and
- all other combinations retain their current unsupported/no-conversion
  behavior. Native `__box_number` presence must not widen the box policy.

The current integration prepares one aggregate runtime manifest for all
healthy functions inside `runGlobalPreparation`; a
`provider-target-unavailable` throw consequently fails every owner. Moving a
box rejection to preparation without changing that lifecycle would turn one
owner-local demotion into `unexpected-internal-throw` for unrelated owners.
Before deleting the from-ast predicate, partition the decision by exact
terminal owner (or an equally exact component boundary):

1. determine provider-policy support before any body, slot, alias, outcome, or
   manifest prefix is published;
2. classify unavailable number-boundary policy for only the requesting
   owner/component as the existing exact outcome
   `kind:"unsupported"`, `code:"late-preparation-unsupported"`,
   `stage:"resolve"`, with a canonical detail that names the exact
   `IntrinsicId` and resolved caller policy; do not add a new outcome code;
3. remove that owner's candidate artifacts, then prepare one deterministic
   frozen manifest over the surviving owners; and
4. keep structural manifest corruption and late mutation fatal for the whole
   transaction.

The required non-vacuity is one standalone box owner beside an unrelated clean
IR owner: the box owner records Unsupported/direct exactly once, the clean
owner remains Prepared exactly once, and no failed-owner slot, alias, outcome,
or body prefix survives. Reordered owner input produces the same surviving
manifest and accounting.

### Materialization without ABI drift

Today a raw `__unbox_number` call makes preregistration invoke
`addUnionImports`, which materializes the complete canonical union family.
Replacing the call with an intrinsic would otherwise remove that trigger and
change import membership/order.

- Preserve `addUnionImports` as the physical whole-family materializer.
- After provider attachment and before body indices freeze, make
  preregistration recognize the exact host import and native runtime targets
  attached to `js.number.box`/`js.number.unbox`, then invoke the same
  materializer.
- Let the existing exact import resolver/runtime observer resolve those
  targets; do not add name scanning or a second allocator.
- Add an isolated synthetic intrinsic fixture whose only union-family trigger
  is the new attached provider. A #4461 Map fixture alone is vacuous because
  its other adapter paths already materialize the union family.
- Compare import set, order, signatures, indices, and Wasm bytes with the
  legacy control in every clean lane.

### Revised production ownership

The implementation owner may edit only the following initially approved
surface, with any expansion requiring another Sol plan amendment before edit:

- `src/ir/intrinsics.ts`
- `src/ir/runtime-manifest.ts`
- one new central host-capability catalogue
- `src/ir/async-runtime-providers.ts`
- `src/ir/nodes.ts` and the exact verifier/provider-equality consumer
- `src/ir/intrinsic-support.ts`
- `src/ir/async-prepare.ts`
- `src/ir/from-ast.ts`
- `src/ir/integration.ts`
- `src/ir/backend/linear-integration.ts`
- `src/codegen/stdlib-selfhost.ts`
- focused #3526 manifest/number-boundary tests and existing directly affected
  async/provider tests.

Do not edit `src/codegen/index.ts`, declarations, raw union registration,
compiler timer-shim preparation, timer shims, generator `setReturn`, public
import projection, or direct codegen handlers without first recording an exact
authority trace and amending this lock. No LOC/function/baseline exception is
authorized by the broad historical frontmatter list.

### Acceptance matrix and coordination gate

In addition to the earlier six obligations, acceptance requires:

- all three GC number-boundary policy combinations above, plus standalone,
  WASI, linear, and self-hosted controls;
- exact provider-attachment mutations for host/runtime crosswire, wrong
  capability/symbol/signature, duplicate, late request, and non-canonical
  capability record;
- the owner-local unsupported-plus-clean-owner transaction test;
- isolated whole-union materialization plus exact import/order/byte parity;
- the exact async-prepare intrinsic roundtrip and unchanged raw-import control;
- unchanged `gen.setReturn`, compiler timer shim, boolean/symbol/AnyValue,
  async-only, and Math-only projections; and
- bare fallback census, TypeScript 7 and 5, focused/equivalence/standalone/WASI
  tests, IR dialect/layering/readiness/oracle ratchets, LOC and function
  regrowth ratchets immediately before every commit, and complete precommit
  and prepush hooks under a finite non-negative one-minute load strictly below
  `logical cores - 2`.

This remains a blocked plan-only checkpoint while #5218 is open. Once the
overlap clears, Luna Max may implement only from the rebased, re-audited lock.
The PR stays draft until an independent Sol reviews the exact pushed head SHA
and explicitly approves provider policy, owner-local failure accounting,
canonical materialization, bytes, tests, and the no-overlap census. Only then,
if the PR is mergeable and green, may root mark it ready.

## 2026-08-31 F1-S1 implementation checkpoint — Opus lane

**Branch** `claude/issue-3526-f1s1-number-boundary`, grounded on `origin/main`
`87002f1fe4dd373e8e3c791dcd964f561e02c78e`. Implemented from the 2026-08-30 Sol
correction (which supersedes the 2026-08-29 plan wherever the two disagree).

### Coordination gate

The Sol correction blocked source implementation until Claude IR PR #5218 had
merged. **#5218 merged 2026-08-31T01:32:04Z** (`feat(ir): nested-vec element
carrier + destructuring for-of heads`), so the gate is clear. The branch is
based on post-#5218 `main`; per project convention `main` is merged in, never
rebased. Exact-file collision census against the grounded tree: no open work
overlaps the eleven owned files.

### Required pre-implementation verifications (answers)

1. **Full-repo trace of `hasHostNumberBox` / `hasNativeNumberUnbox`.** The Sol
   correction is right and the 2026-08-29 plan was not.
   - `hasHostNumberBox` had **two** from-ast reads (`coerceToExpectedExtern`
     f64→externref box arm; `coerceReturnValue`'s externref→f64 provider pick)
     and **three** executable implementations —
     `integration.ts` (`!ctx.nativeStrings`),
     `backend/linear-integration.ts` (`false`), and
     `codegen/stdlib-selfhost.ts` (`false`).
   - `hasNativeNumberUnbox` had **one** from-ast read (the same unbox arm) and
     **one** implementation (`integration.ts`,
     `semanticProviders === "native-first"`).
   - Everything else in the tree was doc prose. All reads, both contract
     entries, all four implementations and every dangling prose reference are
     deleted; `hasHostBooleanBox` is untouched.
2. **`gen.setReturn`.** Confirmed it does **not** route through
   `coerceToExpectedExtern`. `generator-support.ts` attaches a direct
   `irRuntimeFuncRef("__box_number")` through `gen.setReturn`'s own
   `boxProvider`, which `lower.ts` reads (`instr.boxProvider ?? irRuntimeFuncRef
   (...)`). It is a named control and is unchanged in this slice — a follow-up
   row, not silent scope.
3. **Who guarantees the union-native `__unbox_number` exists.**
   `preregisterDynamicSupport` (`integration.ts`) is the trigger and remains the
   owner: `usesNamedUnionImport` (an `env.*` union member) and
   `usesRuntimeUnboxNumber` (a runtime `__unbox_number`) each call
   `addUnionImports(ctx)`, the whole-family materializer. Its detector used to
   key on `call` instructions only, so the migration would have removed the
   trigger. It now also recognizes the **exact attached provider target** of
   `js.number.box` / `js.number.unbox`. This is safe because
   `prepareBuiltFnRuntimeManifest` (provider attachment) runs at the top of the
   preparation sequence and `preregisterDynamicAndForInSupport` runs later in
   the same sequence — attachment always precedes the trigger, and both precede
   any Phase-3 body that could bake a funcidx. No name scanning and no second
   allocator were added. Measured result: **import set and order are identical
   in every lane, before and after.**
4. **Callable-backed intrinsic lowering with externref args/results.**
   `emitPreparedIntrinsic` (`lower.ts`) is already ABI-generic for the callable
   arm — it emits the operands and then
   `emitter.emitCall(resolver.resolveFunc(instr.provider.target))`, with no f64
   assumption; typing flows through the ordinary `IrType` → ValType converter.
   No lowering change was needed. What was **not** generic was the provider
   model, exactly as the Sol correction says: `providerAttachment` always built
   an `irIntrinsicFuncRef`, and provider resolution admitted only the prepared
   self-hosted Math index. Hence the two new implementation kinds.

### What landed

- **`src/ir/runtime-host-capabilities.ts` (new)** — the one central
  host-capability catalogue: closed ID union (seven async + `number.box` /
  `number.unbox`), value types widened to `externref | i32 | f64`, canonical
  object identity, exact-ABI validation, catalogue canonicalization and
  fail-closed resolution.
- **`src/ir/async-runtime-providers.ts`** — derives its async-only projection
  from that table (the *same* frozen objects, so identity guards accept either
  view). `AsyncHostAdapterValueType` stays exactly `externref | i32` and
  `asAsyncHostAdapter` is a **checked** narrowing, not a cast, so no f64 row can
  reach the async adapter materializer (which maps every non-`i32` row to
  externref and would mislower it).
- **`src/ir/intrinsics.ts`** — `js.number.box` `(f64) -> externref` and
  `js.number.unbox` `(externref) -> f64`, versioned, with 1:1 feature rows.
- **`src/ir/runtime-manifest.ts`** — `host-callable` / `runtime-callable`
  implementation kinds; the three providers; the explicit `numberBoundary`
  policy on `RuntimeManifestPolicy`, canonicalized at construction and published
  on the frozen manifest; policy-driven selection whose unavailable arm is a
  typed `provider-target-unavailable` naming the intrinsic and the resolved
  policy.
- **`src/ir/intrinsic-support.ts`** — attachment derives the canonical physical
  `irImportFuncRef` from the exact capability record (host arm) or the canonical
  `irRuntimeFuncRef` (native arm); verification admits a physical target only
  when the closed provider catalogue names it for that intrinsic.
- **`src/ir/from-ast.ts`** — both arms emit provider-free intrinsics and read no
  lane fact; both resolver contract entries deleted.
- **`src/ir/integration.ts`** — the caller-resolved policy projection; the
  owner-local unsupported partition; the materialization trigger.
- **`src/ir/backend/linear-integration.ts`**, **`src/codegen/stdlib-selfhost.ts`**
  — both arms explicitly disabled.
- **`src/ir/async-prepare.ts`** — the exact numeric-return roundtrip is
  recognized in its intrinsic form (provider-free, since async preparation runs
  before manifest freeze) **and** its existing raw-import form.

### Divergences from the plan (recorded, not widened)

1. **Host-lane byte-parity is not literal byte-identity — measured, and it is a
   consequence of the plan's own design.** A semantic `intrinsic` is *pure*
   under the existing `effectsOf` authority, while the opaque `call` it replaces
   was not. `lower.ts`'s effects-aware emission scheduler therefore stops
   anchoring the boxed/unboxed value into a local and emits it lazily at its
   consumer. Measured over 5 fixtures × 5 lanes (25 cells) before/after:
   - **22 cells byte-identical**, including every standalone, WASI,
     native-strings and linear cell;
   - **3 gc-host cells shrink** (283→273, 626→614, 990→976 bytes). The full WAT
     diff on those cells is *only* removed `(local $$irN externref)` declarations
     and the resulting local renumbering: identical instruction sequence,
     identical call targets, identical `env` import set **and order**, identical
     runtime results (the `Map`-memo fixture returns 15181 both ways).
     Preserving the old bytes would require classifying these two intrinsics as
     impure — i.e. a second, per-ID effect table, which R6 forbids and which
     would also be untrue (`__box_number` allocates a fresh object;
     `__unbox_number` reads a primitive).
   - Follow-up worth naming: purity is correct **at the two producing sites**,
     where the operand is a proven-numeric carrier. A future producer that could
     hand `js.number.unbox` an object with a user `valueOf` would need the
     effect question re-opened.
2. **`RuntimeManifestPolicy.numberBoundary` is optional in the type**, defaulted
   to `NUMBER_BOUNDARY_POLICY_DISABLED` and canonicalized at builder
   construction; all three production callers pass it explicitly, so every
   frozen manifest publishes an explicit resolved policy. This keeps the
   fail-closed default without churning unrelated manifest tests.
3. **`src/ir/math-runtime-providers.ts` edited (one expression), outside the Sol
   ownership list.** Authority trace: `materializePreparedMathProviders`
   projected Math method names as `use.id.slice("math.".length)` over **every**
   intrinsic use. With a number-boundary use in the same manifest that yields
   `"js.number.box".slice(5)` → `"mber.box"` handed to the Math emitter. The
   projection now filters on the `math.` prefix. This is a required consequence
   of the approved change, not a scope expansion; recorded here rather than
   silently absorbed.
4. **The `gc-native-strings` unsupported-unbox population changes outcome code,
   not outcome.** Shapes that previously returned the unconverted externref and
   demoted at the verifier as `return-type-legacy-coupling` / `verify` now
   demote in preparation as `late-preparation-unsupported` / `resolve`, per the
   Sol correction's step 2. Both demote to legacy and **the emitted bytes are
   identical** (measured: `MAPGET` and `MIXED` on `gc-native-strings` are
   byte-identical before and after). The strict fixed-corpus census
   (`pnpm run check:ir-fallbacks`) is **unchanged, output-identical**, with all
   unintended, module-level and post-claim buckets still empty.

### The async-prepare join needed the resolved policy, not a shape match

The Sol correction called the `async-prepare` numeric-return roundtrip a
*mechanical* substitution. It is not, and CI proved it: the standalone IR
cutover corpus failed with `compile/async expected derivedUnitCount=12,
observed 11`.

Cause: before this slice, from-ast emitted `env.__unbox_number` on the host lane
and the union-native runtime symbol on native-first, so `async-prepare`'s
raw-import match **also encoded "this is a host owner"** — and the elision is
only validated against the host Promise ABI. A provider-free intrinsic carries
no lane fact (freeze runs after async preparation), so a plain shape match is
not equivalent to what it replaced. Both naive options were measured and both
change behaviour:

| approach | standalone cutover corpus | host (#4106) |
| --- | --- | --- |
| match the intrinsic unconditionally | **FAIL** — derived 18/19, elision fires where it never did | pass |
| match only the raw-import form | pass — derived 19/19 | **FAIL** — resume function regains the unbox call |

Resolved by threading the caller's **already-resolved** `NumberBoundaryPolicy`
— the same frozen fact manifest freeze consumes — from `compileIrPathFunctions`
through `prepareSuspendingAsyncLowering` into `prepareSingleAwaitIrFunction`.
The intrinsic form is admitted iff `unbox === "host"`, which is exactly the
population the import form matched. Both lanes are now neutral: corpus
`derived=19/19`, #4106 green. The parameter defaults to
`NUMBER_BOUNDARY_POLICY_DISABLED`, so an uninformed caller keeps its
continuation rather than silently eliding.

This is the one place where F1-S1's goal (a lane-free front-end node) and an
existing consumer genuinely conflict; the policy hand-off is the narrow fix. A
cleaner long-term home is a post-freeze pass that reads the attached provider.

### `check:ir-kind-neutrality` baseline refresh

The `quality` lane initially failed on `check:ir-kind-neutrality`. **This was
caused by this change-set**, not pre-existing: the gate passes with exit 0 on a
clean `origin/main` worktree (an earlier stash-based check wrongly suggested
otherwise, and the wrong conclusion was reported before the worktree
measurement corrected it).

The cause is line-number drift in the baseline's `evidence` citations — this
slice's edits moved three cited lines. No verdict, kind, placement, ratchet
count or `settledBy` rationale changed:

| kind | cited file | before → after |
| --- | --- | --- |
| `forof.string` | `src/ir/integration.ts` | 6001 → 6054 |
| `string.len` | `src/ir/backend/linear-integration.ts` | 1611 → 1614 |
| `vec.new_fixed` | `src/ir/from-ast.ts` | 4562 → 4542 |

Refreshed per the gate's own instruction (`--update-on-decrease`, then commit
the baseline diff for review). The three citations plus the `generated` date
were patched surgically rather than committing the regenerator's output, which
reflows every array and would have buried a 4-line semantic change in a
356-line formatting diff. This is the gate's documented refresh flow and is
distinct from `scripts/loc-budget-baseline.json`, which remains main's alone.

### Not touched (per the lock)

`src/codegen/index.ts`, declarations, raw union registration (`addUnionImports`
itself), `compiler-timer-shim-preparation.ts` (a different dynamic
box/to-number family — no mechanical join proven), timer shims, generator
`setReturn`, `__box_boolean` / `__box_symbol` / `$AnyValue`, the `#2108`
coercion-sites baseline, the public `ImportIntent` projection, and every direct
codegen `__box_number` / `__unbox_number` handler.

## 2026-09-01 F1-S2 implementation plan — boolean-boundary intrinsic (family 1, slice 2)

**Fable lane.** Grounded on `origin/main` at `e0b46482fd` (post-F1-S1 merge
PR #5364, post-gap-4 merge PR #5367). Opus implements against this plan. This
slice migrates the LAST resolver-mode predicate at the from-ast externref
coercion boundary — `hasHostBooleanBox` — onto the F1-S1 machinery, which now
exists on main and is the template: mirror it, do not re-derive it.

### Measured facts (verified on the grounded tree)

- **One from-ast read.** `src/ir/from-ast.ts:7227-7241`: the boolean-branded
  i32 → externref arm (`got.kind === "i32" && got.boolean === true`) is gated
  on `cx.resolver?.hasHostBooleanBox?.() === true` and emits a direct
  `emitCall(irImportFuncRef("env", "__box_boolean"), [value], externref)`.
  When the predicate is false the arm FALLS THROUGH to the typed
  `operand-coercion-unsupported` build throw below it (designed
  non-claimability → legacy fallback, the #3553 comment).
- **Three resolver implementations**, exactly the pre-F1-S1 number shape:
  `src/ir/integration.ts:5666` (`!ctx.nativeStrings`),
  `src/ir/backend/linear-integration.ts:1537` (`false`),
  `src/codegen/stdlib-selfhost.ts:190` (`false`). Contract entry at
  `from-ast.ts:421`, prose at `:365`. No other executable read exists —
  pre-implementation verification 1 re-proves this.
- **Box arm only.** There is NO `hasNativeBooleanUnbox` and no unbox arm; the
  integration comment states the boolean capability "has no widening
  follow-up". F1-S2 therefore mints ONE intrinsic, not a pair.
- **ABI** `(i32) -> externref` — confirmed by both `ensureLateImport` sites
  (`array-object-proto.ts:1451`, `array-prototype-borrow.ts:502`).
- **Union-import trigger.** `__box_boolean` ∈ `UNION_IMPORT_FUNC_NAMES`
  (`integration.ts:7244`). The F1-S1 attached-target recognizer
  (`integration.ts:7410-7428`) filters on
  `i.id === "js.number.box" || i.id === "js.number.unbox"` before the
  membership check — the migration removes the raw `call` this detector
  otherwise keys on, so the id filter must admit `js.boolean.box`. The
  membership check itself already covers `__box_boolean`; no other edit.
- **F1-S1 machinery to mirror** (all on main): intrinsic rows + feature rows
  (`intrinsics.ts:60/116/234`), the central capability catalogue
  (`runtime-host-capabilities.ts` — closed ID union currently seven async +
  `number.box`/`number.unbox`), provider definitions and policy-driven
  selection (`runtime-manifest.ts:77-102` policy type, `:410-474` providers,
  `:895-898` canonicalization, `:1184` selection), the owner-local
  unsupported partition (`integration.ts:3481-3493`,
  `unsupportedNumberBoundaryIntrinsic`), and the caller policy projections
  (`integration.ts:829`, `linear-integration.ts:666`,
  `stdlib-selfhost.ts:499`).

### Contract

1. **Intrinsic.** `js.boolean.box` `(i32) -> externref`, versioned, 1:1
   feature row, added beside the number rows (a `BOOLEAN_BOUNDARY_*` sibling
   of `NUMBER_BOUNDARY_INTRINSIC_IDS` / `NUMBER_BOUNDARY_RUNTIME_FEATURES` —
   do not widen the number constants).
2. **Capability.** One record `boolean.box` → `env.__box_boolean`
   `(i32) -> externref` in the central catalogue
   (`runtime-host-capabilities.ts`), same exact-ABI validation and canonical
   identity as the number rows. The async projection must remain unable to
   see it only if its value union would mislower it — an `i32`-typed row IS
   admissible under `AsyncHostAdapterValueType`, so the async-only projection
   must filter by the async ID set, not by value type alone (pre-impl
   verification 2 proves the seven-ID filter already does this).
3. **Policy.** `booleanBoundary: { box: "host" | "unsupported" }` on
   `RuntimeManifestPolicy`, optional in the type, defaulted to a frozen
   `BOOLEAN_BOUNDARY_POLICY_DISABLED`, canonicalized at builder construction,
   published resolved on the frozen manifest — the exact `numberBoundary`
   pattern. All three production callers pass it explicitly:
   integration projects `{ box: !ctx.nativeStrings ? "host" : "unsupported" }`
   (the exact former truth table); linear and self-hosted-stdlib pass
   disabled. Host arm resolves through the existing `host-callable` provider
   kind to the SAME physical target `env.__box_boolean`; there is no
   runtime-callable arm (no native boolean boxer exists).
4. **from-ast.** The branded-i32 type gate stays (it is a type fact); the
   resolver predicate read is deleted (it is a lane fact); the arm emits the
   provider-free `cx.builder.emitIntrinsic("js.boolean.box", [value])`.
   Delete the `hasHostBooleanBox` contract entry, all three implementations,
   and the prose references.
5. **Preparation.** An unavailable arm classifies the OWNER as
   `late-preparation-unsupported` / `resolve` owner-locally, before any body,
   slot, alias, outcome or manifest prefix is published — extend or sibling
   the `unsupportedNumberBoundaryIntrinsic` partition; one demoting owner
   must not fail unrelated owners through the aggregate manifest.
6. **Trigger.** Widen the `integration.ts:7410` id filter to admit
   `js.boolean.box` attached callable targets. Attachment-precedes-trigger
   sequencing is the F1-S1 argument verbatim (manifest preparation runs at
   the top of the sequence, `preregisterDynamicAndForInSupport` later in the
   same sequence); no name scanning, no second allocator.

### Behavior-neutrality obligations (each is a test or a measured record)

1. `pnpm run check:ir-fallbacks` census output-identical; unintended,
   module-level and post-claim buckets stay empty.
2. Import set AND order identical in every lane, before and after.
3. Byte parity: every standalone, WASI, native-strings and linear cell
   byte-identical. Host-lane cells may exhibit ONLY the F1-S1 purity class of
   diff (removed `(local $$irN externref)` declarations + renumbering from
   the effects-aware scheduler no longer spilling a pure intrinsic's result;
   identical instruction sequence, call targets, imports and answers) — any
   other WAT delta is a defect. Record the measured cells in the checkpoint.
4. Outcome-code shift, F1-S1 divergence-4 class: shapes that previously fell
   through to the BUILD-time `operand-coercion-unsupported` demote on no-box
   lanes now demote in PREPARATION as `late-preparation-unsupported`. Both
   demote to legacy; emitted bytes must be measured identical on those lanes.
5. Non-vacuity: reverting ONLY the from-ast arm while keeping the schema must
   fail named tests (the owner-local demote code and the intrinsic-emission
   assertion), while schema/policy tests stay green.
6. The boolean-branded gate population is unchanged: nothing that was not
   emitted before may be emitted now (the resolver predicate never gated
   EMISSION population on host lanes — it only picked demote-vs-box; state
   this as an explicit before/after claim-census comparison).

### Required pre-implementation verifications (record answers in the checkpoint)

1. **Full-repo trace of `hasHostBooleanBox`.** Expected: one from-ast read,
   one contract entry, three implementations, prose only elsewhere. Any
   additional executable read invalidates the one-arm premise — stop and
   re-plan rather than absorb it.
2. **Async non-involvement.** Prove `async-prepare.ts` and the async adapter
   materializer have no `__box_boolean` join (the F1-S1 standalone-cutover
   failure came from exactly such a hidden lane-fact join on the number side;
   grep + run the #4103/#4104/#4106 suites and `check:standalone-ir-cutover`
   locally BEFORE pushing). Also prove the async-only capability projection
   filters by the seven async IDs, not by value type.
3. **`box-boolean-fuse.ts` interaction.** The peephole matches emitted
   `call $__box_boolean` leaves. Establish by measurement whether it ever
   fires on IR-path bodies today; if it does, the lowered intrinsic must
   produce the same call shape it matches (the callable provider emits the
   same `emitCall` — verify on a boolean-condition fixture, byte-comparing
   with the fuse pass on and off).
4. **Brand producers.** Enumerate what sets `boolean: true` on i32 IrTypes
   feeding this arm; confirm none consults the resolver predicate to decide
   whether to produce the branded carrier (emission population must be a pure
   type fact after the migration).

### Validation

Typecheck; `check:ir-fallbacks` bare; ratchet chain bare
(`node scripts/check-loc-budget.mjs && node scripts/check-func-budget.mjs &&
node scripts/check-coercion-sites.mjs && npm run -s check:oracle-ratchet &&
npm run -s check:dead-exports`) plus the `LOC_GATE_BASE=$(git rev-parse
origin/main)` CI-base simulation; `check:ir-dialect`, `check:ir-layering`,
`check:ir-only`, `check:linear-ir`, `check:host-import-policy`,
`check:standalone-ir-cutover` (run locally — F1-S1's one CI failure was this
gate); the focused #3526 suites and the F1-S1 tests (which must stay green
untouched); hooks without bypass. Growth allowances in THIS issue file's
frontmatter with a dated rationale; no `scripts/*-baseline.json` edits (the
`check:ir-kind-neutrality` evidence-line refresh via its own
`--update-on-decrease` flow is the sanctioned exception if line drift trips
it, per the F1-S1 checkpoint).

### Explicitly out of scope

Generator `setReturn`'s `boxProvider` (a number-family row — F1-S3 candidate),
`compiler-timer-shim-preparation.ts` (no mechanical join proven), every direct
codegen `__box_boolean` handler and the `box-boolean-fuse` peephole itself,
`__box_symbol` / `$AnyValue`, `__unbox_boolean` (a union member with no IR
producer today), and the #2108 coercion-sites baseline. One owner for the
same file family as F1-S1 minus the async files; check the claim ledger before
touching `integration.ts` (#3525 codex lane overlaps it — coordinate, never
parallel-write).

## 2026-09-01 F1-S2 pre-implementation verifications — Opus lane

**Branch** `claude/issue-3526-f1s2-boolean-boundary`, grounded on `origin/main`
`dcb6eba626eea623c91156b7b8fc44a2d6b3fc00`. Implemented from the 2026-09-01
F1-S2 plan (boolean-boundary intrinsic), whose template is the landed F1-S1
machinery, not a re-derivation.

The plan requires these four answers BEFORE any source edit. All four were
measured on the grounded tree with the migration NOT yet applied.

### 1. Full-repo trace of `hasHostBooleanBox` — the one-arm premise HOLDS

`grep -rn hasHostBooleanBox` over the whole tree (excluding `node_modules` and
`.git`) returns exactly nine hits, and the executable split is precisely what
the plan predicted:

| kind | site |
| --- | --- |
| from-ast READ (1) | `src/ir/from-ast.ts:7233` — the branded-i32→externref box arm |
| contract entry (1) | `src/ir/from-ast.ts:421` |
| implementation (3) | `src/ir/integration.ts:5666`, `src/ir/backend/linear-integration.ts:1537`, `src/codegen/stdlib-selfhost.ts:190` |
| prose (4) | `src/ir/from-ast.ts:365`, `plan/issues/2955-…:399`, `plan/issues/3526-…:918`, `plan/issues/3526-…:1292` |

**No additional executable read exists**, so the STOP-and-report condition did
not trigger. There is no `hasNativeBooleanUnbox` and no unbox arm: F1-S2 mints
ONE intrinsic, not a pair.

### 2. Async non-involvement — proven twice over

- **No `__box_boolean` join.** `grep -rn "__box_boolean" src/ir/` returns seven
  hits: the one from-ast emission arm, its error message, four prose comments,
  and the `UNION_IMPORT_FUNC_NAMES` membership row in `integration.ts:7244`.
  **`src/ir/async-prepare.ts` contains no `box`/`unbox` reference other than
  its own `js.number.unbox` numeric-tail roundtrip** (`:812-851`), which keys
  on `js.number.unbox` / `env.__unbox_number` by exact ID and binding. A
  boolean row cannot reach it. The F1-S1 standalone-cutover failure came from
  the number side's hidden host-lane fact riding on a raw-import match; the
  boolean side has no such consumer, so no policy hand-off is needed and none
  is added.
- **The async-only capability projection filters by ID, not by value type.**
  `ASYNC_HOST_CAPABILITY_RECORDS` (`async-runtime-providers.ts`) is
  `RUNTIME_HOST_CAPABILITY_RECORDS.filter((entry) =>
  isAsyncHostCapabilityId(entry.capability))`, and
  `ASYNC_HOST_CAPABILITY_ID_SET` is exactly the seven `async.*` IDs. An
  `i32`-typed `boolean.box` row IS admissible under
  `AsyncHostAdapterValueType` (`"externref" | "i32"`) — which is precisely why
  a value-type filter would have been the wrong guard — but the seven-ID filter
  excludes it, and `asAsyncHostAdapter` additionally throws on a non-async
  capability, so the narrowing is checked rather than assumed. No async
  manifest can acquire the boolean record.

### 3. `box-boolean-fuse.ts` interaction — measured, and it is NIL

The pass is env-gated **default OFF** (`fuseEnabled()` returns `false` unless
`JS2WASM_UNBOXED_BOOL_FUSE` is set) and matches the direct-codegen
`logical-ops.ts` if-merge SINK shape, not this coercion boundary. Measured on
the grounded tree with the pass forced ON and its debug counters enabled, over
the IR-path boolean fixture plus a logical-value control:

| fixture | fuse counters | bytes fuse OFF | bytes fuse ON |
| --- | --- | --- | --- |
| `BOOLSTORE` (`a[0] = n > 2`, IR-emitted) | `fused-sink=0 fused-adjacent=0 leaf-box-call=0 sites=0` | 1754 | 1754 (sha identical) |
| `LOGICAL` (`if ((a>1)||(b>2))`) | pass declined — no `__is_truthy` in module | 160 | 160 (sha identical) |
| `BOOLSTORE_LOGICAL` | `sites=0` | 1654 | 1654 (sha identical) |

**The pass never fires on an IR-path body today**, so there is no matched call
shape to preserve. The obligation is therefore discharged as a *maintained
zero*: the same measurement is repeated after the migration and must stay at
`sites=0` with identical shas. (The lowered intrinsic emits through
`emitPreparedIntrinsic` → `emitter.emitCall(resolveFunc(target))`, i.e. the
same `call $__box_boolean` leaf, so even a future firing would match.)

### 4. Brand producers — all pure type facts

Every producer of a `boolean: true` i32 `IrType`, enumerated:

| site | what it is |
| --- | --- |
| `src/ir/boolean-brand.ts:38` (`irBool()`) | the canonical brand factory; its `IR_BOOL` singleton (`from-ast.ts:2992`) feeds 25 comparison / truthiness / `i32.eqz` / bool-const sites |
| `from-ast.ts:3825` | `typeNodeToIr` — the `boolean` **type annotation** |
| `from-ast.ts:7106` | `new Boolean(x)` argument's expected type |
| `from-ast.ts:7644` | standalone `RegExp.test` result type |
| `from-ast.ts:7795` | pristine-ES5 `Object.isFrozen` constant-fold result |
| `backend/linear-integration.ts:1242` | `latticeEvidenceToIr` — a certified `bool` lattice fact |

**None consults `hasHostBooleanBox`, or any other capability predicate, to
decide whether to produce the branded carrier.** (`:7795` reads
`cx.resolver?.isAmbientBinding`, an unrelated *binding-provenance* question:
"is `Object` the pristine ambient global?" — not a lane/capability question.)
Emission population is therefore a pure type fact both before and after the
migration, which is what obligation 6's before/after claim-census comparison
asserts.

### Reachability of the arm — measured, and it is narrow

Worth recording because it bounds every neutrality claim below. With a
temporary stderr trace at the arm, `pnpm run check:ir-fallbacks` (the fixed
`playground/examples` corpus) fires the arm **zero** times, and eight
hand-written candidate shapes (`Map<number, boolean>.set`, `Set<boolean>.add`,
`any[]` push, `JSON.stringify`, template/string concat, an extern class method,
a DOM property write) all demote at IR **selection** before reaching it. The
one shape found that both IR-selects and reaches the arm is the **element
store into an `any[]` parameter**:

```ts
export function put(a: any[], n: number): number { a[0] = n > 2; return n; }
```

That is the `BOOLSTORE` fixture used for every byte cell and for the
non-vacuity test; `MIXED` combines it with the F1-S1 `Map` memo shape so one
module carries both boundaries.

## 2026-09-01 F1-S2 implementation checkpoint — Opus lane

Implemented from the 2026-09-01 F1-S2 plan, mirroring the landed F1-S1
machinery rather than re-deriving it. The four required pre-implementation
verifications are in the section above; none triggered a STOP.

### What landed

- **`src/ir/intrinsics.ts`** — `js.boolean.box` `(i32) -> externref`,
  versioned, with a 1:1 feature row, added as a `BOOLEAN_BOUNDARY_*` SIBLING
  of the number constants (which are unchanged). One ID, not a pair: there is
  no `js.boolean.unbox` because `__unbox_boolean` has no IR producer. The new
  `I32_TYPE` param carries no `signed` field, so it matches the branded
  carrier the arm passes (`signed ?? true` on both sides) while
  `valTypeEquals` erases the brand itself.
- **`src/ir/runtime-host-capabilities.ts`** — one record `boolean.box` →
  `env.__box_boolean` `(i32) -> externref`, inserted in capability-ID sort
  order between the async prefix and the number rows, so the async prefix
  keeps its historical position.
- **`src/ir/runtime-manifest.ts`** — `BooleanBoundaryPolicy`
  (`box: "host" | "unsupported"` — no `"native"` member, because no native
  boolean boxer exists), a frozen `BOOLEAN_BOUNDARY_POLICY_DISABLED`, the
  optional `booleanBoundary` field on `RuntimeManifestPolicy` canonicalized at
  builder construction and published resolved on the frozen manifest, the one
  `host.js.boolean.box` provider (`host-callable` → capability `boolean.box`),
  and its policy branch in `#selectProvider` whose unavailable arm is a typed
  `provider-target-unavailable` naming the intrinsic and the resolved policy.
- **`src/ir/from-ast.ts`** — the arm emits the provider-free
  `js.boolean.box` intrinsic and reads no lane fact; the `hasHostBooleanBox`
  contract entry, all three implementations and the prose reference are
  deleted. The branded-i32 gate STAYS, and is load-bearing.
- **`src/ir/integration.ts`** — `integrationBooleanBoundaryPolicy`
  (`{ box: !ctx.nativeStrings ? "host" : "unsupported" }`, the exact former
  truth table), the owner-local `unsupportedBooleanBoundaryIntrinsic`
  partition run in the same pass as the number one, and the one-line trigger
  widening.
- **`src/ir/backend/linear-integration.ts`**, **`src/codegen/stdlib-selfhost.ts`**
  — both pass `BOOLEAN_BOUNDARY_POLICY_DISABLED` explicitly.
- **`tests/issue-3526-boolean-boundary-intrinsic.test.ts`** (new, 16 tests).

`src/ir/intrinsic-support.ts` needed **no edit**: its attachment and
admitted-target tables are driven by `RUNTIME_PROVIDERS` ×
`INTRINSIC_DEFINITIONS`, so the new `host-callable` row is picked up by
construction. Neither did `src/ir/backend/legality.ts` — its linear
`intrinsic` arm is an allowlist, so `js.boolean.box` falls to the default
reject. Neither did `src/ir/async-prepare.ts`, per verification 2: unlike the
number side, this family has no async consumer, so no policy hand-off exists
to thread.

### Measured neutrality

**Byte parity — 25/25 cells identical, WAT included.** Five fixtures
(`BOOLSTORE` = the element store; `BOOLSTORE2` = two arms in one owner;
`MIXED` = the boolean store PLUS the F1-S1 `Map` memo in one module; `CLEAN` =
a Math-only control; `MEMO` = F1-S1's own fixture) × five lanes (gc-host,
gc-native-strings, standalone, WASI, linear), compiled before and after on the
same tree. Every cell matches on byte length, binary sha256, and import set
AND order; a file-by-file diff of all 25 emitted WAT texts is empty.

**This slice produced NO purity-class WAT diff at all** — the one divergence
F1-S1 had to record. The reason is specific and worth keeping: F1-S1's boxed
value was anchored into an `(local $$irN externref)` spill that the pure
intrinsic no longer needed, whereas the boolean box's result is consumed
immediately by its element store and was never spilled. The plan permitted
that diff class; none appeared.

| fixture | gc-host | gc-native-strings | standalone | WASI | linear |
| --- | --- | --- | --- | --- | --- |
| `BOOLSTORE` | 1754 ✓ | 23758 ✓ | 50462 ✓ | 50489 ✓ | 4918 ✓ |
| `BOOLSTORE2` | 1643 ✓ | 24001 ✓ | 50688 ✓ | 50715 ✓ | 4958 ✓ |
| `MIXED` | 2188 ✓ | 26289 ✓ | 124929 ✓ | 103377 ✓ | 5140 ✓ |
| `CLEAN` | 117 ✓ | 21976 ✓ | 22591 ✓ | 22618 ✓ | 4883 ✓ |
| `MEMO` | 584 ✓ | 24596 ✓ | 124959 ✓ | 103399 ✓ | 5118 ✓ |

(✓ = bytes, sha256, imports and WAT all identical before/after.)

**Imports and order.** Identical in every cell. The host-lane `BOOLSTORE`
import list is `__box_boolean, __get_undefined, __unbox_number, __box_number`;
`MIXED` is `Map_new, Map_get, Map_set, __unbox_number, __box_number,
__box_boolean, __extern_is_undefined, __get_undefined`.

**Census.** `pnpm run check:ir-fallbacks` is output-identical (diffed, not
eyeballed); unintended, module-level and post-claim buckets all still empty.

**Outcome-code shift (obligation 4).** Exactly the F1-S1 divergence-4 class,
and nothing else — the only non-byte delta anywhere in the 25 cells:

| lane | before | after |
| --- | --- | --- |
| gc-native-strings, standalone, WASI | `operand-coercion-unsupported` / `build` | `late-preparation-unsupported` / `resolve` |

Both demote to legacy, and the emitted bytes on those lanes are measured
identical. `MIXED` on gc-native-strings shows the two boundaries demoting
side by side, each naming its own policy.

**The trigger widening is NOT decorative — measured.** With the
`js.boolean.box` arm removed from `preregisterDynamicSupport`'s recognizer and
everything else left in place, `BOOLSTORE` and `BOOLSTORE2` on gc-host change
sha (same byte length, different content): the union family materializes later,
moving `__unbox_number` from type 11 to type 15 and `__box_number` from 12 to
16. That is import-order/index drift of exactly the kind obligation 2 forbids,
so the one-line widening is load-bearing and its removal is caught.

**`box-boolean-fuse` (verification 3) — the zero is maintained.** Re-measured
after the migration with the pass forced on and its debug counters enabled:
still `fused-sink=0 fused-adjacent=0 leaf-box-call=0 sites=0` on every fixture,
and every sha identical both before/after the migration and fuse-on/fuse-off.

**Emission population unchanged (obligation 6).** Asserted directly rather
than argued: `lowerFill` lowers the same source under a resolver that answers
the deleted predicate `true` and one that answers it `false`, and the two IR
bodies are shape-identical (same intrinsics, same call targets) — because the
front-end no longer asks. Nothing that was not emitted before is emitted now.

### Non-vacuity — verified by the specified revert-only-the-arm check

Reverting ONLY the from-ast arm to its direct `emitCall(env.__box_boolean)`
form while keeping the entire schema, then re-running the suite:

- **4 tests fail**, and they are exactly the two named classes — the
  intrinsic-emission assertion ("lowers the branded carrier to the
  provider-free intrinsic", plus its lane-freedom twin) and the owner-local
  demote code ("demotes only the requesting owner …" and its
  standalone/WASI sibling);
- **all 9 schema / policy / freeze-discipline tests stay green**, as the plan
  requires.

Worth stating plainly: the host-lane byte-parity test does NOT distinguish the
two implementations (the bytes are identical by construction — that is the
point of the slice), so it is deliberately not relied on for non-vacuity. The
IR-level assertion is.

### Divergences from the plan (recorded, not widened)

1. **One test outside the #3526 suites needed a one-field update.**
   `tests/issue-4104-ir-async-plan-runtime-consumer.test.ts` asserts the frozen
   manifest policy by exact object equality, and the policy now publishes
   `booleanBoundary` alongside `numberBoundary`. This is the same mechanical
   consequence F1-S1 had when it introduced `numberBoundary` into that
   assertion. Every #3526 F1-S1 test and both async suites are otherwise
   green and untouched.
2. **`check:ir-kind-neutrality` evidence-line drift**, the sanctioned
   exception, handled exactly as the F1-S1 checkpoint prescribes. No verdict,
   kind, placement, ratchet count or `settledBy` rationale changed — only
   citation line numbers moved.

   Pre-merge this branch carried three drifted citations plus the `generated`
   date (`forof.string` `integration.ts` 6058→6112; `string.len`
   `linear-integration.ts` 1614→1617; `vec.new_fixed` `from-ast.ts`
   4542→4534). Main's own refresh has since absorbed two of them, so **the
   shipped diff is ONE line**: `forof.string`'s `src/ir/integration.ts`
   citation, 6051 (main's value) → **6105**.

   That final number is neither side's, which is the trap this note exists to
   flag: main moved the line one way and this branch's +56 LOC in the same
   file moves it the other, so the merge resolution had to RE-DERIVE it from
   the gate rather than pick a side or do arithmetic. Patched surgically in
   both rounds rather than by committing the regenerator's output, which
   reflows every array (measured: a 354-line diff for a 1-line change). The
   semantic delta was established each time by normalising both JSON
   documents and diffing those, so "only this line" is measured, not assumed.

### Reachability, stated as a limit rather than a claim

The migrated arm is narrow: it fires **zero** times on the fixed
`playground/examples` corpus, and eight of nine candidate source shapes demote
at IR *selection* before reaching it. Everything above is therefore measured on
the one shape that does reach it (an element store of a comparison result into
an `any[]`), plus hand-built owners for the manifest-level obligations. The
neutrality result is strong for that population and says nothing about shapes
that cannot reach the arm today — which is also why the census is unchanged.

### Validation run

Green: TypeScript 7 and TypeScript 5 typecheck; `check:ir-fallbacks` (bare,
output-identical); the ratchet chain bare AND under
`LOC_GATE_BASE=$(git rev-parse origin/main)` (`dcb6eba6`) — loc, func,
coercion-sites, oracle-ratchet, dead-exports; `check:ir-dialect`,
`check:ir-layering`, `check:ir-only`, `check:linear-ir`,
`check:host-import-policy`, `check:ir-kind-neutrality` (after the refresh
above), `check:test-vacuity-shapes`; `lint`; `prettier --check` over
`src`/`tests`/`scripts`; and — F1-S1's one CI failure —
`check:standalone-ir-cutover-corpus`, which passes with `derived=19/19`,
`units=47/47`, `terminal=38/38`. The new 16-test suite, the F1-S1
number-boundary suite, both #3526 manifest/math suites and both async suites
(#4103/#4104) are green.

**Pre-existing failures, measured on a clean `origin/main` worktree at
`dcb6eba6` and NOT caused by this change-set** — identical failures on base
and branch: `tests/equivalence/arguments-nested-and-loops.test.ts` (1) and
`tests/equivalence/logical-conditional-identity.test.ts` (3);
`tests/ir-backend-emitter.test.ts` (1), `tests/ir-bytecode-proof.test.ts` (1),
`tests/ir-scaffold.test.ts` (1) and `tests/issue-1058-ir-inline-dag.test.ts`
(1). The last of those was worth checking rather than assuming, since a pure
intrinsic can in principle change an inlining decision; it fails identically
on base.

### Not touched (per the plan's scope discipline)

Generator `setReturn`'s `boxProvider`, `compiler-timer-shim-preparation.ts`,
every direct codegen `__box_boolean` handler and the `box-boolean-fuse`
peephole itself, `__box_symbol` / `$AnyValue`, `__unbox_boolean`, the timer
shims, and the #2108 coercion-sites baseline. `scripts/*-baseline.json` is
untouched apart from the sanctioned `check:ir-kind-neutrality` evidence
refresh above; `scripts/loc-budget-baseline.json` remains main's alone.

## 2026-09-01 F1-S3 implementation plan — generator setReturn boxing under manifest authority (family 1, slice 3)

**Fable lane.** Grounded on `origin/main` at `009b812779` (post-F1-S2 merge
PR #5396) via a four-probe measurement pass. Opus implements against this
plan. Governance note: the dormant whole-issue codex claim on #3526 (branch
`codex/3526-f1-s1-number-boundary`, tip = the merged 2026-08-30 Sol
correction, ancestor of main, no activity since 08-30) was released as stale
on 2026-09-01; this slice runs under the slice claim `3526:f1s3`.

This slice migrates the follow-up row both F1 checkpoints named: the
`gen.setReturn` seam still pins `__box_number` by runtime symbol, chosen by
presence, outside the frozen manifest's authority.

### Measured facts (verified on the grounded tree; every line quoted in probes)

- **One attachment site.** `attachIrGeneratorSupport`
  (`src/ir/generator-support.ts:112-125`, generators only per `:82`) attaches
  `provider = irRuntimeFuncRef("__gen_set_return")` and
  `boxProvider = irGeneratorSetReturnNeedsBoxing(valueType) ?
  irRuntimeFuncRef("__box_number") : undefined`; the boxing predicate
  (`:57-61`) is `val.kind === "f64" || val.kind === "i32"`. Re-attachment is
  guarded (`:119-122`) and `requireSameProvider` (`:64-67`) makes a
  binding-kind switch across re-preparation a hard error.
- **Reads.** `src/ir/lower.ts:2797`
  (`instr.boxProvider ?? irRuntimeFuncRef("__box_number")`, consumed at
  `:2808` f64 and `:2812` i32-after-convert; unresolvable box → `resolveFunc`
  throws → whole-function demote, `:2788-2791`);
  `collectAttachedGeneratorProviders` (`generator-support.ts:161-163`) feeds
  pre-sealing observation at `integration.ts:3600-3602`; the sealing
  agreement check `needsBoxing === (instr.boxProvider !== undefined)`
  (`prepared-component-dependencies.ts:687-697`); dependency evidence at
  `:1478-1479`. `boxProvider` exists ONLY on `IrInstrGenSetReturn`
  (`dialect/js.ts:491`); no `__unbox_number` anywhere in the generator path.
- **Order.** Inside `compileIrPathFunctions`: manifest freeze
  (`integration.ts:3557`, `prepareBuiltFnRuntimeManifest`) → generator
  attach (`:3596`) → Phase-3 lowering (`:4205`). `preparedRuntimeManifest`
  is a local in scope at the attach point — threading is plumbing, not
  reordering. Built fns (and thus setReturn value types) exist BEFORE
  freeze, so freeze-time demand scanning is possible.
- **Manifest coverage holes.** The manifest walk collects only
  `instr.kind === "intrinsic"` uses (`intrinsic-support.ts:265`, `:297`); a
  generator-only module yields NO manifest (`:335` empty-uses early return);
  the retained provider map is keyed by actual uses. The asyncPlans hook
  (`builder.requestFeature`, `:341`) is the precedent for freeze-time
  feature requests from non-intrinsic consumers; the async-prepare policy
  threading (`integration.ts:2343-2350` → `async-prepare.ts:680/:747/:829`)
  is the precedent for handing a resolved policy to a prepare step.
- **The truth table this slice must reproduce EXACTLY.**
  | lane | today's boxProvider resolution |
  | --- | --- |
  | gc-host (`!nativeStrings`) | runtime symbol → `resolveAndObserveCallableProvider` materializes `env.__box_number` |
  | gc-native-strings host | runtime symbol → native `__box_number` helper via funcMap presence |
  | standalone / WASI / linear | seam UNREACHABLE — generators demote at BUILD (`from-ast.ts:1255-1271` `jsHostExterns` gate; `imports.ts:2284`) |
  Note `integrationNumberBoundaryPolicy` says `box: "unsupported"` on
  native-strings host while this seam boxes natively there — the seam's
  truth table is WIDER than `numberBoundary` and must NOT reuse it; F1-S1
  deliberately excluded a native member from `numberBoundary.box`
  (presence-must-not-widen doc at `integration.ts:776-782`,
  `runtime-manifest.ts:464-468`).
- **Test surface.** NO test references `boxProvider` (zero hits) — the
  attachment is pinned only by src-side checks. Behavior is pinned
  indirectly: `tests/issue-2951.test.ts:50` (`VALUE_RETURN_GEN`, IR-claimed
  host, terminal `done:true, value:3`), `:111` (`FOROF_GEN`, with
  `trackIrOutcomes` anti-vacuity), `:85-89` (standalone must NOT IR-claim
  the generator), `tests/issue-2035.test.ts:72-75`,
  `tests/issue-1169f-7a/7b`. No fixture distinguishes the i32 arm of the
  boxing predicate. `tests/issue-4104-ir-async-plan-runtime-consumer.test.ts:432-440`
  pins the frozen policy by whole-object equality — every new policy field
  breaks exactly that one test (F1-S1 and F1-S2 precedent).

### Contract

1. **Policy.** New `RuntimeManifestPolicy` field
   `generatorNumberBox: { box: "host" | "native" | "unsupported" }`,
   optional in the type, defaulted to a frozen
   `GENERATOR_NUMBER_BOX_POLICY_DISABLED` (`box: "unsupported"`),
   canonicalized at builder construction, published resolved on the frozen
   manifest — sibling constants, never a widening of `numberBoundary` (whose
   box arm has no native member by design). Callers: integration projects
   `{ box: !ctx.nativeStrings ? "host" : "native" }` — the exact measured
   truth table; `linear-integration.ts` and `stdlib-selfhost.ts` pass
   disabled (the seam is build-unreachable there; fail closed).
2. **Freeze-time demand.** `prepareBuiltFnRuntimeManifest` scans
   `healthyForLower` for generator fns whose `gen.setReturn` needs boxing
   (the same `irGeneratorSetReturnNeedsBoxing` predicate over the same
   inputs the attach pass reads — export and reuse it, do not duplicate) and,
   when present, requests the generator-box feature via the asyncPlans-style
   hook so a generator-only module still freezes a manifest carrying the
   provider row. Provider selection by `generatorNumberBox`:
   `"host"` → the existing `host-callable` capability `number.box` (physical
   `env.__box_number`, ABI authority `runtime-host-capabilities.ts:123`);
   `"native"` → a `runtime-callable` provider on the runtime symbol
   `__box_number` (both implementation kinds exist since F1-S1);
   `"unsupported"` with demand present → typed
   `provider-target-unavailable` naming the seam and resolved policy,
   classified owner-locally (only the demanding generator owners demote).
3. **Attachment.** `attachIrGeneratorSupport` takes the selected provider
   ref as a parameter (threaded from the frozen manifest at
   `integration.ts:3596`) and attaches THAT instead of the hardcoded
   `irRuntimeFuncRef("__box_number")`. The parameter is required at the
   integration call site; a defaulted fallback may exist only for tests and
   must equal today's runtime ref. `requireSameProvider` stays authoritative
   for re-attachment consistency.
4. **Lowering.** `lower.ts:2797` keeps its shape; whether the `??` fallback
   can be retired to a hard error depends on pre-implementation
   verification V1 — if attachment is proven total for every lowered
   `gen.setReturn`, retire it (fail closed); if any path lowers un-attached
   instrs, keep it and say which path.
5. **Sealing/evidence.** The agreement check
   (`prepared-component-dependencies.ts:687-697`) and evidence recording
   (`:1478-1479`) are provider-shape-agnostic; verify they accept an
   import-bound ref unchanged (V2) rather than assuming.

### Behavior-neutrality obligations (each a test or measured record)

1. Byte parity on the REACHABLE lanes: gc-host and gc-native-strings cells
   over generator fixtures — `VALUE_RETURN_GEN` (f64 arm) plus a NEW
   i32-return generator variant (the arm no fixture distinguishes) —
   byte/sha/WAT/import-set-and-order identical before and after. The F1-S1
   purity-diff class does not apply here (no intrinsic purity change);
   ANY WAT delta is a defect.
2. Standalone/WASI/linear: generators still demote at build; the census
   (`check:ir-fallbacks`) is output-identical; `tests/issue-2951.test.ts:85-89`
   stays green untouched.
3. Import set AND order identical on both host lanes — the binding-kind
   switch (runtime-bound → import-bound on gc-host) changes the observation
   path at `integration.ts:3600`; measure that import membership, order and
   indices do not move (the F1-S2 trigger-widening measurement is the
   precedent for proving this class non-decorative). If order DOES move,
   the sanctioned alternative is recorded in the plan: keep the attached
   ref runtime-bound and thread only the SELECTION (policy authority)
   through the manifest — behavior identical, physical binding unchanged;
   record which route was taken and why in the checkpoint.
4. `tests/issue-4104-...:432-440` whole-shape policy pin gains the new
   field — the one expected test edit outside the #3526 suites (divergence
   class recorded by both prior checkpoints).
5. Non-vacuity: reverting ONLY the attachment threading (hardcoded runtime
   ref restored) with the schema kept must fail named tests (the
   manifest-row assertion and a boxProvider-shape assertion — which also
   closes the measured gap that NO test pins `boxProvider` today), while
   schema/policy tests stay green.

### Required pre-implementation verifications (record answers in the checkpoint)

1. **Attachment totality.** Can `lower.ts:2797`'s `??` fallback ever fire on
   the integration path (an un-attached `gen.setReturn` reaching Phase 3)?
   Trace every producer of the instr; decide the fallback's fate from the
   answer, not from taste.
2. **Sealing/evidence shape-agnosticism.** Prove
   `prepared-component-dependencies.ts:687-697/:1478-1479` and the
   observation path accept an import-bound `boxProvider` with identical
   import membership/order on gc-host; if not, take the recorded
   runtime-bound alternative (obligation 3).
3. **Freeze-scan equivalence.** The freeze-time demand scan and the attach
   pass must classify the same population — prove by construction (shared
   predicate + shared input enumeration), not by sampling.
4. **i32 arm coverage.** Confirm the new i32-return fixture actually takes
   the `:2810-2812` convert-then-box path (WAT-inspect once) so the parity
   cell is not vacuously identical.

### Validation

Typecheck; `check:ir-fallbacks` bare; ratchet chain bare + the
`LOC_GATE_BASE=$(git rev-parse origin/main)` simulation; `check:ir-dialect`,
`check:ir-layering`, `check:ir-only`, `check:linear-ir`,
`check:host-import-policy`, `check:ir-kind-neutrality` (evidence-line
refresh via its own flow if line drift trips it), and
`check:standalone-ir-cutover` locally before pushing; the focused suites:
issue-2951, issue-2035, issue-1169f-7a/7b, issue-2864, issue-680, all five
issue-3526 suites, issue-4104/4103; hooks without bypass. Growth allowances
in this issue file's frontmatter with a dated rationale.

### Explicitly out of scope

The from-ast generator build gate (`jsHostExterns`), `gen.push` /
`gen.epilogue` / `gen.yieldStar` providers and the `__gen_*` import family,
legacy generator codegen and the native state machine,
`compiler-timer-shim-preparation.ts`, `numberBoundary` / `booleanBoundary`
(untouched), and everything owned by #3525 (multi-prepared ownership —
check the claim map before touching `integration.ts`; keep that file's diff
to the freeze scan, the policy projection, and the attach call site).

## 2026-09-01 F1-S3 pre-implementation verifications — Opus lane

**Branch** `claude/issue-3526-f1s3-generator-boxprovider`, grounded on
`origin/main` `009b812779`. Implemented from the 2026-09-01 F1-S3 plan, whose
template is the landed F1-S1/F1-S2 machinery.

All four answers were measured on the grounded tree BEFORE any source edit.
Two of them decide routes the plan deliberately left open, and both decisions
below are the measurement's, not a preference.

### V1 — attachment totality: the `??` fallback is UNREACHABLE, so it is retired

Traced end to end rather than sampled:

| step | finding |
| --- | --- |
| producers | ONE: `builder.ts:1425` (`emitGenSetReturn`), reached only from the `funcKind === "generator"` return arm at `from-ast.ts:1985-2004`. |
| middle end | `inline-small.ts:924` and `monomorphize.ts:891` only rename operands; both spread the instr, so an attached `boxProvider` survives — and both run BEFORE attachment anyway. |
| lowering entry | ONE production site: `integration.ts:4205` → `lowerIrEntryFunction` → `lowerIrFunctionToWasm`. `linear-integration.ts`, `backend/porffor`, `stdlib-selfhost` lower non-generator bodies only, and NO test lowers a `gen.setReturn` (zero hits across `tests/`). |
| ordering | attachment (`integration.ts:3596`) precedes Phase 3 (`:4205`), and every later `healthyForLower` assignment is a `retainHealthyOwners` FILTER — nothing joins the lowered set after attachment. |
| the one splice risk | `canInline` admits a single-block callee with a `return` terminator, which a trivial generator can satisfy — so a `gen.setReturn` could in principle land in a NON-generator owner, which `attachIrGeneratorSupport` skips. That case is already rejected earlier in the same lowering arm by the `func.generatorBufferSlot === undefined` guard, which fires before the boxing reference is read. Slots are not migrated by the inliner, so the guard cannot be satisfied by a spliced owner. |

One divergence between the two type maps is worth recording because it is
NOT a hazard: `valueTypesOf` (attachment) covers block args, while lowering's
`typeOf` covers params and instruction results only. A block-arg-typed stash
would therefore be attached and then throw in `typeOf` — demoting the owner,
never silently mis-lowering. In the other direction the attachment map is a
superset, so anything lowering can type, attachment can too.

**Decision: retire the fallback.** `lower.ts` now throws
`gen.setReturn numeric stash has no prepared boxing provider` instead of
re-deciding the symbol locally. Failing closed demotes one owner; the old
`??` silently re-introduced a second authority for the very symbol this slice
exists to give one.

### V2 — sealing/evidence shape: the import-bound route is NOT available

The plan asked whether an import-bound `boxProvider` survives sealing with
identical import membership and order, and named a runtime-bound alternative
if order moved. The measurement did not get as far as import order.

Attaching `irImportFuncRef("env", "__box_number", "__box_number")` in place of
the runtime ref — one line, everything else unchanged — was compiled on both
reachable lanes:

| fixture | gc-host | gc-native-strings |
| --- | --- | --- |
| `VALUE_RETURN_GEN` | **compile FAILS** — `invariant/unexpected-internal-throw` | **compile FAILS** — same |
| `I32_RETURN_GEN` | **compile FAILS** — same | **compile FAILS** — same |
| `REF_RETURN_GEN` (no boxing) | unaffected, 341 bytes | unaffected, 22223 bytes |

The error is `callable-provider resolution requires a runtime or intrinsic
reference`, thrown by `resolveAndObserveCallableProvider`
(`integration.ts:5927`) — a deliberate precondition of the observation path
that `collectAttachedGeneratorProviders` feeds. It is not import-order drift
to be absorbed; it is a designed refusal, and it fails the owner outright
rather than demoting cleanly.

**Decision: take the sanctioned runtime-bound alternative** (plan obligation
3). The attached reference stays `runtime`-bound and only the SELECTION is
threaded through the manifest: the frozen manifest decides which physical
symbol answers the seam — via the central `number.box` capability record on
the host arm, via the union-native runtime symbol on the native arm — and the
seam binds that symbol the one way its observation path admits. The physical
target is unchanged on both lanes, which is why the slice is byte-neutral.

Sealing itself is shape-agnostic and was not the constraint:
`recordExternalCallable` (`prepared-component-dependencies.ts:1120`) keys on
`irCallableBindingKey` for every binding kind, and the agreement check at
`:687-697` reads only `needsBoxing === (instr.boxProvider !== undefined)`.
Both accept the runtime-bound attachment unchanged, as they did before.

### V3 — freeze-scan equivalence: one population, by construction

The freeze-time demand scan and the attachment pass share a single
enumeration, `forEachIrGeneratorSetReturn` (`generator-support.ts`): the same
`funcKind` gate, the same `valueTypesOf` map, the same deep instruction walk
and the same `irGeneratorSetReturnNeedsBoxing` predicate. `irGeneratorNumberBoxDemand`
is a thin fold over it; the attachment pass calls the same predicate over the
same map. A test battery (f64 / i32 / externref stashes, flat and nested in a
statement buffer, plus a non-generator owner) asserts the two verdicts are
equal case by case rather than relying on the shared code alone.

The scan runs at freeze, the attachment later, so the population can only
SHRINK in between (owners failing other preparation steps). That direction is
harmless: the manifest carries a row nobody consumes. The opposite direction
is a preparation defect and is caught by V1's fail-closed throw.

### V4 — i32 arm coverage: measured, and the plan's fixture had to be replaced

The plan's `type i32 = number` generator does NOT reach the arm. Five variants
of the native-annotation shape were compiled and every one demotes at IR
selection with `type-resolution-unsupported`, so its `f64.convert_i32_s` is
LEGACY output and the parity cell would have been vacuous.

The shapes that do IR-claim and take the `lower.ts` convert-then-box path are
i32-valued expressions on an ordinary `number` parameter. Two are now fixtures,
both verified by WAT inspection to emit `f64.convert_i32_s` → `call $__box_number`
→ `call $__gen_set_return`, and both confirmed IR-claimed
(`legacyBodyEmitted: false`, owner in `irFirstSkipped`):

- `I32_RETURN_GEN` — `return n | 0` (a numeric i32; the headline i32 cell);
- `BOOL_RETURN_GEN` — `return n > 2` (a boolean-branded i32).

**Out-of-scope observation, recorded because the second fixture exposes it:**
a generator returning a boolean yields `{done: true, value: 1}`, not `true` —
the branded i32 is boxed through `__box_number`. Measured identical on the IR
path and the legacy path (`IR_FIRST=1` and `=0` both answer `1`), so it is a
pre-existing whole-compiler conformance gap, not an IR-path defect and not
something this byte-neutral slice may change. Worth its own issue.

## 2026-09-01 F1-S3 implementation checkpoint — Opus lane

### What landed

- **`src/ir/runtime-manifest.ts`** — `GeneratorNumberBoxPolicy`
  (`box: "host" | "native" | "unsupported"`), a frozen
  `GENERATOR_NUMBER_BOX_POLICY_DISABLED`, the optional `generatorNumberBox`
  field canonicalized at builder construction and published resolved on the
  frozen manifest; the `js.generator.number-box` feature row; the two provider
  rows (`host.…` → `host-callable` on capability `number.box`, `native.…` →
  `runtime-callable` on `__box_number`); the policy branch in `#selectProvider`
  whose unavailable arm is a typed `provider-target-unavailable` naming the
  feature and the resolved policy. Sibling constants throughout — the number
  boundary's box arm still has no `"native"` member, and a test pins that.
- **`src/ir/generator-support.ts`** — the shared
  `forEachIrGeneratorSetReturn` enumeration, `irGeneratorNumberBoxDemand`, and
  `attachIrGeneratorSupport(fn, numberBoxProvider)` with the provider as a
  REQUIRED parameter. A numeric stash with no supplied provider is a hard
  error, not a fallback to a spelled symbol.
- **`src/ir/intrinsic-support.ts`** — `prepareIrRuntimeManifest` takes
  `generatorNumberBoxDemand` and requests the feature the asyncPlans way, so a
  generator-only module (which yields NO intrinsic uses) still freezes a
  manifest carrying the row; `preparedGeneratorNumberBoxProvider` derives the
  attachable callable from the frozen manifest's selected provider.
- **`src/ir/integration.ts`** — `integrationGeneratorNumberBoxPolicy`
  (`{ box: !ctx.nativeStrings ? "host" : "native" }`, the exact measured truth
  table), the owner-local unsupported partition in the same pass as the number
  and boolean ones, the freeze-time demand argument, and the threaded attach
  call site. Four touch points, per the #3525 co-ownership constraint.
- **`src/ir/lower.ts`** — the `?? irRuntimeFuncRef("__box_number")` fallback is
  gone (V1); the arm shape is otherwise unchanged.
- **`src/ir/backend/linear-integration.ts`**, **`src/codegen/stdlib-selfhost.ts`**
  — both pass `GENERATOR_NUMBER_BOX_POLICY_DISABLED` explicitly.
- **`tests/issue-3526-generator-number-box.test.ts`** (new, 22 tests).

`prepared-component-dependencies.ts` needed **no edit** (V2): the agreement
check and the evidence recorder are binding-kind agnostic and the attachment
stays runtime-bound. Neither did `intrinsic-support.ts`'s admitted-target
tables — this family has no intrinsic instruction, so nothing keys on it.

Note the production consequence of the truth table: the `"unsupported"` arm is
**unreachable in integration** (both lanes resolve to a supported arm, and
generators demote at BUILD on standalone/WASI/linear). That is required by
neutrality — a reachable unsupported arm would be a behavior change — so the
owner-local partition is exercised by tests and by the linear/self-hosted
adapters' explicit disabled policies, not by a production lane.

### Measured neutrality

**Byte parity — 35/35 cells identical, WAT included.** Seven fixtures
(`VALUE_RETURN_GEN` = f64 arm; `I32_RETURN_GEN` = `n | 0`, the i32 arm;
`BOOL_RETURN_GEN` = `n > 2`, the branded-i32 arm; `FOROF_GEN`;
`REF_RETURN_GEN` = the no-boxing control; `VOID_GEN` = no `setReturn` at all;
`CLEAN` = a generator-free control) × five lanes, compiled before and after on
the same tree. Every cell matches on byte length, binary sha256, import set
AND order; a file-by-file diff of all 35 emitted WAT texts is empty. The
measurement was repeated after the V1 fallback retirement and is unchanged.

| fixture | gc-host | gc-native-strings | standalone | WASI | linear |
| --- | --- | --- | --- | --- | --- |
| `VALUE_RETURN_GEN` | 376 ✓ | 22240 ✓ | 49963 ✓ | 49990 ✓ | demote ✓ |
| `I32_RETURN_GEN` | 466 ✓ | 22329 ✓ | 50026 ✓ | 50053 ✓ | demote ✓ |
| `BOOL_RETURN_GEN` | 367 ✓ | 22231 ✓ | 49929 ✓ | 49956 ✓ | demote ✓ |
| `FOROF_GEN` | 416 ✓ | 22274 ✓ | 50256 ✓ | 50283 ✓ | demote ✓ |
| `REF_RETURN_GEN` | 344 ✓ | 22225 ✓ | 49952 ✓ | 49979 ✓ | demote ✓ |
| `VOID_GEN` | 390 ✓ | 22253 ✓ | 49915 ✓ | 49942 ✓ | demote ✓ |
| `CLEAN` | 113 ✓ | 21973 ✓ | 22588 ✓ | 22615 ✓ | 4874 ✓ |

(✓ = bytes, sha256, imports and WAT all identical before/after. `demote` = the
linear target rejects generators at build, identically on both sides.)

**This slice produced NO WAT diff at all.** The F1-S1 purity-diff allowance
does not apply here and none was needed: no intrinsic purity changes, and the
physical call target is the same `__box_number` before and after.

**Imports and order.** Identical in every cell. The boxing lanes carry
`__box_number, __gen_create_buffer, __gen_push_f64, __gen_set_return,
__create_generator` in that order on both host lanes (the gc-host list is
prefixed by its `string_constants` globals); `REF_RETURN_GEN` carries the same
list minus `__box_number`, which is the control that the boxing import is
present only when the seam demands it.

**Census.** `pnpm run check:ir-fallbacks` is output-identical (diffed, not
eyeballed); unintended, module-level and post-claim buckets all still empty.

**Standalone/WASI/linear (obligation 2).** Generators still demote at BUILD;
`tests/issue-2951.test.ts` needed no edit.

### Non-vacuity — verified by the specified revert-only-the-threading check

Reverting ONLY the attachment threading (hardcoded `irRuntimeFuncRef("__box_number")`
restored) while keeping the entire schema, then re-running the suite:

- **2 tests fail**, and they are exactly the two named classes — the
  `boxProvider`-shape assertion (which also closes the measured gap that NO
  test pinned `boxProvider` before this slice) and the fail-closed
  attachment error;
- **all 20 remaining tests stay green**, including every schema, policy,
  freeze-discipline and derivation test, as the plan requires.

The two halves of the authority claim are pinned separately and both are
needed: `preparedGeneratorNumberBoxProvider` following the manifest's selected
provider (proved by pointing the host arm at a different central capability
and watching the derived callable follow it to `env.__get_undefined`, and by
renaming the native arm's runtime symbol), and the attachment consuming THAT
reference. The byte-parity cells deliberately do not carry the non-vacuity
argument — they are identical by construction, which is the point of the slice.

### Divergences from the plan (recorded, not widened)

1. **The plan's V2 route question resolved to the alternative, not the
   primary.** Recorded above with the measurement; the contract's "host arm →
   `host-callable` capability" survives as the manifest AUTHORITY, only the
   physical binding kind at the seam stays `runtime`.
2. **The plan's i32 fixture does not reach the arm** and was replaced by two
   that do (V4).
3. **One test outside the #3526 suites needed a one-field update.**
   `tests/issue-4104-ir-async-plan-runtime-consumer.test.ts` asserts the frozen
   manifest policy by exact object equality and now also sees
   `generatorNumberBox`. Identical mechanical consequence to F1-S1's
   `numberBoundary` and F1-S2's `booleanBoundary`.
4. **`check:ir-kind-neutrality` evidence-line drift**, the sanctioned
   exception, handled as the F1-S1/F1-S2 checkpoints prescribe. No verdict,
   kind, placement, ratchet count or `settledBy` rationale changed — the
   semantic delta was established by normalising both JSON documents and
   diffing those, and it is exactly TWO citation lines
   (`forof.string` `src/ir/integration.ts` 6105 → 6159; `string.len`
   `src/ir/backend/linear-integration.ts` 1617 → 1622). Patched surgically:
   committing the regenerator's output instead would have been a 269/85-line
   diff for a 2-line change.

### Validation run

Green: TypeScript 5 typecheck (the two pre-existing
`WebAssembly.Tag` errors in `src/linked-provider-runtime.ts` are unrelated and
fail identically on base); `check:ir-fallbacks` (bare, output-identical);
the ratchet chain bare AND under `LOC_GATE_BASE=$(git rev-parse origin/main)`
— loc, func, coercion-sites, oracle-ratchet, dead-exports; `check:ir-dialect`,
`check:ir-layering`, `check:ir-only`, `check:linear-ir`,
`check:host-import-policy`, `check:ir-kind-neutrality` (after the surgical
refresh above), and `check:standalone-ir-cutover-corpus`
(`derived=19/19`, `units=47/47`, `terminal=38/38`). The new 22-test suite, all
five other #3526 suites and both async suites (#4103/#4104) are green — 95
tests across 8 files.

**Pre-existing failure, measured on the base tree and NOT caused by this
change-set:** `tests/issue-2951.test.ts` › "standalone generators stay
compile-twice (out of scope — #680 native carrier)" fails identically with the
change-set reverted. Its five siblings, including both value-returning host
generator cases, pass.

### Not touched (per the plan's scope discipline)

The from-ast generator build gate (`jsHostExterns`), `gen.push` /
`gen.epilogue` / `gen.yieldStar` and the `__gen_*` import family, legacy
generator codegen and the native state machine,
`compiler-timer-shim-preparation.ts`, and `numberBoundary` / `booleanBoundary`
(both unchanged, and a test pins that the number box arm did not acquire a
native member). `scripts/*-baseline.json` is untouched apart from the
sanctioned two-line `check:ir-kind-neutrality` citation refresh;
`scripts/loc-budget-baseline.json` remains main's alone.

### Post-merge re-validation (origin/main `2dfb8396`)

`main` advanced under this branch while the slice was in flight, and one of the
landed changes is generator-adjacent (#3591, `src/codegen/generators-native-consumer.ts`),
so every neutrality claim was re-measured against the merged base rather than
carried over: the 35 byte cells are again identical on bytes, sha256, imports
and WAT against `origin/main` `2dfb8396`; the fallback census is byte-identical
to the pre-merge run; `check:ir-kind-neutrality` needs no further citation
change; TypeScript 7 and 5, the full ratchet chain bare and under
`LOC_GATE_BASE=$(git rev-parse origin/main)`, `check:ir-dialect`,
`check:ir-layering`, `check:ir-only`, `check:linear-ir`,
`check:host-import-policy` and `check:standalone-ir-cutover-corpus` are green.
Focused suites: 134/135 pass across 14 files, the single failure being the
pre-existing `tests/issue-2951.test.ts` standalone compile-twice case, which
was re-confirmed to fail identically with this change-set reverted to
`origin/main` `2dfb8396`.

The merge resolved the issue file as a chronological union — main's F1-S3 plan
section (PR #5409, merged while this branch was in flight) followed by this
branch's verifications and checkpoint. No other file conflicted.

### Merge-queue park (2026-09-01) — diagnosed as not-this-PR, with a gate finding

PR #5412 was auto-parked from the merge queue: the `merge_group` re-validation's
`check for test262 regressions` reported one regression —
`test/language/statements/class/subclass/class-definition-null-proto-super.js`,
pass → fail, `Maximum call stack size exceeded` (`range_error`), net −1 — and
flagged it `Regressions with wasm-hash change: 1` on a content-current
baseline. Read at face value that says a generator-boxing slice moved the bytes
of a non-generator class test, which would violate obligation 1 outright.

**It does not move them.** Compiled on clean `origin/main` and on this branch,
same tree, four shapes: the raw test body; body + `assert.js`/`sta.js` sloppy;
the same strict; and — the shape that settles it — the runner's OWN
`assembleOriginalHarness` output under the runner's exact `compileOptions`,
hashed with the runner's own `computeWasmSha`, for both the primary and the
strict-rerun variant. Every cell is byte-, sha- and WAT-identical
(`aa0313d0d7f6` / `c0a8b0c96fcb` on both sides), and the output is
deterministic across processes.

**Why the gate said otherwise, measured rather than guessed.**
`scripts/diff-test262.ts:1747` computes
`wasmUnchanged = typeof baseSha === "string" && typeof curSha === "string" && baseSha === curSha`,
so the #1222 byte-identity noise filter requires a `wasm_sha` on BOTH sides.
The current baseline JSONL carries **`wasm_sha` on 0 of 48,735 entries** (0 of
35,659 `pass` entries). Against that baseline `wasmUnchanged` can never be
true: every pass→fail transition is counted "with wasm-hash change", and the
companion `Wasm-identical noise: 0` line is structurally guaranteed, not
measured. The filter that exists to absorb exactly this class of runner-variance
failure is therefore **inert**. That is a baseline-schema gap, not something
this slice can fix — it deserves its own issue.

With the bytes identical the behavior is identical, so the stack overflow is
runner-side variance on a stack-depth-sensitive test. The run's other signals
agree (`compile_error → compile_timeout` +1; aggregate compile time +1.8%), and
this change-set is not the cause of those either: on the honest-lane module the
branch compiles marginally FASTER (median 792 ms vs 824 ms over 5 runs).

Resolution: one sanctioned re-admission (hold removed) on a confirmed
not-this-PR determination, with no code change — there is nothing in the diff to
fix. Recorded on the PR as the standing-down comment the park rules require.

**Outcome:** the re-validation passed on re-admission and PR #5412 merged
(`2e74deee` is an ancestor of main), which is the confirmation the diagnosis
predicted — the same head, unchanged, went green on the second `merge_group`
run. This note could not ride that PR because a queued branch is locked against
pushes, so it lands separately.

### Two follow-ups this slice surfaced but does not own

Both were measured here and neither has an issue id yet:
`node scripts/claim-issue.mjs --allocate` refuses in this container (exit 6 —
`gh` is unauthenticated, so the open-PR id scan degrades and the reservation
would not be verified against in-flight PRs). Reserving under
`--allow-unscanned` to file them would risk exactly the permanent hole in the
sequence that #3890/#3891 burned, so they are recorded here for whoever can
allocate cleanly:

1. **The test262 baseline carries no `wasm_sha`, which disables the #1222
   byte-identity noise filter.** `scripts/diff-test262.ts:1747` requires the
   field on BOTH sides; the baseline has it on 0 of 48,735 entries. Every
   pass→fail transition is therefore reported "with wasm-hash change" and
   `Wasm-identical noise: 0` is structurally guaranteed. The filter exists to
   absorb runner-variance failures and currently cannot. Fix is on the
   baseline-producing side (record `wasm_sha` per row), not in the gate.
2. **A generator returning a boolean yields `1`, not `true`.** `return n > 2`
   in a generator stashes a boolean-branded i32, which `gen.setReturn` boxes
   through `__box_number`. Measured identical on the IR and legacy paths
   (`IR_FIRST=1` and `=0` both answer `1`), so it is a whole-compiler
   conformance gap, not an IR-path defect. Out of scope for a byte-neutral
   slice; the `BOOL_RETURN_GEN` fixture added here pins the current behavior
   and would need updating alongside the fix.

## 2026-09-01 F1-S4 implementation plan — boundary residuals (family 1, slice 4)

**Fable lane.** Grounded on `origin/main` at `41265d89f5` by a four-probe
census workflow (symbol boundary, remaining predicates, R4 gaps,
overlap/freshness). Opus implements against this plan. Slice claim
`3526:f1s4`, branch `claude/issue-3526-f1s4-boundary-residuals`.

Three sub-migrations, one PR: they share every piece of landed F1 machinery
and reviewer context, and each is independently revertible for non-vacuity.
The census's other candidates are dispositioned: the symbol boundary is
blocked on brand production (filed as #5258, deferred), R4 gap 5 is R3's by
design, R4 gap 3 is a separate R4 slice.

### Sub-slice A — the two remaining `__unbox_number` from-ast arms

**Measured.** `src/ir/from-ast.ts:12273` and `:12303` (ToPrimitive-adjacent
arms) still emit direct `__unbox_number` calls by runtime symbol; the
sibling coercion arm at `:9524` already emits the provider-free
`js.number.unbox` intrinsic (F1-S1). Every piece exists and is exercised:
intrinsic id (`intrinsics.ts:60`), capability row
(`runtime-host-capabilities.ts:124`), `NumberBoundaryPolicy.unbox` with
host/native arms, freeze-time attachment, owner-local unsupported partition,
and the union-import trigger's attached-target recognition (which already
names `js.number.unbox`).

**Contract.** Both arms emit `emitIntrinsic("js.number.unbox", [...])`;
population unchanged (the arms' guards stay). NOT in scope:
`lower.ts:1440`'s defensive `__unbox_number` in `coerceToF64ForBitwise` —
it is a lower-time consumer (post-freeze, cannot carry a provider-free
intrinsic) and its retirement belongs to #1305; record it untouched.

**Byte expectation.** The F1-S1 purity class MAY appear on host lanes (a
pure intrinsic result no longer spilled); measure the cells and record the
WAT diff class exactly as F1-S1 did. Native/standalone/WASI/linear cells
byte-identical.

### Sub-slice B — `__extern_is_undefined` under manifest authority

**Measured.** `src/ir/from-ast.ts:13769-13770` is the last surviving
pre-F1 two-armed shape in from-ast: runtime symbol vs `env` import chosen
in the front-end by the resolver predicate `externIsUndefinedIsNative?()`
(contract `:626`; integration implementation is
`ctx.standalone || ctx.wasi || ctx.nativeStrings`, #4461). No capability
row exists. The preregistration trigger (`integration.ts`,
`preregisterDynamicSupport`) has raw-call detectors for BOTH forms
(`usesExternIsUndefined` on the env call, `usesNativeExternIsUndefined` on
the runtime symbol) — the F1-S1/S2 precedent says the migration removes the
raw calls those detectors key on, so attached-target recognition must be
widened for the new intrinsic id.

**Contract.** `js.extern.is_undefined` `(externref) -> i32` intrinsic with
a 1:1 feature row; capability record `extern.is_undefined` →
`env.__extern_is_undefined` `(externref) -> i32`; policy
`externIsUndefined: { probe: "host" | "native" | "unsupported" }` on
`RuntimeManifestPolicy` (sibling constants; optional; frozen disabled
default; canonicalized; published resolved). Callers: integration projects
`{ probe: (ctx.standalone || ctx.wasi || ctx.nativeStrings) ? "native" :
"host" }` — the exact former truth table; linear and selfhost project their
measured current behavior (verify what linear-integration's resolver
answers today and mirror it — do not guess). Host arm resolves via the
capability record (`host-callable`); native arm via `runtime-callable` on
the runtime symbol. Delete the resolver contract entry and every
implementation of `externIsUndefinedIsNative`; the from-ast site emits the
provider-free intrinsic with no lane read. Owner-local
`late-preparation-unsupported` partition for a demanding owner on a
disabled policy (mirror the F1 partitions). Widen the trigger's
attached-target recognition to the new id and prove import set/order parity
(the F1-S2 measured-trigger precedent — that proof was non-decorative
there).

**Byte expectation.** Byte-identical everywhere; the F1-S1 purity class MAY
appear if the probe result was previously spilled — measure and record; any
other WAT delta is a defect.

### Sub-slice C — retire the four `gen.*` lowering fallbacks

**Measured.** `src/ir/lower.ts:2731/2749/2769/2796` still carry
`instr.provider ?? irRuntimeFuncRef("__gen_push_*" | "__create_generator" |
"__gen_yield_star" | "__gen_set_return")`. F1-S3 deleted only the
`boxProvider` fallback with a totality proof (`lower.ts:2798-2808`); the
same argument covers all four `provider` fields — `attachIrGeneratorSupport`
attaches them unconditionally for every `gen.*` kind before Phase 3.

**Contract.** Replace each `??` fallback with the F1-S3 fail-closed throw
(a missing attachment demotes one owner, never re-decides the symbol
locally), AFTER pre-implementation verification V3 re-proves totality for
all four kinds. No new rows, no behavior change, bytes identical.

### Required pre-implementation verifications (record in the checkpoint)

1. **V-A population.** Which shapes reach `from-ast.ts:12273/:12303`, and
   does the current resolution of the raw runtime symbol on each reachable
   lane match `NumberBoundaryPolicy.unbox`'s truth table exactly? If any
   lane diverges (a population the policy calls unsupported but the raw
   symbol resolves today), STOP on sub-A and record — do not absorb a
   behavior change.
2. **V-B readers.** Enumerate every reader of `externIsUndefinedIsNative`
   and both trigger detectors; after migration, prove import membership,
   order and indices identical on every lane (the binding-kind switch
   hazard from F1-S3's V2 applies — if order moves, keep the native arm
   runtime-bound and record the route).
3. **V-C totality.** Extend F1-S3's attachment-totality evidence to all
   four `gen.*` provider kinds (same producer/lowering-site enumeration).
4. **V-D fixture reach.** For sub-A, name the fixture(s) that actually
   reach each migrated arm (WAT-inspect once) so the parity cells are not
   vacuous; add one if none exists.

### Behavior-neutrality obligations

`check:ir-fallbacks` census output-identical; import set AND order
identical per lane; byte cells per sub-slice expectation above (record the
matrix); the outcome-code divergence-4 class is NOT expected here (no
demote-site moves) — its absence is itself an assertion; non-vacuity by
reverting each sub-slice's arm independently against the kept schema
(named failing tests per sub-slice, including a first-ever pin of the
`gen.*` provider attachments if none survives C's throw conversion);
`tests/issue-4104-...` whole-shape policy pin gains the new field (the
recorded precedented edit).

### Validation

Typecheck; `check:ir-fallbacks` bare; ratchet chain bare + the
`LOC_GATE_BASE=$(git rev-parse origin/main)` simulation; `check:ir-dialect`,
`check:ir-layering`, `check:ir-only`, `check:linear-ir`,
`check:host-import-policy`, `check:ir-kind-neutrality` (evidence-line
refresh via its own flow if tripped), `check:standalone-ir-cutover` locally
before pushing; the five issue-3526 suites, the F1-S3 generator suite, the
#4461 extern-is-undefined tests, #4103/#4104; hooks without bypass. Growth
allowances in this file's frontmatter, dated.

### Explicitly out of scope

`lower.ts:1440` (#1305), `__to_primitive` itself and the `__ir_dyn_*`
family, the string-plan/stringMethodPlan predicate family (family-2
territory), `env.__get_undefined`/`env.__make_callback` non-async reach
plumbing (runner-up, own slice), the symbol boundary (#5258), R4 gaps
(#3523), and everything owned by #3525/#3522. `integration.ts` diff stays
minimal (policy projection, partition sibling, trigger widening); check the
#3525 claim before touching it.

## 2026-09-01 F1-S4 pre-implementation verifications — Opus lane

**Branch** `claude/issue-3526-f1s4-boundary-residuals`, grounded on `origin/main`
`96f7a3c0`, slice claim `3526:f1s4`. Implemented from the 2026-09-01 F1-S4 plan,
whose template is the landed F1-S1/F1-S2/F1-S3 machinery.

All four answers were measured on the grounded tree BEFORE any source edit. One
of them is the plan's STOP condition, and it fired.

### V-A population — **the STOP condition is REAL. Sub-A is not in this PR.**

The plan asked whether the current resolution of the raw `__unbox_number`
symbol at `from-ast.ts:12273/:12303` matches `NumberBoundaryPolicy.unbox`'s
truth table on every reachable lane. It does not.

**Reach, measured with a temporary trace at each arm.** The two arms are
reached only through `emitUnaryToNumber`, and the shapes that get there are
narrower than the plan assumed:

| arm | reached by | measured |
| --- | --- | --- |
| `:12273` (`extern:Object`) | unary `+`/`-` on an OrdinaryToPrimitive object literal whose methods are property-assigned **function expressions** — `lowerOrdinaryToPrimitiveObjectLiteral` gives that form the open `extern:Object` protocol | IR-claimed and REACHED on gc-host, gc-native-strings, standalone and WASI |
| `:12303` (`object`, string sub-arm) | would need a **shorthand-method** literal whose method returns `string` | **UNREACHABLE.** The closed structural route admits only `number`/`boolean` returns (`select.ts:10344` `hasPreparedParityReturn`, mirrored at `from-ast.ts:5592`); a string-returning method is admitted ONLY as a function expression, which takes the `extern:Object` route instead. Measured: the arm fires zero times across the `check:ir-fallbacks` corpus, the equivalence-adjacent suites and five hand-built candidate shapes |

Eight further candidates (an `Object`-annotated parameter, a declared ambient
`Object`, arrow-function OTP literals, a typed `{ valueOf: () => string }`
parameter) all demote at IR **selection** (`type-resolution-unsupported` /
`body-shape-rejected`) before reaching either arm.

**The divergence.** On the reachable arm, per lane:

| lane | `NumberBoundaryPolicy.unbox` | what the RAW symbol resolves to today |
| --- | --- | --- |
| gc-host | `host` | `env.__unbox_number` import — **matches** |
| standalone / WASI | `native` | union-native function, no import — **matches** |
| gc-native-strings (`nativeStrings: true`, `semanticProviders: "host-assisted"`) | **`unsupported`** | **`env.__unbox_number` import — the owner compiles and is IR-claimed** |
| linear | disabled | arm unreachable (the shape fails the linear backend outright) |

The gc-native-strings row is the STOP. `addUnionImports`
(`registry/imports.ts:813`) registers the **host** `env` family on every
non-`native-first` lane, so the raw runtime symbol resolves there; the
preregistration comment says as much ("`__unbox_number` comes from the union
family in every lane"). Measured directly: the fixture emits
`env.__unbox_number` in its import list and reports `emitted`, while the
F1-S1 arm on the same lane reports
`late-preparation-unsupported / resolve — box=unsupported/unbox=unsupported`.

Migrating the arm to `js.number.unbox` would therefore turn a compiling,
IR-claimed owner into a preparation demote — a behaviour change, which the plan
forbids absorbing. **Sub-A is stopped and recorded, not implemented.** Two
tests in the new suite pin the divergence so the next slice inherits a
measurement rather than a memory.

*Route for a future slice, recorded not taken:* the F1-S3 precedent applies
almost exactly. This seam's truth table is
`semanticProviders === "native-first" ? native : host` — a fourth policy, a
sibling of `numberBoundary` the way `generatorNumberBox` is. Minting it was not
authorised by this plan (which explicitly routed sub-A through
`NumberBoundaryPolicy.unbox`), so it belongs to an amended plan, not to a
byte-neutral slice.

### V-B readers — enumerated; the import-order-parity route was available

`grep -rn externIsUndefinedIsNative` over the whole tree returns **three**
executable hits and nothing else: the contract entry (`from-ast.ts:626`), the
one read (`from-ast.ts:13768`), and the one implementation
(`integration.ts:5767`, `ctx.standalone || ctx.wasi || ctx.nativeStrings`).
There is no test, plan or doc reference. Both trigger detectors were traced
end to end:

| detector | set at | acts at | action |
| --- | --- | --- | --- |
| `usesExternIsUndefined` | `integration.ts:7534` (env-import `call`) | `:7654` | `ensureLateImport("__extern_is_undefined", …)` + `flushLateImportShifts` |
| `usesNativeExternIsUndefined` | `:7553` (runtime `call`) | `:7628` | `ensureObjectRuntime` + flush + `observeNativeRuntimeProvider` |

The two fire at **different points** in the registration sequence, so the
migration recognises the attached target into the same two FLAGS and leaves the
action order untouched.

**Route taken: import-order parity, not the runtime-bound fallback.** F1-S3's
V2 hazard (an import-bound ref refused by `resolveAndObserveCallableProvider`)
does not apply: that path is the GENERATOR observation path, and this family
lowers through `emitPreparedIntrinsic`, which F1-S1/F1-S2 already proved
accepts an import-bound `host-callable` target. Both arms therefore keep
exactly today's physical binding — `env.__extern_is_undefined` import on the
host lane, the runtime symbol on the host-free lanes — and import membership,
order and indices are measured identical in every cell (table below).

**Adapters — measured, and they project `unsupported`.** The plan asked for
"their measured current behaviour, do not guess". The measurement is that
`linear-integration.ts` and `stdlib-selfhost.ts` **do not implement the
predicate at all**, and that no owner under either resolver ever reaches the
arm: a trace instrumented to report an adapter-resolver hit fired **zero**
times across every `tests/linear-*.test.ts` file, `tests/stdlib.test.ts`,
`tests/issue-3520-selfhost-cache-identity.test.ts` and
`tests/standalone-ir-cutover-corpus.test.ts`. The resolver-absent default would
have been `host`, so projecting `unsupported` is behaviour-neutral over an
empty population while keeping both adapters fail-closed — which is what
F1-S1/F1-S2/F1-S3 chose for the same two callers, and what the self-hosted
stdlib's "owns no JS-host imports" invariant requires. Recorded as a
deliberate reading of the plan's wording, with the population measurement that
makes the two readings equivalent.

### V-C totality — all four `gen.*` provider fields, proven the F1-S3 way

F1-S3's V1 evidence extends to the other three kinds without weakening:

| step | finding |
| --- | --- |
| producers | FOUR builder methods (`emitGenPush`, `emitGenEpilogue`, `emitGenYieldStar`, `emitGenSetReturn`), each guarded on `funcKind === "generator"` (epilogue and setReturn additionally on `generatorBufferSlot`). Their only callers are seven from-ast sites, all inside generator lowering. |
| attachment | `attachIrGeneratorSupport` attaches `provider` **unconditionally** for all four kinds on every generator owner — no predicate, no policy gate. |
| middle end | unchanged from F1-S3: `inline-small.ts` / `monomorphize.ts` only rename operands, spread the instr, and run before attachment. |
| lowering entry | ONE production site (`integration.ts:4259` → `lowerIrEntryFunction`); `linear-integration`, `backend/porffor` and `stdlib-selfhost` lower non-generator bodies only, and **no test lowers a `gen.push` / `gen.epilogue` / `gen.yieldStar`** (zero hits across `tests/`). |
| splice risk | every one of the four lowering arms reads its provider only AFTER the `func.generatorBufferSlot === undefined` guard, so a `gen.*` spliced into a non-generator owner is rejected before the provider is touched. |

**Decision: retire all four fallbacks**, to the same fail-closed throw F1-S3
used. One consequence is recorded rather than absorbed: the `gen.push` arm's
local `__gen_push_f64` / `_i32` / `_ref` derivation existed only to feed the
fallback, so it is gone — but its `typeOf(instr.value)` READ is kept, because
`typeOf` throws for a value it cannot type and that throw demotes the owner.
Deleting the read with its consumer would have silently admitted a population
lowering previously refused.

### V-D fixture reach — named, and one cell is honestly vacuous

| arm | fixture that reaches it | verified by |
| --- | --- | --- |
| sub-B probe | `ANYUNDEF` (`const v = a[0]; v !== undefined`) and `MEMO` (the F1-S1 `Map` memo, which reaches the F1-S1 unbox arm AND this one) | trace at the arm; `env.__extern_is_undefined` in the host import list, absent on standalone/WASI |
| sub-C `gen.setReturn` / `gen.push` / `gen.epilogue` | `VALUE_RETURN_GEN`, `I32_RETURN_GEN`, `BOOL_RETURN_GEN`, `FOROF_GEN`, `VOID_GEN`, `REF_RETURN_GEN` (F1-S3's set) | F1-S3's WAT inspection, re-run here |
| sub-C `gen.yieldStar` | **`YIELDSTAR_GEN`, added by this slice** — F1-S3's set had no `yield*` fixture, so the fourth kind's parity cell would have been vacuous | new fixture; `__gen_yield_star` in the emitted import list |
| sub-A arms | `OTPNEG` (the function-expression OTP literal) | kept in the matrix as an UNCHANGED control, since sub-A is stopped |

The `:12303` string sub-arm has no fixture and cannot be given one — see V-A.

## 2026-09-01 F1-S4 implementation checkpoint — Opus lane

### What landed

- **`src/ir/intrinsics.ts`** — `js.extern.is_undefined` `(externref) -> i32`,
  versioned, with a 1:1 feature row, added as an `EXTERN_BOUNDARY_*` SIBLING of
  the number and boolean constants (both unchanged). One ID, but — unlike the
  boolean family — **two** provider arms.
- **`src/ir/runtime-host-capabilities.ts`** — one record `extern.is_undefined`
  → `env.__extern_is_undefined` `(externref) -> i32`, inserted in capability-ID
  sort order so the async prefix keeps its historical position. Noted in place:
  this is NOT an `addUnionImports` member — on the host lane the import is its
  own `ensureLateImport` registration, which is why the trigger keys on it
  separately.
- **`src/ir/runtime-manifest.ts`** — `ExternIsUndefinedPolicy`
  (`probe: "host" | "native" | "unsupported"`), a frozen
  `EXTERN_IS_UNDEFINED_POLICY_DISABLED`, the optional `externIsUndefined` field
  canonicalized at builder construction and published resolved on the frozen
  manifest, the two provider rows (`host.…` → `host-callable` on capability
  `extern.is_undefined`; `native.…` → `runtime-callable` on the runtime symbol),
  and the policy branch in `#selectProvider` whose unavailable arm is a typed
  `provider-target-unavailable` naming the intrinsic and the resolved policy.
- **`src/ir/from-ast.ts`** — the strict-undefined arm emits the provider-free
  intrinsic and reads no lane fact; the `externIsUndefinedIsNative` contract
  entry and its one implementation are deleted. The `externrefShaped` gate
  STAYS — it is a type/representation fact, not a lane fact.
- **`src/ir/integration.ts`** — `integrationExternIsUndefinedPolicy`
  (`{ probe: ctx.standalone || ctx.wasi || ctx.nativeStrings ? "native" : "host" }`,
  the exact former truth table), the owner-local
  `unsupportedExternBoundaryIntrinsic` partition in the same pass as the number,
  boolean and generator ones, the freeze-time policy argument, and the widened
  materialization trigger. Five touch points, per the #3525 co-ownership
  constraint (`--check 3525` re-read before editing: still CLAIMED by
  `ttraenkler/codex`).
- **`src/ir/lower.ts`** — all four `?? irRuntimeFuncRef(<spelling>)` fallbacks on
  the `gen.*` arms are gone, replaced by one shared fail-closed
  `requirePreparedGeneratorProvider`.
- **`src/ir/backend/linear-integration.ts`**, **`src/codegen/stdlib-selfhost.ts`**
  — both pass `EXTERN_IS_UNDEFINED_POLICY_DISABLED` explicitly.
- **`tests/issue-3526-boundary-residuals.test.ts`** (new, 26 tests).

`src/ir/intrinsic-support.ts` needed **no edit** (its attachment and
admitted-target tables are driven by `RUNTIME_PROVIDERS` × `INTRINSIC_DEFINITIONS`,
so the new rows are picked up by construction), nor did
`src/ir/async-prepare.ts` (this family has no async consumer — unlike the number
side, whose hidden host-lane join cost F1-S1 a CI failure), nor
`src/ir/backend/legality.ts` (its linear `intrinsic` arm is an allowlist, so the
new id falls to the default reject).

### One divergence from the plan's contract, forced by measurement

The plan specified the intrinsic as `(externref) -> i32` and said nothing more
about the operand. Measured, the arm's own `externrefShaped` gate admits FOUR IR
type shapes, not one: `val` externref (`a[0]` out of an `any[]`), `extern`
(a declared class instance), `callable` (a function-typed parameter) and
host-mode `string`. `emitIntrinsic` type-checks arguments with `irTypeEquals`,
which admits only the first.

Resolved with `coerce.to_externref`, which is a **type normalisation, not a
conversion**: `lower.ts:2962` elides `extern.convert_any` when the operand is
already externref-shaped, and its `alreadyExternref` test is the same four-way
fact as `externrefShaped`. The added IR instruction therefore lowers to **zero**
Wasm instructions on every shape that reaches this arm — which is why the byte
cells below are unchanged. The alternative (loosening `emitIntrinsic`'s argument
check) would have weakened the closed contract for every intrinsic.

### Measured neutrality

**Byte parity — 67 of 70 cells identical, WAT included.** Fourteen fixtures ×
five lanes, compiled before and after on the same tree, compared on byte length,
binary sha256, import set AND order, and the full emitted WAT text.

| fixture | gc-host | gc-native-strings | standalone | wasi | linear |
| --- | --- | --- | --- | --- | --- |
| `MEMO` | 584 ✓ | 24596 ✓ | 125422 ✓ | 103862 ✓ | 5118 ✓ |
| `ANYUNDEF` | 1489 ✓ | n/a ✓ | 122019 ✓ | 99650 ✓ | 4934 ✓ |
| `STRUNDEF` | 184 ✓ | 22439 ✓ | 22603 ✓ | 22630 ✓ | 4894 ✓ |
| `ANYUNDEF2` | 1614 △ | n/a ✓ | 122247 △ | 99875 △ | 4997 ✓ |
| `OTPNEG` (sub-A control) | 3421 ✓ | 25569 ✓ | 126358 ✓ | 103866 ✓ | n/a ✓ |
| `VALUE_RETURN_GEN` | 2543 ✓ | 24255 ✓ | 129904 ✓ | 104352 ✓ | n/a ✓ |
| `I32_RETURN_GEN` | 2858 ✓ | 24562 ✓ | 130421 ✓ | 104532 ✓ | n/a ✓ |
| `BOOL_RETURN_GEN` | 2819 ✓ | 24519 ✓ | 130420 ✓ | 104531 ✓ | n/a ✓ |
| `FOROF_GEN` | 3150 ✓ | 25079 ✓ | 50251 ✓ | 50278 ✓ | n/a ✓ |
| `YIELDSTAR_GEN` | 1925 ✓ | 24185 ✓ | 51207 ✓ | 51234 ✓ | n/a ✓ |
| `REF_RETURN_GEN` | 2522 ✓ | 24332 ✓ | 129207 ✓ | 104465 ✓ | n/a ✓ |
| `VOID_GEN` | 2594 ✓ | 24308 ✓ | 129972 ✓ | 104420 ✓ | n/a ✓ |
| `BOOLSTORE` (F1-S2 fixture) | 1754 ✓ | 23758 ✓ | 50462 ✓ | 50489 ✓ | n/a ✓ |
| `CLEAN` | 108 ✓ | 21970 ✓ | 22585 ✓ | 22612 ✓ | 4877 ✓ |

(✓ = bytes, sha256, imports and WAT all identical before/after. `n/a` = the
fixture does not compile on that lane, identically on both sides — the
native-strings `ANYUNDEF*` cells and every linear generator cell are
pre-existing refusals, unchanged by this slice. △ = the three cells below.)

**Every sub-C cell is identical, including all four `gen.*` kinds.** The
fallback retirement is provably inert: the attachment already supplied the same
symbol the fallback spelled.

**The three △ cells are the F1-S1 purity class, in a stronger manifestation —
measured, argued and runtime-checked.** `ANYUNDEF2` is the only fixture with
TWO probes in one owner. Its WAT diff is 42 lines on each of the three lanes and
is entirely this: two spill locals (`(local $$ir14 externref)`,
`(local $$ir15 i32)`) and their `local.tee`s disappear, and the second element
read moves from a hoisted position at the top of the body down to its consumer.
Same mechanism F1-S1 recorded — a semantic `intrinsic` is *pure* under the
existing `effectsOf` authority while the opaque `call` it replaces was not, so
the effects-aware scheduler stops anchoring the operand and emits it lazily —
but a stronger manifestation than F1-S1's, which lost only local declarations.
Recorded as a divergence from the plan's "identical instruction sequence"
reading of that class, not absorbed:

- the moved read is a pure bounds-checked GC read that yields `ref.null` on
  out-of-bounds and cannot trap;
- it moves across `call $__extern_is_undefined`, the probe itself, which cannot
  mutate the vector;
- the AFTER form is in fact **closer** to source order than the BEFORE form,
  which hoisted `a[1]` ahead of `a[0]`;
- runtime-checked rather than argued alone: five input cases
  (`[1,2] [1] [] [undefined,5] [7,undefined]`) answer **identically** on base
  and branch, on gc-host and standalone, including the pre-existing gc-host
  out-of-bounds divergence from JS. Nothing about the answers moved.

The plan permitted this class "on host lanes"; it appears on standalone and
WASI too, because the scheduler is lane-independent. That widening of the
permitted set is the divergence being recorded here.

**Imports and order.** Identical in every one of the 70 cells, including the
three △ ones. The host-lane `MEMO` list is `Map_new, Map_get, Map_set,
<string_constants>, __unbox_number, __box_number, __extern_is_undefined`;
standalone and WASI carry no `env` import at all.

**The trigger widening is NOT decorative — measured, and it is the most
load-bearing line in the slice.** With `js.extern.is_undefined` removed from
`preregisterDynamicSupport`'s recognizer and everything else left in place:

| cell | without the widening |
| --- | --- |
| `MEMO` gc-host | 584 → **727** bytes, and TWO extra imports appear (`env.__get_undefined`, `env.__new_ReferenceError`) — exactly the import-membership drift obligation 2 forbids |
| `MEMO` standalone | **compile FAILS** — `invariant/unknown-function-ref @ resolve` |
| `ANYUNDEF` / `ANYUNDEF2` gc-native-strings | a **host `env.__extern_is_undefined` import lands in a native-strings module** — precisely the #4461 failure the native arm exists to prevent |

**Census.** `pnpm run check:ir-fallbacks` is output-identical (diffed, not
eyeballed); unintended, module-level and post-claim buckets all still empty.

**Outcome codes.** No shift anywhere in the 70 cells — the divergence-4 class
does not appear here, and its absence is an assertion, not an omission: the
integration policy resolves the probe to a supported arm on every lane, so no
owner changes demote site. The `"unsupported"` arm is unreachable in production
(as F1-S3's was) and is exercised by tests and by the two adapters' explicit
disabled policies.

### Non-vacuity — each sub-slice reverted independently against the kept schema

- **sub-B**, reverting ONLY the from-ast arm to its direct two-armed call:
  **4 tests fail** — the intrinsic-emission assertion, its lane-freedom twin,
  the operand-normalisation assertion, and "uses the host-free Wasm function on
  standalone, with no env import" (the reverted arm puts a host import into a
  standalone module). All 9 schema/policy tests stay green.
  One assertion had to be **strengthened** to be non-vacuous and the reason is
  worth keeping: the two arms this slice replaced spelled the *same name*
  (`__extern_is_undefined`) and differed only in `import` vs `runtime` binding,
  so the lane-freedom comparison had to compare binding KINDS, not names. A
  name-only comparison passed against the un-migrated front-end.
- **sub-C**, restoring the four `??` fallbacks: exactly the **4** "refuses to
  lower an unattached `gen.*`" tests fail, while the four attachment pins and
  the entire F1-S3 suite stay green.
- **sub-A**: nothing to revert — the two pinning tests assert the arms are
  still unmigrated and that the raw symbol still resolves on the lane whose
  policy calls it unsupported.

The byte cells deliberately carry none of this argument: they are identical by
construction, which is the point of the slice.

### Divergences from the plan (recorded, not widened)

1. **Sub-A is not implemented** — V-A's STOP condition fired. Full measurement
   above; the sibling-policy route a future slice would need is named there.
2. **The `:12303` arm is unreachable**, so even had sub-A proceeded its parity
   cell would have been vacuous. Measured, not inferred.
3. **The intrinsic's operand needed `coerce.to_externref`** — the plan's
   `(externref) -> i32` contract did not anticipate the arm's four admitted
   operand shapes. Byte-inert by the elision at `lower.ts:2962`.
4. **The purity class appears on standalone and WASI, not only host lanes, and
   reorders two pure reads** rather than only dropping local declarations.
   Argued and runtime-checked above.
5. **One test outside the #3526 suites needed a one-field update.**
   `tests/issue-4104-ir-async-plan-runtime-consumer.test.ts` asserts the frozen
   manifest policy by exact object equality and now also sees
   `externIsUndefined`. Identical mechanical consequence to F1-S1's
   `numberBoundary`, F1-S2's `booleanBoundary` and F1-S3's `generatorNumberBox`.
6. **One F1-S3 test fixture needed a provider.** Its "refuses to lower a
   numeric stash whose boxing provider was never attached" case built an
   entirely unattached `gen.setReturn`; sub-C makes the SEAM provider fail
   first, so the fixture now attaches `__gen_set_return` and keeps isolating the
   boxing authority. The seam-provider case it used to reach incidentally is
   pinned explicitly in the new suite, for all four kinds.
7. **`check:ir-kind-neutrality` evidence-line drift**, the sanctioned
   exception, handled as the three prior checkpoints prescribe. No verdict,
   kind, placement, ratchet count or `settledBy` rationale changed — the
   semantic delta was established by normalising both JSON documents and
   diffing those, and it is exactly THREE citation lines (`forof.string`
   `src/ir/integration.ts` 6159 → 6216; `string.len`
   `src/ir/backend/linear-integration.ts` 1622 → 1624; `vec.new_fixed`
   `src/ir/from-ast.ts` 4534 → 4526). Patched surgically: committing the
   regenerator's output instead would have been a 269/85-line diff for a
   3-line change.

### Validation run

Green: TypeScript 7 typecheck; `check:ir-fallbacks` (bare, output-identical);
the ratchet chain bare AND under `LOC_GATE_BASE=$(git rev-parse origin/main)` —
loc (+265 net src LOC, every path granted by this file's frontmatter), func,
coercion-sites, oracle-ratchet, dead-exports; `check:ir-dialect`,
`check:ir-layering`, `check:ir-only`, `check:linear-ir`,
`check:host-import-policy`, `check:test-vacuity-shapes`,
`check:ir-kind-neutrality` (after the surgical refresh above); `lint`;
`prettier --check` over `src`/`tests`/`scripts`; and
`check:standalone-ir-cutover-corpus` (`derived=19/19`, `units=47/47`,
`terminal=38/38`). Focused suites: 223/224 across 17 files — all six #3526
suites, both async suites (#4103/#4104), #2951, #2035, #1169f-7a/7b, #2864,
#680 and #4461.

**Pre-existing failures, measured on the base tree and NOT caused by this
change-set** — identical with the eight source files reverted to
`origin/main` `96f7a3c0`: `tests/issue-2951.test.ts` › "standalone generators
stay compile-twice (out of scope — #680 native carrier)" (1); the five
`tests/stdlib.test.ts` `String.at` / `Array.at` cases; the two
`WebAssembly.Tag` errors in `src/linked-provider-runtime.ts` under TypeScript 5;
and the collect-time failure of
`tests/issue-2949-slice3-dynamic-lowering.test.ts`.

### Not touched (per the plan's scope discipline)

`lower.ts:1440`'s defensive `coerceToF64ForBitwise` `__unbox_number` (a
lower-time consumer, post-freeze, cannot carry a provider-free intrinsic —
#1305 owns its retirement), `__to_primitive` itself and the `__ir_dyn_*`
family, the string-plan / `stringMethodPlan` predicate family,
`env.__get_undefined` / `env.__make_callback` reach plumbing, the symbol
boundary (#5258), R4 gaps (#3523), `compiler-timer-shim-preparation.ts`, and
`numberBoundary` / `booleanBoundary` / `generatorNumberBox` (all three
unchanged). `scripts/*-baseline.json` is untouched apart from the sanctioned
three-line `check:ir-kind-neutrality` citation refresh;
`scripts/loc-budget-baseline.json` remains main's alone.

### One follow-up this slice surfaced but does not own

**The `emitUnaryToNumber` string sub-arm (`from-ast.ts:12303`) is dead code.**
Its `primitiveType.kind === "string"` guard cannot be satisfied: the closed
structural OrdinaryToPrimitive route admits only `number`/`boolean` method
returns, and a string-returning method is admitted only as a function
expression, which takes the `extern:Object` route instead. Measured zero hits
across the fallback corpus and every candidate shape. It is either a dead arm
to delete or a gap in the closed route to close — a decision above a
byte-neutral slice. (`claim-issue.mjs --allocate` still refuses in this
container — `gh` is unauthenticated, so the open-PR id scan degrades and the
reservation would not be verified against in-flight PRs; recorded here rather
than reserved under `--allow-unscanned`, per the #3890/#3891 precedent.)

## 2026-09-01 F2-S1 implementation plan — string.compare under manifest policy (family 2, slice 1)

Grounded on `origin/main` `d39779cbfd`. Slice claim: `#3526:f2s1`
(`ttraenkler/fable-ir-takeover`). Three census probes (boundary surface /
catalogue+policy / test surface) ran against that commit; every line number
below is from them. This slice opens **family 2 (string/text boundary)** the
way F1-S4 closed family 1: one byte-identical policy migration (sub-A) plus
one dead-fallback retirement (sub-B), in one PR.

### Where family 2 stands (census summary)

- **Zero string entries in the R6 vocabulary today**: no string `IntrinsicId`
  (`src/ir/intrinsics.ts:95-101`), no string capability record
  (`src/ir/runtime-host-capabilities.ts:27-39`), no string policy on
  `RuntimeManifestPolicy` (`src/ir/runtime-manifest.ts:165-195`).
- The string ops themselves already flow through IR lane-free in from-ast
  (the #2955 grep gate holds: zero functional `nativeStrings` reads there).
  The un-governed mode reads live in **integration.ts**: the resolve-time
  provider table `resolveAndObserveCallableProvider` (`:6059-6276`, raw
  `ctx.nativeStrings` at Phase-3 resolve time — family 2's largest
  un-governed dispatch), the emit-time no-provider fallbacks (`:6597-6688`),
  and the preparation window `prepareStrings` (`:6943-7129`).
- Measured per-op (gc-host / standalone+nativeStrings / wasi): concat, `<`
  compare, `===`, `.length`, `.charCodeAt`, template literals are all
  IR-claimed today; host lane imports span THREE namespaces (`env` funcs,
  `wasm:js-string` builtins, `string_constants` globals); native/wasi lanes
  are import-free. `String(n)` coercion is selector `external-call` — outside
  IR entirely, selector work before boundary work.
- **Deferred by design**: `string.concat`/`eq`/`len` host providers live in
  the `wasm:js-string` module and `string.const` in imported GLOBALS — both
  outside the frozen capability-record schema (`module: "env"`,
  `kind: "func"`, runtime-host-capabilities.ts:76-78). Widening those axes is
  its own schema slice (the family-2 analog of F1-S1's value widening) and
  does NOT ride along here. `stringMethodPlan` (~14 concrete spellings,
  from-ast.ts:656-666 / integration.ts:5652-5718) is the family's XL tail and
  needs its own per-method census first.

### Sub-A — `stringCompare` policy + `string.compare` capability

**The arm being governed**: `IR_STRING_COMPARE_FN` (`__ir_str_compare`) —
from-ast emits it lane-free (`src/ir/from-ast.ts:8477`; consumer :13189);
resolution happens at `integration.ts:6189-6195`: host
`ctx.funcMap.get("string_compare")` (env import
`(externref,externref)->i32`, shim `src/runtime.ts:17620`) vs native
`nativeStrHelperHandle("__str_compare")`. Truth table is exactly
`ctx.nativeStrings ? runtime __str_compare : host env.string_compare`.

**Contract**:
1. New capability record
   `record("string.compare", "string_compare", ["externref","externref"], ["i32"])`
   in the central catalogue — fits the existing frozen schema (module `env`,
   kind `func`; value union already has externref/i32,
   runtime-host-capabilities.ts:53).
2. New `stringCompare?: StringComparePolicy` — `{compare: "host" | "native" |
   "unsupported"}`, sibling of `externIsUndefined` (two provider rows:
   host-callable → the capability record; runtime-callable →
   `__str_compare`). Frozen disabled default, canonicalized, published,
   selected fail-closed with typed `provider-target-unavailable` naming the
   policy. Follow the 10-point precedented edit list verbatim
   (runtime-manifest.ts type+default+constructor refreeze :1137-1157,
   feature/provider unions :604-701 + :64/:277-284, `#selectProvider` branch
   :1425-1497, caller projection `integrationStringComparePolicy(ctx)` beside
   :799-875 consulted ONCE before freeze, policy literal in
   `prepareBuiltFnRuntimeManifest` :922-936, owner-local partition scan
   :3578-3663, explicit disabled policy in the linear adapter and
   `src/codegen/stdlib-selfhost.ts`, and the whole-shape pin updates).
3. The resolve arm at `:6189-6195` stops reading `ctx.nativeStrings`: it
   reads the frozen manifest's selected provider for the string-compare
   demand and fails closed when absent. Mechanism choice is probe P1's
   (below): freeze-time demand (`requestFeature`, the F1-S3
   `generatorNumberBoxDemand` precedent, intrinsic-support.ts:343-389) vs a
   full `js.string.compare` intrinsic instruction. The demand shape is
   recommended: no new IrType ground, no from-ast changes, and byte identity
   is structurally easier.
4. **Import parity is the hard byte constraint**: the host arm today binds
   the funcMap's existing base import `string_compare` — the policy-driven
   attachment must land the exact same import index (no `ensureLateImport`,
   no new registration), or bytes shift. String spellings are NOT in
   `UNION_IMPORT_FUNC_NAMES` and must NOT be union-materialized — add
   per-demand attached-target recognition (the `attachedExternIsUndefinedArm`
   shape, integration.ts:7553-7560) routing to the EXISTING string
   materializers, keeping each lane's registration order identical.
5. No change to `plan.invocation`, no change to from-ast (the #2955 gate and
   the S4 lane-freedom lesson: pins compare binding KINDS, not names).

### Sub-B — retire the `forof.string` `??` fallback

`src/ir/lower.ts:3375`:
`instr.provider ?? irIntrinsicFuncRef(IR_STRING_ITERATOR_CHAR_AT_FN)` is the
last string-op `??` lane fallback in lower.ts (the `gen.*` quartet was
retired by F1-S4; the :3498-3520 quartet is `extern.*`, family 6).
`attachIrStringSupport` attaches the provider unconditionally on every
adapter that prepares strings (`src/ir/string-support.ts:72-73, 138-147`;
linear adapter at `src/ir/backend/linear-integration.ts:735-737`), so the
fallback is dead code under F1-S3's totality argument. Replace with a
`requirePreparedStringProvider`-style fail-closed throw and pin "refuses to
lower an unattached forof.string" — same anatomy as the F1-S4 sub-C pins in
`tests/issue-3526-boundary-residuals.test.ts`.

### Required pre-implementation probes (answers go in the checkpoint note)

- **P1 — mechanism**: demand-at-freeze (recommended) vs intrinsic
  instruction. For the demand shape, name the exact seam that reads the
  selected provider (the `preparedGeneratorNumberBoxProvider` analog,
  intrinsic-support.ts:262-280) and prove the host arm binds the SAME
  `env.string_compare` funcMap index as today (contract item 4). Note the
  measured constraint that generator-style seams accept only
  runtime/intrinsic bindings — verify whether the string-compare seam can
  take an `irImportFuncRef` host binding or must follow the same
  runtime-symbol route; either way the physical import must not move.
- **P2 — adapters**: exact edits for the linear adapter and
  stdlib-selfhost disabled policies (edit-list item 9), with the F1-S2/S3/S4
  loc-budget rationale pattern (issue :83-120).
- **P3 — outcome-pin shift**: which committed pins actually move. Candidates
  measured: `tests/issue-3520-callable-provider-abi.test.ts:16,768-777`
  (IR_STRING_COMPARE_FN binding-key/ABI identity — update to compare KINDS),
  the `tests/issue-4104-...:432-442` whole-shape policy pin and its
  `issue-3526-ir-runtime-manifest.test.ts` analogs (new field), and whether
  any `tests/issue-3529-*` divergence-4 pins
  (`operand-coercion-unsupported`@build) cover populations this arm demotes —
  if none demote (compare is total under both arms), record that the
  divergence-4 class is EMPTY for this slice.
- **P4 — census**: `pnpm run check:ir-fallbacks` output must be diffed, not
  eyeballed (`ir-fallback-baseline.json` has `unintended: {}` and
  `deferred: {"string-builder-candidate": 2}` — neither should move; note
  `check-ir-fallbacks.ts:145-149` has no `resolve` stage key, so any
  demote-site shift would change census OUTPUT). The linear twin
  `scripts/linear-ir-baseline.json` is byte-exact-pinned
  (`tests/issue-4550-linear-ir-census.test.ts:627-629`) — must not change.

### Verification matrix (the 6-point F1 template, issue :1595-1616, verbatim)

- **V-A byte cells**: the F1 fixture protocol — fixtures × 5 lanes (gc-host,
  gc-native-strings, standalone, WASI, linear), before/after on the same
  tree: byte length, sha256, import set AND order per cell; full WAT diff
  empty. Expectation for this slice: **all cells byte-identical** (no purity
  class — the semantic ref shape does not change). Any WAT delta is a defect.
- **V-B import parity**: exact `result.imports.map(name)` array in order on
  the host lane (the F1-S2 :467-492 pattern), plus a runtime oracle equality
  check on string comparisons (`<`, `>`, `localeCompare`-free shapes) across
  lanes.
- **V-C non-vacuity by revert**: restore only the `:6189-6195` mode read
  (sub-A) / only the `:3375` fallback (sub-B); exactly the named new pins
  fail, all schema/policy pins stay green (the S3 2/20, S4 4/9 pattern).
- **V-D fail-closed reachability**: refusal per disabled policy with typed
  `provider-target-unavailable` naming `stringCompare`; owner-local demote
  (`late-preparation-unsupported`@resolve) proven per-owner with a clean
  co-owner staying emitted; unattached `forof.string` refusal pin (sub-B).
- **V-E suites**: new `tests/issue-3526-string-boundary-compare.test.ts` with
  the committed per-slice anatomy (a)-(i) from the F1 files; affected string
  regression controls run unchanged (`issue-3518-string-repeat-ir`,
  `issue-3502-string-contract`, `issue-2955-depolymorph-gate` — the grep gate
  must stay green); all five ratchet gates chained before commit.

### Out of scope

The `wasm:js-string` and `string_constants` capability-schema widenings
(their own slice, before concat/eq/len/const can move); `stringMethodPlan`
(XL, needs per-method census); `String()` coercion (selector work, not
boundary work); `stringForOfPlan`/`charReadPlan` strategy queries (stay
build-time per #2955 — only their provider NAMES could ever be
manifest-projected); the resolve-table rows beyond compare (`__concat_N`,
repeat, charAt families — later slices ride on this slice's machinery).

## 2026-09-01 F2-S1 checkpoint note — Opus lane

**Branch** `claude/issue-3526-f2s1-string-compare`, grounded on `origin/main`
`bee8a149`, slice claim `3526:f2s1`. Implemented from the 2026-09-01 F2-S1 plan.
All four probe answers were measured on the grounded tree BEFORE any source edit.

### Probe answers

**P1 — mechanism: DEMAND-AT-FREEZE, as recommended. The intrinsic instruction
was not needed and would have been the wrong shape.** The seam has no
`intrinsic` to attach to: from-ast emits a plain `call` through the
`IR_STRING_COMPARE_FN` (`__ir_str_compare`) sentinel func-ref
(`from-ast.ts:8491`), so the F1-S3 `generatorNumberBoxDemand` route is the exact
structural match. The demand is requested by `irStringCompareDemand`, a scan of
the `call` population; the SAME predicate answers the freeze request and the
owner-local partition, so the two can never disagree.

The seam that reads the selected provider is **not** an attachment pass, and
that is the one place this slice diverges from the F1-S3 template. The
`preparedGeneratorNumberBoxProvider` analog is
`preparedStringCompareProvider(prepared)` (`intrinsic-support.ts`), but it
returns the ARM CLASSIFICATION plus the physical spelling
(`{arm:"host",field:"string_compare"}` / `{arm:"native",symbol:"__str_compare"}`)
rather than an `IrFuncRef` — because the two arms are materialized by different
existing routines and no single callable reference could carry the decision
without moving a registration. Its consumer is the resolve-time provider table
itself (`integration.ts`, the `IR_STRING_COMPARE_FN` arm), which now receives
the whole `PreparedIrRuntimeManifest` where it previously received only
`preparedRuntimeManifest?.providers` — the feature row `js.string.compare` is
not in that intrinsic-keyed map, and the host arm's field name comes from the
frozen capability records.

**The plan's note about generator-style seams accepting only runtime/intrinsic
bindings does not bind here, and the import cannot move — for a stronger reason
than the plan anticipated.** No binding is constructed at all: the arm resolves
a funcidx directly. And `env.string_compare` is neither an `addUnionImports`
member nor an `ensureLateImport` registration — it is a **BASE import minted by
the legacy import collector's pre-pass** (`import-collector.ts:1637-1640`, gated
on `!ctx.nativeStrings`), long before any IR preparation runs. The migrated host
arm evaluates `ctx.funcMap.get(record.field)`, which is character-for-character
the same lookup as the old `ctx.funcMap.get("string_compare")`. There is no
registration in this slice to reorder, which is why contract item 4 is satisfied
structurally rather than by measurement alone. The plan's suggested
`attachedExternIsUndefinedArm`-style preregistration widening was consequently
**not needed and not added**: that recognition exists because F1's migrations
removed the raw `call` the detectors keyed on, whereas this slice leaves the
front-end call shape untouched (`prepareStrings`'s own compare detector at
`integration.ts:7034-7040` still sees exactly what it saw before). Recorded as a
divergence below.

**P2 — adapters.** Both take the explicit disabled policy, one line each:
`linear-integration.ts` `prepareLinearIntrinsicFunctions` and
`stdlib-selfhost.ts`'s per-definition freeze. Note honestly what that does and
does not mean: **on the linear lane the disabled policy is inert**, because that
adapter never passes `stringCompareDemand` and resolves the compare through its
own resolver (`linear-integration.ts:1502` → `__str_cmp`). The row is stated so
the frozen policy is total and no adapter inherits a host decision by omission —
the same status `numberBoundary`/`booleanBoundary` already have there. Budget
rationale added to this file's frontmatter in the F1-S2/S3/S4 pattern; no new
path was needed.

**P3 — outcome-pin shift: ONE pin moved, and it is the precedented one.**
- `tests/issue-4104-ir-async-plan-runtime-consumer.test.ts:432-443` — the
  whole-shape frozen-policy equality now also sees `stringCompare`. Identical
  mechanical consequence to F1-S1's `numberBoundary`, F1-S2's `booleanBoundary`,
  F1-S3's `generatorNumberBox` and F1-S4's `externIsUndefined`.
- `tests/issue-3520-callable-provider-abi.test.ts` "binds one string-compare
  intrinsic to the mode-selected import or definition" — **did NOT move.**
  Measured, not assumed: it passed unchanged. It asserts the resolved Program-ABI
  slot, and the slot is identical because the physical target is.
- `tests/issue-3526-ir-runtime-manifest.test.ts` — **did not move**; it carries
  no whole-shape policy assertion.
- **The divergence-4 class is EMPTY for this slice.** No owner changes demote
  site anywhere in the byte matrix: the integration policy resolves the compare
  to a supported arm on every lane (`nativeStrings ? native : host` is total),
  so the `"unsupported"` arm is unreachable in production, exactly as F1-S3's and
  F1-S4's were. Its absence is an assertion here, not an omission — the
  `irOutcomes` records are byte-compared in all 30 cells below.

**P4 — census: `pnpm run check:ir-fallbacks` output is DIFFED and IDENTICAL.**
Run on both trees (`git checkout -- src` for the base, patch re-applied after),
`diff` clean. Neither baseline bucket moved: `unintended: {}` stays empty,
`deferred: {"string-builder-candidate": 2}` unchanged, module-level and
post-claim both `(none)`. `scripts/linear-ir-baseline.json` is untouched
(`git status` clean on `scripts/` apart from the sanctioned two-line citation
refresh recorded below), so the `tests/issue-4550-linear-ir-census.test.ts`
byte-exact pin holds — that suite was run and passes.

### What landed

- **`src/ir/intrinsics.ts`** — `EXTERNREF_PAIR_TO_I32_INTRINSIC_SIGNATURE`, the
  `(externref, externref) -> i32` ABI shared by both arms. No new `IntrinsicId`:
  this family has no intrinsic instruction.
- **`src/ir/runtime-host-capabilities.ts`** — one record `string.compare` →
  `env.string_compare`, inserted in capability-ID sort order. Noted in place: the
  first record whose physical import is a base import, not a union member or a
  late registration.
- **`src/ir/runtime-manifest.ts`** — `StringComparePolicy`
  (`compare: "host" | "native" | "unsupported"`), a frozen
  `STRING_COMPARE_POLICY_DISABLED`, the optional `stringCompare` field
  canonicalized at builder construction and published resolved on the frozen
  manifest, the `js.string.compare` feature row, the two provider rows
  (`host.…` → `host-callable` on capability `string.compare`; `native.…` →
  `runtime-callable` on `__str_compare`), and the `#selectProvider` branch whose
  unavailable arm is a typed `provider-target-unavailable` naming the feature and
  the resolved policy.
- **`src/ir/intrinsic-support.ts`** — the `stringCompareDemand` input (and its
  place in the "freeze nothing at all" guard) plus `preparedStringCompareProvider`.
- **`src/ir/integration.ts`** — `integrationStringComparePolicy`
  (`{ compare: ctx.nativeStrings ? "native" : "host" }`, the exact former truth
  table), `irStringCompareDemand`, the owner-local `unsupported` partition in the
  same pass as the four F1 ones, the freeze-time policy + demand arguments, the
  prepared manifest threaded in place of its providers map, and the rewritten
  resolve arm.
- **`src/ir/lower.ts`** — the `forof.string` `??` fallback is gone, replaced by
  `requirePreparedStringProvider`, the string family's twin of F1-S4's
  `requirePreparedGeneratorProvider`.
- **`src/ir/backend/linear-integration.ts`**, **`src/codegen/stdlib-selfhost.ts`**
  — both pass `STRING_COMPARE_POLICY_DISABLED` explicitly.
- **`tests/issue-3526-string-boundary-compare.test.ts`** (new, 21 tests).

`src/ir/from-ast.ts` needed **no edit** — the #2955 gate already holds there and
the seam was already lane-free in the front-end; this slice governs the
resolve-time table, not the emission. `src/ir/string-support.ts`,
`src/ir/backend/legality.ts` and the preregistration trigger needed no edit
either (see the divergence below).

### Sub-B totality — re-proved, and the linear half is NOT the plan's argument

The plan justified sub-B by "`attachIrStringSupport` attaches the provider
unconditionally on every adapter that prepares strings, including the linear
adapter at `linear-integration.ts:735-737`". **The first half holds; the second
does not, and the retirement is safe for a different reason.** Measured:

- **WasmGC path — total as stated.** `prepareStrings` (`integration.ts:7111-7126`)
  runs `attachIrStringSupport` over EVERY healthy owner, and
  `irStringCallableProviderRef` returns a non-`undefined` ref for `forof.string`
  unconditionally (`string-support.ts:72-73, 132-148`).
- **Linear path — the plan's citation is conditional.** `linear-integration.ts`
  calls `attachIrStringSupport` only `if (usesRepeat)` (`:733-740`), so a linear
  owner with a `forof.string` and no `string.repeat` would get NO attachment.
  That is harmless only because **`forof.string` is absent from the linear
  instruction allowlist** (`src/ir/backend/legality.ts:230-320`), so such an owner
  demotes at the function-lowering boundary and never reaches `lower.ts`. The
  `FOROFSTR::linear` byte cell is in the matrix precisely to hold that line: it
  is unchanged.
- **`stdlib-selfhost.ts`** lowers its own IR with its own resolver and no string
  attachment pass, but its self-hosted bodies carry no `forof.string`; its cells
  are covered by the whole-module byte parity below.

### Measured neutrality

**Byte parity — 30 of 30 cells identical, WAT included.** Six fixtures × five
lanes (gc-host, gc-native-strings, standalone, WASI, linear), compiled before and
after **on the same tree** (the source patch was captured, reverted with
`git checkout -- src`, re-measured, and re-applied), compared on byte length,
binary sha256, import set AND order, full emitted WAT text, the error list, and
the `irOutcomes` records.

| fixture | gc-host | gc-native-strings | standalone | wasi | linear |
| --- | --- | --- | --- | --- | --- |
| `STRCMP` (`a < b`) | 157 ✓ | 22652 ✓ | 22816 ✓ | 22843 ✓ | 4876 ✓ |
| `STRCMP4` (all four operators) | 270 ✓ | 22540 ✓ | 22704 ✓ | 22731 ✓ | 4988 ✓ |
| `STRMIX` (compare beside concat/eq/len) | 316 ✓ | 22936 ✓ | 23100 ✓ | 23127 ✓ | 4956 ✓ |
| `FOROFSTR` (sub-B) | 1351 ✓ | 22669 ✓ | 49119 ✓ | 49146 ✓ | 4960 ✓ |
| `BOTH` (both sub-slices, one module) | 1504 ✓ | 22902 ✓ | 49352 ✓ | 49379 ✓ | 4989 ✓ |
| `CLEAN` (control, no strings) | 113 ✓ | 21973 ✓ | 22588 ✓ | 22615 ✓ | 4874 ✓ |

(✓ = bytes, sha256, imports, WAT, errors and IR outcomes all identical
before/after.) **No purity class appears and none was expected**: this slice adds
no semantic `intrinsic` instruction, so the effects-aware scheduler sees exactly
the same call it saw before. Any WAT delta would have been a defect; there is
none.

**Imports and order.** Identical in all 30 cells. The `STRCMP` gc-host list is
exactly `["env.string_compare"]` — pinned as an ordered array in the new suite,
which is the assertion that would catch a late registration before a byte diff
did. The three native-strings lanes carry no compare import at all
(`gc-native-strings` carries only the `__str_*` memory-bridge trio; standalone,
WASI and linear carry none).

**The migrated arm is REACHED — measured, not assumed.** With a temporary probe
on the arm, the 30-cell run resolves it **15** times: 3 host
(`{arm:"host",field:"string_compare"}`, the three gc-host compare fixtures) and
12 native (`{arm:"native",symbol:"__str_compare"}`, four fixtures × three
native-strings lanes). `BOTH::gc-host` does not reach it because that owner
demotes at IR selection for an unrelated reason, identically on both trees.

**Runtime oracle.** All four relational operators are checked against JavaScript
on seven input pairs (`a/b`, `b/a`, `a/a`, `""/a`, `""/""`, `ab/abc`, `Z/a`)
through an instantiated host-lane module. Nothing about the answers moved.

**Census.** `pnpm run check:ir-fallbacks` output-identical (diffed, not
eyeballed); unintended, module-level and post-claim buckets all still empty.

### Non-vacuity — each sub-slice reverted independently against the kept schema

- **sub-A**, reverting ONLY the resolve arm to its `ctx.nativeStrings` read:
  **3 tests fail** — "consults the prepared string-compare provider", "reads NO
  lane discriminator", and "fails closed rather than falling back to a locally
  decided symbol". All 10 schema/policy pins and every end-to-end, import-order,
  runtime-oracle and byte assertion stay green.
  **Those three pins are deliberately SOURCE-shape assertions, and that is a
  finding worth stating plainly rather than hiding behind a green suite.** A
  behavioural pin cannot separate the migrated arm from the one it replaced: the
  policy projection reproduces the old truth table exactly, so both forms emit
  identical bytes on every lane — which is the whole point of the slice and the
  reason all 30 cells are unchanged. What actually moved is WHICH authority
  answers, and on this seam that is only observable in source. The pins use the
  established `tests/issue-2955-depolymorph-gate.test.ts` grep-gate idiom, scoped
  to the one arm. F1-S4's sub-B had a behavioural revert signal available (the
  reverted arm put a host import into a standalone module); this seam has none,
  and manufacturing one would have meant changing behaviour.
- **sub-B**, restoring the `??` fallback: exactly **1** test fails — "refuses to
  lower an unattached `forof.string`" — while the attachment pin, the
  already-attached-provider pin and the end-to-end iteration pin stay green.

### Divergences from the plan (recorded, not widened)

1. **No preregistration/attached-target recognition was added.** The plan
   specified per-demand recognition modeled on `attachedExternIsUndefinedArm`.
   It is not needed and adding it would have been dead code: that mechanism
   exists because F1's from-ast migrations DELETED the raw `call` the detectors
   keyed on, whereas this slice does not touch the front-end at all.
   `prepareStrings`'s compare detector still matches the identical instruction.
   Byte-confirmed by the 30 identical cells, including their import order.
2. **The manifest is threaded to the resolve site, rather than a callable being
   attached at a preparation seam.** The compare is a plain `call`, not a
   `string.*` IR instruction, so it has no provider slot to attach to. The
   threading changes the parameter of `resolveAndObserveCallableProvider`,
   `makeResolver` and `preregisterCallableProviders` from
   `preparedRuntimeManifest?.providers` to `preparedRuntimeManifest`; the
   providers map is re-derived on the first line, so every other arm is untouched.
3. **`preparedStringCompareProvider` returns an arm classification, not an
   `IrFuncRef`** — unlike `preparedGeneratorNumberBoxProvider`. The two arms have
   different existing materializers; see P1.
4. **The plan's sub-B totality citation for the linear adapter is conditional.**
   Corrected above with the real argument (the legality allowlist). The
   retirement is still safe; the reason recorded in the plan was not.
5. **One test outside the #3526 suites needed a one-field update.**
   `tests/issue-4104-ir-async-plan-runtime-consumer.test.ts` — the precedented
   whole-shape policy pin.
6. **`check:ir-kind-neutrality` evidence-line drift**, the sanctioned exception,
   handled as the four prior checkpoints prescribe. No verdict, kind, placement,
   ratchet count or `settledBy` rationale changed — established by normalising
   both JSON documents and diffing those, which isolates exactly **TWO** citation
   lines (`forof.string` `src/ir/integration.ts` 6243 → 6327; `string.len`
   `src/ir/backend/linear-integration.ts` 1624 → 1626). Patched surgically:
   committing the regenerator's output instead would have been a 524-line diff
   (it reformats every `evidence` array) for a 2-line change.

### Validation run

Green: TypeScript 7 typecheck; `check:ir-fallbacks` (bare, output-identical);
the ratchet chain bare AND under `LOC_GATE_BASE=$(git rev-parse origin/main)` —
loc (+301 net src LOC, every path granted by this file's frontmatter), func,
coercion-sites, oracle-ratchet, dead-exports; `check:ir-dialect`,
`check:ir-layering`, `check:ir-only`, `check:linear-ir`,
`check:host-import-policy`, `check:test-vacuity-shapes`,
`check:ir-kind-neutrality` (after the surgical refresh above), `lint`, and
`check:standalone-ir-cutover-corpus` (`records=5/5`, `sources=5`, `units=47`).
Focused suites: **233 passing across 17 files** — all seven #3526 suites
(including the new one), both async suites (#4103/#4104), #3520, #2955,
#3518, #3502, #4550 linear-ir census, #1183 and #3167 (the string relational
suite this seam serves).

### Not touched (per the plan's scope discipline)

The `wasm:js-string` and `string_constants` capability-schema widenings (their
own slice — `string.concat`/`eq`/`len`/`const` stay un-governed and their
resolve-table rows keep reading `ctx.nativeStrings`); `stringMethodPlan`;
`String()` coercion; `stringForOfPlan` / `charReadPlan` strategy queries; the
`__concat_N`, repeat and charAt resolve-table families; `src/ir/from-ast.ts`;
the `extern.*` lowering quartet (family 6); and `numberBoundary` /
`booleanBoundary` / `externIsUndefined` / `generatorNumberBox`, all four
unchanged. `scripts/*-baseline.json` is untouched apart from the sanctioned
two-line `check:ir-kind-neutrality` citation refresh.

## 2026-09-01 F2-S2 implementation plan — capability-record schema widening (family 2, slice 2)

Grounded on `origin/main` `dc29e1f15d` (first parent = PR #5433, the merged
F2-S1). Slice claim: `#3526:f2s2` (`ttraenkler/fable-ir-takeover`). Three
probe lanes (schema+consumers / boundary sites / test-evidence) ran against
that commit; every line number below is theirs.

**This slice moves NO boundary.** It widens the central capability-record
schema so that family 2's remaining host crossings — which live in the
`wasm:js-string` module and in `string_constants` / `string_constants16`
GLOBAL imports — become *expressible* as exact-ABI catalogue rows. No policy
field, no provider row, no resolve/attach/from-ast edit. Byte identity holds
by construction: no provider references the new rows, so `freeze()`
(`runtime-manifest.ts:1430-1446`) never selects them and every frozen
manifest, import and body stays exactly as today. This is what makes the
issue's anti-vacuity item 10 ("typed projections include intentional
non-`env` string import namespaces", :856-857) satisfiable at all — today
the record type cannot spell a non-`env` namespace.

### The frozen schema, measured (`src/ir/runtime-host-capabilities.ts`)

- Record type `:72-83`: `module: "env"` (`:77`), `kind: "func"` (`:79`),
  `params`/`results` over the value union `"externref" | "i32" | "f64"`
  (`:54`, set `:56-60`); factory `record()` `:85-101` hardcodes both literals;
  12 ids `:27-40` (F2-S1's `string.compare` at `:39`, row `:140`);
  `assertRuntimeHostCapabilityRecord` `:189-223` checks the exact key list
  (`:204-206`), `module` (`:207-209`), `field` (`:210-212`), `kind`
  (`:213-215`), value types (`:216-217`), exception policy (`:218-222`);
  `canonicalizeRuntimeHostCapabilityCatalog` `:236-253` demands completeness
  (ids ↔ rows). No `Record<Id,…>` table or `never`-check here — completeness
  is dynamic (`:248-251`).
- Consumers that ASSUME func-kind (each must gain a kind guard or narrow
  type): `intrinsic-support.ts` `ADMITTED_CALLABLE_TARGETS` `:84-90`,
  `providerAttachment` `:229-230`, `preparedGeneratorNumberBoxProvider`
  `:274-278`, `preparedStringCompareProvider` `:309-313`, async adapters
  `:521-529`; `async-runtime-providers.ts` `asAsyncHostAdapter` `:90-100`
  iterates `[...params, ...results]` unguarded (`:94-98`) and the
  `AsyncHostAdapter` alias `:83`; `runtime-manifest.ts` `host-callable`
  implementation `:366-376` admits any id; provider index checks
  `:1484-1509` never verify func-kind; `ir-async-runtime-adapters.ts`
  `expectedSignature` `:27-33` / `assertImportSignature` `:35-` (typed on the
  narrow async union — unaffected if `AsyncHostAdapter` is retargeted to the
  func arm).
- Two measured facts that shape the design:
  1. **`wasm:js-string.concat` returns `(ref extern)`**, not `externref`
     (`imports.ts:628`; binary dump `(result (ref extern))`; `substring`
     `:649-653` likewise). The value union must grow `"ref_extern"` (already a
     `ValType` member, `src/ir/types.ts` after `:265`).
  2. **`string_constants` globals use the literal itself as the import
     field** (`imports.ts:177` `importName = useSurrogateNs ? hexCodeUnits(value) : value`;
     measured `string_constants."f"`, `"ab"`, `""`; lone surrogates go to
     `string_constants16` keyed by `hexCodeUnits`, `STRING_CONSTANTS16_NS`
     `src/string-surrogate.ts:20`). A closed catalogue cannot enumerate
     per-literal fields, so a global record carries a **field scheme**, not a
     field name.

### Contract

1. **Kind-discriminated record union.**
   ```ts
   type RuntimeHostCapabilityFuncModule = "env" | "wasm:js-string";
   type RuntimeHostCapabilityGlobalModule = "string_constants" | "string_constants16";
   interface RuntimeHostCapabilityFuncRecord<Id, V>   { capability: Id; module: FuncModule;   field: string; kind: "func";   params: readonly V[]; results: readonly V[]; exceptionPolicy?: … }
   interface RuntimeHostCapabilityGlobalRecord<Id, V> { capability: Id; module: GlobalModule; field: { scheme: "literal" | "literal-utf16-hex" }; kind: "global"; valueType: V; mutable: boolean }
   type RuntimeHostCapabilityRecord<Id, V> = Func | Global;
   ```
   Module unions are **closed** (`as const` tuple → union, the `:27-42`
   idiom) and live on the kind arm, so `env.<global>` and
   `wasm:js-string.<global>` are unrepresentable. Value union `:54` grows
   `"ref_extern"` (+ set `:56-60`). Factories: `funcRecord(capability, module,
   field, params, results, exceptionPolicy?)` (the 12 existing rows pass
   `"env"`; `record()` may remain as an `env`-defaulting alias so existing
   call sites and tests are untouched) and
   `globalRecord(capability, module, fieldScheme, valueType, mutable)`.
2. **New ids + rows (sorted; catalogue stays complete):**
   - `funcRecord("string.char_code_at", "wasm:js-string", "charCodeAt", ["externref","i32"], ["i32"])` (`imports.ts:640-645`)
   - `funcRecord("string.concat", "wasm:js-string", "concat", ["externref","externref"], ["ref_extern"])` (`:628`)
   - `funcRecord("string.eq", "wasm:js-string", "equals", ["externref","externref"], ["i32"])`
   - `funcRecord("string.len", "wasm:js-string", "length", ["externref"], ["i32"])`
   - `globalRecord("string.const", "string_constants", { scheme: "literal" }, "externref", false)` (matches `addStringConstantGlobal`, `imports.ts:179-183`: `{kind:"global", type:externref, mutable:false}`)
   - `globalRecord("string.const.utf16", "string_constants16", { scheme: "literal-utf16-hex" }, "externref", false)`
   Each row's ABI is pinned against the registration site it names
   (`addStringImports` `imports.ts:627-664`; `addStringConstantGlobal`
   `:179-183`/`:224-228`) — a catalogue-level equality, no emission.
3. **Validator grows kind arms**: key list per kind (`func`: today's six ±
   `exceptionPolicy`; `global`: `capability, field, kind, module, mutable,
   valueType`); module membership checked against the arm's union (a
   runtime twin of the type — "unknown host capability module/kind" is a
   pinnable message, distinct from the equality rejections); `global` arm
   compares `field.scheme`, `valueType` (via `assertValueTypes`), `mutable`;
   `exceptionPolicy` is func-only.
4. **Fail-closed kind guards** at every func-assuming consumer (list above):
   `kind !== "func"` ⇒ throw naming the capability ("not a callable host
   capability"). Prefer the type-level narrowing for `host-callable`
   (`capability: Extract<…, func ids>`) so a global id in a provider row is a
   compile error; keep the runtime check in `#indexProviders` (`:1484-1509`)
   as the twin. `asAsyncHostAdapter` gets the guard BEFORE `:94`;
   `AsyncHostAdapter` (`:83`) retargets to the func arm.
5. **Nothing else moves**: no `IrIntrinsicProvider` global arm
   (`nodes.ts:856-860` — a global capability attaches as an `IrGlobalRef` on
   `IrInstrStringConst.storage`, a later slice's concern), no policy field
   (the `tests/issue-4104…:432-445` whole-shape pin does not move), no
   provider row, `integration.ts:6284` / `:7142` keep reading
   `ctx.nativeStrings` (pin that they do — the F1-S4 grep-gate idiom, so a
   reviewer cannot mistake this slice for the move).

### Required pre-implementation probes (answers go in the checkpoint note)

- **P1 — un-requested ids**: grep `scripts/` and `src/` for any gate
  asserting "every capability id is requested by some provider" (none found
  in `runtime-manifest.ts`; `scripts/` unverified). If one exists, name it
  and decide: exempt the family-2 rows explicitly or sequence the first
  provider row (F2-S3) into this PR — do NOT silently weaken the gate.
- **P2 — `ref_extern` reach**: confirm the widened value type cannot leak
  into `lowerAdapterType` (`ir-async-runtime-adapters.ts:19-21`, typed on
  the narrow async union) and that `assertValueTypes` accepts it only where
  a row declares it.
- **P3 — key-order canonicalization**: the `semanticView` helper
  (`tests/issue-3526-ir-runtime-manifest.test.ts:88-97`) serializes
  `hostCapabilityRecords` verbatim — verify the reversed-catalogue
  canonicalization pin (`:440-452` idiom) stays byte-equal with the new
  rows present, i.e. sorting is by id and the new rows land in a stable
  position.
- **P4 — F2-S3 handoff**: record the exact split of the eq arm out of
  `integration.ts:6277-6296` and the `stringEq` policy shape (`{eq: "host" |
  "native" | "unsupported"}`, projected `nativeStrings ? native : host`) as
  the next slice's starting point — no code for it in this PR.

### Verification matrix

- **V-A byte cells**: the F2-S1 six fixtures (`STRCMP`, `STRCMP4`,
  `STRMIX`, `FOROFSTR`, `BOTH`, `CLEAN`) **plus a literal-heavy `CONST`
  fixture** (so the `string_constants`/`string_constants16` global path is in
  the matrix) × five lanes (gc-host, gc-native-strings, standalone, WASI,
  linear), before/after on the same tree: byte length, sha256, import set
  AND order, full WAT, error list, `irOutcomes` — **100 % identical**; any
  delta is a defect.
- **V-B schema pins** (new `tests/issue-3526-string-boundary-schema.test.ts`,
  the F1/F2 per-slice anatomy, header stating the slice moves no boundary):
  each new row resolves via `resolveRuntimeHostCapabilityRecord` to the exact
  literal (whole-shape `toEqual`) and is canonical (`toContain` identity
  `:282-284` idiom); reversed-catalogue canonicalization byte-equal; async
  projection excludes the new ids and `asAsyncHostAdapter` throws on a global
  record; a Math-only / async-only / compare-only manifest's
  `hostCapabilityRecords` is free of the new rows; validator rejections for
  `env`+`global`, `wasm:js-string`+`global`, `string_constants`+`func`, wrong
  `mutable`, wrong `valueType`, wrong scheme, unknown module, unknown kind;
  every func-assuming consumer throws (not misbehaves) on a global id.
- **V-C exhaustiveness lives in `src/`**: `tsconfig` excludes `tests/`, so
  `@ts-expect-error` in a test is unenforced — closedness is enforced by the
  `as const`-tuple unions and factory parameter types under `pnpm run
  typecheck` (the `quality` gate), with the runtime membership check as the
  vitest-pinnable twin.
- **V-D revert non-vacuity**: reverting the widening fails exactly the new
  file's pins and **0 tests elsewhere** — record that count as the measured
  baseline (the probes' Exp 1/2 showed a no-pin revert fails 0 tests, which
  is why the slice's own pins are its only observability).
- **V-E** the five ratchet gates chained bare AND under
  `LOC_GATE_BASE=$(git rev-parse origin/main)`; `runtime-manifest.ts` is
  already over the 1500-line god-file threshold (1670), so any growth needs
  the dated `loc-budget-allow` rationale block (the `:123-140` template; all
  four likely-touched paths already carry grants at `:78-80`, `:94`);
  controls run unchanged: `issue-2955-depolymorph-gate`,
  `issue-3502-string-contract`, `issue-3518-string-repeat-ir`, `issue-3167`,
  `issue-1183`, `issue-4550-linear-ir-census` (baseline byte-pin), both
  async suites, all #3526 suites, `#3520` callable-provider-abi.

### After this slice (ranked, from the boundary probe)

| rank | boundary | why |
| --- | --- | --- |
| **F2-S3** | `string.eq` | one import, one native symbol (`__str_equals`), no mode sub-arm, ABI in the existing union (only the module axis is new); resolve arm = F2-S1's shape verbatim; demand = `string.eq` instr scan; policy `stringEq` |
| F2-S4 | `string.len` | host arm trivial; native struct-field arm needs manifest provider vocabulary |
| F2-S5 | `string.concat` | `owned-append` sub-arm, `__concat_N` late-import sibling, `string-builder-candidate` census bucket |
| later | `charCodeAt` | `host-capability` two-record provider behind a defined helper (`char-code-at-helpers.ts:173-224`) |
| later | `string.const` | global kind, derived field, two namespaces, oversized materializer, legacy pre-pass ordering |

Out of scope here: every resolve-table arm (`integration.ts:6186-6347`),
`stringMethodPlan`, `String()` coercion, `src/ir/from-ast.ts`, the
`host-import-policy.ts:283-286` classifier (retire once records are typed),
and `import-manifest.ts:337`'s `env`-only walk.

---

## 2026-09-01 F2-S2 checkpoint note — Opus lane

**Branch** `claude/issue-3526-f2s2-schema-widening`, grounded on `origin/main`
`dc29e1f1` (the merged F2-S1, PR #5433), slice claim `3526:f2s2`. Implemented
from the 2026-09-01 F2-S2 plan. **The slice moves no boundary**: not one
resolve arm, provider row, policy field or emitted import changed, and the
35-cell byte matrix below is 100 % identical.

### Probe answers

**P1 — un-requested ids: NO such gate exists, in `scripts/` OR `src/`. Nothing
was weakened, and nothing had to be sequenced forward.** Measured, not assumed:
the full reference set of the capability catalogue is eleven files
(`grep -rn "RUNTIME_HOST_CAPABILITY_IDS\|RUNTIME_HOST_CAPABILITY_RECORDS\|isRuntimeHostCapabilityId\|hostCapabilityRecords" src/ scripts/ tests/`),
and **`scripts/` contributes zero** — no gate reads the catalogue at all. The
one completeness demand in the codebase is
`canonicalizeRuntimeHostCapabilityCatalog` (`runtime-host-capabilities.ts`),
and it is **ids ↔ rows, not ids ↔ providers**: it fails when a catalogue omits
a declared id, never when a declared id goes un-requested. The frozen
manifest's `hostCapabilityRecords` is built the other way round — from the
capabilities that SELECTED providers request (`runtime-manifest.ts`
`#buildManifest`) — so an un-requested row is structurally invisible to
`freeze()`. That is exactly why this slice is byte-neutral by construction and
not by luck, and it is now pinned rather than argued: the new suite asserts
that no provider row names any of the six ids, and that Math-only, async-only
and compare-only manifests carry none of them.

**P2 — `ref_extern` cannot reach `lowerAdapterType`, on two independent
barriers.** `lowerAdapterType` (`src/codegen/ir-async-runtime-adapters.ts:19`)
is typed on `AsyncHostAdapterValueType`, which stays the narrowed
`"externref" | "i32"` — the F1-S1 note about `f64` applies verbatim to
`ref_extern`. The only route into an `AsyncHostAdapter` is
`asAsyncHostAdapter`, whose value-type loop rejects anything outside that pair
by name. Separately, `assertValueTypes` admits a value type only when it BOTH
equals the expected entry positionally and is a member of
`RUNTIME_HOST_CAPABILITY_VALUE_TYPES`, so `ref_extern` is accepted only where
a row declares it — today that is `string.concat`'s result and nothing else,
which the suite pins as an exhaustive scan of the catalogue rather than a
spot-check.

**P3 — key-order canonicalization holds; the sort is by id and the new rows
land in a stable position.** `compareCapabilityRecords` sorts on the capability
string, so the six ids interleave deterministically:
`number.unbox` < `string.char_code_at` < `string.compare` < `string.concat` <
`string.const` < `string.const.utf16` < `string.eq` < `string.len`. Pinned two
ways: `canonicalizeRuntimeHostCapabilityCatalog` of the **reversed** catalogue
is `JSON.stringify`-equal to the forward one AND element-identical by object
reference; and the sorted id list is asserted verbatim at 18 entries. The
`semanticView` helper (`tests/issue-3526-ir-runtime-manifest.test.ts`) is
unaffected for a different and stronger reason than ordering — it serializes
`manifest.hostCapabilityRecords`, which contains only requested capabilities,
and no new row is ever requested. That suite passes unchanged.

**P4 — F2-S3 handoff, recorded exactly.** The eq arm is **not** a standalone
arm today: `integration.ts:6279-6296` is a THREE-symbol branch
(`IR_STRING_CONCAT_FN || IR_STRING_CONCAT_OWNED_FN || IR_STRING_EQUALS_FN`)
whose single `if (ctx.nativeStrings)` picks between
`nativeStrHelperHandle(ctx, "__str_concat" | "__str_concat_owned" | "__str_equals")`
and `exactCallableImportIndex(ctx, "wasm:js-string", "concat" | "equals")`.
F2-S3's first move is therefore a SPLIT, not a rewrite: lift
`symbol === IR_STRING_EQUALS_FN` into its own `else if` above the concat pair,
leaving the two concat symbols on the untouched lane read, then migrate only
the lifted arm. The policy shape is F2-S1's verbatim:
`StringEqPolicy = { eq: "host" | "native" | "unsupported" }`, projected
`ctx.nativeStrings ? "native" : "host"` (the exact former truth table), two
provider rows (`host.js.string.eq` → `host-callable` on capability
`string.eq`, whose record this slice already provides; `native.js.string.eq` →
`runtime-callable` on `__str_equals`), demand from a `string.eq` instruction
scan, and `STRING_EQ_POLICY_DISABLED` passed explicitly by the linear and
self-hosted-stdlib adapters. No code for any of that is in this PR.

### What landed

- **`src/ir/runtime-host-capabilities.ts`** (+239 net, the whole slice) — the
  id union split into `RUNTIME_HOST_CAPABILITY_FUNC_IDS` (16) and
  `RUNTIME_HOST_CAPABILITY_GLOBAL_IDS` (2) with `RUNTIME_HOST_CAPABILITY_IDS`
  as their sorted merge; closed per-kind module unions
  (`env | wasm:js-string` for func, `string_constants | string_constants16`
  for global), a closed kind tuple and a closed field-scheme tuple, each with
  its runtime `Set` twin; `RuntimeHostCapabilityValueType` grown by
  `ref_extern`; `RuntimeHostCapabilityFuncRecord` /
  `RuntimeHostCapabilityGlobalRecord` and their union;
  `funcRecord` / `globalRecord` factories with `record()` retained as the
  `env`-defaulting alias so the twelve existing rows are literally unchanged;
  the six new rows; a per-kind validator (`assertGlobalCapabilityRecord` for
  the global arm) with kind/module/field-scheme membership checks; and the
  shared `asCallableRuntimeHostCapabilityRecord` guard plus
  `resolveRuntimeHostCapabilityFuncRecord`.
- **`src/ir/runtime-manifest.ts`** (+20) — `host-callable`'s `capability`
  narrowed from `RuntimeHostCapabilityId` to `RuntimeHostCapabilityFuncId`
  (the type-level `Extract` the plan asked for, spelled as the id half so it
  actually narrows), and its runtime twin in `#indexProviders`.
- **`src/ir/intrinsic-support.ts`** (+3) — `ADMITTED_CALLABLE_TARGETS`,
  `providerAttachment`, `preparedGeneratorNumberBoxProvider` and
  `preparedStringCompareProvider` all routed through
  `resolveRuntimeHostCapabilityFuncRecord`. The file now contains no
  unguarded `resolveRuntimeHostCapabilityRecord(` call, which the suite
  ratchets.
- **`src/ir/async-runtime-providers.ts`** (+13) — `AsyncHostAdapter`
  retargeted to `RuntimeHostCapabilityFuncRecord<AsyncHostCapabilityId, …>`;
  `asAsyncHostAdapter` takes the kind guard immediately after the id filter
  and before the value-type walk.
- **`src/ir/async-plan.ts`** (+3) — see the divergence below.
- **`tests/issue-3526-string-boundary-schema.test.ts`** (new, 33 tests).

Nothing else was touched: no policy field, no provider row, no
`IrIntrinsicProvider` global arm, no resolve/attach/from-ast edit.

### One divergence from the plan (recorded, not widened)

**A sixth guard site the plan's enumeration missed: `async-plan.ts`'s
adapter-parity loop.** `assertPreparedIrAsyncRuntimeCurrent` filters
`manifest.hostCapabilityRecords` by the requested capability set and then
builds `irImportFuncRef(record.module, record.field, record.field)` from the
result — a func-assuming read on a value typed as the union. It is not in the
plan's list (which named `intrinsic-support.ts`, `async-runtime-providers.ts`
and `runtime-manifest.ts`), and leaving it out would have been a type error,
not a silent gap, so the omission was caught the moment the union landed. Fixed
in the plan's own idiom — `asCallableRuntimeHostCapabilityRecord(records[index]!)`,
identity-preserving so the `adapter.record !== record` comparison two lines
down is unaffected. `src/ir/async-plan.ts` is the one path added to
`loc-budget-allow`; at 1285 lines it is far under the god-file threshold.

Two things the plan allowed that were **not** needed: no `Extract<>` gymnastics
on the record type (declaring the id union in two halves narrows
`host-callable` directly and reads better), and no separate `AsyncHostAdapter`
compatibility shim (retargeting the alias to the func arm was a one-line
change that every downstream consumer already satisfied — `pnpm run typecheck`
is green with **zero** edits outside the five files above).

### V-A — measured neutrality: 35 of 35 cells identical

Seven fixtures (the F2-S1 six plus the plan's literal-heavy `CONST`) × five
lanes, compiled before and after **on the same tree** (the five source files
were snapshotted, reverted from `HEAD`, re-measured, and restored; the restored
files were `diff`-verified byte-equal to the snapshots). Each cell compares
byte length, binary sha256, the ORDERED import list, the **full emitted WAT
text**, the error list, the `irOutcomes` records and the string pool — deep
JSON equality, not a spot-check.

| fixture | gc-host | gc-native-strings | standalone | wasi | linear |
| --- | --- | --- | --- | --- | --- |
| `STRCMP` (`a < b`) | 157 ✓ | 22652 ✓ | 22816 ✓ | 22843 ✓ | 4876 ✓ |
| `STRCMP4` (all four operators) | 270 ✓ | 22540 ✓ | 22704 ✓ | 22731 ✓ | 4988 ✓ |
| `STRMIX` (compare beside concat/eq/len) | 338 ✓ | 22961 ✓ | 23125 ✓ | 23152 ✓ | 4982 ✓ |
| `FOROFSTR` | 1351 ✓ | 22669 ✓ | 49119 ✓ | 49146 ✓ | 4960 ✓ |
| `BOTH` | 1440 ✓ | 22924 ✓ | 49374 ✓ | 49401 ✓ | 4983 ✓ |
| `CLEAN` (control, no strings) | 113 ✓ | 21973 ✓ | 22588 ✓ | 22615 ✓ | 4874 ✓ |
| `CONST` (literals + `charCodeAt`) | 619 ✓ | 22855 ✓ | 23019 ✓ | 23046 ✓ | 6007 ✓ |

(The fixture SOURCES are this lane's reconstructions from the F2-S1
checkpoint's descriptions, not that slice's byte-identical files — three of the
gc-host numbers differ slightly from its table for that reason. It does not
weaken the measurement: parity is before/after on the same tree, and the six
descriptions are reproduced exactly.)

**The `CONST` fixture earns its place — it is the only cell that reaches the
global path at all.** Its gc-host module imports
`string_constants."" / "f" / "ab" / "abc" / "de" / "abcde" / …`,
`string_constants16."d800"` (the lone-surrogate route, #2880), and
`wasm:js-string.{length,charCodeAt}`; `STRMIX::gc-host` supplies
`wasm:js-string.{concat,equals}`. So every one of the six new rows has its
registration site inside the matrix. Note also that `result.imports` covers
only `env` FUNC descriptors — the `wasm:js-string` and `string_constants*`
imports appear **only** in the WAT — which is why the WAT text is compared in
full rather than the import array alone; an import-array-only matrix would
have been blind to exactly this slice's subject matter.

### V-B / V-C — the pins, and where exhaustiveness actually lives

33 tests in `tests/issue-3526-string-boundary-schema.test.ts`, in eight
sections: the kind-discriminated schema (disjoint/total id halves, closed
per-kind module namespaces, the `ref_extern` widening scanned exhaustively);
the six rows whole-shape plus canonical object identity; the ABI **measured**
against the registration site; the no-provider-selects-them argument; the
async projection; the validator's cross-kind rejections; the fail-closed
guards; and the boundary-did-not-move pins.

**The ABI section is a measurement, not a restatement.** Rather than
re-typing `addStringImports`'s literals, it compiles a host-lane module through
`generateModule(analyzeSource(...))` and compares each record against the type
the compiler actually registers — `module.types[import.desc.typeIdx].params /
.results` for the four `wasm:js-string` rows, and the full
`{kind:"global", type:{kind:"externref"}, mutable:false}` descriptor for both
global namespaces — including that `hexCodeUnits("\uD800") === "d800"` is the
field the `literal-utf16-hex` scheme actually produces and that a
surrogate-free literal never lands in `string_constants16`.

**V-C — exhaustiveness is enforced in `src/`, and that was verified by a
negative probe rather than asserted.** `tsconfig` excludes `tests/`, so a
`@ts-expect-error` in the suite would prove nothing. A temporary
`src/zz-f2s2-probe.ts` (deleted; it is not in the diff) asked
`pnpm run typecheck` for five illegal constructions and got five errors:
`.params` on the union (TS2339, naming the global arm),
`{kind:"host-callable", capability:"string.const"}` (TS2820),
`RuntimeHostCapabilityFuncModule = "string_constants"` and
`RuntimeHostCapabilityGlobalModule = "env"` (TS2322 each), and
`RuntimeHostCapabilityValueType = "i64"` (TS2322). The runtime membership
checks in the validator are the vitest-pinnable twins of those five.

### V-D — non-vacuity: 24 of 33, and 0 elsewhere

Reverting **only** the widening (all five source files back to `HEAD`, the new
suite kept) fails **24** of the new file's 33 tests and **0 tests anywhere
else** — the 17 control suites are 233/233 green on the reverted tree, and
266/266 (233 + 33) with the widening restored.

The **9** that still pass on the reverted tree are named rather than hidden,
because they are the honest ones:

- three **boundary-did-not-move** pins (`integration.ts` still reads
  `ctx.nativeStrings` at the concat/eq arm, at the `string.len` provider and in
  `storageForConst`). These are *supposed* to hold on both trees — they assert
  what this slice deliberately did NOT do, and they are the pins that will fire
  in F2-S3/S4 when the arms move. A pin that passes before and after is vacuous
  only if it was meant to detect the change; this one is meant to detect its
  absence.
- `hexCodeUnits`/emission derivation, "the twelve pre-existing rows are `env`
  func rows", the seven-row async projection, the reversed-catalogue
  canonicalization, "no provider names the six ids", and "Math/async/compare
  manifests are free of them" — all true of the 12-row catalogue too, by
  construction. They are the regression fence for the NEXT slice, which is the
  one that will add the first provider row.

### V-E — validation run

Green: `pnpm run typecheck` (TS7, the `quality` gate) — and the two
pre-existing `WebAssembly.Tag` TS5-lib errors in `src/linked-provider-runtime.ts`
are on `origin/main` too, untouched by this slice. The five ratchet gates, run
**bare** and again under `LOC_GATE_BASE` pinned to `origin/main`
(`dc29e1f1`): loc (+278 net src LOC; every grown path granted by this file's
frontmatter — `runtime-host-capabilities.ts` 264→503, `runtime-manifest.ts`
1670→1690 over the god-file threshold, `intrinsic-support.ts` 544→547), func,
coercion-sites, oracle-ratchet, dead-exports. Also green: `lint`,
`format:check`, `check:ir-dialect`, `check:ir-layering`, `check:ir-only`
(verdict READY), `check:linear-ir`, `check:host-import-policy`,
`check:test-vacuity-shapes`, `check:ir-kind-neutrality` (no evidence-line
drift this time — no cited line moved), and `check:ir-fallbacks` (bare;
unintended, module-level and post-claim buckets all still empty,
`string-builder-candidate` still 2).

Focused suites: **266 passing across 18 files** — all eight #3526 suites
including the new one, both async suites (#4103/#4104), #3520
callable-provider-abi, #2955, #3502, #3518 string-repeat-ir, #3167, #1183 and
#4550 linear-ir census. `scripts/*-baseline.json` is untouched.

### Not touched (per the plan's scope discipline)

Every resolve-table arm (`integration.ts:6186-6347`) including the eq/concat
one this slice's rows describe; `stringMethodPlan`; `String()` coercion;
`src/ir/from-ast.ts`; the `host-import-policy.ts` classifier;
`import-manifest.ts`'s `env`-only walk; the `IrIntrinsicProvider` global arm
(`nodes.ts:856-860`); and every existing policy — `numberBoundary`,
`booleanBoundary`, `externIsUndefined`, `generatorNumberBox`, `stringCompare`
— all unchanged. The whole-shape frozen-policy pin at
`tests/issue-4104-ir-async-plan-runtime-consumer.test.ts:432-445` did **not**
move, which is the mechanical signature of a slice that adds no policy field.

## 2026-09-02 F2-S3 implementation plan — string.eq under manifest policy (family 2, slice 3)

Grounded on `origin/main` `351f2bfc6b` (= merged F2-S2, PR #5440). Slice
claim: `#3526:f2s3` (`ttraenkler/fable-ir-takeover`). Three probe lanes
(resolve arm + registration / BEFORE-half byte matrix / test surface) ran
against that commit; every line number below is theirs. The F2-S2 checkpoint's
P4 handoff (`:3786-3802`) is the starting point and is confirmed by
measurement.

### What moves and what does not

- **The arm is a THREE-symbol branch today**: `integration.ts:6280-6296`
  serves `IR_STRING_CONCAT_FN || IR_STRING_CONCAT_OWNED_FN ||
  IR_STRING_EQUALS_FN` with one raw `ctx.nativeStrings` read (`:6284`) and one
  symbol→spelling ternary per lane (`:6286-6291` native helpers, `:6294`
  host field). **First move is a SPLIT, not a rewrite**: lift
  `symbol === IR_STRING_EQUALS_FN` into its own `else if` directly after the
  F2-S1 compare arm (`:6256-6279`), above the concat pair; the two concat
  symbols keep their lane read and raw lookup (`else if` order across
  disjoint symbols is byte-inert). Then migrate only the lifted arm.
- **Host arm = `exactCallableImportIndex(ctx, arm.module, arm.field)`, NOT
  `ctx.funcMap.get`.** `wasm:js-string.equals` is registered by
  `addStringImports` (`registry/imports.ts:609-700`) as the third of a fixed
  five-import block (`concat, length, equals, substring, charCodeAt`,
  `:628-663`), by a base-phase caller (legacy collector pre-pass
  `import-collector.ts:1668/2142/2157/2175`, or the IR pre-pass
  `prepareStrings` `:7099-7101` — `instrUsesStrings` already includes
  `string.eq` at `:7232`), never alone and always ahead of Phase 3. It IS in
  `funcMap` but under the bare field `"equals"`, subject to #1072 user-function
  shadowing — which is exactly why the arm has never used `funcMap`.
  `exactCallableImportIndex` (`:6362-6370`) derives the index from
  import-section position, mints nothing, and is shift-immune. So
  `preparedStringEqProvider` returns `{arm:"host", module: record.module,
  field: record.field}` (a deliberate deviation from F2-S1's `{arm, field}`
  shape and from its source pin `toContain("ctx.funcMap.get(arm.field)")`).
  No attached-target recognition is needed (F1-S4's
  `attachedExternIsUndefinedArm` exists because from-ast deleted the raw call;
  here from-ast is untouched and the `string.eq` instr still triggers
  `addStringImports`).
- **Native arm** = `runtime-callable` on `__str_equals`
  (`native-strings-basics.ts:433-449`, minted via `ensureNativeStringHelpers`
  `native-strings.ts:94-140`, resolved by `nativeStrHelperHandle`
  `func-space.ts:126-133` as a #3909 stable handle). Physical ABI
  `(ref $str, ref $str) -> i32`; semantic signature
  `EXTERNREF_PAIR_TO_I32_INTRINSIC_SIGNATURE` (`intrinsics.ts:287-291`) — the
  same relationship F2-S1's `__str_compare` row has. Reuse it; no new
  signature.
- **Untouched**: from-ast (`:13178-13183`, `:11410` — lane-free, #2955 gate
  scoped to from-ast stays green), `string-support.ts` attach (`:57-77`,
  `:132-148` — unconditional, binding kind stays `intrinsic`), `lower.ts:2275`,
  `wasmgc-emitter.ts:91-96` (`i32.eqz` on negate), `nodes.ts`, `builder.ts`,
  `runtime-host-capabilities.ts` (row exists `:303`, func id `:67`),
  `registry/imports.ts`, `import-collector.ts`, `legality.ts:274` (`string.eq`
  allowed on linear), `linear-integration.ts:1620-1622` (resolves `__str_eq`
  ignoring the provider — the disabled policy there is inert, as for compare).
- **The emitter no-provider fallback `integration.ts:6718-6727`** (the second
  `ctx.nativeStrings` read in `emitStringEquals`, backed by
  `computeStringBackend` `:5163-5188`): measured **0 reaches** across all 55
  BEFORE cells; attach is unconditional on every healthy owner (`:7195-7210`)
  but conditional on `ctx.programAbiTypes` (`:7137-7138`), and
  `prepared-component-dependencies.ts:636-642` fails any component whose
  `string.eq` lacks a provider before lowering. Probe P1 decides
  retire-vs-pin by measurement (temporary throw over the full matrix), NOT by
  argument from F2-S1's sub-B (whose linear half was itself corrected).

### Contract (F2-S1's 10-point edit list, with the eq-specific deltas)

1. `StringEqPolicy { eq: "host" | "native" | "unsupported" }` +
   `STRING_EQ_POLICY_DISABLED` beside `runtime-manifest.ts:184-196`; optional
   field on `RuntimeManifestPolicy` beside `:221-225`, required on
   `FrozenRuntimeManifestPolicy` beside `:229-235`; constructor default +
   refreeze beside `:1257`/`:1264`.
2. Feature `js.string.eq` (`:326-327`, union `:66-70`); provider ids
   `host.js.string.eq` / `native.js.string.eq` (`:330-336`); rows beside
   `:741-756` — host `{kind:"host-callable", capability:"string.eq"}` with
   `hostCapabilities:["string.eq"]` (type-checks: `string.eq` is a func id),
   native `{kind:"runtime-callable", symbol:"__str_equals"}`; both with
   `EXTERNREF_PAIR_TO_I32_INTRINSIC_SIGNATURE`; `stringEqProviderId` beside
   `:760-763`; feature-set predicate beside `:765-769`; splice into
   `RUNTIME_PROVIDERS` `:1021-1029`; `#selectProvider` branch beside
   `:1621-1636` throwing `provider-target-unavailable` naming `stringEq`.
3. `integrationStringEqPolicy(ctx) = { eq: ctx.nativeStrings ? "native" :
   "host" }` beside `integration.ts:889-891` — the exact former truth table
   of `:6284`; policy literal beside `:976`; owner-local partition twin of
   `:3696-3710`; demand `irStringEqDemand` beside `:902-919` — a plain
   `instr.kind === "string.eq"` scan over blocks + `asyncPlan.states`
   (simpler than compare's call scan); `stringEqDemand:` beside `:983`;
   `intrinsic-support.ts` input field beside `:390-398`, the "freeze nothing"
   guard `:431` (`&& !input.stringEqDemand`), `requestFeature` beside `:440`,
   feature const beside `:286`; `preparedStringEqProvider` beside `:301-320`
   using `resolveRuntimeHostCapabilityFuncRecord` and returning
   `{arm:"host", module, field}` / `{arm:"native", symbol}`.
4. The resolve arm: split as above, then the lifted eq arm reads
   `preparedStringEqProvider(prepared)`, throws `selection-preparation-mismatch`
   when absent, native → `ensureNativeStringHelpers(ctx); nativeStrHelperHandle(ctx, arm.symbol)`,
   host → `exactCallableImportIndex(ctx, arm.module, arm.field)`. The arm body
   runs once per module per symbol (registry-cached by
   `irCallableBindingKey`); the per-instr count equals the attach count.
5. Adapters: `stringEq: STRING_EQ_POLICY_DISABLED` in
   `backend/linear-integration.ts:680` and `codegen/stdlib-selfhost.ts:507`
   (+ import lists `:140` / `:75`).
6. No edit to `plan.invocation`, no from-ast edit, no new import
   registration anywhere (contract: import set AND order on every lane
   unchanged by construction; the matrix confirms rather than establishes).

### Required pre-implementation probes (answers go in the checkpoint note)

- **P1 — emitter fallback `:6718-6727`**: temporary throw + the full 55-cell
  matrix + the affected suites; 0 reaches ⇒ retire it fail-closed (F2-S1
  sub-B shape, with the "refuses to lower an unattached string.eq" pin);
  any reach ⇒ keep and pin it explicitly as not-moved, naming the lane.
- **P2 — the import-pruning pass**: at arm time `exactCallableImportIndex`
  returns 2 (`EQ`/`NEQ`/`TPLEQ`) or 3 (`EQMIX`/`STRMIX`) while the emitted
  module has `equals` at #0/#1/#3 — unused string imports are dropped before
  emission and the registry's locator (`program-abi-provider-planning.ts:299-300`)
  keeps the final index right. The probe could not name the pruning pass;
  name it, and state why the migrated arm (same lookup, same locator) is
  unaffected.
- **P3 — pins that move**, all measured: (a)
  `tests/issue-4104-ir-async-plan-runtime-consumer.test.ts:432-443` gains
  `stringEq: { eq: "unsupported" }` (the only whole-shape pin;
  `issue-3526-ir-runtime-manifest.test.ts` has no policy analog;
  `compare.test.ts:252-262` asserts fields individually — extend to six); (b)
  `tests/issue-3526-string-boundary-schema.test.ts:356-363` "no provider
  names any of the six capabilities" FIRES once `host.js.string.eq` names
  `string.eq` — narrow `NEW_IDS` (`:75-84`) for that pin to the five still
  un-provided ids (F2-S2 called this "the regression fence for the NEXT
  slice"); (c) `schema.test.ts:627-638` "keeps the concat/eq resolve arm on
  ctx.nativeStrings and the raw import lookup" — keyed on the three-symbol
  marker and `exactCallableImportIndex(ctx, "wasm:js-string", field)`: after
  the split the concat arm has no `field` variable, so re-spell to
  `"concat"` and retitle concat-only; the eq half INVERTS into the new suite;
  (d) `scripts/ir-kind-neutrality-baseline.json:287` cites
  `integration.ts:6327` (`forof.string`) — inserting the eq arm above shifts
  it: the sanctioned one-line citation refresh (normalize-and-diff both JSON
  documents; never commit the regenerator's 500-line output).
- **P4 — pre-existing red controls on the grounding sha, NOT this slice's**:
  `tests/issue-320.test.ts` "no dead imports (no-op)" (WAT now carries
  `string_constants."add"` module-init globals) and three `issue-3529-*`
  pins (#4512 `!ref` ToBoolean; array-literal widening `<module-init>` row).
  Confirm they are red on base BEFORE your first edit and leave them; file
  or cite an issue for them, do not fix here.

### Verification matrix

- **V-A byte cells — 55/55 identical to the BEFORE record.** The BEFORE
  half is preserved: `scratchpad/f2s3-matrix-before.{mts,json,md}` + 55 full
  WAT texts under `wat/` + the 6-site instrumentation patch
  (`.instrument.py/.diff`). Fixtures (sources verbatim in the JSON): `EQ`,
  `NEQ`, `EQMIX`, `FOROFEQ`, `TPLEQ`, `CLEAN`, `STRCMP`, `STRCMP4`, `STRMIX`,
  `FOROFSTR`, `BOTH` × gc-host / gc-native-strings / standalone / wasi /
  linear: bytes, sha256, WAT sha256, ordered import list WITH func/global
  indices (parsed from the binary import section — `result.imports` covers
  only `env` func descriptors and is blind to this seam), errors,
  `irOutcomes`. Includes reproducing `FOROFEQ::gc-host`'s pre-existing
  build-stage demote (`operand-coercion-unsupported`, 1513 B, `270e2a6a…`)
  byte-identically — it is the host `stringForOfPlan() === "iter-host"`
  binding the loop variable as externref, not the eq seam.
- **V-B reach**: re-apply the instrumentation on the AFTER tree — host 5 /
  native 18 / linear 4 eq resolutions, fallback 0, `resolve-entry`
  fresh+cached per cell as before; runtime oracle for `===`/`!==` on
  ≥7 input pairs across lanes via instantiation.
- **V-C import-order pin** on the host lane via the module import section
  or WAT (`tests/strings.test.ts:69` route) — an `result.imports`-only pin
  is blind to `wasm:js-string`.
- **V-D fail-closed**: `provider-target-unavailable` naming `stringEq` at
  the manifest unit level; the production projection is total (`nativeStrings
  ? native : host`), the linear lane admits `string.eq` and ignores the
  provider, so the `unsupported` arm is unreachable on every lane —
  **divergence-4 class EMPTY** (all `string.eq` producers are guarded before
  emission at `from-ast.ts:13162-13173` / `:11388-11402`; #3529 pins stay at
  `build`). Record integration-level reachability as a limit (F1-S2 style)
  unless a policy-injection seam exists (none does).
- **V-E revert non-vacuity**: revert only the arm → exactly the new
  source-shape pins fail (`stringEqArmSource` marker
  `symbol === IR_STRING_EQUALS_FN) {`, host assertion
  `exactCallableImportIndex(ctx, arm.module, arm.field)`); revert only the
  fallback retirement (if P1 retires it) → exactly its pin fails.
- **V-F**: five ratchet gates chained bare AND under `LOC_GATE_BASE`;
  `runtime-manifest.ts` (1690 lines, over threshold) needs the dated
  `loc-budget-allow` rationale; `check:ir-fallbacks` diffed (no bucket
  moves); controls: `issue-2955-depolymorph-gate`,
  `issue-3520-callable-preregistration` (`equals` NOT imported on native
  lanes), `strings`, `host-string-prefix-suffix-fast-path`,
  `issue-3521-prepared-component-dependencies:1017-1029` (attach binding
  kind), all #3526 suites, both async suites.

New suite: `tests/issue-3526-string-boundary-eq.test.ts`, anatomy from the
compare suite (contract `:166-216`, policy `:218-296`, end-to-end
`:298-337`, demote `:339-358` — but see V-D, the linear trick does not carry
because `string.eq` is linear-admitted — source-shape arm pins `:361-409`).

### Out of scope

`string.concat` / `_OWNED` (stay on the lane read — F2-S5, with `__concat_N`
and the `string-builder-candidate` bucket), `string.len` (F2-S4; native
struct-field arm needs provider vocabulary), `charCodeAt` (two-record
`host-capability` provider behind a defined helper), `string.const` (global
kind), `stringForOfPlan` (`:5970-5972` — the FOROFEQ host demote is its
business, not this slice's), `TPLEQ`'s `env.__concat_3` late import, the
`:6718-6727` twin reads in the other string emitters.

### 2026-09-02 F2-S3 checkpoint note — Opus lane

**Branch** `claude/issue-3526-f2s3-string-eq`, grounded on `origin/main`
`0f801557` (which carries no `src/`, `scripts/` or `tests/` delta against the
plan's grounding `351f2bfc` — verified, so the preserved BEFORE record is valid
on this base). Slice claim `3526:f2s3`. Implemented from the 2026-09-02 F2-S3
plan. All four probe answers were measured on the grounded tree BEFORE any
source edit.

#### Probe answers

**P1 — the emitter no-provider fallback is RETIRED, on a measurement, not an
argument.** A temporary `throw` replaced the two fallback branches of the WasmGC
`emitStringEquals` adapter (`integration.ts`) and the whole probe was re-run:

- **0 reaches across all 55 byte cells** — and the matrix stayed **byte-identical
  to the BEFORE record with the throw in place**, which is a stronger statement
  than "no cell crashed": nothing in any of the 55 modules depended on the
  branch, not even indirectly through a demote.
- **0 reaches across 22 string suites / 337 passing tests** (`strings`,
  `native-strings` ×3, `issue-2742-native-string-equality`,
  `issue-2063-switch-strict-equality`, `issue-2191-case-equals`, the two #4208
  equality suites, `loose-equality`, `issue-3167`, `issue-1183`, the two #3502
  suites, `issue-3518-string-repeat-ir`, `imported-string-constants`,
  `for-of-string-generator`, `issue-2880`, `issue-1470-standalone-string-imports`,
  `host-string-prefix-suffix-fast-path`, both #3526 string suites).

So it is retired fail-closed, with the "refuses to lower an unattached
`string.eq`" pin plus a source-shape pin. **The plan's argument for why it was
dead is correct but is NOT what licensed the removal** — `attachIrStringSupport`
does attach the provider unconditionally for `string.eq` and `prepareStrings`
runs that pass over every healthy owner, but F2-S1's sub-B taught that the
second half of such an argument can be wrong in a way the first half hides. The
throw is the evidence.

**One honest scope note on the retirement's pins.** The behavioural pin
("refuses to lower an unattached `string.eq`") holds on BOTH trees and is
deliberately not the non-vacuity signal: a hand-built resolver carries no string
runtime, so `WasmGcEmitter.emitStringEquals` refuses one frame earlier with its
own `string.eq runtime is unavailable` and the retired branch is never reached.
The suite says so in place rather than hiding it behind an alternation regex.
The discriminator is the source-shape pin, and V-E measures it: reverting only
the retirement fails exactly that one test.

**P2 — the pruning pass is `eliminateDeadImports`
(`src/codegen/dead-elimination.ts`), and the migrated arm is unaffected because
it changes neither the lookup nor the locator.** It is called from
`eliminateDeadLayoutAndPlanProgramAbi` (`src/codegen/program-abi-finalization.ts`)
at the `finalize/dead-layout` / `eliminate-dead-layout` phase of
`src/codegen/index.ts` — i.e. **after** IR resolve. The sequence the probe saw
but could not name is therefore:

1. `addStringImports` (`codegen/registry/imports.ts`) registers all five
   `wasm:js-string` builtins as one block, so at arm time `equals` sits at func
   position 2 (`EQ`/`NEQ`/`TPLEQ`) or 3 (`EQMIX`/`STRMIX` — `env.string_compare`
   precedes the block).
2. `exactCallableImportIndex` returns that position, and
   `ProgramAbi…observe()` immediately converts it into a `ProviderLocator` that
   holds the **`Import` object itself** (`callableLocatorAt` →
   `{kind:"import-function", value: imported}`).
3. `eliminateDeadImports` compacts the section, dropping the four unused
   builtins; `currentCallableIndex` re-derives the index **by object identity**,
   which is why the emitted module has `equals` at #0/#1/#3 and the call is still
   right.

The migration keeps step 2's call site character-for-character (`registry?.observe(ref, index)`)
and only changes where the module/field strings come from, so the locator sees
the same object. Confirmed rather than argued: `EQ::gc-host` resolves at arm-time
index **2** and emits `wasm:js-string.equals` at **#0**, identically before and
after.

**P3 — the pin moves, all measured.**

- `tests/issue-4104-ir-async-plan-runtime-consumer.test.ts` — the whole-shape
  frozen-policy equality gains `stringEq: { eq: "unsupported" }`. The
  precedented mechanical consequence, and the only whole-shape pin;
  `issue-3526-ir-runtime-manifest.test.ts` carries no policy analog and did not
  move.
- `tests/issue-3526-string-boundary-schema.test.ts` "no provider names any of
  the six capabilities" — **fired, exactly as F2-S2 predicted it would.** Its id
  list is narrowed to the **five still-unprovided** ids (a derived
  `STILL_UNPROVIDED_IDS`, so the six-row list stays single-sourced) and the pin
  now also asserts positively that `string.eq` **is** named. Shrinking the fence
  by the id that landed is the correct edit; deleting it would have thrown away
  the regression fence for F2-S4/S5.
- `tests/issue-3526-string-boundary-schema.test.ts` "keeps the concat/eq resolve
  arm on `ctx.nativeStrings`" — re-scoped to **concat only** and retitled. The
  `field` variable went with the eq half, so the assertion is re-spelled
  `exactCallableImportIndex(ctx, "wasm:js-string", "concat")`, plus a new
  `not.toContain("IR_STRING_EQUALS_FN")` so the pin actively witnesses the split.
  The eq half is INVERTED into the new suite.
- `tests/issue-3526-string-boundary-compare.test.ts` — its
  defaults pin is extended from five policies to six. It asserts fields
  individually, so it did not *have* to move; it is only worth having if it keeps
  pace with its own sibling.
- `scripts/ir-kind-neutrality-baseline.json` — the sanctioned citation refresh,
  handled as the five prior checkpoints prescribe. **TWO evidence lines moved,
  not the plan's one**: `forof.string` `src/ir/integration.ts` 6327 → 6410 (the
  eq arm inserted above it) and `string.len`
  `src/ir/backend/linear-integration.ts` 1626 → 1628 (the two-line adapter
  edit). Established by normalising both JSON documents to sorted leaf paths and
  diffing those: **448 leaves each, exactly 3 changed** — those two evidence
  arrays and the `generated` date. No verdict, kind, placement, ratchet count or
  `settledBy` rationale moved. Patched surgically; committing the regenerator's
  output would have been a **356-line** diff for a 3-line change.

**P4 — pre-existing red controls, measured on the grounding tree BEFORE the first
edit. There are 17 failing tests across 5 files, not the plan's four.** Left
untouched; none is this slice's.

| file | failing | what |
| --- | --- | --- |
| `tests/issue-320.test.ts` | 1 | "handles programs with no dead imports (no-op)" — the WAT now carries `string_constants."add"` module-init globals |
| `tests/imported-string-constants.test.ts` | 4 | same class: global-import counts (`5` vs `3`, `2` vs `0`) and two end-to-end reads |
| `tests/issue-3529-equivalence-error-imports.test.ts` | 8 | the whole Error-family constructor set |
| `tests/issue-3529-dataflow-outcomes.test.ts` | 2 | unary `!` ToBoolean (#4512) |
| `tests/issue-3529-ir-producer-parity.test.ts` | 2 | boolean identity across an externref console boundary; array-literal widening |

The four the plan named are in there; the other 13 are not, and the
`imported-string-constants` four were confirmed red on a **clean** base after an
instrumented run made them look like new failures. Worth stating because that is
exactly how a real regression gets waved through: the plan's list read as
complete, and a longer list of "known reds" is only safe if it was measured
rather than inherited. Cited here for a follow-up issue; not fixed in this slice.

#### What landed

- **`src/ir/runtime-manifest.ts`** (+113) — `StringEqPolicy`
  (`eq: "host" | "native" | "unsupported"`), a frozen `STRING_EQ_POLICY_DISABLED`,
  the optional `stringEq` field canonicalized at builder construction and
  published resolved on the frozen manifest, the `js.string.eq` feature row, the
  two provider rows (`host.…` → `host-callable` on capability `string.eq`;
  `native.…` → `runtime-callable` on `__str_equals`, both on the existing
  `EXTERNREF_PAIR_TO_I32_INTRINSIC_SIGNATURE` — no new signature), and the
  `#selectProvider` branch whose unavailable arm is a typed
  `provider-target-unavailable` naming the feature and `string-eq policy eq=…`.
- **`src/ir/intrinsic-support.ts`** (+58) — the `stringEqDemand` input (and its
  place in the "freeze nothing at all" guard) plus `preparedStringEqProvider`.
- **`src/ir/integration.ts`** (+85) — the **split** of the three-symbol
  concat/eq arm, the migrated eq half, `integrationStringEqPolicy`,
  `irStringEqDemand`, the owner-local `unsupported` partition in the same pass as
  the five existing ones, the freeze-time policy + demand arguments, and the
  retired `emitStringEquals` fallback.
- **`src/ir/backend/linear-integration.ts`**, **`src/codegen/stdlib-selfhost.ts`**
  — both pass `STRING_EQ_POLICY_DISABLED` explicitly (+2 each).
- **`tests/issue-3526-string-boundary-eq.test.ts`** (new, 24 tests).

`src/ir/from-ast.ts`, `src/ir/string-support.ts`, `src/ir/lower.ts`,
`src/ir/nodes.ts`, `src/ir/builder.ts`, `src/ir/backend/wasmgc-emitter.ts`,
`src/ir/backend/legality.ts`, `src/ir/runtime-host-capabilities.ts` and
`src/codegen/registry/imports.ts` needed **no edit** — the front-end was already
lane-free, the `string.eq` record landed in F2-S2, and no registration moves.

#### The split is the load-bearing first move, and it is byte-inert

The arm served three symbols (`__ir_string_concat`, `__ir_string_concat_owned`,
`__ir_string_equals`) behind one `ctx.nativeStrings` read and two symbol→spelling
ternaries. `string.eq` is lifted into its own `else if` **above** the concat pair
and only the lifted arm is migrated. The lift cannot change behaviour because the
three symbols are pairwise disjoint: `else if` order decides which branch a symbol
takes only when two conditions can both hold. The concat pair keeps its lane read
and its raw lookup, which the re-scoped F2-S2 pin still holds.

#### The one structural difference from F2-S1, and why F2-S2 had to land first

`preparedStringEqProvider` returns `{arm:"host", module, field}` where the
compare's twin returns `{arm:"host", field}`, and the consumer is
`exactCallableImportIndex(ctx, arm.module, arm.field)` rather than
`ctx.funcMap.get(arm.field)`. That is not a stylistic deviation:

- `env.string_compare` is an `env` base import and `funcMap` names it
  unambiguously.
- `wasm:js-string.equals` is a **builtin**. `addStringImports` records it in
  `funcMap` under the **bare field `equals`**, which a user function named
  `equals` shadows (#1072) — which is why the arm has never used `funcMap` and
  does not start now. Locating it by import-section position needs both halves of
  the name, and the module half only became expressible as a capability record in
  F2-S2.

The new suite pins the module half explicitly, and the arm's source-shape gate
asserts `not.toContain("funcMap")` so a future edit cannot quietly "simplify" it
into the shadowable lookup.

#### V-A — measured neutrality: 55 of 55 cells identical

Eleven fixtures (`EQ`, `NEQ`, `EQMIX`, `FOROFEQ`, `TPLEQ`, `CLEAN`, plus F2-S1's
`STRCMP`, `STRCMP4`, `STRMIX`, `FOROFSTR`, `BOTH`) × five lanes (gc-host,
gc-native-strings, standalone, WASI, linear). Each cell compares byte length,
binary sha256, WAT sha256, the **full emitted WAT text**, the **ordered import
list with func/global indices parsed from the binary import section**, the error
list and the `irOutcomes` records — deep equality, not a spot-check.

The BEFORE half is the preserved record from the plan's probe lane. **It was
re-run on this branch's own base before the first edit and reproduced all 55
cells exactly**, so the comparison below is against a base this lane measured,
not one it inherited. The AFTER half was then run twice: once on the
implementation tree, and once more on the exact tree being committed (after
`prettier` reformatted `runtime-manifest.ts`). Both are 55/55.

| fixture | gc-host | gc-native-strings | standalone | wasi | linear |
| --- | --- | --- | --- | --- | --- |
| `EQ` (`a === b`) | 148 ✓ | 22424 ✓ | 22588 ✓ | 22615 ✓ | 4873 ✓ |
| `NEQ` (`a !== b`) | 153 ✓ | 22664 ✓ | 22828 ✓ | 22855 ✓ | 4876 ✓ |
| `EQMIX` (eq beside compare) | 247 ✓ | 22944 ✓ | 23108 ✓ | 23135 ✓ | 4933 ✓ |
| `FOROFEQ` (eq inside a string for-of) | 1513 ✓ | 22944 ✓ | 49394 ✓ | 49421 ✓ | 5016 ✓ |
| `TPLEQ` (template literal `===` literal) | 240 ✓ | 22743 ✓ | 23523 ✓ | 22934 ✓ | 4972 ✓ |
| `CLEAN` (control, no strings) | 119 ✓ | 21977 ✓ | 22592 ✓ | 22619 ✓ | 4878 ✓ |
| `STRCMP` | 157 ✓ | 22652 ✓ | 22816 ✓ | 22843 ✓ | 4876 ✓ |
| `STRCMP4` | 270 ✓ | 22540 ✓ | 22704 ✓ | 22731 ✓ | 4988 ✓ |
| `STRMIX` | 360 ✓ | 22982 ✓ | 23146 ✓ | 23173 ✓ | 5022 ✓ |
| `FOROFSTR` | 1351 ✓ | 22669 ✓ | 49119 ✓ | 49146 ✓ | 4960 ✓ |
| `BOTH` | 1440 ✓ | 22924 ✓ | 49374 ✓ | 49401 ✓ | 4983 ✓ |

**`FOROFEQ::gc-host` reproduces its pre-existing demote byte-identically**
(`countX`, `operand-coercion-unsupported`@build, 1513 B, `270e2a6a…`). That demote
is `stringForOfPlan()` returning `"iter-host"` and binding the loop variable as
externref — the host for-of's business, not the eq seam's — and the cell is in the
matrix precisely so a slice that "fixed" it by accident would be caught.

**Imports and order.** Identical in all 55 cells, including the func/global
INDICES. The measurement parses the binary import section directly because
`result.imports` covers only `env` func descriptors and is **blind** to
`wasm:js-string` and `string_constants` — an import-array-only matrix could not
have seen this slice's subject matter at all. The new suite's order pin
(V-C) reads the emitted module's import section for the same reason.

#### V-B — the migrated arm is REACHED, and the retired one is not

With the six-site instrumentation re-applied on the AFTER tree, the 55-cell run
resolves the eq arm **23** times: **5 host** (`EQ`, `NEQ`, `EQMIX`, `TPLEQ`,
`STRMIX` on gc-host) and **18 native** (six fixtures × three native-strings
lanes). The linear lane emits `__str_eq` through its own resolver **4** times
(`EQ`, `NEQ`, `EQMIX`, `STRMIX`). `emitStringEquals` takes the provider path
**23** times and the fallback **0**. Every one of those counts, and the per-cell
`resolve-entry` fresh/cached sequences, are **identical to the BEFORE run** — the
per-cell probe tables `diff` clean.

**Runtime oracle.** `===`, `!==` and `=== "x"` are checked against JavaScript on
**seven** input pairs (`a/b`, `a/a`, `""/""`, `""/a`, `x/x`, `ab/abc`, `Z/z`)
through an instantiated host-lane module, and the same source is compiled and
validated on a native-strings lane and on linear.

#### V-D — fail-closed, and the divergence-4 class is EMPTY

The refusal is pinned at the **manifest unit level**: freezing an eq demand under
`STRING_EQ_POLICY_DISABLED` throws `provider-target-unavailable` with
`js.string.eq is unavailable under string-eq policy eq=unsupported`.

**Integration-level reachability is recorded as a LIMIT, not claimed as a test
(the F1-S2 shape).** The production projection is total (`nativeStrings ? native
: host`), so no lane resolves `unsupported`; and unlike F2-S1's compare, **the
linear demote trick does not carry** — `string.eq` IS on the linear instruction
allowlist (`backend/legality.ts`), so that lane lowers it through its own
resolver and ignores the frozen provider entirely. Its explicitly disabled
`stringEq` policy is therefore **inert**, stated only so the frozen policy is
total and no adapter inherits a host decision by omission. The suite pins that
inertness behaviourally (a linear module with `a === b` beside a clean co-owner
compiles and runs), which is what makes the claim falsifiable. No owner changes
demote site anywhere in the matrix — the `irOutcomes` records are byte-compared
in all 55 cells — so the divergence-4 class is EMPTY for this slice, as an
assertion rather than an omission.

#### V-E — non-vacuity, each sub-slice reverted independently

- **sub-A**, reverting ONLY the resolve arm to the three-symbol lane read:
  **5 tests fail** — the four new source-shape pins ("consults the prepared
  string-eq provider", "reads NO lane discriminator", "fails closed rather than
  falling back to a locally decided symbol", "is its OWN branch") **plus** the
  re-scoped F2-S2 concat pin, which correctly refuses an un-split arm. All 217
  other tests in that run stay green, including every byte, import-order,
  runtime-oracle, schema and policy assertion.
  **Those pins are deliberately SOURCE-shape assertions, for the reason F2-S1
  recorded and this slice re-confirms:** the policy projection reproduces the old
  truth table exactly, so both forms emit identical bytes on every lane — which
  is the point of the slice and why all 55 cells are unchanged. What moved is
  WHICH authority answers, and on this seam that is only observable in source.
- **sub-B**, restoring the emitter fallback: exactly **1** test fails — "keeps
  the retired fallback's lane read out of the emitter" — while the attachment
  pin, the already-attached-provider pin, the refusal pin and all 179 other tests
  stay green.

#### Divergences from the plan (recorded, not widened)

1. **The kind-neutrality refresh is TWO citation lines, not one.** The plan
   anticipated only `integration.ts:6327`; the two-line adapter edit also moved
   `linear-integration.ts:1626 → 1628`. Normalise-and-diff isolates exactly
   those two plus the `generated` date.
2. **P4's pre-existing-red list was incomplete: 17 tests across 5 files, not 4.**
   Named above.
3. **The retirement's behavioural pin cannot discriminate**, because
   `WasmGcEmitter` refuses one frame earlier on a hand-built resolver. Disclosed
   in the suite rather than papered over; the source-shape pin is the
   discriminator and V-E measures it at exactly 1.
4. **`preparedStringEqProvider` returns the record's MODULE as well as its
   field**, and the host arm uses `exactCallableImportIndex`, not
   `ctx.funcMap.get`. This is the plan's own instruction; it is recorded here
   because it is a deliberate divergence from F2-S1's shape AND from that
   slice's committed source pin, and a reader comparing the two arms should not
   read it as drift.

#### Validation run

Green: `pnpm run typecheck` (TS7, the `quality` gate); the five ratchet gates run
**bare** and again under `LOC_GATE_BASE` pinned to `origin/main` (`0f801557`) —
loc (+260 net src LOC, every grown path granted by this file's frontmatter;
`runtime-manifest.ts` 1690 → 1803, over the god-file threshold, with the dated
rationale), func, coercion-sites, oracle-ratchet, dead-exports. Also green:
`lint`, `prettier --check` on every touched path, `check:ir-dialect`,
`check:ir-layering`, `check:ir-only` (verdict READY), `check:linear-ir`,
`check:host-import-policy`, `check:test-vacuity-shapes`,
`check:ir-kind-neutrality` (after the surgical refresh), and
`check:ir-fallbacks` — **diffed against a base-tree run of the same command,
output byte-identical**; unintended, module-level and post-claim buckets all
still empty, `string-builder-candidate` still 2.
`scripts/linear-ir-baseline.json` and `scripts/ir-fallback-baseline.json` are
untouched.

Focused suites: **416 passing across 25 files** — all nine #3526 suites
(including the new one), both async suites (#4103/#4104), #3520
callable-provider-abi and callable-preregistration, #3521 prepared-component
dependencies, #2955, #3502, #3518 string-repeat-ir, #3167, #1183, #4550
linear-ir census, `strings`, `native-strings` ×2,
`host-string-prefix-suffix-fast-path`, and the three equality suites this seam
serves.

#### Not touched (per the plan's scope discipline)

`string.concat` / `_OWNED` (F2-S5 — still on the lane read, still pinned),
`string.len` (F2-S4), `charCodeAt`, `string.const`, `stringMethodPlan`,
`String()` coercion, `stringForOfPlan` / `charReadPlan`, `TPLEQ`'s
`env.__concat_3` late import, the twin no-provider reads in the OTHER string
emitters (`emitStringConcat`, `emitStringLen` — each belongs to its own slice),
`src/ir/from-ast.ts`, and every existing policy — `numberBoundary`,
`booleanBoundary`, `externIsUndefined`, `generatorNumberBox`, `stringCompare` —
all unchanged.

## 2026-09-02 F2-S6 implementation plan — batched many-arity string concat under manifest policy (family 2, slice 6)

Written by the Fable planning lane against the verified census grounded at
`origin/main` `a07f65319f` (F2-S4 merged as PR #5460). `origin/main` has since
moved to `5f13a35bc6` (#5464/#5465 test-rot rewrites, npm-compat refreshes):
**no `src/` delta** against the grounding, so every `src/` line below holds on
both — but `scripts/loc-budget-baseline.json` moved 40 lines in that window
(plus six test files: `imported-string-constants`, `issue-320`, `issue-3517-*`,
`issue-3529-*`), so the LOC ceilings the lane is measured against are NOT the
grounding's (see V-D). In flight: **F2-S5 (`string.concat` pair arm) on
`claude/issue-3526-f2s5-string-concat`**, tip `6d6425c8e3` (one squash commit
+ a main merge) — **PR #5467, open and auto-parked 2026-09-02 07:48 UTC on
collateral from #5224 (diagnosis in the PR thread); confirm it has merged
before enqueueing**. It adds
`StringConcatPolicy` (branch `runtime-manifest.ts:273`),
`integrationStringConcatPolicy` (branch `integration.ts:1012-1014`,
`nativeStrings ? native : host`), `irStringConcatDemand` (`:1029`),
`preparedStringConcatProvider` (branch `intrinsic-support.ts:433`), the
partition block (`:3954`), and
`tests/issue-3526-string-boundary-concat.test.ts` whose "leaves the BATCHED
many-arity family byte-identical — the F2-S6 fence" test (branch `:464-492`)
is this slice's front-line fence. **Every `integration.ts` line below moves
again when F2-S5 lands** — observed at `6d6425c8e3` (not census-verified): the
batch selection `:3678` → `:3732` (+54), the two arms `:6360/:6369` →
`:6435/:6444` (+75), the freeze call `:3918` → `:3993`,
`preregisterCallableProviders` `:7084` → `:7178`. Content anchors govern: the
batch selection is the `const hostBatchedConcat = !ctx.nativeStrings && …`
pair; the arms are the two `ref.binding.kind === "intrinsic"` branches keyed
on `IR_ASYNC_STRING_CONCAT_5_FN` and `parseIrStringConcatManyArity(symbol) !==
null`; the policy/demand functions go beside `integrationStringConcatPolicy` /
`irStringConcatDemand`; the partition block beside
`stringConcatPolicy.concat === "unsupported"`.

**Sequencing (predecessor stacking).** F2-S6 reuses F2-S5's `stringConcat`
policy as its provider selector, so branch from
`origin/claude/issue-3526-f2s5-string-concat`, re-merge it whenever it changes,
and **enqueue only after F2-S5 merges** — a real wait, not a formality. F2-S7
(`charCodeAt`) can stack on F2-S5 the same way (policy field +
`#selectProvider` branch + partition block — mechanical adjacency, not a
dependency). F2-S8 (`string.const`) is last and hardest.

Census artifacts (originals under the planning session's scratchpad
`/tmp/claude-0/-home-user-js2/28d6498f-fc64-5f6d-952c-7075f472bc2f/scratchpad/`,
verified present 2026-09-02; **durable copies under `probes/f2s6/`,
`probes/f2s7/` and `probes/f2s8/` on branch `claude/probe-artifacts-2026-09-02`,
`.txt` suffix, never merged — fetch that branch from another container**): `census-f2s6-batched-concat.md` (its `## verdict`
`wrongSites`/`corrections` override the body); `f2s6/f2s6-matrix.mts` (driver:
14 fixtures CAT/CAT3/CAT4/CAT5/CAT8/CAT9/TPL3/TPL6/TPLEQ/LITRUN/MULTIUSE/
CATNUM3/ASYNC/EVALFN × 6 lanes incl. `gc-strict`; the wasi edge cell is NOT in
it — the census measured that by a separate probe); `f2s6/f2s6-instrument.py`
(reach counters — **known defect**: `ctx.mod.funcs.length` throws, fix to
`ctx.mod.functions`; it carries no shift-ref/shift-map patch);
`f2s6/f2s6-shift.mts` (the shift re-run driver over CAT3/TPLEQ/CATNUM3/ASYNC —
the verdict's shift figures come from it plus a re-created patch, "results then
match", so they ARE reproducible once the patch is re-created);
`f2s6/f2s6-policy.mts` (walks `scripts/check-host-import-policy.ts`'s
`const probes = {` on both gate lanes and counts `env.__concat_*`);
`f2s6/matrix.{md,json,out}` (the 84-cell BEFORE record). Siblings for the
ranking table: `f2-cca-matrix.mts`, `f2-cca-instrument.py`,
`f2-cca-matrix-before.{md,json}`, `f2-cca-probe-strict.mts`,
`f2-cca-pin-clean.out`, `f2-cca-pins-instrumented.out` + `census-charcodeat.md`;
`census-string-const-matrix.{mts,md,json}`, `census-string-const-instrument.py`,
`census-string-const-probe{,2,3}.mts`, `census-string-const-run.out` +
`census-string-const.md`.

### What moves and what does not (census, 84 cells)

The seam is the **batched** many-arity family: the `batchStringConcat` pass
(`src/ir/passes/batch-string-concat.ts:77`) fuses any single-use immutable
`string.concat` tree of ≥3 leaves (`:21` predicate, `:198` arity cap, `:199`
3-leaf floor) into one `call` on the free-form intrinsic symbol
`string.concat$arityN` (`:266`; `src/ir/string-runtime.ts:44/67-70/74`),
lowered to `env.__concat_N` (host, late-minted) or `__str_concat_N` (native,
3..8, `src/codegen/native-batched-concat.ts:20-21`, `ensureNativeBatchedConcat`
`:37`, `mintDefinedFunc` `:65`). A second symbol, `async.string.concat$arity5`
(`src/ir/async-semantic-runtime.ts:7`, produced at
`src/codegen/async-ir-planning.ts:849-850` behind `isPreparedIrAsyncConcat`
`:679`), has its own arm with the identical lowering.

| # | site | what it reads | fate |
| --- | --- | --- | --- |
| 1 | `src/ir/integration.ts:3678` `hostBatchedConcat` | `!nativeStrings && !standalone && !wasi && !strictNoHostImports` | **moves** — reads the frozen `stringConcatMany.batch` |
| 2 | `src/ir/integration.ts:3679` `standaloneBatchedConcat` | `nativeStrings && standalone && !wasi` | **moves** — same |
| 3 | `src/ir/integration.ts:3680-3684` pass call | literal `8` (a copy of `MAX_BATCHED_CONCAT_ARITY`) or ∞ | **moves** — cap derived from the provider row |
| 4 | `src/ir/integration.ts:6360-6368` async5 arm | `ctx.nativeStrings ? ensureNativeBatchedConcat(ctx, 5) : ensureLateImport("__concat_5")` | **moves** — reads `preparedStringConcatManyProvider(prepared, 5)`; symbol and condition kept |
| 5 | `src/ir/integration.ts:6369-6377` many-arity arm | same, per arity | **moves** — same helper |
| 6 | `src/codegen/string-ops.ts:1762` legacy native twin | `noJsHost(ctx)` (`js-errors.ts:29`) + `JS2WASM_NATIVE_BATCHED_CONCAT` | **stays outside** — demoted functions only |
| 7 | `src/codegen/string-ops.ts:1835-1862` `compileBatchedConcat` (+ folded-arity-2 `:2055-2058`) | no lane read; legacy host twin | **stays outside** |
| 8 | `src/codegen/expressions/eval-inline.ts:2372` | `new Function` body join → `__concat_${pieces}` | **stays outside**; 0 reaches in the matrix |
| 9 | `src/codegen/expressions/late-imports.ts:400` `ensureLateImport` (`:551/:554` shift open + `addImport`) | other names only; `__concat_N` falls through to raw `env` | unchanged; the host arm keeps calling it |
| 10 | `src/runtime.ts:11415`, `scripts/generate-size-benchmarks.ts:136` | prefix-matched JS providers | unchanged |
| 11 | `src/host-import-policy.ts:76` + `:151-152`, `src/compiler/import-manifest.ts:323` | classification: builtin fallthrough → `legacy-semantic / ecmascript-runtime` | unchanged (out of scope) |
| 12 | `src/ir/backend/linear-integration.ts`, `src/codegen/stdlib-selfhost.ts` policy blocks | — | gain `stringConcatMany: STRING_CONCAT_MANY_POLICY_DISABLED` |

Measured (14 fixtures × 6 lanes = 84 cells, compile-only — bytes, sha,
ordered import list, reach counts; no cell was executed; the wasi edge cell is
an 85th measurement outside `matrix.md`):

- **Only `gc-host` and `standalone` batch.** Flag tuples
  `(nativeStrings, standalone, wasi, strict)`: gc-host `(F,F,F,F)`→host;
  standalone `(T,T,F,F)`→native; gc-native-strings `(T,F,F,F)`, wasi
  `(T,F,T,T)`, gc-strict `(T,F,F,T)`→none; linear never enters the pass.
- **Host is unbounded, native caps at 8**: CAT3/4/5/8/9 → `env.__concat_N#0`;
  CAT9 standalone declines (`batch-cap 9>8`, 8 pairwise `__str_concat`). TPL3
  (6 leaves) → `_6`, TPL6 → `_7`.
- **Import position is the byte-identity lever, not funcidx shifting.** The
  `wasm:js-string` 5-import block (`src/codegen/registry/imports.ts:629`
  `addStringImports`) is registered pre-Phase-3, so the host arm mints
  `__concat_N` at import index 5 (`late-import new@imp5`), index 6 on CATNUM3
  after `number_toString`, index 97 on ASYNC inside an open batch (`__concat_5#21`
  of 27 after dead-import elimination). Those mints happen **inside the walk of
  `preregisterCallableProviders`** (`integration.ts:7084`; it calls the resolve
  arms via `resolveAndObserveCallableProvider` `:7118-7120` and seals with
  `flushLateImportShifts(ctx, null)` `:7130`) — `batchOpen=false` at every
  IR-arm registration except ASYNC. `flushLateImportShifts`
  (`late-imports.ts:686`) ran (+1@5; ASYNC +2@96) but moved **0 instruction refs
  and 0 funcMap entries** in all four measured host cells — every defined
  function is on a stable handle (`src/emit/resolve-layout.ts:80`
  `STABLE_FUNC_BASE = 1 << 21`). ASYNC gc-strict and gc-native-strings DO carry
  live-regime flushes (26 refs / 18 map; 75 map) but none is a `__concat_N`
  registration — **those lanes never mint it**; a flush AT a `__concat_N` site
  on a live-regime module remains unmeasured (census unmeasured #3).
- **`!ctx.wasi` in the host selector is LIVE**, not redundant: the edge cell
  `{target:"wasi", nativeStrings:false, strictNoHostImports:false}` compiles
  (CAT3: 1000 bytes, `wasm:js-string.concat`, pairwise) and only `!ctx.wasi`
  keeps the pass off there. The standalone selector's `!ctx.wasi` IS
  unreachable (`src/target-profile.ts:68-69` throws on wasi∧standalone).
- **The legacy twins batch where the IR pass does not.** CATNUM3
  (`operand-coercion-unsupported`) → gc-host `env.__concat_3#1` via
  `compileBatchedConcat`; standalone/wasi `__str_concat_3` via the native twin;
  ASYNC wasi → `__str_concat_5` ×2 (one mint, one cache hit) with the IR pass off.
- **`check:host-import-policy`** (bare, unpatched tree, exit 0): native-first
  imports **395/395**, compat legacy-semantic **23/23** — both AT ceiling.
  `__concat_*` in the ratcheted counts: **zero**; the only `__concat_` the gate
  ever produces is `env.__concat_3` on the compat `errors` probe, via the LEGACY
  twin, in an unratcheted inventory. Not re-run on a modified tree (probe P5).
- Cross-census check: CAT3 gc-host reproduces sha-for-sha (149/`4677a84a2dcd`
  in this census and in F2-S5's fence test). F2-S5's other fence cell, TPL
  (`${a}!`, 173/`a6702c76db07`), is not an F2-S6 fixture; no other cross-census
  sha claim is made.

**Conformance yield is zero by design.** Both authorities exist; the slice moves
WHICH authority the IR pass and its two arms consult. The 84-cell matrix (+ the
edge cell) must come back identical, batching cells included.

### Design — a pass policy, a family feature, and F2-S5's provider selector

Three facts force the shape. (1) **The pass creates the demand**, so it needs
a frozen decision of its own —
`StringConcatManyPolicy { readonly batch: "host" | "native" | "off" }`, projected
from the lane as the two predicates **verbatim** (`nativeStrings ? (standalone ?
"native" : "off") : (standalone || wasi || strictNoHostImports) ? "off" : "host"`)
— not the census's simplified form, because the wasi term is live. (2) **The two
resolve arms today read `ctx.nativeStrings` alone**, i.e. exactly F2-S5's
`stringConcat.concat`, independent of the pass — so the provider row for the
family feature is selected by **`this.#policy.stringConcat.concat`**, not by
`batch`. A cross-policy rule at canonicalization refuses `batch !== "off" &&
batch !== stringConcat.concat` (nearest existing `RuntimeManifestInvariantCode`
`:614`, F2-S4's precedent; do not grow the union). **It cannot fire from the
projections** — `integrationStringConcatPolicy` is `nativeStrings ? native :
host` and `batch` is `native` only under `nativeStrings`, `host` only under
`!nativeStrings` — so it guards hand-built policies only (one (b) pin); the
async5 argument in P4 rests on `stringConcat.concat` alone. Alternative — the
census's self-contained `{ batch, maxArity }` policy that also selects the row:
rejected, `maxArity` would be a third copy of the native cap, and it would
silently re-route the async5 arm on any lane where that producer fires with the
pass off. (3) **Demand is scanned AFTER the pass**, from the batched IR:
`irStringConcatManyDemand(fns)` returns the sorted unique arities of every
`call` whose target symbol parses via `parseIrStringConcatManyArity` or equals
`IR_ASYNC_STRING_CONCAT_5_FN`. A module with no fused root freezes **no** family
row (CAT, LITRUN, MULTIUSE on gc-host), matching F2-S5's "no row when nothing
concatenates". Alternative — request the feature whenever `batch !== "off"`:
rejected as vacuous manifests on every gc-host module. Pass and freeze already
sit in one function (`compileIrPathFunctions` `:1808`: pass `:3678-3684`,
freeze `:3918`); P2 confirms what the freeze input carries.

**Manifest vocabulary the slice adds (each tied to a measured fact):**

- **A func-family capability record**, new kind `"func-family"`, id
  `string.concat.many`, module `env`, `field: { scheme: "arity-suffix", prefix: "__concat_" }`,
  `params: { repeat: "externref", min: 3, max: null }`, `results: ["externref"]`.
  A separate record kind, not a widening of
  `RuntimeHostCapabilityFuncRecord.field: string` / `params: readonly Value[]`
  (`src/ir/runtime-host-capabilities.ts:171/:173`, exact-matched at `:393-397`):
  widening would make every `resolveRuntimeHostCapabilityFuncRecord` (`:498`)
  consumer handle a scheme it can never receive. **The id goes in a THIRD list
  `RUNTIME_HOST_CAPABILITY_FUNC_FAMILY_IDS` with its own
  `RuntimeHostCapabilityFuncFamilyId` type** — NOT in
  `RUNTIME_HOST_CAPABILITY_FUNC_IDS` (`:52`): putting it there would make
  `RuntimeHostCapabilityFuncId` (`:73`) admit it, so a plain `host-callable
  { capability: "string.concat.many" }` would type-check and be caught only by
  the runtime throw in `asCallableRuntimeHostCapabilityRecord` (`:453-460`) at
  `ADMITTED_CALLABLE_TARGETS` module init — exactly the typed-half hole F2-S2
  closed for globals (`runtime-manifest.ts:480-486`). With the third list,
  `host-callable-family.capability` is typed on the family half and
  `host-callable` cannot name it. `RUNTIME_HOST_CAPABILITY_IDS` becomes the
  sorted three-way union. A new
  `resolveRuntimeHostCapabilityFuncFamilyRecord(id, arity)` synthesizes the
  physical row `{ module, field: prefix + arity, params: repeat × arity, results }`;
  the plain resolver and `asCallableRuntimeHostCapabilityRecord` throw on a
  family id (the latter already does, `:456`). Scheme list: a new frozen
  `RUNTIME_HOST_CAPABILITY_FUNC_FAMILY_FIELD_SCHEMES` (the global-only list is
  `:147`); `RUNTIME_HOST_CAPABILITY_KINDS` (`:134`) gains `"func-family"`.
- **Two implementation kinds** on `RuntimeProviderImplementation`
  (`src/ir/runtime-manifest.ts:485/:493` are the one-capability / one-symbol
  arms): `host-callable-family { capability: RuntimeHostCapabilityFuncFamilyId }`
  and `runtime-callable-family { symbolPrefix: "__str_concat_", arity: { min: 3, max: 8 } }`.
  The native range lives **here once**; `native-batched-concat.ts:20-21` imports
  it (`codegen → ir/runtime-manifest` is the direction `stdlib-selfhost.ts`
  already uses) and the literal `8` at `integration.ts:3683` is deleted.
  Alternative — keep the constants in `native-batched-concat.ts` and pin equality
  by test: rejected (two copies plus a pin is the census's risk #5 verbatim).
  **Registration stays in the arms (late minting).** Today's mint IS the resolve
  arm executing inside `preregisterCallableProviders`' walk; nothing changes
  there. What must hold is that no consumer maps a family row or record to a
  concrete import earlier: `ADMITTED_CALLABLE_TARGETS`
  (`intrinsic-support.ts:77-100`) already skips any kind that is not
  `host-callable`/`runtime-callable` (`:81` positive check — pin it, no edit);
  `IntrinsicRuntimeProviderImplementation` (`runtime-manifest.ts:528`, an
  `Extract`) must not admit the family kinds; the async attachment filter
  (`intrinsic-support.ts:605-613`, `:653`; `async-plan.ts:442`;
  `async-runtime-providers.ts:120`) selects by `isAsyncHostCapabilityId` and so
  never sees the record; `canonicalizeRuntimeHostCapabilityCatalog` (`:463`,
  called `runtime-manifest.ts:1661`) and `assertRuntimeHostCapabilityRecord`
  (`:359`) must accept a scheme-field record. Late minting is kept because bytes
  depend on import order (ASYNC `#21 of 27`); a freeze-time registration would
  move every batching cell by design and touch both at-ceiling ratchets.
- **No signature family — the census's option (b).** `string.concat$arityN` /
  `async.string.concat$arity5` are free-form symbols, not `IntrinsicId`s, and
  `IntrinsicSignature` is fixed-arity (`src/ir/intrinsics.ts:184`). The rows
  carry **no `signature`**; the record's params scheme plus the native row's
  arity range are the only shape statements, and the host arm derives its
  `ensureLateImport` params from the record, so the record IS the checked
  contract. Alternative (a), an `IntrinsicSignatureFamily` on both rows:
  rejected because `provider-signature-mismatch` (`runtime-manifest.ts:1627-1636`,
  `signatureEquals` `:1280`) fires only when `RUNTIME_FEATURE_SIGNATURES[feature]`
  (`:655`) exists — F2-S5 registered no entry for `js.string.concat` (grep on
  `6d6425c8e3`: none), so a family signature would be checked by nothing unless
  `RUNTIME_FEATURE_SIGNATURES`'s value type and `signatureEquals` were widened
  manifest-wide for one feature. The symbols stay outside `INTRINSIC_DEFINITIONS`.
- **Cap derivation**: `stringConcatManyArityCap(batch)` in `runtime-manifest.ts`
  reads the static rows — `"host"` → the family record's `params.max` (`null` →
  `Number.POSITIVE_INFINITY`), `"native"` → the native row's `arity.max` (8).
  `tests/ir/passes.test.ts:489` keeps its numeric third parameter and does not move.

What the slice governs after landing: the IR pass and the two IR resolve arms.
What it does NOT govern, stated so `batch: "off"` on wasi is read correctly:
the legacy twins (sites 6-8) still mint `__concat_N` / `__str_concat_N` on
demoted functions (CATNUM3 on every lane, ASYNC wasi ×2, the policy gate's
`errors` probe). The policy describes the IR pipeline, not the module.

### Contract

**A. `src/ir/runtime-manifest.ts`**

1. `StringConcatManyPolicy { readonly batch: "host" | "native" | "off" }`,
   frozen `STRING_CONCAT_MANY_POLICY_DISABLED = { batch: "off" }`, after F2-S5's
   `STRING_CONCAT_POLICY_DISABLED`; `RuntimeManifestPolicy.stringConcatMany?`,
   `FrozenRuntimeManifestPolicy.stringConcatMany`, canonicalization beside the
   `stringConcat ?? STRING_CONCAT_POLICY_DISABLED` line, plus the cross-policy
   rule (design fact 2).
2. The two family implementation kinds on the union (`:485-495` neighbourhood);
   validation rules beside the `carrier-field` triad: a `host-callable-family`
   names a `RuntimeHostCapabilityFuncFamilyId`; a `runtime-callable-family`
   requests no host capability, has `min ≥ 3`, `max ≥ min`, safe integers;
   `symbolPrefix` non-empty. Keep both kinds OUT of
   `IntrinsicRuntimeProviderImplementation` (`:528`).
3. `STRING_CONCAT_MANY_RUNTIME_FEATURES = ["js.string.concat.many"]`,
   `STRING_CONCAT_MANY_RUNTIME_PROVIDER_IDS = ["host.js.string.concat.many", "native.js.string.concat.many"]`;
   splice into `RuntimeFeature` (main `:68` neighbourhood), `RuntimeProviderId`
   (branch `:503-514`, one member per family), the `RUNTIME_FEATURES` /
   `RUNTIME_PROVIDER_IDS` arrays (branch `:1394/:1408`), `RUNTIME_PROVIDERS`.
   Rows: host → `host-callable-family` on `["string.concat.many"]`; native →
   `runtime-callable-family` with `[]`; neither carries `signature`; no
   `RUNTIME_FEATURE_SIGNATURES` entry (design bullet 3).
4. `stringConcatManyProviderId(policy)` keyed on `policy.stringConcat.concat`,
   `isStringConcatManyFeature`, a `#selectProvider` branch after F2-S5's
   `isStringConcatFeature` branch (branch `:2066-2068`), refusal text
   `` `runtime feature ${feature} is unavailable under string-concat policy concat=${…} (many-arity family)` ``.
5. `stringConcatManyArityCap(batch)` (design bullet 4), exported for
   `integration.ts` and `native-batched-concat.ts`.

**B. `src/ir/intrinsic-support.ts`** (nothing in `intrinsics.ts`)

6. `stringConcatManyDemand?: { readonly arities: readonly number[] }` on the
   prepare input (sibling of `stringConcatDemand`, branch `:561`), in the
   freeze-nothing conjunction (branch `:601-602`) and `requestFeature` when
   non-empty; `STRING_CONCAT_MANY_RUNTIME_FEATURE` beside branch `:408`.
7. `preparedStringConcatManyProvider(prepared, arity)` → `{ arm: "host"; module;
   field; params; results } | { arm: "native"; symbol } | undefined`, host via
   `resolveRuntimeHostCapabilityFuncFamilyRecord(capability, arity)`, native as
   `` `${symbolPrefix}${arity}` `` after checking `arity` against the row's range
   (out of range → throw `` `IR string-concat-many provider ${id} does not cover arity ${arity}` ``).
8. `ADMITTED_CALLABLE_TARGETS` (`:77-100`): no edit — `:81` already skips the
   family kinds; the (a) pin asserts it.

**C. `src/ir/integration.ts`** (content anchors; lines are main's)

9. `integrationStringConcatManyPolicy(ctx)` beside `integrationStringConcatPolicy`
   — the verbatim projection of `:3678-3679`. Wired into the freeze policy object
   (branch `:1106`) and computed in the partition loop beside
   `stringConcatPolicy` (branch `:3843`).
10. `irStringConcatManyDemand(fns)` beside `irStringConcatDemand`; passed as
    `stringConcatManyDemand` at the freeze input. Partition block beside F2-S5's
    (branch `:3954`): `stringConcatPolicy.concat === "unsupported"` and a
    non-empty many-arity demand → `late-preparation-unsupported`
    `"ir/integration: batched string concatenation has no provider under string-concat policy concat=…"`.
11. `:3678-3684` becomes: `const manyPolicy = integrationStringConcatManyPolicy(ctx);`
    `const batched = manyPolicy.batch === "off" ? hygienic : batchStringConcat(hygienic, allocRegistry, stringConcatManyArityCap(manyPolicy.batch));`
    — no `ctx.nativeStrings/standalone/wasi/strictNoHostImports`, no literal `8`.
12. The two arms (`:6360-6377`) keep their conditions and both routines; the
    decision becomes `const arm = preparedStringConcatManyProvider(prepared, arity)`
    (`arity = 5` in the async5 arm); `!arm` →
    `IrInvariantError("selection-preparation-mismatch", "resolve", "batched string concatenation has no frozen provider under the string-concat policy")`;
    native → `ensureNativeBatchedConcat(ctx, arity)` (unchanged); host →
    `ensureLateImport(ctx, arm.field, arm.params, arm.results, arm.module)` —
    the SAME call as today, now fed by the row. No `ctx.nativeStrings` in either
    arm. Symbols and producers untouched (alternative — fold
    `async.string.concat$arity5` into the `string.concat$arityN` family: a
    from-ast/async-planning refactor with its own census; deferred, see the table).
13. Not touched: `src/ir/passes/batch-string-concat.ts` (reads `maxArity` as
    before), `src/ir/string-runtime.ts`, `src/ir/async-semantic-runtime.ts`,
    `src/codegen/async-ir-planning.ts`, `preregisterCallableProviders`, sites
    6-11, `late-imports.ts`.

**D. Adapters.** `src/ir/backend/linear-integration.ts` and
`src/codegen/stdlib-selfhost.ts` (branch `:78` import, `:513` policy block)
gain `stringConcatMany: STRING_CONCAT_MANY_POLICY_DISABLED` beside the F2-S5
`stringConcat:` line. Neither passes a many-arity demand; the linear lane never
enters the pass (measured: no batch-decision event on any linear cell).
`src/codegen/native-batched-concat.ts:20-21` import the range from the native
row; `ensureNativeBatchedConcat`'s guard text unchanged.

**E. `src/ir/runtime-host-capabilities.ts`** — the `func-family` record kind on
`RuntimeHostCapabilityRecord` (`:191`); `RUNTIME_HOST_CAPABILITY_FUNC_FAMILY_IDS`
+ `RuntimeHostCapabilityFuncFamilyId` + `isRuntimeHostCapabilityFuncFamilyId`
(beside `:52/:73`); `RUNTIME_HOST_CAPABILITY_IDS` as the sorted three-way union;
`"func-family"` in `RUNTIME_HOST_CAPABILITY_KINDS` (`:134`); the scheme list;
the record in `RUNTIME_HOST_CAPABILITY_RECORDS` (`:255`); the
`assertRuntimeHostCapabilityRecord` arm (`:359`: scheme in list, non-empty
prefix, `min ≥ 3` — the measured floor at pass `:199`, `string-runtime.ts:67-70`
and `native-batched-concat.ts:20` — `max === null || max ≥ min`);
`canonicalizeRuntimeHostCapabilityCatalog` (`:463`) accepting the kind; the
family resolver; the plain resolver (`:498`) throwing on a family id.

**F. Tests.** New `tests/issue-3526-string-boundary-concat-many.test.ts`, anatomy
from F2-S5's concat suite:

- (a) contract — ONE feature, TWO family rows, NO signature on either and no
  `RUNTIME_FEATURE_SIGNATURES` entry; the host row names `string.concat.many`,
  `isRuntimeHostCapabilityFuncFamilyId` true / `isRuntimeHostCapabilityFuncId`
  false for it; the record is `func-family` with `arity-suffix` / `__concat_`,
  params `repeat externref min 3 max null`, result externref;
  `resolveRuntimeHostCapabilityFuncFamilyRecord("string.concat.many", 7)`
  yields `env.__concat_7` with 7 externref params; the plain resolver and
  `asCallableRuntimeHostCapabilityRecord` throw on the family id; the async
  projection excludes the rows; neither family row is an admitted callable
  target; the native row's range is `{3, 8}` and `MAX_BATCHED_CONCAT_ARITY`
  equals it by import, not by copy.
- (b) policy — `batch` projection table for all six lanes PLUS the edge cell
  `{target:"wasi", nativeStrings:false, strictNoHostImports:false}` → `off`
  (structural pin: no `__concat_`, `wasm:js-string.concat` present); the
  cross-policy rule refuses a hand-built `{batch:"host"}` with `{concat:"native"}`
  (its only pin — unreachable from projections); default closed and published;
  no row when nothing fuses (CAT, MULTIUSE); a fused module freezes exactly
  `["js.string.concat.many"]`; row selected by `stringConcat.concat`; refusal
  names `string-concat policy` and `many-arity`.
- (c) end-to-end — gc-host sha pins from `f2s6/matrix.md` (CAT3 149/`4677a84a2dcd`
  — **deliberately the same cell F2-S5's fence pins**, so a red is attributed to
  whichever slice landed last; CAT9 167/`c11957fc8004`, TPL6 235/`1d7f766908cf`,
  TPLEQ 246/`7e6dac42d3c7`; CATNUM3 199/`a4af808e0009` as the legacy-twin
  control) with ordered import lists (`env.__concat_3` / `wasm:js-string.equals,
  env.__concat_3` / `env.number_toString, env.__concat_3`); standalone pinned
  structurally (`$__str_concat_N` present; CAT9 stays 8× pairwise, no `_9` —
  F2-S5's checkpoint explains why standalone sha pins are a trap); ASYNC gc-host
  `__concat_5` ×2; a runtime oracle for 3-, 6- and 9-operand chains and a
  template on host and native-strings lanes (empty leaves, surrogate halves,
  non-ASCII BMP, a numeric-looking leaf).
- (d) source pins — batch selection contains `integrationStringConcatManyPolicy(`
  and `stringConcatManyArityCap(`, no `nativeStrings`/`standalone`/`wasi`/
  `strictNoHostImports`, no literal `8`; both arms contain
  `preparedStringConcatManyProvider(`, no `nativeStrings`; the host arm still
  contains `ensureLateImport(` (late minting is the contract, pin it); the
  partition block names `string-concat policy`.
- (e) fail-closed — an unfrozen family (prepared manifest without the feature)
  makes the arm throw `selection-preparation-mismatch`; a `runtime-callable-family`
  row asked for arity 9 throws the range error.
- (f) validation — a `host-callable` naming the family id is a type error
  (`// @ts-expect-error`) and a `host-callable-family` naming a plain func id
  throws; `runtime-callable-family` with a host capability throws
  `unknown-host-capability`; `min: 2` throws; a `func-family` record with an
  unknown scheme throws.

Existing pins that move, each a named edit, all in
`tests/issue-3526-string-boundary-schema.test.ts`: `:135-136` (FUNC∪GLOBAL
sorted-union identity → three-way union); `:137` `toHaveLength(18)` → 19;
`:138` sorted list gains `string.concat.many`; `:163`
`RUNTIME_HOST_CAPABILITY_KINDS` → `["func", "func-family", "global"]` (or the
order E chooses); `:173-186` two-way `kind` branch gains a `func-family` arm
(scheme in the family scheme list, module `env`, `params.repeat`). `:409` holds
by construction (`canonicalize…` sorts; `:407-408` prove order-independence)
once E's canonicalizer accepts the kind; **`:378` `STILL_UNPROVIDED_IDS` does
NOT move** (`NEW_IDS` `:75-82` is a fixed six-id list). Frozen-policy default
pins in the compare / eq / len / concat suites and the whole-shape pin in
`tests/issue-4104-ir-async-plan-runtime-consumer.test.ts:444` neighbourhood
(F2-S4 divergence 2: not in `issue-3526-ir-runtime-manifest`) gain
`stringConcatMany: { batch: "off" }`.
Fences that must NOT move: `tests/issue-958-concat-chain.test.ts:41/50/59`,
`tests/issue-3523-ir-calendar-retirement.test.ts:471-472`,
`tests/issue-3523-ir-algorithms-retirement.test.ts:347-349/432-433`,
`tests/issue-4124-ir-final-async.test.ts:750/760`,
`tests/issue-3522-ir-builtins-retirement.test.ts:395` (host arm and legacy twin
keep one spelling), `tests/issue-1470-standalone-string-imports.test.ts:21`
(`/^env::__concat_\d+$/`), `tests/issue-1342.test.ts:98`,
`tests/issue-4566-standalone-algorithms-module-init.test.ts:295-297/419-421`,
`tests/issue-4574-standalone-native-async-family.test.ts:444`,
`tests/native-batched-string-concat.test.ts:48/60` (legacy env kill-switch,
untouched), `tests/ir/passes.test.ts:489`, and F2-S5's "F2-S6 fence" test
(`tests/issue-3526-string-boundary-concat.test.ts:464-492` on the branch).

### Required pre-implementation probes (answers go in the checkpoint note)

- **P1 — the BEFORE byte matrix on the lane's own base** (F2-S5 tip merged
  with `origin/main`), uninstrumented, all 84 cells via `f2s6/f2s6-matrix.mts`
  **plus the wasi edge cell added to the driver** (85). Expected: identical to
  `f2s6/matrix.md` (F2-S5 is byte-neutral by its own 65/65 V-A); any
  difference is a finding about F2-S5, reported, not absorbed. For reach
  counts, fix the instrument's `ctx.mod.funcs` first and establish the
  instrumentation is byte-inert.
- **P2 — what the freeze input carries.** Pass and freeze are in one function
  (`compileIrPathFunctions` `:1808`; pass `:3678-3684` binds `fn: final`
  `:3684`; freeze `prepareBuiltFnRuntimeManifest(ctx, …, healthyForLower)`
  `:3918`, branch `:3993`, called once per compile). Confirm `healthyForLower`
  carries the batched `final` (so the post-pass demand scan sees every fused
  root), confirm the same holds for the `<module-init>` entry, and confirm no
  reader of the family symbols sits between pass and freeze. (The string.const
  census's "two passes per compile" is `prepareStrings` scan events, not
  manifest freezes.)
- **P3 — consumers of the widened types.** Enumerate every `switch`/`if` on
  `implementation.kind` (`ADMITTED_CALLABLE_TARGETS` `:81`;
  `IntrinsicRuntimeProviderImplementation` `runtime-manifest.ts:528`), every
  `hostCapabilityRecords` / `RUNTIME_HOST_CAPABILITY_RECORDS` consumer
  (`canonicalizeRuntimeHostCapabilityCatalog` `:463` ← `runtime-manifest.ts:1661`;
  `asCallableRuntimeHostCapabilityRecord` `:453-460`;
  `assertRuntimeHostCapabilityRecord` `:359`; async attachment
  `intrinsic-support.ts:605-613/:653`, `async-plan.ts:442`,
  `async-runtime-providers.ts:120`), and the #3520/#3521 suites. Expected: every
  one either skips the family kind by an existing positive check or is edited in
  E; **anything that maps a family row/record to a concrete import before the
  resolve arm is a STOP** until excluded. (`catalogProgramAbiCallableImports`,
  `program-abi-import-planning.ts:911`, catalogs ctx imports, not records —
  not a consumer.)
- **P4 — async5 off-lane.** Does `isPreparedIrAsyncConcat`
  (`async-ir-planning.ts:679`, behind the `:849-850` producer) consult the lane?
  Compile an async final-main that does not demote on gc-native-strings and on
  gc-strict. If the async5 ref can be minted with `batch === "off"`, today's arm
  resolves it via `nativeStrings` — row selection on `stringConcat.concat`
  reproduces that; record which lane. If it cannot, say so.
- **P5 — the two at-ceiling ratchets and the red baseline.** Run
  `check:host-import-policy` bare on the modified tree (expected: 395/395,
  23/23 unchanged — inferred by the census, never re-run) and measure the
  standing-red set on the base BEFORE editing: #5465 rewrote the 17 #5274 pins
  after the census, so the count is **unmeasured** here — do not copy 17.

### Verification matrix

- **V-A byte neutrality** — 84/84 `matrix.md` cells + the edge cell identical
  (bytes, sha256, ordered import list with indices, WAT text, demotions) against
  P1's record; corpus (`website/playground/examples/**`, `examples/**`) on both
  trees; `check:ir-fallbacks` diffed against a base-tree run (byte-identical
  output).
- **V-B pins** — the new suite in full; the moved schema/default pins; every
  fence above green; F2-S5's concat suite green unchanged.
- **V-C non-vacuity**, each revert independent against the kept schema. Counts
  are **unmeasured until run** — F2-S4 and F2-S5 both found the row revert
  larger than predicted; record the measured sets. Predicted: revert item 11
  only → the (d) batch-selection pins, bytes unchanged (the projection is
  verbatim); revert item 12 only → the (d) arm pins + the (e) unfrozen-family
  pin, bytes unchanged (the arms fall back to the same lane read — this is why
  (e) is load-bearing; the (a) range-import pin is unaffected); revert the two
  rows only → (a)/(b) and, because the arms now fail closed, every (c)
  end-to-end batching pin (the F2-S4 "frozen row is the only physical
  authority" behaviour); revert the cross-policy rule only → its one (b) pin;
  revert the range import in `native-batched-concat.ts` only → the (a) equality
  pin.
- **V-D gates** — the five ratchets bare AND under
  `LOC_GATE_BASE=$(git rev-parse origin/main)` (`check-loc-budget`,
  `check-func-budget`, `check-coercion-sites`, `check:oracle-ratchet`,
  `check:dead-exports`); `typecheck`, `lint`, `prettier --check`;
  `check:ir-dialect`, `check:ir-layering` (the `codegen → ir/runtime-manifest`
  import in `native-batched-concat.ts` must pass it), `check:ir-only`,
  `check:linear-ir`, `check:host-import-policy` (P5), `check:test-vacuity-shapes`,
  `check:ir-kind-neutrality` — evidence lines below the inserted functions move
  again (`forof.string` in `integration.ts`); refresh surgically by sorted-leaf
  diff, no verdict moves. `check:ir-fallbacks` diffed against base.
- **LOC** — **unmeasured**; by analogy to two measured slices (F2-S4 +381 with
  one new kind; F2-S5 +353 measured, against its own +170 estimate) expect
  roughly +400–500 net src LOC: two implementation kinds with validation, one
  record kind with resolvers and a third id list, one policy with a cross-policy
  rule, one demand scan, no signature family. The ceilings moved with
  `scripts/loc-budget-baseline.json` after the grounding (40 lines,
  `a07f65319f..5f13a35bc6`) and will move again when F2-S5 lands — measure
  against the lane's real `LOC_GATE_BASE`, not the census's. Grant every grown
  path in this file's frontmatter `loc-budget-allow` with a dated F2-S6
  rationale (new path: `src/codegen/native-batched-concat.ts` if it grows);
  **never edit `scripts/*-baseline.json` for LOC.** One PR, two commits (E
  first, then A-D/F) — a separate S6a record-only PR was considered and
  rejected: a record nothing reads gives V-C nothing to revert against.

### Out of scope

Sites 6-11 (the legacy twins incl. folded arity-2 `string-ops.ts:2055-2058`,
`eval-inline.ts:2372`, the JS providers, the `__concat_N` classification — a
typed intent changes 0 ratcheted counts and is a gate-policy change); unifying
`async.string.concat$arity5` into the family symbol; a signature family /
widening `RUNTIME_FEATURE_SIGNATURES`; `batch-string-concat.ts` internals
beyond the cap argument; the `operand-coercion-unsupported` demotions; wasi's
legacy-only batching; `__concat_2` corpus presence and corpus-wide arity counts
(unmeasured); registration timing of the host import; `charCodeAt`,
`string.const`, `stringMethodPlan`, `src/ir/from-ast.ts`.

### After this slice (ranked)

| rank | boundary | why / decision already taken |
| --- | --- | --- |
| **F2-S7** | `charCodeAt` | stacks on F2-S5 (policy field + `#selectProvider` branch + partition block); census `census-charcodeat.md` — two-record host row (`string.char_code_at`, `string.len`) behind a defined helper: reuse `runtime-callable` rows naming the helper symbol, not a new composed-callable kind (the helper is minted by `char-code-at-helpers.ts` either way; a kind would describe codegen, not authority) |
| **F2-S8** | `string.const` | last and hardest: `host-global` / `native-global` kinds, derived field, two namespaces, oversized materializer, legacy pre-pass minting is the ORDER authority (`census-string-const.md`) — the IR seam re-labels globals it finds, it does not mint them; say so in that plan |
| later | async5 symbol unification | producer refactor (`async-ir-planning.ts:849-850`, `async-semantic-runtime.ts:7`); byte-neutral in principle, touches #4124/#4574 |
| later | `__concat_N` typed intent | policy-gate spelling; 0 ratcheted-count change |
| later | signature family | only if `RUNTIME_FEATURE_SIGNATURES` is widened manifest-wide; otherwise unchecked by construction |

## 2026-09-02 F2-S7 implementation plan — charCodeAt under manifest policy (family 2, slice 7)

Written by the Fable planning lane from the verified census
(`census-charcodeat.md` — durable copy `probes/f2s7/census-charcodeat.md.txt`
on branch `claude/probe-artifacts-2026-09-02`, original in the planning
session's scratchpad; its `## verdict` corrections applied) measured at `origin/main` `a07f65319f`.
`origin/main` is now `5f13a35bc6`, ten commits on; `git diff --stat a07f65319f
origin/main` over every seam file (`src/ir/integration.ts`,
`src/ir/runtime-manifest.ts`, `src/ir/intrinsic-support.ts`,
`src/ir/intrinsics.ts`, `src/codegen/char-code-at-helpers.ts`,
`src/ir/backend/linear-integration.ts`, `src/codegen/stdlib-selfhost.ts`,
`src/ir/from-ast.ts`, `src/ir/string-support.ts`) is empty, so every `a07f`
line below holds on today's main. Two things are in flight and both move this
plan's anchors:

- **F2-S4 landed** (PR #5460, merge `985de5b65b`). The frozen row is the only
  physical authority for a seam with no resolve arm (F2-S4 checkpoint,
  divergence 5); this seam HAS a resolve arm (site 1), so that lesson applies
  only to the instr path (see V-C).
- **F2-S5 is PR #5467** on `origin/claude/issue-3526-f2s5-string-concat`
  (head `6d6425c8e3`, impl commit `b814a01a4c`; open, auto-parked 2026-09-02
  07:48 UTC on collateral from #5224 — diagnosis in the PR thread). `git diff --numstat a07f65319f
  b814a01a4c -- src/`: `integration.ts` 116/22 (+94 net), `runtime-manifest.ts`
  168/4 (+164), `intrinsic-support.ts` 66/1 (+65), `intrinsics.ts` 26/0 (+26),
  `linear-integration.ts` and `stdlib-selfhost.ts` +2 each — **+353 net**, the
  figure its own frontmatter grant records (`:225-226` on the branch). It does
  NOT yet contain today's `origin/main` tip. It touches no charCodeAt line, but
  **every `integration.ts` anchor below moves when it lands**. Both numberings
  are given where measured: `a07f` → F2-S5 head; content anchors are given
  where a line number alone would mislead.

**Sequencing.** Branch from `origin/claude/issue-3526-f2s5-string-concat`
(predecessor stacking, CLAUDE.md "known dependency"), merge `origin/main` into
it first, and **enqueue only after F2-S5 merges**; re-merge if F2-S5 changes.
F2-S6 (many-arity concat) stacks on F2-S5 too and adds the same three
mechanical things this slice adds (a policy field, a `#selectProvider` branch,
a partition block) plus the adapter lines and the schema fence — independent
in substance, adjacent in text; F2-S6 is ranked first, and whichever lands
second re-merges and re-anchors. F2-S8 (`string.const`) is last.

### What moves and what does not (census, 65 cells)

The seam is `s.charCodeAt(i)`. Two producers reach WasmGC codegen: the
**plan path** (`from-ast.ts:8673` `stringMethodPlan` → `:8792` an intrinsic
`call` whose SYMBOL already names the lane, `__jsstr_charCodeAt` or
`__str_charCodeAt`) and the **instr path** (`from-ast.ts:8661` a
`string.char_code_at` instruction, minted only with receiver-encoding
evidence — a literal receiver — carrying the semantic provider
`__ir_string_char_code_at` attached unconditionally by `string-support.ts:70/:137`).
Six physical symbols serve it (`char-code-at-helpers.ts:47-80`); this slice
governs the two GUARDED ones.

| # | site (`a07f` → F2-S5 head) | what it reads | fate |
| --- | --- | --- | --- |
| 1 | `integration.ts:6527` → `:6624`, resolve arm `IR_STRING_CHAR_CODE_AT_FN` | `ctx.nativeStrings ? ensureNativeCharCodeAtHelper(ctx) : ensureHostCharCodeAtGuarded(ctx)` | **THE R6-shaped decision** — reads the frozen `stringCharCodeAt` row (4/65 cells: OOB × gc-host, gc-native-strings, standalone, wasi) |
| 2 | `integration.ts:6417` → `:6492`, arm `JSSTR_CHARCODEAT_FN` | nothing — materializes the plan symbol via `ensureHostCharCodeAtGuarded` (7 cells) | keeps its materializer; **verifies** the symbol against the frozen row (fail-closed) |
| 3 | `integration.ts:6421` → `:6496`, arm `NATIVE_CHARCODEAT_FN` | nothing — `ensureNativeCharCodeAtHelper` (24 cells) | same as 2 |
| 4 | `integration.ts:6974` → `:7068`, `emitStringCharCodeAt` adapter fallback | `ctx.nativeStrings` when no provider is attached | **dead** (0/65) — retire fail-closed |
| 5 | `integration.ts:5898/5907` → `:5973`, `stringMethodPlan` | `ctx.nativeStrings` at PLAN time, baked into the symbol (35/65 cells) | **out of scope** — from-ast-side vocabulary (#2955 discipline); the policy can VERIFY it, not re-decide it |
| 6 | `integration.ts:6003-6012` → `:6078`, `charReadPlan() {` | `nativeStrings`, three struct-type indices, `standalone`/`wasi`/`strictNoHostImports` | **out of scope** — plan-time; the trusted/hoist arms `:6425`/`:6437` consume it and read no flag |
| 7 | `integration.ts:7268` → `:7362` (the `if (instr.kind === "call" && … JSSTR_CHARCODEAT_FN \|\| … JSSTR_CHARCODEAT_TRUSTED_FN)` block, `:7361-7365` on the branch), host pre-registration scan | enumerates `JSSTR_CHARCODEAT_FN` / `_TRUSTED_FN` calls | unchanged — it is the ordering guarantee the host helper needs (`addStringImports` before Phase 3) |
| 8 | `src/ir/backend/linear-integration.ts:1560/1637` | no lane read; `__linear_ir_str_char_code_at` | unchanged; the adapter's policy block (`:683-686` on the branch, `stringConcat` at `:686`) declares DISABLED |
| 9 | `src/codegen/stdlib-selfhost.ts:510-513` (branch; `stringConcat` at `:513`) | policy block | gains `stringCharCodeAt: STRING_CHAR_CODE_AT_POLICY_DISABLED` |

Measured facts the design rests on (census `numberChecks`, all reproduced on a
fresh worktree; artefacts under the scratchpad (durable copies in `probes/f2s7/` on
`claude/probe-artifacts-2026-09-02`, `.txt` suffix), verified by `ls`: driver
`f2-cca-matrix.mts`, instrumentation `f2-cca-instrument.py`, strict probe
`f2-cca-probe-strict.mts`, BEFORE record `f2-cca-matrix-before.md` / `.json`,
pin runs `f2-cca-pin-clean.out` / `f2-cca-pins-instrumented.out`):

- 13 fixtures (LOOP, LOOPSUM, LOOPNC, READ, CONST, NEG, OOB, OMIT, TPL, FOROF,
  CHAIN, SUBCONST, CLEAN — sources in the census `## fixtures`) × 5 lanes
  (`{}`, `{nativeStrings:true}`, `standalone`, `wasi`, `linear`) = 65 cells;
  `emitWat:true` does not change a byte (65/65 same sha).
- Path totals: plan path 35 (7 gc-host, 24 native lanes, 4 linear); instr
  path 5 (OOB × 5, of which **4** pass through arm 1 — OOB linear reaches
  neither the arm nor the GC adapter); hoist/trusted 8 (LOOP, LOOPSUM × 4 GC
  lanes); demote/fail 12 (SUBCONST × 4 GC via `preferLegacyFlatSubstringCharCodeAt`,
  FOROF gc-host `charCodeAt on externref not in slice 4`, 7 linear
  `Unsupported method call: .charCodeAt()`); CLEAN 5. Adapter fallback (site 4)
  **0/65**.
- The lane fact is ONE flag: guarded-host ⇔ `!nativeStrings` & no proof;
  guarded-native ⇔ `nativeStrings` & no proof. `charReadPlan`'s
  `standalone||wasi||strictNoHostImports` guard IS reachable from `compile()`
  — only with an explicit `nativeStrings:false`, and the compile then fails on
  `string_constants.*` under strict mode, so no module is emitted (census
  verdict; the original "unreachable" claim was wrong).
- The host provider is a DEFINED helper closing over TWO capability records
  (`char-code-at-helpers.ts:173-179`: `jsStringImports.get("charCodeAt")` and
  `.get("length")`, returns `null` if either is missing; sig
  `(externref,i32)->f64` at `:181`). The native helper is
  `(ref $AnyString,i32)->f64` (`:239`) and is ALSO `number | null` (`:227`).
  Neither is an import — the F2-S3 `exactCallableImportIndex(ctx, module, field)`
  arm template does NOT transfer.
- Host import block in every emitting gc-host cell: `wasm:js-string.length#0`,
  `wasm:js-string.charCodeAt#1`; native lanes import nothing FOR THE SEAM
  (they do carry `env.__str_from_mem/__str_to_mem/__str_extern_len`).
- OMIT reports the TS diagnostic `Expected 1 arguments, but got 0.` with
  `success=true` on all five lanes; the plan pads i32 0 (`padOmitted`).
- Runtime results were NOT executed for the 65 cells (byte/sha/reach only);
  suites #3931 and #1105 cover the guarded/hoist runtime semantics.

Conformance yield is **zero by design**: both authorities already exist, the
manifest only decides which answers, and the matrix must come back 65/65
byte-identical — the LOOP/LOOPSUM cells double as the fence proving the
hoist/trusted arms were not touched.

### Why one feature, `runtime-callable` rows, and a new signature

**One policy, one feature.** `StringCharCodeAtPolicy { charCodeAt: "host" | "native" | "unsupported" }`
selects feature `js.string.char_code_at` (the guarded semantic read,
`(string, i32) -> f64`, NaN out of range) between rows
`host.js.string.char_code_at` and `native.js.string.char_code_at`. The
proof-licensed arms (`__jsstr_charCodeAt_trusted`; the `__str_flatten` +
`__str_flat_charCodeAt` PAIR with a preheader-slot protocol) are a different
feature with a plan-time decision and a symbol pair no implementation kind
expresses — **deferred**, not folded in (alternative: a second feature
`js.string.char_code_at.trusted` whose rows the arms only verify; rejected
because the native row would have to encode a two-symbol protocol, and the
decision that picks it lives in `charReadPlan`, outside R6).

**Implementation kind: reuse `runtime-callable` for BOTH rows**, the host row
carrying `hostCapabilities: ["string.char_code_at", "string.len"]`. Measured
basis: validation (`runtime-manifest.ts:1716-1760`) forbids capabilities only
on `host-managed` / `native-managed` / `carrier-field` and requires ≥1 only on
`host-capability`; nothing forbids them on `runtime-callable`. The two
tempting kinds do not fit: `host-capability` is bound to the async family
projection (`projectRuntimeBackendRequirements` `:558`, throws on a host/native
mix at `:565-570`), and `host-callable` names an IMPORT the arm binds with
`exactCallableImportIndex`, whereas this provider is a helper minted on
demand. `ADMITTED_CALLABLE_TARGETS` (`intrinsic-support.ts:77-100`) is keyed
on `INTRINSIC_DEFINITIONS` entries sharing the provider's feature;
`js.string.char_code_at` has no `intrinsic` instruction, so the rows contribute
nothing there — exactly as `native.js.string.eq`. **Alternative, named:** a new
kind `composed-callable { symbol; capabilities }` stating "defined helper over
N records" as a first-class fact. Rejected for this slice on cost (F2-S4 shows
a new kind is a union arm plus a validation triad, +~100 LOC) with no consumer
that would read the distinction; if a later seam needs it, the two rows here
migrate in one edit.

**Signature: mint `EXTERNREF_I32_TO_F64_INTRINSIC_SIGNATURE`** in
`src/ir/intrinsics.ts` beside `:287-291` — params `[EXTERNREF, I32]`, result
F64. No existing constant has those params (the eight at `:250-307` plus
F2-S5's `EXTERNREF_PAIR_TO_REF_EXTERN`). This is the first row whose signature
is NOT its capability record's ABI (`runtime-host-capabilities.ts:286` is
`(externref,i32)->i32`): the record is the raw builtin that traps out of range
(#2003); the seam's semantic shape is the guarded f64. The native row reuses
the constant nominally, as `native.js.string.eq` does. Do NOT mint an
`EXTERNREF_I32_TO_I32` twin — that belongs to the deferred trusted feature.

**Demand must count BOTH producers.** An instr-only scan (the F2-S3/F2-S4
template) freezes a row for 4/65 cells and leaves the 35 plan-path cells with
nothing to verify against. `irStringCharCodeAtDemand(fns)` = any
`string.char_code_at` instr OR any `call` whose target is
`{kind:"intrinsic", symbol: JSSTR_CHARCODEAT_FN | NATIVE_CHARCODEAT_FN}`
(mirror site 7's enumeration, minus the trusted symbol). The trusted/hoist
symbols are NOT demand — LOOP/LOOPSUM freeze no row and their arms stay
untouched.

**The double decision, stated.** The same flag is read at plan time (`:5907`)
and, after this slice, from the frozen row at resolve. Inside `compile()` they
cannot disagree (`integrationStringCharCodeAtPolicy` is the same expression).
They CAN disagree for an adapter that passes a policy AND a demand; the arms at
sites 2/3 therefore **verify** (symbol ≠ row → `selection-preparation-mismatch`)
and `unsupported` + demand **partitions the owner** — the policy refuses, it
never re-lowers. A later slice can neutralise the plan symbol to
`IR_STRING_CHAR_CODE_AT_FN` so site 1 re-decides for every cell; that is out of
scope here and named in "After this slice".

**No attach move, no second attach pass.** The semantic provider is already on
every `string.char_code_at` (`string-support.ts:70/:137`) and site 1
re-decides at resolve, so nothing needs to run behind the freeze. The F2-S4
lesson stands: `attachIrStringSupport` is NOT idempotent for a second pass (its
callable arm re-derives six seams) — do not call it again.

### Contract

**A. `src/ir/runtime-manifest.ts`** (anchors `a07f`; F2-S5 inserts its
`stringConcat` siblings immediately after every `stringLen` one — place the
charCodeAt sibling after `stringConcat`'s)

1. `StringCharCodeAtPolicy { readonly charCodeAt: "host" | "native" | "unsupported" }`
   and frozen `STRING_CHAR_CODE_AT_POLICY_DISABLED`, after `StringLenPolicy`
   `:240-252` (then F2-S5's concat policy).
2. `RuntimeManifestPolicy.stringCharCodeAt?` (`:291` sibling),
   `FrozenRuntimeManifestPolicy.stringCharCodeAt` (`:302`), canonicalization
   at `:1472/:1481` (`stringCharCodeAt: Object.freeze({ charCodeAt: … })`).
3. `STRING_CHAR_CODE_AT_RUNTIME_FEATURES = ["js.string.char_code_at"]`,
   `STRING_CHAR_CODE_AT_RUNTIME_PROVIDER_IDS = ["host.js.string.char_code_at", "native.js.string.char_code_at"]`
   and their types, spliced where `STRING_LEN_*` are (`:431-436`, the
   `RuntimeFeature` / `RuntimeProviderId` unions, `RUNTIME_PROVIDERS` `:1238`,
   `RUNTIME_FEATURES` `:1251`, the id list `:1264`).
4. **Widen `numberBoundaryProvider`'s `id` / `feature` parameter unions**
   (`a07f :722`, unions `:723-738`; branch `:788`, where F2-S5 already appended
   `StringConcatRuntimeProviderId` / `StringConcatRuntimeFeature`) with
   `StringCharCodeAtRuntimeProviderId` / `StringCharCodeAtRuntimeFeature` —
   the two rows do not typecheck without it. Then
   `STRING_CHAR_CODE_AT_RUNTIME_PROVIDERS` via that helper:
   - `("host.js.string.char_code_at", "js.string.char_code_at", EXTERNREF_I32_TO_F64_INTRINSIC_SIGNATURE, { kind: "runtime-callable", symbol: "__jsstr_charCodeAt" }, ["string.char_code_at", "string.len"])`
   - `("native.js.string.char_code_at", "js.string.char_code_at", EXTERNREF_I32_TO_F64_INTRINSIC_SIGNATURE, { kind: "runtime-callable", symbol: "__str_charCodeAt" }, [])`
   Doc on the host row: a defined helper CLOSING OVER two records, minted on
   demand by `ensureHostCharCodeAtGuarded`; the capabilities are what it needs
   registered, not what it is.
5. `stringCharCodeAtProviderId(policy)`, `isStringCharCodeAtFeature`, and a
   `#selectProvider` branch after the len branch (`:1899-1909`; after F2-S5's
   concat branch), refusal text
   `` `runtime feature ${feature} is unavailable under string-char-code-at policy charCodeAt=${this.#policy.stringCharCodeAt.charCodeAt}` ``.
   No new validation rule; no new kind.

**B. `src/ir/intrinsic-support.ts` / `src/ir/intrinsics.ts`**

6. `intrinsics.ts`: `EXTERNREF_I32_TO_F64_INTRINSIC_SIGNATURE` beside `:287-291`.
7. `stringCharCodeAtDemand?: boolean` on the prepare input (sibling of
   `stringLenDemand` `:500`), in the freeze-nothing conjunction (`:538-539`)
   and the `requestFeature` line (`:551`); `STRING_CHAR_CODE_AT_RUNTIME_FEATURE`
   const beside `:366`.
8. `preparedStringCharCodeAtProvider(prepared)` — sibling of
   `preparedStringLenProvider` (`:382-403`; its `host-callable` branch is
   `:395`) — returns
   `{ arm: "host"; symbol: string; capabilities: readonly string[] } | { arm: "native"; symbol: string } | undefined`;
   the arm is `provider.id === "host.js.string.char_code_at" ? "host" : "native"`
   (both kinds are `runtime-callable`, so the ID, not the kind, is the
   discriminator — say so in the doc); any other kind throws
   `` `IR string-char-code-at provider ${provider.id} is not a charCodeAt implementation` ``.

**C. `src/ir/integration.ts`** (`a07f` → F2-S5 head)

9. `integrationStringCharCodeAtPolicy(ctx)` =
   `Object.freeze({ charCodeAt: ctx.nativeStrings ? "native" : "host" })` after
   `integrationStringLenPolicy` (`:970` → `:972`; place it after F2-S5's
   `integrationStringConcatPolicy` at `:1012`) — the exact fact `:5907` and
   `:6527` read today. Wire into the freeze policy (len twin `:1068-1074` →
   `:1123`; place after F2-S5's `stringConcatDemand` line `:1128`) and the
   partition loop (block after the len block `:3880-3891` → after F2-S5's
   concat block at `:3954`):
   `stringCharCodeAtPolicy.charCodeAt === "unsupported" && irStringCharCodeAtDemand([entry.fn])`
   → `IrUnsupportedError("late-preparation-unsupported", "resolve", "ir/integration: charCodeAt has no provider under string-char-code-at policy charCodeAt=…")`.
10. `irStringCharCodeAtDemand(fns)` — the two-producer scan above, sibling of
    `irStringLenDemand` `:983`; passed as `stringCharCodeAtDemand`.
11. **Site 1** (`:6527` → `:6624`): `const arm = preparedStringCharCodeAtProvider(prepared)`;
    `!arm` → `IrInvariantError("selection-preparation-mismatch", "resolve", "charCodeAt has no frozen provider under the string-char-code-at policy")`;
    `arm.arm === "native"` → `index = ensureNativeCharCodeAtHelper(ctx)`; host →
    `index = ensureHostCharCodeAtGuarded(ctx)`. BOTH helpers return
    `number | null`; a `null` index keeps today's meaning — it falls to
    `resolveFunc`'s `unknown-function-ref` invariant (`:6556-6561` →
    `:6654-6659`, `cannot materialize callable provider …`), a hard compile
    error, never a late import (the len suite's analogous pin is "fails
    closed on a missing host import rather than registering a new one",
    len.test.ts `:540-544`). Site 7's scan and `instrUsesStrings` `:7435`
    guarantee the imports for both producers. No `ctx.nativeStrings` in the
    arm; never `funcMap.get(arm.symbol)` (#1072 shadowing — the #3520 pin).
12. **Sites 2/3** (`:6417`/`:6421` → `:6492`/`:6496`): keep condition and
    materializer; prepend
    `const arm = preparedStringCharCodeAtProvider(prepared); if (!arm || arm.symbol !== symbol) throw new IrInvariantError("selection-preparation-mismatch", "resolve", "plan-time charCodeAt symbol disagrees with the frozen string-char-code-at row")`.
    Since demand includes these calls, `prepared` carries the row in every
    cell that reaches them (P4 confirms nothing mints such a call after the
    freeze).
13. **Site 4** (`:6974` → `:7068`): keep the provider branch verbatim; replace
    the rest with `throw new Error("ir/integration: string.char_code_at has no prepared runtime provider")`
    — after P3's zero-reach measurement. The `_inputEncoding` parameter stays
    (`lower.ts:2292` contract shared with linear).
14. Not touched: `:5898-5910` `stringMethodPlan`, `:5964`
    `preferLegacyFlatSubstringCharCodeAt`, `:6003-6012` `charReadPlan`,
    `:6425-6437` hoist/trusted arms, site 7's pre-registration scan,
    `string-support.ts`, `char-code-at-helpers.ts` bodies, `from-ast.ts`,
    `lower.ts`, `nodes.ts`, `runtime-host-capabilities.ts` (row `:286` stays).

**D. Adapters.** `src/ir/backend/linear-integration.ts` policy block
(`:683-686` on the branch) and `src/codegen/stdlib-selfhost.ts` (`:510-513`)
gain `stringCharCodeAt: STRING_CHAR_CODE_AT_POLICY_DISABLED` after the
`stringConcat` line (`:686` / `:513`); imports beside the
`STRING_LEN_POLICY_DISABLED` ones. Neither freeze passes the demand, so
DISABLED refuses nothing; linear keeps lowering through
`__linear_ir_str_char_code_at` (measured: READ/CONST/NEG/OMIT/OOB).

**E. Records.** No change to `runtime-host-capabilities.ts`; the `:286`
`string.char_code_at` and `:304` `string.len` records are what the host row
names. `scripts/ir-kind-neutrality-baseline.json`: evidence lines below the
inserted functions move (`forof.string` in `integration.ts`; F2-S5 already
patched two) — refresh surgically by sorted-leaf diff, no verdict moves;
`string.char_code_at` stays whatever verdict it carries.

**F. Tests.** New `tests/issue-3526-string-boundary-charcodeat.test.ts`,
anatomy from the len suite (`tests/issue-3526-string-boundary-len.test.ts`,
`describe` blocks at `:245/:303/:402/:515/:582/:694`):

- (a) contract — ONE feature; ONE new signature constant (params
  `[externref, i32]`, result F64; pin it is the only signature with those
  params); TWO provider ids, both `runtime-callable`; the host row names
  exactly `["string.char_code_at", "string.len"]` and the native row `[]`; the
  async projection excludes the seam twice, by two different mechanisms —
  the capability RECORDS `string.char_code_at` and `string.len` by ID
  (`asAsyncHostAdapter`'s seven-ID filter, the len precedent at len.test.ts
  `:280-295`), and the two provider ROWS by KIND
  (`projectRuntimeBackendRequirements` `:565-585` `continue`s past anything
  but `host-capability` / `host-managed` / `native-managed`, so a
  `runtime-callable` row is ignored) — pin both; no `intrinsic` instruction (a
  charCodeAt-only module freezes no manifest without the demand and exactly
  `["js.string.char_code_at"]` with it); the frozen manifest's
  `hostCapabilities` lists both records when host is selected and neither when
  native is.
- (b) policy — host arm `{arm:"host", symbol:"__jsstr_charCodeAt"}`; native
  arm `{arm:"native", symbol:"__str_charCodeAt"}` requesting NO capability;
  refusal names `string-char-code-at` and the value; default closed and
  published; independent of compare / eq / len / concat and family 1; no row
  when nothing calls charCodeAt.
- (c) end-to-end — host lane keeps `wasm:js-string.length#0`,
  `wasm:js-string.charCodeAt#1` in the same positions (READ, OOB) and defines
  `__jsstr_charCodeAt` (WAT); native-strings lanes define `__str_charCodeAt`
  with no `wasm:js-string` import; a runtime oracle against JS for
  `charCodeAt` on host, native-strings and linear (linear only READ/CONST/
  NEG/OMIT/OOB shapes) over: in-range ASCII, NaN out of range (OOB), negative
  index, omitted index (→ index 0), fractional index (ToIntegerOrInfinity),
  both halves of a surrogate pair, a BMP non-ASCII code unit; **sha fence**:
  LOOP and LOOPSUM on all four GC lanes equal the BEFORE record's sha
  (`f2-cca-matrix-before.json`) — proving the hoist/trusted arms untouched.
- (d) source pins on site 1 — contains `preparedStringCharCodeAtProvider(`,
  no `nativeStrings`, no `funcMap`, no `ensureLateImport`, still names
  `IR_STRING_CHAR_CODE_AT_FN` and both helper names (the fail-closed null
  covers both arms); sites 2/3 contain the verify line
  (`arm.symbol !== symbol` + `selection-preparation-mismatch`) and still name
  their materializers; the partition block names
  `string-char-code-at policy`; `irStringCharCodeAtDemand`'s source names
  BOTH `"string.char_code_at"` and the two plan symbols.
- (e) sub-B — the emitter refuses an unattached `string.char_code_at`
  (`ir/integration: string.char_code_at has no prepared runtime provider`),
  accepts an attached one, and its source contains no `nativeStrings`.
- (f) verify — **source-text pins, not a behavioural fence**: no entry point
  lets a test inject a manifest policy into `resolveFunc` (the policy is
  derived from ctx inside `compile()`; the only adapters that pass one, D,
  pass DISABLED with no demand), the family's one existing mismatch pin
  (eq.test.ts `:471`) is source-text, and F2-S4's partition/verify pins are
  too (len.test.ts `:516-544`, `:560-564`). So (f) pins the sites 2/3 verify
  line and the partition condition
  (`stringCharCodeAtPolicy.charCodeAt === "unsupported" && irStringCharCodeAtDemand([entry.fn])`)
  as text. If P6 finds a harness, promote (f) to a behavioural fence and say
  so in the checkpoint; do not invent one for this slice.

Existing pins that move, each a named edit: `tests/issue-3526-string-boundary-schema.test.ts`
`PROVIDED_IDS` (`:93` on both trees — `["string.eq","string.len"]` at `a07f`,
`["string.concat","string.eq","string.len"]` on the branch) gains
`string.char_code_at`, and the `STILL_UNPROVIDED_IDS` fence (`:378` on both
trees — `toHaveLength(4)` at `a07f`, `toHaveLength(3)` on the branch) shrinks
to 2 and asserts positively that a provider names `string.char_code_at`
(F2-S5's schema churn is at `:77`, `:152`, `:194`, `:212` — these two anchors
did not move). Frozen-default pins are field-by-field `expect(frozen.policy.X).toEqual(X_POLICY_DISABLED)`
lines, so the edit is one appended line each —
`expect(frozen.policy.stringCharCodeAt).toEqual(STRING_CHAR_CODE_AT_POLICY_DISABLED);`
— after the block's last policy expect: compare `:268` → `:270` (F2-S5's
`stringConcat` line; the `stringLen` line moved +1 to `:269`), eq `:301` →
`:303` (`stringLen` at `:302`), len `:350` → `:359` (`stringLen` at `:351`,
F2-S5 appended concat at the block's END), and F2-S5's concat suite defaults
block (`it(...)` `:362-376` on the branch, expects `:366-374`, `stringLen` at
`:374`). The ONE whole-shape policy equality is
`tests/issue-4104-ir-async-plan-runtime-consumer.test.ts:444` (branch
`:444-445`, `stringConcat` at `:445`), which gains the object-literal field
`stringCharCodeAt: { charCodeAt: "unsupported" }` (NOT
`issue-3526-ir-runtime-manifest.test.ts`, which has no such assertion —
census correction, and F2-S3/F2-S4 recorded the same). Pins that STAY:
`tests/issue-3931.test.ts:101-125,158-268,270-305,309-410`,
`tests/issue-1105-charcodeat.test.ts:38-108` (108-line file, `describe` at
`:38`), `tests/issue-3520-callable-preregistration.test.ts:13-27` (a user
export named `__jsstr_charCodeAt` must still compile as a source unit — the
row's symbol is binding-aware, item 11),
`tests/string-derived-length-fast-path.test.ts:344`,
`tests/linear-charcodeat-ascii-fast-path.test.ts:142+`,
`tests/issue-3521-prepared-component-dependencies.test.ts:50,994,1019` (pins
the semantic provider on the prepared instr — unchanged), schema `:204-211`
and `:313`. No existing test pins site 1's source text, so there is no
"un-migrated charCodeAt arm" fence to invert (unlike concat).

### Required pre-implementation probes (answers go in the checkpoint note)

- **P1 — BEFORE byte matrix on the lane's own base** (post-F2-S5 + `origin/main`
  merge), `f2-cca-matrix.mts` WITHOUT instrumentation, 65 cells deep-equal to
  `f2-cca-matrix-before.json` (bytes, sha, ordered import section with
  indices, demotions). Expected identical — F2-S5 is byte-neutral by its own
  V-A. If any cell differs, look at **TPL first** (`` `${a}!`.charCodeAt(0) ``,
  which carries `env.__concat_3#5` on gc-host — the one charCodeAt cell
  F2-S5's concat policy could plausibly touch); any difference is a finding
  about F2-S5, reported, not absorbed. Then once WITH `f2-cca-instrument.py`
  re-anchored to the branch's line numbers, to re-establish the reach counts
  (`6624/ir-*`, `6492`, `6496`, `7068`).
- **P2 — readers of `provider.hostCapabilities` on a `runtime-callable` row**:
  `intrinsic-support.ts:595`, `async-plan.ts:300/405/441`, the frozen
  manifest's published union. Expected: publication/validation only, nothing
  mints an import from it (`check:host-import-policy` count unchanged; the
  gc-host import block stays two entries). If a reader mints, the host row's
  capabilities must become documentation-only and the finding goes in the
  checkpoint.
- **P3 — zero-reach of the site-4 fallback**: temporary `throw` in place of
  `:7068`'s fallback, the 65-cell matrix (byte-identical with the throw in)
  and the string suites (`strings`, `native-strings` ×3,
  `host-string-prefix-suffix-fast-path`, #3931, #4517, #1105, #3520, #3521,
  `linear-charcodeat-ascii-fast-path`, `string-derived-length-fast-path`, the
  #3526 string suites incl. concat). **Measure the standing-red control set on
  the lane's base FIRST** — its red count is **unmeasured** post-#5465 (#5274's
  five rewritten suites are not in this set, so it says nothing here). The
  one known red: `string-derived-length-fast-path` "applies immutable
  derived-result proofs to host strings…" (`illegal cast`, reproduced on
  `a07f` in `f2-cca-pin-clean.out:20-28`; #5274 did not touch that file) —
  expected still red, not this slice's, must not be blamed on it.
- **P4 — every guarded call is visible to the demand scan**: no pass between
  the freeze and resolve mints a `JSSTR_CHARCODEAT_FN` / `NATIVE_CHARCODEAT_FN`
  call (planning grep: 0 hits in `src/ir/passes/`, `lower.ts`, `builder.ts`;
  re-confirm on the branch, including `src/ir/passes/batch-string-concat.ts`,
  imported at `integration.ts:305` and invoked at `:3681/:3683` → `:3735/:3737`),
  and no test hand-builds a resolver with those symbols and no prepared
  manifest (planning grep: only `issue-3520`, which uses `compile()`).
  Expected: none — otherwise item 12's fail-closed verify would throw where
  today's arm compiles.
- **P5 — signature ≠ record ABI**: does any #3526 suite assert a provider's
  `signature` equals its named capability record's params/results? (Schema
  `:313` compares record vs import registration, not vs provider.) Expected:
  none. If one exists it is a finding — extend it to admit the guarded f64
  shape, do not weaken it, and do not switch the row to the i32 record ABI.
- **P6 — a policy-injection harness for resolve**: is there any entry point
  (a `generateModule` / `compileIrPathFunctions` call with a hand-built ctx,
  or an adapter that passes both a policy and a demand) by which a test can
  freeze `charCodeAt: "native"` and resolve a function carrying a
  `__jsstr_charCodeAt` call? Expected (census: unmeasured; planning read:
  none). If none, (f) stays source-text; if one exists, name it and promote
  (f) to a behavioural fence (`selection-preparation-mismatch` at resolve;
  `unsupported` + demand → `late-preparation-unsupported`).

### Verification matrix

- **V-A** byte neutrality — 65/65 cells identical to P1's record (bytes, sha256,
  import section with indices, demotions, WAT text `diff -r` empty), the
  LOOP/LOOPSUM hoist cells and the 7 linear compile-fails included; corpus
  (`website/playground/examples/**`, `examples/**`) × 4 GC lanes on both
  trees; `check:ir-fallbacks` diffed against a base-tree run (byte-identical).
- **V-B** pins — the new suite in full; the moved pins named above; #3931,
  #1105, #3520, #3521 untouched and green; reach counts re-instrumented on the
  AFTER tree equal the BEFORE (site 1 ×4, site 2 ×7, site 3 ×24, site 4
  fallback 0).
- **V-C** non-vacuity, each revert independent against the kept schema
  (counts unmeasured — record them): revert only site 1 → the (d) site-1 pins
  fail (and, if P6 promoted (f), the instr-path fence); revert only the
  sites 2/3 verify → the (d)/(f) verify-line pins fail, nothing else; revert
  only site 4 → exactly the (e) refusal pin; revert only the demand's
  plan-symbol half → the (d) demand pin and — because sites 2/3 then find no
  row — every plan-path (c) pin (expected interlocked, the F2-S4 divergence-5
  shape, not the F2-S3 prediction); revert only the manifest rows → (a)/(b)
  and every (c) pin (site 1 is fail-closed on the row).
- **V-D** gates — the five ratchets bare AND under
  `LOC_GATE_BASE=$(git rev-parse origin/main)` (and once more against the
  F2-S5 branch tip while stacked); `typecheck`, `lint`, `prettier --check`;
  `check:ir-dialect`, `check:ir-layering`, `check:ir-only`, `check:linear-ir`,
  `check:host-import-policy` (no new import, no new builtin),
  `check:test-vacuity-shapes`, `check:ir-kind-neutrality` (surgical evidence
  refresh, no verdict moves), `check:ir-fallbacks` diffed against base.
- **LOC** — estimate +230 net src LOC (one policy, two rows, one signature,
  the two-producer demand, three arm edits, one retirement; measured
  comparators: F2-S3 was +260 with a resolve arm — checkpoint `:4560`, grant
  `:166`; F2-S5 is +353 with two features — numstat above). Grant in this
  file's frontmatter with a dated F2-S7 rationale, placed **after the F2-S5
  block** the branch already carries (`:225+` on the branch; the F2-S4 block
  at `:187-221` is the wording template); **never edit
  `scripts/*-baseline.json` for LOC**.

### Out of scope

The plan-time lane reads (`stringMethodPlan` `:5898-5907`, `charReadPlan`
`:6003-6012`, `preferLegacyFlatSubstringCharCodeAt` `:5964`) and the from-ast
producers; the trusted/hoist feature and arms `:6425`/`:6437`; the
`char-code-at-helpers.ts` bodies; the SUBCONST demote, the FOROF gc-host
`charCodeAt on externref` demote and the 7 linear `.charCodeAt()` compile
failures (pre-existing); `charAt` (`:6520-6525`, its own lane read); the
`fast: true` lane (not in the matrix — a #3931 config only); the
`string.len` record's governance (F2-S4); F2-S6's batching pass; F2-S8's
`string.const`.

### After this slice (ranked)

| rank | boundary | why |
| --- | --- | --- |
| **F2-S6** | batched many-arity concat (branch from F2-S5; land BEFORE this slice if both are ready — the adjacency conflict is mechanical either way; census `census-f2s6-batched-concat.md`, drivers under `f2s6/`) | last lane reads in the string block; variadic `env` record scheme + a pass policy |
| **F2-S8** | `string.const` | hardest: host-global / native-global kinds, derived field, two namespaces; the IR seam is not the minting authority — the plan must say what it governs (census `census-string-const.md`, matrix `census-string-const-matrix.{mts,json,md}`, probes `census-string-const-probe{,2,3}.mts`) |
| later | neutralise the charCodeAt plan symbol to `IR_STRING_CHAR_CODE_AT_FN` | lets site 1 re-decide for all 35 plan-path cells; removes the double decision this slice only verifies |
| later | `js.string.char_code_at.trusted` | needs a pair-shaped kind and a plan-time policy hook; the `charAt` arm `:6520` in the same sweep |

## 2026-09-02 F2-S8 implementation plan — string.const under manifest policy (family 2, slice 8)

Written by the Fable planning lane against `origin/main` `5f13a35bc6` (F2-S4
merged as PR #5460; #5465 rewrote the #5274 red pins). The census was measured
at `a07f65319f`; `git diff --stat a07f65319f origin/main` over the ten seam
files (`src/ir/{integration,runtime-manifest,intrinsic-support,string-support,runtime-host-capabilities,nodes}.ts`,
`src/ir/backend/linear-integration.ts`, `src/codegen/registry/imports.ts`,
`src/codegen/{native-string-literals,stdlib-selfhost}.ts`) is **empty**, so
every file:line below holds on `5f13a35bc6` (= HEAD `f1739d2b52` for these
files). In flight: **F2-S5, PR #5467** on `origin/claude/issue-3526-f2s5-string-concat`,
tip `6d6425c8e3` (`b814a01a4c` + a merge of `origin/main`; open, auto-parked
2026-09-02 07:48 UTC on collateral from #5224 — diagnosis in the PR thread). Its change set
(`git diff --stat origin/main...6d6425c8e3`, 14 files) moves **every B/C/D/F
anchor here** — measured at the tip: `integration.ts` +138 (`prepareStrings`
`:7235→:7329`, `if (usesStringOp && !ctx.nativeStrings) {` `:7307→:7401`,
`storageForConst` `:7369→:7463`, `emitResolvedStringConst` `:6576→:6674`,
`resolveAndObserveCallableProvider` `:6304→:6379`, `const lengthAttached =`
`:1089→:1143`); `runtime-manifest.ts` +172 (1967→2131 lines; `RUNTIME_PROVIDERS`
`:1228→:1369`, the `isStringLenFeature(feature)` branch `:1902→:2048`);
`intrinsic-support.ts` +67 (`:500→:553`, `:382→:384`, `:77→:79`, `:366→:368`;
anchors `readonly stringLenDemand?: boolean;`, `export function preparedStringLenProvider(`,
`const ADMITTED_CALLABLE_TARGETS`); `intrinsics.ts` +26 (appended after
`:287-291`, which survives); both adapters +2 (`stringConcat: STRING_CONCAT_POLICY_DISABLED,`
after `stringLen: STRING_LEN_POLICY_DISABLED,`); the schema suite (36 lines),
the `it("defaults an omitted policy closed` pins (+2/+4/+4), `issue-4104…:442-445`
(+1), and `scripts/ir-kind-neutrality-baseline.json` (`forof.string` evidence
`integration.ts:6531→:6629`). F2-S6 (batched concat) and F2-S7 (`charCodeAt`)
each add a policy field, a `#selectProvider` branch, a partition block and an
adapter line in the same adjacency. **Re-anchor by content**:
`function prepareStrings(`, `const storageForConst = (instr: IrInstrStringConst)`,
`providerRegistry.observe(provider, materialization.funcIdx)`,
`function emitResolvedStringConst(`, `if (!runtime) return { entries };`,
`has no provider under string-len policy`, `export const STRING_LEN_RUNTIME_PROVIDERS`.

**Sequencing: the LAST family-2 slice and the hardest.** Dispatch only after
F2-S5, F2-S6 and F2-S7 have merged, branching from `origin/main` then; if a
predecessor is still queued, branch from its REAL branch (predecessor
stacking, never a `gh-readonly-queue/*` ref) and enqueue only after it lands.

### What moves and what does not (census, 78 cells)

The seam is the `string.const` IR instruction (`src/ir/nodes.ts:1205`
`storage?: IrGlobalRef`, `:1211` `materializer?: IrFuncRef`, mutually
exclusive) and the attachment in `prepareStrings` that binds one of them. There
is **no resolve-table arm and no callable**: the attached `IrGlobalRef` IS the
physical choice, resolved at emission from the Program-ABI plan
(`integration.ts:6725` `resolveGlobal`) — immune to the legacy path's
mid-emission index shifts.

| # | site | what it reads | fate |
| --- | --- | --- | --- |
| 1 | `src/ir/integration.ts:7370`, `storageForConst` (`:7369`) host arm | `!ctx.nativeStrings` → `programAbiStringConstantRef(ctx, value)` (`src/codegen/program-abi-import-planning.ts:991`) | **THE decision** — reads the frozen `stringConst` policy; gains an exact-global check |
| 2 | `integration.ts:7378`, native arm | `ctx.programAbiGlobals.prepareNativeStringLiteral(global)` (`program-abi-global-planning.ts:98`) on a `kind:"global"` materialization | the native resolver; moves with the attachment, unchanged |
| 3 | `integration.ts:7357`, `nativeMaterializationFor` | `!ctx.nativeStrings \|\| ctx.nativeStrTypeIdx < 0` | folds into the native arm (policy says native ⇒ materialize) |
| 4 | `integration.ts:7360-7363`, encoding read | `ctx.utf8Storage && instr.alloc && ctx.allocRegistry` → `u8:`/`u16:` key | **unchanged** — storage WIDTH, below the policy |
| 5 | `integration.ts:7382-7392`, `materializerForConst` (observe `:7389`) | `materialization.kind === "callable"` (literal > `ARRAY_NEW_FIXED_MAX` 10000, `native-string-literals.ts:57`) | **unchanged, policy-silent** — moves with the attachment |
| 6 | `integration.ts:7307-7315`, host pre-registration | `usesStringOp && !ctx.nativeStrings` → `addStringImports` + `addStringConstantGlobal` (`:7314`) per scanned literal | **NOT touched** — the registration / import-ORDER authority; also gates charAt/repeat |
| 7 | `integration.ts:7398`, the omnibus `attachIrStringSupport` call | `storageForConst`, `materializerForConst` | its `string.const` arm becomes a no-op; a const-only pass runs inside the freeze |
| 8 | `integration.ts:6589` / `:6596`, `emitResolvedStringConst` (`:6576-6600`) no-storage fallback | `ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0` → inline native literal; else raw `stringGlobalMap` `global.get` | **NOT retired here** — 0 `string.const` reaches in 78 cells, but `extern.regex` (`src/ir/lower.ts:3561`/`:3566`) emits pattern/flags through it with no storage; unmeasured (P3) |
| 9 | `src/codegen/registry/imports.ts:154` (`-1` sentinel), `:175-177` (`hasLoneSurrogate` → `string_constants16`/`hexCodeUnits`), `:207` (`addHostStringConstantGlobal` refusal, mint `:209`); `src/codegen/declarations/import-collector.ts:1660` (the `if (ctx.nativeStrings)` finalize branch), `:1670` (its `addStringConstantGlobal(ctx, value)` mint), `:1457` (function names) | lane / per-literal | **out of scope** — legacy producers (38 of 39 host mints); `:175-177` is the derivation the two schemes MIRROR, never select |
| 10 | `src/ir/backend/linear-integration.ts:1576-1593` (data segment); `src/codegen/stdlib-selfhost.ts:508-512` | no lane read / policy block | unchanged; both adapters declare `stringConst: STRING_CONST_POLICY_DISABLED` (`:681-686`, `:508-512`) |

Census — 13 fixtures × 6 lanes (five required + `standalone+utf8`, the only
way to reach the `u8:` arm) = 78 cells at `a07f65319f`, 21 markers; the
verifier re-derived 78/78 bytes+sha12 and re-instrumented 54 cells. Artifacts
under the planning session's scratchpad (all verified by `ls`; durable copies
in `probes/f2s8/` on branch `claude/probe-artifacts-2026-09-02`, `.txt` suffix): `census-string-const.md` (the census, verdict notes at
its head), `-matrix.mts` (driver; imports `../src/index.js`, so run from a
worktree root as `.tmp/sc-matrix.mts`; 13 fixture sources verbatim),
`-instrument.py` (scratch worktree only; each patch asserts its anchor count),
`-matrix.md`/`.json` (BEFORE record), `-run.out`, `-probe{,2,3}.mts` (same
relative import; probe2 has REGEX
`export function f(s: string): boolean { return /ab+c/i.test(s); }`, probe3
BOOLTPL `` export function f(b: boolean): string { return `${b}`; } ``);
`booltpl.mts` and `matrix-wt.mts` — **both hard-wired to the removed worktree
`/home/user/js2/.claude/worktrees/verify-string-const/src/…`**, re-point first;
`f2s8-red-recheck.out` (post-#5465 red re-check at `/home/user/js2` HEAD
`f1739d2b52`). Predecessor drivers: `f2s6/{f2s6-matrix.mts,f2s6-instrument.py,f2s6-policy.mts,f2s6-shift.mts,matrix.md,matrix.json,matrix.out}`
and `f2-cca-{matrix.mts,instrument.py,matrix-before.md,matrix-before.json,probe-strict.mts}`.
BOOLTPL and REGEX are cited by the census but NOT in its matrix — add both
(P1): 15 × 6 = 90 cells.

What it measured:

- **The IR seam is NOT the minting authority on the host lane.** 38 of 39
  `string_constants` mints came from the legacy collector finalize
  (`import-collector.ts:1670`, under the `:1660` lane branch), the 39th from
  `src/codegen/statements/tdz.ts:120` (LATEGLOBAL). `prepareStrings`' own
  `addStringConstantGlobal` (`:7314`) was `already:true` in 10/10
  required-fixture host cells (7/7 in the verifier's re-sample); it mints only
  IR-only literals — BOOLTPL's `"true"`/`"false"`, each triggering
  `fixupModuleGlobalIndices` (`imports.ts:321`; thresholds 2→3, delta 1;
  `:7314` is the single-value helper). **So the policy governs the LABEL
  (which `IrGlobalRef` the instruction carries) on a global something else
  minted, plus the interned `__strlit_N` on native lanes; not mint time or
  import order.**
- **Import order is a three-producer product:** collector func imports first
  (INIT `env.console_log_string`#0, BOOLTPL `wasm:js-string.concat`#0), then
  collector literal globals in AST-scan order with `string_constants16`
  INTERLEAVED (LONE: `sc@0`, `sc16@1` `"0078d8000079"`, `sc@2`), then late
  imports at their emission point (TPLONLY `env.__concat_3` after 3 globals;
  LATEGLOBAL `env.__throw_reference_error` between `@2` and `@3`). Nothing in
  this slice may re-time a registration.
- **Native lanes: 0 `string_constants` globals in every required fixture**;
  the seam interns `__strlit_N` (`native-string-literals.ts:117`/`:122`; ASCII
  2, DUP 3, LONG12000 3 + one `__strlit_materialize_${nativeStrHelpers.size}`
  helper (`:195`/`:237`), `_43`/`_41` by lane; standalone TPLONLY 6 through
  the EXISTING batched `__str_concat_N` codegen, `src/codegen/native-batched-concat.ts:37`
  — F2-S6 is the unlanded plan to govern it, not the producer of today's
  bytes). The one host global under gc-native-strings (LATEGLOBAL
  `"n is not defined"@0`) is the LEGACY `imports.ts:207` path — `native` on
  that lane is not "no `string_constants`".
- **Two namespaces, one arm:** `string_constants16` is chosen per literal by
  `hasLoneSurrogate` (`imports.ts:175`; runtime twin `src/runtime/string-constants.ts:11`;
  one source `src/string-surrogate.ts:26`); PAIR stays in `string_constants`.
  Not a lane or policy choice. `:6589`/`:6596` reached 0 times for
  `string.const`; their only producer is `extern.regex`, unfixtured.
- Linear: 0 imports; ASCII/EMPTY/LONG*/DUP → data segment; BMP/PAIR/LONE and
  TPLONLY REJECTED (ASCII proof, `src/ir/analysis/linear-string-runtime.ts:13`),
  visible only in `getLastLinearIrReport()`. Demotions (need
  `trackIrOutcomes: true`): INITCONST/LATEGLOBAL `body-shape-rejected`; INIT
  coercion / host-surface. Controls, kept.
- **The census's "red today" note is stale:** `imported-string-constants` (4)
  and `issue-320` (1) were red at `a07f`; #5465 (`dff0f43000`) rewrote them —
  `f2s8-red-recheck.out` on `f1739d2b52`: 29/29 green (8 + 21). P1
  re-measures on the lane's own base.

Conformance yield is **zero by design**; the matrix must come back 90/90
byte-identical (bytes, sha256, WAT, ordered import list with indices,
demotions, linear report text). **What the frozen row governs, plainly:** the
`js.string.const` row is authoritative for `string.const` INSTRUCTIONS only.
Regex literals count as demand (item 11) so a regex-only module's
`hostCapabilityRecords` truthfully names the namespace it imports — but their
emission stays the `:6596`/`:6589` legacy fallback until the next slice gives
`extern.regex` a `storage`. The manifest claims the capability; the seam does
not yet route those two literals through it.

### Why two kinds, two features, one policy

The manifest has no value-shaped provider: of the ten kinds in
`RuntimeProviderImplementation` (`runtime-manifest.ts:450-522`), lowering can
act on `host-callable { capability: RuntimeHostCapabilityFuncId }` (`:485-486`;
a global id there is refused by `#indexProviders` `:1738-1741`, schema suite
`:560-600`) and `runtime-callable { symbol }` (`:493-494`). The verifier's
correction stands — `host-capability` (`:470`) CAN already request a global
id (`hostCapabilities` `:547` is checked against `HOST_CAPABILITY_ID_SET`
`:1268`/`:1709`; freeze resolves it kind-agnostically, `runtime-host-capabilities.ts:483`
at `runtime-manifest.ts:1668-1670`) — but `projectRuntimeBackendRequirements`
(`:558`, `:565`) treats that kind as the ASYNC host family, so reusing it is
rejected (the charCodeAt census's reason too). What is missing is an
`implementation` discriminant. Add two kinds:

```ts
| { readonly kind: "host-global"; readonly capability: RuntimeHostCapabilityGlobalId }
| { readonly kind: "native-global"; readonly role: "native-string-literal" }
```

Symbolic, like F2-S4's `carrier-field`: the host row names the GLOBAL record
(its `field.scheme` is the derivation, never an enumerable field list); the
native row names the Program-ABI global ROLE
(`PROGRAM_ABI_GLOBAL_ROLE.nativeStringLiteral`, `program-abi-global-planning.ts:14`,
applied at `:121`), never an index — the manifest freezes before
`internNativeStringLiteral` (`native-string-literals.ts:117`) allocates.

| feature | host row | native row |
| --- | --- | --- |
| `js.string.const` | `host.js.string.const` — `host-global` on `string.const` (`string_constants`, scheme `literal`) | `native.js.string.const` — `native-global`, role `native-string-literal` |
| `js.string.const.utf16` | `host.js.string.const.utf16` — `host-global` on `string.const.utf16` (`string_constants16`, `literal-utf16-hex`) | `native.js.string.const.utf16` — `native-global`, same role (a lone surrogate is a plain u16 literal natively) |

Policy `StringConstPolicy { readonly storage: "host" | "native" | "unsupported" }`
selects the arm for BOTH features. **Values `host`/`native`, not
`host-global`/`native-global`** — the kinds carry the global-ness, and the
values stay parallel to `compare`/`eq`/`len`/`concat`. **Two features, not one
host row requesting both capabilities:** a surrogate-free module freezes only
`js.string.const` and its `hostCapabilityRecords` names exactly the import
namespaces it needs; the alternative (one row, `hostCapabilities: ["string.const","string.const.utf16"]`)
would claim `string_constants16` on every module. The utf16 split stays a
per-literal DERIVATION inside the host arm, requested as a feature, never
offered as an arm — as F2-S5 keeps `owned-append` a row fact.

**Signature: ONE nominal constant.** Every `IntrinsicSignature`
(`src/ir/intrinsics.ts:184-188`) is callable-shaped; add
`EXTERNREF_GLOBAL_INTRINSIC_SIGNATURE` beside `:287-291` (`params []`, result
`EXTERNREF_TYPE`); native rows reuse it as `native.js.string.len` reuses
`EXTERNREF_TO_I32` for a `struct.get`. The alternative — a `valueType` on
`RuntimeProvider` (`:545-550`) — changes every projection; rejected here.

### Contract

**A. `src/ir/runtime-manifest.ts`**

1. `StringConstPolicy` + frozen `STRING_CONST_POLICY_DISABLED` after F2-S5's
   `stringConcat` sibling (after `STRING_LEN_POLICY_DISABLED` `:250-252` here).
   Doc: family 2's last policy; the only one whose arms are VALUES; governs
   the label, not the mint.
2. `RuntimeManifestPolicy.stringConst?` (`:291` sibling),
   `FrozenRuntimeManifestPolicy.stringConst` (`:302`), canonicalization beside
   `:1472`; `STRING_CONST_RUNTIME_FEATURES` (two ids, the `:431-432` tuple
   pattern) spliced into `RuntimeFeature` (`:67`), `FEATURE_SET` (`:1243-1251`)
   and `RUNTIME_FEATURE_SIGNATURES` (`:655`); `STRING_CONST_RUNTIME_PROVIDERS`
   (four rows, the `STRING_LEN_RUNTIME_PROVIDERS` `:948-962` shape) spliced
   into `RUNTIME_PROVIDERS` (`:1228`, spread beside `:1238`); id types into
   `RuntimeProviderId` (`:438`) and the `numberBoundaryProvider{,Id}` unions
   (`:722`, `:1018`). There is no `RUNTIME_FEATURES` list.
3. The two kinds on the union `:450-522` ONLY — NOT in
   `MathRuntimeProviderImplementation` (`:523`) nor the
   `IntrinsicRuntimeProviderImplementation` `Extract` (`:528`).
4. Four rows via `numberBoundaryProvider(id, feature, EXTERNREF_GLOBAL_INTRINSIC_SIGNATURE, implementation, hostCapabilities)`
   — host rows `["string.const"]` / `["string.const.utf16"]`, native rows `[]`.
5. `stringConstProviderId(feature, policy)`, `isStringConstFeature` (the
   `:974` shape), a `#selectProvider` branch after F2-S7's (after the
   `isStringLenFeature(feature)` branch `:1900-1914` here), refusal
   `provider-target-unavailable`
   `` `runtime feature ${feature} is unavailable under string-const policy storage=${this.#policy.stringConst.storage}` ``.
6. Validation beside `:1728-1762`: `host-global` → `capability` satisfies
   `isRuntimeHostCapabilityGlobalId` (`runtime-host-capabilities.ts:98`) AND
   appears in `hostCapabilities`; `native-global` → no host capability, `role`
   is `"native-string-literal"`. Reuse `unknown-host-capability` /
   `unknown-runtime-provider` (F2-S4 divergence 4).

**B. `src/ir/intrinsic-support.ts` / `src/ir/intrinsics.ts`**

7. `EXTERNREF_GLOBAL_INTRINSIC_SIGNATURE` in `intrinsics.ts` beside `:287-291`.
8. `stringConstDemand?: { readonly literal: boolean; readonly utf16: boolean }`
   on the prepare input (sibling of `:500`; F2-S5's `stringConcatDemand` pair
   at branch `:561` is the precedent), in the "freeze nothing" conjunction
   (`:536-539`; branch `:601-602`), two `requestFeature` lines (`:551`
   siblings; branch `:615-616`); constants beside `:366`. **Item 12 depends
   on the conjunction line.**
9. `preparedStringConstProvider(prepared, feature)` — sibling of
   `preparedStringLenProvider` (`:382`) — returns
   `{ arm: "host"; module; scheme } | { arm: "native"; role } | undefined`;
   host via a NEW `resolveRuntimeHostCapabilityGlobalRecord` in
   `runtime-host-capabilities.ts` (twin of `:498`, kind-guarded — `:483` is
   kind-agnostic, `:498` func-only); anything else throws
   `` `IR string-const provider ${provider.id} is not a literal-storage implementation` ``.
   `ADMITTED_CALLABLE_TARGETS` (`:77`, kind filter `:81`) `continue`s on both
   kinds. The func-only guards are **six** `resolveRuntimeHostCapabilityFuncRecord`
   call sites on main (`:92/:234/:279/:314/:356/:396`), **seven** on the
   F2-S5 branch (`:94/:236/:281/:316/:358/:398/:449`), plus the kind guard
   `asCallableRuntimeHostCapabilityRecord` (`async-runtime-providers.ts:106`)
   — P4 greps them, never enumerates; none is on a `host-global` row's path.

**C. `src/ir/integration.ts`**

10. `integrationStringConstPolicy(ctx)` =
    `Object.freeze({ storage: ctx.nativeStrings ? "native" : "host" })` beside
    `integrationStringLenPolicy` (`:970-971`) — the exact fact `:7370` reads.
    Wire into the freeze policy (`:1057` sibling) and the partition loop
    (compute beside the len policy; block beside `:3880-3882`):
    `storage === "unsupported"` and either demand flag →
    `IrUnsupportedError("late-preparation-unsupported", "resolve", "ir/integration: string literal storage has no provider under string-const policy storage=…")`.
11. `irStringConstDemand(fns)` — one scan: `literal` on any `string.const` OR
    `extern.regex` (mirrors `:7251` `literals.add(instr.value)` and the regex
    adds `:7294-7295` under `:7291`; a regex literal DOES occupy a
    `string_constants` global on host, so it is demand — caveat above),
    `utf16` iff any such literal `hasLoneSurrogate` (import from
    `src/string-surrogate.ts:26` — `integration.ts` has no such import today;
    NOT from `src/codegen/`, so `check:ir-layering` does not grow). Passed as
    `stringConstDemand` beside `:1074`.
12. **Move the attachment behind the freeze (F2-S4 pattern).** `prepareStrings`
    (`:7235`) KEEPS the scan, `:7307-7315` verbatim, `attachIrStringCarrier`,
    `prepareStringCarrier()`, `providerForRepeat`; its `attachIrStringSupport`
    call (`:7398`) passes `storageForConst: () => undefined` and no
    `materializerForConst`. The block `:7355-7392` (`nativeMaterializations`,
    `nativeMaterializationFor`, `storageForConst`, `materializerRefs`,
    `materializerForConst`) moves into a new
    `prepareStringConst(ctx, lengthAttached, runtime)` in
    `prepareBuiltFnRuntimeManifest` (`:1040`), after `prepareStringLength`
    (`:1089`), before `materializePreparedMathProviders` (`:1090`). **Input is
    `lengthAttached`** — the output of BOTH prior passes (`prepareStrings` at
    `:3915`, whose first pass bound `string.repeat`, then `:1089`) — or the
    exact-binding checks in `string-support.ts:105-107` trip. **It sits after
    the early return `if (!runtime) return { entries };` (`:1076`), so it runs
    ONLY because item 8 puts `stringConstDemand` into the freeze-nothing
    conjunction: a module with any `string.const`/`extern.regex` always
    freezes.** Break that coupling and literals silently lose `storage` and
    fall into `:6596` — byte-identical on host (same global), INVISIBLE to
    V-A; pin (c) guards it. Changes inside the moved block, and only these:
    `arm(value) = preparedStringConstProvider(runtime, hasLoneSurrogate(value) ? UTF16 : LITERAL)`
    (`undefined` ⇒ entries unchanged); the host arm keeps
    `programAbiStringConstantRef` and adds the **exact-global check**
    `ref.binding.kind === "import" && ref.binding.module === arm.module`
    (`irImportGlobalRef` carries `module`/`field`, `src/ir/abi-bindings.ts:161-183`;
    error `ir/integration: prepared string.const has no exact ${arm.module} import global`).
    That check guards **derivation drift**, not mis-registration:
    `programAbiStringConstantRef` (`program-abi-import-planning.ts:991-1012`)
    walks `ctx.mod.imports` to the `stringGlobalMap` index, so its `module` is
    whatever `imports.ts:175-177` derived — it differs only if
    `hasLoneSurrogate` in `integration.ts` disagrees with the collector's call
    (two derivations, one source `string-surrogate.ts:26`). The native arm
    drops the `!ctx.nativeStrings` read at `:7357`, keeps the physical skips;
    `materializerForConst` unchanged. Attach through a NEW const-only pass
    `attachIrStringConstStorage(fn, storageForConst, materializerForConst)`
    in `string-support.ts` (the `string.const` arm of `:94-119` lifted
    verbatim) — **not `attachIrStringSupport`**, whose callable arm re-derives
    providers on a second pass (F2-S4 divergence 1, 4 corpus cells).
    Order-preservation (P2 proves it): the host arm reads what `:7314`
    registered — no mint; the native arm's `internNativeStringLiteral` and
    the oversized `pushDefinedFunc` now run after `prepareIrRuntimeManifest`
    + `prepareStringLength`, byte-neutral iff nothing in that window pushes a
    defined or import global (the oversized `funcIdx` is a late-resolved
    handle, census `2097203`). `providerRegistry.observe` (`:7389`) moves
    with it — from before `:3918` to inside it, still before
    `preregisterCallableProviders` (`:4034`) and long before `planRetained()`
    (`src/codegen/program-abi-finalization.ts:33`) seals the registry
    (`program-abi-provider-planning.ts:292-297`, `planning-sealed`).
    LONG12000 native cells and DUP are the fence.
13. `emitResolvedStringConst` (`:6576-6600`): **unchanged**; P3 measures the
    `extern.regex` reach, and retiring it needs the regex seam to carry storage.
14. Not touched: `:7307-7315`, `:7255`, `lower.ts:2254`/`:3561`/`:3566`,
    `wasmgc-emitter.ts:68`, `from-ast.ts`, `builder.ts:355`, every
    resolve-table arm, `registry/imports.ts`, `import-collector.ts`,
    `native-string-literals.ts`, `program-abi-*-planning.ts`.

**D. Adapters.** `linear-integration.ts` gains `stringConst: STRING_CONST_POLICY_DISABLED`
after the `stringLen` line of `:681-686` (import beside `:142`);
`stdlib-selfhost.ts` in `:508-512` (import beside `:77`) — both one line
lower on the F2-S5 branch. Neither freeze passes a const demand, so DISABLED
refuses nothing; linear `:739-746` is the `usesRepeat ? … : functions` ternary
whose `attachIrStringSupport` call (`:741-744`) keeps
`storageForConst: () => undefined` — it runs only when `usesRepeat`.

**E. Records.** `runtime-host-capabilities.ts` rows `:301-302` and `:71`
unchanged; ADD `resolveRuntimeHostCapabilityGlobalRecord` (item 9).
`RUNTIME_HOST_CAPABILITY_IDS` stays 18 (schema suite `:137`, same on the F2-S5 branch).

**F. Tests.** New `tests/issue-3526-string-boundary-const.test.ts`, anatomy
from the len suite:

- (a) contract — TWO feature rows; ONE new signature (`params []`, result
  externref; pin it is the only empty-params signature); FOUR provider ids;
  host rows name the two GLOBAL records (module + scheme); async projection and
  `projectRuntimeBackendRequirements` ignore all four; no `intrinsic`
  instruction (a literal-only module freezes nothing without the demand,
  exactly `["js.string.const"]` with `{literal, !utf16}`, both with a lone
  surrogate).
- (b) policy — host arm through the GLOBAL record, module and scheme
  published; native arm names the role, requests NO capability; refusal names
  `string-const` and `storage=`; omitted policy defaults closed and is
  published; independent of every sibling policy; a surrogate-free module's
  `hostCapabilityRecords` has `string.const` and NOT `string.const.utf16`; a
  regex-only module freezes `js.string.const` (the caveat, pinned).
- (c) end-to-end — host: ASCII binds `string_constants."hello"` at the SAME
  position (`"f"@0 "hello"@1 ""@2`); LONE keeps `sc@0 / sc16@1 / sc@2`; BOOLTPL
  keeps `wasm:js-string.concat`#0 ahead of `"true"`/`"false"`; **every
  `string.const` in a compiled host module carries `storage` after
  preparation** (`:6596` reach = 0 for `string.const` — the early-return
  pin); native: no `string_constants*` import, one `__strlit_N` for DUP's two
  uses, LONG12000 two chunk globals + a materializer; a runtime oracle on
  seven literals (`""`, ASCII, BMP, a valid pair, `"x\uD800y"` with `.length`
  3, 2000 chars, a literal shared by two functions) on host, native-strings
  and linear (ASCII subset — non-ASCII stays rejected there).
- (d) source pins on the NEW attach site — contains
  `preparedStringConstProvider(`, the exact-global error text,
  `hasLoneSurrogate(`; no `nativeStrings`; `prepareStrings`' source no longer
  contains `const storageForConst`; the partition block names `string-const policy`.
- (e) validation — `host-global` on a FUNC id, `host-global` omitting its
  capability from `hostCapabilities`, `native-global` requesting one: each
  throws; `role: "vec"` is a `@ts-expect-error`; `host-callable` on
  `string.const` STILL throws (the F2-S2 refusal is kept, not inverted).
- (f) the const-only pass — attaches storage / materializer, refuses both or a
  different binding (`:98-116` messages verbatim), no-op on `string.len` /
  `string.repeat` (the F2-S4 defect reduced to a unit).

Existing pins to move, each named: schema suite `PROVIDED_IDS` (`:93`) grows
both const ids; the `STILL_UNPROVIDED_IDS` fence (`:378`; 4 here, 3 on the
F2-S5 branch) reaches **0 once F2-S7 has landed** — replace it with "every
NEW_ID is named"; the `:560-600` fail-closed block STAYS and gains the twin
"a `host-global` row is admitted by `#indexProviders`"; the `:22` comment
("no provider names any of the six new rows") is rewritten; the defaults pins
`issue-3526-string-boundary-{compare:254,eq:290,len:346}.test.ts` (each `+1`
on the branch), `issue-3526-string-boundary-concat.test.ts:362` ("defaults an
omitted policy closed and publishes the resolved decision", branch only) and
`tests/issue-4104-ir-async-plan-runtime-consumer.test.ts:442-445` (`:442-446`
on the branch) gain `stringConst: { storage: "unsupported" }`. **Do NOT
move:** `tests/issue-3521-prepared-component-dependencies.test.ts:820`
(constructs `storageForConst` against the retained omnibus interface), schema
suite `:327`/`:352`, and every suite the census's `## pins` block lists as
pinning OUTPUTS (`imported-string-constants`, `issue-320`, `issue-1470`,
`native-strings{,-standalone}`, `issue-1174`/`2515`/`2880`,
`issue-3520-imported-global-abi:34-54`, the #3523 module-init suites,
`equivalence/global-index-shift-trycatch`, `ir/passes`, `ir/alloc-provenance`).

### Required pre-implementation probes (answers go in the checkpoint note)

- **P1 — the BEFORE byte matrix on the lane's own base, uninstrumented.**
  `census-string-const-matrix.mts` + BOOLTPL + REGEX = 90 cells. The 78
  census cells are expected to reproduce `census-string-const-matrix.md`
  exactly IF F2-S5/S6/S7's own V-A held on their trees (F2-S5's is not on
  main; F2-S6/S7 are plans only) — any difference is a finding about the
  predecessor, reported not absorbed. Record the 12 new cells (no census
  BEFORE exists). Re-measure the red set on the base: expected 0 in
  `imported-string-constants` / `issue-320` after #5465; name the residue.
- **P2 — the window, two questions.** (i) Between `prepareStrings`' return
  (`:3915`) and the new `prepareStringConst` call inside `:3918`: anything
  pushing `ctx.mod.globals`, adding an import global, or reading
  `string.const.storage`/`.materializer`? Grep `prepareIrRuntimeManifest`,
  `prepareStringLength`, `attachProviders`; expected none (F2-S4's P2 found
  only intrinsic readers). (ii) `observe` after the freeze: grep `.observe(`
  in `integration.ts` — expected `:6301`/`:6563` (inside
  `resolveAndObserveCallableProvider` `:6304-6565`, reached from `:4034` on)
  and `:7389` only, so the materializer's observation ORDINAL
  (`sealObservationOrder`, `program-abi-provider-planning.ts:546`) is
  unchanged; a wrong answer is a loud `planning-sealed` throw, never a silent
  byte diff. Decisive form for both: block moved + instrumented, LONG12000/DUP
  native cells byte-identical.
- **P3 — the fallback's real producer.** Temporary `throw` at `:6589-6600`,
  90 cells. Expected: every non-REGEX cell byte-identical with the throw in;
  REGEX/gc-host reaches `:6596` and REGEX/native `:6589` N times (N
  unmeasured — record it). N = 0 everywhere ⇒ retire the fallback in THIS
  slice — the sub-B retirement as measured in F2-S3's checkpoint P1 and
  F2-S4's checkpoint P3 (0 reaches, matrix byte-identical with the throw in)
  — and say so; N > 0 ⇒ item 13 stands.
- **P4 — mint timing and closed enumerations.** BOOLTPL with `:7314`
  instrumented: expected two `already:false` mints, thresholds 2→3, delta 1,
  still from `prepareStrings` — registration BEFORE the freeze, only the label
  moved. `grep -n resolveRuntimeHostCapabilityFuncRecord src/ir/*.ts` (six
  sites on main, seven after F2-S5) plus `asCallableRuntimeHostCapabilityRecord`
  — confirm none is on the `host-global` path. Grep tests for closed
  `implementation.kind` enumerations (F2-S4 P1 found none; F2-S5/S6/S7 may
  have added one) and for `hostCapabilityRecords` walks assuming func
  records — 11 files on main (`issue-3526-{boolean-boundary-intrinsic,boundary-residuals,generator-number-box,ir-runtime-manifest,number-boundary-intrinsics,string-boundary-compare,string-boundary-eq,string-boundary-len,string-boundary-schema}`, `issue-4103-ir-async-runtime-providers`, `issue-4104-ir-async-plan-runtime-consumer`).
- **P5 — layering and neutrality.** `check:ir-layering` with the
  `src/string-surrogate.ts` import in `integration.ts` (not `src/codegen/`;
  count unchanged); `check:ir-kind-neutrality` evidence that moves:
  `forof.string` `src/ir/integration.ts:6531` (`:6629` on the F2-S5 branch —
  already moved there); `string.const`'s own evidence is `src/ir/nodes.ts:1195`
  (declared `:1194`) — does not move, and its `neutral`/`core` verdict stays
  (the UTF-16 residual is not this slice's).

### Verification matrix

- **V-A** byte neutrality — 90/90 cells identical: bytes, sha256, full WAT,
  ordered import list with func/global indices parsed from the binary,
  `irOutcomes` (`trackIrOutcomes: true`), linear `getLastLinearIrReport()`
  text; `check:ir-fallbacks` diffed against a base run; the corpus
  (`website/playground/examples/**`, `examples/**`) × four WasmGC lanes.
- **V-B** pins — the new suite in full; the moved pins; instrumented AFTER
  tree: per-cell `storageForConst` host/native reach counts equal BEFORE, and
  `:6596` reach for `string.const` = 0 on every host cell.
- **V-C** non-vacuity, each revert independent against the kept schema: only
  the attachment move (restore `:7355-7392`, delete `prepareStringConst`) →
  the (d) pins fail; only the exact-global check → the (d) error-text pin and
  the LONE scheme pin; only the const-only pass (use `attachIrStringSupport`)
  → the (f) pins and the counted-native-repeat corpus cells (F2-S4's 4,
  re-measured); only the demand-in-conjunction line (item 8) → the (c)
  storage-carried pin (the early-return coupling, made visible); only the
  manifest rows → expect the F2-S4 shape (divergence 5): (a)/(b) AND every
  (c) pin, because after the move the frozen row is the only physical
  authority — record the count, do not predict it.
- **V-D** gates — the five ratchets bare AND under
  `LOC_GATE_BASE=$(git rev-parse origin/main)`; `typecheck`, `lint`,
  `prettier --check`; `pnpm run check:ir-dialect`, `check:ir-layering`,
  `check:ir-only` (a `.ts` script — run via `pnpm run`), `check:linear-ir`,
  `check:host-import-policy` (no new host import), `check:test-vacuity-shapes`,
  `check:ir-kind-neutrality` (surgical evidence refresh, no verdict moves),
  `check:ir-fallbacks` diffed against base.
- **LOC** — **unmeasured estimate** +420 net src LOC (two kinds + validation,
  four rows, two features, one signature, one record resolver, the demand
  pair, the moved block + `prepareStringConst`, the const-only pass); F2-S4's
  comparable shape landed at +381 against a +150 estimate — a floor.
  `runtime-manifest.ts` is 1967 here, 2131 on the F2-S5 branch, over the
  god-file threshold; grant in this file's frontmatter with a dated F2-S8
  rationale. **Never edit `scripts/*-baseline.json` for LOC.**

### Out of scope

The legacy pre-pass mint and its ordering (`import-collector.ts:1457`/`:1648`/`:1660`/`:1670`,
`imports.ts:130-192`/`:207-209`/`:321`, `src/codegen/statements/tdz.ts:120`,
`data-struct-host-bridge.ts:81`, `struct-field-exports.ts:1129`; the census
counted 352 `addStringConstantGlobal(` grep lines at `a07f`, 353 on
`5f13a35bc6` by `grep -rn "addStringConstantGlobal(" src` — definition and a
comment included, the drift unmeasured); the oversized materializer arm
(`:7382-7392`, `native-string-literals.ts:195`); storage width (`:7360-7363`,
`native-string-literals.ts:23`); the `extern.regex` no-storage path (item 13 /
P3); the module-init second pipeline (`prepareStrings` runs twice per compile
when module-init is claimed — the INIT cells check the demand is idempotent);
the linear ASCII-proof admission (`src/ir/analysis/linear-string-runtime.ts:13`);
`string.repeat`'s `:7255` read; the `nodes.ts:1195` UTF-16 residual; the other
`StringBackendEmitter`s (`src/ir/backend/porffor/sink.ts:401`,
`src/ir/backend/bytecode-emitter.ts:413`, `src/ir/backend/contract-conformance.ts:96`
— only `sink.ts` is under `porffor/`); multi-file builds
(`planProgramAbiStringConstantImport`, `program-abi-import-planning.ts:940`,
one entry source `:949-955`).

### After this slice (ranked)

| rank | boundary | why |
| --- | --- | --- |
| **next** | `extern.regex` literal storage | give pattern/flags a `storage` at attachment so `:6589`/`:6596` can be retired fail-closed and the regex-only row stops over-claiming; needs P3's count first |
| later | legacy host-literal mint → Program-ABI registration | the ORDER authority (`import-collector.ts:1670` under `:1660`, the `:7314` single-value helper, BOOLTPL's per-literal fixups); a registration seam, not a manifest one |
| later | oversized native literal as a manifest sub-arm | needs a kind that can name a minted-per-literal defined function; freezing would then depend on literal lengths — decide whether that is wanted at all |
| later | family-2 close-out | `STILL_UNPROVIDED_IDS` at 0; retire `IrStringSupportProviders.storageForConst` from the omnibus pass (3521:820, linear `:739-746`) once nothing else uses it |

## 2026-09-02 F2-S5 implementation plan — string.concat under manifest policy (family 2, slice 5)

Written by the Fable planning lane against `origin/main` `a7edf000ee` (F2-S3
merged; F2-S4 plan merged, F2-S4 implementation in flight on
`claude/issue-3526-f2s4-string-len`). Line numbers below are from that tree;
**the F2-S4 lane inserts a policy function near `:933`, a demand scan near
`:960`, a partition block near `:3760` and a post-freeze attachment near
`:1042`, so every `integration.ts` anchor below `:933` shifts by a few dozen
lines once it lands — re-anchor from the F2-S4 checkpoint note before editing.**
Dispatch this slice only after F2-S4 has merged: both touch the resolve-table
string block, the schema suite's `STILL_UNPROVIDED_IDS`, the frozen-policy
defaults pins and the adapter policy blocks.

### What moves and what does not (census, 65 cells)

The seam is `a + b` on two statically-string operands — the `string.concat`
IR instruction (`src/ir/nodes.ts:1219-1229`) with its `concatMode`
(`"immutable" | "owned-append"`, `src/ir/string-runtime.ts:16`) and a callable
provider attached unconditionally by `attachIrStringSupport`
(`src/ir/string-support.ts:62-63`: `owned-append` → `IR_STRING_CONCAT_OWNED_FN`,
else `IR_STRING_CONCAT_FN`). Producers: seven `emitStringConcat` sites in
`src/ir/from-ast.ts`; the two that can mint `owned-append` are the counted
builder loop (`:10338-10339`) and typed `+=` (`:11688-11689`), both licensed by
`collectOwnedStringAppendSymbols` (`src/ir/string-builder-shape.ts`).

Where the lane is read today:

| # | site | what it reads | fate |
| --- | --- | --- | --- |
| 1 | `src/ir/integration.ts:6371-6382`, the concat pair arm of the resolve table | `ctx.nativeStrings ? nativeStrHelperHandle(ctx, owned ? "__str_concat_owned" : "__str_concat") : exactCallableImportIndex(ctx, "wasm:js-string", "concat")` | **THE decision** — reads the frozen `stringConcat` policy (sub-A) |
| 2 | `src/ir/integration.ts:6764-6786`, the `emitStringConcat` adapter | the no-provider twin: `ctx.nativeStrings` → `__str_concat_owned` if registered and owned, else `__str_concat`; host → `stringBackend.hostImports.get("concat")` | **dead** — retire fail-closed (sub-B) |
| 3 | `src/ir/integration.ts:3574-3580`, the batched-concat pass selection | `hostBatchedConcat = !nativeStrings && !standalone && !wasi && !strictNoHostImports`; `standaloneBatchedConcat = nativeStrings && standalone && !wasi` → `batchStringConcat(fn, registry[, 8])` | **out of scope** — F2-S6 (see below) |
| 4 | `src/ir/integration.ts:6240-6262`, the `string.concat$arityN` / `async.string.concat$arity5` arms | `ctx.nativeStrings ? ensureNativeBatchedConcat(ctx, arity) : ensureLateImport(ctx, "__concat_N", …)` | **out of scope** — F2-S6 |
| 5 | `src/ir/backend/linear-integration.ts:1592-1609` (`emitStringConcat`, `owned-append` → `LINEAR_IR_STRING_APPEND_ASCII_FN`, else the planned `concatenate` operation) | no lane read | unchanged; the adapter declares the policy DISABLED (`:677-684`) |
| 6 | `src/codegen/stdlib-selfhost.ts:504-511` | policy block | gains `stringConcat: STRING_CONCAT_POLICY_DISABLED` |

Census — 13 fixtures × 5 lanes at `a7edf000ee`, instrumented at the resolve
arm (both symbols), every `emitStringConcat` branch, the many-arity arm, the
batch decision and the linear adapter. Driver / instrumentation / BEFORE
record:
`/tmp/claude-0/-home-user-js2/28d6498f-fc64-5f6d-952c-7075f472bc2f/scratchpad/f2s5-matrix.mts`,
`f2s5-instrument.py`, `f2s5-matrix-before.md` / `.json`. Fixtures:

| fixture | source |
| --- | --- |
| CAT | `return a + b;` |
| CAT3 | `return a + b + c;` |
| CAT4 | `return a + b + c + d;` |
| TPL | `` return `${a}!`; `` |
| TPL3 | `` return `${a}-${b}-${c}`; `` |
| APPEND | `let s = ""; for (let i = 0; i < n; i++) { s += "x"; } return s;` |
| APPENDREAD | same loop, but `k = k + s.length` inside it |
| APPENDPLUS | `out = out + parts[i]` over a `string[]` |
| TPLEQ | `` return `${a}!` === "hi!"; `` (F2-S3 control) |
| CATLEN | `return (a + b).length;` |
| CATNUM | `return a + n;` with `n: number` |
| EQ, CLEAN | F2-S3 controls |

What it measured:

- **Every WasmGC cell that carries a binary `string.concat` attaches a
  provider and emits through it** — `provider/immutable` or
  `provider/owned-append`; the adapter's three fallback branches were reached
  **0 times in 65 cells**.
- **The host arm collapses `owned-append` onto the immutable import.** APPEND
  on `gc-host` resolves `__ir_string_concat_owned` to the same
  `wasm:js-string.concat` (func 0) the immutable symbol uses; on the three
  native-strings lanes it resolves to `__str_concat_owned`. So the policy has
  ONE lane axis and the owned mode is a provider-row fact, not a policy fact.
- **The owned license is lane-independent and fragile in the expected way**:
  APPENDREAD (a `s.length` read inside the loop) drops to `immutable` on every
  lane; APPENDPLUS and CATNUM demote (`operand-coercion-unsupported`, an
  `any`-typed element / string+number operand) on every WasmGC lane before any
  concat is emitted — pre-existing, not this slice's.
- **Batching is a different seam with a different truth table.** On `gc-host`
  and `standalone` — and ONLY there — any single-use immutable tree of ≥3
  leaves is fused into one `string.concat$arityN` call (CAT3/CAT4/TPL/TPL3/
  TPLEQ), lowered to `env.__concat_N` minted **late** on host (func 0 in every
  fixture, func 1 in TPLEQ after `equals`) and to `__str_concat_N` on
  standalone (arity 3..8, `src/codegen/native-batched-concat.ts:20-21`).
  `gc-native-strings` and `wasi` never batch (pairwise `__str_concat`, 2/3/5
  calls); linear never batches. `owned-append` is never batched
  (`src/ir/passes/batch-string-concat.ts:15-19` admits only unprepared
  immutable nodes).
- Linear: `immutable=1` in every concat fixture, `owned-append=1` in APPEND,
  through its own runtime — the policy will be DISABLED there and, as with eq
  and len, the linear lane does not consult it.

Conformance yield is **zero by design**; the matrix must come back 65/65
byte-identical, and the many-arity cells are the regression fence for F2-S6 —
this slice must not move a single one of them.

### Why two features and one policy

The manifest decides WHICH authority answers; the owned mode decides WHICH
helper on that authority. Modelling that as two features under one policy
keeps the freeze honest (a module with no builder loop requests no owned
provider and its manifest says so) without pretending the host lane has an
owned import it does not have:

| feature | host row | native row |
| --- | --- | --- |
| `js.string.concat` | `host.js.string.concat` — `host-callable` on capability `string.concat` | `native.js.string.concat` — `runtime-callable` `__str_concat` |
| `js.string.concat.owned` | `host.js.string.concat.owned` — `host-callable` on the SAME capability `string.concat` (documented collapse) | `native.js.string.concat.owned` — `runtime-callable` `__str_concat_owned` |

Policy `StringConcatPolicy { readonly concat: "host" | "native" | "unsupported" }`
selects the arm for BOTH features (`stringConcatProviderId(feature, policy)`
returns the owned or plain id by feature). Two host rows naming one capability
is new but legal: `#indexProviders` keys providers by id and hostCapabilities
by capability id (a set) — probe P1 confirms nothing asserts one-row-per-
capability.

**Signature: mint ONE new constant.** The `string.concat` record is
`["externref","externref"] -> ["ref_extern"]` (`src/ir/runtime-host-capabilities.ts:295`,
the only `ref_extern` row, pinned by the schema suite's "only concat uses it"
test `:185-192`). No existing `IntrinsicSignature` has that result, so add
`EXTERNREF_PAIR_TO_REF_EXTERN_INTRINSIC_SIGNATURE` to `src/ir/intrinsics.ts`
beside `:287-291` — `params [EXTERNREF_TYPE, EXTERNREF_TYPE]`, result
`{ kind: "val", val: { kind: "ref_extern" } }` (the `ValType` union already
has `ref_extern`, `src/ir/types.ts:275`). Both native rows reuse it nominally,
as `native.js.string.eq` reuses the externref pair: the signature is the seam's
semantic shape, and `__str_concat` / `__str_concat_owned` physically take and
return `ref $AnyString` (`native-strings-basics.ts:283`).

`__str_concat_owned` is always registered together with `__str_concat`
(`emitStrConcatOwnedHelper` is the final step of `emitStrConcatHelpers`,
`native-strings-basics.ts:240-285`), so the resolve arm's
`ensureNativeStringHelpers` + `nativeStrHelperHandle` pair serves both rows
unchanged; the adapter's "unregistered helper falls through" comment
(`:6769-6771`) describes a state the census never reached — that is what
sub-B retires.

### Contract (F2-S3's edit list, with the concat-specific deltas)

**A. `src/ir/runtime-manifest.ts`**

1. `StringConcatPolicy { readonly concat: "host" | "native" | "unsupported" }`
   and frozen `STRING_CONCAT_POLICY_DISABLED`, after the `stringLen` sibling
   F2-S4 adds (after `STRING_EQ_POLICY_DISABLED` `:222-224` on this tree).
2. `RuntimeManifestPolicy.stringConcat?` (`:258` sibling),
   `FrozenRuntimeManifestPolicy.stringConcat` (`:268`), canonicalization
   `:1352-1361` (`stringConcat: Object.freeze({ concat: stringConcat.concat })`).
3. `STRING_CONCAT_RUNTIME_FEATURES = ["js.string.concat", "js.string.concat.owned"]`,
   `STRING_CONCAT_RUNTIME_PROVIDER_IDS` (the four ids above) and their types;
   splice into `RuntimeFeature` (`:72`), `RuntimeProviderId` (`:387-396`), the
   `numberBoundaryProvider` id/feature unions (`:653-667`), `RUNTIME_PROVIDERS`
   (`:1122`) and `RUNTIME_FEATURES` (`:1134`).
4. The four provider rows via `numberBoundaryProvider(id, feature, EXTERNREF_PAIR_TO_REF_EXTERN_INTRINSIC_SIGNATURE, implementation, hostCapabilities)`
   — host rows `["string.concat"]`, native rows `[]`.
5. `stringConcatProviderId(feature, policy)`, `isStringConcatFeature`, and a
   `#selectProvider` branch after F2-S4's len branch (after `:1735-1750` on this
   tree), refusal text
   `` `runtime feature ${feature} is unavailable under string-concat policy concat=${this.#policy.stringConcat.concat}` ``.
   No new validation rules — both implementation kinds already exist.

**B. `src/ir/intrinsic-support.ts`**

6. `stringConcatDemand?: { readonly immutable: boolean; readonly owned: boolean }`
   on the prepare input (sibling of `:449`); the early-return conjunction
   (`:483-489`) treats either flag as demand; `requestFeature` per flag
   (`:498` siblings). Both feature constants beside `:323`.
7. `preparedStringConcatProvider(prepared, mode: IrStringConcatMode)` — sibling
   of `preparedStringEqProvider` (`:341-368`) — finds the provider whose
   `feature` is the mode's feature and returns
   `{ arm: "host"; module; field } | { arm: "native"; symbol } | undefined`.

**C. `src/ir/integration.ts`**

8. `integrationStringConcatPolicy(ctx)` =
   `Object.freeze({ concat: ctx.nativeStrings ? "native" : "host" })` beside
   `:931-933` — the exact fact `:6375` reads today. Wire into the freeze policy
   (`:1016` sibling) and the partition loop (`:3683` sibling; block beside
   `:3759`: `stringConcatPolicy.concat === "unsupported"` and either demand →
   `late-preparation-unsupported` "string concatenation has no provider under string-concat policy concat=…").
9. `irStringConcatDemand(fns)` — one scan returning both flags from
   `instr.concatMode ?? "immutable"`, sibling of `irStringEqDemand`
   (`:943-959`); passed as `stringConcatDemand` beside `:1027`.
10. **The resolve arm** (`:6371-6382`) keeps its two-symbol condition and its
    two routines, and swaps only the decision:
    `const arm = preparedStringConcatProvider(prepared, symbol === IR_STRING_CONCAT_OWNED_FN ? "owned-append" : "immutable")`;
    `!arm` → `IrInvariantError("selection-preparation-mismatch", "resolve", "string concatenation has no frozen provider under the string-concat policy")`;
    native → `ensureNativeStringHelpers(ctx); index = nativeStrHelperHandle(ctx, arm.symbol)`;
    host → `index = exactCallableImportIndex(ctx, arm.module, arm.field)` —
    never `funcMap` (#1072 shadowing), never `ensureLateImport` (the five-import
    block is minted pre-Phase-3; a late registration here shifts every defined
    funcidx). No `ctx.nativeStrings` in the arm.
11. `emitStringConcat` (`:6764-6786`): keep the provider branch verbatim;
    replace everything after it with
    `throw new Error("ir/integration: string.concat has no prepared runtime provider")`
    — after P3's zero-reach measurement. The `_alloc` and `mode` parameters
    stay (the contract `src/ir/lower.ts:296` is shared with linear, which uses
    `mode`).
12. Not touched: `:3574-3580` (batch selection), `:6240-6262` (many-arity
    arms), `string-support.ts:62-63` (the mode → symbol mapping is the
    producer's, and it is what the demand scan mirrors), every other
    resolve-table arm, `src/ir/from-ast.ts`, `src/ir/string-builder-shape.ts`,
    `src/ir/passes/batch-string-concat.ts`.

**D. Adapters.** `src/ir/backend/linear-integration.ts:682` gains
`stringConcat: STRING_CONCAT_POLICY_DISABLED` (import beside `:141`);
`src/codegen/stdlib-selfhost.ts:509` the same (import beside `:76`). Neither
freeze passes a concat demand, so DISABLED refuses nothing there — the linear
lane keeps lowering `+` and `+=` through its own runtime (the "ignores the
provider" pin pattern from F2-S3/F2-S4).

**E. `src/ir/runtime-host-capabilities.ts`** — no change (row `:295`).

**F. Tests.** New `tests/issue-3526-string-boundary-concat.test.ts`, anatomy
from the eq suite (`tests/issue-3526-string-boundary-eq.test.ts:194-561`):

- (a) contract — TWO feature rows; ONE new signature constant with params
  `[externref, externref]` and result `ref_extern` (and a pin that it is the
  only signature with that result); FOUR provider ids; the two host rows name
  the SAME capability and the async projection excludes it by id; no
  `intrinsic` instruction (an `a + b`-only module freezes no manifest without
  the demand, freezes exactly `["js.string.concat"]` with it, and a builder
  loop freezes both features).
- (b) policy — host arm through the record, MODULE included, for both modes;
  native arm on `__str_concat` / `__str_concat_owned` requesting NO host
  capability; refusal names `string-concat` and the policy value; default
  closed and published; independent of eq / len / compare and every family-1
  arm; no row when nothing concatenates; **a module with only an immutable
  concat requests no owned provider** (the manifest's `providers` list is
  exactly one row).
- (c) end-to-end — host lane binds the existing `wasm:js-string.concat` in the
  same position for BOTH modes (CAT → func 0; APPEND → func 0 through the
  owned symbol); native-strings lanes call `__str_concat` for CAT and
  `__str_concat_owned` for APPEND with no `wasm:js-string` import; a runtime
  oracle for `+`, `+=` in a builder loop, and a template on seven input pairs
  (empty × empty, empty × ascii, surrogate halves that combine, a 1000-char
  builder loop, non-ASCII BMP, a numeric-looking string, a concatenation whose
  result is then compared) on host, native-strings and linear lanes; the
  many-arity cells (CAT3, TPL) stay byte-identical on `gc-host` and
  `standalone` — the F2-S6 fence, pinned by sha against the BEFORE record's
  values for those two fixtures; linear still lowers both modes.
- (d) source pins on the arm — contains `preparedStringConcatProvider(`, no
  `nativeStrings`, no `hostImports`, no `funcMap`, no `ensureLateImport`,
  contains `exactCallableImportIndex(ctx, arm.module, arm.field)`, still names
  both symbols in its condition; the partition block names `string-concat policy`.
- (e) sub-B — the emitter refuses an unattached `string.concat`
  (`ir/integration: string.concat has no prepared runtime provider`), accepts
  an attached one in either mode, and its source contains neither
  `nativeStrings` nor `hostImports.get("concat")` nor `__str_concat_owned`.

Existing pins to move (each a deliberate, named edit): the schema suite's
"keeps the CONCAT resolve arm on ctx.nativeStrings" (`:641-655`) is INVERTED
into the new suite and deleted from the schema suite — that was its stated
purpose ("what stops F2-S5 from being mistaken for having landed"); the
"no provider names any of the five/four still-unprovided capabilities" fence
(`STILL_UNPROVIDED_IDS`, `:92` / `:376`) shrinks by `string.concat` and asserts
positively that it IS named; the frozen-policy defaults pins in the compare,
eq and len suites and the whole-shape policy equality in
`tests/issue-3526-ir-runtime-manifest.test.ts` gain
`stringConcat: { concat: "unsupported" }`.
`tests/issue-3744-ir-owned-append-string-builder.test.ts` pins the owned
helper's BEHAVIOUR and must not move; if any of its assertions reads the arm's
source, that is a finding for the checkpoint, not a pin to weaken.

### Required pre-implementation probes (answers go in the checkpoint note)

- **P1** — two host provider rows on one capability: grep `runtime-manifest.ts`
  and the #3526 suites for any assertion that `hostCapabilities` or the
  capability → provider projection is one-to-one (`#indexProviders`,
  `hostCapabilityRecords`, `resolveRuntimeHostCapabilityFuncRecord` callers).
  Expected: sets keyed by capability id, no uniqueness assertion. If one
  exists, model the owned host row as the SAME provider id selected for both
  features instead — record which.
- **P2** — the `mode` axis at resolve time: confirm the arm receives the
  intrinsic SYMBOL and nothing else (`ref.binding.symbol`), so the mode must be
  recovered from the symbol as item 10 does, and confirm no other consumer of
  `IR_STRING_CONCAT_OWNED_FN` exists (`grep -rn` — expected: `string-support.ts`
  and the arm only).
- **P3** — zero-reach of the retired fallbacks: a temporary `throw` in place of
  `:6768-6786`, the 65-cell matrix (byte-identical with the throw in) and the
  string suites: `strings`, `native-strings` ×2, `host-string-prefix-suffix-fast-path`,
  #3744 owned-append, #3740, #1210, #1761, #2160, #2163, #2598/2599, #1470,
  #1899 funcidx authority, the three #3526 string suites plus F2-S4's len suite,
  `issue-320`, `imported-string-constants`. The 17 reds
  [#5274](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5274-standing-red-tests-string-and-3529-suites)
  names must not grow — measure them on the grounding tree first.
- **P4** — the BEFORE half of the byte matrix, re-measured on the lane's own
  base (post-F2-S4 main) before the first edit, WITHOUT the instrumentation.
  It will differ from `f2s5-matrix-before.md` only where F2-S4 moved bytes —
  expected nowhere, since F2-S4 is byte-neutral by its own V-A; any difference
  is a finding about F2-S4, to be reported, not absorbed.

### Verification matrix

- **V-A** byte neutrality — 65/65 cells identical (bytes, sha256, ordered
  import list with indices, demotions), the many-arity cells included;
  `check:ir-fallbacks` diffed against a base-tree run (byte-identical; the
  `string-builder-candidate` bucket stays at its baseline count of 2); corpus
  compile on both trees.
- **V-B** pins — the new suite in full, the moved pins, #3744 untouched and
  green.
- **V-C** non-vacuity, each revert independent against the kept schema: revert
  only the arm → exactly the (d) pins fail; revert only the retirement →
  exactly the (e) refusal pin fails; revert only the manifest rows → (a)/(b)
  fail and the (c) host-lane import-position pins still pass.
- **V-D** gates — the five ratchets bare AND under
  `LOC_GATE_BASE=$(git rev-parse origin/main)`; `typecheck`, `lint`,
  `prettier --check`; `check:ir-dialect`, `check:ir-layering`, `check:ir-only`,
  `check:linear-ir`, `check:host-import-policy` (the host import set does not
  change — no new `env` import, no new builtin), `check:test-vacuity-shapes`,
  `check:ir-kind-neutrality` (evidence lines below the inserted functions move
  again: `forof.string` in `integration.ts`; refresh surgically by sorted-leaf
  diff, no verdict moves — `string.concat` stays `neutral`).
- **LOC** — estimate +170 net src LOC (four rows, two features, one signature
  constant, one demand pair). Grant in this file's frontmatter with a dated
  rationale; never edit `scripts/*-baseline.json` for LOC.

### Out of scope

The batched many-arity family — **F2-S6**: the pass selection at
`:3574-3580` (four lane flags, arity cap 8 on standalone, unbounded on host),
the `string.concat$arityN` / `async.string.concat$arity5` arms at
`:6240-6262`, the `env.__concat_N` LATE import (the only late-minted `env`
import left in the string block; the legacy twin is
`src/codegen/string-ops.ts:1830-1862`), and `ensureNativeBatchedConcat`
(`src/codegen/native-batched-concat.ts:37`). It needs two things this slice
does not have: a capability record for a variadic `env` family (an
arity-derived field scheme on a FUNC record — F2-S2's global schemes are the
precedent) and a policy over a PASS, not a provider. The census rows for it
are already in `f2s5-matrix-before.md`. Also out: `charCodeAt`,
`string.const`, `stringMethodPlan`, `String()` coercion, the
`operand-coercion-unsupported` demotions (APPENDPLUS, CATNUM), the
`string-builder-candidate` selection bucket, `src/ir/from-ast.ts`.

### After this slice (ranked)

| rank | boundary | why |
| --- | --- | --- |
| **F2-S6** | batched many-arity concat | last lane reads in the string block; needs a variadic `env` record scheme + a pass policy |
| later | `charCodeAt` | two-record `host-capability` provider behind a defined helper (`char-code-at-helpers.ts`) |
| later | `string.const` | global kind, derived field, two namespaces, oversized materializer, legacy pre-pass ordering |

(Filed while the F2-S4 implementation was in flight and placed ABOVE the F2-S4
section on purpose: the F2-S4 lane appends its checkpoint note at the end of
this file, and an insertion here keeps that append conflict-free.)

## 2026-09-02 F2-S4 implementation plan — string.len under manifest policy (family 2, slice 4)

Written by the Fable planning lane against PR #5448's head `469fd03e` (F2-S3
merged state). Every line number below is from that tree. Implementer: an Opus
lane, working from this plan; measurements first, edits second.

### What moves and what does not (census, 60 cells)

The seam is `s.length` — the `string.len` IR instruction (`src/ir/nodes.ts:1251-1257`)
and its two-armed provider `IrStringLengthProvider` (`nodes.ts:1260-1272`):
`callable` (the host `wasm:js-string.length` builtin import) or `struct-field`
(native `$AnyString` field 0, the UTF-16 code-unit count). Unlike the compare and
the eq, **there is no resolve-table arm at all** — `string.len` is not a callable
symbol, so nothing in `resolveAndObserveCallableProvider` names it. The lane is
read in exactly two places, and one of them is dead:

| # | site | what it reads | fate |
| --- | --- | --- | --- |
| 1 | `src/ir/integration.ts:7225-7237`, inside `prepareStrings` (`:7112`) | `ctx.nativeStrings ? {struct-field, carrierRef, 0} : {callable, irImportFuncRef("wasm:js-string","length","length")}` — with the exact-import check through `catalogProgramAbiCallableImports` | **THE decision.** Moves behind the frozen manifest (sub-A + the attachment move) |
| 2 | `src/ir/integration.ts:6814-6831`, the `emitStringLen` adapter | the no-provider twin: `ctx.nativeStrings && ctx.anyStrTypeIdx >= 0` → `struct.get`, else `stringBackend.hostImports.get("length")` | **dead** — retire fail-closed (sub-B) |
| 3 | `src/ir/backend/linear-integration.ts:741` (`providerForLength: () => undefined`) and `:1625-1629` (`emitStringLen` → `__str_length_utf16`, ignores the provider) | no lane read | unchanged; the adapter declares the policy DISABLED (`:677-683`) exactly as it does for `stringEq` |
| 4 | `src/codegen/stdlib-selfhost.ts:504-510` | policy block | gains `stringLen: STRING_LEN_POLICY_DISABLED` |

**Ordering fact that shapes the whole slice:** `prepareStrings` runs at `:3794`,
**before** the manifest freeze at `:3797` (`prepareBuiltFnRuntimeManifest`,
`:1005-1045`). The eq's provider is attached in the same `attachIrStringSupport`
pass but is only *materialized* later, at resolve time, where `prepared` is in
scope; `string.len`'s provider is materialized **at attachment** — the
`IrStringLengthProvider` carried on the instruction IS the physical choice. So
"read the frozen manifest" here means the attachment itself has to move after
the freeze. That is the one structural edit of this slice (contract item 12).

Census — 12 fixtures × 5 lanes at `469fd03e`, instrumented at the decision
(`:7225`), the registry gate (`:7223`), the attach pass
(`string-support.ts:121`), every `emitStringLen` branch (`:6814`) and the linear
adapter (`:1625`). Driver and instrumentation:
`/tmp/claude-0/-home-user-js2/28d6498f-fc64-5f6d-952c-7075f472bc2f/scratchpad/f2s4-matrix.mts`
and `f2s4-instrument.py`; full table `f2s4-matrix-before.md` / `.json`
(sha256, bytes, ordered import list with func/global indices, demotions). The
fixtures, so the matrix can be rebuilt without the scratchpad:

| fixture | source |
| --- | --- |
| LEN | `export function len(s: string): number { return s.length; }` |
| LENCMP | `export function big(s: string): boolean { return s.length > 3; }` |
| LENEQ | `export function same(a: string, b: string): boolean { return a.length === b.length; }` |
| LENLOOP | `let n = 0; for (let i = 0; i < s.length; i++) { n = n + s.charCodeAt(i); } return n;` |
| LENIDX | `export function last(s: string): string { return s.charAt(s.length - 1); }` |
| TPLLEN | ``export function tpl(a: string): number { return `${a}!`.length; }`` |
| CONCATLEN | `export function cl(a: string, b: string): number { return (a + b).length; }` |
| LENCONST | `export function k(): number { return "hello".length; }` |
| FOROFLEN | `let n = 0; for (const ch of s) { n = n + ch.length; } return n;` |
| LENSTMT | `const n = s.length; if (n === 0) return -1; return n * 2;` |
| EQ | F2-S3's `a === b` control |
| CLEAN | number-only control |

Lanes: `gc-host` `{}`, `gc-native-strings` `{nativeStrings:true}`, `standalone`,
`wasi`, `linear`.

What it measured:

- **Every WasmGC cell that carries a `string.len` attaches exactly one provider,
  and its kind is the lane's**: `gc-host` → `callable` on the
  `wasm:js-string.length` import (func index **0** in nine fixtures, **1** in
  CONCATLEN where `concat` is registered first — pin that); the three
  native-strings lanes → `struct-field`. Attach count equals emit count in every
  cell (LENEQ: 2/2).
- **The adapter fallback (`:6824-6830`) was reached 0 times in 60 cells.** Only
  `callable=` / `struct-field=` branches fired. The registry gate never
  short-circuited (`len-no-registry` 0).
- The decision fires once per compile and reports `usesStringLen` false on the
  two controls — the `if (usesStringLen)` guard is the only reason an
  eq-only/clean module has no length provider.
- Linear: `__str_length_utf16` fired once in 6 fixtures. The other linear cells
  are pre-existing and not this slice's: LENLOOP and LENIDX **fail to compile on
  linear on the grounding tree** (`Unsupported method call: .charCodeAt()` /
  `.charAt()`), TPLLEN/CONCATLEN/FOROFLEN take no IR `string.len` on linear.
- FOROFLEN `gc-host` demotes `count` with `property-access-unsupported`
  (`ch.length` on a for-of character) — pre-existing, 0 attaches in that cell.

Conformance yield is **zero by design**, as for every family-2 slice: the
manifest decides *which* authority answers, both authorities already exist, and
the matrix must come back 60/60 byte-identical.

### Why the native arm needs new provider vocabulary

`RuntimeProviderImplementation` (`src/ir/runtime-manifest.ts:397-452`) has two
callable arms (`host-callable` on a capability record, `runtime-callable` on a
symbol), three intrinsic-only backend arms (`backend-op` / `backend-sequence` /
`backend-composite`), `self-hosted`, and the three async arms
(`host-capability` / `host-managed` / `native-managed`). The native length
provider is none of these: it is a **field read on the Program-ABI string
carrier** — `registry.stringCarrierRef()` =
`irSupportTypeRef(entry, "string-carrier", "__string_carrier")`
(`src/codegen/program-abi-type-planning.ts:433-435`), whose physical type is
planned later by `prepareStringCarrier()` (`:445-455`).

Add one kind:

```ts
| {
    /** (#3526 F2-S4) A field read on a Program-ABI support carrier. */
    readonly kind: "carrier-field";
    readonly carrier: "string";
    readonly fieldIndex: number;
  }
```

Symbolic on purpose: the manifest names the ABI **role** (`"string"`) and the
field; the consumer resolves the role to `registry.stringCarrierRef()` at
attachment. Never a raw `ctx.anyStrTypeIdx` — the manifest is frozen before the
physical carrier is planned, and a type index in a frozen manifest would be a
lie the next lane has to discover.

Every consumer that switches on `implementation.kind`, enumerated so the lane
does not have to re-find them:

| site | behaviour with the new kind |
| --- | --- |
| `src/ir/intrinsic-support.ts:80-84` (callable pre-registration) | `continue`s on any kind but the two callables — skipped by construction, no edit |
| `intrinsic-support.ts:220-236` (intrinsic provider binding) | unreachable: `string.len` has no `intrinsic` instruction; the `IntrinsicRuntimeProviderImplementation` `Extract` (`runtime-manifest.ts:459-470`) must NOT list the new kind, so the static type keeps it out |
| `runtime-manifest.ts:454-457` `MathRuntimeProviderImplementation` | not listed |
| `runtime-manifest.ts:495-510` `projectRuntimeBackendRequirements` | only the managed kinds matter; falls through `continue` |
| `intrinsic-support.ts:532-535`, `src/ir/async-plan.ts:418-420` | async projection, managed kinds only |
| `src/ir/math-runtime-providers.ts:19`, `integration.ts:6205` | `self-hosted` only |
| `runtime-manifest.ts:1588-1631` validation | **add** three rules: a `carrier-field` provider requests no host capability; `carrier === "string"`; `fieldIndex` is a non-negative safe integer |

### Contract (F2-S3's edit list, with the len-specific deltas)

**A. `src/ir/runtime-manifest.ts`**

1. `StringLenPolicy { readonly len: "host" | "native" | "unsupported" }` and a
   frozen `STRING_LEN_POLICY_DISABLED`, placed after `STRING_EQ_POLICY_DISABLED`
   (`:222-224`). Doc: family 2's third sibling; same one-flag truth table; the
   physical pair is a builtin import vs a struct field — the manifest's first
   non-callable native arm.
2. `RuntimeManifestPolicy.stringLen?` (`:258` sibling),
   `FrozenRuntimeManifestPolicy.stringLen` (`:268`), canonicalization at
   `:1352-1361` (`stringLen: Object.freeze({ len: stringLen.len })`).
3. `STRING_LEN_RUNTIME_FEATURES = ["js.string.len"]`,
   `STRING_LEN_RUNTIME_PROVIDER_IDS = ["host.js.string.len", "native.js.string.len"]`
   and their types; splice into `RuntimeFeature` (`:72`), `RuntimeProviderId`
   (`:387-396`), the `numberBoundaryProvider` id/feature unions (`:653-667`),
   `RUNTIME_PROVIDERS` (`:1122`) and `RUNTIME_FEATURES` (`:1134`).
4. The `carrier-field` implementation kind (above), on the union at `:397-452`
   only.
5. `STRING_LEN_RUNTIME_PROVIDERS`:
   - `numberBoundaryProvider("host.js.string.len", "js.string.len", EXTERNREF_TO_I32_INTRINSIC_SIGNATURE, { kind: "host-callable", capability: "string.len" }, ["string.len"])`
   - `numberBoundaryProvider("native.js.string.len", "js.string.len", EXTERNREF_TO_I32_INTRINSIC_SIGNATURE, { kind: "carrier-field", carrier: "string", fieldIndex: 0 }, [])`

   **Signature reuse, not a new constant.** `EXTERNREF_TO_I32_INTRINSIC_SIGNATURE`
   (`src/ir/intrinsics.ts:275-279`, F1-S4's `__extern_is_undefined`) is exactly
   the `wasm:js-string.length` record ABI (`runtime-host-capabilities.ts:304`,
   `["externref"] -> ["i32"]`). The native row reuses it nominally, exactly as
   `native.js.string.eq` reuses the externref pair for `__str_equals`: the
   signature is the seam's semantic shape, not the physical `struct.get`.
6. `stringLenProviderId(policy)`, `isStringLenFeature`, and a `#selectProvider`
   branch after the eq branch (`:1735-1750`), refusal text
   `` `runtime feature ${feature} is unavailable under string-len policy len=${this.#policy.stringLen.len}` ``.
7. The three validation rules (table above) next to `:1607-1631`.

**B. `src/ir/intrinsic-support.ts`**

8. `stringLenDemand?: boolean` on the prepare input (sibling of `:449`), in the
   early-return conjunction (`:483-489`) and the `requestFeature` line (`:498`);
   `STRING_LEN_RUNTIME_FEATURE` const beside `:323`.
9. `preparedStringLenProvider(prepared)` — sibling of `preparedStringEqProvider`
   (`:341-368`) — returning
   `{ arm: "host"; module; field } | { arm: "native"; carrier: "string"; fieldIndex } | undefined`.
   Host via `resolveRuntimeHostCapabilityFuncRecord`; native reads
   `implementation.kind === "carrier-field"`; anything else throws
   `` `IR string-len provider ${provider.id} is not a length implementation` ``.

**C. `src/ir/integration.ts`**

10. `integrationStringLenPolicy(ctx)` =
    `Object.freeze({ len: ctx.nativeStrings ? "native" : "host" })` after
    `:931-933` — the exact fact `:7226` reads today. Wire into the freeze policy
    (`:1016` sibling) and into the partition loop: compute it beside `:3683`,
    and add the block beside `:3759`:
    `stringLenPolicy.len === "unsupported" && irStringLenDemand([entry.fn])` →
    `IrUnsupportedError("late-preparation-unsupported", "resolve", "ir/integration: string length has no provider under string-len policy len=…")`.
11. `irStringLenDemand(fns)` — a `string.len` instruction scan, sibling of
    `irStringEqDemand` (`:943-959`); passed as `stringLenDemand` beside `:1027`.
12. **Move the attachment behind the freeze.** `prepareStrings` (`:7112`) keeps
    everything else — the `usesStringLen` scan (`:7122`, `:7129`), the host
    import pre-registration, the registry gate (`:7222-7223`), the carrier
    attach and `prepareStringCarrier()` (`:7295`) — but `providerForLength`
    (`:7286`) becomes `() => undefined` and the `lengthProvider` block
    (`:7225-7237`) is deleted. A new `prepareStringLength(ctx, entries, runtime)`
    runs inside `prepareBuiltFnRuntimeManifest` right after `preparedEntries` is
    built (`:1031-1041`) and before `materializePreparedMathProviders` (`:1042`):
    - `const arm = preparedStringLenProvider(runtime)`; `undefined` (no demand)
      → return `entries` unchanged.
    - `!ctx.programAbiTypes` → return unchanged (today's `:7223` skip, kept).
    - host → `target = irImportFuncRef(arm.module, arm.field, arm.field)`, then
      the SAME exact-import check as today (`catalogProgramAbiCallableImports(ctx).get(irCallableBindingKey(target.binding))`,
      `desc.kind === "func"`) with the SAME error text
      `ir/integration: prepared string.len has no exact wasm:js-string.length import`;
      provider `{ kind: "callable", target }`.
    - native → `{ kind: "struct-field", ownerType: ctx.programAbiTypes.stringCarrierRef(), fieldIndex: arm.fieldIndex }`.
    - `attachIrStringSupport(fn, { storageForConst: () => undefined, providerForLength: () => provider })`
      over every entry — the exact call shape `linear-integration.ts:739-745`
      already uses. The `string.const` arm is a no-op when storage and
      materializer are both undefined (`string-support.ts:96-119`); the
      `string.len` arm attaches only when unattached (`:121-131`), so the pass is
      idempotent.

    Order-preservation argument: today the provider is attached at `:7283-7293`
    (before the freeze); after the move it is attached at the end of the
    freeze. Nothing in between reads `string.len.provider` —
    `prepareIrRuntimeManifest` collects `intrinsic` uses only
    (`intrinsic-support.ts:451-476`) and lowering reads the provider at
    `src/ir/lower.ts:2281-2285`, long after. Probe P2 confirms. Byte-neutral by
    construction; V-A proves it.
13. `emitStringLen` (`:6814-6831`): keep the `callable` and `struct-field`
    branches verbatim; replace the two fallbacks (`:6824-6830`) with
    `throw new Error("ir/integration: string.len has no prepared runtime provider")`
    — the F2-S3 sub-B pattern, after P3's zero-reach measurement.
14. Not touched: every resolve-table arm (`:6186-6410`), `stringMethodPlan`,
    `stringForOfPlan` / `charReadPlan`, `emitStringCharAt` (`:6832-`), the
    #3931 hoist arms, `src/ir/from-ast.ts`.

**D. Adapters.** `src/ir/backend/linear-integration.ts:682` gains
`stringLen: STRING_LEN_POLICY_DISABLED` (import beside `:141`);
`src/codegen/stdlib-selfhost.ts:509` the same (import beside `:76`). The linear
freeze passes no demand, so a DISABLED policy refuses nothing there — the linear
lane keeps lowering `.length` through `__str_length_utf16` exactly as it keeps
lowering `===` (the F2-S3 "ignores the provider" pin).

**E. `src/ir/runtime-host-capabilities.ts`** — no change; the `string.len` row
(`:304`) exists since F2-S2.

**F. Tests.** New `tests/issue-3526-string-boundary-len.test.ts`, anatomy from
the eq suite (`tests/issue-3526-string-boundary-eq.test.ts:194-561`):

- (a) contract — ONE feature row; REUSES `EXTERNREF_TO_I32_INTRINSIC_SIGNATURE`
  (params `[externref]`, result `I32`); two-armed; carries NO intrinsic
  instruction (an `.length`-only module freezes no manifest without the demand,
  and freezes exactly `["js.string.len"]` with it); names the F2-S2 record
  (`wasm:js-string` / `length` / `["externref"] -> ["i32"]`) and the async
  projection excludes it by id.
- (b) policy — host arm through the record, MODULE included; native arm is
  `carrier-field` `{carrier:"string", fieldIndex:0}` requesting NO host
  capability (`hostCapabilities` `[]`); refusal names `string-len` and the
  policy value; omitted policy defaults closed and the frozen manifest publishes
  it; independent of eq / compare / every family-1 arm; no row when nothing
  reads `.length`.
- (c) end-to-end — host lane binds the existing `wasm:js-string.length` import
  **in the same position** (LEN: func 0; CONCATLEN: func 1 after `concat`);
  native-strings lanes emit `struct.get` on the string carrier field 0 with no
  `wasm:js-string` import at all; a runtime oracle for `.length` on seven inputs
  (`""`, ASCII, a surrogate pair counting **2**, a BMP non-ASCII string, a
  1000-char string, a concatenation result, a template result) on host,
  native-strings and linear lanes; linear still lowers `.length` (the policy is
  DISABLED there, and it does not care).
- (d) source pins on the NEW attach site — contains
  `preparedStringLenProvider(`, contains the exact-import error text, contains
  no `nativeStrings` and no `anyStrTypeIdx`; `prepareStrings`'s source no longer
  contains `lengthProvider`; the partition block names `string-len policy`.
- (e) sub-B — the emitter refuses an unattached `string.len`
  (`ir/integration: string.len has no prepared runtime provider`), accepts an
  attached one of either kind, and its source contains neither `nativeStrings`
  nor `hostImports.get("length")`.
- (f) validation — a `carrier-field` provider that requests a host capability
  throws `unknown-host-capability`; `fieldIndex: -1` throws; `carrier: "vec"`
  is a compile error (type-level pin via `@ts-expect-error`).

Existing pins to move (each is a deliberate edit, named in the checkpoint):
`tests/issue-3526-string-boundary-schema.test.ts:92` `STILL_UNPROVIDED_IDS`
shrinks by `string.len` and the `:376` pin asserts positively that `string.len`
IS now named; the defaults pins in `issue-3526-string-boundary-compare.test.ts`
and `issue-3526-string-boundary-eq.test.ts:289-300` extend to seven policies;
`tests/issue-3526-ir-runtime-manifest.test.ts`'s whole-shape frozen-policy
equality gains `stringLen: { len: "unsupported" }`.
`tests/issue-3521-prepared-component-dependencies.test.ts:832-846` attaches
`callable` providers by hand and does not move.

### Required pre-implementation probes (answers go in the checkpoint note)

- **P1** — does any test pin the `RuntimeProviderImplementation` kind union
  closed? Candidates: `tests/issue-4103-ir-async-runtime-providers.test.ts`,
  `tests/issue-4104-ir-async-plan-runtime-consumer.test.ts` (they name
  `native-managed`). Grep tests for `"host-managed"` / `implementation.kind`
  enumerations. Expected: none is exhaustive; if one is, extend it, do not
  weaken it.
- **P2** — confirm nothing between `:3794` and `:3801`, and nothing inside
  `prepareIrRuntimeManifest` / `prepareSuspendingIrFunction` (`:464`), reads
  `string.len.provider`. Grep `provider` in the prepare path of
  `intrinsic-support.ts` and `async-plan.ts`. Expected: no reader.
- **P3** — zero-reach of the retired fallback: put a temporary `throw` in place
  of `:6824-6830`, run the 60-cell matrix (it must stay byte-identical with the
  throw in) and the string suites: `strings`, `native-strings` ×2,
  `host-string-prefix-suffix-fast-path`, #1558, the #3931 hoist suites, #3518,
  #2955, #3502, #1183, #4550, `issue-1470-standalone-string-imports`,
  `issue-320`, `imported-string-constants`, and the three #3526 string suites.
  The 17 pre-existing reds [#5274](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5274-standing-red-tests-string-and-3529-suites)
  names must not grow; measure them on the grounding tree first.
- **P4** — the BEFORE half of the byte matrix, re-measured on the lane's own
  base before the first edit (`f2s4-matrix.mts` + `f2s4-instrument.py`; the
  instrumentation is for the reach counts only — the byte comparison is run
  WITHOUT it). Expected to reproduce `f2s4-matrix-before.md` exactly.

### Verification matrix

- **V-A** byte neutrality — 60/60 cells identical: bytes, sha256, ordered
  import list with func/global indices, demotions. Plus `check:ir-fallbacks`
  diffed against a base-tree run (byte-identical output) and the corpus
  (`website/playground/examples/**`, `examples/**`) compiled on both trees.
- **V-B** pins — the new suite in full, the five moved pins.
- **V-C** non-vacuity, each revert independent against the kept schema: revert
  only the attachment move (restore `:7225-7237` and `:7286`) → the (d) pins
  fail and nothing else; revert only the retirement → exactly the (e) refusal
  pin fails; revert only the manifest rows → the (a)/(b) contract and policy
  tests fail and the (c) host-lane pin still passes (the physical import is
  unchanged, which is the point).
- **V-D** gates — the five ratchets bare AND under
  `LOC_GATE_BASE=$(git rev-parse origin/main)`; `typecheck`, `lint`,
  `prettier --check`; `check:ir-dialect`, `check:ir-layering`, `check:ir-only`,
  `check:linear-ir`, `check:host-import-policy`, `check:test-vacuity-shapes`,
  `check:ir-kind-neutrality`. **Evidence lines WILL move**: `string.len`'s
  `src/ir/backend/linear-integration.ts:1628` (+1 from the policy line) and
  `forof.string`'s `src/ir/integration.ts:6410` (the policy/demand functions
  inserted above it). Refresh `scripts/ir-kind-neutrality-baseline.json`
  surgically, established by a sorted-leaf diff — expect only evidence arrays and
  `generated` to change, no verdict; the `string.len` verdict stays
  `unresolved` (its placement is #4551's call, not this slice's).
- **LOC** — estimate +150 net src LOC (F2-S3 was +265 with a resolve arm this
  slice does not have). Grant in this file's frontmatter with a dated rationale;
  never touch `scripts/*-baseline.json` except the neutrality citation refresh
  above.

### Out of scope

`string.concat` / `_OWNED` (F2-S5 — `owned-append` sub-arm, the `__concat_N`
late import, the `string-builder-candidate` bucket), `charCodeAt` (two-record
`host-capability` provider behind a defined helper), `string.const` (global
kind), the `src/ir/dialect/js.ts:599` placement verdict for `string.len` (core
vs dialect), `stringForOfPlan`, `src/ir/from-ast.ts`, the linear
`__str_length_utf16` path, the `programAbiTypes`-absent skip, the two linear
`.charAt()`/`.charCodeAt()` compile failures and the FOROFLEN host demotion the
census surfaced.

### After this slice (ranked)

| rank | boundary | why |
| --- | --- | --- |
| **F2-S5** | `string.concat` | the last lane read in the resolve table's string block (`:6373-6381`), the `_OWNED` sub-arm, `__concat_N` |
| later | `charCodeAt` | `host-capability` two-record provider behind a defined helper |
| later | `string.const` | global kind, derived field, two namespaces, oversized materializer, legacy pre-pass ordering |

### 2026-09-02 F2-S4 checkpoint note — Opus lane

**Branch** `claude/issue-3526-f2s4-string-len`, based on the plan branch
`claude/docs-r6-f2s4-plan` (`33c3afc4`), whose parent is `origin/main`
`aaebad2a`. The plan's grounding sha `469fd03e` (= PR #5448's head) carries **no
`src/`, `scripts/` or `tests/` delta** against that base — only the post-merge
`loc-budget-baseline.json` / `coercion-sites-baseline.json` refreshes — so the
preserved BEFORE record is valid here. Slice claim `3526:f2s4`. All four probes
were measured on this branch's own tree BEFORE any source edit.

#### Probe answers

**P1 — no test pins the `RuntimeProviderImplementation` kind union closed, so
the new `carrier-field` arm needed no test to be widened.** The two candidates
the plan named do assert on `implementation.kind`, but both scope the assertion
to an **async-only frozen manifest's own providers**
(`issue-4103…:126-140` `every(kind === "native-managed")` over an
async-feature-only freeze; `issue-4104…:449-453` the same over
`standalone.manifest.providers` and `fn.asyncRuntime.providers`). A new kind on
another feature's row is invisible to both. `issue-3526-string-boundary-schema`
walks `RUNTIME_PROVIDERS` but reads only `host-callable` rows.

**P2 — nothing between `prepareStrings` and the end of the freeze reads
`string.len.provider`.** The window contains exactly one thing:
`prepareIrRuntimeManifest`, whose collector short-circuits on
`instr.kind !== "intrinsic"` and whose `attachProviders` / `attachAsyncRuntime`
touch only `intrinsic` instructions and `asyncPlan.states`. Every real reader
runs elsewhere: `lower.ts` (lowering), `prepared-component-dependencies.ts` (via
`prepared-component-sealing`, called at `integration.ts:3921` — **after** the
freeze), `verify.ts` (all three WasmGC call sites are at `:3211`/`:3289`/`:3582`
— **before** the partition, hence before both the old and the new attachment).
`string.len` is also absent from `callableProviderRef`, so
`preregisterCallableProviders` never sees it.

**P3 — the emitter no-provider fallback is RETIRED, on a measurement.** A
temporary `throw` replaced both fallback branches of the WasmGC `emitStringLen`
adapter and the whole probe was re-run:

- **0 reaches across all 60 byte cells** — and the matrix stayed
  **byte-identical to the BEFORE record with the throw in place**, which is
  stronger than "no cell crashed": nothing in any of the 60 modules depended on
  the branch, not even through a demote.
- **0 reaches across 21 string suites / 335 passing tests** (`strings`,
  `native-strings` ×3, `host-string-prefix-suffix-fast-path`, #1558, the #3931
  hoist pair (#3931/#4517), #3518 string-repeat-ir + counted-string-cutover,
  #2955, both #3502 suites, #1183, #4550, `issue-1470-standalone-string-imports`,
  `issue-320`, `imported-string-constants`, and the three #3526 string suites).
  The only 5 failures were pre-existing reds, unchanged.

**P4 — the BEFORE byte matrix reproduces the planning lane's record exactly.**
60 cells, **deep** equality (bytes, sha256, ordered import list with func/global
indices, errors, demotions AND every probe counter), `0` differing. Run twice:
once instrumented (reproducing `f2s4-matrix-before.md` character-for-character)
and once clean, to establish that the instrumentation is itself byte-inert
(60/60 identical either way) — necessary because the AFTER comparison runs
uninstrumented.

**Pre-existing red controls: 17, exactly the set
[#5274](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5274-standing-red-tests-string-and-3529-suites)
names**, measured on this base before the first edit and re-measured after:
`issue-320` 1, `imported-string-constants` 4,
`issue-3529-equivalence-error-imports` 8, `issue-3529-dataflow-outcomes` 2,
`issue-3529-ir-producer-parity` 2. Unchanged; not this slice's, not touched.

#### What landed

- **`src/ir/runtime-manifest.ts`** (+164) — `StringLenPolicy`
  (`len: "host" | "native" | "unsupported"`), a frozen
  `STRING_LEN_POLICY_DISABLED`, the optional `stringLen` field canonicalized at
  construction and published resolved on the frozen manifest, the
  `js.string.len` feature row, the **`carrier-field` implementation kind**, the
  two provider rows (`host.…` → `host-callable` on capability `string.len`;
  `native.…` → `carrier-field` `{carrier:"string", fieldIndex:0}`, both on the
  existing `EXTERNREF_TO_I32_INTRINSIC_SIGNATURE` — no new signature), the
  `#selectProvider` branch whose unavailable arm is a typed
  `provider-target-unavailable` naming `string-len policy len=…`, and the three
  `carrier-field` validation rules.
- **`src/ir/intrinsic-support.ts`** (+53) — the `stringLenDemand` input (and its
  place in the "freeze nothing at all" guard) plus `preparedStringLenProvider`,
  which returns the ABI **role** and field index for the native arm.
- **`src/ir/integration.ts`** (+115) — `integrationStringLenPolicy`,
  `irStringLenDemand`, the owner-local `unsupported` partition in the same pass
  as the six existing ones, the freeze-time policy + demand arguments, the
  **moved attachment** (`prepareStringLength`, run inside the freeze), the
  deleted `prepareStrings` decision block, and the retired `emitStringLen`
  fallback.
- **`src/ir/string-support.ts`** (+45) — `attachIrStringLengthProvider`, a
  length-only attach pass. See divergence 1: this is not in the plan and exists
  because of a measured defect.
- **`src/ir/backend/linear-integration.ts`**, **`src/codegen/stdlib-selfhost.ts`**
  — both pass `STRING_LEN_POLICY_DISABLED` explicitly (+2 each).
- **`tests/issue-3526-string-boundary-len.test.ts`** (new, 31 tests).

`src/ir/from-ast.ts`, `src/ir/lower.ts`, `src/ir/nodes.ts`, `src/ir/builder.ts`,
`src/ir/backend/wasmgc-emitter.ts`, `src/ir/backend/legality.ts`,
`src/ir/runtime-host-capabilities.ts` and `src/codegen/registry/imports.ts`
needed **no edit** — the front end was already lane-free, the `string.len`
record landed in F2-S2, and no registration moves.

#### The attachment MOVE is the slice, and why it is byte-neutral

Every family-2 predecessor migrated a *resolve-table arm*: the decision is read
at lowering time, where the prepared manifest is already in scope. `string.len`
has no such arm — it is not a callable symbol, nothing in
`resolveAndObserveCallableProvider` names it — so the `IrStringLengthProvider`
carried on the instruction **is** the physical choice, and it was attached in
`prepareStrings`, which runs *before* the freeze. The migration therefore had to
move the attachment itself behind the freeze (`prepareStringLength`, called from
inside `prepareBuiltFnRuntimeManifest` right after `preparedEntries` is built and
before the math/async materializers).

That is safe because (P2) nothing in the window reads the provider, and because
both passes are pure structural maps over disjoint instruction kinds — so
composing the length attach *after* the intrinsic attach instead of before it
yields identical IR. Measured, not argued: 60/60 byte cells and 104/104 corpus
cells identical.

#### Divergences from the plan (recorded, not widened)

1. **The plan's idempotency argument for reusing `attachIrStringSupport` is
   WRONG, and the corpus caught it.** The plan reasoned about that pass's
   `string.const` and `string.len` arms and concluded "the pass is idempotent".
   Its **callable arm is not**: for `string.concat` / `.repeat` / `.eq` /
   `.char_at` / `.char_code_at` / `forof.string` it re-derives the provider on
   every run via `irStringCallableProviderRef` and compares. Running it a second
   time with only `providerForLength` supplied made that helper fall back to the
   generic `__ir_string_repeat` for instructions the first pass had bound to
   `__ir_string_repeat_counted_native`, so every module with a counted native
   `string.repeat` failed with *"IR string.repeat already carries a different
   prepared provider binding"* — **4 corpus cells**
   (`website/playground/examples/benchmarks.ts` and `benchmarks/string.ts` on the
   `gc-native-strings` and `standalone` lanes). The **60-cell byte matrix stayed
   green throughout**: no fixture in it carries that shape. Smallest faithful
   fix: a length-only pass, `attachIrStringLengthProvider`, with the same
   check-don't-overwrite discipline. The alternative — threading
   `prepareStrings`'s `providerForRepeat` lambda through — was rejected because
   it would put the *repeat* seam's `ctx.nativeStrings` decision inside the
   length pass, which has no authority over it. Covered non-vacuously: reverting
   only this fix fails 3 tests, one of them an end-to-end reduction of the corpus
   failure.
2. **The whole-shape frozen-policy pin is in
   `tests/issue-4104-ir-async-plan-runtime-consumer.test.ts`, not
   `tests/issue-3526-ir-runtime-manifest.test.ts`** as the plan's test-moves list
   says. The latter defines its own `policy()` helper but never asserts the whole
   shape; F2-S3's checkpoint recorded the same fact. Moved the 4104 pin.
3. **A FIFTH existing pin had to move, and it is a deletion-with-inversion, not
   a shrink.** `tests/issue-3526-string-boundary-schema.test.ts` carried the
   F2-S2 fence *"keeps the string.len provider on ctx.nativeStrings and the raw
   import ref"*, keyed on `prepareStrings`'s `if (usesStringLen) {` block. F2-S4
   deletes that block outright, so — unlike F2-S3's concat/eq pin, which had a
   surviving concat half to re-scope — there is nothing left to fence. The pin is
   removed with a comment naming its replacement, and the assertion is INVERTED
   into the new suite's (d) section.
4. **The `carrier-field` validation rules reuse the existing
   `unknown-runtime-provider` invariant code** rather than adding a new one to
   `RuntimeManifestInvariantCode`. The plan did not specify a code; the
   host-capability rule uses `unknown-host-capability` as the plan's test (f)
   requires, and the carrier/field-index rules reuse the nearest existing code so
   the union does not grow for two shape checks.
5. **V-C's third revert behaves the OPPOSITE way to the plan's prediction, and
   that is the structural point of the slice.** The plan expected *"revert only
   the manifest rows → the (a)/(b) contract and policy tests fail and the (c)
   host-lane pin still passes (the physical import is unchanged)"*. Measured:
   dropping the two provider rows fails **16** tests including every (c)
   end-to-end pin, because after the attachment move the frozen row is the
   **only** source of the physical choice — there is no resolve arm to fall back
   to the way F2-S1/F2-S3 had. The three sub-edits are genuinely interlocked for
   end-to-end behaviour, and they should be: that is what "the manifest is the
   authority" means for a seam with no callable symbol.
6. **Net src LOC is +381, not the plan's +150 estimate.** Two structural reasons,
   both recorded in the frontmatter grant: the slice introduces a new provider
   IMPLEMENTATION KIND (a union arm plus a three-rule validation triad no
   previous family-2 slice needed), and it adds a whole new function rather than
   editing an existing arm. The F2-S4 rationale block names every path.

#### V-A — measured neutrality: 60 of 60 byte cells, 104 of 104 corpus cells

Twelve fixtures (`LEN`, `LENCMP`, `LENEQ`, `LENLOOP`, `LENIDX`, `TPLLEN`,
`CONCATLEN`, `LENCONST`, `FOROFLEN`, `LENSTMT`, plus the `EQ` and `CLEAN`
controls) × five lanes (gc-host, gc-native-strings, standalone, WASI, linear).
Each cell compares byte length, binary sha256, the **full emitted WAT text**, the
**ordered import list with func/global indices parsed from the binary import
section** (`result.imports` covers only `env` func descriptors and is blind to
`wasm:js-string`), the error list and the `irOutcomes` records — deep equality.
**60/60 identical**, and `diff -r` over all 60 WAT texts is empty.

The BEFORE half was re-run on this branch's own base before the first edit and
reproduced the planning lane's record exactly, so the comparison is against a
base this lane measured.

Corpus: every `.ts` under `website/playground/examples/**` and `examples/**`
(26 files) × four WasmGC lanes = **104 cells**, comparing sha256, byte length,
success and the full error list. 0 differing — after the divergence-1 fix; 6
differing before it, which is how the defect was found.

`FOROFLEN::gc-host` reproduces its pre-existing `property-access-unsupported`
demote byte-identically (`ch.length` on a for-of character — the host for-of
plan's business, not this seam's), and `LENLOOP`/`LENIDX` reproduce their
pre-existing linear compile failures (`.charCodeAt()` / `.charAt()` unsupported
on that lane). Both are in the matrix precisely so a slice that "fixed" them by
accident would be caught.

#### V-B — the migrated decision is REACHED, and the retired one is not

With instrumentation re-applied on the AFTER tree, the 60-cell run emits the
length seam **43** times: **10 host** `callable` and **33 native**
`struct-field` — identical to the BEFORE run — plus **6** linear
`__str_length_utf16` calls, also identical. The retired fallback is taken **0**
times. In every cell the count of attachments that carried a provider equals the
emit count exactly (`1/1`, `2/2`), as before.

Two probe-column changes are expected and are not byte differences:
`attachIrStringSupport` now visits each `string.len` with
`providerForLength: () => undefined` before `prepareStringLength` attaches, so
the raw attach-visit count doubles while the *with-provider* count is unchanged;
and the four `CLEAN` WasmGC cells no longer report a decision event at all,
because a module with no intrinsics, no async plan and no demand freezes no
manifest and the pass does not run.

**Runtime oracle.** `.length` is checked against JavaScript on **seven** inputs
through an instantiated host-lane module — `""`, ASCII, a **surrogate pair**
(which must count 2 UTF-16 code units, not 1 code point), a BMP non-ASCII
string, a 1000-character string, a concatenation result and a template result —
over an expression that exercises the direct, template, concat and literal
receivers in one owner. The same source is compiled and validated on a
native-strings lane and on linear.

#### V-C — non-vacuity, each sub-edit reverted independently

| revert | tests failing | which |
| --- | --- | --- |
| the attachment move (restore `prepareStrings`'s decision, delete `prepareStringLength`) | **5** | exactly the five (d) attachment pins; 103 others green |
| the retirement (restore the emitter fallback) | **1** | "keeps the retired fallback's lane read out of the emitter" — the discriminator; 107 others green |
| the length-only attach pass (revert to the omnibus one) | **3** | the (d) pass pin plus the two (e) attach pins, including the reduced-corpus end-to-end one |
| the manifest provider rows | **16** | see divergence 5 — the whole seam, by design |

As in every family-2 slice, the (d)/(e) pins are deliberately **source-shape**
assertions: the policy projection reproduces the old truth table exactly, so both
forms emit identical bytes on every lane — which is the point of the slice and
why all 60 cells are unchanged. What moved is WHICH authority answers, and on
this seam that is only observable in source.

#### V-D — gates

Green: `typecheck`; the five ratchets run **bare** and again under
`LOC_GATE_BASE` pinned to `origin/main` — loc (+381 net src LOC, every grown path
granted by this file's frontmatter with the dated F2-S4 rationale;
`runtime-manifest.ts` 1803 → 1967, over the god-file threshold), func,
coercion-sites, oracle-ratchet, dead-exports. Also green: `lint`,
`prettier --check` on every touched path, `check:ir-dialect`,
`check:ir-layering`, `check:ir-only`, `check:linear-ir`,
`check:host-import-policy`, `check:test-vacuity-shapes`,
`check:ir-kind-neutrality` (after the surgical refresh below), and
`check:ir-fallbacks` — **diffed against a base-tree run of the same command,
output byte-identical**. `scripts/linear-ir-baseline.json` and
`scripts/ir-fallback-baseline.json` are untouched.

**Kind-neutrality refresh: TWO evidence lines, patched surgically.**
`forof.string` `src/ir/integration.ts` 6410 → 6531 (the policy, demand and
`prepareStringLength` functions inserted above it) and `string.len`
`src/ir/backend/linear-integration.ts` 1628 → 1630 (the two-line adapter edit) —
exactly the two the plan predicted. Established by normalising both JSON
documents to sorted leaf paths and diffing those: **462 leaves each, exactly 2
changed**, both evidence strings. No verdict, kind, placement, ratchet count or
`settledBy` rationale moved, and `string.len`'s verdict stays `unresolved`
(#4551's call, not this slice's). Patched by hand: committing the regenerator's
output would have been a **269-line** diff for a 2-line change, and would also
have left the file prettier-dirty.

The eight `equivalence-gate` shards run locally: no new equivalence regressions.

Focused suites: **all #3526 suites (including the new one, 31 tests), both async
suites (#4103/#4104), #3520 callable-provider-abi and callable-preregistration,
#3521 prepared-component-dependencies — 218 passing across 12 files** — plus the
string set (`strings`, `native-strings` ×3,
`host-string-prefix-suffix-fast-path`, #1558, #3931, #4517, #3518 ×3, #2955,
#3502 ×2, #1183, #3167, `for-of-string-generator`, #4550,
`issue-1470-standalone-string-imports`). The only failures anywhere are the 17
pre-existing #5274 reds.

**One suite could not be run in this container, on EITHER tree:**
`tests/issue-3518-multi-prepared-string-leaf-planner.test.ts` OOMs the vitest
worker (`Reached heap limit`) even at `--max-old-space-size=6144`. Confirmed
pre-existing by running it on the reverted base tree with the same result, so it
is an environment limit rather than this slice's; CI runs it with a larger heap.

#### Not touched (per the plan's scope discipline)

`string.concat` / `_OWNED` (F2-S5 — still on the lane read, still pinned),
`charCodeAt`, `string.const`, `stringMethodPlan`, `stringForOfPlan` /
`charReadPlan`, `emitStringCharAt`, the #3931 hoist arms, the linear
`__str_length_utf16` path, the `programAbiTypes`-absent skip (kept verbatim),
the two linear `.charAt()`/`.charCodeAt()` compile failures and the FOROFLEN host
demote the census surfaced, `src/ir/from-ast.ts`, the `src/ir/dialect/js.ts`
placement verdict for `string.len`, and every existing policy —
`numberBoundary`, `booleanBoundary`, `externIsUndefined`, `generatorNumberBox`,
`stringCompare`, `stringEq` — all unchanged.

### 2026-09-02 F2-S5 checkpoint note — Opus lane

**Branch** `claude/issue-3526-f2s5-string-concat`, based on `origin/main`
`7f998ff8` (F2-S4 merged, PR #5460). Slice claim `3526:f2s5`. All four probes
were measured on this branch's own tree BEFORE any source edit.

#### Probe answers

**P1 — nothing asserts one-row-per-capability, so TWO host rows on the single
`string.concat` capability are legal as planned.** `#indexProviders`
(`runtime-manifest.ts`) keys uniqueness on `provider.id` alone and groups
`byFeature`; the freeze aggregates `provider.hostCapabilities` into a **Set**
before resolving records, so both host rows collapse to one `string.concat`
entry and one import. The only length assertions anywhere are
`issue-4103…:94-95` (`hostCapabilities` has 6 entries on an **async-only**
freeze — invisible to a string feature) and `issue-4104…:447` (`[]` on a
standalone async freeze). Measured: a host-lane concat freeze publishes
`hostCapabilities === ["string.concat"]` for either mode.

**P2 — the resolve arm receives the intrinsic SYMBOL and nothing else, and the
only other consumer of `IR_STRING_CONCAT_OWNED_FN` is the producer.**
`grep -rn` over `src/` finds it in exactly three places: its definition
(`string-runtime.ts:23`), the producer's mode→symbol map
(`string-support.ts:63`, inside `irStringCallableProviderRef`) and the resolve
arm's condition + helper choice (`integration.ts`). So the mode must be
recovered from the symbol at resolve time, as contract item 10 says.

**P3 — the emitter no-provider fallback is RETIRED, on a measurement.** A
temporary `throw` replaced all three fallback branches of the WasmGC
`emitStringConcat` adapter and the probe was re-run:

- **0 reaches across all 65 byte cells** — and the matrix stayed
  **byte-identical to the BEFORE record with the throw in place**, which is
  stronger than "no cell crashed": nothing in any of the 65 modules depended on
  the branch, not even through a demote.
- **0 reaches across 22 string suites / 352 passing tests**, with a red set
  identical name-for-name to the base tree's.

**P4 — the BEFORE byte matrix reproduces the planning lane's record exactly.**
65 cells compared on fixture, lane, success, byte length, sha256, the ordered
concat import list and the demotion list: **0 differing**. The record was made
on `a7edf000ee` (pre-F2-S4) and reproduces on this post-F2-S4 base, which
independently confirms F2-S4's own byte-neutrality claim for these fixtures.
**No finding about F2-S4.**

**Pre-existing red controls: 31, not the 17 [#5274](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5274-standing-red-tests-string-and-3529-suites)
names — and the extra 14 are a CONTAINER limit, not a regression.** The #5274
set reproduces exactly (`issue-320` 1, `imported-string-constants` 4,
`issue-3529-equivalence-error-imports` 8, `issue-3529-dataflow-outcomes` 2,
`issue-3529-ir-producer-parity` 2). On top of it this container fails
`issue-1761` ×9, `issue-2598-2599` ×3, `issue-2163` ×1 and `issue-3744` ×1 —
every one of them on a test that runs `optimize`, and 18 of the failures print
`invalid type: distinct rec groups would be identical after binary writing (to
resolve this, use --enable-gc)`, i.e. this box's Binaryen refuses the WasmGC
module the optimizer is handed. The #3744 red is the same cause one step later
(`optimize: 3` fails, so `irCompiledFuncs` is empty). Measured on the base tree
BEFORE the first edit and re-measured after: **identical set, name for name.**
Not this slice's; CI has the working toolchain.

#### What landed

- **`src/ir/intrinsics.ts`** (+26) — `EXTERNREF_PAIR_TO_REF_EXTERN_INTRINSIC_SIGNATURE`
  and its `REF_EXTERN_TYPE`. The one new signature the slice mints: the
  `string.concat` host record returns a non-null `(ref extern)` and no existing
  signature carries that result.
- **`src/ir/runtime-manifest.ts`** (+164) — `StringConcatPolicy`
  (`concat: "host" | "native" | "unsupported"`), frozen
  `STRING_CONCAT_POLICY_DISABLED`, the optional `stringConcat` field
  canonicalized at construction and published resolved, the TWO feature rows
  (`js.string.concat`, `js.string.concat.owned`), the FOUR provider rows (both
  host rows on capability `string.concat`; native rows `runtime-callable`
  `__str_concat` / `__str_concat_owned`), the two-argument
  `stringConcatProviderId(feature, policy)` and the `#selectProvider` branch
  whose unavailable arm is a typed `provider-target-unavailable` naming
  `string-concat policy concat=…`. No new validation rules — both
  implementation kinds already existed.
- **`src/ir/intrinsic-support.ts`** (+65) — the `stringConcatDemand`
  `{immutable, owned}` input (and its place in the "freeze nothing at all"
  guard) plus `preparedStringConcatProvider(prepared, mode)`, the family's first
  twin that takes a second argument.
- **`src/ir/integration.ts`** (+94) — `integrationStringConcatPolicy`,
  `irStringConcatDemand` (returning the mode pair), the owner-local
  `unsupported` partition in the same pass as the seven existing ones, the
  freeze-time policy + demand arguments, the migrated resolve arm and the
  retired `emitStringConcat` fallback.
- **`src/ir/backend/linear-integration.ts`**, **`src/codegen/stdlib-selfhost.ts`**
  — both pass `STRING_CONCAT_POLICY_DISABLED` explicitly (+2 each).
- **`tests/issue-3526-string-boundary-concat.test.ts`** (new, 27 tests).

`src/ir/from-ast.ts`, `src/ir/string-support.ts`, `src/ir/string-builder-shape.ts`,
`src/ir/passes/batch-string-concat.ts`, `src/ir/nodes.ts`, `src/ir/lower.ts`,
`src/ir/runtime-host-capabilities.ts` and every other resolve-table arm needed
**no edit**.

#### Two features under one policy — and the host-side collapse

The manifest decides WHICH authority answers; the concat MODE decides WHICH
helper on that authority. Modelling that as two features under one policy keeps
the freeze honest: a module with only `a + b` freezes exactly one row
(`js.string.concat`) and `preparedStringConcatProvider(prepared, "owned-append")`
returns `undefined`. Both HOST rows name the same `string.concat` capability
because `wasm:js-string` has no owned-append builtin — the collapse is stated in
the rows rather than hidden in the call site, and because the freeze projects
capabilities through a Set it costs no second import (measured: the `APPEND`
fixture on `gc-host` binds `wasm:js-string.concat` at func #0, exactly as `CAT`
does).

#### Divergences from the plan (recorded, not widened)

1. **Net src LOC is +353, not the plan's +170 estimate.** One structural reason,
   recorded in the frontmatter grant: this is the first seam with TWO features
   under ONE policy, so every per-seam artefact the three predecessors minted
   once is minted twice (two features, FOUR provider rows, a two-argument
   selector, a pair-shaped demand), and it is also the first that could not
   reuse an existing ABI.
2. **V-C's third revert behaves the way F2-S4 found, not the way this plan
   predicted.** The plan expected *"revert only the manifest rows → (a)/(b) fail
   and the (c) host-lane import-position pins still pass"*. Measured: dropping
   `...STRING_CONCAT_RUNTIME_PROVIDERS` from `RUNTIME_PROVIDERS` fails **11**
   tests including the (c) end-to-end pins, because after the migration the
   frozen row is the only source of the physical choice and the arm fails closed
   — there is no lane read left to fall back to. The one (c) test that DOES
   still pass is the batched many-arity fence, which is exactly right: those
   cells never freeze a concat row at all.
3. **The plan's P3 suite list names "#3740"; there is no such test file.** The
   nearest neighbours are `issue-3741-i32-slot-promotion` (unrelated) and
   `issue-3744-ir-owned-append-string-builder` (already in the list). Ran the
   other 21 named suites plus `native-strings-roundtrip`.
4. **The (c) runtime oracle needed THREE owners, not one.** A single
   `let s = a + b; … s += "x"; return s + \`${a}!\`` owner demotes with
   `string-evidence-unsupported` before the seam is reached — from-ast requires
   checker/producer string AND encoding evidence for the appended variable, and
   both a `a + b` initializer and an append of a string PARAMETER destroy it.
   The census recorded the same shape sensitivity for its `APPENDREAD` and
   `APPENDPLUS` fixtures. The suite therefore exercises `+`, a literal-append
   builder loop and a template as three owners in one module, over the seven
   input pairs.
5. **The F2-S6 byte fence is pinned by sha on the `gc-host` cells only.** CAT3
   (149 bytes, `4677a84a2dcd`) and TPL (173 bytes, `a6702c76db07`) are pinned
   exactly; on `standalone` the same trees are pinned structurally
   (`$__str_concat_3` present) rather than by sha, because those modules carry
   the whole native-strings runtime (~23 KB) and a sha pin there would go red on
   any unrelated runtime edit — a maintenance trap rather than a fence. The
   65-cell matrix in this PR is where standalone byte-identity is established.
6. **The kind-neutrality baseline was patched BY HAND**, following F2-S4's
   precedent: the regenerator's output is a **269-line** diff for a 2-leaf
   change. Established by normalising both JSON documents to sorted leaf paths
   and diffing those — **462 leaves each, exactly 2 changed**, both evidence
   strings (see V-D).

#### V-A — measured neutrality: 65 of 65 byte cells, 104 of 104 corpus cells

Thirteen fixtures (`CAT`, `CAT3`, `CAT4`, `TPL`, `TPL3`, `APPEND`, `APPENDREAD`,
`APPENDPLUS`, `TPLEQ`, `CATLEN`, `CATNUM`, plus the `EQ` and `CLEAN` controls) ×
five lanes (gc-host, gc-native-strings, standalone, WASI, linear). Each cell
compares byte length, binary sha256, the full emitted WAT text, the ordered
import list with func/global indices parsed from the binary import section, the
error list and the `irOutcomes` records. **65/65 identical**, and `diff -r` over
all 65 WAT texts is empty. The many-arity cells (CAT3, CAT4, TPL, TPL3, TPLEQ —
the F2-S6 fence) are among them and did not move.

Corpus: every `.ts` under `website/playground/examples/**` and `examples/**`
(26 files) × four WasmGC lanes = **104 cells**, comparing sha256, byte length,
success and the full error list. **0 differing** (22 cells fail identically on
both trees — pre-existing).

`check:ir-fallbacks` run on both trees: **output byte-identical**, and
`string-builder-candidate` stays at its baseline count of **2**.
`scripts/ir-fallback-baseline.json` and `scripts/linear-ir-baseline.json` are
untouched.

#### V-B — the migrated decision is REACHED, and the retired one is not

With instrumentation re-applied on the AFTER tree, the 65-cell run emits the
concat seam identically to the BEFORE run, counter for counter:

| probe | BEFORE | AFTER |
| --- | --- | --- |
| resolve arm, host (`wasm:js-string.concat`) | 4 | 4 |
| resolve arm, native `__str_concat` | 19 | 19 |
| resolve arm, native `__str_concat_owned` | 3 | 3 |
| `emitStringConcat` via provider, `immutable` | 40 | 40 |
| `emitStringConcat` via provider, `owned-append` | 4 | 4 |
| `emitStringConcat` via the RETIRED fallback | 0 (throw probe) | **0** |
| batched many-arity arms (host×3/4/6, native×3/4/6) | 10 | 10 |
| batch decisions that changed a function | 10 | 10 |
| linear `emitStringConcat` (`immutable` 8, `owned-append` 1) | 9 | 9 |

The instrumented AFTER run is itself **byte-identical to the clean BEFORE run**
(65/65), so the instrumentation is byte-inert and the comparison is honest.

**Runtime oracle.** `+`, a `+=` builder loop and a template literal are checked
against JavaScript through an instantiated host-lane module on seven input
pairs — `""`×`""`, `""`×ascii, two lone **surrogate halves that combine** into
one astral code point, a 1000-iteration builder loop, a non-ASCII BMP pair, a
numeric-looking pair, and a plain ascii pair. The same source compiles and
validates on a native-strings lane and on linear, and a linear module with both
modes plus a numeric control instantiates and runs.

#### V-C — non-vacuity, each sub-edit reverted independently

| revert | tests failing | which |
| --- | --- | --- |
| the resolve arm (restore the `ctx.nativeStrings` read) | **3** | exactly the three (d) arm pins; 24 others green |
| the retirement (restore the emitter fallback) | **1** | "keeps the retired fallback's lane read and its private mode mapping out of the emitter" — the discriminator; 26 others green |
| the four manifest provider rows | **11** | see divergence 2 — the whole seam, by design; the batched-family fence still passes |

As in every family-2 slice, the (d)/(e) pins are deliberately **source-shape**
assertions: the policy projection reproduces the old truth table exactly, so
both forms emit identical bytes on every lane — which is the point of the slice
and why all 65 cells are unchanged. What moved is WHICH authority answers, and
on this seam that is only observable in source.

#### V-D — gates

Green: `typecheck`; the five ratchets run **bare** and again under
`LOC_GATE_BASE=$(git rev-parse origin/main)` — loc (+353 net src LOC, every
grown path granted by this file's frontmatter with the dated F2-S5 rationale;
`runtime-manifest.ts` 1967 → 2131), func
(`compileIrPathFunctions` 3157 → 3178, already granted), coercion-sites,
oracle-ratchet, dead-exports. Also green: `lint`, `prettier --check` on every
touched path, `check:ir-dialect`, `check:ir-layering`, `check:ir-only`,
`check:linear-ir`, `check:host-import-policy` (**the host import set does not
change** — no new `env` import, no new builtin), `check:test-vacuity-shapes`,
`check:ir-kind-neutrality` (after the surgical refresh below), and
`check:ir-fallbacks` (diffed against a base-tree run of the same command,
output byte-identical).

**Kind-neutrality refresh: TWO evidence lines, patched surgically.**
`forof.string` `src/ir/integration.ts` 6531 → 6629 (the policy, demand and
partition additions inserted above it) and `string.len`
`src/ir/backend/linear-integration.ts` 1630 → 1632 (the two-line adapter edit) —
exactly the two F2-S4's checkpoint predicted would move again. Normalising both
JSON documents to sorted leaf paths: **462 leaves each, exactly 2 changed**,
both evidence strings. No verdict, kind, placement, ratchet count or `settledBy`
rationale moved, and `string.concat` stays **`neutral`** with its
`src/ir/nodes.ts` evidence untouched.

Focused suites: the new suite (27 tests) plus all #3526 suites, both async
suites (#4103/#4104), #3520 callable-provider-abi, #3521
prepared-component-dependencies and the 22-suite string set — **462 passing
across 28 files**. The only failures anywhere are the 31 pre-existing reds
described above, unchanged name for name.

**One suite could not be run in this container, on EITHER tree:**
`tests/issue-3518-multi-prepared-string-leaf-planner.test.ts` OOMs the vitest
worker (`Reached heap limit`). F2-S4 recorded the same; CI runs it with a larger
heap.

#### Not touched (per the plan's scope discipline)

The BATCHED many-arity family — the pass selection (`hostBatchedConcat` /
`standaloneBatchedConcat`), the `string.concat$arityN` /
`async.string.concat$arity5` resolve arms, the `env.__concat_N` LATE import and
`ensureNativeBatchedConcat` — all F2-S6. Also untouched: `string-support.ts`'s
mode→symbol mapping (the demand scan mirrors it rather than replacing it),
`src/ir/from-ast.ts`, `src/ir/string-builder-shape.ts`,
`src/ir/passes/batch-string-concat.ts`, `charCodeAt`, `string.const`,
`stringMethodPlan`, the linear concat/append lowering, the
`operand-coercion-unsupported` demotions the census surfaced (APPENDPLUS,
CATNUM), the `string-builder-candidate` selection bucket,
`tests/issue-3744-ir-owned-append-string-builder.test.ts` (no assertion of its
reads the arm's source — no finding), and every existing policy —
`numberBoundary`, `booleanBoundary`, `externIsUndefined`, `generatorNumberBox`,
`stringCompare`, `stringEq`, `stringLen` — all unchanged.

## 2026-09-02 F2-S7 implementation checkpoint — Opus lane

**Branch** `claude/issue-3526-f2s7-char-code-at`, based on
`origin/claude/issue-3526-f2s5-string-concat` `6d6425c8e3` (F2-S5, PR #5467 —
open and auto-parked; the planning lane owns that park, untouched here), then
`git merge origin/main` (`ed829da999`) and `git merge
origin/claude/docs-r6-f2s6-s8-plans` (`04b903c4a`) so the grant and this note
edit the same file as the plan. Base tree `0000567919`. Slice claim
`3526:f2s7`. Every probe was measured on this branch's own tree BEFORE any
source edit.

### Probe answers

**P1 — the BEFORE byte matrix reproduces the planning lane's record EXACTLY, and
the reach counts with it.** 65 cells compared on fixture, lane, success, byte
length, sha256, the ordered import list with func/global indices parsed from
the binary import section, and the demotion list: **0 differing fields**. The
record was made on `a07f65319f`; it reproduces on a base that is F2-S5 +
today's `origin/main`, which independently confirms F2-S5's byte-neutrality
claim for these fixtures. **TPL — the one cell F2-S5's concat policy could
plausibly have touched — is identical (173 bytes, `a6702c76db07`). No finding
about F2-S5.** Re-run WITH `f2-cca-instrument.py` (which anchors on CONTENT,
not line numbers, and applied unchanged on the branch): the instrumented run is
itself byte-identical to the clean one (65/65, `diff -r` over all 65 WAT texts
empty), so the instrumentation is byte-inert and the counts below are honest.

| site | probe counter | BEFORE |
| --- | --- | --- |
| 1 — instr path, `IR_STRING_CHAR_CODE_AT_FN` | `resolve:6527/ir-host-guarded` + `ir-native-guarded` | 1 + 3 = **4** |
| 2 — plan path, `JSSTR_CHARCODEAT_FN` | `resolve:6417/host-guarded` | **7** |
| 3 — plan path, `NATIVE_CHARCODEAT_FN` | `resolve:6421/native-guarded` | **24** |
| 4 — WasmGC adapter | `emit:adapter/provider` | **4** |
| 4 — WasmGC adapter FALLBACK | `emit:adapter/fallback-*` | **0** (no counter emitted at all) |
| hoist/trusted (untouched) | `resolve:6425` ×2 + `resolve:6437` | 6 + 6 + 2 |

Exactly the plan's numbers.

**P2 — nothing mints an import from `provider.hostCapabilities`, so the host
row may honestly list the two records its helper closes over.** Every reader is
async-scoped or validation-only: `intrinsic-support.ts:660` (the async runtime
attachment, which narrows to `AsyncHostCapabilityId` and throws on anything
else — unreachable for a `runtime-callable` string row), `async-plan.ts:300`
(frozen-shape assertion), `:405` (a containment CHECK against the frozen
manifest), `:441` (the async ADAPTER set, host-async only). The manifest's own
freeze aggregates them into a Set and resolves records for publication
(`runtime-manifest.ts:1802-1821`) — publication, not registration. Measured:
`check:host-import-policy` output is **byte-identical** to a base-tree run of
the same command, and the gc-host import block stays exactly
`wasm:js-string.length#0`, `wasm:js-string.charCodeAt#1` in all 65 cells. The
capabilities are therefore a real fact about the host row, not documentation.

Also confirmed against the validation triad (`runtime-manifest.ts:1854-1874`):
capabilities are FORBIDDEN on `host-managed`, `native-managed` and
`carrier-field`, and REQUIRED on `host-capability`. Nothing forbids them on
`runtime-callable` — the plan's reading holds, and no new validation rule was
needed.

**P3 — the site-4 fallback is RETIRED, on a measurement.** A temporary `throw`
replaced the WasmGC `emitStringCharCodeAt` no-provider branch and everything
was re-run:

- **0 reaches across all 65 byte cells** — and the matrix stayed
  **byte-identical to the BEFORE record with the throw in place**, `diff -r`
  over all 65 WAT texts empty. Nothing in any of the 65 modules depended on the
  branch, not even through a demote.
- **0 reaches across 39 suites / 604 passing tests**, with a red set identical
  name-for-name to the base tree's.

**Pre-existing red controls: 15 across 5 files — and the #5274 set is GONE from
this base, which is a correction to F2-S5's count.** F2-S5 measured 31 and
attributed 17 of them to [#5274](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5274-standing-red-tests-string-and-3529-suites)
(`issue-320` 1, `imported-string-constants` 4,
`issue-3529-equivalence-error-imports` 8, `issue-3529-dataflow-outcomes` 2,
`issue-3529-ir-producer-parity` 2). On this base — F2-S5 plus today's
`origin/main`, whose merge diff touches all five of those files — **every one
of them passes.** #5274 was fixed on main between the two measurements; the
plan's "the red count is unmeasured post-#5465" was right to say so.

What remains is exactly F2-S5's other 14 plus the one known charCodeAt-adjacent
red, and all 15 are this container's Binaryen, not this slice:

| suite | failures | cause |
| --- | --- | --- |
| `issue-1761` | 9 | `optimize` — `distinct rec groups would be identical after binary writing (to resolve this, use --enable-gc)` |
| `issue-2598-2599-string-arg-tostring` | 3 | same |
| `issue-2163` | 1 | same |
| `issue-3744-ir-owned-append-string-builder` | 1 | same, one step later (`optimize: 3` fails, so `irCompiledFuncs` is empty) |
| `string-derived-length-fast-path` | 1 | "applies immutable derived-result proofs to host strings…" — `RuntimeError: illegal cast`, the red the plan names, reproduced on `a07f` in `f2-cca-pin-clean.out:20-28` |

18 error lines print the rec-group message. Measured on the base tree BEFORE
the first edit and again after the last: **identical set, name for name.** CI
has the working toolchain.

**P4 — every guarded call IS visible to the demand scan; nothing mints one
after the freeze.** `grep -rn` over `src/` for `JSSTR_CHARCODEAT_FN` /
`NATIVE_CHARCODEAT_FN` / their literal spellings finds them only in
`char-code-at-helpers.ts` (the definitions), `integration.ts` (the plan
resolver, the three arms, the pre-registration scan) and `stdlib-selfhost.ts`.
`src/ir/passes/` — `batch-string-concat.ts` included, the one F2-S6 touches —
has **0 hits**, as do `lower.ts` and `builder.ts`. In tests, only
`issue-3520-callable-preregistration` names `__jsstr_charCodeAt`, and it goes
through `compile()`.

**One finding, and it is why D matters:** `stdlib-selfhost.ts` MINTS
`NATIVE_CHARCODEAT_FN` calls (`:178`, its own `stringMethodPlan` map) and
resolves them through its OWN `resolveFunc` (`:609`, `ensureNativeCharCodeAtHelper`
directly), never through `integration.ts`'s table. Its freeze now passes
`STRING_CHAR_CODE_AT_POLICY_DISABLED` and passes **no demand**, so DISABLED
refuses nothing and the new verify arms are never reached from that adapter.
Confirmed by the AFTER suite run: no `selection-preparation-mismatch` anywhere.

**P5 — no suite asserts a provider's `signature` equals its capability record's
ABI, so the deliberate divergence needed no pin to be weakened.** Schema `:311`
compares the RECORD against the emitted import registration, not against a
provider. The only signature check on providers is the freeze's
`RUNTIME_FEATURE_SIGNATURES` lookup (`runtime-manifest.ts:1774-1783`), and that
map carries **no string-family feature at all** — F2-S3/S4/S5 added none and
neither does this slice. The new suite pins the divergence positively instead:
the `string.char_code_at` record results are `["i32"]` and the row's result is
f64.

**P6 — there is NO policy-injection harness for resolve, so (f) stays
source-text.** `generateModule(ast, options)` takes `CodegenOptions`
(`nativeStrings`, `target`, …), never a manifest policy; the policy is derived
from `ctx` INSIDE `compile()` by the same expression `stringMethodPlan` reads,
so plan-time symbol and frozen row cannot disagree from outside. The only
adapters that pass a policy — `linear-integration.ts` and `stdlib-selfhost.ts`
— pass DISABLED with no demand (P4). Tests that construct a
`RuntimeManifestBuilder` / `prepareIrRuntimeManifest` directly (12 files) have
no route into `resolveAndObserveCallableProvider`; the `resolveFunc` stubs in
`ir-bytecode-proof`, `ir-frontend-widening` and `ir-vec-two-backend` are
`IrLowerResolver`s, a different interface. (f) is therefore pinned as source
text, exactly as the plan's fallback prescribed.

### What landed

- **`src/ir/intrinsics.ts`** (+20) — `EXTERNREF_I32_TO_F64_INTRINSIC_SIGNATURE`.
  The one new signature: no existing constant carries `[externref, i32]` params,
  and this is the catalogue's first row whose signature is deliberately NOT its
  capability record's ABI (the record is the raw builtin that TRAPS out of
  range, #2003; the seam is the guarded f64 that answers `NaN`).
- **`src/ir/runtime-manifest.ts`** (+139 net) — `StringCharCodeAtPolicy`
  (`charCodeAt: "host" | "native" | "unsupported"`), frozen
  `STRING_CHAR_CODE_AT_POLICY_DISABLED`, the optional `stringCharCodeAt` field
  canonicalized at construction and published resolved, ONE feature
  (`js.string.char_code_at`), TWO `runtime-callable` provider rows
  (`__jsstr_charCodeAt` carrying `["string.char_code_at", "string.len"]`,
  `__str_charCodeAt` carrying none), `stringCharCodeAtProviderId` and the
  `#selectProvider` branch whose unavailable arm is a typed
  `provider-target-unavailable` naming `string-char-code-at policy charCodeAt=…`.
  No new implementation kind, no new validation rule.
- **`src/ir/intrinsic-support.ts`** (+46 net) — the `stringCharCodeAtDemand`
  input (and its place in the "freeze nothing at all" guard) plus
  `preparedStringCharCodeAtProvider`, the family's first twin that
  discriminates on the provider **ID** rather than the implementation kind,
  because both arms are `runtime-callable`.
- **`src/ir/integration.ts`** (+142 net) — `integrationStringCharCodeAtPolicy`,
  the TWO-PRODUCER `irStringCharCodeAtDemand`, the owner-local `unsupported`
  partition in the same pass as the eight existing ones, the freeze-time policy
  and demand arguments, the migrated instruction-path resolve arm, the two
  plan-path VERIFY arms, and the retired `emitStringCharCodeAt` fallback.
- **`src/ir/backend/linear-integration.ts`**, **`src/codegen/stdlib-selfhost.ts`**
  — both pass `STRING_CHAR_CODE_AT_POLICY_DISABLED` explicitly (+2 each).
- **`tests/issue-3526-string-boundary-charcodeat.test.ts`** (new, 31 tests).

`src/ir/from-ast.ts`, `src/ir/string-support.ts`, `src/ir/nodes.ts`,
`src/ir/lower.ts`, `src/ir/runtime-host-capabilities.ts`,
`src/codegen/char-code-at-helpers.ts` and every other resolve-table arm needed
**no edit**.

### Two producers, three arms — and why only one of them re-decides

The seam's shape is what makes this slice different from its four predecessors:
`s.charCodeAt(i)` reaches WasmGC codegen through TWO producers. The PLAN path
(`stringMethodPlan`) bakes the lane into the intrinsic SYMBOL before the
manifest is frozen (35 of 65 census cells); the INSTR path emits
`string.char_code_at` only with receiver-encoding evidence (5 cells, 4 of which
reach the GC arm). Re-deciding the plan symbol at resolve would be from-ast-side
vocabulary (#2955 discipline), so the migration splits:

- the **instr** arm is the R6-shaped decision — it stops reading
  `ctx.nativeStrings` and materializes whichever authority the frozen row names;
- the two **plan** arms keep their materializers and gain a fail-closed VERIFY
  (`arm.symbol !== symbol` → `selection-preparation-mismatch`). The policy
  refuses; it never re-lowers.

That is only honest if the demand counts both producers, which is why
`irStringCharCodeAtDemand` is the family's first scan that is not a single
`instr.kind` test. The proof-licensed symbols are deliberately excluded: a
hoisted char-read loop freezes no row, and its arms are untouched — the LOOP /
LOOPSUM byte fence is what makes that falsifiable.

### Divergences from the plan (recorded, not widened)

1. **Net src LOC is +351, not the plan's +230 estimate**, measured against this
   branch's own base. The structural reason is the one above and is recorded in
   the frontmatter grant: the migration lands THREE arms, not one, and the
   demand scan enumerates an instruction kind plus two call symbols.
2. **A `func-budget-allow` grant was needed and the plan did not anticipate
   one.** The three arms push `integration.ts::resolveAndObserveCallableProvider`
   from 261 to 330, across the 300-LOC threshold. Granted in this file's
   frontmatter with a dated rationale; splitting that dispatcher is #3399's
   work, not this slice's. (`compileIrPathFunctions` 3157 → 3198 and
   `makeResolver` 369 → 370 were already granted.)
3. **The plan's V-C prediction for the demand revert was right, and it is the
   F2-S4 divergence-5 shape rather than the F2-S3 one** — see the table below:
   dropping the plan-symbol half of the demand fails 5 tests, the demand pin
   plus every plan-path (c) pin, because sites 2/3 then find no row and fail
   closed. The linear (c) pin and the hoist fence still pass, which is exactly
   right: those cells never freeze a charCodeAt row.
4. **The (c) sha fence pins the two gc-host cells by sha and the three
   native-strings lanes STRUCTURALLY, not the plan's "all four GC lanes by
   sha".** Following F2-S5's divergence 5 verbatim: LOOP/LOOPSUM on gc-host are
   ~310-byte modules containing only the trusted helper, so the sha pin
   (`313 / d05f4670b1971be3`, `309 / df45ced9493b984e`) is specific and stable;
   the same trees on gc-native-strings / standalone / wasi are ~22 KB because
   they carry the whole native-string runtime, where a sha pin goes red on any
   unrelated runtime edit — a maintenance trap rather than a fence. Those three
   lanes are pinned on the hoist helpers being present (`__str_flatten`,
   `__str_flat_charCodeAt`) and the guarded helper absent. The 65-cell matrix in
   this PR is where their byte identity is established.
5. **The (c) runtime oracle needed FOUR owners, not one.** A single owner
   summing the four shapes is unusable as an oracle: `NaN` from the
   out-of-range read poisons every other case, so a wrong in-range answer would
   be invisible. The suite exports `at` / `first` / `neg` / `omit` and compares
   each to JavaScript with `Object.is`, NaN included.
6. **"One PR, two commits (E first, then the rest)" is F2-S6's instruction, not
   F2-S7's.** The dispatch brief carried it over; the F2-S7 plan says no such
   thing, and "E first" is impossible here — F2-S7's E is the kind-neutrality
   evidence refresh, which is a CONSEQUENCE of A–D's line numbers. Two commits
   were made in the only order that works: A–D + F + the grants, then E + this
   note.
7. **The pre-existing red control set is 15, not F2-S5's 31** — #5274's 17 are
   fixed on this base. Recorded above under P3 as a correction to the
   predecessor's count, not a finding about this slice.
8. **The kind-neutrality baseline was patched BY HAND**, following F2-S4's and
   F2-S5's precedent: the regenerator's output is a **269-insertion /
   85-deletion** diff for a 2-leaf change. Established by normalising both JSON
   documents to sorted leaf paths and diffing those — **462 leaves each, exactly
   2 changed**, both evidence strings (see V-D).

### V-A — measured neutrality: 65 of 65 byte cells, 104 of 104 corpus cells

Thirteen census fixtures (LOOP, LOOPSUM, LOOPNC, READ, CONST, NEG, OOB, OMIT,
TPL, FOROF, CHAIN, SUBCONST, CLEAN) × five lanes (gc-host, gc-native-strings,
standalone, WASI, linear). Each cell compares byte length, binary sha256, the
ordered import list with func/global indices parsed from the binary import
section, the error list, the `irOutcomes` demotion records and the full emitted
WAT text. **65/65 identical**, and `diff -r` over all 65 WAT texts is empty. The
12 demote/fail cells (SUBCONST ×4 via `preferLegacyFlatSubstringCharCodeAt`,
FOROF gc-host `charCodeAt on externref not in slice 4`, the 7 linear
`Unsupported method call: .charCodeAt()`) and the 8 hoist/trusted cells are
among them and did not move.

Corpus: every `.ts` under `website/playground/examples/**` and `examples/**`
(26 files) × four WasmGC lanes = **104 cells**, comparing sha256, byte length,
success and the full error list. **0 differing** (22 cells fail identically on
both trees — pre-existing).

`check:ir-fallbacks` run on both trees: **output byte-identical**.
`scripts/ir-fallback-baseline.json` and `scripts/linear-ir-baseline.json` are
untouched.

### V-B — the migrated decision is REACHED, and the retired one is not

With the instrumentation re-anchored to the AFTER tree's shape, the 65-cell run
emits the charCodeAt seam identically to the BEFORE run, counter for counter —
**24 counters, 0 differing**:

| probe | BEFORE | AFTER |
| --- | --- | --- |
| site 1, instr arm host (`ir-host-guarded`) | 1 | 1 |
| site 1, instr arm native (`ir-native-guarded`) | 3 | 3 |
| site 2, plan arm `__jsstr_charCodeAt` | 7 | 7 |
| site 3, plan arm `__str_charCodeAt` | 24 | 24 |
| `emitStringCharCodeAt` via provider | 4 | 4 |
| `emitStringCharCodeAt` via the RETIRED fallback | 0 (throw probe) | **0** |
| hoist arms `resolve:6425` flatten / flat | 6 / 6 | 6 / 6 |
| trusted arm `resolve:6437` | 2 | 2 |
| `plan:stringMethodPlan` host / native | 7 / 24 | 7 / 24 |
| `plan:charReadPlan` host-trusted / native-hoist | 3 / 9 | 3 / 9 |
| `plan:preferLegacyFlatSubstring` true | 8 | 8 |
| linear plan / emit | 8 / 1 | 8 / 1 |

The instrumented AFTER run is itself **byte-identical to the clean AFTER run**
(65/65), so the instrumentation is byte-inert and the comparison is honest.

**Runtime oracle.** `at(s, i)`, `first(s)`, `neg(s)` and `omit(s)` are checked
against JavaScript through an instantiated host-lane module over four inputs
(ASCII, an astral pair, BMP non-ASCII, the empty string) × seven indices
(0, 1, 2, 10, −1, 0.9, 1.5) — in-range ASCII, NaN out of range, negative index,
fractional index through ToIntegerOrInfinity, both halves of a surrogate pair,
a BMP non-ASCII code unit, and the omitted index that pads to 0. Compared with
`Object.is`, so NaN identity is checked rather than skipped. The same source
compiles and emits on a native-strings lane, and a linear module carrying the
READ / CONST / OOB shapes instantiates and runs (`oob()` is NaN).

### V-C — non-vacuity, each sub-edit reverted independently

| revert | tests failing | which |
| --- | --- | --- |
| site 1 (restore the `ctx.nativeStrings` ternary) | **3** | exactly the three (d) instr-arm pins; 28 others green |
| the sites 2/3 VERIFY only | **2** | exactly the two (f) plan-path pins; 29 others green |
| site 4 (restore the emitter fallback) | **1** | "keeps the retired fallback's lane read and both materializers out of the emitter" — the discriminator; 30 others green |
| the demand's plan-symbol half | **5** | the (d) demand pin plus every plan-path (c) pin — interlocked, the F2-S4 divergence-5 shape the plan predicted; the linear (c) pin and the hoist fence still pass, because those cells freeze no row |
| the two manifest provider rows | **12** | all of (a)/(b) that read a row plus every plan-path (c) pin — the whole seam, by design: after the migration the frozen row is the only source of the physical choice and the arm fails closed |

As in every family-2 slice, the (d)/(e)/(f) pins are deliberately
**source-shape** assertions: the policy projection reproduces the old truth
table exactly, so both forms emit identical bytes on every lane — which is the
point of the slice and why all 65 cells are unchanged. What moved is WHICH
authority answers, and on this seam that is only observable in source.

### V-D — gates

Green: `typecheck`; the five ratchets run **bare**, again under
`LOC_GATE_BASE=$(git rev-parse origin/main)`, and once more against the F2-S5
branch tip while stacked — loc (+351 net src LOC, every grown path granted by
this file's frontmatter with the dated F2-S7 rationale; `runtime-manifest.ts`
2131 → 2270, `integration.ts` 9112 → 9348 against main), func
(`resolveAndObserveCallableProvider` 261 → 330, newly granted — divergence 2),
coercion-sites, oracle-ratchet (`getTypeAtLocation` +0, `ctx.checker` +0),
dead-exports (25 known entries, 0 new). Also green: `lint`,
`prettier --check` on every touched path, `check:ir-dialect`,
`check:ir-layering` (86 import lines, baseline 86), `check:ir-only`,
`check:linear-ir`, `check:host-import-policy` (**output byte-identical to a
base-tree run** — no new `env` import, no new builtin),
`check:test-vacuity-shapes`, `check:ir-kind-neutrality` (after the surgical
refresh below), and `check:ir-fallbacks` (diffed against a base-tree run of the
same command, output byte-identical).

**Kind-neutrality refresh: TWO evidence lines, patched surgically.**
`forof.string` `src/ir/integration.ts` 6629 → 6766 (the policy, demand,
partition and three arm edits inserted above it) and `string.len`
`src/ir/backend/linear-integration.ts` 1632 → 1634 (the two-line adapter edit) —
exactly the two lines F2-S4 and F2-S5 predicted would move again. Normalising
both JSON documents to sorted leaf paths: **462 leaves each, exactly 2
changed**, both evidence strings. No verdict, kind, placement, ratchet count or
`settledBy` rationale moved, and `string.char_code_at` keeps the verdict it
carried.

Focused suites: the new suite (31 tests) plus all #3526 suites, both async
suites (#4103/#4104), #3520 callable-preregistration and callable-provider-abi,
#3521 prepared-component-dependencies, #3931, #4517, #1105 ×3, #2742
charCodeAt-new-string, `linear-charcodeat-ascii-fast-path`,
`string-derived-length-fast-path`, `host-string-prefix-suffix-fast-path`,
`strings`, `native-strings` ×3 and the #5274 / Binaryen control files —
**635 passing across 40 files**. The only failures anywhere are the 15
pre-existing reds described under P3, unchanged name for name.

**One suite could not be run in this container, on EITHER tree:**
`tests/issue-3518-multi-prepared-string-leaf-planner.test.ts` OOMs the vitest
worker (`Reached heap limit`). F2-S4 and F2-S5 recorded the same; CI runs it
with a larger heap.

### Not touched (per the plan's scope discipline)

The proof-licensed TRUSTED/HOIST feature — `charReadPlan`, the
`__jsstr_charCodeAt_trusted` arm, the `__str_flatten` + `__str_flat_charCodeAt`
preheader pair and their arms, `matchProvenCharRead` — all deferred, and the
LOOP/LOOPSUM byte fence proves they did not move. Also untouched:
`stringMethodPlan`'s mode→symbol mapping (the demand scan mirrors it rather
than replacing it), `preferLegacyFlatSubstringCharCodeAt` and the SUBCONST
demote, the FOROF gc-host `charCodeAt on externref` demote, the 7 linear
`.charCodeAt()` compile failures, `charAt`, `src/ir/from-ast.ts`,
`src/ir/string-support.ts`, `src/ir/lower.ts`, `src/ir/nodes.ts`,
`src/ir/runtime-host-capabilities.ts` (the `string.char_code_at` and
`string.len` records are unchanged — this slice only NAMES them), the
`fast: true` lane, `string.const` (F2-S8), and every existing policy —
`numberBoundary`, `booleanBoundary`, `externIsUndefined`, `generatorNumberBox`,
`stringCompare`, `stringEq`, `stringLen`, `stringConcat` — all unchanged.

**F2-S6's seam is untouched by construction**, and deliberately so: the batched
many-arity concat family (`string.concat$arityN`,
`async.string.concat$arity5`, the `batchStringConcat` pass call,
`native-batched-concat.ts`, `src/ir/passes/batch-string-concat.ts`) carries no
edit from this slice. Whichever of F2-S6 / F2-S7 lands second re-merges and
re-anchors the adjacent policy field, `#selectProvider` branch, partition block
and adapter lines.

## 2026-09-02 F2-S6 implementation checkpoint — Opus lane

Implemented from the `## 2026-09-02 F2-S6 implementation plan` section above,
on `claude/issue-3526-f2s6-batched-concat`, branched from
`origin/claude/issue-3526-f2s5-string-concat` (tip `6d6425c8e3`, PR #5467) and
merged with `origin/main` `ed829da99` plus the plan branch
`claude/docs-r6-f2s6-s8-plans` `04b903c4a`. Base for every measurement below:
`9e466d4b` (that merge). **Held: this PR is stacked on #5467 and must not be
enqueued before it lands.**

### P1 — the BEFORE byte matrix on this lane's own base

Ran `f2s6/f2s6-matrix.mts` uninstrumented on `9e466d4b`, with the wasi edge
cell added to the driver as an explicit 85th measurement (a `PLAN` list of
`(fixture, lane, options)` triples so the edge cell rides the identical
measurement path as the 14×6 grid).

- **84/84 grid cells identical to the census record `f2s6/matrix.json`** —
  bytes, sha256, success and the ordered import list, every cell. F2-S5 is
  byte-neutral on this family as its own V-A claimed, and main's advance from
  the census grounding moved nothing in `src/` that this family reads. No
  finding to report against F2-S5.
- **The 85th cell**, `CAT3` on `{target:"wasi", nativeStrings:false,
  strictNoHostImports:false}`: **1000 bytes, sha `ebc5bc839cba`, one func
  import `wasm:js-string.concat#0`, pairwise, no `__concat_`, no demotions.**
  Reproduces the census's separate-probe figure exactly and confirms `!ctx.wasi`
  in the host selector is LIVE — the projection keeps a wasi term.
- Instrumentation: the census's `f2s6-instrument.py` carries the known
  `ctx.mod.funcs` defect and its anchors target the base tree's code, which
  this slice rewrites. Rather than patch it, re-anchored counters for the four
  seam sites were written for **both** trees (`.tmp/reach/inst-{base,new}.py`)
  so the two runs are comparable. **Instrumentation is byte-inert: 85/85 on the
  base tree and 85/85 on the modified tree against the uninstrumented BEFORE
  record.**

### P2 — what the freeze input carries

Confirmed structurally and by the reach counts.

- Pass and freeze are in one function. `batchStringConcat` runs in the
  `modAfterTU.functions` loop inside `compileIrPathFunctions` and its result is
  pushed as `readyForLower.push({ …, fn: final })`; `readyForLower` becomes
  `healthyForLower`, which is the exact argument to
  `prepareBuiltFnRuntimeManifest(ctx, sourceFile.fileName, healthyForLower)`.
  **So `healthyForLower` carries the batched `final` and the post-pass demand
  scan at freeze sees every fused root.** `<module-init>` entries are ordinary
  `BuiltFn`s in that same list and are not special-cased anywhere on the path.
- **No reader of the family symbols sits between pass and freeze.** The only
  readers in `src/` are the two resolve arms in `integration.ts`, which run
  during lowering — after the freeze. The only producers are
  `batch-string-concat.ts` (the pass) and `async-ir-planning.ts` (async
  planning, which runs before the IR path). Verified by exhaustive grep on
  `parseIrStringConcatManyArity` / `irStringConcatManySymbol` /
  `IR_ASYNC_STRING_CONCAT_5_FN` / `IR_STRING_CONCAT_MANY_PREFIX`.

### P3 — consumers of the widened types

Enumerated every reader; **nothing maps a family row or record to a concrete
import before the resolve arm**, so the plan's STOP condition does not fire.

- `ADMITTED_CALLABLE_TARGETS` (`intrinsic-support.ts:83`) — positive check
  `kind !== "host-callable" && kind !== "runtime-callable" → continue`. Skips
  both family kinds. No edit, as the plan says.
- `providerAttachment` (`intrinsic-support.ts:218`) — the one site that maps a
  provider to an `irImportFuncRef`. Reachable **only** through
  `manifest.intrinsicUses`, i.e. only for ids in `INTRINSIC_DEFINITIONS`. The
  family answers free-form symbols, not `IntrinsicId`s, so no family row can
  reach it — and its argument type `RuntimeProviderPlan` narrows
  `implementation` to `IntrinsicRuntimeProviderImplementation`, which this
  slice deliberately does not widen. Double exclusion.
- `resolveProvider`'s intrinsic overload is typed on `IntrinsicRuntimeFeature`
  (the `intrinsics.ts` feature union). `js.string.concat.many` is a
  `runtime-manifest.ts` feature only — same shape as F2-S5's `js.string.concat`.
- Async attachment: `intrinsic-support.ts:669` and
  `async-runtime-providers.ts:120` filter by `isAsyncHostCapabilityId`;
  `async-plan.ts:442` filters `hostCapabilityRecords` by the capability set the
  owner's ASYNC providers declare — none names the family — so the family
  record never reaches `asCallableRuntimeHostCapabilityRecord` there.
- Edited in E, as planned: `assertRuntimeHostCapabilityRecord` (a `func-family`
  arm), `canonicalizeRuntimeHostCapabilityCatalog` (accepts the kind through
  that arm and counts the id for completeness), and the plain func resolver,
  which already throws on a non-`func` kind via
  `asCallableRuntimeHostCapabilityRecord`.
- No `scripts/` consumer of the catalogue exists. `catalogProgramAbiCallableImports`
  catalogs ctx imports, not records — confirmed not a consumer.

### P4 — the async5 arm off-lane

**Measured, on this lane's own base, instrumented.** The `concat-async5` arm
reaches exactly twice across the 85 cells: `ASYNC/gc-host` once (`host×5`,
`batch === "host"`) and `ASYNC/standalone` once (`native×5`,
`batch === "native"`). **It reaches ZERO times on every `batch === "off"`
lane**, and for three different reasons: `gc-native-strings` demotes `main`
with `call-graph-closure`; `wasi` demotes it with `async-function` and the
LEGACY native twin mints `__str_concat_5` instead (`legacy-native-batched:5`
×2); `gc-strict` fails to compile at all (`main:host-surface-unavailable`).
`linear` never enters the path.

So the answer is: **the async5 ref cannot be minted with `batch === "off"`
today — but that is a demotion fact, not a structural one.**
`isPreparedIrAsyncConcat` → `preparedIrAsyncSourceShape` is pure source shape
plus checker queries; it reads no lane flag whatsoever. If a future change
stopped that demotion on `gc-native-strings`, today's arm would resolve through
`ctx.nativeStrings → ensureNativeBatchedConcat`, and selecting the row by
`stringConcat.concat` (`nativeStrings ? native : host`) reproduces exactly
that. Selecting it by `batch` would throw. **This is the measurement that
justifies contract item A4's key.**

### P5 — the two at-ceiling ratchets, and the base red set

- `check:host-import-policy` bare on the **modified** tree, exit 0:
  `nativeFirstTotals.imports = 395` (ceiling 395),
  `compatibilityLegacySemanticImports = 23` (ceiling 23),
  `legacySemanticImports = 0`, `unknownImports = 0`, probes 33.
  **Both at-ceiling ratchets unchanged** — the census's inference confirmed by
  a run on a modified tree, which it had not been.
- **Base red set: 90 red entries** (88 failed tests + 2 suite-level failures)
  across **339 suites / 1,427 tests** in a 108-file control set covering every
  fence the plan names, every `#3526` suite, every concat/string/IR-manifest
  suite and every `optimize`-using suite. `tests/issue-3518-multi-prepared-string-leaf-planner.test.ts`
  is excluded — it OOMs the vitest worker on this 4-core box; CI runs it.
  **The AFTER run over the identical file list returns the identical red set,
  name-for-name: 90 entries, 339 suites, 1,427 tests, 88 failed.** No red
  gained, none lost.
- **The count is 90, not 31.** The plan's brief cited "F2-S5's checkpoint lists
  31 such reds by name" — see divergence 1: that checkpoint does not exist, so
  the figure could not be inherited and was measured here instead.
- **Two of the plan's named fences are ALREADY RED on the base**, and this is
  worth stating plainly: `tests/issue-958-concat-chain.test.ts:41/50`
  ("3-operand chain uses `__concat_3`", "6-operand chain uses `__concat_6`").
  Both fixtures are all-literal chains (`"hello" + " " + "world"`), which
  constant-fold upstream to fewer than three leaves, so the pass never fuses
  them — the same upstream fold the census recorded for its `LITRUN` fixture.
  Pre-existing, unrelated to this slice, and unchanged by it. The remaining
  `issue-958` assertions (the 2-operand negative and the runtime checks) are
  green on both trees.
- The full 3,899-file unit suite was **not** run locally — at the measured
  throughput it is a multi-hour job on this box and is CI's work. The control
  set is what was measured, and it is stated as such rather than as a whole-suite
  claim.

### Verification matrix

**V-A byte neutrality — 85/85.** Every cell of the census's 84-cell grid plus
the wasi edge cell came back identical on the final tree: **bytes, sha256,
success, the ordered import list with indices, the demotion list, and the WAT
text** (`diff -rq` over all 85 WAT files). Contract E alone was measured
separately and is byte-inert on its own (85/85). `check:ir-fallbacks` output is
**byte-identical** to a base-tree run of the same gate (file-copy A/B, not
stash). **Reach counts are identical 85/85** between the instrumented base and
the instrumented modified tree, per cell and per site. Totals across the matrix:
`concat-many` host ×8 / native ×7, `concat-async5` host ×1 / native ×1,
`batch-decision` 15 changed (8 host, 7 standalone) / 79 unchanged,
`native-batched` 11 mints + 1 cache hit.

Sha pins carried into the new suite, all measured on `9e466d4b`:
`CAT3` 149/`4677a84a2dcd` (deliberately the same cell F2-S5's fence pins),
`CAT9` 167/`c11957fc8004`, `TPL6` 235/`1d7f766908cf`,
`TPLEQ` 246/`7e6dac42d3c7`, `CATNUM3` 199/`a4af808e0009` (the legacy-twin
control), `ASYNC` 10021/`3c072b5822b4` with `__concat_5` at import index 21
of 27, and the edge cell 1000/`ebc5bc839cba`.

**V-B pins.** The new suite `tests/issue-3526-string-boundary-concat-many.test.ts`
is 33 tests, all green. Every fence the plan lists is unchanged (the two
`issue-958` assertions above were already red on the base and are red
identically after). F2-S5's concat suite is green unchanged, its "leaves the
BATCHED many-arity family byte-identical — the F2-S6 fence" test included.

**V-C non-vacuity — every count MEASURED, each revert independent.**

| revert | reds in the new suite | bytes |
| --- | --- | --- |
| item 11 only (pass selection back to the four-flag read + literal 8) | **1** — the (d) batch-selection pin | unchanged (the projection is verbatim; every (c) end-to-end pin stayed green) |
| item 12 only (both arms back to `ctx.nativeStrings`, shared lowering deleted) | **3** — the (d) arm pin, the (d) late-mint pin, the (d) fail-closed pin | unchanged (same reason) |
| the two provider rows only | **16** — all of (a) except the record shape, all of (b) except the defaults, and **every (c) end-to-end batching pin** | CHANGED — the arms fail closed, which is the F2-S4 "frozen row is the only physical authority" behaviour |
| the cross-policy rule only | **1** — its single (b) pin | unchanged |
| the range import in `native-batched-concat.ts` only | **1** — the (a) single-authority pin | unchanged |

Divergence from the plan's prediction on revert 12: it predicted "the (d) arm
pins + the (e) unfrozen-family pin". The (e) pin exercises
`preparedStringConcatManyProvider` directly, not through the arm, so reverting
the arm leaves it green — it is a pin on the accessor, not on the arm. A first
pass at the revert also left the (d) fail-closed and late-mint pins green
because deleting only the two CALL SITES leaves the shared lowering in the file
for the source pin to find; the faithful revert deletes the helper too, and
then all three go red. Both facts are recorded rather than papered over, and a
**fail-closed source pin was ADDED** during V-C for exactly this reason — the
plan's (d) list did not include one, and without it "fails closed" was carried
only by a test that the arm's own removal cannot reach.

**V-D gates.** All green.

- The five ratchets chained (`check-loc-budget`, `check-func-budget`,
  `check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`) — exit 0.
- The same two under `LOC_GATE_BASE=$(git rev-parse origin/main)` (`ed829da99`)
  — exit 0 each, run bare.
- `typecheck`, `lint` — exit 0. `prettier --check` over every file this PR
  touches — clean. Repo-wide `prettier --check src tests scripts plan` reports
  9 files, **all pre-existing and none touched by this PR**
  (`plan/probes/3603/*`, `plan/probes/3976/synt2.mts`,
  `tests/dogfood/setup-lit-upstream-suite.mjs`,
  `scripts/godfile-profile-baseline.json`).
- `check:ir-dialect`, `check:ir-layering`, `check:ir-only`, `check:linear-ir`,
  `check:host-import-policy`, `check:test-vacuity-shapes`,
  `check:ir-kind-neutrality` — exit 0 each, run bare, status never piped.
- `check:ir-layering` note: the new `codegen → ir/runtime-manifest` import in
  `native-batched-concat.ts` is invisible to that gate by construction — the
  gate counts `src/ir/**` importing `src/codegen/**`, the opposite direction.
  No new `ir → codegen` import line was added, so no per-file count moved.
- `check:ir-kind-neutrality`: refreshed **surgically**. `--update-on-decrease`
  rewrites the whole file with expanded arrays (269 insertions / 85 deletions,
  a formatting churn that would bury the real change), so its output was used
  only to compute the sorted-leaf diff, the file was restored, and the **two**
  changed leaves were edited by hand: `kinds.forof.string.evidence.1`
  `src/ir/integration.ts:6629 → :6750` and `kinds.string.len.evidence.1`
  `src/ir/backend/linear-integration.ts:1632 → :1634`. **No verdict moved.**
  The gate then passes on the hand-edited file.

**LOC — measured +738 net src lines**, against the plan's +400–500 estimate.
The overshoot is structural, not sprawl, and the grant block in this file's
frontmatter names both reasons: the slice adds a whole new CAPABILITY RECORD
KIND (not merely a provider implementation kind — a third id list, a
field-scheme list, a params scheme, a record type, a factory, a validator arm
and a synthesizing resolver, +247 in `runtime-host-capabilities.ts`, the same
shape and nearly the same size as F2-S2's +239 for the global kind), **and**
two provider implementation kinds at once with a validation triad each
(+283 in `runtime-manifest.ts`), where F2-S4 added one. Per file: `runtime-manifest.ts`
+283, `runtime-host-capabilities.ts` +247, `integration.ts` +121,
`intrinsic-support.ts` +78, `native-batched-concat.ts` +5,
`stdlib-selfhost.ts` +2, `linear-integration.ts` +2.

### Divergences from the plan

Every one is recorded with the measurement that decided it. **Where the tree
disagreed with the plan, the tree won.**

1. **The F2-S3, F2-S4 and F2-S5 checkpoint notes do not exist.** The plan's
   brief directs the implementer to read them ("the F2-S4 / F2-S5 checkpoint
   notes", "F2-S5's checkpoint lists 31 such reds by name", "F2-S5's checkpoint
   explains why standalone sha pins are a trap", "F2-S5's checkpoint documents
   how" the kind-neutrality baseline is refreshed). Measured: the issue file on
   `origin/main`, on `claude/issue-3526-f2s5-string-concat` and on
   `claude/docs-r6-f2s6-s8-plans` carries **plans** for F2-S3/S4/S5 but the
   last checkpoint notes in the file are F2-S1's and F2-S2's. Consequences,
   all handled by measuring instead of inheriting: the red set was measured
   here (90, not 31); the standalone-sha-pin decision was taken from the census
   directly and the standalone cells are pinned structurally; the baseline
   refresh procedure was derived from the gate's own `--update-on-decrease`
   output plus a sorted-leaf diff. This note follows the F2-S1/F2-S2 shape.
2. **A schema pin the plan's "existing pins that move" list did not name.**
   `tests/issue-3526-string-boundary-schema.test.ts` "leaves the twelve
   pre-existing rows untouched" filters `RUNTIME_HOST_CAPABILITY_RECORDS` by
   `!NEW_ID_SET.has(...)` and asserts length 12; a nineteenth id that is not in
   F2-S2's fixed `NEW_IDS` six makes it 13. Adding `string.concat.many` to
   `NEW_IDS` was rejected — `STILL_UNPROVIDED_IDS` derives from that list and
   must stay at 3 (which it does; the plan and the census are both right that
   `:378` does not move). A separate `LATER_SLICE_IDS` constant was added and
   excluded in that one filter, so the pin keeps meaning *pre-F2-S2* instead of
   drifting into "everything not new today".
3. **`numberBoundaryProvider`'s `signature` parameter had to become optional.**
   The plan's design bullet 3 requires both family rows to carry NO signature,
   but the shared factory typed it as required. It is now
   `IntrinsicSignature | undefined` and the key is OMITTED rather than set to
   `undefined`, because `RuntimeProviderDefinition.signature` is an optional
   field and a row that carries none must not carry the key. Pinned in (a).
4. **A fail-closed source pin was added to the (d) list** (see V-C above).
5. **The native max-arity is pinned by import-and-behaviour, not by exporting
   `MAX_BATCHED_CONCAT_ARITY`.** The plan's (a) asks that
   "`MAX_BATCHED_CONCAT_ARITY` equals it by import, not by copy". Exporting a
   constant read only by a test is a weaker guarantee than what is done
   instead: `STRING_CONCAT_MANY_NATIVE_ARITY` is asserted to be `{3,8}`,
   `stringConcatManyArityCap("native")` is asserted to derive `8` from it, the
   source of `native-batched-concat.ts` is pinned to contain
   `STRING_CONCAT_MANY_NATIVE_ARITY.max` and to contain no
   `MAX_BATCHED_CONCAT_ARITY = 8` literal, and the CAT9 standalone cell proves
   the ceiling behaviourally. V-C revert 5 shows the pin is non-vacuous.
6. **The runtime oracle runs a different shape on the native-strings lane.**
   The plan's (c) asks for an oracle "on host and native-strings lanes". A
   native-strings module's string params and results are `(ref $AnyString)`
   carriers that cannot cross the JS boundary, so the host lane takes strings
   in and out while the native lane builds the chains from literals inside the
   module and returns their UTF-16 code-unit LENGTH. That still exercises the
   batched helper end to end — length summing and per-operand copying are
   exactly what a wrong answer corrupts — and covers the same four hazardous
   leaf shapes (empty, lone surrogate halves, non-ASCII BMP and astral, a
   numeric-looking leaf).
7. **The `f2s6-matrix.mts` driver needed a structural change for the edge
   cell**, not just an extra lane: adding a 7th lane to `LANES` would have made
   98 cells, not 85. The grid and the edge cell are now driven from one
   explicit `(fixture, lane, options)` plan list, so the edge cell rides the
   identical measurement path.

### Not touched

`src/ir/passes/batch-string-concat.ts` (its `maxArity` parameter stays a
number; `tests/ir/passes.test.ts:489` is unchanged and green),
`src/ir/string-runtime.ts`, `src/ir/async-semantic-runtime.ts`,
`src/codegen/async-ir-planning.ts`, `preregisterCallableProviders`,
`late-imports.ts`, the legacy twins (`string-ops.ts`'s `compileBatchedConcat`
and the native twin, `eval-inline.ts:2372`), the JS providers in `runtime.ts`,
the `__concat_N` host-import classification, and — per the parallel-lane
partition — every `charCodeAt` line (`IR_STRING_CHAR_CODE_AT_FN`,
`JSSTR_CHARCODEAT_FN`, `NATIVE_CHARCODEAT_FN`, `char-code-at-helpers.ts`,
`stringMethodPlan`, `charReadPlan`), which F2-S7 owns.

### 2026-09-02 F2-S8 checkpoint note — Opus lane

Implemented from the `## 2026-09-02 F2-S8 implementation plan` section above,
on `claude/issue-3526-f2s8-string-const`, branched from
`origin/claude/issue-3526-f2s6-batched-concat` (tip `828a9c1fe`, PR #5473 —
which already carries F2-S7's branch, merged there at `828a9c1fe0`), then
`git merge origin/main` (`47e337f3b`). Base for every measurement below:
`c3f50982` (that merge). Slice claim `3526:f2s8`. Every probe was measured on
this branch's own tree BEFORE the first source edit. **Held: this PR is stacked
on #5473 and must not be enqueued before it lands.**

Family 2's last slice. It is the one that gives a GLOBAL host capability a
provider for the first time, and the one where "the manifest is the authority"
had to be made falsifiable by a test rather than by bytes — see P3 and V-C
revert 4.

#### P1 — the BEFORE byte matrix reproduces the census record EXACTLY, on a base three slices ahead of it

`census-string-const-matrix.mts` was re-pointed to this worktree (`.tmp/`, the
driver imports `../src/index.js`), extended with the two fixtures the census
cites but does not tabulate — BOOLTPL
(`` export function f(b: boolean): string { return `${b}`; } ``) and REGEX
(`export function f(s: string): boolean { return /ab+c/i.test(s); }`) — and
given one more recorded field, the linear `getLastLinearIrReport()` text, which
V-A requires and the census driver did not capture. 15 fixtures × 6 lanes =
**90 cells**.

- **78 of 78 census cells identical to `probes/f2s8/census-string-const-matrix.json`**
  on every field that record carries: success, byte length, sha256, the ordered
  import list with func/global indices parsed from the binary import section,
  the run-length import shape, the `string_constants` / `string_constants16`
  global lists, the error list and the demotion list. **0 differing fields.**
  The record was made on `a07f65319f`; it reproduces on a base that is F2-S6 +
  F2-S7 + today's `origin/main`, which independently confirms the byte-neutrality
  claims of F2-S5, F2-S6 and F2-S7 for this family. **No finding about any
  predecessor.**
- The 12 new cells have no census BEFORE, so they are recorded here:

| fixture | lane | bytes | sha12 | import shape | string_constants |
| --- | --- | --- | --- | --- | --- |
| BOOLTPL | gc-host | 205 | `8adf0a76a611` | `func:wasm:js-string×1 → global:string_constants×4` | `"f"@0 ""@1 "true"@2 "false"@3` |
| BOOLTPL | gc-native-strings | 39692 | `7933fb0e5199` | `func:env×3` | — |
| BOOLTPL | standalone | 39856 | `c10a30feb5fb` | (none) | — |
| BOOLTPL | wasi | 39883 | `39bb8d5f0edb` | (none) | — |
| BOOLTPL | linear | 4946 | `098f63be25b0` | (none) | — |
| BOOLTPL | standalone+utf8 | 41254 | `31b0417290ca` | (none) | — |
| REGEX | gc-host | 230 | `ca7df6a68375` | `func:env×2 → global:string_constants×4` | `"f"@0 "ab+c"@1 "i"@2 ""@3` |
| REGEX | gc-native-strings | 22575 | `b1970f24bc63` | `func:env×5` | — (demotes `f:operand-coercion-unsupported`) |
| REGEX | standalone | 133706 | `ccfaf12b2ad5` | (none) | — (demotes `f:regexp-constructor-unsupported`) |
| REGEX | wasi | 0 | — | compile fails | — (`f:regexp-constructor-unsupported`) |
| REGEX | linear | 0 | — | compile fails | — |
| REGEX | standalone+utf8 | 135125 | `21d27ae7bf0d` | (none) | — (demotes `f:regexp-constructor-unsupported`) |

**The base red set is 16 failing tests across 6 files, not F2-S7's 15 or
F2-S6's 90** — measured on this base before the first edit over a 51-file
control set (826 tests) covering every suite the census's `## pins` block names,
every `#3526` suite, both async suites, the #3520/#3521 ABI suites, the string
family and every `optimize`-using control. The census's "red today" note is
confirmed stale: `imported-string-constants` (4) and `issue-320` (1) are
**green** here, so #5465 did fix them.

| suite | failures | cause |
| --- | --- | --- |
| `issue-1761` | 9 | `optimize` — `distinct rec groups would be identical after binary writing (to resolve this, use --enable-gc)` |
| `issue-2598-2599-string-arg-tostring` | 3 | same |
| `issue-2163` | 1 | same |
| `issue-3744-ir-owned-append-string-builder` | 1 | same, one step later |
| `string-derived-length-fast-path` | 1 | `RuntimeError: illegal cast` — the red F2-S7 also names |
| `issue-2515` | 1 | "defineProperty redefine still throws catchable TypeError in host mode" — `expected NaN to be 1` |

18 error lines print the rec-group message. **The `issue-2515` red is the one
addition to F2-S7's list**, measured here rather than inherited; it is on this
box's Binaryen path like the rest and is not this slice's. The AFTER run over
the identical file list plus the new suite returns the **identical red set,
name for name**: 16 failed, 853 passed (869) across 52 files.

**One suite could not be run in this container, on the BASE tree, before any
edit:** `tests/issue-3518-multi-prepared-string-leaf-planner.test.ts` OOMs the
vitest worker (`FATAL ERROR: Ineffective mark-compacts near heap limit`). F2-S4,
F2-S5, F2-S6 and F2-S7 recorded the same; it is measured here rather than
inherited, and it is excluded from the control set. CI runs it with a larger
heap.

#### P2 — the window is two passes wide, and no observation ordinal moves

**(i) Nothing between `prepareStrings`' return and the new `prepareStringConst`
call pushes a global, adds an import global, or reads
`string.const.storage`/`.materializer`.** The window is exactly
`prepareIrRuntimeManifest` plus `prepareStringLength`, and nothing else:
`prepareStrings` is called at `integration.ts` `compileIrPathFunctions`,
`prepareBuiltFnRuntimeManifest` is the very next `runGlobalPreparation`, and the
new pass sits inside it after `prepareStringLength` and before
`materializePreparedMathProviders`. `prepareIrRuntimeManifest` short-circuits on
`instr.kind !== "intrinsic"` and neither it nor `runtime-manifest.ts` contains
`ctx.mod.globals`, `addStringConstantGlobal` or `ensureLateImport`;
`prepareStringLength` only READS (`catalogProgramAbiCallableImports`,
`registry.stringCarrierRef()`). The only `"string.const"` reader in any of the
three files is `string-support.ts`'s attach arm, which is the pass itself.

**(ii) `observe` after preregistration: three call sites in `integration.ts`,
and the ordinal is unchanged.** The plan expected `:6301`/`:6563` (inside
`resolveAndObserveCallableProvider`) and the materializer's own. Measured, the
three are `observeNativeRuntimeProvider` (`:6559` at the base), the tail of
`resolveAndObserveCallableProvider` (`:6919`), and `materializerForConst`
(`:7746`) — so the plan's count is right but one of the two non-materializer
sites is NOT inside the dispatcher. **That is the divergence, and it is
harmless:** `observeNativeRuntimeProvider` is reached only from
`preregisterDynamicAndForInSupport`, which runs AFTER
`prepareBuiltFnRuntimeManifest` in the pipeline, exactly as
`preregisterCallableProviders` does. The materializer's observation therefore
moves from just before the freeze to just inside it — still before every other
observer and long before `planRetained()` seals the registry. Decisive form, as
the plan prescribed: the LONG12000 native cells and DUP are byte-identical on
all six lanes, and the instrumented reach counts are identical per cell
(`materializer/observe` = 4 before and after).

#### P3 — the fallback is NOT retired, on a measurement: N = 2

A counter was placed in both no-storage branches of `emitResolvedStringConst`
and the 90 cells re-run. The instrumentation is byte-inert (90/90 identical to
the clean BEFORE record, `diff -r` over all 90 WAT texts empty), so the counts
are honest.

- **`string.const` reaches the fallback ZERO times, on every one of the 90
  cells** — before AND after the migration.
- **`extern.regex` reaches it exactly TWICE**, both on `REGEX/gc-host`, both
  through the `stringGlobalMap` branch (the plan's `:6596`), once for the
  pattern `"ab+c"` and once for the flags `"i"`.
- **The native branch (`:6589`) is reached zero times**, and the reason is a
  demotion rather than a structural absence: `REGEX/gc-native-strings` demotes
  with `operand-coercion-unsupported` and the three standalone/wasi cells with
  `regexp-constructor-unsupported`, so no regex literal ever reaches emission on
  a native lane in this corpus.

**N > 0 ⇒ contract item 13 stands and the fallback is kept**, exactly as the
plan's conditional says. Retiring it needs `extern.regex` to carry a `storage`
of its own, which is the next slice's work. The manifest still counts a regex
literal as demand (item 11) so a regex-only module's `hostCapabilityRecords`
truthfully names `string_constants`; the caveat is pinned positively in the new
suite rather than left implicit.

#### P4 — mint timing is unchanged, and every closed enumeration still excludes the new kinds

**Mint timing, instrumented at `prepareStrings`' own `addStringConstantGlobal`
call:** BOOLTPL on `gc-host` mints exactly TWO globals (`already:false`),
`"true"` at import-global count 2→3 and `"false"` at 3→4, both with
`ctx.mod.functions.length === 1` and `ctx.mod.globals.length === 1` — i.e.
thresholds 2 and 3, delta 1, one `fixupModuleGlobalIndices` per literal, from
`prepareStrings`, BEFORE the freeze. Exactly the plan's prediction. Across the
90 cells the site fires 18 times: 16 `already` and those 2 mints. **Registration
happens where it always did; only the label moved.** REGEX/gc-host shows FOUR
`already` events for two literals, reproducing the census's unexplained
double-`prepareStrings` run — observed again, still not traced, and out of
scope.

**Closed enumerations:** `grep -rn resolveRuntimeHostCapabilityFuncRecord
src/ir/**` finds **seven** call sites, all in `intrinsic-support.ts`
(`:98/:240/:285/:320/:362/:402/:453`) plus the definition — the plan's "six on
main, seven on the F2-S5 branch" holds at seven here. Every one is inside a
`implementation.kind === "host-callable"` branch or inside
`ADMITTED_CALLABLE_TARGETS`, whose filter is POSITIVE
(`kind !== "host-callable" && kind !== "runtime-callable" → continue`) and
therefore skips both new kinds with no edit. `asCallableRuntimeHostCapabilityRecord`
has two consumers, `async-plan.ts:450` and `async-runtime-providers.ts:106`,
both async-scoped. In tests, the only closed `implementation.kind` enumerations
are `issue-4104:453/:457`, both over an ASYNC-ONLY freeze's own providers —
F2-S4's finding, unchanged by F2-S5/S6/S7. Fourteen suites walk
`hostCapabilityRecords`; none assumes a func record for a string-const row, and
all fourteen are green after.

#### P5 — layering unchanged, two evidence lines move

`check:ir-layering` reports **86 import lines across 15 files (baseline 86)**
both before and after. The new `import { hasLoneSurrogate } from
"../string-surrogate.js"` in `integration.ts` is invisible to the gate BY
CONSTRUCTION, not by luck: the gate RESOLVES specifiers and counts only those
under `src/codegen/`, and `src/string-surrogate.ts` is neither — it is the
shared compiler/runtime module the legacy collector already derives the same
key from. Using `src/codegen/registry/imports.ts` instead would have grown the
count by one.

`check:ir-kind-neutrality`: **two** evidence lines move,
`kinds.forof.string.evidence.1` `src/ir/integration.ts` 6887 → **7095** and
`kinds.string.len.evidence.1` `src/ir/backend/linear-integration.ts`
1636 → **1638** — exactly the two every predecessor from F2-S3 on predicted
would move again. `string.const`'s OWN evidence is `src/ir/nodes.ts:1195` and
does not move; its `neutral` verdict is unchanged (the UTF-16 residual is
#4551's call, not this slice's).

#### What landed

- **`src/ir/intrinsics.ts`** (+21) — `EXTERNREF_GLOBAL_INTRINSIC_SIGNATURE`,
  `() -> externref`. The catalogue's first and only EMPTY-PARAMETER signature,
  and the one place its callable-shaped `IntrinsicSignature` is bent to describe
  a VALUE. The rejected alternative — a `valueType` field on
  `RuntimeProvider` — would have changed every projection in the catalogue for
  one seam.
- **`src/ir/runtime-manifest.ts`** (+239) — `StringConstPolicy`
  (`storage: "host" | "native" | "unsupported"`), frozen
  `STRING_CONST_POLICY_DISABLED`, the optional `stringConst` field canonicalized
  at construction and published resolved, TWO features (`js.string.const`,
  `js.string.const.utf16`), TWO implementation kinds (`host-global` on the
  GLOBAL half of the capability id union; `native-global` naming the ABI role
  `native-string-literal`), FOUR provider rows, the two-argument
  `stringConstProviderId(feature, policy)`, the `#selectProvider` branch whose
  unavailable arm is a typed `provider-target-unavailable` naming
  `string-const policy storage=…`, and the validation rules for both kinds.
- **`src/ir/runtime-host-capabilities.ts`** (+22) —
  `resolveRuntimeHostCapabilityGlobalRecord`, the fail-closed twin of the func
  resolver. `resolveRuntimeHostCapabilityRecord` is deliberately kind-AGNOSTIC
  (the freeze publishes records of every kind through it), so a global consumer
  needs its own guard rather than the func one, whose whole job is to refuse
  this kind.
- **`src/ir/intrinsic-support.ts`** (+73) — the PAIR-shaped `stringConstDemand`
  input and its place in the "freeze nothing at all" conjunction,
  `stringConstFeatureFor` (the one derivation, exported so no caller spells the
  feature) and `preparedStringConstProvider`, which returns the import MODULE
  and the field SCHEME on the host arm and the ABI ROLE on the native one — a
  field name is impossible (there is one per literal) and an index would be a
  lie (the manifest freezes before `internNativeStringLiteral` allocates).
- **`src/ir/integration.ts`** (+176) — `integrationStringConstPolicy`, the
  TWO-producer `irStringConstDemand` (`string.const` AND `extern.regex`), the
  owner-local `unsupported` partition in the same pass as the nine existing
  ones, the freeze-time policy and demand arguments, the MOVED attachment
  `prepareStringConst`, and the deleted decision block in `prepareStrings`.
- **`src/ir/string-support.ts`** (+59) — `attachIrStringConstStorage`, the
  const-only attach pass.
- **`src/ir/backend/linear-integration.ts`**, **`src/codegen/stdlib-selfhost.ts`**
  — both pass `STRING_CONST_POLICY_DISABLED` explicitly (+2 each). Neither
  freeze passes a const demand, so DISABLED refuses nothing.
- **`tests/issue-3526-string-boundary-const.test.ts`** (new, 42 tests).

`src/ir/from-ast.ts`, `src/ir/lower.ts`, `src/ir/nodes.ts`, `src/ir/builder.ts`,
`src/ir/backend/wasmgc-emitter.ts`, `src/codegen/registry/imports.ts`,
`src/codegen/declarations/import-collector.ts`,
`src/codegen/native-string-literals.ts` and every `program-abi-*-planning.ts`
needed **no edit**.

#### The seam with no arm, and why the demand line is load-bearing

Every family-2 predecessor except F2-S4 migrated a resolve-table arm.
`string.const` has neither an arm nor a callable symbol: the `IrGlobalRef` (or,
past the array-new-fixed ceiling, the minted materializer) that the instruction
carries IS the physical choice. So, as in F2-S4, the migration had to move the
ATTACHMENT behind the freeze.

What is new — and what the plan flagged in advance — is that `prepareStringConst`
sits after `prepareBuiltFnRuntimeManifest`'s `if (!runtime) return { entries }`.
A module whose only string work is literals has no `intrinsic` instruction and
no async plan, so without `stringConstDemand` in the freeze-nothing conjunction
it would freeze nothing, attach nothing, and every literal would reach emission
through the raw `stringGlobalMap` fallback. **On the host lane that is the same
global and therefore the same bytes; V-C revert 4 measures it and the 90-cell
matrix does not move at all.** The demand line is the only thing that makes the
authority real, and the (b) coupling pin is the only thing that can see it.

#### Divergences from the plan (recorded, not widened)

Every one is recorded with the measurement that decided it. **Where the tree
disagreed with the plan, the tree won.**

1. **The fallback is KEPT, not retired.** The plan's P3 made this conditional on
   the count and it came back N = 2 (P3 above). Item 13 stands verbatim.
2. **Net src LOC is +594, not the plan's +420 unmeasured estimate.** Three
   structural reasons, all named in the frontmatter grant: two implementation
   kinds at once (F2-S4 added one), the first VALUE-shaped arm in the catalogue
   (a new signature plus a record resolver of its own), and — like F2-S4 — a
   moved attachment, i.e. a whole new function plus a new attach pass rather
   than a rewrite inside an existing branch. F2-S4's comparable shape landed at
   +381 against a +150 estimate; the plan itself called its estimate a floor.
3. **No `func-budget-allow` grant was needed.** F2-S7 needed one; this slice
   touches `resolveAndObserveCallableProvider` not at all, which is the
   structural point — `string.const` has no resolve arm. The only function that
   grows past the gate's notice is `compileIrPathFunctions` (3178 → 3242, the
   partition block), already granted since F1-S1.
4. **P2's `observe` enumeration differs from the plan's reading.** Three sites,
   as predicted, but one of the two non-materializer sites
   (`observeNativeRuntimeProvider`) is not inside
   `resolveAndObserveCallableProvider`. It runs later in the pipeline than the
   freeze either way, so the conclusion is unchanged — see P2(ii).
5. **The plan's "(c) every `string.const` in a compiled host module carries
   `storage` after preparation" is pinned at the UNIT level, not end-to-end.**
   There is no compile-time surface that exposes prepared IR, and the two forms
   emit identical bytes by construction (that is what V-A measures), so an
   end-to-end assertion would be vacuous. It is pinned instead as the freeze
   coupling itself — a literal-only owner freezes a manifest WITH the demand and
   freezes nothing without it — which is precisely the condition that makes the
   storage reachable, and V-C revert 4 shows it is the only non-vacuous form.
6. **The (c) native pins are structural, not sha pins**, following F2-S5's
   divergence 5 and F2-S7's divergence 4: the native-lane modules are 22–58 KB
   because they carry the whole native-string runtime, where a sha pin goes red
   on any unrelated runtime edit. The 90-cell matrix in this PR is where their
   byte identity is established; the suite pins the interning BEHAVIOUR (a
   duplicated literal interns once; an oversized one gets a minted helper and
   three globals; no `string_constants*` import appears on any native lane).
7. **The census's own DUP figure is 3 interned globals; measured here it is 2.**
   `DUP/standalone` carries `__strlit_0` and `__strlit_1`, the same count as the
   single-literal ASCII fixture — which is the fact the pin actually needs (the
   duplicate interns once). Recorded as a correction to the census, not to any
   predecessor's byte claim: the DUP cell's bytes and sha reproduce the census
   record exactly.
8. **The schema suite's `STILL_UNPROVIDED_IDS` fence reached 0 and is INVERTED,
   not deleted** — the plan's instruction, carried out: section (d) now asserts
   that every one of the six new ids IS named, that the two global ids are named
   by `host-global` rows, and that `host-callable` still names neither. The
   `:22` header paragraph is rewritten to say so. The (g) fail-closed block
   STAYS and gains the twin the plan asked for: a `host-global` row naming
   `string.const` freezes cleanly, so what `#indexProviders` refuses is a
   CALLABLE row pointing at a global, not a global capability.
9. **The (h) `storageForConst` pin is a deletion-with-inversion**, the F2-S4
   shape: `prepareStrings` no longer has a `storageForConst` to fence, so the
   assertion moves into the new suite and the section keeps a narrower pin (all
   three moved seams really did leave `prepareStrings`).
10. **The kind-neutrality baseline was patched BY HAND**, following
    F2-S4/F2-S5/F2-S6/F2-S7: the regenerator's output is a **269-insertion /
    85-deletion** diff for a 2-leaf change. Established by normalising both JSON
    documents to sorted leaf paths and diffing those — **462 leaves each,
    exactly 2 changed**, both evidence strings. Re-derived after `prettier`
    reformatted `integration.ts`, because the line number moved again
    (7097 → 7095).

#### V-A — measured neutrality: 90 of 90 byte cells, 104 of 104 corpus cells

Fifteen fixtures (ASCII, BMP, PAIR, LONE, LONG2000, LONG12000, DUP, TPLONLY,
EMPTY, INIT, INITCONST, LATEGLOBAL, CLEAN, plus BOOLTPL and REGEX) × six lanes
(gc-host, gc-native-strings, standalone, wasi, linear, standalone+utf8 — the
only way to reach the `u8:` intern arm). Each cell compares success, byte
length, binary sha256, the ordered import list with func/global indices parsed
from the binary import section, the run-length import shape, the
`string_constants` and `string_constants16` global lists, the error list, the
`irOutcomes` demotion records (`trackIrOutcomes: true`), the linear
`getLastLinearIrReport()` text and the full emitted WAT.

**90/90 identical**, and `diff -r` over all 90 WAT texts is empty. Re-measured
on the exact tree being committed, after `prettier` reformatted two source
files: still 90/90, WAT included.

Corpus: every `.ts` under `website/playground/examples/**` and `examples/**`
(26 files) × four WasmGC lanes = **104 cells**, comparing sha256, byte length,
success and the full error list, with the base half run from file copies of the
base sources rather than a stash. **0 differing** (the pre-existing failures
fail identically on both trees).

`check:ir-fallbacks` run on both trees: **output byte-identical**.
`check:host-import-policy` output: **byte-identical**, `nativeFirstTotals.imports`
395 (ceiling 395) and `compatibilityLegacySemanticImports` 23 (ceiling 23) —
neither at-ceiling ratchet moves. `scripts/ir-fallback-baseline.json` and
`scripts/linear-ir-baseline.json` are untouched.

#### V-B — the migrated decision is REACHED, counter for counter

With counters re-anchored to the AFTER tree's shape (the same
content-anchored script, which asserts every anchor count and carries an
explicit branch for each tree's `storageForConst` shape), the 90-cell run emits
the seam identically to the BEFORE run — **90 cells compared, 0 differing**,
per cell and per site:

| probe | BEFORE | AFTER |
| --- | --- | --- |
| `storageForConst` host arm | 15 | 15 |
| `storageForConst` native arm | 58 | 58 |
| `materializerForConst` observe | 4 | 4 |
| `prepareStrings` host global, `already` | 16 | 16 |
| `prepareStrings` host global, MINT | 2 | 2 |
| `emitResolvedStringConst` fallback, `string.const` | **0** | **0** |
| `emitResolvedStringConst` fallback, `extern.regex` | 2 | 2 |

The instrumented AFTER run is itself **byte-identical to the clean BEFORE
record** (90/90, `diff -r` over all 90 WAT texts empty), so the instrumentation
is byte-inert and the comparison is honest.

**Runtime oracle.** Nine exported owners are checked against JavaScript through
an instantiated host-lane module: the empty string, ASCII, a BMP non-ASCII
string, a valid astral pair, a lone-surrogate literal (returned AND its
`.length`, which must be 3 — two ASCII code units plus the unpaired surrogate),
a 2000-character literal, and one literal shared by two functions (asserted
equal to each other, so the interning is checked rather than assumed). The same
literals compile and emit on `nativeStrings` and `standalone`; a linear module
carrying the ASCII and empty literals compiles, non-ASCII staying rejected there
as the ASCII-proof control it is.

#### V-C — non-vacuity, each sub-edit reverted independently

Every count MEASURED, each revert applied alone against the kept schema, from
file copies rather than a stash.

| revert | tests failing | which | bytes |
| --- | --- | --- | --- |
| the attachment move (restore `prepareStrings`' block, delete `prepareStringConst`) | **6** | the five (d) attachment pins plus the schema suite's narrowed (h) pin | **unchanged** — 90/90, the projection is verbatim |
| the exact-global check only | **1** | exactly the (d) error-text pin | unchanged |
| the const-only pass (settle through the omnibus `attachIrStringSupport`) | **1** + **6 corpus cells** | the (d) pass pin; `benchmarks.ts` and `benchmarks/string.ts` flip green→red on `gc-native-strings` and `standalone` with *"IR string.repeat already carries a different prepared provider binding"*, and their two wasi cells gain the same error | corpus CHANGED, the 90-cell matrix unmoved |
| the demand's place in the freeze-nothing conjunction | **8** | the (b) coupling pin and every (a)/(b) pin that reads a frozen row | **unchanged — 90/90, WAT included** |
| the four manifest provider rows | **33** | all of (a)/(b) plus every (c) end-to-end pin, and two F2-S4 length pins | **162 field diffs across the 90 cells** — the seam fails closed |

Three of these are worth stating plainly.

**The corpus revert re-measures F2-S4's defect and finds it slightly larger than
recorded: 6 cells, not 4.** Four flip from success to failure; the two `wasi`
cells were already failing and gain the same error in their list. The 90-cell
byte matrix is green throughout — no fixture in it carries a counted-native
`string.repeat` — which is exactly why the const-only pass is not a stylistic
preference.

**The demand revert is the one the plan warned about, and it behaves as
warned.** Eight tests fail and NOT ONE byte moves, on any of the 90 cells, WAT
text included. Without the (b) coupling pin this slice's central claim — that
the frozen row is the authority — would have been unfalsifiable.

**The manifest-rows revert is the F2-S4 divergence-5 shape at its most
extreme.** 33 tests and 162 field diffs, including two `string.len` pins from
F2-S4, because a module carrying any literal can no longer freeze at all. After
the move the frozen row is the only physical authority for this seam, and the
arm fails closed rather than falling back to a lane read — there is none left.

As in every family-2 slice, the (d)/(e)/(f) pins are deliberately
**source-shape** assertions: the policy projection reproduces the old truth
table exactly, so both forms emit identical bytes on every lane. What moved is
WHICH authority answers, and on this seam that is only observable in source and
in the freeze.

#### V-D — gates

Green: `pnpm run -s typecheck` (the project script; plain `tsc -p
tsconfig.json` reports pre-existing `process`/`__filename` errors and is not the
gate). The five ratchets run **bare**, status never piped, and again under
`LOC_GATE_BASE=$(git rev-parse origin/main)` — `check-loc-budget` (+594 net src
LOC this slice, every grown path granted by this file's frontmatter with the
dated F2-S8 rationale; `runtime-manifest.ts` 2553 → 2792, `integration.ts`
9469 → 9645), `check-func-budget` (no new grant — divergence 3),
`check-coercion-sites`, `check:oracle-ratchet` (`getTypeAtLocation` +0,
`ctx.checker` +0), `check:dead-exports` (25 known entries, 0 new).

Also green, each run bare: `lint`; `prettier --check` over every file this PR
touches; `check:ir-dialect`; `check:ir-layering` (86 import lines across 15
files, baseline 86 — unchanged, see P5); `check:ir-only`; `check:linear-ir`;
`check:host-import-policy` (**output byte-identical to a base-tree run** — no
new host import, both at-ceiling ratchets unmoved at 395/395 and 23/23);
`check:test-vacuity-shapes` (0 identifier-gate-defeating `new` callees in 3949
test files); `check:ir-kind-neutrality` (after the surgical two-line refresh
above); and `check:ir-fallbacks` (**diffed against a base-tree run of the same
command, output byte-identical**).

Focused suites: the 51-file control set plus the new one — **52 files, 869
tests, 853 passing**, with the only failures the 16 pre-existing reds described
under P1, unchanged name for name.

#### Not touched (per the plan's scope discipline)

The host pre-registration and its import ORDER (`prepareStrings`'
`addStringImports` + per-literal `addStringConstantGlobal`, kept verbatim); the
legacy minting authority (`import-collector.ts`'s finalize branch and its mint,
`registry/imports.ts` `:130-192`/`:207-209`/`:321`, `statements/tdz.ts`,
`struct-field-exports.ts`); the `hasLoneSurrogate` derivation itself and the two
namespaces it chooses between (`string-surrogate.ts` is IMPORTED, not
reimplemented); the oversized native materializer arm and
`native-string-literals.ts`; storage WIDTH (`utf8Storage`, the `u8:`/`u16:`
key), which is below the policy; `emitResolvedStringConst`'s no-storage
fallback (P3); the `extern.regex` emission path (`lower.ts:3561`/`:3566`); the
module-init second pipeline; the linear ASCII-proof admission; `string.repeat`'s
scan; the `nodes.ts:1195` UTF-16 residual; the other `StringBackendEmitter`s
(`porffor/sink.ts`, `bytecode-emitter.ts`, `contract-conformance.ts`);
multi-file builds; and every existing policy — `numberBoundary`,
`booleanBoundary`, `externIsUndefined`, `generatorNumberBox`, `stringCompare`,
`stringEq`, `stringLen`, `stringConcat`, `stringCharCodeAt`,
`stringConcatMany` — all unchanged.

**Family 2 is now closed at the manifest level**: all six #3526 F2-S2 host
capability ids have providers, and `STILL_UNPROVIDED_IDS` is empty. The
follow-ups the plan ranks — `extern.regex` literal storage (which P3's count
now unblocks), the legacy host-literal mint, the oversized literal as a manifest
sub-arm, and retiring `IrStringSupportProviders.storageForConst` from the
omnibus pass — are unstarted and out of scope here.

## 2026-09-02 Family 2 close-out — string/text boundary complete at manifest level

Family 2 (string/text) is closed the way family 1 was: every string boundary
the census at F2-S1 (`:3302-3335`) named as un-governed now resolves through a
frozen `RuntimeManifestPolicy` row, selected fail-closed before emission, with
byte identity on every already-admitted shape proven per slice in the
checkpoint notes below each plan. Eight slices, eight PRs, all merged on
`loopdive/js2` between 2026-09-01 19:45 and 2026-09-02 13:43 UTC
(first-parent `git log origin/main`, branch names `claude/issue-3526-f2s*`):

| Slice | Boundary governed | Policy row / mechanism | PR (merged UTC) |
| --- | --- | --- | --- |
| F2-S1 | `string.compare` (`<`/`>`/`<=`/`>=`) + retire the `forof.string` `??` fallback | `stringCompare` | #5433 (09-01 19:45) |
| F2-S2 | capability-record schema widening: `wasm:js-string` module, `func-family` + `global` kinds | schema only, no policy | #5440 (09-01 23:38) |
| F2-S3 | `string.eq` (`===`/`!==`) | `stringEq` | #5448 (09-02 01:37) |
| F2-S4 | `string.len` (`.length`) | `stringLen` | #5460 (09-02 04:37) |
| F2-S5 | `string.concat` (binary `+`, `+=`, two-part templates) | `stringConcat` | #5467 (09-02 09:07) |
| F2-S7 | `charCodeAt` | `stringCharCodeAt` | #5472 (09-02 10:29) |
| F2-S6 | batched many-arity concat (`string.concat.many`, `arity-suffix` family) | `stringConcatMany.batch` | #5473 (09-02 12:35) |
| F2-S8 | `string.const` storage (imported globals vs native constants) | `stringConst.storage`; `prepareStringConst` / `attachIrStringConstStorage` behind the freeze | #5482 (09-02 13:43) |

Plans: #5428, #5438, #5446, #5452, #5453, #5471 (docs PRs). The manifest's
string policy rows are `src/ir/runtime-manifest.ts:431-456`
(`stringEq`, `stringLen`, `stringConcat`, `stringCharCodeAt`,
`stringConcatMany`, `stringConst`; `stringCompare` above them). The schema
suite's `STILL_UNPROVIDED_IDS` fence reached 0 at F2-S8 and is inverted (every
capability id has a provider; the F2-S8 checkpoint note records the fence).

Landed on the way, not part of the family: the merge-queue defect that landed
two failed groups on `main` during F2-S7/F2-S8 (#5275, four instances that day),
and the queue-park collateral on F2-S5/F2-S7 (byte-neutral slices parked on a
predecessor's regression — the identical-bucket-signature rule in the auto-park
playbook is what re-admitted them).

**Deferred by design, still open (from the F2-S1 census, unchanged):**

- `stringMethodPlan` — ~14 concrete method spellings (`from-ast.ts` /
  `integration.ts`, F2-S1 census `:3378-3380`) are the family's XL tail and need
  their own per-method census before any of them moves under policy; the
  per-method `plan:stringMethodPlan` host/native rows in the F2-S7 checkpoint
  (`:7811`) are the starting count.
- `String(n)` / number→string coercion is selector `external-call` — selector
  work (#3521 R2 / #3522 R3 territory), not a boundary slice.
- Family 2 governs *which provider* a string op binds; the string ABI shapes
  themselves (`wasm:js-string` builtins vs `i16` arrays) stay a backend-adapter
  question (#3528).

Family 3 (callables, closures, callbacks) opens below with its own census.

## 2026-09-02 Family 3 census — callables, closures, callbacks (where family 3 stands)

Grounded on `origin/main` `de72c54996` (2026-09-02: a `[skip ci]` baseline
refresh on top of PR #5482, F2-S8 `string.const`). The three census probes ran
on the pre-#5482 tip `33ea8606aa`; #5482 shifted lines only in
`src/ir/{integration,runtime-manifest,intrinsic-support,intrinsics,runtime-host-capabilities,string-support}.ts`,
`src/codegen/stdlib-selfhost.ts`, `src/ir/backend/linear-integration.ts` and
the #3526 plan file (every other file cited is byte-identical), and the
`integration.ts` functional mode-read count re-derives unchanged there. Probes —
**boundary-surface** (grep/read), **ungoverned-dispatch** (mode-read ranking),
**lane-measurement** (14-shape corpus × 4 lanes, compiled) — under
`.tmp/r6-f3-census/{boundary-surface,ungoverned-dispatch,lane-measurement}/`
(each has an index/summary file). Every line number below was re-read on
`de72c54996`; every count names its artifact (probe outputs: `33ea8606aa`). Family 3 is the issue's
"Callable/closures/callbacks: direct/indirect calls, bound functions, host
callbacks, closure environments, constructor/callable ABI" (`:1051-1052`).

### Where family 3 stands (census summary)

- **Zero callable entries in the R6 vocabulary today, bar one record**: no
  callable `IntrinsicId` (`src/ir/intrinsics.ts:95-103` — numeric / number /
  boolean / extern / math only; `boundary-surface/02-intrinsics-id-vocab.txt`),
  **0 of 11** `RuntimeManifestPolicy` fields are callable (10 at `33ea8606aa`,
  `stringConst` added by #5482; `src/ir/runtime-manifest.ts:399-457`, frozen
  twin `:460-472`, freeze literal `:2135-2147`; `ungoverned-dispatch/manifest-freeze.grep`), and
  exactly **one** callback-adjacent capability record of 16 func ids:
  `async.callback.wrap` → `env.__make_callback (i32, externref) -> externref`
  with `exceptionPolicy: "module-tag-payload"`
  (`src/ir/runtime-host-capabilities.ts:52-69`, row `:375`, policy `:239-240`,
  field `:253`), cited only by the async projection `host.promise.react`
  (`src/ir/async-runtime-providers.ts:240-245`).
- **Unlike F1/F2, there is no single un-governed resolve table to migrate.**
  Family 2's mode reads sat in one post-freeze table
  (`resolveAndObserveCallableProvider`); family 3's sit in FOUR layers, three of
  them BEFORE `freeze()` (`runtime-manifest.ts:2219`, sole caller
  `intrinsic-support.ts:834`, reached from `prepareBuiltFnRuntimeManifest`
  `integration.ts:1275` at `:4384-4385` — after Phase-1 build, before
  `preregisterCallableProviders` `:4500` and Phase-3 lowering `:4699`):
  1. **Pre-freeze binding-kind decisions in the from-ast resolver**
     (`makeFromAstResolver`, 18 functional mode reads;
     `ungoverned-dispatch/mode-reads-by-function.txt`):
     `functionPrototypeCallTarget` (`integration.ts:6332-6337`: `null` unless
     `standalone && !wasi`, else `irRuntimeFuncRef("__function_prototype_call")`,
     helper `src/codegen/function-prototype-callable.ts:17-19`; consumer
     `from-ast.ts:7553`), `hostIndirectEvalTarget` (`:6253-6259`; consumer
     `from-ast.ts:6395`).
  2. **Pre-freeze selection gates**: host-callback arrows are claimed only
     when `jsHostExterns || supportsStandaloneDomInteraction`
     (`src/ir/calendar-selection-support.ts:27-36`); legacy callers demote a
     claimed unit exactly when `jsHostExterns !== true`
     (`src/ir/legacy-caller-policy.ts:35-44`).
  3. **Pre-freeze program-ABI planning (R1/R2 territory)**: constructor
     identity `hiddenIdentity = !ctx.wasi`
     (`src/codegen/program-abi-fnctor-producer.ts:134`), foreign return
     `standalone || wasi || resultIsExternref` (`:80`,
     `src/ir/fnctor-abi.ts:67`), IR fnctor admission only on
     standalone+nativeStrings+!wasi+!fast+native-first
     (`src/codegen/ir-fnctor-admission.ts:49-53`).
  4. **Post-freeze name-keyed resolution** — the family-3 analog of F2's
     un-governed dispatch: `makeResolver.resolveFunc` (`integration.ts:7240-7276`)
     routes `unit`/`support`/`import`/`runtime|intrinsic` bindings by kind and
     then falls through to `ctx.funcMap.get(adapterName)` (`:7265`) /
     `nativeStrHelperHandle` (`:7274`); `resolveAndObserveCallableProvider`
     (`:6811`) ends in the same name lookup (`:7118`). Which function a NAME
     denotes depends on which lane registered it. `callResultAdapter`
     (`:7278-7288`) reads raw `ctx.nativeStrings`. All 29
     `resolver.resolveFunc(` sites in `lower.ts` funnel here; `lower.ts` itself
     has **0** functional mode reads (`ungoverned-dispatch/lower-callable.txt`,
     `fan-in.txt`).
- **The callback crossing is a bundle, not an import.** Each host callback is
  (a) a maker **import** (`env.__make_callback`, registered by the legacy
  pre-pass `src/codegen/declarations/import-collector.ts:2005-2011`, siblings
  `__make_getter_callback` `:2012-2016` and `__make_callback_ctor`
  `src/codegen/callback-ctor-bridge.ts:52-62`; runtime dispatch on sentinel
  `-2` one-shot / `-1` reusable `src/runtime.ts:17660-17661`), (b) host-facing
  dispatch **exports** resolved by name — `__call_fn_0..4`
  (`src/codegen/index.ts:6038-6056`, `src/codegen/closure-exports.ts:369-372`,
  name `:774`), `__closure_arity` (`:111`) — and (c) closure **types**: header
  `func funcref / $arity i32 / $bag externref` + captures
  (`src/ir/closure-struct-registry.ts:121-125`), the DOM-authority branded
  subtype (`:183-184`), `IrClosureLowering` / `IrFnctorLowering.reservedLayout`
  (`src/ir/backend/handles.ts:127`, `:156-161`), and the `callable<S>`
  externref carrier (`src/ir/nodes.ts:389`). The frozen record schema spells
  only (a) — see "Deferred by design".
- **IR emission is lane-free at the instruction level, lane-bound at one
  site.** `closure.new` (`nodes.ts:1368-1381`, lowered `lower.ts:2349`),
  `closure.call` (`nodes.ts:1419-1423`, lowered `:2390`, wrapper ROOT rationale
  `:2401-2406`) and `call` carry no provider field; the intrinsic arm throws
  on a missing frozen provider (`lower.ts:407-412`). The four surviving `??`
  provider fallbacks in `lower.ts` are all `extern.*`
  (`:3522, :3529, :3537, :3544` — family 6;
  `boundary-surface/22-lower-nullish.txt`). The ONE from-ast lane branch on this
  surface is the host-callback maker: `from-ast.ts:8303-8317` pushes the packed
  closure directly on the exact standalone-DOM path, else emits a plain `call`
  on `irImportFuncRef("env","__make_callback")` with an `i32.const -2` sentinel
  — a spelling and an ABI fact the `async.callback.wrap` record already states,
  and which `hasExactHostVoidCallbackMakerImport`
  (`src/codegen/ir-overlay-finalize.ts:270-275`) re-derives by hand from
  `ctx.funcMap`. Closure-environment shape is chosen at plan time:
  `plan.standaloneDomReusable ? domCallbackAuthority : hostOneShot`
  (`from-ast.ts:14486-14496`, plan flag `src/codegen/index.ts:3380` ←
  `calendar-codegen-planning.ts:366`, dispatcher gate `:4440-4445`; reserve-time re-read
  `src/codegen/standalone-dom-callback-authority.ts:99-104`).
- **Backends**: the closure family lowers on WasmGC only
  (`src/ir/backend/wasmgc-emitter.ts:371-375` pushes the DOM authority brand
  global before `struct.new`); linear (`linear-emitter.ts:485-488`) and
  bytecode (`bytecode-emitter.ts:749-752`) are not-implemented for
  `emitFuncRef` and the rest of the family; plain `call` is legal on all three
  (`src/ir/backend/legality.ts:269`; `boundary-surface/104-backend-closure-emitters.txt`).
- **Legacy emission is the demote target and carries the bulk of the reads**:
  398 functional `ctx.{nativeStrings,wasi,standalone,strictNoHostImports,fast}`
  reads in 20 of the 55 scanned callable-path files — `codegen/index.ts` 118, `calls.ts` 57,
  `call-receiver-method.ts` 51, `call-identifier.ts` 30, `integration.ts` 79 —
  plus 32 `noJsHost()` (`= wasi || standalone`, `src/codegen/js-errors.ts:29`)
  calls (`ungoverned-dispatch/mode-reads-functional.grep`, `ranked-sites.tsv`).
  Bound functions have **no IR representation** — `.bind()` is legacy-only
  (`src/codegen/expressions/call-tail-dispatch.ts:1762`:
  `!standalone && !noJsHost` → host bound fn, else closure struct;
  `__bind_function` is the only callable import on the dual-mode allowlist,
  `src/codegen/host-import-allowlist.ts:332`).

### Measured per-shape lane behaviour (`lane-measurement/results.md`, `results.json`)

Lanes (runner `lane-measurement/run.ts:9-13`, names as in `results.json`): gc-host `{}` ·
gc-strict-no-host `{strictNoHostImports:true}` · standalone `{target:"standalone"}`
(implies nativeStrings, `src/index.ts:517-520`; derives `environment:"none"` and
`semanticProviders:"native-first"` by itself, `src/target-profile.ts:73-74`, `:96-101`) ·
wasi `{target:"wasi"}`; `trackIrOutcomes`/`experimentalIR`/`trackFallbacks` on,
verdict from `result.irOutcomes` (`src/ir/outcomes.ts:281`). **Not measured**:
the exact standalone-DOM lane (`environment:"none"` + `native-first`, the gate
at `index.ts:4440-4445` `hasStandaloneDomDispatcher`; `:2885-2888` is the promise-delay
gate) — the profile is NOT a different option object: the corpus's standalone cell already had it, but its 09/09b fixtures pass the DOM as parameters and
never set `requiresStandaloneDomInteractionCapability` (a closed DOM-authority plan,
`calendar-codegen-planning.ts:190-191`; fixture precedent `tests/issue-4576-standalone-dom-builtins.test.ts:325-338`),
so the `domCallbackAuthority` path and the standalone DOM dispatcher
(`standalone-dom-callback-authority.ts:388-392`) have no measured cell. F3-S1's
V-A must add it.

| shape | verdict (all lanes unless noted) | reason · reject arm | bytes gc / strict / standalone / wasi |
|---|---|---|---|
| 01 direct call | **IR, compile-once** 2/2 | — | 183 / 22017 / 22632 / 22659 |
| 04 closure capturing param | **IR, compile-once** 1/1 | — | 2990 / 33007 / 33030 / 33057 |
| 11 `new` class | **IR, compile-once** 3/3 | — | 1100 / 22697 / 23044 / 23071 |
| 02 indirect call via fn-typed var | LEGACY entry 2/3 | `vardecl-typenode:FunctionType` (`select.ts:5723`) | 9974 / 42469 / 60149 / 60016 |
| 03 closure over mutable local | LEGACY 0/1 | `closure-return-type` (`:6010`) | 3282 / 33003 / 51773 / 51725 |
| 05 returned closure | LEGACY 0/2 | `closure-return-type` (`:6010`); entry `call-graph-closure` (`:1153`) | 5942 / 36555 / 54660 / 54634 |
| 06 `.bind` | LEGACY 0/2; `scale` compile-twice | `expr-ident-not-in-scope` (`:9264`) | 3890 / 99725 / 132257 / 107031 |
| 07 `.call`/`.apply` | LEGACY 0/2; `sum3` compile-twice | `function-invocation-method-unsupported` (`:9792`) | 812 / 22433 / 22798 / 22825 |
| 08 `array.map(arrow)` | LEGACY 0/1 | `array-method-unsupported` (`:9769`) | 4333 / 35716 / 53572 / 53498 |
| 09 host callback `addEventListener` | gc-host: IR emitted but **compile-twice**; strict/standalone: LEGACY `body-shape-rejected`; **wasi FAILS** | lane-dependent | 908 / 93602 / 50422 / FAIL |
| 09b pinned B2 (`tests/issue-3214-void-host-callback.test.ts:139-140`) | same as 09 | same | 849 / 93617 / 33180 / FAIL |
| 10 `new` plain function | LEGACY 0/2; `Point` compile-twice | `expr-new-callee-nonident` (`:9047`) | 6425 / 100730 / 131627 / 102595 |
| 12 higher-order compose | LEGACY entry 2/4; `compose` compile-twice on gc-host, `call-graph-closure` elsewhere | `expr-ident-not-in-scope` (`:9264`) | 12005 / 44173 / 61517 / 61330 |
| 13 recursion via local ref | LEGACY 0/1 | `nested-function-self-reference` (`:5881`) | 3288 / 33431 / 52211 / 52150 |

Findings that size the family (`lane-measurement/summary.md`):

- **3 of 14 shapes are IR-claimed compile-once on all four lanes**; 11 have
  a selector-rejected terminal unit. Only 4 of 14 (03/05/08/13 — no `irBodyEmitted`
  unit on any lane, `results.json`) never reach the IR boundary; 10 do, via
  compile-once, partial (02 2/3, 12 2/4) or compile-twice units — selector coverage (#3522 R3 / adoption lanes) is the gate before most
  of family 3's manifest work, the verdict F2 gave `String()` coercion.
- **Compile-twice is the dominant family-3 hazard**: 5 units on gc-host
  (`scale`, `sum3`, `Point`, `compose`, `install`) carry both an IR and a
  legacy body. `computeIrFirstSkipUnitIds` admits only number/bool/string
  positions via `positionDomain` (`src/codegen/ir-overlay-safety.ts:368`);
  `irFirstBodyIsProvenLowerable` states closure/extern/`new` shapes "all stay
  COMPILE-TWICE" (`src/codegen/ir-first-gate.ts:96-101`). Even the pinned B2
  host-callback shape compiles twice on gc-host.
- **Host-lane-only callable imports** (all `env`; strict/standalone/wasi emit
  0 imports on every shape except the 09/09b DOM leak): `__call_function`,
  `__call_function_0..4`, `__bind_function`, `__make_callback` (09/09b),
  `__register_fnctor_instance` (10; survives on gc-strict-no-host too). Shape 04 is
  genuinely IR (`closure.new`/`closure.call`) yet gc-host still imports
  `__call_function_1..4` + `__box/__unbox_number` — the unmatched-callee
  fallback `hostCallableFallbackTerminal`
  (`src/codegen/closure-exports.ts:1268-1290`; `undefined` under
  `standalone || wasi || native-first || arity>4`) is registered on the host
  lane regardless of IR claim, and its import NAME is partly env-var driven
  (`JS2WASM_FIXED_ARITY_HOST_CALLS`, `:1280`,
  `src/codegen/expressions/host-call-fallback.ts:19-30`).
- gc-strict-no-host is a native-strings regime (`nativeStringsRequiredByPolicy`,
  `src/target-profile.ts:124-125`; `strictEnvImportGate` `:80`) — hence 22 KB
  for a 2-function module — and is refused by the exact invocation lane
  (`src/codegen/index.ts:4292-4300`).

### Deferred by design (needs a schema slice — the family-3 analog of F2-S2)

The frozen record schema (`src/ir/runtime-host-capabilities.ts`) can spell
`kind: "func"` over `module ∈ {env, wasm:js-string}` (`:157`) with values
`externref | i32 | f64 | ref_extern` (`:143-150`), `kind: "func-family"` for
arity-suffixed **imports** (`:280-290`), and `kind: "global"` over
`{string_constants, string_constants16}` (`:158-161`). A provider may cite
several records (`runtime-manifest.ts:886`). The 14 provider implementation
kinds (`:730-860`; 12 at `33ea8606aa`, `host-global`/`native-global` added by
#5482) all name something the module CALLS or READS, or a symbolic field;
none names an export, a type, or a host→module trampoline
(`boundary-surface/08-manifest-policy-and-provider-shapes.txt`). Consequently:

- (a) **Direction** — no export / host-calls-module kind: `__call_fn_N`,
  `__closure_arity`, `__cb_<id>` are unrepresentable, and `module` has no slot
  for a module-export namespace.
- (b) **Types** — no `funcref` / `ref $T` in the value union, no record kind
  for a struct or func type; the only type-shaped provider arm is
  `carrier-field` with a symbolic role (`:818-820`), deliberately not a type
  index. Closure header, wrapper ROOT, lifted-func type and the fnctor reserved
  layout are outside it.
- (c) **Globals** beyond string constants — the DOM authority brand global
  (`wasmgc-emitter.ts:372-373`) and the function-value trampoline cache global
  have no module in `RUNTIME_HOST_CAPABILITY_GLOBAL_MODULES`.
- (d) **Sentinel semantics** (`-1` reusable / `-2` one-shot) exist only in a
  comment (`from-ast.ts:8307-8310`) and the runtime switch
  (`runtime.ts:17660-17661`); no record field.
- (e) **Backend legality** — the closure family lowers on WasmGC only; a
  manifest freezing a callable provider for `backend: linear/bytecode` would be
  a lie until those emitters exist (`linear-emitter.ts:485-488`).
- (f) **Env-var knob** — `JS2WASM_FIXED_ARITY_HOST_CALLS` decides
  `__call_function_N` vs `__call_function`; a record for that family cannot
  be frozen from `ctx` alone without freezing the knob.
- (g) **Constructor/fnctor ABI facts** (`hiddenIdentity`, `resultIsExternref`)
  are frozen by the R1/R2 program-ABI registry independently of the R6
  manifest; governing them means projecting the R1 plan INTO the manifest or
  declaring them out of R6 scope (as F2 did for `stringMethodPlan`). Open
  question below.
- (h) **Bound functions** — no IR op; adoption work first (shape 06).

### Family 3 slice map (F3-S1 … F3-S6)

| slice | title | size | depends on | files it edits | byte-neutral by construction |
|---|---|---|---|---|---|
| **F3-S1** | host callback maker under manifest policy (`hostCallbackWrap` policy (new), reuse `async.callback.wrap`) | M | F2-S8 (PR #5482, on `de72c54996`; adjacent `runtime-manifest.ts` policy fields) | `src/ir/runtime-manifest.ts`, `src/ir/intrinsic-support.ts`, `src/ir/integration.ts` (policy projection + post-freeze admission in `preregisterDynamicSupport` `:8463-8466`), `src/ir/from-ast.ts` (`:8313` spelling from the static record), `src/codegen/ir-overlay-finalize.ts` (sub-B), `src/ir/backend/linear-integration.ts` + `src/codegen/stdlib-selfhost.ts` (disabled policy), tests | **yes** — host arm binds the existing `env.__make_callback` import index (no registration, no index shift); native arm emits nothing today and after; the disabled policy is unreachable on every real lane because selection never admits the arrow (post-freeze admission, contract item 4) |
| F3-S2 | capability-record schema widening for callables: `kind: "export"` (new) host→module records (`__call_fn_N`, `__closure_arity`), maker siblings `callback.wrap.ctor` / `callback.wrap.getter` / `closure.apply` (new ids, `env`), `func-family` rows for `__call_function_N` + `__boundary_callback_call_N` with the env-var knob frozen as a record axis | M | F3-S1 | `src/ir/runtime-host-capabilities.ts`, kind guards in `intrinsic-support.ts` / `runtime-manifest.ts` / `async-runtime-providers.ts`, `tests/issue-3526-callable-boundary-schema.test.ts` (new) | **yes** — moves no boundary (F2-S2 anatomy) |
| F3-S3 | `functionPrototypeCall` policy (new): govern `functionPrototypeCallTarget` (`integration.ts:6332-6337`), one runtime symbol, truth table `standalone && !wasi` | S | F3-S1 machinery | `runtime-manifest.ts`, `integration.ts` (`:6332-6337` `makeFromAstResolver` arm + projection; R2-locked, #3521 `:953-956` — coordinated with the R2 lane as F3-S1 does), tests | yes if the demote stays at build (see open question 4) |
| F3-S4 | closure-environment policy (new): `hostOneShot` vs `domCallbackAuthority` subtype choice (`from-ast.ts:14486-14496`, `closure-struct-registry.ts:183-184`, `standalone-dom-callback-authority.ts:99-104` reserve-time re-read) | M | F3-S2 (type role + brand global need a record kind) | `from-ast.ts`, `closure-struct-registry.ts`, `standalone-dom-callback-authority.ts`, `runtime-manifest.ts`, tests | yes — same subtype, same brand global |
| F3-S5 | publish host dispatch exports (`__call_fn_0..4`, `__closure_arity`) as manifest export intents (anti-vacuity item 2 for callables) | L | F3-S2 | `closure-exports.ts`, `index.ts:6038-6056` (R2-locked, #3521 `:953-956` — coordinated with the R2 lane as F3-S1 does), `runtime-manifest.ts`, tests | yes — publication only, no emission change |
| F3-S6 | unmatched-callee host fallback under policy (`hostCallableFallbackTerminal`, `planHostCallFallback`, `__apply_closure` host late import `src/codegen/array-tolocalestring.ts:153`) | XL | F3-S2, selector coverage for shapes 02/05/12 | `closure-exports.ts`, `calls.ts`, `host-call-fallback.ts`, `object-runtime.ts`, `integration.ts` (R2-locked, #3521 `:953-956` — coordinated with the R2 lane as F3-S1 does), tests | **no** — gc-host import set on IR-claimed shapes (04) is the measured target; needs its own before/after cells |

Out of R6 (adoption/selector work first, like F2's `String()`): `.bind`
(06), `.call/.apply` (07), `array.map(arrow)` (08), `new` on a plain function
(10), returned/escaping closures (03/05), local-ref recursion (13); the
compile-twice admission in `ir-overlay-safety.ts` / `ir-first-gate.ts`;
constructor/fnctor ABI (R1 #3520 / R2 #3521); `extern.*` `??` fallbacks
(family 6).

### F3-S1 — host callback maker under manifest policy (contract)

**The arm being governed**: the maker crossing for a checker-certified void
host callback. Host lanes emit `call env.__make_callback(i32.const -2, packed)`
spelled in from-ast (`from-ast.ts:8311-8316`); the exact standalone-DOM lane
pushes `packed` unwrapped (`:8303-8306`); import existence is decided by the
legacy pre-pass (`import-collector.ts:2005-2011`) and re-verified by hand
(`ir-overlay-finalize.ts:270-275`). Truth table:
`jsHostExterns → host maker` · `exact standalone DOM → no maker` · else the
selection gate (`calendar-selection-support.ts:27-36`) never admits the arrow.

1. **New policy** `hostCallbackWrap?: HostCallbackWrapPolicy` (new) —
   `{ wrap: "host" | "native-dispatch" | "unsupported" }`, sibling of
   `stringConst` (`runtime-manifest.ts:456`, F2-S8). Frozen disabled default,
   canonicalized, published, selected fail-closed with typed
   `provider-target-unavailable` naming the policy. Follow the 10-point edit
   list F2-S1 item 2 names (type + default + constructor refreeze around
   `:2135-2147`, feature/provider unions, `#selectProvider` branch, caller
   projection `integrationHostCallbackWrapPolicy(ctx)` (new) beside
   `integration.ts:1284-1296` consulted ONCE before freeze, owner-local
   partition scan, explicit disabled policy in the linear adapter and
   `stdlib-selfhost.ts`, whole-shape pin updates).
2. **Provider rows**: `host.callback.wrap` (new) → `host-callable` over the
   EXISTING record `async.callback.wrap` (`runtime-host-capabilities.ts:375`,
   no rename, no new record — `host.promise.react` keeps citing it);
   `native.callback.dispatch` (new) → a no-import implementation naming the
   standalone DOM dispatcher (mechanism per P1 — `native-managed` today admits
   only `service: "native-promise-runtime"`, `runtime-manifest.ts:858-859`).
3. **from-ast stops spelling the maker**: `:8313` builds the import ref from
   the static catalogue record (`resolveRuntimeHostCapabilityRecord("async.callback.wrap")`;
   from-ast runs in Phase-1 `integration.ts:2899`, BEFORE `freeze()` at `:4384`, so the
   frozen manifest is unreadable here — policy ADMISSION is post-freeze, item 4), binding
   KIND stays `import` (pins compare kinds, the S4 lesson); the `-2` sentinel
   stays a from-ast fact (deferred (d) — do not invent a record field here).
   The exact standalone-DOM branch keeps its plan-driven shape; the slice adds
   the manifest as the authority that ADMITS it (native-dispatch selected) and
   fails closed otherwise.
4. **Import parity is the hard byte constraint**: the host arm must bind the
   funcMap's existing `__make_callback` import index — no `ensureLateImport`,
   no new registration, no union materialization; add attached-target
   recognition in the `call`-on-`env`-import scan of `preregisterDynamicSupport`
   (`integration.ts:8463-8466`; `attachedExternIsUndefinedArm` `:8370-8372` matches only
   `intrinsic` instrs and cannot see the maker). Exact resolve arm: `resolveFunc` `:7258-7260`
   → `resolvePreparedImportCallable` `:7167` (catalog `:4504`) when `ctx.programAbiSession`
   is set, else `:7264-7265`; both return the pre-pass index iff the record's `module.field`
   equals the `import-collector.ts:2010` key; `preregisterCallableProviders` `:7649` learns no `call` instrs — routing to the
   existing pre-pass registration, keeping every lane's import order
   identical. The native arm emits no call before and after.
5. **Sub-B — record as single source of the maker ABI**:
   `hasExactHostVoidCallbackMakerImport` (`ir-overlay-finalize.ts:270-275`)
   compares the physical `(i32, externref) -> externref` against
   `resolveRuntimeHostCapabilityRecord("async.callback.wrap")` instead of a
   hand-written shape; pin "refuses a maker whose ABI drifts from the record".
   `callback-ctor-bridge.ts:52-62` (legacy `_ctor` maker) is NOT touched —
   its record lands in F3-S2.
6. No change to `plan.invocation`, selection (`calendar-selection-support.ts`),
   `closure.new` flags, or the sentinel; no from-ast change beyond item 3.

**Required pre-implementation probes** (answers go in the checkpoint note):

- **P1 — native-arm mechanism**: how a "no call" provider is expressed —
  extend `native-managed.service` (new value), or record the native arm as
  `unsupported`-for-import with the DOM plan as its own authority. Whichever
  is chosen must not require a record kind from F3-S2. Name the seam that
  reads the selected provider for the import ref (the
  `preparedStringCompareProvider` analog in `intrinsic-support.ts`, read post-freeze
  from `preregisterDynamicSupport` / `resolveFunc`, never from from-ast) and prove
  the host arm binds the SAME `env.__make_callback` index (item 4) — measure
  with `result.imports.map(name)` on the B2 fixture.
- **P2 — the un-measured lane**: compile 09/09b under the exact standalone-DOM
  profile (`environment:"none"`, `native-first`; gate `index.ts:4440-4445`)
  before any edit; record bytes, import set, `irOutcomes`, and whether the
  dispatcher is reserved (`index.ts:4448-4451`). Without this cell the
  native-dispatch row has no baseline.
- **P3 — outcome-pin shift**: which committed pins move — the
  `tests/issue-3214-void-host-callback.test.ts` B2 pins, the
  `issue-3520-callable-provider-abi` binding pins (kinds, not names), the
  whole-shape policy pins in `issue-4104…` / `issue-3526-ir-runtime-manifest`
  (new field), the async-manifest pins that enumerate `async.callback.wrap`
  citers. Record the divergence-4 class: if the maker is total under both arms
  (it is today — selection already refuses the rest), state it is EMPTY.
- **P4 — census**: `pnpm run check:ir-fallbacks` diffed, not eyeballed
  (`unintended: {}` must not move); the linear baseline
  `scripts/linear-ir-baseline.json` byte-exact-pinned must not change.

**Verification matrix** (the 6-point F1 template, verbatim):

- **V-A byte cells**: the 09/09b fixtures + shape 04 (closure without a host
  callback, control) + the F2 `CLEAN` control × six lanes named by option object:
  gc-host `{}`, gc-strict-no-host `{strictNoHostImports:true}`, standalone
  `{target:"standalone"}`, exact standalone-DOM (same `{target:"standalone"}` on a
  closed-DOM-authority fixture, `hasStandaloneDomDispatcher` true), wasi `{target:"wasi"}`,
  linear `{target:"linear"}`;
  before/after on the same tree: byte length, sha256, import set AND order;
  full WAT diff empty. Expectation: **all cells byte-identical**; wasi cells
  stay the same hard failure ("DOM global 'EventTarget' is not available").
- **V-B import parity**: exact `result.imports.map(name)` on gc-host for 09b
  (`__make_callback` at its pre-slice index), plus a runtime oracle check that
  the wrapped callback fires once with the one-shot sentinel.
- **V-C non-vacuity by revert**: restore only the `:8313` spelling / only the
  sub-B hand-written ABI check; exactly the named new pins fail, all
  schema/policy pins stay green.
- **V-D fail-closed reachability**: refusal per disabled policy with typed
  `provider-target-unavailable` naming `hostCallbackWrap`; owner-local demote
  proven per-owner with a clean co-owner staying emitted; sub-B ABI-drift
  refusal.
- **V-E suites**: new `tests/issue-3526-callable-boundary-callback.test.ts`
  with the per-slice anatomy (a)-(i); controls unchanged:
  `issue-3214-void-host-callback`, `issue-3520-callable-provider-abi`, both
  async suites, all #3526 suites, `issue-4550-linear-ir-census`; five ratchet
  gates chained bare AND under `LOC_GATE_BASE=$(git rev-parse origin/main)`;
  `runtime-manifest.ts` growth needs the dated `loc-budget-allow` block.

**Ownership**: slice claim `#3526:f3s1`. Per `#3526 :1070-1071` (C0/M1 one-owner set) R6 is sole owner of `runtime-manifest.ts`,
`intrinsic-support.ts`, `runtime-host-capabilities.ts`, `from-ast.ts`, the
adapters. `src/ir/integration.ts` is under the R2 lock
(`plan/issues/3521-ir-r2-prepared-program-free-function-compile-once.md:953-956`);
F1/F2 precedent is that R6 edits only its own policy-projection,
attached-target and `makeFromAstResolver`-arm lines there (F2-S1 item 3, `#3526 :3412`) — same here, coordinated with the R2 lane before
push. Not written by F3-S1: `src/codegen/ir-prepared-free-functions.ts` and
the R2 selector call sites in `src/codegen/index.ts` (R2 #3521),
`src/codegen/multi-prepared-callable-orchestration.ts` and R5 multi-prepared
files (#3525), `src/ir/outcomes.ts` (#3520), R3 late-feature routing (#3522),
the `src/codegen/declarations.ts` prelift seam (#3523 gap-6a v2, PR #5480),
`import-collector.ts` (on the #3526 C0/M1 single-owner list, `plan/issues/3526-ir-r6-semantic-runtime-contract.md:1070-1076`).

### Open questions (overlaps to settle before dispatch)

1. `src/codegen/ir-overlay-finalize.ts` (sub-B) — is it R2 overlay territory
   or R6? If R2, sub-B moves to a docs-level pin and F3-S1 is sub-A only.
2. F3-S4's `from-ast.ts:14486-14496` / `closure-struct-registry.ts` edits sit
   on the closures compile-once surface (#3522 R3) and the standalone DOM
   capability (#3523 R4) — needs an explicit partition line before F3-S4.
3. Deferred (g): does R1 (#3520) project `hiddenIdentity` / `resultIsExternref`
   into the manifest, or does R6 declare constructor ABI out of scope for good?
4. F3-S3's demote point: `functionPrototypeCallTarget` returning `null`
   demotes at BUILD (`method-call-unsupported`, `from-ast.ts:7553`); a
   resolve-time fail-closed arm would shift it to `late-preparation-unsupported`
   @resolve and change census output — decide build-time projection vs
   resolve-time provider before sizing. F3-S1 already takes the post-freeze
   side (items 3-4: from-ast reads only the static record, admission is
   post-freeze, refusal surfaces as `late-preparation-unsupported`@resolve);
   F3-S3 must either follow it or justify a build-time exception.
5. The compile-twice admission (`ir-overlay-safety.ts:368`, `ir-first-gate.ts:96-101`)
   dominates family 3's measured cost but is not a boundary — which lane owns it?
6. F3-S2's env-var knob (`JS2WASM_FIXED_ARITY_HOST_CALLS`): freeze it as a
   record axis, or retire the knob first (a #3520/#4397 host-import-policy
   question).
7. R2 lock (#3521 `:953-956`): confirm the R2 lane accepts the F1/F2-style
   line-scoped edits before claim — F3-S1 (`integration.ts:8463-8466` scan +
   projection), F3-S3 (`:6332-6337` arm), F3-S5 (`index.ts:6038-6056`), F3-S6.

### 2026-09-02 F3-S1 checkpoint note — Opus lane

Implemented from the `### F3-S1 — host callback maker under manifest policy
(contract)` section of the family-3 census (docs branch
`claude/docs-3526-f3-census`, `c246fb6ed`), on
`claude/issue-3526-f3s1-host-callback-maker`, branched from `origin/main`
`77ca8fba`. Base for every measurement below: `77ca8fba`. Slice claim
`3526:f3s1`. Every probe was measured on this branch's own tree BEFORE the first
source edit.

Family 3's first slice, and the first in the whole issue whose two live arms are
not two spellings of one crossing but **a crossing and its absence** — which is
what forced the one deviation from the plan's own P1 menu (below).

#### Settled before implementation (recorded per the dispatch brief)

- **OQ1** — `src/codegen/ir-overlay-finalize.ts` is NOT on the R2 lock list
  (#3521 `:952-955` locks `index.ts`, `declarations.ts`, `integration.ts`,
  `prepare.ts`, `program.ts`). Sub-B stayed in F3-S1 and edited exactly
  `hasExactHostVoidCallbackMakerImport` (`:270-275` at the base).
- **OQ7** — line-scoped `src/ir/integration.ts` edits, exactly as F1/F2 did:
  the policy projection `integrationHostCallbackWrapPolicy(ctx)` beside the
  eleven `integration*Policy` siblings, the demand scan, the owner-local
  partition arm, the two freeze arguments, and the attached-target recognition
  reached from `preregisterDynamicSupport`. Nothing else in that file. The
  concurrent R2 lane (`claude/issue-3521-r2-t1g1-telemetry-ci`) edits
  `ir-prepared-free-functions.ts`, one spot in `codegen/index.ts`, a new
  `src/ir/r2-withdrawal.ts` and tests — no overlap; `origin/main` was re-merged
  before the PR.

#### P1 — native-arm mechanism: NEITHER offered option; a new implementation kind, on a measurement

The plan offered two: extend `native-managed.service` with a new value, or
record the native arm as `unsupported`-for-import with the DOM plan as its own
authority. **Both were rejected, and the first was rejected on a measurement
rather than on taste.**

`projectRuntimeBackendRequirements` (`runtime-manifest.ts:897-926`) treats EVERY
`native-managed` row as a member of the native ASYNC family — the loop's only
non-host arm is `kind !== "native-managed" continue`, after which it adds
`async.native.drive` and `async.native.number-boundary` unconditionally, and
throws `invalid-backend-requirement-projection` if the manifest also carries a
host async provider. It is called at freeze over ALL selected providers
(`:2337`), not over the async plan's, and its output is the frozen
`backendRequirements` that `ir-async-runtime-adapters.ts` materializes from.
Measured directly (`.tmp/f3s1/probe-freeze.mts`, and pinned in the new suite's
section (e)):

| the same provider row, typed as | `projectRuntimeBackendRequirements([row])` | with a host async provider |
| --- | --- | --- |
| `native-managed` (the plan's option A) | `["async.native.drive","async.native.number-boundary"]` | **throws** `mixes host and native async providers` |
| `native-dispatch` (chosen) | `[]` | `[]` |

So option A changes the frozen vector on exactly the lane this slice must keep
byte-identical. Option B was rejected on the contract's own words: item 1 fixes
the policy union as `{ wrap: "host" | "native-dispatch" | "unsupported" }` and
item 3 requires the manifest to be "the authority that ADMITS" the standalone-DOM
path, which an `unsupported` arm cannot be — under option B the owner-local
partition would demote every DOM-authority owner, or the demand scan would have
to exclude them and the manifest would govern nothing on that lane.

The chosen mechanism is a **new `RuntimeProviderImplementation` kind**,
`{ kind: "native-dispatch", service: "standalone-dom-callback-dispatch" }`. It
is a *provider implementation* kind, not a *capability record* kind, so it
satisfies the plan's hard constraint ("must NOT need any record kind from
F3-S2") exactly: `runtime-host-capabilities.ts` keeps its three kinds
(`func` / `func-family` / `global`) and gains no row. The precedent is F2-S8's
own `native-global` — a native arm with no import, its own kind, invisible to
the async projection.

**The seam that reads the selected provider** is
`preparedHostCallbackWrapProvider` (`intrinsic-support.ts`), the
`preparedStringCompareProvider` analog. It is read post-freeze only, from
`preregisterDynamicSupport`; from-ast reads the STATIC catalogue instead
(`HOST_CALLBACK_WRAP_CAPABILITY_RECORD`, new module-scope const in
`runtime-host-capabilities.ts`), because from-ast runs in Phase 1 at
`integration.ts:2899` and the freeze is at `:4384`.

**The host arm binds the SAME index.** Measured with
`result.imports.map(name)` on the B2 fixture, before and after:

```
env.EventTarget_addEventListener, env.Element_set_textContent, env.number_toString,
string_constants.install, string_constants.tick, string_constants.,
env.__make_callback, env.__call_function_0
```

`__make_callback` is function-import index **3** on both sides (globals do not
occupy the func index space); the 09 fixture's shorter list puts it at **2** on
both sides. Both are pinned in the new suite. No `ensureLateImport`, no
registration, no union materialization: `admitAttachedHostCallbackMaker` sets no
flag and runs no materializer, by construction.

#### P2 — the un-measured lane, measured

The census names the exact standalone-DOM lane as having no cell. It does now:
`website/playground/examples/dom/calendar.ts` at `{target:"standalone"}`, which
is the fixture with `hasStandaloneDomDispatcher === true` (the #4577 suite's own
compile options). Measured on the base tree before any edit:

| field | value |
| --- | --- |
| success | `true` |
| bytes | **69282** |
| sha256 (12) | `232d3c9ec8af` |
| imports (11, all `env` funcs, in order) | `__date_now, global_document, Document_createElement, CSSStyleDeclaration_set_cssText, HTMLElement_get_style, Element_set_innerHTML, Element_set_textContent, Node_appendChild, HTMLElement_addEventListener, CSSStyleDeclaration_set_background, Document_get_body` |
| `__make_callback` | **absent** — the crossing has no maker on this lane |
| dispatcher reserved | **yes** — `(type $$standalone_dom_callback_dispatch_type (func (param externref)))` is in the WAT |
| `irCompiledFuncs` (17) | `<module-init>, dimOf, el, fdow, main, main__closure_0..3, mname, onDay, priceOf, renderCal, renderCal__closure_0..2, updFoot` |
| `irOutcomes` | all ten terminals claimed, no reject reason |

Every field is identical after the slice. The row this cell now freezes is
`native.callback.dispatch`, measured live (instrumented run, byte-inert — all 21
cells and all 21 WAT texts identical to the clean AFTER record):

```
F3S1-DEMAND {"host":false,"nativeDispatch":true}
F3S1-ARM    {"arm":"native-dispatch","service":"standalone-dom-callback-dispatch"}
```

and on 09 / 09b gc-host:

```
F3S1-DEMAND {"host":true,"nativeDispatch":false}
F3S1-ARM    {"arm":"host","module":"env","field":"__make_callback",
             "params":["i32","externref"],"results":["externref"]}
```

Every other cell freezes no row at all (`F3S1-ARM undefined`). **That is the
non-vacuity evidence a byte matrix structurally cannot give**, and it is why the
demand is read off `closure.new` rather than off the maker `call`: on this lane
there is no call to scan for.

#### P3 — outcome-pin shift: ONE pin moves, and the divergence-4 class is EMPTY

- **Moved: exactly one.** `tests/issue-4104-ir-async-plan-runtime-consumer.test.ts:436-449`
  — the whole-shape frozen-policy pin gains `hostCallbackWrap: { wrap: "unsupported" }`.
- **Did NOT move**, verified by running them: the
  `tests/issue-3214-void-host-callback.test.ts` B2 pins (the binding KIND stays
  `import`, so the maker's spelling, sentinel and import index are unchanged);
  every `tests/issue-3520-callable-provider-abi.test.ts` binding pin;
  `tests/issue-3526-ir-runtime-manifest.test.ts`; both async suites
  (`issue-4103`, `issue-4104` apart from the one line above), whose
  `async.callback.wrap` citer enumeration still sees `host.promise.react` — the
  record is REUSED, not renamed, and gains a second citer rather than a twin.
- **Divergence-4 class: EMPTY.** The maker is total under both live arms. On a
  JS-host lane every certified arrow gets the maker; on the exact standalone-DOM
  lane every certified arrow gets the dispatcher; everywhere else
  `calendar-selection-support.ts:27-36` never certifies one, so there is no
  population to demote. No `operand-coercion-unsupported`@build pin covers a
  population this arm demotes, because this arm demotes none.

#### P4 — census unmoved

- `pnpm run check:ir-fallbacks`: **OK, no unintended/post-claim/module-level
  increases**, run after the final edit. `scripts/ir-fallback-baseline.json` is
  untouched in the diff (`git diff --stat scripts/` shows only the
  kind-neutrality baseline).
- `scripts/linear-ir-baseline.json`: **untouched**;
  `tests/issue-4550-linear-ir-census.test.ts` green.
- **One gate did move, as F2-S7 and F2-S8's did**: `check:ir-kind-neutrality`
  reported four EVIDENCE line numbers shifted by my insertions, with no verdict
  and no classification change —
  `kinds.forof.string.evidence.1` `integration.ts` 7095 → 7213,
  `kinds.string.len.evidence.1` `linear-integration.ts` 1638 → 1640,
  `kinds.vec.new_fixed.evidence.0` `from-ast.ts` 4526 → 4527,
  `kinds.vec.set.evidence.1` `from-ast.ts` 390 → 391.
  Refreshed **surgically** (four one-line edits, the F2-S7 `c980a4b41`
  precedent), not with `--update-on-decrease`, which rewrites the whole file's
  JSON formatting.
- `check:ir-layering`: **86 import lines across 15 files (baseline 86)**, before
  and after. The three new cross-file imports
  (`from-ast.ts` → `runtime-host-capabilities.js`,
  `integration.ts` → `runtime-host-capabilities.js`,
  `ir-overlay-finalize.ts` → `runtime-host-capabilities.js`) are invisible to
  the gate BY CONSTRUCTION: it counts only specifiers resolving under
  `src/codegen/`, and the third one points the other way (codegen → ir), which
  the gate does not count either.

#### Verification matrix

**V-A — 21/21 cells byte-identical, WAT included.** Five fixtures × their lanes,
compiled before and after on the same tree: 09 (the census's
`addEventListener` shape), 09b (the pinned B2 source,
`issue-3214-void-host-callback.test.ts:8-14`), 04 (a closure with no host
callback — the control), CLEAN (a number-only control), each × gc-host `{}`,
gc-strict-no-host `{strictNoHostImports:true}`, standalone
`{target:"standalone"}`, wasi `{target:"wasi"}`, linear `{target:"linear"}`;
plus CAL × exact standalone-DOM. Every cell matches on success, byte length,
binary sha256, the ordered import list, the `result.imports` list, the error
list, `irCompiledFuncs`, `irOutcomes` and WAT sha; a `diff -r` over all 21
emitted WAT texts is **empty**. **0 differing fields.**

| fixture | gc-host | gc-strict-no-host | standalone | wasi | linear |
| --- | --- | --- | --- | --- | --- |
| 09 | 852 ✓ `f65b5d28809d` | 93598 ✓ `74623fd98ed4` | 33181 ✓ `cf9c5ac59002` | fail ✓ | fail ✓ |
| 09b | 908 ✓ `2b0fa77dc7d5` | 93602 ✓ `b1f0131b3a1e` | 50422 ✓ `7f9a1ee3f80e` | fail ✓ | fail ✓ |
| 04 | 2956 ✓ `95960a6599ac` | 32978 ✓ `777f88d8ad11` | 33001 ✓ `beabd4f0669e` | 33028 ✓ `75200ffae214` | fail ✓ |
| CLEAN | 158 ✓ `73a8d1fa2a90` | 21994 ✓ `9b2e9228e465` | 22609 ✓ `a04eb66e7b6d` | 22636 ✓ `006f16ecfff8` | 4895 ✓ `15f2f81b5bcc` |
| CAL (exact standalone-DOM, its own lane) | 69282 ✓ `232d3c9ec8af` | — | — | — | — |

(✓ = bytes, sha256, imports, errors, outcomes and WAT all identical
before/after. `fail` = the same hard failure on both sides: wasi
`DOM global 'EventTarget' is not available in WASI target`, linear
`Unsupported method call: .addEventListener()`.)

**This slice produced NO WAT diff at all.**

**V-B — import parity.** The exact ordered `result.imports` array for 09b/gc-host
is pinned in the new suite (section (c), reproduced under P1), with
`__make_callback` asserted at function-import index 3. The runtime oracle check
instantiates the module, installs the callback through a fake `EventTarget`,
fires it, asserts `sink.textContent === "42"`, asserts the wrapper returns
`undefined` and asserts `Reflect.construct` on it throws `TypeError` — i.e. the
one-shot sentinel's semantics, unchanged.

**V-C — non-vacuity by revert: three reverts, each fails EXACTLY one named new
pin, 34/35 otherwise green.**

| revert | pin that fails |
| --- | --- |
| from-ast spells `irImportFuncRef("env", "__make_callback")` again | `leaves no maker string literal in from-ast — the crossing is built from the record` |
| sub-B restores the hand-written `(i32, externref) -> externref` check | `leaves no maker string literal and no hand-written ABI in the overlay proof` |
| the post-freeze admission arm is removed | `keeps the post-freeze admission keyed on the FROZEN provider, not on a name` |

Every schema and policy pin stayed green in all three runs.

**These three pins are grep-shaped, and that is a finding, not a convenience.**
The capability record names *exactly* the spelling both seams used to hard-code,
so restoring either hand-written form is byte-identical AND pin-identical to
everything else in the file — I measured that too: with the record's field
perturbed to `__make_callback_probe`, the slice and the revert produce the same
504-byte module, because sub-B (which reads the record) refuses the drifted
maker first and the whole module demotes before from-ast's spelling can matter.
What the slice actually removes is the **second authority**, and the only way to
pin the absence of a duplicated constant is to look for it. Precedent: the
#2955 depolymorph grep gate.

**V-D — fail-closed reachability.**
- Typed refusal: `RuntimeManifestInvariantError` / `provider-target-unavailable`,
  message `runtime feature js.callback.wrap is unavailable under
  host-callback-wrap policy wrap=unsupported`. Pinned live in section (b).
- Owner-local demote: pinned on the partition source slice, as F2-S8 pinned its
  own unreachable arm. **Stated plainly: the disabled arm is unreachable on every
  real lane** — the selection gate never certifies an arrow where the policy is
  `unsupported`, which is the structural reason this slice is byte-neutral —
  so a live per-owner demote with a clean co-owner cannot be produced from a
  real compile without hand-building a policy the projections cannot emit. The
  pin therefore asserts the block's shape: `late-preparation-unsupported`,
  `markOwnerFailure(terminalOwnerOf(entry), …)`, the trailing `continue;` that
  keeps a clean co-owner in `healthyForLower`, and **both** sides of the check
  (an `unsupported` policy refuses either crossing; a policy that selected the
  OTHER arm refuses too).
- Sub-B ABI-drift refusal: four live pins — wrong param types, wrong arity,
  wrong result type, empty results — plus wrong module and wrong field.

**V-E — suites and gates.**
- New: `tests/issue-3526-callable-boundary-callback.test.ts`, **38 tests, all
  green**, with the per-slice anatomy (a) contract · (b) policy · (c)
  end-to-end · (d) the overlay proof reads the record · (d2) the maker spelling
  has ONE source · (e) validation + the P1 measurement · (f) the exact
  standalone-DOM lane · (g) the demand scan, the partition and the projection ·
  (h) deliberately out of scope · (i) adapters.
- Controls, 27 files / 505 tests: all 15 `#3526` suites, both async suites,
  four `#3520` callable/overlay suites, both `#3214` callback suites,
  `issue-4550-linear-ir-census`, `issue-4576-standalone-dom-builtins`, and the
  two `#4577` DOM/calendar suites. **19 failed | 486 passed on BOTH sides** —
  the red set is identical name for name, measured on this branch's own tree
  with the source edits reverted and re-applied (file-copy A/B, no `git stash`).
  It is 6 files: `issue-4576-standalone-dom-builtins` (15),
  `issue-4577-standalone-calendar-retirement` (2),
  `issue-4577-dom-interaction-bridge` (1), `issue-3214-callable-abi` (1),
  `issue-3214-void-host-callback` (1: `rejects non-void before the IR claim`),
  `issue-3520-closure-host-bridge-abi` (1). **None is this slice's**, and the
  B2 one was confirmed against a pristine `origin/main` checkout as well.
- `tests/issue-3518-multi-prepared-string-leaf-planner.test.ts` was **not run**:
  it OOMs the vitest worker on this 4-core box, as F2-S4…F2-S8 all recorded.
  CI runs it with a larger heap.
- Five ratchet gates, chained and bare, **and again under
  `LOC_GATE_BASE=$(git rev-parse origin/main)`**: all green. `pnpm run typecheck`
  and `pnpm run format:check` clean.

#### What landed

- **`src/ir/runtime-manifest.ts`** (+170) — `HostCallbackWrapPolicy`
  (`wrap: "host" | "native-dispatch" | "unsupported"`), frozen
  `HOST_CALLBACK_WRAP_POLICY_DISABLED`, the optional `hostCallbackWrap` field
  canonicalized at construction and published resolved, ONE feature
  (`js.callback.wrap`), ONE new implementation kind (`native-dispatch`) with its
  no-host-capability validation rule, TWO provider rows, and the
  `#selectProvider` branch whose unavailable arm is a typed
  `provider-target-unavailable` naming `host-callback-wrap policy wrap=…`.
- **`src/ir/intrinsic-support.ts`** (+66) — the PAIR-shaped
  `hostCallbackWrapDemand` input and its place in the "freeze nothing at all"
  conjunction, and `preparedHostCallbackWrapProvider`, which returns the maker's
  import MODULE, FIELD and full ABI on the host arm and the dispatcher ROLE on
  the native one — a target is impossible there, because the native arm's whole
  content is that nothing is emitted.
- **`src/ir/integration.ts`** (+164) — `integrationHostCallbackWrapPolicy` (the
  two lane predicates, disjoint by construction: the DOM lane is
  `environment: "none"`, so it can never be `ambient-js`), the
  `closure.new`-shaped `irHostCallbackWrapDemand`, the two-sided owner-local
  partition in the same pass as the ten existing ones, the freeze-time policy
  and demand arguments, the prepared manifest threaded into
  `preregisterDynamicAndForInSupport` / `preregisterDynamicSupport`, and
  `admitAttachedHostCallbackMaker` — the attached-target recognition, extracted
  as its own function in the shape F1-S4 gave `attachedExternIsUndefinedArm`.
- **`src/ir/runtime-host-capabilities.ts`** (+16) —
  `HOST_CALLBACK_WRAP_CAPABILITY_RECORD`, the catalogue record resolved once at
  module scope. It is the seam between two authorities that must never drift:
  the STATIC catalogue answers from-ast at build time, the FROZEN manifest
  answers admission post-freeze, and both name this one object.
- **`src/ir/from-ast.ts`** (+8) — the maker crossing built from that record
  instead of spelled by hand. Binding kind stays `import`; the `-2` sentinel and
  the exact standalone-DOM branch are untouched.
- **`src/codegen/ir-overlay-finalize.ts`** (+12, sub-B) —
  `hasExactHostVoidCallbackMakerImport` compares the physical import against the
  record's `module` / `field` / `params` / `results` instead of a hand-written
  copy. `callback-ctor-bridge.ts` is NOT touched; its record lands in F3-S2.
- **`src/ir/backend/linear-integration.ts`**, **`src/codegen/stdlib-selfhost.ts`**
  — both pass `HOST_CALLBACK_WRAP_POLICY_DISABLED` explicitly (+2 each). Neither
  freeze passes a callback demand, so DISABLED refuses nothing.
- **`tests/issue-3526-callable-boundary-callback.test.ts`** (new, 38 tests);
  **`tests/issue-4104-…`** (+1 line, the whole-shape pin).

`src/ir/lower.ts`, `src/ir/nodes.ts`, `src/ir/builder.ts`,
`src/ir/closure-struct-registry.ts`,
`src/codegen/standalone-dom-callback-authority.ts`,
`src/codegen/declarations/import-collector.ts`, `src/codegen/closure-exports.ts`
and every backend emitter needed **no edit**.

#### Deviations from the plan

1. **P1's answer is neither of the two options the plan offered** — a new
   implementation kind, for the measured reason above. It honours the plan's one
   hard constraint (no F3-S2 record kind) and its item-1 policy union verbatim.
2. **The demand is scanned off `closure.new`, not off the maker `call`.** The
   plan's items 3-4 describe the crossing in terms of the `call`, and the
   `call`-on-`env`-import scan is where the ADMISSION lives, as specified — but
   a call-shaped *demand* would freeze no row on the exact standalone-DOM lane
   and the manifest would not be that lane's admitting authority (contract item
   3). `hostOneShot` and `domCallbackAuthority` are set only by
   `lowerHostVoidCallbackExpression`, one per arm, so reading them is the one
   lane-free way to see both crossings. No `closure.new` flag was changed
   (contract item 6) — they are read, not written.
3. **The attached-target recognition is an extracted function, not an inline
   arm.** Inline, `preregisterDynamicSupport` crossed the 300-LOC function
   budget (330). Extracting `admitAttachedHostCallbackMaker` — the shape F1-S4
   already gave this seam's sibling — leaves it under the threshold and needs no
   grant.
4. **The three V-C pins are grep-shaped rather than behavioural**, for the
   reason measured under V-C above. The plan's V-C wording ("exactly the named
   new pins fail") is satisfied; what the pins assert is the absence of a second
   authority, which is what items 3 and 5 actually change.

#### Left undone (out of this slice, by the contract)

`callback.wrap.ctor` / `callback.wrap.getter` / `closure.apply` records, the
`kind: "export"` host→module rows for `__call_fn_N` / `__closure_arity`, and the
`func-family` rows for `__call_function_N` are F3-S2's. The `-2` / `-1` sentinel
has no record field (deferred (d)) and gained none here. `plan.invocation`,
`calendar-selection-support.ts`, the closure-environment subtype choice
(F3-S4) and the unmatched-callee host fallback (F3-S6) are untouched.

#### Re-measured after `git merge origin/main` (`4abfe80ea`)

The merge brought in the family-2 close-out and the family-3 census sections of
this file (kept in full, above, with this note appended after them — the docs PR
landed while the slice was in review) plus 24 hours of unrelated `main`, and it
moved **two absolute byte figures** in the V-A table: `09/gc-strict-no-host`
93598 → **93766** and `09b/gc-strict-no-host` 93602 → **93770**, both +168.

**That is `main`'s stdlib growth, not this slice's, and it was measured rather
than assumed.** The whole 21-cell A/B was re-run on the MERGED tree — my eight
source files replaced with `origin/main`'s, matrix recorded, files restored,
matrix recorded again: **21/21 identical, 0 differing fields, `diff -r` over all
21 WAT texts empty.** Every other cell's bytes and sha256 are unchanged from the
pre-merge table, including both callback cells on gc-host (852 / 908) and the
exact standalone-DOM cell (69282 / `232d3c9ec8af`). The two moved figures are
the same on both sides of the merged base; only the pre-merge table's absolute
numbers for those two cells are stale, and they are left as measured rather than
retro-edited.

All five ratchet gates, `check:ir-kind-neutrality`, `check:ir-layering`,
`typecheck` and `format:check` were re-run on the merged tree: green, bare and
under `LOC_GATE_BASE=$(git rev-parse origin/main)`. The kind-neutrality baseline
needed no further edit — the four evidence lines this slice shifted are the same
after the merge.
