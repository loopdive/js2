---
id: 5199
title: "ES2015 standalone generators — r2 residual pass"
status: in-progress
sprint: current
created: 2026-08-29
updated: 2026-09-13
priority: medium
horizon: m
feasibility: hard
reasoning_effort: max
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude/fable-es2015
assignee: ttraenkler/codex-5199-generator-payload-20260913
loc-budget-allow:
  - src/codegen/array-object-proto.ts
  - src/codegen/closures.ts
  - src/codegen/context/types.ts
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/expressions/object-get-prototype-of.ts
  - src/codegen/generators-native-consumer.ts
  - src/codegen/generators-native.ts
  - src/codegen/instance-props.ts
  - src/codegen/iter-hof-native.ts
  - src/codegen/iterator-native.ts
  - src/codegen/object-runtime-prototype.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/proto-function-value.ts
  - src/codegen/statements/nested-declarations.ts
  - src/codegen/statements/variables.ts
func-budget-allow:
  - src/codegen/expressions/object-get-prototype-of.ts::tryCompileEs5GetPrototypeOfEarly
  - src/codegen/generators-native-consumer.ts::tryCompileNativeGeneratorResultProperty
  - src/codegen/generators-native-consumer.ts::tryCompileNativeGeneratorMethodCall
  - src/codegen/generators-native.ts::buildNativeGeneratorPlan
  - src/codegen/generators-native.ts::compileState
  - src/codegen/generators-native.ts::ensureNativeGeneratorResumeFunction
  - src/codegen/generators-native.ts::registerNativeGenerator
  - src/codegen/iter-hof-native.ts::fillIterHofSteppers
  - src/codegen/iterator-native.ts::buildIteratorNextBody
  - src/codegen/iterator-native.ts::fillNativeIteratorLateArms
  - src/codegen/object-runtime-prototype.ts::buildObjectPrototypeHelpers
  - src/codegen/property-access-dispatch.ts::tryIdentifierNamespaceAndStaticReceiverRead
  - src/codegen/closures/funcref-as-closure.ts::emitFuncRefAsClosure
  - src/codegen/statements/nested-declarations.ts::compileNestedFunctionDeclarationInScope
  - src/codegen/statements/variables.ts::compileVariableStatement
---

# #5199 — generators r2: cluster and fix the residual generator-bucket failures

## Problem

