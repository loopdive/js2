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
standalone-arms-allow:
  # 2026-11-05 (#4016): measured +1 standalone; open-object @@iterator calls
  # reuse the real callable-element owner, not GetIterator normalization.
  - src/codegen/expressions/call-tail-dispatch.ts
  # 2026-11-05 (#4016): measured +1 standalone/+1 WASI; the native String.split
  # closure's fixed ABI must evaluate surplus arguments before coercion.
  - src/codegen/expressions/calls.ts
  # 2026-11-05 (#4016): measured +2 standalone; one shared native Symbol-to-
  # Number TypeError boundary is prepared and recaptured after operand staging.
  - src/codegen/helpers/string-split-coercion.ts
  # 2026-11-05 (#4016): measured +1 standalone/+1 WASI; fresh computed methods
  # use native key/name/descriptor providers, never shared declaration metadata.
  - src/codegen/literals.ts
  # 2026-11-05 (#4016): measured +1 standalone/+1 WASI; the live Symbol binding
  # identity check selects a real raw key carrier before ToPropertyKey.
  - src/codegen/property-access-dispatch.ts
  # 2026-11-05 (#4016): measured noJsHost 1→2 (+1 net); the fresh class-value
  # SetFunctionName owner seeds the canonical native data descriptor once.
  # Exact own installer/key joins preserve name overrides; this is not a
  # static-receiver ABI fallback or a read-time type-name replacement.
  - src/codegen/expressions/extern.ts
import-cycles-allow:
  - largestSccSize: 733 # 2026-11-13 (#4016, replacement for PR #6206): restated after merging main, whose own SCC is now 732; the same one file (the shared staged split coercion owner) joins it. 2026-11-05: one shared staged split coercion owner joins the existing codegen SCC; direct and reflective split reuse the same provider preflight and exact ToUint32 emission
loc-budget-allow:
  - src/codegen/regexp-standalone.ts
  - src/codegen/string-ops.ts
  - src/codegen/expressions/calls.ts
func-budget-allow:
  - src/codegen/string-ops.ts::compileNativeStringMethodCall
  - src/codegen/expressions/calls.ts::emitReflectiveNativeProtoClosureCall
  # 2026-11-05 (#4016): actual formatted gate 1234 vs 1231 (+3); the real
  # nested-declaration return registration calls the shared exact captured
  # const/open-literal proof before allocating its physical result ABI.
  - src/codegen/statements/nested-declarations.ts::compileNestedFunctionDeclarationInScope
  # 2026-11-05 (#4016): actual formatted gate 433 vs 431 (+2); Phase-0 hoisting
  # must mirror the same shared result-carrier proof so its reserved callable
  # signature agrees with the actual producer. No duplicated analysis body.
  - src/codegen/statements/nested-declarations.ts::hoistFunctionDeclarations
---

## 2026-09-28 documentation checkpoint scope

This checkpoint publishes documentation and receipts only. The vnext49 fixture
and the `stripStaticWrapper` candidate remain uncommitted local diagnostic
work, are not part of the published compiler, and do not credit a fix gain.

## 2026-09-28 verified host callback controls

The independent undefined-index repair is published as
[PR 6214](https://github.com/loopdive/js2/pull/6214), but does not repair this
issue's host Symbol-limit semantics. A corrected, temporary diagnostic ran in
the separate integration checkout at `47fd894d96cc647cbe637741c98a9a60805eb4ff`
with only that three-line cache repair in production source. Its imports-file
SHA256 was `8aae5e7a0e233f06ead2bd6900f9b48bff14650ae8ffd2c129e133a05abac1ca`;
the frozen historical 47-test fixture remained
`92bd8d30a494c17e6d1e04c07c0498a51a61311a619303a48c1f5f2c7fc46efc`.

The earlier expanded diagnostic stopped before observation because its tracing
harness wrongly required a host `__to_primitive` import for a direct compiled
callback. The corrected harness permits absent host traces only for that
explicit direct-call control; host cases retain their trace checks. On the
explicit Node 24.19.0 binary, one fork, and 4096 MiB parent/fork heaps, its one
diagnostic test passed in 28.32 s. This is diagnostic validation, not a
five-case conformance success claim:

- Bare Symbol control: result `1`; `__to_primitive` returns a Symbol and
  `__unbox_number` throws `TypeError`.
- Direct compiled `Symbol.toPrimitive` call: encoded result `101`, with no
  host conversion imports/traces, proving the direct callback/counter control.
- Host number-hint `valueOf` control: encoded result `101`; the host receives
  the exact `"number"` hint and a numeric primitive reaches numeric conversion.
- Numeric-returning and Symbol-returning Symbol callbacks: both encoded
  results remain `0`; host `__to_primitive` receives an object and the exact
  `"number"` hint, but returns the string `"[object Object]"`. The following
  numeric conversion receives that string and does not throw.

The positive controls narrow the remaining investigation to Symbol-method
exposure/lookup across this host boundary. They do not identify the precise
producer or bridge defect, establish a fix, or authorize shared runtime/IR
edits. The earlier null-terminal hypothesis remains refuted.

The retained expanded-fixed diagnostic contains only
`/private/tmp/js2-6715-host-toprimitive-expanded-node24-fixed.OFNWga/receipt.txt`
(SHA-256 `af41dcd6df0eec9611835d78bfc4b13b3208fea2a172cb0868968fa185eee2a3`)
and its sibling `vitest.log`
(`fcd890da5bd3dd9d9fba0b79e71c1d31608bbc79e888142c00285b6116a23a1f`).
It retains no WAT, Wasm binary, or export-table enumeration. The ignored probe
SHA256 is `c87e41c60e917847ed9b50dc091f8be8bef028b1504609ace451694cccd3ae00`;
its runner-visible copy was removed after terminal exit 0. Neither the frozen
acceptance fixture nor the published index-fix branch was changed.

#### 2026-09-28 source-supported host `Symbol.toPrimitive` export boundary

This is a source-supported handoff, not emitted-module or callback evidence.
For the host-assisted native-string direct-split arm,
`captureHostStagedSplitLimitProviders` rebuilds a
`runtimeHostToPrimitiveInstrs(ctx, "number")` call after staging. Its preflight
uses `prepareHostRuntimeToPrimitive`, which registers a real host-string
`"number"` global and the `__to_primitive` import. That import maps the host
externref hint to `"number"` and invokes runtime `_hostToPrimitive`. In turn,
the host walker can probe `exports["__call_@@toPrimitive"]` and, when that export
is a function, call it with the raw struct and host hint before its ordinary
`valueOf`/`toString` fallback.

There is a material export-admission boundary on that possible route.
`emitToPrimitiveMethodExport` emits a hint-taking entry only when its second
compiled parameter is `externref`; it skips a non-externref hint. Under native
strings, the normal `string` type mapping uses the native `$AnyString` carrier,
so a declared `hint: string` can be skipped by that filter. Before the v2
evidence below, source inspection supported a possible missing-export
explanation but did **not** prove that the exact diagnostic callback was
skipped, that the export was absent, or that a present export received a wrong
hint. The retained v1 diagnostic has no WAT, Wasm, or export inventory to decide
those alternatives.

The historical v1 diagnostic above still has no export inventory. A separate
v2 inventory has now supplied that missing emitted-module evidence: under Node
v24.19.0, one fork, and 4096 MiB parent/fork heaps, it exited 0 with one
diagnostic passing in 18.51 s. Its retained receipt is
`/private/tmp/js2-6715-export-inventory-v2.D9XsKb/receipt.txt` (SHA-256
`daaed0cfd62660342b39d5d37a13be1f4afdb523c781992d52fa4eaaae19b518`), its
Vitest log is SHA-256
`30abc6ca4d17db4f768febcebc20f3e29a4f35e56f19a8201e4a21b3c933d52c`, and its
ignored v2 source was SHA-256
`2e5f671c70220cfde92f3d4762a636d88cde46dd6a739a9cad046f8f622c6cd4` before
the runner-visible copy was removed.

`WebAssembly.Module.exports` reports no `__call_@@toPrimitive` export for either
the numeric- or Symbol-returning host computed-**method** callback. Both receive
the host `"number"` hint and fall through to `"[object Object]"`, yielding the
recorded result `0`. The direct compiled callback likewise has no bridge export
but returns `101` without a host trace; it is therefore a control for the direct
internal route, not evidence that the host bridge works. The independent
`valueOf` control returns `101` and exposes both `__call_valueOf` and
`__sget_valueOf`, demonstrating a working adjacent export route. All tested
method-shorthand modules also lack `__sget_@@toPrimitive`; that absence is
expected for the field-specific route and is not causal evidence here.

This proves the `__call_@@toPrimitive` export is absent for the exact host
method fixtures and supports—without isolating it from other entry
filters—the source-level non-externref-hint hypothesis. It neither proves a
safe bridge repair nor identifies a removal/insertion site. The next possible
step is a narrowly owned bridge/export investigation after explicit ownership
clearance. The computed-field `Symbol.toPrimitive` route remains owned by the
active #3481 work; #4016 makes no runtime, closure-export, bridge, or
shared-dispatch implementation claim. This handoff also leaves the separately
recorded computed-Symbol producer hold and #6716 return-carrier boundary
unchanged.

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

### 2026-09-28 source-only follow-up: real split-protocol acceptance

The two historical refusal pins in the focused fixture were not valid lasting
acceptance criteria after upstream B6. They asserted a diagnostic for cases
that current lowering intentionally admits, and thus would keep a repaired
path red without testing its runtime result. The vnext fixture replaces them
with four ordinary runtime assertions; its completed candidate receipt is
recorded below and retains every failure as an ordinary assertion.

1. It preserves the original source `const sep: any = JSON.parse("1")` and
   original subject `"abc"`, asserting the one-part result from the plain
   `ToString(1)` fallback. This remains a numeric fallback check rather than
   silently substituting a different fixture.
2. It separately uses `JSON.parse('"b"')` and asserts the actual two string
   parts from `"abc".split(sep)`, so the dynamic fallback proves more than an
   absence of a diagnostic.
3. It calls an explicit object `[Symbol.split]` method with a supplied raw
   string limit and checks exactly one call, protocol `this`, raw subject,
   raw supplied limit, and returned-marker identity. The current direct
   protocol route is `tryCompileStringSymbolProtocolDispatch` in
   `string-symbol-protocol.ts`, wired by `call-receiver-method.ts`; it is
   distinct from the dynamic no-method fallback in
   `string-regexp-dynamic.ts`.
4. It calls the same explicit protocol with an omitted limit and requires both
   `limit === undefined` and `arguments.length === 2`. ECMAScript calls the
   method with `[O, undefined]`. Current source inspection shows the direct
   protocol emitter only appends a limit expression when one was supplied, so
   this deliberately remains an ordinary assertion: if the formal parameter is
   filled by the runtime but the call arity is one, it must stay visibly red,
   not become a skip or expected failure.

The raw-v1 direct-object receiver red remains unchanged in source and expected
value (`1234`). Its statically native `receiver(): string` annotation admits a
native string method route, but its returned object has no `.split` member. In
ordinary JavaScript, separator, limit, and surplus expressions run before the
eventual non-callable-member `TypeError`; moving the new direct split
`RequireObjectCoercible` boundary after arguments would incorrectly change
genuine nullish member-base behavior. The underlying defect is broader static
member admission/return-carrier handling (`index.ts`, `control-flow.ts`,
`type-coercion.ts`, and `call-receiver-method.ts`), so it is recorded here as
a handoff rather than widened under #4016. The dedicated, plan-only
[#6716 return-carrier follow-up](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6716-erased-object-return-string-method-dispatch)
captures its evidence, ownership boundary, and future acceptance criteria; it
does not authorize a carrier or dispatcher edit from this branch.

The native Node reference equivalents for all four new protocol cases and the
retained raw-receiver case are the prerequisite semantic oracle. Because this
vnext change initially changes only the fixture and handoff—not compiler
source—a copied `47fd894d96` baseline would exercise byte-identical compiler
code and would not be an implementation A/B comparison. After #6715's
separate historical 47-test cache-relocation pair completed, the appropriate
next receipt is therefore **one** full vnext candidate run on recorded
compiler revision `47fd894d96`, with the exact fixture hash and every ordinary
failure retained. A fresh same-fixture baseline/candidate pair becomes
mandatory only if a later implementation changes compiler behavior. This
branch must not alter the separate #6715 registry/global-index worktree or use
its integration tree as a baseline fixture host.

The source-only reference step completed on Node `v24.19.0`, with no compiler
imports, bundle build, Vitest process, or project runtime: numeric fallback
`1`, string-parts assertion `1`, explicit-protocol assertion `1`, omitted-limit
arity assertion `1`, and retained raw-member TypeError order `1234`. These are
host-language expectations only; they are not standalone candidate evidence
and do not change the earlier 42-pass/5-fail checkpoint denominator.

The one permitted vnext candidate receipt then ran under Node `v24.19.0` at
recorded compiler revision `47fd894d96cc647cbe637741c98a9a60805eb4ff`, fixture
SHA-256 `4d47dc24d0fefb641727c5e0f203fc2ab90642cfc258c94f7a3ca720dbb24b75`,
one Vitest fork, `--no-file-parallelism`, and both parent and fork 4 GiB heap
limits. It is **44 pass / 5 fail**, not a compiler A/B claim. The five ordinary
failures are retained verbatim: explicit `@@split` raw-argument/result
identity (`0`, expected `1`); omitted-limit explicit-`undefined` arity (`0`,
expected `1`); the direct erased-object receiver order (`1`, expected `1234`);
the separately-owned host stale-global invalid-Wasm error; and the existing
descriptor-before-split host `TypeError: Cannot convert object to primitive
value`. The durable receipt is
`.tmp/4016/vnext49-candidate-47fd894d96-20260928.log`; it neither converts any
ordinary assertion into an expected failure nor changes the earlier raw-v1
evidence.

The completed bounded diagnostic replaced neither vnext assertion nor its
expected result. Its separately named source used an observable bit mask for
call count, protocol `this`, raw subject, raw supplied limit, result identity,
and a fallback-`toString` flag for the supplied-limit case; and for
`arguments.length === 2`, `limit === undefined`, result identity, and the same
fallback flag for the omitted-limit case. The masks distinguish a missed
`GetMethod`/fallback from a callable/receiver/vector/result-identity failure
while preserving the committed ordinary assertions at `1`.

#### 2026-09-28 shape-matched bitmask/WAT receipt

The first temporary mask added a `toString` method solely to observe fallback
use, so its all-zero result could not establish causality for the acceptance
literal. A second source copied the acceptance literals' computed
`[Symbol.split]` method declarations, `unknown` parameters, marker returns,
`as any` call-site assertions, and direct string receiver **without** a
`toString` member. Node v24.19.0 gives masks `95` (supplied limit) and `127`
(omitted limit); the standalone run at
`47fd894d96cc647cbe637741c98a9a60805eb4ff` gave `0` for both. It retained the
ordinary acceptance fixture byte-for-byte at SHA-256
`4d47dc24d0fefb641727c5e0f203fc2ab90642cfc258c94f7a3ca720dbb24b75`.

The matching compile-only WAT artifact is
`.tmp/4016/protocol-bitmask-no-tostring-standalone-47fd894d96.wat`, SHA-256
`3d55d80ebe3e2adff1414c9a9368ffb6a678e3fecb0c898514f16482138abb34`.
With no function imports, both exported test functions call function `358`,
`$__str_split_dyn`; neither calls `139` (`$__extern_get`) nor `172`
(`$__apply_closure`). Thus the upstream B6 protocol arm is **not emitted** for
this exact TypeScript shape: it is a compile-time route decline, not a runtime
slot-lookup or closure-call failure.

The raw-wrapper admission predicate is now source-proven. The primary checker
calls `checker.getTypeAtLocation` before `factOfType`, so raw `sep as any` has
`TypeFlags.Any` and becomes `{ kind: "any" }`. The in-house checker separately
classifies an assertion from its written type node and reaches the same `any`
fact. `tryCompileStringSymbolProtocolDispatch` admits only `object` or `class`,
so the raw wrapper declines before it can emit `__extern_get`. A checker-only
query over the exact object literal reports that stripped `sep` has
`TypeFlags.Object` and symbol `__object`; the direct split gate already unwraps
this same expression with `searchValueOperand`. The #6651 positive Test262
source instead uses `var separator = {};` followed by
`separator[Symbol.split] = function () { ... };`, with no assertion wrapper.

The narrow #4016 repair normalizes static wrappers with the existing
`stripStaticWrapper` utility before **both** the protocol fact check and
`compileExpression` call. This removes the raw assertion's `any` refusal while
keeping a truly `any`-typed value declined; calls and property accesses under
an assertion still fail the existing re-evaluation gate. The only caller is
`call-receiver-method.ts`, which invokes the protocol helper before the native
direct split fallback, so the edit is an existing #4016 admission change rather
than an IR, ABI, or generic dispatch change.

The first candidate after that edit remains **44 pass / 5 fail**, exactly the
recorded vnext count: both protocol assertions still return `0`. Its receipt
is `.tmp/4016/protocol-assertion-unwrapping-candidate-47fd894d96-20260928.log`
at source SHA-256 `9e1634b266bab3c1f7e05c958889abf3bbd3321ae4f2a5d7cfb48245a9cdfa45`;
the acceptance fixture stays SHA-256
`4d47dc24d0fefb641727c5e0f203fc2ab90642cfc258c94f7a3ca720dbb24b75`.
That outcome does **not** prove a remaining admission decline: the protocol arm
may now be emitted and fail later at lookup, call, receiver/vector construction,
or result handling. The one exact same-shape candidate trace has now resolved
that distinction without changing the vnext fixture. At temporary traced source
SHA-256 `9eb1472784a88954747ad08ece6d6ba23bcf95aced28bcf0877abf8e747674d2`,
both exports reported raw `AsExpression` fact `any`, unwrapped `Identifier` fact
`object`, re-evaluability for the receiver and search value, all required
providers present, and `protocol-emitted`. The durable trace is
`.tmp/4016/protocol-assertion-admission-wat-trace-47fd894d96-20260928.log`,
SHA-256 `1259cd00e28811a83ec3ff3cb848ada54eecfee3648dd3f2ec3d4554333f4f35`.

Its WAT artifact is
`.tmp/4016/protocol-assertion-unwrapping-candidate-47fd894d96.wat`, SHA-256
`7d87ea3e92ed188b878de1354f0bf92ae20050812ef5283e26cf6b1173dfe676`.
With no function imports, both exported functions call `139` (`$__extern_get`),
perform the nullish and callable checks, build the argument vector, and call
`172` (`$__apply_closure`). `358` (`$__str_split_dyn`) occurs only in the
nullish-method fallback arm. Therefore the stripped candidate **does emit** the
protocol route; its still-zero runtime masks cannot be attributed to the former
static-wrapper admission decline. This is compile/WAT route evidence only: it
does not identify whether lookup, closure dispatch, receiver/argument transport,
or result transport causes the later runtime mismatch.

The temporary trace function and one-file WAT runner were removed immediately
after this terminal capture with the accepted `stripStaticWrapper` change kept.
The cleaned candidate source SHA-256 is
`5a648bdc36d6979a6a187367957e5bf5bf9786e3add187270a589969ffccc168`.
The two ordinary protocol assertions remain scoped regression pins; no Test262
gain is credited.

The complete pre-edit temporary receipt remains
`.tmp/4016/protocol-bitmask-no-tostring-wat-analysis-20260928.md`.

#### 2026-09-28 computed `[Symbol.split]` literal representation audit

The post-admission WAT receipt narrows the remaining protocol failure further.
The acceptance separator is a computed **method literal**,
`{ [Symbol.split](...) { ... } }`; it is not the form used by the existing
passing Test262 original
`built-ins/String/prototype/split/cstm-split-invocation.js`, which first makes
`var separator = {}` and then performs
`separator[Symbol.split] = function (...) { ... }`.

Source and WAT inspection show two coupled representation facts, neither of
which is repaired by the accepted assertion-unwrapping change:

1. `resolveComputedKeyExpression` maps the literal name to the internal
   `@@split` spelling and `_hasRuntimeComputedKey` intentionally keeps a
   well-known Symbol key on the closed-struct path. In
   `compileObjectLiteralForStruct`, however, the per-field `matchingProps`
   matcher recognizes identifier, string, and numeric method declarations but
   not a `ComputedPropertyName`. The method body is still compiled, while the
   corresponding closed field has no matching writer and is initialized with
   its default undefined value. The captured WAT has the compiled anonymous
   `@@split` method body but no installation of that body into the literal's
   `@@split` field.
2. Correcting only that literal matcher would still not make the protocol
   lookup work. The emitted protocol arm calls generic `__extern_get` with a
   real boxed `$Symbol` id `10`. Its closed-struct field arms dispatch numeric
   and `$AnyString` keys; they do not translate a `$Symbol(10)` key to the
   internal `@@split` spelling. This limitation is already documented by the
   narrow `[Symbol.toPrimitive]` open-object precedent: a runtime Symbol-key
   lookup cannot observe an `@@name` closed-struct field.

The #6651 original avoids both faults because the empty literal remains an
open `$Object` after the later element assignment. That assignment is emitted
through the existing real-Symbol `__extern_set` path, so generic
`__extern_get` can recover the same actual Symbol key. This is a
source-supported explanation of the current zero protocol masks; it is not a
claim that the Test262 original itself has been rerun or that either path is
now fixed.

No literals or object-runtime patch is authorized from this #4016 slice.
Recognizing computed methods in the closed-field matcher alone is insufficient;
a valid next slice would need a fresh ownership/claim review for a producer
representation decision (for example, routing just the relevant literal to
the proven open-object Symbol-key store) and its carrier consequences. A
generic `$Symbol`-to-closed-field reader would instead touch shared
`object-runtime`/closure authority and is explicitly outside this branch.
The two ordinary protocol assertions remain red until such a separately scoped
change has direct runtime evidence.

#### Ownership and a bounded producer-only follow-up boundary

The live assignment-ledger read on 2026-09-28 found no live claim for the
closest historical plans: #5108 (computed-only non-Symbol data keys), #5149
(object-literal wave), #5269 (`[Symbol.toPrimitive]` open-object precedent),
and #5270 (computed-key residual wave) are reserved rather than active. They
are useful history, not current ownership. The ledger still reports #3099 as
claimed by `ttraenkler/dev-proxy`, but repository ancestry establishes that it
is a historical claim rather than an active owner: implementation
`b1097f64e4` is the direct parent of merge `4c305100ca`, and both are
ancestors of fresh `upstream/main` `37b11b28919ef22a428cb13aa31006850e331ecb`.
Its completed method-materialization plan expressly excludes
computed/well-known-Symbol methods; it is useful landed precedent, not an
ongoing ownership block. Open PR search found no exact computed-`[Symbol.split]`
literal patch. PR #5753 is open and modifies `literals.ts` only at the adjacent
`objectLiteralSpreadTakesHostPath` area for indexed spreads, so an eventual
literal-gate change requires a fresh exact-hunk overlap check even though its
current diff is not the computed-method matcher.

The existing open-object **writer** is already category-general: when
`compileObjectLiteralWithAccessors` receives a computed `MethodDeclaration`
spelled as a recognized `Symbol.X`, it resolves every table entry through
`getWellKnownSymbolId`, boxes that id, and stores the closure with
`__extern_set`. A follow-up must reuse that writer rather than add a
`Symbol.split` special case. The proposed producer predicate is therefore the
semantic category “a computed object-literal method whose key is a resolved,
ambient-global well-known `Symbol.X`”, not a test-name or one-id exception.

That category is **not yet safe to route wholesale**. `Symbol.iterator` is a
documented counterexample: the closed `@@1` field is consumed by dedicated
iterator dispatch, and `to-primitive-open-object.ts` deliberately says moving
every well-known key to `$Object` would give up that layout. `Symbol.toPrimitive`
has its own value-level companion so open representation survives aliases,
returns, fields, and arrays. Thus existing evidence proves the general writer,
not that every statically resolved Symbol method can safely use the open
producer even for a direct local. A future category matrix must preserve each
static reader before broadening the producer gate; it must include iterator
and ToPrimitive preservation, rather than treating all ids as interchangeable.

The gate must also be scope-safe. Current literal helpers recognize the text
`Symbol.X` without checking whether `Symbol` is locally shadowed. A correct
predicate must ask the checker/oracle whether the particular `Symbol`
identifier has only declaration-file (ambient-global) declarations, analogous
to the existing `isAmbientGlobalIdentifier` helper; a local, parameter,
capture, import, or user declaration must retain ordinary computed-key
evaluation. File-wide spelling checks alone are insufficient. This oracle-based
proof can be asked from the shared literal predicate without relying on a
partially populated function-local map, but needs an explicit source test for
both a local and a module-level shadow before adoption.

That cannot be implemented as a new producer predicate alone. The same
name-only recognition currently appears in `resolveComputedKeyExpression`,
`_hasRuntimeComputedKey`, the data/method Symbol branches of
`compileObjectLiteralWithAccessors`, the disposal predicate, and the separate
`to-primitive-open-object.ts` predicate. If only the new gate became
scope-aware, an already-selected open writer could still box a shadowed
`Symbol.split` as global id 10; if only the writer changed, the closed path
could still turn that dynamic key into a synthetic `@@split` field. A future
implementation needs one shared ambient-global resolver and must make a
shadowed spelling fall through to the ordinary runtime-computed-key lowering.
The ToPrimitive helper has no `CodegenContext` today, so its scope check is a
separate signature/caller review rather than an implicit exception to that
rule. No such refactor is authorized by this audit.

The narrowest candidate remains **not** a generic closed-struct Symbol reader.
It would be a standalone-only, scope-proven producer route that selects the
existing open-object construction before the closed struct is built. The
existing direct local/module/hoisted slot readers
(`statements/variables.ts`, `declarations.ts`, and
`statements/nested-declarations.ts`) already consult
`objectLiteralForcesHostPath`; they require regression proof, not speculative
edits. A value crossing a return, parameter, array/field, or any other
type-led slot still requires the separate value-representation review below.

This remains deliberately smaller than a general value-representation claim.
If the value crosses a return, parameter, array/field, or any other type-led
slot that still resolves it as a closed struct, the #5269 lesson applies: a
producer-only open object can null-cast and be lost. In that case a new,
separately owned type-level companion near `index.ts::resolveWasmType` (not a
reuse of the semantically specific `to-primitive-open-object.ts` name) would
need concrete carrier/IR coordination first. Initial acceptance must therefore
either prove the existing initializer-local lockstep for the chosen narrow
shape or stop before broadening. Required controls are the direct local
supplied/omitted split protocol identity checks, an alias/escape boundary that
either works or is explicitly outside the first slice, and preservation for
closed `[Symbol.iterator]` literals and existing `[Symbol.toPrimitive]`
open-literal behavior. No implementation is authorized by this audit.

### 2026-09-28 raw object return-carrier / static-member handoff

The retained direct-object row is not a `split` coercion-order defect and must
not be fixed by moving `RequireObjectCoercible` after argument evaluation or by
silently applying `ToString` to the returned object. In ordinary JavaScript,
the object has no `.split` property: property lookup and call failure occur
after the receiver, separator, limit, and surplus expressions run. A genuine
nullish member base still throws before those arguments, which the current
staged split boundary correctly preserves.

The measured runtime result is order `1` rather than Node's `1234`. The
source-supported route starts with a statically declared
`receiver(): string` whose erased cast returns an object. `resolveWasmType` in
`src/codegen/index.ts` selects `$AnyString`; `compileReturnStatement` in
`src/codegen/statements/control-flow.ts` supplies that expected return type;
`coerceType` in `src/codegen/type-coercion.ts` guarded-casts the object carrier
to `$AnyString` and yields null; and
`src/codegen/expressions/call-receiver-method.ts` admits the native string
method path from the static type. `compileNativeStringMethodCall` then reaches
the split raw-receiver/ROC boundary with null, so it correctly reports the
wrong *member-base* result before arguments. The value was already lost before
that boundary.

No existing issue owns exactly this path. Adjacent #2576 is complete and covers
opaque externref/`any` native-string guards; #2742 is a separately owned,
generic borrowed-`String.prototype` receiver task that excludes `split` and
`search`; #4096 covers a different closed-static-member miss; and #4121 is
broad numeric carrier work. They are related references, not claims of the
same cause or authorization to edit their code.

Any future fix needs a dedicated issue, an atomic collision/ownership check,
and confirmed clearance for the combined producer/ABI/dispatcher surface
before code changes. It must preserve a native primitive-string fast path while
keeping an object-valued erased return distinguishable long enough for runtime
property lookup and callability to decide the direct call. Likely readers and
mutators include the four files above, return/closure ABI construction, and
shared `$AnyString`/object carrier coercion consumers; that is broader than the
owned standalone split helpers and may be IR-sensitive. No active IR agent was
visible in the local task tree during this audit, but that is not global
ownership clearance. The #4016 fixture keeps this row red and unchanged until
that separate work is planned and owned.

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

## 2026-10-04 Astra: two retained split residuals, source-only diagnostic plan

### Status, provenance, and limits

This appendix is a proposal, not implementation clearance or semantic acceptance.
Planning branch `codex/4016-split-residual-plan` starts at explicit
`fdb116928b5861fd628abfde95da5e3deb91f689`, in its own worktree. The preceding
390 lines are preserved. The actual issue filename is this file, not the
suggested `4016-dedicated-regexp-symbol-dispatch-widening.md`.

Read-only source/evidence donor:
`/Users/thomas/.codex/worktrees/pr-6206-shepherd/js2`, HEAD
`92afa58c6e831cbb8dd184c70100593581865307`, with its existing merged-main and
structural-refactor working changes. HEAD alone does not identify that source.
The retained refactor terminal records production fingerprint
`67125c379cca08da1c1dd7a37963ec7fb4b3c0d1867a034c481a6a99779ad6ad` unchanged
before/after execution. `.tmp/6206-refactor.json` SHA256 is
`ea972e12223a4da94ece638586c979c554ce3b19f48af34c609e243c6cef27fc`.
The actual canonical Node 24.19 run completed 73 PASS / 4 FAIL; terminal exit
1, signal null. This is retained evidence, not an execution by this planner.
Root's matched baseline is 64 PASS / 13 FAIL with all 64 passes retained.
The accepted dependency refactor preserves 73/4; it did not repair these two
semantic residuals. Neither diagnostic is an original Test262 gain.

Frozen 77 manifest `.tmp/6206-fixed-manifest.json` SHA256:
`1b87e586a3f25a5d1ba44ca82beca20493d3a1621460e1199d287593caf9b652`.
The unchanged 47-case fixture is
`tests/issue-4016-standalone-search-value-tostring.test.ts`, SHA256
`92bd8d30a494c17e6d1e04c07c0498a51a61311a619303a48c1f5f2c7fc46efc`.
Two of its four failures (assertions at lines 179 and 190) demand obsolete
compile refusals and already fail main. Preserve them and their expectations;
this task neither removes them nor calls a 75/2 result green publication.

No compiler/provider build, compile, runtime execution, fixture edit, claim
mutation, source edit, dependency change, or publication occurred in this task.
The native P1 worker owns the heavy lease. No GitHub polling was performed.

### D: direct ordinary-object receiver, expected 1234, actual 1

The exact fixture at lines 211–235 returns an ordinary object from a nested
function declared `receiver(): string` using `as unknown as string`. The
object has `@@toPrimitive`, but no `.split`. The four operand functions append
digits 1, 2, 3, 4; the receiver conversion would append 5, limit conversion 6,
separator conversion 7. Its catch returns `order` only for TypeError. Actual 1
therefore proves a TypeError was caught after the first recorded effect, not
that ordinary method lookup or any particular conversion caused that throw.

The contract is ordinary call evaluation, not borrowed String split:
evaluate receiver once; Get its current `split` once; evaluate all arguments
left-to-right; reject a missing/noncallable method only then. Genuine nullish
member bases and throwing property getters fail before argument evaluation.
An argument throw wins over the later noncallability error. Do not turn this
into `String.prototype.split.call(receiver, ...)` or ToString(receiver).
This ordering follows [ES2015 EvaluateCall/EvaluateDirectCall](https://262.ecma-international.org/6.0/#sec-evaluatecall)
and [argument evaluation](https://262.ecma-international.org/6.0/#sec-argument-lists-runtime-semantics-argumentlistevaluation).

Source-supported first-loss hypothesis D1 (not yet WAT-confirmed):

- `statements/nested-declarations.ts` lines 1508–1545 chooses the physical
  nested-function return type from its signature through `resolveWasmType`.
- `expressions.ts` lines 1535–1555 erases assertions but passes the expected
  type through. Type erasure here does not prove value preservation across ABI.
- `statements/control-flow.ts::compileReturnStatement` lines 551–554 supplies
  `fctx.returnType`; `normalizeReturnExpression` lines 174–195 applies
  `coerceType` when the natural value differs from that physical result.
- `type-coercion.ts::coerceType` lines 2677–2745 and 2798–2818 contain the
  differing-struct guarded casts, including nullable destinations that can
  answer null instead of preserving the ordinary-object reference. These
  source arms are candidates, not proof of the exact selected arm here.
- `expressions/call-receiver-method.ts` lines 3350–3436 admits the statically
  string-typed receiver into `compileNativeStringMethodCall`; its raw receiver
  callback is defined at `string-ops.ts` lines 2755–2756. The protocol probe in
  `string-symbol-protocol.ts` lines 198–236 declines non-re-evaluable call
  receivers/search expressions, as these operands are.
- `string-search-value.ts::tryCompileStandaloneSplitSeparator` stages the
  receiver at 594–595, then emits RequireObjectCoercible at 596–601, before
  argument staging at 604–615. `string-proto-split.ts` lines 294–304 emits that
  nullish guard. If the producer already replaced the object with null, this
  consumer correctly rejects the wrong value early. Moving its guard after
  arguments would hide the producer loss and break real-nullish calls.

D2 is distinct: if WAT proves the object survives to the call boundary, the
statically selected intrinsic lane does not itself Get `receiver.split`.
It can therefore bypass ordinary Get/callee semantics. A runtime string brand
alone is not permission to coerce a non-string receiver, synthesize a missing
method, or return the guarded string dispatcher's benign sentinel. D1 and D2
can coexist; repairing only the first does not establish the complete call.

Conditional implementation contract, after first-loss proof and clearance:

1. If D1 is confirmed, preserve the real object through the function's physical
   result ABI, then make reservation, body, direct caller, and closure caller
   agree on that carrier. Identify the declaration-owned return fact and its
   existing reservation consumers before proposing exact edits. Merely changing
   `normalizeReturnExpression` cannot return externref into a string-ref
   signature. No generic string coercion/global ABI widening is authorized.
2. At the actual direct-call admission seam, a value not proven to be the
   current intrinsic must use current ordinary Get with the saved receiver.
   Save its returned callee before argument effects, stage all raw arguments
   once, then check/call that saved value with the original receiver as `this`.
   A getter that changes the property during arguments must not be re-read.
   User methods keep arbitrary return values, not forced string-vector results.
3. Keep the native intrinsic branch only on a valid intrinsic/receiver contract;
   preserve existing limit-before-separator conversion and surplus effects.
   Do not widen `compileGuardedNativeStringMethodCall` across all string methods
   as a split workaround. If the existing ordinary route cannot honor Get before
   args, stop and name that additional consumer; do not silently adopt it.

### H: host Symbol callback, expected 1, actual normal 0

The exact fixture at lines 417–440 calls native-strings host split with
`void Date.now()` separator and a concrete object whose
`[Symbol.toPrimitive](hint: string)` increments captured `calls`, checks the
numeric hint, and returns a captured undescribed Symbol. Its try returns 0
after split; its catch returns 1 for exactly one correctly hinted callback,
otherwise 2. Thus observed 0 means the split call returned normally. It does
NOT expose callback count/hint and cannot prove zero callbacks.
The bare Symbol fixture at lines 405–415 throws a host-visible TypeError and
passes; Symbol construction itself also has a passing independent control.

Concrete source path and competing, falsifiable hypotheses:

- `string-search-value.ts` lines 588–622 prepares helpers before effects,
  stages receiver/separator/limit, and recaptures live providers afterwards.
  Lines 632–640 use `emitHostStagedSplitLimitFromExternref` for the proven
  undefined separator. No limit AST replay is needed or acceptable.
- `helpers/string-split-coercion.ts::emitHostStagedSplitLimitFromExternref`
  tests exact undefined, otherwise emits ToPrimitive(number), ToNumber, exact
  ToUint32. `coercion-engine.ts` lines 128–169 registers the real host hint
  global and resolves `__to_primitive`/`__unbox_number` from current handles.
  Preserve these late-import/index invariants; no evidence currently implicates
  the accepted callback-injection architecture or exact ToUint32 algorithm.
- `runtime.ts` lines 13906–13912 delegates the host import to
  `_hostToPrimitive`; that walker (4203 onward) checks real property, sidecar,
  then Wasm method export `__call_@@toPrimitive`, then struct closure-field and
  ordinary valueOf/toString fallbacks. The real reached representation matters.
- H1: `index.ts::emitToPrimitiveMethodExport` lines 9156–9162 explicitly skips
  any entry whose declared hint parameter is not externref. A native-string
  `hint: string` can therefore be omitted. If another entry creates the export,
  the dispatch miss returns `ref.null.extern` (9188), which `_hostToPrimitive`
  accepts as primitive (4313–4316), and ToNumber turns into zero. If the export
  is absent, the walker instead continues through its remaining probes. Which
  case occurs here requires the actual module's exports and dispatch ladder.
- H2: if the method is reached, the export's lines 9204–9215 box every i32
  result through `__box_number`, ignoring Symbol/boolean metadata. A symbol ID
  returned as a number is accepted by host ToNumber and causes normal return.
  Inspect the actual method/result type and callback wrapper before claiming
  this is reached. `symbol-field-carrier.ts::symbolBoundaryCoercionInstrs`
  lines 70–77 already expresses branded i32 -> host Symbol through
  `__box_symbol`; that is a reusable contract, not authority to edit the module.
- H3: a missing method/field producer or wrong captured environment could make
  neither intended callback route available. Inspect the concrete closure field,
  registration key, callable body, and capture parameters. Do not invent a
  sidecar or substitute an unrelated same-shape/name method to obtain a pass.
- H4: inspect the emitted exact-undefined branch and live import indices. If
  an object is classified as undefined or the provider index is wrong, H1/H2
  are not first loss. The passing late-import control does not exclude a
  case-specific shift. Record evidence, do not reintroduce cached raw indices.

`runtime/host-async-imports.ts::createHostNumberUnboxImport` lines 77–112
ultimately applies host Number to the primitive; a genuine Symbol throws.
This narrows the question to the value reaching it, not a demand for another
split-specific Symbol-shaped rejection. Do not trust its adjacent broad BigInt
comment as a new task or change that separate contract.

Conditional implementation contract: repair the proven ToPrimitive producer /
export boundary, not the split limit algorithm. A real native-string hint needs
an existing host-string-to-native conversion before calling the typed method;
do not feed host externref directly to a native-ref parameter or drop the hint.
Preserve concrete receiver/capture identity and per-instance callable state.
Normalize the actual return with semantic Symbol/boolean metadata, not plain
i32 numeric boxing; carry native/host strings, null, undefined, objects, and
abrupt completions honestly. Reserve all converters/boxers before capturing
function indices, then resolve current handles. An absent method must remain
distinct from a present method returning null. Do not globally change exported
dispatcher miss semantics without auditing all its readers. Exact source scope
must be chosen from the four-module evidence below, not all hypotheses at once.

### Ownership intersections: positive evidence, not source clearance

The root retains the delegated `4016:pr-6206-shepherd` production leaf; this
planner owns only this append. A local assignment-tree read at
`b08e3f94fb3715634d074383f5a3f2aaae739c59` is a dated snapshot, not a fresh
server predispatch check. It records 3481 (opus-3481, write10507-bejvnko7),
4406 (opus-4406, write10455-jvv8gdrd), 5374 (dev-5374,
write3356-6whu869a), 4637 (claude-es5-standalone, write21722-b4gyvn3s),
6651 (project-thread-yhj9pp, write11530-bzpj3qae), and 6775 (opus-6775,
write1573-liurq9bq) still in progress. Historical done MD5374 does not release
its held record. Bare4016 done and 1917 released do not grant broad successors.
Held `3518:export-marshalling` and `3518:native-string-value-abi-planning`
are additional ABI adjacency, not assignments this planner can borrow.

MD3481 positively reserves Symbol coercion, index wiring, type-coercion, and
host ToPrimitive work; MD4406 specifically owns return normalization / boxed
ABI consumers. MD5374 concerns module ownership in the actual host walker.
Any proposed change in those exact protocols needs owner adjudication even
when unrelated IR implementation on another machine is explicitly cleared.

Retained fully paginated 16-PR path inventory in the R2-A donor
`.tmp/6835-r2-a/open-pr-inventory.json` identifies these positive overlaps:
6468: index, nested-declarations, expressions, control-flow, type-coercion,
call-receiver-method, string-ops; 6341: index/expressions; 5784:
index/expressions/nested-declarations; 5753: those plus type-coercion,
call-receiver-method, symbol-field-carrier; 5748: index/coercion-engine/runtime;
5911: runtime. PR6206 itself owns the split/coercion integration paths.
These path intersections are not exact-function conflicts or absence proofs.
The inventory retains no selected patch for the newly implicated exact bodies.
Root confirmed no fully reviewed local hunk receipt and instructed that they
remain HELD/unadjudicated. No further GH poll or claim mutation is needed for
this documentation; before implementation, inspect exact current patches and
ask for a named function-level carve-out. No source GO is implied here.

### Finite next diagnostic: four original source strings, no adaptive expansion

After separate root approval and the heavy lease becomes available, collect
exactly these four unchanged strings from the frozen fixture using TypeScript
template-literal text, retaining whitespace/comments/annotations. SHA256s below
were computed read-only from its cooked `src` literal, not a rewritten probe:

1. D-object, fixture line211, target standalone, export f, expected 1234:
   `722768e1c25652ff613f821b48db40ded30101226b0d673525d5563b525cf66b`.
2. D-primitive, line238, target standalone, export f, expected 1234672:
   `b3631deb609d48c4f5d26e13ed456a76d8e1d343e9c8bfd368264c3060b1967f`.
3. H-callback, line417, nativeStrings true with normal host runtime, export f,
   expected 1:
   `9341bb96f2a63aac005af0b3082ff697a82859e8e827f96d86e124877c7615d4`.
4. H-bare, line405, same host lane, export f, expected escaping host TypeError:
   `6131e3b910481a9c44019b396b3ba8d02199ab6668693e7f0fdb6467f12fe0e0`.

Do not add `: any` to receiver/limit, remove the `hint: string` annotation,
change assertion boundaries, inject counters, add exports, monkeypatch host
imports, or replace method shorthand with a field closure. Those alter the
producer/carrier path. Compile-only/WAT observation and existing export lists
are enough for this first bounded attribution step; no provider rebuild.

Each artifact receipt must bind exact source hash, complete source fingerprint,
compiler options, canonical Node24 executable/version, binary/WAT hashes,
actual import/export list, compile/validate/instantiate/export-call result,
thrown category, terminal exit/signal, and pre/post production identity.
Standalone imports must stay empty. Host instantiation must reproduce the
fixture's buildImports + instantiateWasm + setInstance lifecycle unchanged.
Do not report collector exit0 as four test passes. If donor bytes differ from
the retained refactor fingerprint, stop and obtain a matched checkpoint first.

For D, map receiver declaration's actual result signature and complete return
tail; identify any object-to-null conversion before the call. Then map f's
receiver call, current method Get (or its absence), guard, all three argument
calls, callable check, and catch. Pair every claim with exact WAT indices and
source emitters. Compare D-primitive's same boundaries. If D-object reaches a
different source arm than hypothesized, report that first loss and stop.

For H, list whether `__call_@@toPrimitive`, `__sget_@@toPrimitive`, and relevant
closure dispatch exports exist; decode the exact limit shape/capture closure,
hint parameter and result carrier; inspect matching and miss arms. Resolve the
actual host hint global and imported helper indices after Date.now staging.
Follow the returned primitive into ToNumber, comparing H-bare's Symbol boxing
path. A normal0 only proves no caught abrupt completion. Static reachability
does not establish callback execution/count: if these four unmodified modules
cannot distinguish hypotheses, report that precise remaining observation need
to root; do not invent a fifth source or a production patch while collecting.

### Acceptance and stop boundary for a later, separately cleared repair

Root must read this complete append and the four-source receipts before any
implementation dispatch. The diagnostic run stops after its four fixed cases,
even if inconclusive. An implementation proposal must identify its proven
first-loss hunk, every physical ABI reader it changes, owner carve-out, and
normal static-gate cost before source GO. Neither ABI rewrite is preapproved.

Preserve all 73 current passes and the complete frozen 77 identities/expectations
in a matched rerun after any authorized repair. Require D-object1234,
D-primitive1234672, H-callback1, H-bare TypeError; keep the two stale refusal
reds visible and separately adjudicated, not weakened. No original gains are
claimed without unchanged original Test262 measurements.

Before production semantic acceptance, root must approve a separate supplemental
manifest covering null/undefined base before arguments, throwing getter before
arguments, absent/noncallable method after arguments, argument abrupt precedence,
getter once with mutation during arguments, own/inherited callable and arbitrary
return identity; and host hint exactness, Symbol/boolean/number/null/undefined /
object results, callback abruptness, same-shape distinct captures, and ordinary
valueOf fallback. Those are contracts, not newly executed tests in this task.
Keep standalone/host boundary controls, late registration, and closure identity.
No gate exemption, oracle edit, refusal removal, generic coercion workaround,
runtime miss-status rewrite, or expanded source ownership is authorized.

## 2026-10-04 one-shot owned-PR shepherd audit (20:42 UTC)

Root requested a read-only publication handoff for six owned open PRs. This
appendix records their server snapshot, not a watch, merge authorization or
semantic-completion claim. No PR, review, check, claim or source was mutated;
no fetch, merge, build or runtime execution occurred. The separate P2 Script
plan remains frozen. Preserve this MD's preceding 676 lines (SHA256
`1bc2c65b27726c94322010ad678bca1c603266792224d0152d22ec0dd117af88`).

### Provenance and current integration base

The initial sandbox API read failed to connect and supplied no state. A single
network-enabled GraphQL snapshot then read all six PR heads/bases, merge state,
draft/hold state and review threads. Every review connection reported
`totalCount=0`, `hasNextPage=false`: zero unresolved inline review threads for
each PR, not an approval or proof of no issue-level discussion. ReviewDecision
was null for all six. Each required-check list was read once with
`gh pr checks --required`; completed failing job details and logs were read,
with truncated log tails retrieved as content, not repeated status polling.

Actual server `refs/heads/main` at this snapshot:
`1787b1af4a2f010f51ca1f45fc68fa540bfa4673`.
Server compare from validated `fdb116928b5861fd628abfde95da5e3deb91f689`
reported ahead2/behind0, merge-base=fdb, two commits: npm-compat refresh
`6ad7760e71342f4270f899f564cd962b4d06f0a9` and PR6474 merge1787b1af.
Exactly six files changed: `npm-compat-history.json`, `npm-compat-perf.json`,
`npm-compat.json` under both `benchmarks/results/` and its website/public mirror.
No compiler, provider, test or workflow source delta in that comparison.
The distinct PR `baseRefOid` values below are returned PR metadata, NOT current
main; none was silently substituted for the server tip. Publication still
requires current integration and normal gates under its actual owner.

### Required-check interpretation used for every PR

All six returned the required names `quality`, `equivalence-gate`, `cla-check`,
`cheap gate (main-ancestor + lint)`, `merge shard reports`, and
`check for test262 regressions`. Five PRs returned ten rows: six non-skipped
workflow jobs, three SKIPPED same-name PR-stub jobs, and a duplicate successful
legacy CLA status with no job URL. Skipped rows and duplicate CLA status were
not counted as additional verification. PR6435 instead has seven rows: six
SUCCESS workflow jobs plus legacy CLA; three of those jobs ARE the PR-stub
workflow, so non-skipped still does not mean actual conformance execution.

For5883/6206/6234/6246/6436 the actual Test262 Sharded cheap/report/regression
jobs all returned SUCCESS; equivalence and CLA jobs also SUCCESS. Their PR-level
report/regression success is not a measured merge-group Test262 sweep. Quality
is SUCCESS only on5883 and6435 and FAILURE on the other four. No returned
required context is pending. Failed quality steps leave downstream steps
SKIPPED, not implicitly passed. Exact failed-job head_sha matched each PR head.

### Per-PR actionable handoff

**[PR5883 — fix(promise): preserve observable intrinsic combinator protocol](https://github.com/loopdive/js2/pull/5883)**

- Head `6f73c8edd15a2fb88f3f7c34166ec5ce0337ae80`, branch
  `codex/5197-promise-observable-r3-2-20260913`; base metadata
  `2b8101b9bc9a1910ce32a26e5b74e8a503f5b471` (`main`). OPEN, not draft,
  `hold` present, CONFLICTING/DIRTY, zero review threads.
- Six actual required workflow jobs SUCCESS. [Quality job](https://github.com/loopdive/js2/actions/runs/36997490120/job/110807440554)
  matches this head and its lint/format/typecheck, changed-root tests, required
  guards and conformance-number steps all succeeded. Cheap/report/regression
  jobs in run36997490192 are110807442225/110807478495/110807478544.
- Blockers are the explicit hold and merge conflict despite green historical
  head CI. Coordinate with the existing Promise owner before resolving/rebasing;
  no inference that author is finished and no permission to remove the hold.

**[PR6206 — fix(string): stage standalone split coercion before conversion](https://github.com/loopdive/js2/pull/6206)**

- Head `92afa58c6e831cbb8dd184c70100593581865307`, branch
  `codex/4016-resume-20260927`; base metadata
  `aca46e64cded68942686f67a52c38bb1d3c358ab`. OPEN draft,
  CONFLICTING/DIRTY, no hold, zero review threads.
- [Quality job](https://github.com/loopdive/js2/actions/runs/36367765816/job/108757496910)
  failed `Changed root test files must pass`: published fixture47 has42 PASS,
  5 FAIL. Two refusal pins expected false/received true; direct-object call
  expected1234/received1; host Symbol-returning conversion expected1/received0;
  descriptor-before-split threw `Cannot convert object to primitive value` at
  `_normalizeDescKey`. Required guard and later steps were skipped. Other five
  required jobs passed (cheap/report/regression run36367765431,
  jobs108757495884/108757515806/108757515864).
- The newer local merged/refactored candidate73P4F/77 is NOT this published CI
  result. Preserve its four reds and all73 positives; the preceding appendix's
  four-source diagnosis is still required. Existing split shepherd owns that
  integration; don't create a duplicate repair, weaken refusal tests, or mark
  ready just because the architecture-only refactor passed locally.

**[PR6234 — fix(codegen): normalize direct Map.get equality results](https://github.com/loopdive/js2/pull/6234)**

- Head `9bb4f293940e0029dff22ad1d224febde903d424`, branch
  `codex/3585-map-result-equality`; base metadata
  `3eb7ae5da3951641b97c1af2e9fc27a0c7c41435`. OPEN draft,
  MERGEABLE/BEHIND, no hold, zero review threads.
- [Quality job](https://github.com/loopdive/js2/actions/runs/36387719119/job/108816556863)
  failed changed-root tests:7 PASS/3 FAIL of10. Object/nullish controls returned
  2 vs3, mixed results687 vs1023, missing/undefined/null42 vs63. Required guard
  and later steps skipped. Other five required jobs passed;
  cheap/report/regression run36387719020 jobs108816557621/108816583986/108816583922.
- Continue the already assigned narrow Map observation repair and matched
  preservation gates, then integrate current main under the owner. Published
  three reds remain until new measured head; no credit for four unrelated
  frozen Map originals and no broad binary-ops/storage rewrite permission.

**[PR6246 — fix(eval): stage arguments before runtime snapshot](https://github.com/loopdive/js2/pull/6246)**

- Head `49e6fe14795de20020c2c68901cf184ef308a325`, branch
  `codex/5157-eval-spread-arguments`; base metadata
  `9187cce7452e3fec5845d09b118c98164e899dde`. OPEN draft,
  CONFLICTING/DIRTY, no hold, zero review threads.
- [Quality job](https://github.com/loopdive/js2/actions/runs/36974562907/job/110735479296)
  failed `CLAUDE.md names only paths and CLI flags that exist` at line676:
  `.claude/ci-status/pr-<N>.json` directory absent, plus missing
  `ci-status-feed.yml`, `ci-status-basic.yml`, `ci-status-pending.yml`.
  Four dangling references; changed-root tests and required guards were NOT
  reached. Other five required jobs passed; cheap/report/regression
  run36974562938 jobs110735480428/110735503880/110735503917.
- Existing shepherd must retain the approved M1 argument/cache/late-binding
  semantic merge and dependency-cycle repair. This remote failure is old docs,
  not proof current merged source passes tests or M2 direct-spread semantics.
  Resolve integration with current maintained docs, not a gate exemption or
  four historical annotations used to evade a still-active protocol fix.

**[PR6435 — fix(ci): execute native eval guards with a full provider](https://github.com/loopdive/js2/pull/6435)**

- Head `16120f29f62e5748f8d9fec795695fca302a4a8a`, branch
  `codex/es6-native-eval-ci`; base metadata
  `ff310447e51b6443c5a3c34c62bd80f38c64269e`. OPEN draft,
  MERGEABLE/CLEAN, no hold, zero review threads.
- [Quality job](https://github.com/loopdive/js2/actions/runs/37033068204/job/110924447677)
  matches head, SUCCESS including changed-root tests and required guards;
  equivalence110925681991 and CLA110924433538 SUCCESS. Cheap/report/regression
  are SUCCESS jobs110924566085/110924566422/110924566201 in
  run37033068390, explicitly **Test262 PR stub**. No real Test262 sweep is
  established by those three green contexts.
- Closest mechanical candidate, but still draft and not declared ready by this
  audit. Owner must confirm completion and full-provider evidence, then make
  the explicit ready/publication decision; workflow-touching queue permissions
  and current-main integration remain the shepherd's checks. Do not toggle draft.

**[PR6436 — feat(intl): add locale canonicalization kernel](https://github.com/loopdive/js2/pull/6436)**

- Head `77711ef957faa069f35acc55d6d3c0a2a64ecc02`, branch
  `codex/6809-intl-locale-canonicalization`; base metadata
  `7c8edb29224f7497bc2be8544dfabc166f4dd63d`. OPEN, not draft,
  MERGEABLE/BEHIND, no hold, zero review threads.
- [Quality job](https://github.com/loopdive/js2/actions/runs/37224664939/job/111501740327)
  failed `src/codegen flat-directory budget`:829→830 (+1). Import-cycle and
  preceding lint/type/format passed; every later architecture/test/guard step
  was skipped. Other five required jobs passed; cheap/report/regression
  run37224664953 jobs111501740965/111501765389/111501765545.
- Exact next repair is owner-approved file placement/import reconciliation,
  not changing the budget. The positive6809 owner claim remains held pending
  explicit clearance; this audit does not supply it. Later semantic gates still
  need execution on the repaired current head, not extrapolation from step15.

No PR in this six-item snapshot is certified ready for publication by this
audit. Root/assigned shepherd retains follow-up ownership; there is no watcher,
scheduled recheck, rerun, comment, review resolution or external write here.


## 2026-10-30 current-main source-only reconciliation

This successor composes the whole original 17-path scope onto receiving main
`2f28f6b89a1f3d661cda5faf0750226e2b7384e9`. The historical observations and
original 47-case body above remain unchanged; 42/47 was an old observation,
not a result for this composition. Current formatter, typing and runtime
qualification have not run.

The accepted WasmGC semantic-provider regime is now native-first (#6979).
The staged split lowering therefore retains its native provider path and removes
only the obsolete, unselectable host-assisted alternative and its private helper
plumbing. Existing native staging remains receiver, separator, limit, trailing
arguments, followed by receiver ToString, limit ToUint32, separator ToString;
providers are reserved before operand evaluation and mutable handles recaptured
after staging. No host fallback, provider spelling cast or lane flag is added.
The controls historically labelled host still compile with their original
`{ nativeStrings: true }` input and retain all original values and effects;
their names do not prove that a retired semantic profile is being selected.

The direct-object return-carrier boundary, the no-description Symbol limit
callback boundary and descriptor-before-split boundary remain current-runtime
questions. This source adaptation does not claim to fix them. The two historical
compile-refusal controls remain literal here pending genuine current whole-file
observation and source-supported positive protocol successors; they are not
waived, skipped or counted as expected failures.


## 2026-11-05 current native-boundary repair and control successors

The receiving source epoch for this work is `d9b796abc74c02d5984f218ef4bc4aa548e5a7e1`,
with the original `92afa58c6e831cbb8dd184c70100593581865307` authored ancestry
preserved by the pending normal merge. All earlier measurements and source-only
statements above remain historical; none is transferred to this repaired tree.

The first current whole-three-file run was 88 passing / 6 failing of 94, with
all 31 incoming string-field controls passing. The real raw receiver program
returned 1 instead of Node's 1234. A stronger independent Symbol.split witness
returned an exception instead of Node's 131; a length-one result from either old
protocol program alone was not evidence that its method ran. Eight of ten new
metadata observers also returned 0 instead of Node's 1. All of these failed
runs and unchanged guest programs remain retained evidence, without expected
failure annotations or skip credit.

The bounded source repairs preserve captured const open-object identity at the
actual hoisted FunctionDeclaration return ABI and its Phase-0 reservation, using
the same exact declaration/initializer certificate as other callable boundaries.
The direct split arm gets the actual non-string receiver member before arguments,
then checks the maintained callable predicate after every argument effect and
calls with the original receiver. Borrowed intrinsic calls retain their existing
receiver-conversion semantics. The evaluated computed method key is converted
once before method creation; only the fresh method receives its real public name.
The descriptor-input word is 0xBC (value present, all attributes specified), while
the resulting public name attributes remain writable=false, enumerable=false,
configurable=true, i.e. attribute word 0x04. No shared declaration metadata or
runtime-wide protocol algorithm is changed by these corrections.

The composed isolated source tree `535ddee6520be1a51d266f25a2f86427602300f3`
produced an actual 14/14 passing standalone observation run: all ten metadata
programs returned Node-matching 1, the original raw receiver returned 1234,
and the stronger protocol witness returned 131 with the actual call count,
subject, limit, result length, returned element and no-ToString checks intact.
The original two protocol programs also returned their Node-matching 1. This is
bounded observation evidence, not a passing whole-original-94 result, an IR
ownership claim, a provider-build claim or a protected conformance-floor result.

The two former route-only refusal assertions are replaced by semantic successors
using their EXACT original guest bytes, positive Node results and actual native
execution without host imports. Their historical assertions are preserved below;
they are not converted to `it.fails`, skipped, deleted from history, or counted as
current PASS. The stronger 131 witness and all ten public-name/descriptor
observers are now permanent regression controls. The prospective whole-three-file
population is 105 (original 94, with two faithful named successors, plus 11 new
controls); actual collection and the full normal gates still must establish it.
The remaining original values, effects, call order and assertions stay unchanged.

### Historical split compile-refusal pins (superseded, not current assertions)

```typescript
  const refusal = /with a RegExp or symbol-protocol search value is not supported/;

  it("still refuses a search value that could carry @@split", async () => {
    // An `any` whose operand is also unprovable cannot be shown free of
    // `[Symbol.split]`, so the spec's protocol dispatch might apply. Refusing
    // loudly beats guessing.
    const r = await compile(
      `export function f(): number { const sep: any = JSON.parse("1"); return "abc".split(sep).length; }`,
      { target: "standalone" },
    );
    expect(r.success && r.errors.every((e) => !refusal.test(e.message))).toBe(false);
  });

  it("still refuses an explicit @@split implementor", async () => {
    const r = await compile(
      `export function f(): number {
         const sep = { [Symbol.split](s: string) { return ["x"]; } };
         return "abc".split(sep as any).length;
       }`,
      { target: "standalone" },
    );
    expect(r.success && r.errors.every((e) => !refusal.test(e.message))).toBe(false);
  });

```

Current source typing, import-cycle and architecture gates, normal formatter/lint,
whole-105 runtime qualification, normal commit/push hooks, latest-main composition
and protected required checks remain pending for this test successor. No baseline,
function/LOC allowance, timeout, heap, provider or test-floor exception is granted
by this note. All original guests and the author history remain reviewable.


### 2026-11-05 CI repair: shared split-coercion subsystem location

The published CI run 41978354355 rejected the new top-level
`src/codegen/string-split-coercion.ts` under the flat-directory budget
(838 to 839 files). Move this existing shared implementation into
`src/codegen/helpers/string-split-coercion.ts`, preserving the implementation,
exports, two consumers and boundary classification. Only relative import paths
change. The earlier source location and qualification records remain historical.
No flat-directory baseline or allowance is changed. The two equivalence failures
from the same run remain separate repair obligations until their actual errors
are captured and the batched receiving tree is qualified.


### 2026-11-05 measured native-owner disposition after CI repair

The actual change-scoped standalone-arm gate on the formatted receiving tree
reported net growth of six `ctx.standalone` lines and three `ctx.wasi` lines
across exactly the five paths above. These reviewed operation boundaries keep
their existing physical native-provider contracts: ordinary Symbol method
invocation, reflective split argument evaluation, shared limit conversion,
fresh method metadata, and live Symbol-binding reads. No token spelling or
wrapper alias is substituted, and no main-owned baseline is changed. The shared
limit implementation now lives under the existing `helpers/` subsystem.

The unchanged pre-repair two whole fixtures reproduced the two CI failures
(53 pass, 2 fail): the Symbol.iterator method returned NaN instead of 42, and
the WASI static initializer trapped when reading a missing class name as a
string. Their complete errors and emitted artifacts remain retained. The
reviewed repair preserves the ordinary method result and admits the old class
name route only for an exact fresh, effect-free initializer with no own name
override. The original 160 test inputs and six separate adverse observations
remain unqualified until the remaining gates and genuine runtime run complete.

## 2026-11-05 class-value name metadata owner disposition

The current CI repair's live name reads exposed a missing native constructor
name value, which changed the inherited-static-method observation from main's
wrong value `4` (Node `6`) into a null trap. The bounded owner seeds only a
fresh class singleton's canonical `name` data descriptor with input flags
`0xBC`; public writable/enumerable/configurable remain false/false/true.
Own declaration and installed-key records protect actual name owners, and
runtime-keyed members use already-evaluated keys without repeated conversion.
This does not correct the separate existing inherited static receiver ABI.

The actual formatted-source quality attempt passed normal formatting, Biome
lint, flat-directory, LOC, function, oracle and coercion gates, then failed the
standalone-arm ratchet solely on `expressions/extern.ts`: `noJsHost` grew
from 1 to 2, +1 net. The own-issue path disposition above records that measured
native operation owner. No shared baseline, predicate spelling, test assertion
or execution limit changes. Typing, cycles, inventory and all 174 prospective
rows were not run in that stopped invocation; the earlier original 160 PASS
and all adverse failures remain separate historical observations. The original
160 and six adverse guests/assertions are unchanged; eight focused metadata
observations are additional diagnostics, with no assumed passing outcome.