State after the 2026-08-29 session: wave 1 (#5141, part of PR #5179 — includes
the root-cause fix of the #5060 standalone generator-resume trap: V8 12.4 runs
a result-typed `try_table` as `unreachable`; the resume wrapper now trampolines
in a `block (result R)` under an empty-typed `buildTargetTaggedTry`) plus a
second pass (+25, PR #5213). Residual count on current main not re-measured;
the wave-8 planning pass was stopped.

Adjacent recorded defect: yield-star throw delegation has its own held draft
(PR #5063, pre-session) — check its state before clustering that area.

## Implementation Plan

Planning pass required before implementation (plan/implement split).

- Step 0 — regenerate the generators residual list
  (`language/statements/generators/**`, `language/expressions/generators/**`,
  `built-ins/GeneratorPrototype/**`) on current main via the standalone probe
  (see #5194 step 0 for probe shape and the `.test262-cache` caveat).
- Step 1 — cluster by error signature; write the cluster table into this
  file.
- Step 2 — implement per cluster; re-probe; spot-checks stay green.
- Step 3 — five ratchet gates + equivalence gate.

## Acceptance criteria

- Cluster table with measured counts in this file before implementation.
- Measurable net gain on the regenerated list; no spot-check or equivalence
  regressions.

## References

- #5141 (wave-1 plan), PRs #5179, #5213; #5060 (resume-trap root cause).

## 2026-09-12 generator protocol rescue checkpoint

### Provenance, ownership, and bounded scope

This implementation is a manual, generator-only port from the second commit of
the stale mixed draft PR #5736 (`b3a21dfcd1fc28c13a9f2ef168a8114deee347b0`),
reviewed relative to `357b05f68c8c76b8c4888690941edf9d247243ab`. It starts from
fresh main `d4108568d43f14c361ecc3a58c82633027eaae39` in the isolated branch
`codex/5199-generator-protocol-rescue-20260912`. It was normally merged,
never rebased, through `c645a7627e099173b0b3e0c5daa1d7b5a110a9d5`, then the
#3518 frame-engine integration at `7c8069cb0770e67014a8df4f42af48bbb7fb5736`,
and finally current main
`cbeffc55aaf12cd26a52fcae811d2efa224c4dce`.

After the first PR publication, upstream advanced through #5849 at
`d03c2248002723c01c412ec48c3b585851e38bd0` and, on the required fresh fetch,
to `ffb338c45b9ce26c0b430a7345f498c403d35441`. The latter contains only
post-d03 #5341 documentation and npm-compat artifacts, while #5849 changes
other compiler/runtime surfaces. Both were normally merged without conflict at
`66c44d6470fb6b73624ab9f5fc06915dd00f241e`; no rebase or force update was
used.

The merge queue subsequently advanced main to
`b433de9ffe4e0c165fe65ff9d4a20bc91854cc1d` (#5756) and automatically merged
that into the published fork branch at
`95b55dbe2387915d54b93228c2bd8d949ce4bf4a`. The locally completed checkpoint
was reconciled with that bot merge normally at
`22181e55b23e807256c59bc146beafa55c5e973e`; no remote history was overwritten.

The port intentionally excludes the stale PR's super and TypedArray hunks. It
does not modify the TypedArray lane's `ta-dyn-mop.ts`, `native-proto.ts`, or
`proto-index-store.ts`. The only shared surfaces are ordinary prototype/object
plumbing, isolated to native-generator state branches. `context/types.ts` and
`statements/nested-declarations.ts` overlap #5683 at integration time; retain
both #5683's eager-capture semantics and this protocol wiring when resolving
the normal merge.

The bounded mechanism is ES2015 native-generator factory/prototype identity and
runtime protocol dispatch: each generator instance captures its factory's current
`prototype`, uses the common closure bag only as its ordinary-object view, and
observes own/inherited `next`/`return`/`throw` and iterator overrides through
ordinary Get with the source generator receiver. It is not a claim of complete
generator semantics or full ES2015 conformance.

### Local evidence before upstream integration

- Exact original-source `tests/issue-5199-native-generator-prototype.test.ts`:
  **11/11 pass** under one compiler worker. Every fixture asserted successful
  standalone compile, `imports=[]`, `WebAssembly.validate(binary)`, and result
  `1`. The temporary `any`-cast diagnostic used during triage is not a fixture
  rewrite and is not counted as a gain.
- `tests/issue-5199-generic-yield-star.test.ts`: **27/27 pass** under one
  compiler worker, with the same standalone/import/valid-Wasm assertions.
- The prototype fixes were: preserve a generator state's explicit/factory
  prototype instead of re-seeding its borrowed closure bag with
  `%Function.prototype%`; bypass the closed-plain-object `getPrototypeOf` fold
  after integrity operations for native generators; and make a non-native
  result from a mutable protocol method use ordinary property Get rather than
  treating it as a native `{ value, done }` struct and silently reading `0`.
- No current Test262 result is claimed from those fixture runs. The former
  `44/44` protocol/control result belongs to the stale source/provider and is
  historical only. The compiler bundle and QuickJS provider must be rebuilt
  after the upstream merge before any exact-corpus comparison.

### Current bridge repairs and why they are bounded

- A captured `var g = producer()` was planned against its hoisted `externref`
  slot before the initializer refined `g` to the native generator-state ref.
  A synchronous generator declaration that captures exactly such a binding now
  uses the existing capture cell; its initializer writes the cell rather than
  leaving the captured pre-init carrier at `undefined`. This is deliberately
  limited to synchronous generator declarations, whose function-value
  materialization initializes the factory/prototype view. Plain nested
  functions retain their by-value timing.
- A direct native generator factory returns its private state struct, while a
  first-class function value must match the checker-visible `Generator`
  closure ABI. Generator-state-only wrapper signatures now publish
  `externref`, with `extern.convert_any` at the trampoline return. This makes
  the registry's `ClosureInfo.returnType` agree with the dynamic call
  candidates without loosening any unrelated reference result signature.
- State instances use the ordinary identity-keyed expando bag but are not
  callable closure wrappers. The delete carrier recognizes only the exact
  registered native-state type set, restoring inherited `next` and
  `Symbol.iterator` after an own shadow is deleted; it does not widen the
  generic closure-carrier predicate.
- Installing the public `return` wrapper exposed an older f64 abrupt-payload
  assumption even for native-string generators that never call `.return()`.
  Immediate return-result construction now uses the same default-element
  fallback as the resume path when the old scalar carrier cannot inhabit a
  nonnumeric result field. This makes the wrapper valid; it deliberately does
  not claim the separate arbitrary-payload ABI.

The rebuilt local bundle is
`33dba5253a70deebe42a5f35ef04bfbb2244bbc2b8b6f484725416588188ac9a`.
Its QuickJS provider used artifact
`073742801ba76347` and canary-verified adapter `d9d66a61210e4856`. On this
pre-integration source, original bridge9 is **9/9** with successful compile,
`imports=[]`, valid Wasm, and result `1`; original prototype11 and generic27
plus the three isolated bridge tests are **41/41**. These remain source-level
evidence until the required integrated-head rerun.

The authoritative standalone ES2015 JSONL for subsequent measurements is
`/Users/thomas/Code/js2/.test262-cache/test262-standalone-current.jsonl`,
SHA-256 `45ff56e7570bba0a1bff6590d19d35de2525928adb7e3054789ba35aebb29360`:
11,704 rows (10,230 pass, 1,144 fail, 329 compile_error, 1 timeout). All
cohorts use one compiler worker and exact corpus paths.

### Initial integrated validation — `cbeffc55`

This was the first publication evidence. It is retained for provenance, but
the post-d03 final validation below is the review basis for the current PR
head.

The historical `44/44` path list and legacy-control script were untracked
artifacts and cannot be recovered. Their result remains historical and is not
an acceptance claim. Do not reconstruct a lookalike list or report it as an
exact rerun.

The reproducible **2026-09-12 protocol36+B8** current-head protocol/control
matrix is
[`2026-09-12-es2015-generator-protocol-current-head-paths.txt`](../log/2026-09-12-es2015-generator-protocol-current-head-paths.txt):

- Lines 1–36 are the current exact corpus set of all
  `test/language/expressions/yield/star-rhs-iter-*.js`, plus
  `star-iterable.js`, `star-return-is-null.js`, and `star-throw-is-null.js`.
  They are the owned protocol rows and must be remeasured, not inferred from
  stale output.
- Lines 37–44 are the B controls selected from the authoritative JSONL, all
  currently `pass`: `star-array.js`, `star-string.js`, `rhs-iter.js`,
  `rhs-omitted.js`, `in-iteration-stmt.js`, `from-try.js`,
  `from-catch.js`, and `then-return.js`.

The manifest retains canonical JSONL paths rooted at `test/`; the maintained
runner expects paths below `test262/test`. The exact invocation removes only
that root prefix while preserving all 44 selected rows:

```sh
COMPILER_POOL_SIZE=1 JS2WASM_EVAL_ENGINE=quickjs node --import tsx scripts/run-test262-paths.mts \
  <(sed 's#^test/##' plan/log/2026-09-12-es2015-generator-protocol-current-head-paths.txt) \
  --standalone --isolate
```

On initial integrated head `67c36ad828fee7af2bd53f4f5617be03b86f46b0`
(whose upstream parent is `cbeffc55`), the rebuilt compiler bundle was
`b48135496043b1493824ddd47ca8ca309f1bfb77e96ce710a98de902a24e8bf0`.
The correct QuickJS evaluation provider reused artifact
`073742801ba76347` and built/canary-verified adapter `a39c62fac5d89739`.

- The exact **2026-09-12 protocol36+B8** matrix is **44/44 pass**: owned
  protocol A is **36/36 pass** and JSONL-authority B is **8/8 pass**, so there
  are zero B-control losses. This is a new current-head matrix, never the
  unrecoverable historical protocol44 claim.
- Unchanged original prototype11 is **11/11 pass** and unchanged generic27 is
  **27/27 pass**, each retaining their standalone compile, `imports=[]`, valid
  Wasm, and result assertions.
- Original bridge9 is **9/9** with successful standalone compile, `imports=[]`,
  valid Wasm, and result `1`. The permanent bridge suite is **5/5**, including
  the named legacy host-buffer producer positive control.

The c645 provider build is retained only as intermediate provenance
(`a67d940e…` bundle and `a520c80d…` adapter); no c645 cohort result is used as
publication evidence.

### Post-d03 intermediate validation — `ffb338c45b`

This measured the post-d03 merge tip
`66c44d6470fb6b73624ab9f5fc06915dd00f241e`, whose second parent is current
upstream at that time, `ffb338c45b9ce26c0b430a7345f498c403d35441`. #5849 at `d03c2248`
touches compiler/runtime inputs, so the compiler bundle and the QuickJS
**evaluation** provider were rebuilt even though it has no direct generator
source-file overlap. The later `d03..ffb338` range is only #5341 documentation
and npm-compat artifacts. The merge queue later added #5756, so this evidence
is retained as intermediate provenance rather than the current PR basis.

The rebuilt compiler bundle is
`31bd3f5b3afcaeda6222bc1017be10a7cdd4f878d7e8801df7e2aa5f8aa09dd2`.
The correct QuickJS evaluation provider reused artifact `073742801ba76347`
and built/canary-verified adapter `5fc4ed2567c14c45` (1,826,684 bytes). All
corpus commands used `COMPILER_POOL_SIZE=1` and
`JS2WASM_EVAL_ENGINE=quickjs`.

- Unchanged original prototype11, generic27, and permanent bridge/legacy suite
  are **43/43 pass** under one Vitest fork. Standalone fixtures retain
  successful compile, `imports=[]`, valid Wasm, and result `1` assertions.
- Original bridge9 is **9/9 pass** from the retained source bodies, using only
  the fixture entry wrapper that turns `function test()` into `export function
  test()`; no diagnostic cast or behavior rewrite is counted. Every row has
  successful standalone compile, `imports=[]`, valid Wasm, and result `1`.
- The exact **2026-09-12 protocol36+B8** matrix is again **44/44 pass**:
  owned protocol A is **36/36** and authoritative-JSONL B is **8/8**, with
  zero B-control losses. This remains the reproducible current matrix, never
  the unrecoverable historical protocol44 list.
- `pnpm run typecheck`, `pnpm run lint`, Prettier, LOC/function budgets all
  passed on this head.

### Current merge-queue validation — `b433de9f`

The merge-queue bot's fork commit
`95b55dbe2387915d54b93228c2bd8d949ce4bf4a` merges main
`b433de9ffe4e0c165fe65ff9d4a20bc91854cc1d` (#5756) into the previously
published generator branch. Its IR-planning changes have no direct generator
source-file conflict, but they change compiler inputs, so the local normal
reconciliation tip `22181e55b23e807256c59bc146beafa55c5e973e` rebuilt both the
compiler bundle and QuickJS **evaluation** provider before remeasurement.

The current compiler bundle is
`461ad8ef1ae4a7ddd958b02ebf4345a5994ff5048b23c9a1ffd99512105b6e0d`.
The QuickJS artifact remains `073742801ba76347`; evaluation adapter
`6054229e6f1cf236` (1,826,684 bytes) was built and canary-verified. All corpus
commands used `COMPILER_POOL_SIZE=1` and `JS2WASM_EVAL_ENGINE=quickjs`.

- Unchanged original prototype11, generic27, and permanent bridge/legacy suite
  are again **43/43 pass** under one Vitest fork. The standalone fixtures retain
  successful compile, `imports=[]`, valid Wasm, and result `1` assertions.
- Original bridge9 is again **9/9 pass**, with only its ordinary test-entry
  export wrapper and no diagnostic cast or behavior rewrite; all rows compile
  standalone with `imports=[]`, valid Wasm, and result `1`.
- The exact **2026-09-12 protocol36+B8** matrix is **44/44 pass** again:
  owned A is **36/36** and authority B is **8/8**, with zero B-control losses.
  It is still not the unrecoverable historical protocol44 list.
- `pnpm run typecheck`, `pnpm run lint`, Prettier, LOC/function budgets all
  passed on this current merge-queue head.

### Separate numeric-payload and closed-identity residual

Numeric generators still need an independent payload ABI decision. Do not
convert caller-supplied sent/return values to the yielded `f64` merely because
the yield element is numeric. The follow-up implementation plan is:

1. Split `payloadValType` / public result value representation from the
   optimized yielded-element carrier in native generator state, resume,
   abrupt completion, and dispatch helpers.
2. Thread the raw externref payload through `next`, `return`, and completion
   construction, then retain a proven numeric fast path only at consumers that
   actually require numeric arithmetic.
3. Re-run the three original object-payload controls (suspended return,
   completed return, ignored next) with `imports=[]` and valid Wasm before
   counting a Test262 gain.

On the current merge-queue head, the tracked original payload source bodies
from the stale checkpoint were rerun as a residual diagnostic (with only an
export wrapper to invoke `test`): all three compile with `imports=[]` and valid
Wasm, but all three return `0` rather than the Node-oracle `1`. The retained
failures are **0/3** for suspended `return(object)`, completed `return(object)`,
and ignored `next(object)`. They are not a Test262 gain and remain a separately
scoped ABI follow-up.

The historical closed-object identity control was untracked and is unavailable
for a current rerun. Its previously recorded no-generator failure is not
attributable to this protocol bridge and is not relabeled as passing; it remains
an object-carrier substrate dependency to coordinate with its owner.

### 2026-09-13 factory-identity regression investigation plan

On the freshly fetched standalone snapshot SHA-256
`07c89a5c2626f3312ff611f008a69ed6d8826e9802da024df39726ddabc1e9ba`,
53 official ES2015 rows contain `Missing native generator factory identity`.
Comparison with the previous snapshot finds 37 previously passing rows,
15 previous failures, and one previous compile error. This establishes a
regression candidate population, not attribution to a particular PR.

The same snapshot diff reports 63 gains and 38 losses overall. Thirty-seven
losses carry this factory-identity diagnostic; the remaining loss is the
original `test/language/statements/generators/default-proto.js` source, which
answers `Expected SameValue two objects`. It is an investigation/control row,
not evidence that every generator loss has the same cause.

Before continuing the three payload controls, the generator owner will:

1. Reproduce an original affected object-method source and a passing factory
   control on current upstream `e0023dbbe6c37e15c1f56ed0c8bc8d15d0afbac3`.
2. Trace prepared factory admission and registration through the landed
   protocol bridge; compare the relevant parent implementation to establish
   causality rather than infer it from matching diagnostics.
3. Repair confirmed factory identity loss, preserve parameter/default and
   generator protocol behavior, and pin the original affected source shape.
4. Measure all 53 paths against the same runner on both revisions, retaining
   the 37 previous passes as a regression floor and positive controls.
5. Publish this as a separately reviewed fix with issue evidence, then resume
   the independent payload ABI work. Do not conflate the two fixes.

#### 2026-09-13 original-source A/B and repair boundary

The maintained isolated standalone runner establishes the original-source
regression before any repair: on the pre-#5853 first parent
`bc8d2d30827923a049c68d93e5a34958eed3a8ce`,
`language/expressions/object/method-definition/gen-meth-params-trailing-comma-single.js`
is **pass 1/1**. On current `e0023dbbe6c37e15c1f56ed0c8bc8d15d0afbac3`,
the same unchanged path is a compile error:
`Missing native generator factory identity`. This is not an `any`-cast or
rewritten-fixture result.

The landed #5853 factory-prototype bridge added that throw in
`compileNativeGeneratorFunction`. Its new fallback asks
`ctx.funcMap` for `info.functionName` and calls
`emitCachedFuncClosureAccess`. Object-literal method registration deliberately
uses a per-literal `&lt;fullName&gt;__lit&lt;n&gt;` native-generator key while the
function map contains only the ordinary method name. More importantly, a
`MethodDeclaration` factory's observable identity is the per-object closure
from `emitObjectMethodAsClosure`, not the cached function-declaration/expression
closure represented by `ctx.funcMap`. Adding an alias would therefore hide the
compile error by substituting a semantically different factory identity.

The first `MethodDeclaration` exclusion was insufficient: the original sources
then compiled but failed at execution with `TypeError: Generator method is not
callable`, because the raw state had no `%GeneratorPrototype%` view for
`.next()`. The repair must therefore retain `NATIVE_GENERATOR_INIT_PROTO` for
methods, supplying its established default generator protocol prototype rather
than fabricating a cached factory closure. `FunctionDeclaration` and
`FunctionExpression` retain the factory-prototype initialization where their
cached identity is canonical. This neither broadens closure-signature matching
nor changes the independent payload representation. Per-method factory
`prototype` transport remains a deliberately separate residual; the historical
`generator-prototype-prop.js` row was already a failure. The separate
`default-proto.js` loss will be measured as its own control; its different
assertion is not attributed to this method-identity failure without a second
A/B.

An interim six-row original-source smoke before the final method wiring review
reported **4 pass / 2 fail**: both affected originals,
`generator-prototype.js`, and free-generator `star-array.js` passed. The final
wiring moves `NATIVE_GENERATOR_FACTORY_PROTO` wholly into the non-method arms,
so that smoke must be repeated before it is treated as acceptance evidence.
The two known non-passes remain intentionally separated:
`generator-prototype-prop.js` is the old method-factory-prototype residual (it
no longer compile-errors), while `default-proto.js` is the distinct
free-factory SameValue failure. The exact null-prototype behavior belongs to
the latter residual and is deliberately not installed as a passing permanent
pin until its own original-source A/B and repair are complete.

As a non-regression check on that boundary, all 63 old-to-fresh ES2015 gains
were parsed as original sources with the TypeScript AST. **Zero** contain a
generator `MethodDeclaration`; the gains are free-factory/protocol, RegExp, or
TypedArray rows. The method exclusion therefore cannot discard a measured new
generator-method gain, but it still requires current-head method-prototype and
protocol controls before publication.

The exact 53-row diagnostic population contains 52 generator
`MethodDeclaration` sources and one module free declaration,
`language/module-code/instn-uniq-env-rec.js`. The latter was an old failure,
not a lost pass. It is a separate registration/lookup residual: do not add a
generic missing-`ctx.funcMap` fallback merely to change its failure class,
because an ordinary generator factory may require the bridge's prototype
semantics. Trace its canonical factory registration separately; the first
repair accepts a 52-improved/one-remaining diagnostic cohort if that identity
cannot be established safely.

The exact 37 formerly-passing regression floor is checked in as
[`2026-09-13-es2015-generator-factory-identity-previous-pass-paths.txt`](../log/2026-09-13-es2015-generator-factory-identity-previous-pass-paths.txt).
It is derived mechanically from the old comparison snapshot's `pass` rows and
the fresh snapshot's factory-identity diagnostic. It is a targeted current-head
regression floor, not a replacement for the fresh authoritative census.

#### 2026-09-13 current-candidate repair evidence — `e0023dbb` + local diff

The final method-only wiring was measured on upstream
`e0023dbbe6c37e15c1f56ed0c8bc8d15d0afbac3` plus this candidate diff, using
the maintained isolated standalone runner with `COMPILER_POOL_SIZE=1` and
`JS2WASM_EVAL_ENGINE=quickjs`. The corrected six-row original-source smoke is
**4 pass / 2 fail**:

- Pass: the two original affected method rows,
  `generator-prototype.js`, and free-generator `star-array.js`.
- Existing method-prototype residual:
  `generator-prototype-prop.js` fails its own descriptor assertion but no
  longer compile-errors; it was already an old-snapshot failure.
- Separate free-factory residual: `default-proto.js` fails its exact
  `SameValue` assertion. It is neither hidden by this repair nor installed as
  a red permanent test.

The exact 37-row former-pass floor is **37 pass / 0 non-pass** on that same
candidate. Every listed path therefore regained its original standalone
verdict after the narrow `MethodDeclaration` protocol initialization. There
were no unexpected pass-to-nonpass rows needing individual pre-#5853 A/B.
The runner transcript is retained locally at
`.tmp/2026-09-13-generator-factory-identity-floor.log`; the checked-in path
manifest above, not that transient log, is the reproducible cohort definition.

The existing exact **2026-09-12 protocol36+B8** control matrix is also **44
pass / 0 non-pass** on this candidate with QuickJS evaluation under the same
one-worker limit. It remains 36 owned `yield*` protocol rows plus eight
authority-selected generator controls, not the unrecoverable historical
protocol44 list. Its local transcript is
`.tmp/2026-09-13-generator-factory-identity-protocol36-b8.log`.

#### Separate method function-prototype identity residual

The following mixed original-shape control is a real conformance residual, not
an invalid assertion:

```js
function* free() { yield 1; }
var method = { *method() { yield 2; } }.method;
Object.getPrototypeOf(method) === Object.getPrototypeOf(free) &&
  free().next().value === 1 && method().next().value === 2;
```

Node v22.23.2 answers `1`; the candidate's standalone permanent-test execution
answers `0`. Thus the two callable generator functions do not yet share the
required `%GeneratorFunction.prototype%` identity even though the method is
callable and its generator instance has the protocol view. This is separate
from the per-method `prototype` data-property residual and from free-factory
`default-proto.js`. The accepted method-fix pin intentionally checks the
bounded behavior it repairs—method callability plus both `.next()` paths—while
this stronger identity source remains recorded for a subsequent dedicated
repair. It is not reported as passing or erased from the handoff.

### Historical pre-regression bridge readiness (superseded)

This recorded the bounded protocol bridge's prior non-draft readiness:
current-merge-queue source fixtures, bridge controls, provider provenance, and
the reproducible protocol36+B8 matrix were green. The 2026-09-13
factory-identity regression above supersedes it as current acceptance; no
reviewer should interpret this historical checkpoint as approval of the new
method repair. It never claimed complete ES2015 or closed the separately
recorded numeric-payload/closed-object mechanisms.

### Post-#5850 final integrated validation — `f41432d1`

Upstream main advanced to `f84b3a3de56afd2f6ddd6c91a77ef407d92f4f19` while
the CI-repair validation was in progress. It was normally merged, without a
rebase or force update, at `f41432d1ba59d8f8a744960c1de7d69e68ed5ad6`.
`#5850` adds async-thenable adoption and one boundary-inventory entry. The
merge auto-resolved the shared policy, `closures.ts`, and
`nested-declarations.ts`; both #5850's and #5199's classifications and source
semantics are present. This is the final source head measured below.

#### CI repair: host IteratorResult key planning

The six CI equivalence regressions were real, not base drift: the generic
delegated-result getter and the open `IteratorResult` dynamic-property fallback
called `nativeStringLiteralInstrs` on the ordinary WasmGC host lane. That helper
requires a native-string heap type, so its `__strlit_0` global had heap type
index `-1` there. The #5756 prepared-admission order made that invalid global
observable during compilation.

The repair does not relax heap-type checks or mark unrelated captures mutable.
It reserves the exact protocol keys through `addStringConstantGlobals` before
the program ABI finalizes, then uses `stringConstantExternrefInstrs`, which is
target-aware. `next`, `throw`, `return`, `done`, and `value` are reserved when
the generic delegated-result helpers are emitted; `value`/`done` are reserved
only when the open-result dynamic fallback is selected. The known-native result
struct path and host-free native protocol paths are unchanged.

Permanent evidence now includes the exact original #439 IteratorResult read
and #763 yield-as-IIFE-argument sources in the bridge suite, plus the prepared
admission pin. No `any` cast or source rewrite is counted as a gain. The three
newly classified generator runtime modules are also in
`scripts/compiler-boundaries.json`, alongside #5850's classification.

The compiler bundle rebuilt from `f41432d1` is
`ad4110377653290332b121425869b72ed61b21c3757bc66fba4ea59c51e9651c`.
The correct QuickJS **evaluation** provider reused artifact
`073742801ba76347` and built/canary-verified adapter `a8544ea4802d2a14`
(1,826,684 bytes). All compiler-backed cohorts used
`COMPILER_POOL_SIZE=1`; the exact corpus also used
`JS2WASM_EVAL_ENGINE=quickjs`.

- Permanent generator pins are **46/46 pass**: unchanged prototype11,
  generic27, the seven-test bridge/legacy suite, and the prepared-admission
  pin. The original standalone fixtures retain their compile, `imports=[]`,
  valid-Wasm, and result assertions.
- Original bridge9 is **9/9 pass** from the retained bodies with only the
  normal `test` export wrapper. Every row compiled standalone with
  `imports=[]`, valid Wasm, and result `1`.
- Exact **2026-09-12 protocol36+B8** is **44/44 pass**: owned A is **36/36**,
  authority-selected B is **8/8**, and there are zero B losses. It remains
  distinct from the historical, unrecoverable protocol44 list.
- The four #439 and two #763 rows that regressed in CI now pass. The direct
  files report **8/9** only because the pre-existing baseline row `yield with
  value used as expression` still reports `Type 'undefined' is not assignable
  to type 'number'`; it is not a new or claimed #5199 gain.
- `pnpm run test:equivalence:gate` is green: **1,720 pass**, **22 known
  baseline failures**, and **zero new regressions**. The CI-equivalent boundary
  inventory is also green (`errors: []`, 1,333 tracked, 0 untracked), as are
  typecheck, lint, Prettier, LOC/function budgets, and the oracle ratchet.

The three tracked numeric-payload controls were rerun again from their stale
checkpoint source bodies with only the export wrapper. They compile with
`imports=[]` and valid Wasm but return `0`, not the Node-oracle `1`: **0/3**.
The separate payload ABI plan above remains the handoff; this is neither a
Test262 gain nor a reason to hold the bounded protocol bridge draft.

### Post-#5858 publication-base sync — `23a0ddaa`

After the `f41432d1` checkpoint was pushed, the authoritative GitHub main
advanced to `23a0ddaa26e5db149a93e27db113dba17794c353`. It was normally merged
at `5e655de822f8653d8e8d7a4c7a864dc7418d38c6`; no rebase or force update was
used. Although #5858 itself refreshes npm-compat artifacts, the intervening
range also contains #5856 compiled-closure-length and #5857 nullish-join source
work. Neither overlaps generator code; the shared
`scripts/compiler-boundaries.json` policy auto-merged with both classifications
intact.

The f414 repair evidence remains the source-sensitive CI proof, including the
full equivalence baseline gate (**1,720 pass**, 22 known failures, zero new
regressions). The new publication-base rerun is deliberately proportional:

- Bundle SHA-256 `cd964d00c8fca69aff9783644599717f268db2bcb9833d153cd00c2a323f38a4`;
  QuickJS evaluation adapter `2523a1574106f5f1`, canary-verified with artifact
  `073742801ba76347` (1,826,684 bytes).
- Permanent generator pins **46/46**, original bridge9 **9/9** with
  `imports=[]`, valid Wasm, and result `1`, and exact protocol36+B8 **44/44**
  (A **36/36**, B **8/8**, zero B loss) are all green under one compiler worker.
- The four #439 and two #763 repaired rows pass again; direct files remain
  **8/9** solely for the existing baselined #763 static diagnostic.
- CI-equivalent boundary inventory has `errors: []`; typecheck, lint, and
  Prettier pass. The tracked numeric payload diagnostic remains **0/3** with
  valid Wasm and `imports=[]`, returning `0` rather than the Node-oracle `1`.

PR #5853 remains **draft** while this refreshed exact head is published and its
new CI/shepherd verdict is pending. It may be marked ready/non-draft only once
that head is confirmed green and mergeable.

### Post-#5859 final draft base — `561b9d20`

Main advanced again to `561b9d2003ed3e6d7bd27538437e4084f48369f0` through the
isolated RegExp cursor repair #5859. It was normally merged at
`24d66a9c633a3c2ccb566317a343d031aa6710ba`; no generator file or boundary
policy overlaps occurred. The f414 full-equivalence repair proof and 23a
publication-base history remain intact, while the following final exact-head
checks guard this unrelated source integration:

- Bundle SHA-256 `63be675c0cba1db781a549b3cbc2570562c36fe108499468f8160753abcc2ca0`;
  QuickJS evaluation adapter `50303ea3ccaa966d` is canary-verified against
  artifact `073742801ba76347` (1,826,684 bytes).
- Permanent generator pins are **46/46**, original bridge9 is **9/9** with
  standalone `imports=[]`, valid Wasm, and result `1`, and protocol36+B8 is
  **44/44** (A **36/36**, B **8/8**, zero B loss).
- The six repaired #439/#763 rows pass again. Direct files remain **8/9** only
  for the known baselined #763 static diagnostic; boundary inventory has
  `errors: []`, and typecheck, lint, and Prettier pass.
- The tracked numeric-payload residual remains **0/3**: all bodies compile with
  `imports=[]` and valid Wasm but return `0`, not Node-oracle `1`.

PR #5853 remains **draft** pending CI/shepherd confirmation for this exact head;
do not mark it ready solely from these local checks.

Full resumption details and exact local commands are in
[the 2026-09-12 rescue handoff](../log/2026-09-12-es2015-generator-protocol-rescue-handoff.md).
