---
id: 6929
title: "ES2015 standalone: attribute and repair the two canonical Function.prototype.toString residuals"
status: in-progress
sprint: current
created: 2026-10-09
updated: 2026-10-09
priority: high
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: ttraenkler/6878-local-receiver-sol61
related: [6878, 5269, 6775, 4492, 5383, 5140, 5197, 6770]
---

# Decision and scope

This Markdown file is the planner's only write target. Preserve all production,
test, IR, policy and peer changes. Root exclusively owns compilation, parsing,
native execution, builds, tests and validation. The two retained canonical
nonpasses are proxy-class.js (NativeFunctionSyntax rejects `[object Function]`)
and not-a-constructor.js (expected TypeError, no exception). These messages do
not establish their causes. No source implementation is authorized by this plan.

Next executable slice: reproduce all nine unchanged canonical originals through
the maintained honest whole-harness runner, then capture the two failing
original modules and identify their first failing assertion. Root alone executes.
There is no ownership-clear production fix to dispatch yet. Two active issues
declare these exact residuals; the apparent missing mechanisms already exist in
current source. Do not redispatch their historical patches as a new fix.

This issue was atomically allocated by root's publisher (terminal63025/5cbcbd,
exit0; root reports prScan ok, degraded=false and allocation effect verified).
Allocation tracks this diagnostic task; it is NOT a reservation of foreign
production hunks. The former 14-line duplicate-6878 draft was moved here with
root's explicit authorization after checking that the destination did not exist.
All older frozen plans remain untouched. The 6878 references below identify the
root conformance lane and retained evidence, not this issue's identity.

## Evidence, denominator and custody

Current source inspection root L:
`/Users/thomas/.codex/worktrees/6878-latest-composition/js2`.
Its recorded HEAD is `7d9e8ce3c6efcd4ebcfca6e14e8f895a69e9ae18` with composed
dirty source. This is NOT the source epoch of the admitted b47 canonical run.
Root reports newer upstream `dbf5b4f74b37d67e525b2af36fd1fe49803b1348` contains
53 later commits/243 changed files but no src changes. That is reconciliation
context, not a new full run or a reason to skip current harness/bundle sealing.

Retained complete canonical JSONL, directly read and hashed:
`L/benchmarks/results/es2015-6878-b47-composed-20261009-results-20261009081917402.jsonl`
SHA256 `b7f70f52195cf92d2ce15bf2b43efbf20ad360e6aa667121888a688cf5ce3250`.
Root-admitted full result: 11,778 original identities, all 74 Intl retained,
11,575 PASS / 189 FAIL / 14 compile errors. No gain is claimed here.

Exact prefix filter `test/built-ins/Function/prototype/toString/` gives nine
rows, all oracle14/honest/auto, official standard scope, reached_test=true,
strict=both. Root independently verified the same 7 PASS / 2 FAIL population
(cf510b). The complete unchanged reproduction manifest is these nine paths
under that prefix:

- `proxy-non-callable-throws.js` — PASS.
- `proxy-bound-function.js` — PASS.
- `proxy-function-expression.js` — PASS.
- `proxy-generator-function.js` — PASS.
- `proxy-arrow-function.js` — PASS.
- `proxy-method-definition.js` — PASS.
- `GeneratorFunction.js` — PASS.
- `proxy-class.js` — FAIL: `Test262Error: Conforms to NativeFunction Syntax: "[object Function]"`.
- `not-a-constructor.js` — FAIL: `Test262Error: Expected a TypeError to be thrown but no exception was thrown at all`.

This is the entire canonical prefix population, not every file in that directory
at every edition. Keep all seven passing rows; do not replace the manifest with
only two failures or classify an absent row as a passing row.

### Original and harness seals

All original bodies and both relevant harness helpers were read. SHA256:

```text
85f6829f92b0a37cca0e01024047e1c1ac3a5b04e543260178fdab28039efe9b proxy-class.js
52c3c2aa9b4557c99712505a914eb32b8026c087349dc453bec288e5302b91f2 not-a-constructor.js
0dff80adb5e19b3231f426aa4d4b1cd052dadc6555b019e3ca274c67d6969447 proxy-non-callable-throws.js
362bfcb98de66a6be13f7198afcb1bae9433dbfaa478bede7e0d90fe2d7eaa74 proxy-bound-function.js
9070c6be3d3d25a1e6e37e4d10bd83edf374ed9681529ab28f4139847c56ced9 proxy-function-expression.js
2c33314f9c4f567d49d1f66183531a9cb6696cab1583eb091795db34598c2142 proxy-generator-function.js
edf647e1538d6ccc6291b4f69954d0b21b1a0e13466746336387f8674c3b9a3b proxy-arrow-function.js
16ee1af4fea6da30f21c07ad10ac9f59b685401170f3e69047070ef885a0cfc8 proxy-method-definition.js
fc07757e1e4d74147c01366dab2a9b2496cd65422b31463892515532798a6d5a GeneratorFunction.js
277e156a46d4f200e92c0f0d89aebbf5c6e94ca3eae8638f7802365819db0954 test262/harness/nativeFunctionMatcher.js
68e1a3e4565a8d33ea7fc918627fbbf446bcf14d7a939777616b2b545a5e7d32 test262/harness/isConstructor.js
```

The first nine paths are relative to L/test262/test/built-ins/Function/prototype/toString/.
The harness paths are relative to L. NativeFunctionMatcher's actual helper
computes `"" + fn`, then validates NativeFunction syntax; it is NOT a direct
`Function.prototype.toString.call(fn)` fixture. The large identifier regex and
validation function stay unchanged. No abbreviated matcher is an original verdict.

## Two distinct attribution questions

### P — proxy/class conversion

Original proxy-class contains, in order:

```js
assertNativeFunction(new Proxy(class {}, {}));
assertNativeFunction(new Proxy(class {}, { apply() {} }).apply);
```

The error alone does not identify which assertion failed. The second expression
reads `.apply` from the proxy's target/prototype chain: the handler has an apply
trap, not a get trap. It must not be rewritten as stringification of the handler
method. All five passing callable-proxy controls contain this same two-assertion
shape for different targets. They are strong route controls, not proof that the
class case takes their emitted route.

Source facts in current L:

1. `object-runtime-proxy.ts`'s `__proxy_create` body writes immutable field5
   CALLABLE by calling `__typeof_function(target)` and field6 CONSTRUCTIBLE by
   calling `__reflect_is_constructor(target)`. Creation does not eagerly read
   traps; revocation does not erase these capability bits.
2. `typeof-natives-finalize.ts::fillStandaloneTypeofClosureArms` includes exact
   class-object singleton identities in `__typeof_function`. Its distinct
   host-free bridge predicate `__is_callable` excludes class objects. Therefore
   blaming the latter for ProxyCreate's field5 is contradicted by the source.
   Actual registered singleton/type/helper values in the original are UNKNOWN.
3. `new-super.ts::compileClassExpression` can emit a standalone class singleton
   when registered, otherwise a constructor closure; an uncollected class falls
   back to null. The actual branch for these two class expressions is UNKNOWN.
4. `callable-any-to-string.ts::buildProxyCallableToStringArm` already tests the
   proxy and field5 and returns NATIVE_FUNCTION_SOURCE. Both any/extern fills
   include this before their ordinary property walk, behind the outer function
   predicate. Adding this same arm again is not a diagnosis.
5. `native-addition.ts::emitAnyAddFromExternTemps` first applies default-hint
   `__to_primitive` and `emitAddOrdinaryToPrimitiveResidue` to each operand, then
   decides concatenation/numeric addition. The residue consults valueOf then
   toString through `__extern_get` and the accessor-call driver. A primitive
   string produced there remains a string; a later callable string arm cannot
   recover the original object. Static alternatives also exist in binary-ops
   and addition-to-primitive; the original module must identify the selected one.

Leading hypothesis: ordinary primitive conversion or inherited-method lookup
has already produced `[object Function]` before the existing callable proxy
string arm. Competing hypotheses: wrong field5/class carrier classification;
missing fill dependencies; second-assertion `.apply` value/receiver misrouting.
None is promoted to observed first loss. Historical issue text reporting the
same string is not current emission evidence.

Semantic constraint: IsCallable asks whether [[Call]] exists, not whether calling
the function succeeds. A class constructor's [[Call]] throws; that differs from
no [[Call]]. Do not globally equate the local bridge predicate with the spec
predicate, or mutate it to fix a writer that does not consult it. See the primary
[IsCallable algorithm](https://tc39.es/ecma262/multipage/abstract-operations.html#sec-iscallable)
and [ECMAScript function call algorithm](https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-ecmascript-function-objects-call-thisargument-argumentslist).

### C — native method construction

The unchanged not-a-constructor body first calls
`isConstructor(Function.prototype.toString)`, then asserts a TypeError from
`new Function.prototype.toString()`, then aliases the value and asserts a
TypeError from `new toString`. Keep this sequence intact. The harness's
isConstructor uses Reflect.construct with the candidate as newTarget and catches
ANY exception: its false answer alone cannot prove correct TypeError identity.

Current source already contains:

- `native-proto.ts::ensureStandaloneNativeMethodClosure`: canonical member
  aliasing, native body probe/final emission, metadata subtype creation via
  ensureBuiltinFnMetaType, nativeClosureMeta and receiver-closure registrations.
- The native prototype seeder calls that SAME factory with refusalBodyFallback
  enabled, then stores a singleton via pushBuiltinFnSingletonValueInstrs. It is
  a real property/descriptor surface and can be mutated/deleted at runtime.
- `builtin-fn-meta.ts::ensureBuiltinFnMetaType` registers the metadata subtype
  in closureInfoByTypeIdx and builtinFnMetaByTypeIdx. It does not itself add it
  to constructibleClosureTypeIdxs.
- `object-runtime.ts` reserves `__builtinfn_is_builtin`, then
  fillBuiltinFnMeta/prependBuiltinFnObjectSemantics fills it from metadata
  families. The fill can decline if prerequisite helpers/types are absent.
- `new-super.ts::emitBuiltinFnNotAConstructorGuard` uses that classifier in the
  dynamic-new fallback. A separate direct syntax guard exists in
  isNewOnNonConstructablePrototype/compileNewExpression for X.prototype.Y.
- `reflect-construct-native.ts::fillReflectIsConstructor` reads the dedicated
  constructible set, bound target, immutable proxy bit and exact builtin/class
  identities. `construct-is-constructor-guard.ts` is another driver consumer.

Historical issue 6775 S3/residuals says the preceding Reflect.construct probe
materializes a companion-seeded wrapper not recognized by a later classifier.
This is useful to test, not proof. Current seeding and direct reads share a
metadata-registering factory; closure-classifier walks registered types to roots.
Actual seeded subtype/root, predicate result, guard selected, and first failing
new expression all remain UNKNOWN. Do not fix this by blanket builtin rejection,
changing the null tail of every dynamic constructor, or treating syntax/name as
runtime identity. User-overwritten prototype methods may be constructors.

## Shared readers, mutators and lifecycle obligations

This is a bounded dependency inventory for diagnosis, NOT clearance to change
all of these structures. A production proposal changing any shared publication
must append its full current reader/mutator search before reservation.

- Proxy field5 is written at creation and read by typeof, callable string arms,
  direct proxy call/apply dispatch. Field6 feeds Reflect/construct. Handler/target
  and revoked/trap-record fields have separate operation-time semantics. Changing
  a capability is not a stringification-only change; preserve nested/revoked
  proxy identities and no eager trap lookup.
- classObjectGlobals is populated by class collection/materialization and read
  by class singleton access, typeof, constructor classification and the linked
  boundary. Exact identity—not shape alone—distinguishes a class from instances.
  Do not publish a broad class-shaped callable vote or alter linked bit policy.
- closureInfoByTypeIdx is shared factory metadata, consumed by root-classifier,
  closure dispatch/export, arity/property readers and typeof. Root filtering has
  hostOneShotOnly/domCallbackOnly exclusions. Never delete these exclusions
  globally merely to admit one captured wrapper.
- builtinFnMetaTypeByKey caches metadata identity; builtinFnMetaByTypeIdx drives
  name/length descriptors, property deletion state and integrity/prototype
  predicates as well as the builtin classifier. Native closure metadata,
  receiver/getter sets and singleton emission preserve receiver ABI and aliases.
  A metadata-family ref.test is not exact per-method identity in linked modules;
  existing bfnid/signature guards are load-bearing. Do not widen a shared map
  solely to make a constructor guard fire.
- The seeder records its registry entry before emitting members to break
  re-entry. It re-reads shifted helper mappings around member/constructor
  acquisition. FillBuiltinFnMeta resolves target bodies by name; closure/typeof
  filling waits for registrations, mutates existing bodies without index churn.
- Single-source index ordering places the any-string callable fill before its
  final typeof fill and extern-string fill after it; multi-source has both
  callable fills after typeof. Calls may legitimately point at a reserved body
  filled later. Capture final bodies, not an intermediate zero stub. Do not
  repeat non-idempotent prepend passes to conceal a missing registration.
- protoNamedWrittenMembers affects the existing user-installed-only ordinary
  walk. Prototype companion presence/absence governs actual writes/deletions.
  Neither source-name occurrence nor a broad dirty flag proves runtime identity.
- Existing addition lowering evaluates operands once, then converts in order;
  helpers acquire/flush late imports before current index capture. Preserve this
  sequencing, current receiver, abrupt completion and fresh instruction objects.

Excluded without a new reviewed contract: IR/layout/runtime ABI; global coercion
policy; class singleton representation; generic IsCallable/IsConstructor
redefinition; shared-map publication; linked boundary bit meanings; global
constructor fallback; registry/gate/budget baselines or allowances.

## Fresh ownership reconciliation — implementation HOLD

Read-only GitHub API branch read returned immutable assignment commit
`238a263333f581d3e317bb8888197fc5923dadb3`. A recursive tree read resolved exact
root record paths; contents were decoded from this immutable ref, not inferred
from a stale local ref. No claim mutation, external message or PR adoption occurred.

- `5269.json`, blob `75f3376d42bdd079ecec88707b2e6ff693b526c7`:
  in-progress, assignee/requested_by `ttraenkler/proxy-class-baseline-sol61`,
  branch `codex/5269-current-main-integration-sol61`, updated/claimed
  2026-10-06T22:25:24Z, write `42660-0feq938p`.
  Issue title: “ES2015 standalone: Function / Error / Symbol / String / JSON /
  Number built-ins — r2 residual pass”. Its Step C explicitly names proxy-class,
  callable-any-to-string, native-proto, Reflect classification and dynamic-new.
- `6775.json`, blob `149cefb6339846f42c89775d6f080fe9b28b2db4`:
  in-progress `ttraenkler/opus-6775`, branch
  `issue-6775-es2015-builtins-misc-residue`, write `1573-liurq9bq`,
  updated 2026-09-30T21:05:49Z. “ES2015 standalone: built-ins misc residue
  (70 rows) …” S3 and S18/residual section name BOTH exact rows, companion
  closure classification and construct-is-constructor-guard/new-super.
- `4492.json`, blob `6fd74002c9a554b98ccfc7176028b2a6c68afcc2`:
  in-progress `ttraenkler/dev-4492`, branch `claude/es5-standalone-pass-rate-6tk9rb`,
  write `22482-pirk6luk`. “ES5 standalone: builtin-prototype methods on
  exotic/boxed/dynamic receivers (~103 tests across Array/String/Function.prototype)”
  declares callable/ordinary primitive conversion work. Age is not release.
- `5383.json`, blob `96e81554338f4443bab95f07463fe050812372fd`:
  in-progress `ttraenkler/dev-5383-s2d`, branch `issue-5383-standalone-temporal-s2d`,
  write `15609-jviss7h9`. “standalone: a real Temporal global … link the compiled
  polyfill provider into the standalone lane …” R12/R13 declares class identity
  and callable boundary distinctions; no blanket classifier clearance.
- `5197.json`, blob `b664bf0076f991c4cae386311b962cfd064773e7`:
  in-progress `ttraenkler/opus-5197`, branch `issue-5197-r3-promise`,
  write `24517-uxuavc7m`. “ES2015 standalone promise — r2 residual pass” owns
  builtin non-constructor guard/classifier work shared by the proposed route.
- `6770.json`, blob `7194dfb98892e4424845482c05300fc823f95050`:
  in-progress `ttraenkler/opus-6770`, branch `issue-6770-object-reflect-residue`,
  write `21505-y5j21jvm`. “ES2015 standalone built-ins/Object + built-ins/Reflect
  residue — 49 rows … lazy trap lookup” overlaps ProxyCreate and live trap paths.
- `5140.json`, blob `7f93290ab555ac82d36a0143e5ad37e4106bfddd`:
  reserved, assignee empty, requested_by `claude/fable-es2015`,
  write `7796-1u7w9vjh`, pr_scan degraded. “ES2015 standalone: proxy conformance
  wave 1”. Empty assignee/degraded scan is NOT release.
- `6878.json`, blob `28afdcab8470077e81f929032422c709217ad75d`:
  root's in-progress `ttraenkler/codex-6878-delete-result-boolean-sol61`,
  write `49336-skzxz13q`. Its conformance lane does not absorb these claims.

Tree did not contain 2896.json or 6607.json at these exact paths. That establishes
only absence of those particular records, not unowned shared code. The above
positive overlaps are sufficient to HOLD production. Root must reconcile exact
functions with recorded owners or obtain explicit authorized handoff; stale local
issue status, apparently landed source, user IR clearance, and this new issue's
allocation do not independently release them. No external owner contact is
authorized here. Freshen the immutable ledger once at actual dispatch.

## Root-only diagnostic and implementation route

### Phase 1 — unchanged nine-row reproduction

Use the existing dynamic entry `tests/test262-chunk-dynamic.test.ts`, one logical
shard (index0/total1), exact nine-path manifest, current maintained runner. Use
standalone / honest / auto / strict rerun always / realm recycle / one worker,
matching the admitted run and root's complete Map-original reproduction. Keep
actual compiler/runtime bundles, normal host hooks, optional initialization and
whole original harness assembly. Do not substitute an empty import object or a
handwritten assert. Root seals source epoch/bundles/options/runner before/after.

Retain actual nine verdicts and one completion manifest; require COMPLETE,
9 registered,9 unique verdicts,0 missing/duplicate/excluded/pending. Compare each
status and first error with retained b47; if different, report a changed baseline,
not assumed attribution. Preserve control failures for diagnosis. No compiler
settings or source patch solely to make the reproduction fit a hypothesis.

### Phase 2 — original emission and separately labelled first-assertion capture

Capture exact compiler-input assembled source (including full harness), original
AST/source provenance through the normal runner, compiler-returned module/WAT,
binary, imports, options, actual lifecycle count and first exception. Capture
each strict variant actually executed. No copied historical module indices.

For P trace both class expressions separately: selected class value carrier →
ProxyCreate target → field5/field6 writer → final typeof body → native matcher
concat's selected path → primitive-conversion property gets/call receiver →
first primitive string → syntax validator. Also identify second `.apply` value.
Record the first destructive producer/lookup, not only final string formatting.

For C record all three original checks and exact order: Reflect.construct target
and newTarget → prototype seeding/actual method subtype and funcref → both new
sites → chosen native/dynamic driver → typeof, builtin, constructor classifiers
actually called → thrown object/no throw. Record type indices, nominal IDs,
final predicates and instruction offsets in this module. A final error message
or a successful standalone new probe is insufficient.

If natural exception provenance cannot distinguish sites, add a separate
diagnostic fixture (future root-approved `tests/issue-6929-function-tostring-diagnostic.test.ts`)
with explicitly numbered observations while keeping originals verdict-bearing
and unchanged. Label altered assembly as diagnostic, never original. Preserve
the preceding reflection and both original Proxy assertions; do not isolate away
their materialization effects. Pair observer-present/absent controls and correlate
to original final WAT before drawing a cause. No root test writer is authorized
until root reviews this diagnostic scope.

### Phase 3 — at most two separately reserved repairs, conditional on evidence

P: if original evidence shows incorrect inherited Function method resolution
before stringification, request only the actual receiver/prototype lookup helper
function and its private glue/fixture. Do not bypass live Get/@@toPrimitive with
an unconditional proxy constant at concat entry. If instead final field5 or an
existing callable fill is wrong, request only its demonstrated writer/fill
precondition; repeat the shared-reader audit before touching classification.
Candidate investigation files: callable-any-to-string.ts, native-addition.ts,
add-to-primitive.ts, object-runtime-proxy.ts, native-proto/proto-index lookup.
This list is NOT a write grant; exact function remains dependent on capture.

C: if captured native-proto method publication/classification is incomplete,
request only that factory/seed/finalize hunk with 5269/6775 reconciliation. If
classification is correct but a specific new site skips the existing guard,
request only that site's routing in new-super.ts or the identified native driver.
Use actual non-constructible function identity and existing real TypeError
producer, preserve legitimate constructors and evaluate arguments as JS requires.
No new ctx public API, generic cast, syntax-only extension, blanket fallback throw
or change to constructibleClosureTypeIdxs without all publication contracts.

After evidence + owner reservation + root plan review, dispatch a Sol6.1 High
writer in its own isolated worktree with exact source preimages and function
boundaries. If capture points outside these boundaries, stop and amend the issue
before edits. Do not merge both mechanisms merely because they share toString.

## Acceptance and negative controls

- All nine original rows unchanged; all seven retained PASS controls must remain
  passing. No predicted two-row gain. Preserve all root original148/12 and current
  composed425 populations; report actual unchanged counts rather than borrowing
  previous counts as new evidence.
- P controls: callable proxy of ordinary/arrow/generator/method/bound/class;
  plain non-callable proxy; class instance vs constructor; nested and revoked
  proxies; direct Function.prototype.toString.call vs `"" + value`; own/inherited
  valueOf/toString/@@toPrimitive overrides, getters and throwing get traps.
  Observe once-only lookup/call/left-right order, actual receiver and exception
  identity. Preserve source-text behavior for ordinary source functions.
- Calling a class without an apply trap still throws; constructing it works;
  a proxy apply trap around a class must retain its applicable call semantics.
  Neither operation's result can substitute for the capability bit itself.
- C controls: direct/member/alias/computed method access; before/after
  Reflect.construct/descriptor/prototype materialization; native methods and
  accessor functions remain callable but not constructors; constructible user
  replacements, normal/bound/class constructors and proxies remain constructible
  where specified. Native arrow/generator/method nonconstructibility remains.
- Real current-realm TypeError identity in explicit invalid-new tests; preserve
  callee-realm distinctions for class [[Call]] and existing cross-realm/newTarget
  behavior. A WebAssembly trap, generic error or arbitrary caught exception is
  not successful TypeError conformance. Arguments/lookup abrupt completions must
  retain spec order and original identity.
- Host/gc/wasi and linked import/provider controls are separate measurements,
  not substitute canonical evidence. Keep single/multi-source finalized helper
  registration and no-shift/index lifecycle controls for any changed fill.
- Root runs formatting, types, source/function size, boundaries/inventory,
  cycles and focused tests with no copied grants/baseline edits, then exact
  same-source A/B and removal of only the repair to prove attribution. Record
  source/bundle hashes and fullName/status/first-error row parity in each arm.
- Final publication requires fresh latest-main reconciliation preserving IR,
  recorded ownership, zero new control losses, actual original target outcomes
  and root's fresh complete 11,778/all74 canonical validation. A nine-row green
  cannot become full-suite or 100% credit. Existing 203 canonical nonpasses
  remain the retained goal status until actually remeasured.

## Current-source preimages (SHA256, relative to L)

```text
01170d8a4f99b47d8074cea8b7b9e159fdfd67e3dc6da0da79a31e2af8afaddb src/codegen/callable-any-to-string.ts
2d56240fbe5af71e2f49e43be64dacd2d5a8675de7f5f083b91d999ae0c65804 src/codegen/function-proto-to-string.ts
bfcc4347d38bf914316323f1a468864973a5264b28d84855f66d16461d8534f0 src/codegen/typeof-natives-finalize.ts
a64b0209aec8e46acdc3590f0f2a8a6e53d30c2d70e545cf23917477de89161a src/codegen/object-runtime-proxy.ts
cd2870b7016cd0b9e1009ba69f991526b36aec990b6831195963c9f4d92d07c6 src/codegen/expressions/new-super.ts
03f1804d815f315ded693f09a549c3b9a55c5f750b5032b05af437c4dacc816f src/codegen/native-proto.ts
cb90358d4dedc2d4d032aa38cc576b8f2ba3619579d70ee3102c4817506fb642 src/codegen/builtin-fn-meta.ts
0d2b70770eb0aef9d2791fd75d6a006b0a1873e7e510caf62c5809512b386693 src/codegen/closure-classifier.ts
92bd1b419222c200af68869fbdc4801d3c1dec806d3b5420a2b19530a08fc2e1 src/codegen/object-runtime.ts
ea5e0f15e42f5eb72d411b3f7c0eb01e52d823ccc9104f5fe3f70e2e87026fb2 src/codegen/reflect-construct-native.ts
8dd2a67293459c8d97d42fb2a0564882f8b51d848d19fc4ee6bc1588b81e819e src/codegen/construct-is-constructor-guard.ts
f385b12faa9066e6b745ea159cae6e3506fee3c77fa6054979c507b01420e305 src/codegen/index.ts
08100098cad4430697e7eb5f255dcf2231dd3542bbd78b7afbc53a53ef076f9e src/codegen/native-addition.ts
07c816c15c3ed2c78169d955e24b4696b3ce983c8fda1be3094bfbf0a86db01e src/codegen/add-to-primitive.ts
5e79440e5840e13632d7cdad2728fb5a878d2d396a5120a260196684ac954cf3 src/codegen/carrier-to-primitive.ts
0b112285e3b025432d18b4784356a126520804e8cb68a6ab678d1ef7ee571d36 src/codegen/ordinary-to-primitive-probe.ts
281bc9a70a9a5f266780cdb077c86fd3467d48cf74074d4b3810106ef1077eb5 src/codegen/coercion-engine.ts
124cdcd48ae1cc806e87afe645a068c72183e7ded51c112fb7e081d6bad7551c src/codegen/native-proto-value-read.ts
a53faaef1c17e84fd5edd2702f01a0a9535f9423e2a6d8c47a58993667379e91 src/codegen/native-proto-own-props.ts
06d69d8a29ad7efff8187d8788e84a0a531f6d574c283a88c37e1b787f9300b5 src/codegen/proto-index-store.ts
31790087a77cecc5c532ca5e0492f1f9baaf14f577fc612fa6a966061ad33339 tests/test262-chunk-dynamic.test.ts
5049f6e291709b8f5043cad5649f9e549b09288923b451a2cf070c595c8d38df tests/test262-shared.ts
a7a9f9a3ebb0fe9ab3f25ee1e4a11dcde734561174de3d203e487a46e57d90f0 tests/test262-original-harness.ts
```

## Handoff

Planner performed source/text/hash/immutable-owner reads only. No compiler,
parser, runtime, tests, builds, gates or formatter was executed. No production,
test, policy, claim or external issue/PR state was changed. The only filesystem
change is the authorized draft move and this issue Markdown. Root must fully
read the frozen file, authorize the diagnostic fixture/capture, and reconcile
the exact owner overlaps before any production writer assignment.

## Root execution receipt — unchanged nine originals

Root executed Phase 1 in L using the existing dynamic entry, one logical
shard, exact nine-path manifest, standalone/honest/auto, strict rerun always,
realm recycle, one unified worker, 3072 MiB worker/fork and 1024 MiB parent.
No production, original corpus, runner, provider or policy changed. Session2824
terminated exit1 (e1e5de), reflecting two genuine conformance failures.
Completeness validation ba24d3 passed: COMPLETE1shard9verdicts9registered,
zero explicit exclusions. All nine rows reached the test with oracle14,
auto providers and strict=both. Actual result is 7PASS/2FAIL/0compile_error/
0skip; proxy-class and not-a-constructor retain the exact errors listed above.

Retained JSONL in L:
`benchmarks/results/es2015-6929-function-original9-7d9-20261009-results-20261009152515001.jsonl`,
SHA256 `c1b28e775ddaf3f300940966dd36d78e840c963b48eaaaa803f46f53f29bba24`.
Its adjacent `.shard-1-of-1.complete.json` is actual runner completion evidence.
Exact selection `.tmp/6929-function-tostring-original9-manifest-20261009.txt`
validated nine originals, SHA256
`2a0051430c36eaa90202866d0816b21e03da8142123f3c2c9cec4f81d6e75bfd`.
Full stdout/stderr remain under `.tmp/6929-function-original9-20261009.*`.
Compiler/runtime seals remained a89ec75a/fe2df688 before and after execution;
worker/assembler seals remained be06c73b/a7a9f9a3. This is the composed L epoch,
not PR6604's separate receiver-proof epoch or a new full canonical run.

Both original failures are now reproduced on the current composition with
all seven passing controls preserved. First failing assertion/value route
still requires Phase 2 observation; source ownership remains HOLD. These
nine verdicts confer no canonical gain or full-suite completion credit.

## Source-only Phase 2 fixture handoff — root review required

Root explicitly approved this diagnostic writer after reading the full canonical
plan and executing Phase 1. This is the same issue 6929, not a new allocation or
a release of any production owner. The complete 474-line source plan above was
copied faithfully from the planner's isolated worktree; its pre-append SHA256 is
`005f6c697cc6dacb27f7704b752025747ef8ed79a19658c0b14c5aa8b55e24ff`.
Planner worktree and older frozen records remain untouched.

Owned isolated checkout:
`/Users/thomas/.codex/worktrees/6929-function-first-failure-sol61/js2`.
Actual starting HEAD:
`7d9e8ce3c6efcd4ebcfca6e14e8f895a69e9ae18`, initially clean. No production from
composed L was copied. Root will integrate ONLY the new fixture into composed L;
the captured bundles and source seals must belong to L's actual epoch.

New fixture:
`tests/issue-6929-function-first-failure-diagnostic.test.ts`.
Source-only SHA256:
`311c44838927d0adc574af333cb1122decac0158418367e4ce02f603f15c989d`.
The writer has not run a parser, compiler, native execution, test, typecheck,
build, formatter, gate or install. All behavior below describes prepared source,
not an observed result. Root alone owns execution, verification and changes to
the integrated fixture. No Git publication, issue allocation or external message
occurred. Only the fixture and this one same-canonical issue file were written.

### Preserved programs and planned denominators

The opt-in switch is `JS2WASM_6929_FUNCTION_DIAGNOSTIC=1`. The source requires
`TEST262_TARGET=standalone`, `TEST262_STRICT_RERUN=always`, providers auto and the
sealed maintained worker/original-harness assembler. Corpus seals match all nine
originals, nativeFunctionMatcher and isConstructor. Normal metadata/error checks
preserve the Phase 1 statuses and exact first-error text; none is silently
upgraded by diagnostic results.

The nine unchanged originals each have a separately labelled D counterpart.
All top-level whole assertion statements are exact source slices within new
try/catch wrappers. Arguments, operand reads, callback bodies, class/proxy
construction and aliases are unchanged. The existing third sameValue argument
in not-a-constructor is preserved; no new argument is added. No operand local,
duplicate get, strict-equality substitution, abbreviated helper or annotated
JavaScript input is introduced. The second proxy-class assertion still reads
the proxy's `.apply` property, not the handler's method. The constructor sequence
still performs isConstructor first, then direct new, then assignment of the alias
and its new assertion.

The seven original passing controls are retained beside their own D variants.
A separate deliberate `assert.sameValue(1, 2)` original/D pair tests both ordinary
JS and worker/native marker bridges. Each unit uses the genuine assembler for
sloppy and strict whole-harness source. Planned denominator: 9 original identities,
7 original passing controls, 20 source units, 40 strict variants, 40 maintained
worker requests, 40 normal incremental captures, 40 emitWat captures, 40 separate
observer replays and 40 ordinary-JS reference runs. This is one Vitest fixture
registration. These are planned counts; actual settled counts remain UNKNOWN.
There are zero added canonical verdicts or claimed canonical flips.

### Custody and loader design

Per variant, the prepared source retains complete body and assembled JS, public
AST/source offsets and call/new argument slices, ordered full-harness part seals,
actual worker request and complete IPC receipt, stdout/stderr, normal binary and
metadata/import descriptors/string pool/source map, full returned normal/debug
compiler errors, explicit compiler options, debug binary and complete WAT.
Normal incremental binary and metadata identity must agree with the maintained
worker, and emitWat must preserve the normal binary. Any disagreement fails
closed as UNKNOWN. Before/after seals cover the bundles, worker, assembler,
providers/import seam, fixture and the complete bounded production dependency
inventory already listed in this issue.

Each worker is forked with actual `--max-old-space-size=3072`; root preserves its
1024 MiB parent budget. Exactly one request is sent to each maintained worker.
The source waits for its settled IPC receipt AND clean actual exit AND separately
observed stdout EOF AND stderr EOF before normal/debug capture, replay or another
unit. The composite ChildProcess close event is recorded, not a prerequisite.
Timeout/error retains child PID and UNKNOWN custody, throws out of the entire
capture, and starts no next heavy operation. It does not kill, restart or raise
the heap. Counts for maintained-worker internal compile/init calls remain
explicitly UNKNOWN because its implementation is unmodified. Actual observer
replay counts are recorded separately and cannot stand in for worker counts.

The Map observer writer and root supplied loader evidence during preparation.
Direct compiler-bundle dynamic import under Vitest killed the root's 1024 MiB
parent before any worker; a subsequent constant Function-body dynamic import
failed `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` before any worker. This fixture
uses root's latest `node:vm.compileFunction` constant `return import(specifier);`
body with `constants.USE_MAIN_CONTEXT_DEFAULT_LOADER`, and passes the exact file
URL as its parameter. No bundle text is rewritten/evaluated, URL query is added,
namespace is cloned, compiler option is altered or heap is raised. It records a
pending loader receipt before import, exact before/after bundle SHA, actual ESM
namespace brand, full export-name/type inventory and required callable guards.
Compiler requires compile/compileMulti/createIncrementalCompiler. Runtime requires
buildImports/instantiateLinkedProviders/wireCompiledInstance and is passed as its
original namespace to the maintained instantiation seam. Loader success and
main/VM realm compatibility still require root execution; no success is claimed.

Replay copies bytes into a genuinely owned Uint8Array, validates the actual
returned WebAssembly.Instance and uses maintained imports/sandbox policy,
setInstance and optional deferred __module_init. It never assumes main/test or
setExports. Native exception tag/payload/rendering and actual phase are captured;
opaque payload identity is not invented. Module imports and actual runtime
namespace inventories are retained. All counts and exceptions from this replay
are separately labelled observer evidence.

### Interpretation and review gate

A D marker identifies a candidate whole statement only: failure could occur
while evaluating its operand or invoking the assertion, and its catch replaces
the original error object. First site, destructive producer, root cause,
original/D route parity and canonical gain all remain UNKNOWN. Passing bridge
controls or complete 40-unit capture cannot prove route parity. Root must inspect
the complete finalized WAT for the original and D counterparts, including both
class carriers, ProxyCreate capability bits, coercion/method receiver routes and
the actual constructor metadata/classifiers/guard drivers required above.

Source-only work is frozen for root review. Production remains HOLD for active
5269/6775/4492/5383/5197/6770 ownership plus the existing 5140 reservation. No
release, repair reservation, first-loss attribution, nine-row gain or full-suite
completion is inferred from this fixture. The retained fresh canonical prefix
result remains COMPLETE 7PASS/2FAIL/9, JSONL SHA256
`c1b28e775ddaf3f300940966dd36d78e840c963b48eaaaa803f46f53f29bba24`.
The retained whole canonical population remains 11,575PASS/189FAIL/14CE of
11,778 originals, all 74 Intl retained, pending an actual new root full run.

## Source-only lifecycle refinement after root Map evidence

Initial Function fixture freeze SHA256 was
`acac915c2b94c566afede7ecb276d404695b52f486968d7f5a6b623bc763b3f0`.
Root fully read that freeze. Root's separate Map capture session47463 terminated
exit1 at the 120-second observation timeout (terminalc025a1): child44469 had sent
the genuine original FAIL and had an actually observed exit(code0, signalnull),
but the composite ChildProcess close event never arrived. Root's escalated
process read 1e8050 confirmed child44469 and parent44445 were gone. No additional
normal/debug compile, replay or next unit had started in that capture. Root's
Map compiler loader did return the actual unchanged ESM namespace with matching
file SHA; this is a loader observation in the Map fixture, not execution of the
Function diagnostic or proof of its replay's realm compatibility.

Root authorized only the Function lifecycle-gate refinement, coordinated with
the Map writer. The amended source installs independent child exit, close,
disconnect and error listeners plus both streams' data, end, close and error
listeners immediately after fork, before the first request. Completion requires
one settled request, actual clean exit, BOTH actual stream end events (EOF/data
consumed), and zero child/stream errors. Stream close is separately recorded;
close before end fails UNKNOWN. Missing streams fail UNKNOWN. Composite child
close and disconnect flags remain evidence but do not substitute for EOF.
Custody/output are persisted on every observed transition, including after a
timeout. Timeout retains PID, rejects the complete capture and refuses late
ready/send; no kill/restart or subsequent heavy operation is started. Receipt,
exit alone, readableEnded state or absence of a process never infer drain.

The aggregate settled count is now named workerCleanExitAndOutputEOF to describe
what it actually observes. No request, input, loader, namespace, compiler option,
sourceMap string identity check, 40-variant population or production code changed.
This updated source-only fixture is frozen with SHA256
`311c44838927d0adc574af333cb1122decac0158418367e4ce02f603f15c989d`.
The writer again performed reads/patches/hashes only. First site, cause, route
parity, marker-bridge validity, settled diagnostic count and gain remain UNKNOWN;
root owns the next review and serialized execution.

## Root integration and live diagnostic capture

Root integrated only the reviewed source-only Function fixture into the latest
composition worktree. Formatting and scoped lint passed (d1d125). Formatted
fixture SHA256 is
`8bb3317b32b80c690afb1a7fb8ed4868d764b29d76a6483327db412e64e59769`.
Focused TS7 check session54397 terminated exit1 (6ed30e): no fixture errors,
but six existing maintained harness/runner errors remain. This is not a green
typecheck. Maintained modules were not altered to hide them.

After Map session19695 settled exit0, root started serialized Function
session89686 (8d934e), parent1024MiB/worker3072MiB, pool1/maxfork1,
standalone/honest/auto/strictalways/recycle. Custody:
`/Users/thomas/.codex/worktrees/6878-latest-composition/js2/.tmp/6929-function-first-failure-xuyqPb`.
Logs: `.tmp/6929-function-first-failure-EOF-20261009.stdout` and `.stderr`.
Actual registration has nine originals, seven passing controls,20source units,
40strict variants and40plannedworker/normal/debug/replay/reference operations.
At the first progress read four cases had settled with all six observed counts4
and validityErrors[]. The process was confirmed live by its same handle. This
is pending diagnostic evidence, not terminal acceptance or canonical gain.

## Root settled Function capture

Same session89686 terminated exit0 (69d15f). Actual custody summary SHA256
`c8f584ac665dd966271d7996a8a43ed1425a1cd245672123a0f0538c2cab6947`;
40planned/40settled/40unique labels, all six observed operation counts40,
validityErrors[]. All40 normal/debug/metadata identities true; all workers
have observed clean exits and both output EOFs. Twenty-eight passing-control
variants PASS; both original failure identities in both modes retain the
canonical errors. Proxy-class D candidates are site1 in both modes; constructor
D candidates site3 in both modes. Four intentional negative bridge variants
fail as intended; reference36completed/4negative throws. Vitest diagnostic
1PASS took211.35s, total223.89s. This is not40canonicalPASS or any gain.

Root assigned full original/D strict/sloppy route analysis to an isolated
Sol6.1 agent before attributing first loss or authorizing production fixes.
First-site proof/root cause remain pending the emitted-route comparison.

## Sol6.1 emitted-route freeze: original/D, strict/sloppy (2026-10-09)

Read-only analysis completed in isolated managed worktree
`/Users/thomas/.codex/worktrees/6929-function-route-analysis-sol61/js2`.
The 654-line canonical record above was copied faithfully before this append:
both copies had SHA256
`640f2caaa5b5998625ae7995474914972efc047d630905ff993aeda032444ffb`.
No production edit, compiler/parser execution, test, typecheck, build,
formatter, commit, push, allocation, or owner release was performed here.
The evidence below is the already sealed session89686 capture at
`/Users/thomas/.codex/worktrees/6878-latest-composition/js2/.tmp/6929-function-first-failure-xuyqPb`.
Each cited WAT line is in the named case directory's `full.wat` and is a
textual line, not a binary byte offset. Function numbers below are the
zero-based top-level WAT function order, not the emitter's export labels.

### P: concrete inherited-brand loss, then destructive string conversion

The original first statement remains
`assertNativeFunction(new Proxy(class {}, {}))`. The helper retains its real
`var actual = "" + fn`; no substitute direct toString call was analyzed.
The first target is the exact type78 class-constructor singleton global30;
the second statement uses the distinct type81 singleton global32 and reads
`.apply` from a Proxy whose handler only has an apply trap, not a get trap.

For original sloppy, the concrete route is:

- Module-init function1069 at292922 materializes the singleton, handler and
  Proxy. The first statement core293400–293516 matches D293407–293523's
  117 instructions after indentation/global-initializer reference mapping.
  Strict original293420–293536 likewise matches D293427–293543.
- ProxyCreate339 at145410 sets proxy type126 field5 from typeof_function80
  at9446. That classifier explicitly recognizes globals30/32; field5 is
  true. The Proxy therefore is callable, not an arbitrary-object receiver.
- Matcher1057 at263528 sends the original proxy through __to_primitive208
  at113482 and __class_to_primitive204 at103657. The runtime method walk
  probes valueOf then toString with __extern_get168 at75248.
- Proxy get dispatch318 at142676 has no get trap and delegates through
  ReflectGetReceiver169 at86393, retaining the original proxy receiver.
  ClassProtoLookup1297 at390519 returns null for exact globals30/32, correctly
  not borrowing their instance prototypes. The class own-key cases do not
  supply valueOf/toString. The remaining inherited lookup asks
  __protoidx_brand_off148 at23494.
- That brand classifier's Function arm consults __is_closure_prop_carrier107
  at15527, which does not recognize types78/81. Thus the exact callable class
  singleton is classified as Object offset18, not Function offset19. This is
  the first concrete wrong inherited classification in the captured route.
  __protoidx_get_k145 at23382 retrieves the real Object companion methods.
- Object prototype seed598 at186987 binds toString ref.func592 and valueOf
  ref.func593. Method-call driver167 at75070 passes the original receiver
  in the method receiver slot. valueOf leaves the proxy unconverted;
  Object.prototype.toString592 at185948 sees proxy field5=true and creates
  global616, the string `[object Function]`. This is the first destructive
  primitive producer. It occurs inside __to_primitive, before the later
  addition residue can use the original function value.
- The existing __extern_toString211 at118364 already handles callable proxy
  type126/field5 and would return global657, `function () { [native code] }`.
  Adding another native-string arm there would not recover a proxy that has
  already become the primitive global616.

Source seam: `src/codegen/proto-index-store.ts::fillBrandOffBody`1064–1110
supplies only `isClosureCarrier` for the final Function arm (resource1104).
`src/runtime/wasmgc/values/prototype-receiver-bodies.ts::buildPrototypeBrandOffsetDefinition`
299–315 puts fnctor instances into Object, then closure carriers into Function,
then defaults to Object. The exact class-constructor identity admitted by
typeof_function is absent from this classification. The method walker in
`src/codegen/class-to-primitive.ts::buildClassToPrimitiveRuntimeWalk`481
consumes this wrong lookup; it is not the demonstrated first-loss classifier.

Bounded P next investigation: add a narrowly planned exact class-constructor
identity arm at inherited-brand classification, preserving native-prototype,
wrapper and fnctor-instance precedence. Do not widen the shared expando-bag
carrier predicate or equate all callable/constructible values with classes.
Reconcile the actual proposed hunks against active owners before editing.
The second `.apply` statement was structurally inspected, including the same
class singleton, handler, ProxyCreate and lookup key. D catch locals shift its
local numbers, so its full instruction span was not proven text-identical.
It does not execute after site1 fails; its actual dynamic result and any
second-site improvement remain UNKNOWN, not a promised PASS.

### C: aliased construction is erased; source admission cause UNKNOWN

The unchanged body keeps all three assertions and the original third
assert.throws argument. D reaches site3 in both modes after the actual first
two assertions. Original sloppy's method singleton is global635, initialized
with ref.func564, arity0, null bag, state0, builtin id357 and struct.new356.
Its type356 (`__builtinfn_meta_357_struct`, subtype88) is not a constructible
closure family. The actual alias publication stores that same singleton to
global29 (`__mod_toString`) and the global-object binding; D does likewise.
No missing-method-metadata diagnosis is supported by this capture.

- ReflectIsConstructor321 at81771 rejects type356. isConstructor86 at6566
  executes that check and catches the real TypeError, returning false.
- Direct-new callback592 at130574 emits the real TypeError throw (call68,
  throw0). Its diagnostic counterpart130577 differs only in the global
  reference for the same decoded `is not a constructor` message.
- Aliased-new callback593 at130580 is, in its entirety, `ref.null extern`
  followed by `drop`. D130583, strict original130600 and strict D130603 have
  the exact same body. There is no alias read, constructor predicate, native
  method invocation, argument evaluation, constructor driver or throw.
  The loss is before runtime: the `new toString()` expression has been erased.
  assert.throws565 at103132 invokes this callback and gets no exception.
- Native Function.prototype.toString564 at103117 still has its actual
  receiver check and native-function string return. The alias never reaches
  it or any guard; changing its metadata cannot repair the absent expression.

Source candidates were reviewed, not claimed proven: new-super.ts has native
value-construction admission3850–3915; `compileNewExpression`6490; the
`if (!className)` gate7595 and existing standalone statically nonconstructable
identifier guard7633–7635; dynamic-any admission7981/8007; and terminal unknown
constructor/import fallback8112–8113. non-constructable.ts197–202 already
contains the matching ambient `Function.prototype.toString` initializer proof.
However, the actual checker symbol/declaration/type fact, computed className,
and branch return trace were not captured. Whether this proof is reached,
whether the alias binds to the intended variable declaration, and which
source branch produces the null result are UNKNOWN. Do not move a guard or
reject all builtin values based only on this emitted symptom.

Bounded C next investigation belongs to the sole heavy executor: retain the
unchanged canonical body and trace only callback593's NewExpression through
checker symbol/valueDeclaration, initializer, type fact, computed className,
nonconstructor proof and native/dynamic/fallback admission results. Identify
the first source branch that returns null before proposing a narrow patch.
This is an investigation request, not permission to execute or edit here.

### Original/D parity coverage and limits

For each mode separately, complete emitted P function bodies were compared
for indices80,107,1297,148,145,168,169,318,208,204,167,211,592,598,1057;
all fifteen comparisons agree. Complete emitted C function bodies were
compared for80,86,321,564,565,592,593; all seven agree. Comparisons that required
global-number normalization mapped references to their complete serialized
initializer definitions with names removed; this proves emitted initializer
parity, not runtime equality of arbitrary mutable globals. P matcher1057 and
C erased callback593 were exact text matches, without that normalization.
Full module-init bodies are not identical because D legitimately introduces
outer catches, locals and markers. The first P statement's bounded core was
matched separately; C's actual published singleton and callback statements
were inspected in full. No aggregate module byte-equivalence claim is made.

The sealed normal/debug binary and capture-metadata identities for all40
variants remain the root's independent custody evidence, not a consequence
of these source comparisons. Both modes show the same first-loss mechanisms.
This freezes first emitted loss for P and C, but only P has a concrete source
classification omission. C's responsible source admission branch remains
UNKNOWN. No fix or canonical gain is claimed: fresh original controls remain
7PASS/2FAIL and the established full baseline remains11575PASS/189FAIL/14CE
out of11778 with all74 Intl entries retained.

## Root genuine constructor admission observation — 2026-10-09

Root added an opt-in test-only exported emitter/guard call-through fixture in
the latest-composition checkout: tests/issue-6929-constructor-admission-diagnostic.test.ts.
The original retained assembled source/options are unchanged. Both original
functions run exactly once per observed call, with untouched return objects.
No production tracing API, rewritten source, alternate verdict or predicate
substitution is used. The initial run failed2/2 solely because its observation
floor incorrectly expected one emitter invocation; actual compilation has two
visits to the same original AST site. That failed receipt is retained.

The corrected run session95544 terminated exit0:2PASS/2,17.29s. Scoped formatter,
lint and focused TS7 also passed (type session2291 exit0). Per mode there are
two emitter calls, one unique NewExpression AST and two genuine static admission
guard calls. Both guard results are false. Checker symbol declarations contain
ONLY ambient lib.d.ts `declare function toString(): string;`, not the script
variable initializer Function.prototype.toString. Actual new type is any; no
class/extern-class/constructor-cache registration is present. Emission returns
externref and emits only ref.null.extern. This supplies concrete evidence for
the alias-proof miss through the ambient symbol, not permission for a spelling
heuristic or a global constructability widening.

Normal source compilation, observed source compilation and sealed worker binary
are asserted byte-identical. Sloppy SHA256 d70d9d14c18b00b1027b5412e55b2f98af0f58ab2c0878d2bd585a2f22bf29da;
strict e5340dc863d2733d1e19efe61e6c5ad360f3b8942588cfa33ee73104d9e0d4e9.
Logs: latest-composition/js2/.tmp/6929-constructor-admission-guard-20261009.stdout
and .stderr; earlier failed floor logs omit `-guard` in the same filenames.
Internal branch-return trace beyond these exported boundaries remains UNKNOWN.
Next implementation plan must recover the real original lexical declaration
identity while preserving legitimate constructors, reassignment/escape and
ambient shadowing controls. No production repair or canonical gain is claimed.


## 2026-10-09 Astra constructor-alias implementation packet (source-only; not implemented)

### Record preservation, measured inputs, and checkout distinction

This section is appended to the exact 851-line canonical record supplied by the
root. Its prefix SHA-256 is
`65c397b7aa2dae919454543d6376ed3fd40ed543523626f9074bc51e6da27d15`.
No earlier diagnosis, failing row, assertion, denominator, or ownership note is
replaced. This remains issue 6929, **ES2015 standalone: attribute and repair the
two canonical Function.prototype.toString residuals**. No new allocation.

Owned planning checkout:
`/Users/thomas/.codex/worktrees/6929-constructor-alias-plan-astra/js2`.
It was created from `e4c3e3cf040129a98efb90e07a2fe025cbcade96` and is ONLY a
destination for this record; its older source is NOT the measured source and
must not be used as an implementation base without reconciliation.

Source citations below are to the root's actual measured composition:
`/Users/thomas/.codex/worktrees/6878-latest-composition/js2`, HEAD
`7d9e8ce3c6efcd4ebcfca6e14e8f895a69e9ae18`, with the root's existing unrelated
dirty changes preserved. The two relevant production files were clean there:

- `src/codegen/expressions/non-constructable.ts`: SHA-256
  `83b8ac83a7df0510f9d0f85991b6f39b1bd52b8264d9ae6a435ffdc20e4ca56f`.
- `src/codegen/expressions/new-super.ts`: SHA-256
  `cd2870b7016cd0b9e1009ba69f991526b36aec990b6831195963c9f4d92d07c6`.

Read the complete genuine diagnostic fixture
`tests/issue-6929-constructor-admission-diagnostic.test.ts` and stdout
`.tmp/6929-constructor-admission-guard-20261009.stdout`. The recorded 2/2 PASS
are diagnostic acceptance, NOT corpus PASS. For each mode, two genuine exported
emitter calls share one original NewExpression, the real static guard returns
false twice, and the real checker reports only
`lib.d.ts: declare function toString(): string;`. Each emitter returns externref
with exactly one `ref.null.extern`. Baseline, observed and sealed-worker bytes
match within each mode. No interior return-branch trace has yet been measured.
Original C remains a canonical failure until a new worker run proves otherwise.

### Decision: recover binding identity, not a false static lifetime proof

A mechanical change from `checker.getSymbolAtLocation` to the in-house binder in
`classifyNonConstructableValue` is NOT the approved plan. At line 197 the existing
initializer arm regards an ambient `X.prototype.member` initializer as provably
non-constructable, without proving that the binding or prototype member retains
that value. Exposing new aliases to that arm would introduce static throws for
potentially reassigned constructor values. It would also change its four codegen
consumers, including exclusions from constructable-value routes.

The bounded recommendation is a distinct, explicitly weaker fact:
**this original identifier has a real source-local variable binding whose
runtime value needs constructor dispatch, despite an ambient-only checker
answer**. It says nothing about whether the current value has [[Construct]].
Read that current value and use the already existing native construct driver.
Do not add `toString`, or any alias spelling, to a global non-constructor set.
Do not move the static guard, synthesize a declaration, overwrite the checker
symbol, change oracle-wide declaration lookup, or re-evaluate the initializer.

### Proposed two-file production ownership and first implementation gate

The next Sol 6.1 implementer owns ONLY the following production responsibility,
in a fresh managed implementation checkout rooted in the root-approved current
composition (not this planner's old base):

1. A small, separately named identity-recovery query in
   `src/codegen/expressions/non-constructable.ts`, alongside—not inside—the
   existing static classifier. Prefer reusing `binderFor`/`sourceFileOf` from
   `src/checker/binder.ts` as read-only lexical machinery. Do not modify that
   shared binder or either TypeOracle backend.
2. One narrow standalone admission in
   `src/codegen/expressions/new-super.ts:3854`
   (`tryCompileNativeConstructFromValue`), in the existing runtime-value
   admission check around lines 3871–3914. The outer caller at 7522 already
   admits the canonical identifier. Keep all existing class/fnctor exclusions,
   native-first host behavior, bound/proxy/provider admissions and guard order.
   An explicitly named boolean beside `dynamicCtorValue` is clearer than
   silently weakening `resolvesToDynamicAnyCtorValue` for every consumer.
3. A new regression fixture under `tests/issue-6929-...test.ts`, and this canonical
   record. Existing root diagnostic fixtures and saved captures are immutable
   evidence; no editing their expectation floors to manufacture acceptance.

Before changing production, the implementer must prepare a root-run, test-only
identity observation on the **actual original AST** used by the genuine emitter.
Report the checker declaration and the lexical result side by side, with
`lexical.valueDeclaration === original VariableDeclaration` object identity,
source file identity, scope, declaration list and reassignment flags. Confirm
the recovered initializer is the original `Function.prototype.toString` AST.
The observation must call the original emitter once, return its original result,
and preserve sealed-worker bytes. No substituted symbol or hand-parsed replica
counts as this proof. If the lexical binder does not identify this declaration,
stop and report the actual result; do not replace this gate with a name scan.

### Recovery contract and conservative refusals

- Accept only an original identifier reference (transparent wrappers may be
  unwrapped without manufacturing AST nodes), with a real non-declaration
  SourceFile and valid parent chain. Reject synthetic/detached nodes.
- Enter recovery only when the checker has no source declaration and reports
  ambient declarations only, or genuinely no declaration. Any real checker
  declaration keeps its existing path; a disagreement between two real source
  declarations is UNKNOWN, never permission to pick one.
- Resolve the reference through the nearest actual lexical scope using the
  original SourceFile binder. Require one plain, initialized VariableDeclaration
  in that same source file, non-destructured, not an import/parameter/catch/class/
  function binding. Return that declaration identity, not its text as a key.
  Duplicate declarations, ambiguous merges and Annex-B block-function ambiguity
  are declined in this first packet.
- Bound the initial shape to an initializer reading a prototype member
  (`Root.prototype.member`, with only transparent wrappers). Prove the initializer's
  `Root` has no competing source-local lexical binding and has actual ambient
  checker provenance. A missing root symbol is not positive intrinsic evidence.
  Do not accept arbitrary `foo.prototype.m` just because `foo` is unresolved.
  The query is intentionally independent of the alias's spelling.
- Reject references whose scope chain crosses a `with` body and source scopes
  affected by direct eval where lexical identity cannot be guaranteed. Do not
  follow imports, exports, dynamic global-object properties or alias-of-alias
  graphs as declarations. Record these refusals explicitly in query tests.
- A read-only query must NOT confuse single declaration with single assignment.
  Binding assignment, captured writes, argument-time writes, and mutable
  prototype properties do not make the initial value permanent. Either keep
  such a successfully recovered binding on the runtime-value route (preferred),
  or decline the recovery with an explicit reason; never upgrade it to the old
  `"provable"` result. Runtime dispatch is what permits supported mutations.
- Only the native standalone/WASI admission consumes this fact. Preserve all
  host-lane behavior. The identity-query result must not populate classSet,
  externClasses, funcConstructorMap, oracle caches, or non-constructor sets.

The exact eligible scope breadth should remain the smallest needed for the
original script variable captured by the harness callback. Nested bindings are
primarily refusal/shadowing controls, not an invitation to broaden constructor
inference. Existing runtime paths still own non-colliding local aliases.

### Runtime emission and ABI requirements (reuse, do not rewrite)

`new-super.ts:3982–4118` already reserves and arms the native driver, evaluates
the callee into an externref local first, then evaluates each argument exactly
once in order, then calls `__native_construct_N`. Preserve these instructions and
the existing runtime-argv path for spreads; do not replace it with
`emitStaticNotAConstructorThrow`, whose compile-and-drop loop is not an arbitrary
spread iterator implementation and omits the recovered binding read.

The driver invokes `constructIsConstructorGuard` in
`src/codegen/native-construct.ts:410,727`. Its per-context guard is armed during
ordinary emission by `armConstructIsConstructorGuard`, not during finalization.
`src/codegen/reflect-construct-native.ts:225` fills the existing IsConstructor
predicate. Saved C evidence already proves the builtin singleton is rejected by
that predicate; candidate emission must show the actual stored singleton flowing
to this driver. Do not assume an inferred type name implies the same value.

Preserve callee-before-arguments behavior if an argument reassigns the alias.
Preserve argument side effects and abrupt completion before the TypeError.
Preserve callable/constructible distinction, real native TypeError identity,
normal constructible returns, new-target/prototype behavior and class/bound/proxy
driver arms. No new runtime helper, host import, boxing scheme, closure type,
carrier ABI, runtime constructor table entry or singleton metadata change is
authorized. If existing driver support is inadequate for a new control, report
that separate defect before broadening runtime ownership.

### Readers, mutators, and lifecycle audit

This packet introduces no shared registry write and does not migrate state.

- The unchanged static classifier is read by its two exported wrappers.
  `new-super.ts:574,647` uses the non-constructable wrapper to exclude values from
  other constructable routes; lines 7633 and 7637 consume respectively the static
  and host-probe wrappers. Their semantics remain unchanged. Do not feed the new
  recovered initializer into them.
- `resolvesToAmbientGlobal` is also imported by builtin constructor invocation,
  host-callable initialization, standalone unavailable globals, property dispatch,
  builtin prototype constructor, promise/static-call TypeError analysis,
  standalone queueMicrotask, error-prototype toString and namespace-static calls;
  it is re-exported from new-super. Leave it unchanged.
- `FileBinder` owns scope creation, `declare`/`declarePattern`, deferred target
  recording, and `applyPendingWrites`; the latter resolves assignment, compound,
  update and loop targets after declaration collection. `resolve` reads the nearest
  scope and memoizes by identifier. `binderFor` caches by SourceFile identity in a
  WeakMap. InHouseOracle is the existing semantic consumer; the new query is
  read-only. The caller must not mutate the returned Binding/declarations.
- Binder bookkeeping does not model property mutation, dynamic eval/with or
  arbitrary global-object writes as ordinary identifier writes. Therefore
  `!binding.reassigned` is NOT used as a lifetime proof of the builtin value.
  The runtime value is authoritative. Replaced incremental SourceFiles get new
  binder entries; never introduce filename/name-only caching.
- TsCheckerOracle caches declarations/value declarations by node and currently
  delegates to the checker (`oracle.ts:408–484`); merely calling
  `ctx.oracle.declarationsOf` does not solve the measured checker-backed collision.
  Neither these caches nor InHouseOracle's existing contract are changed.
- Existing driver reservation writes funcMap/functions and
  `nativeConstructProtoKey` (fixed arity at native-construct:188–204; argv at
  225–239). Driver filling reads those keys (347,519) and the complete closure/
  class/proxy/bound metadata. Existing reserve/flush/fill ordering is retained.
  The new admission must pass the real fctx to reservation/late-index flushing,
  not cache function indices before imports shift.
- `armedThrow` in construct-is-constructor-guard is a module-private WeakMap keyed
  by CodegenContext: arming reads/sets it once, emission reads it, and no shared
  cross-module flag is added. The native driver already clones throw instruction
  templates where necessary. Do not move it into generic constructor facts.
- The actual alias storage writer is the original module initializer; existing
  identifier read/assignment/property/closure code remains its owner. Candidate
  tests must verify the dispatcher reads that live slot, including argument-time
  and captured writes; a syntax-derived constant would violate this contract.

### Concrete ancestry and collision handling

The measured files are not locally dirty. Classifier lookup lines 152–156 come
from published `f0a57d51e7c`; the dynamic admission includes published hunks
`3b02cba60e5`, `ae337920432`, `33aee1c8eab`, `69a5275b4e4`,
`5dca11720b4` and `6debb018392`. The last two own Function/bound-Function dispatch
around the exact admission hunk; preserve them, do not overwrite with an older
file. The root's dirty array/numeric/property-dispatch work does not overlap
these two clean files. Active issue names alone are not whole-file locks.

Before writing, compare the implementer's exact base/diff with these hashes and
the latest root composition, then reconcile only concrete overlapping edits with
their owner. The human's IR work is outside this packet. Do not edit IR,
TypeOracle, binder, runtime driver, construct guard, corpus, harness, scripts or
CI. The compiler boundary inventory currently labels binder `unmigrated`,
frontend-ts-owned; any architecture ratchet objection to importing the existing
binder must be reported for root review, not bypassed by weakening the ratchet
or silently changing migration ownership. A new boundary allowance is not
pre-authorized here.

### Required test packet and causal attribution

Root owns all execution. Sol prepares source/test changes and exact commands;
no independent heavy runner, compiler, parser, native process, build, TS or
formatter execution in the planning lane.

1. **Identity diagnostic:** original C sloppy/strict, preserving byte identity
   before production change; true original lexical declaration identity must be
   observed. Include one genuine non-colliding constructor positive control so
   an empty/unvisited query cannot pass.
2. **Canonical path:** unchanged worker `not-a-constructor.js`, both modes, with
   all three original assertion calls and messages intact. Require runtime
   TypeError at alias `new`, not just a changed compile result. Run all nine exact
   canonical prefix files with count/completeness/duplicate/path checks and save
   actual JSONL/errors. The existing seven PASS are mandatory positive controls.
   `proxy-class.js` remains in the denominator and in the record as the independent
   unresolved P defect; never skip it to report a green prefix.
3. **Focused native alias matrix:** original-style `var` captured by an assertion
   callback; same-value parenthesized alias; differently spelled alias; zero and
   side-effecting argument lists; argument throws sentinel before any TypeError;
   runtime-array spread with element/order observations; alias reassigned to an
   ordinary constructible function before use; captured setter reassigning it;
   argument-time reassignment (old callee still selected); prototype member
   overwritten before alias capture versus after capture; descriptor/getter
   mutation before capture; alias escaping through an object/call then updated.
   For mutations, assert successful constructor body/return identity where
   required, not merely “does not TypeError”. Report unsupported cases as failures.
4. **Shadow/refusal controls:** source function/class/parameter named `toString`;
   nested `let`/`const` shadows and sibling same-name bindings; shadowed `Function`;
   duplicate var declarations; destructuring; unresolved identifier; `with`;
   direct eval; imported binding; sourceFile replacement in repeated incremental
   compilation. Query-level refusals must leave existing paths unchanged, not
   turn unresolved values into static throws. Include native passing constructors,
   class/bound-function controls and host-lane before/after bytes or runtime PASS.
   Do not claim a refused pre-existing failing behavior fixed.
5. **Actual output:** inspect candidate original C callback instructions: stored
   runtime alias read, argument evaluation, driver call, genuine predicate/throw;
   no lone null fallback and no constant forced TypeError. Normal/debug binary
   identity and strict/sloppy source/options/path fingerprints remain explicit.
6. **Attribution:** same base/config/worker/harness and exact source set for
   candidate → remove ONLY the new admission (keep identity query/test fixture)
   → restore. C must regain its actual prior failure on removal and its actual
   candidate result on restoration; all seven passing controls must persist.
   A/B identity-only removal is an additional useful check, not a substitute.
   Save source hashes and actual denominators for every stage. A one-shot compile
   alone is not authoritative replacement for the original incremental worker.

No numerical gain is asserted by this plan. If C passes and P does not, the
anticipated *acceptance target*, not a measured result, is 8 PASS / 1 FAIL / 9
canonical files. Full ES2015 improvement can only be claimed after the root's
real complete run. Preserve all focused failures and pre-existing P evidence;
no green PR/finished-issue claim until the required actual acceptance exists.

### Freeze and readiness

This is a bounded Sol implementation packet with one mandatory empirical gate:
prove the existing lexical binder returns the real original variable on the
genuine worker AST before applying the runtime-admission change. The suitability
of the runtime path is supported by source and saved predicate evidence, but its
new admission, side-effect controls and canonical outcome are UNMEASURED.
If that gate fails, return evidence rather than widening by spelling or adding a
synthetic declaration. No production/test fixture was edited by this planner,
no heavy execution was performed, and neither C nor issue 6929 is marked fixed.


## Sol6.1 source-only constructor lexical identity fixture handoff (2026-10-09)

Root requested the first empirical gate from the Astra packet only. No production
implementation is released by this handoff. The complete 1,137-line canonical
record above was copied faithfully from the planning checkout, with prefix
SHA256 54236f0c9f5b357bd3338550ff5e91e400c1c220e8c1407502ffaeacd5c51314.
The planner's record, both existing root diagnostic fixtures and all retained
captures remain untouched.

Owned managed checkout:
/Users/thomas/.codex/worktrees/6929-constructor-lexical-identity-sol61/js2.
Actual HEAD is 7d9e8ce3c6efcd4ebcfca6e14e8f895a69e9ae18, detached; no branch
was created or mutated. Its source is the clean recorded HEAD, NOT root L's dirty
composition. Only the new test fixture and this canonical-record copy are owned.
Root must integrate ONLY the new fixture into actual L before executing it.

New fixture:
tests/issue-6929-constructor-lexical-identity-diagnostic.test.ts.
Source-only freeze SHA256:
0176b3e08833bfaaf305b0abcac9b8cc8b077be1e483219a6ec6d6b8a12d0e70.
The source was prepared and read back without a parser, compiler, native process,
test, typecheck, formatter, build, gate or install. No issue allocation, Git
publication, claim mutation or external message was performed.

### Prepared observation and falsifiability

The opt-in switch is
JS2WASM_6929_CONSTRUCTOR_LEXICAL_IDENTITY_DIAGNOSTIC=1.
It requires standalone/auto/strict-rerun-always and source/bundle/worker seals
matching the already retained root composition capture. The unchanged original C
strict and sloppy assemblies, options and saved normal.wasm files are read from
L/.tmp/6929-function-first-failure-xuyqPb. The original corpus SHA remains
52c3c2aa9b4557c99712505a914eb32b8026c087349dc453bec288e5302b91f2.

Each observation intercepts the genuine exported compileNewExpression only at
the sealed source-coordinate NewExpression. It obtains sourceFileOf on that
actual emitter AST and asks binderFor(originalSourceFile).resolve(originalId).
The expected declaration is the actual SourceFile statement's sole
VariableDeclaration at the sealed source offset, not a reparsed declaration and
not a source-name scan used as lexical resolution. The actual binder result is
compared by object identity to that original declaration and initializer.
Nearest-scope chain, resolved binding scope, SourceFile identity, declaration
list, reference position, original tree bounds, reassigned/incremented/opaque
write flags and assigned RHS nodes are serialized beside the genuine checker
declarations/valueDeclaration. The original Function.prototype.toString
initializer's property-access AST and its Function root's ambient checker
declarations versus absence of a lexical root binding are recorded.

The intercepted emitter runs exactly once for each actual invocation, returns
its original result and leaves its emitted instruction objects untouched.
Compilation's actual visit count is recorded; it is not forced to one visit.
The floor requires at least one visit and exactly one original NewExpression AST
for each source unit. A missing binder result, wrong declaration/initializer
identity, missing ambient provenance, incomplete source population or differing
binary fails UNKNOWN and starts no later source/control operation.
No new static classifier result or lifetime proof is synthesized.

One separately labelled positive constructor control is prepared in both modes.
It retains the exact maintained whole-harness prefix and uses a non-colliding
plain var initialized with an ordinary function expression. Its new-expression
AST is observed through the same emitter/binder seam; both the checker and
binder must return the actual original variable declaration. Its maintained
worker executes construction and assert.sameValue(result.value, 41), so an
unvisited observer or a compile-only success cannot validate the control.
Original corpus bodies and saved captures are not edited.

### Planned custody, execution and limits

One Vitest registration, four labelled source units: two unchanged original
modes plus two constructor-control modes. Planned source operations: four normal
incremental baseline compilations and four separately observed compilations.
Each unit requires baseline/observed/maintained-worker binary identity.
Originals use the immutable saved worker bytes. Controls issue exactly one fresh
request each to the unchanged maintained scripts/test262-worker.mjs, using its
normal execute=true/originalHarness/standalone/auto path and identical options.
There are two planned fresh worker requests, NOT four new original verdicts.

Fresh control workers receive 3072 MiB heaps; root retains its 1024 MiB parent
budget. Each worker's listeners are installed before ready/send. Completion
requires its settled one-request receipt, actual clean exit and separately
observed stdout AND stderr end events, with no child/stream errors. Composite
close is evidence only. Timeout retains child PID/custody, rejects the capture
and starts no next heavy operation; no kill/restart or heap raise is performed.
Actual worker internal compile/lifecycle counts remain UNKNOWN.

All observation JSON, summaries, source/options, baseline/observed binaries,
fresh worker requests/receipts/binaries/metadata/stdout/stderr and lifecycle
transitions are saved in a new mkdtemp directory under L/.tmp. Before/after
bounded source, bundle, worker, assembler, immutable diagnostic and corpus seals
must match. Existing retained capture files are only read.

Suggested root execution after source review and integration, from actual L:

~~~text
JS2WASM_6929_CONSTRUCTOR_LEXICAL_IDENTITY_DIAGNOSTIC=1 TEST262_TARGET=standalone TEST262_STRICT_RERUN=always TEST262_SEMANTIC_PROVIDERS=auto VITEST_FORK_MAX_OLD_SPACE_SIZE=1024 pnpm exec vitest run tests/issue-6929-constructor-lexical-identity-diagnostic.test.ts
~~~

This is a prepared command, not executed evidence. Root owns formatting, scoped
lint/type checks and serialized execution. No compiler/runtime bundles or dirty
production files are copied from the clean diagnostic checkout into L.

Actual lexical identity recovery, positive-control PASS, settled 4/4 source
units, source/worker byte parity and the existing driver's suitability remain
UNKNOWN. Production remains HOLD until root inspects the actual gate receipts.
The current canonical prefix remains the measured 7 PASS / 2 FAIL / 9; the whole
retained baseline remains 11,575 PASS / 189 FAIL / 14 compile errors / 11,778,
all 74 Intl retained. No canonical gain or issue completion is claimed.

## Source-only error-custody refinement after root's first identity run

Root integrated only the reviewed fixture into L. Root reports formatter and
scoped lint PASS and then actual gate session60753 EXIT1, 1 FAIL / 1, 14.82s.
The retained custody is
L/.tmp/6929-constructor-lexical-identity-t75dLr.
The directly read sloppy-original/identity-observations.json contains
calls=0, uniqueSites=1, rows=[]; summary.json contains settled=0 of planned=4.
No constructor-control worker started. The observer entered an original AST
site but failed before completing a row or attempting the genuine emitter.
The old subsequent row-floor message did not expose the actual exception or
the observed compiler's errors. This is not evidence against lexical recovery
and not an unvisited-spy result; actual failure stage remains UNKNOWN.

Root authorized source-only diagnostic receipts, preserving the identity and
binary gates. The revised fixture adds per-visit stage receipts, original call
attempted/returned facts and primitive node provenance for serialization. The
unchanged nodeRecord operations now report their sourceFileOf, getStart and
getText stages. Any observer failure records its actual rendered exception,
message and stack, then rethrows. No fallback source owner or invented node is
used and no declaration/initializer expectation is loosened.

The actual returned observed compiler success/errors and binary hash/size are
persisted and printed before asserting success or the row floor. A thrown
compiler call has separate error custody. The genuine emitter call-through,
all original/control identity assertions, preserved sources/options, worker
lifecycle gates and source/baseline/observed/worker byte checks are unchanged.

Revised source-only fixture: 468 lines, SHA256
69bd3e54dba5954f62a040ce38a2f5d5a74de90e27ac298971184126f350a546.
Root's already formatted L copy has its own distinct hash; root must integrate
these precise diagnostic changes, review and execute there. The writer ran no
parser/compiler/test/native/type/formatter/build/gate/install and edited no
production. Exact serializer failure, lexical recovery and control acceptance
remain UNKNOWN; production remains HOLD and no canonical gain is claimed.

## Root integration and pre-execution receipt

Root read the complete new 388-line observer and full handoff, then integrated
ONLY the new test file into the actual dirty L composition checkout through
apply_patch. Preformat SHA matched 0176b3e08833bfaaf305b0abcac9b8cc8b077be1e483219a6ec6d6b8a12d0e70.
Binder/non-constructable/new-super seals matched the approved packet exactly.
No production, retained original capture, earlier fixture or corpus edit.
Scoped formatting and Biome lint passed; focused TS7 session 11630 exited 0,
both captured typecheck streams zero bytes. Formatted fixture seal is
1fbf788e27c95d65aea6280b5d309541b80ac138d018a1571a91c4e8dff5722b.
Execution started in root-owned session 60753 with parent 1024 MiB and
fork/worker 3072 MiB, standalone/auto/strict-rerun-always. The source-only
handoff command's 1024 MiB fork suggestion was not used. Actual identity,
control executions and byte parity remain UNKNOWN until terminal inspection.

Initial enabled gate session 60753 TERMINATED exit 1: 1 failed registration,
14.82s. Actual custody in L/.tmp/6929-constructor-lexical-identity-t75dLr:
first sloppy-original observation has uniqueSites=1 but calls=0 and rows=[];
whole population settled=0/4. This contradicts the superficial error wording
"unvisited": the spy entered and recorded a genuine site before an observer
error was caught by compilation. No positive control worker started, no source
byte parity or lexical recovery claim. Logs `.tmp/6929-constructor-lexical-identity-20261009.stdout`
and `.stderr` retained. Root asked Sol for diagnostic-only error-stage custody
before row-floor assertions, preserving all identity and byte gates; production
remains HOLD. This is instrument repair, not a constructor semantic failure.

## Source-only provenance receipt refinement after root's revised run

Root's revised gate session18762 terminated EXIT1, 1 FAIL / 1, 15.46s.
The complete directly read root log is
L/.tmp/6929-constructor-lexical-receipt-20261009.stdout;
custody is L/.tmp/6929-constructor-lexical-identity-zTGgxG.
Actual observed compilation success=false, binary length=0. Two attempts
share one NewExpression AST and both stop at original-source-provenance,
before any genuine emitter call attempt. The error stack names the source
provenance guard. No nodeRecord serializer operation was reached.
Lexical recovery and positive controls remain unmeasured.

Root requested diagnostic facts before that unchanged guard. The source-only
fixture now records sourceFileOf presence, file/declaration status, text
SHA/length/equality, and the genuine expr.getSourceFile result with exact object
identity comparison and any actual method error. Requested source SHA/length,
actual ctx.sourceFile presence (without inventing a context field), callee
kind/identifier status/parent identity and the complete bounded parent chain
are recorded. Parent-chain entries contain real node kind/position/flags,
source-file result identities and actual source-file text seals. Cycle,
termination and truncation facts are explicit. Missing values do not become
positive identity evidence.

Per-attempt provenance is persisted before the guard in a new custody file.
The guard's SourceFile text equality, declaration-file rejection and identifier
requirement are unchanged. No original source substitution, SourceFile fallback,
parent repair, parser replica, name scan or inferred preprocessor exception is
introduced. All declaration/initializer and byte-parity gates remain intact.

Revised source-only fixture: 527 lines, SHA256
eb8286b7431fa1a5101c6e30f572dd9a794599fee138a888f0248bc6ca912067.
Root must integrate the diagnostic delta into its separately formatted L
fixture and execute there. No heavy operation or production edit was performed
by the writer. The exact failing provenance condition remains UNKNOWN.

Root read the complete added provenance block and refinement handoff, then
integrated ONLY its 59-line facts-before-guard delta into the already formatted
L fixture. Actual unformatted integrated seal
6eb627b5c8252e218b1262a8537ba43e0e1fc2f519cb8a0650f470b2a004a3b1.
Binder/non-constructable/new-super production seals remain exactly unchanged.
No formatter/type/compiler execution for this refinement yet: authoritative
537-original collection sweep session96476 is live and root heavy work remains
serialized. Original provenance guard, expected identity and byte gates intact;
no production release or new passing evidence is claimed.

Root formatted/linted the integrated provenance delta; focused TS7 session29347
TERMINATED exit0 with zero-byte streams. Formatted fixture seal
adbbd5a0e07959956efcdb15f1c589f59c8eb27405143c72d00953df684d1e6f.
Actual enabled gate66431 TERMINATED exit1:1failedregistration,14.98s. Custody
L/.tmp/6929-constructor-lexical-identity-8q51ir preserves both actual attempts.
Both sourceFileOf and genuine getSourceFile return SAME original non-declaration
test.js SourceFile object; identifier/parent identity and real terminated7-node
parent chain hold. Requested and actual SourceFile texts BOTH11811characters,
but SHA1f6c0629 versus8aab66b64c6393137709f4ddbc449685c28266f65cb954a03de1bd8184e2d3a2.
Thus exact whole-source text comparison is the failing guard condition, not
absent AST provenance/serializer/binder failure. Actual compiler path legitimately
preprocesses/ground-folds/elides before language-service parsing; which transform
caused these bytes remains UNKNOWN. Population settled0/4; no controlworkers.
Root released only genuine language-service input call-through provenance
diagnostics with complete original corpus-body/identity/worker-byte gates kept;
no production/IR/parser-replica substitution or waived identity claim.

## Source-only actual incremental-input provenance contract (root requested)

Root's measured requested-versus-SourceFile text mismatch does not establish a
particular preprocessor's effect. The writer read compiler.ts:1710-1855 and
the real IncrementalLanguageService.updateSource implementation; no pipeline was
executed here. The revised diagnostic observes that genuine method on its
prototype, for both baseline and observed incremental compiles. Each actual
invocation preserves its exact this, complete argument list and processed source,
calls the original method once, and returns its original result. The original
method's actual filename/script-kind fields are recorded after return.
No shared checker, binder, query, production or IR code is changed.

The complete processed input passed by the compiler is saved verbatim per arm,
along with its SHA/length, filename/grammar arguments, actual method call
attempt/return and exact requested-versus-processed textual delta. Equal-length
differences are saved as exact contiguous differing spans; unequal-length input
has its exact replacement span plus complete processed bytes. This does not
name an unobserved transform as their cause.

Each arm requires exactly one completed genuine updateSource invocation with the
expected filename. Its complete target body (entire unchanged canonical corpus
body for originals, entire separately labelled control body for controls) must
remain byte-for-byte unchanged at its original requested-source offset.
Total source length must remain unchanged, and every actual emitter parent-chain
scope node must stay within that authenticated body or be the original SourceFile
with its exact full extent. Any body/coordinate change is a refusal, not a
waiver. The requested original source, options, corpus/assembly hashes and saved
worker binaries retain all existing seals and byte-equality requirements.

The emitter SourceFile text is now compared against the actual source passed to
its own observed compiler's completed updateSource call, not against the earlier
assembly before the compiler's processing stages. Baseline and observed service
instances must be distinct and their actual processed input bytes must match.
SourceFileOf/getSourceFile provenance, real identifier/reference and original
declaration/initializer object identity assertions remain mandatory. Neither a
reparse, reconstructed source, name scan, fallback SourceFile nor synthetic
binding can satisfy them. Existing native positive-control worker execution and
baseline/observed/worker binary parity remain mandatory.

This refinement supersedes only the previous diagnostic's unsupported equality
between the pre-processing assembly and the parsed SourceFile's whole text.
Root explicitly authorized the real pipeline-input observation and must review
the full source before execution. A changed original target body must be reported
and production kept HOLD.

Source-only fixture freeze: 641 lines, SHA256
5b25d54a6b09bc079a74430dbf622e569ac913922f904126e92862ec0e927286.
No parser/compiler/test/type/native/formatter/build/gate/install was executed
by the writer. Actual processed input/delta, original-body preservation,
declaration recovery, positive controls and all byte parity remain UNKNOWN.
No production release, constructor repair or canonical gain is claimed.

Root reviewed the COMPLETE641-line processed-input fixture and full handoff,
integrated ONLY that new diagnostic into L via apply_patch, then formatted/linted
it. Focused TS7 session27936 TERMINATED exit0, both streams0bytes. Formattedseal
a94a9abfb03d1e3ccec98cbb48ffbc7eb87f7e5b65c7a1651af84009b9a78554.
Enabled standalone/auto/strictalways gate started session24911 with root1024MiB
and fork/worker3072MiB. Original methods/target-body/identity/worker-byte gates
remain intact; no production or source capture overwrite. Results UNKNOWN
until terminal inspection; no constructor implementation released yet.

### Root terminal identity-gate receipt and source-only release

Session24911 TERMINATED exit0: 1 PASS / 1 Vitest registration, 26.40s.
This is a noncanonical instrument, not a corpus gain. Persisted custody in L:
`.tmp/6929-constructor-lexical-identity-SMzLdj/`. Summary floors planned4 /
settled4 units, each two genuine emitter calls / one original AST site; eight
identity rows total. Root inspected persisted rows and actual input receipts:
all original source/declaration/initializer identities, binding-source scopes,
target coordinates and processed-input authentication true in all four units.
Both original modes have positive ambient Function provenance; ordinary
function-expression constructor controls correctly do not assert that shape.
Before/after production seals compare byte-identical, including binder e495c7,
classifier83b8ac and new-super cd2870. Original worker-byte hashes remain
sloppy d70d9d14 / strict e5340dc8; baseline/observed/worker agree in all four
units. Control workers81267 and81281 each sent1, PASS/reachedTest=true,
exit0/no signal, stdout+stderr EOF and zero errors. These processes are terminal;
the root heavy-execution slot is released.

The empirical prerequisite in the Astra plan is satisfied. Root releases a
source-only implementation of that plan to Sol in a NEW isolated worktree;
never change the measured L composition or immutable diagnostics. Only the
separate weaker lexical identity query, narrow native runtime admission, new
regression fixture and this canonical issue are owned. No static lifetime proof,
synthetic checker/binder declaration, oracle/runtime/IR/corpus change permitted.
Root retains execution/publication custody. New-super is already8552lines;
actual formatted file and function sizes must not grow beyond the exact base
without an explicitly reviewed cohesive extraction. Do not invent grants or
trim comments. Report a necessary placement refinement before widening paths.
Canonical nine-file acceptance and mutation/refusal/native/host/causal-removal
requirements remain unmeasured; C is NOT marked repaired or ready for merge.

## Astra constructor placement refinement — source-only, 2026-10-09

### Preserved record and current authority

Read the COMPLETE 1,137-line constructor-alias planner record, then the COMPLETE
latest 1,462-line canonical record through root's terminal identity receipt.
The latter was copied byte-for-byte with apply_patch into this planning checkout
before appending; independent SHA256 of both prefix copies:
`636c5ec2eb9e63e21d6f066e2ae92b6e3c2dcedd1b976fd730d5640e14eb064e`.
Original 1,137-line planner SHA256 remains
`54236f0c9f5b357bd3338550ff5e91e400c1c220e8c1407502ffaeacd5c51314`.

Owned record location:
`/Users/thomas/.codex/worktrees/collection-raw-anyref-comparison-plan-astra/js2/plan/issues/6929-function-tostring-canonical-residual-plan-astra-20261009.md`.
This existing isolated planning checkout is at dbf5b4f; it is NOT the measured L
composition or a source to copy over a future implementation. The previous Map
plan was not changed during this task. Only this copied canonical issue and
appendix are owned; earlier planner/diagnostic/canonical source records remain
untouched. This is the SAME allocated issue 6929, not a new issue or grant.

The empirical prerequisite is now ACTUALLY satisfied: root session24911 exit0,
4/4 source units, eight genuine emitter identity rows, original declaration/
initializer/processed-input identity and baseline/observed/worker byte equality,
both native constructor controls PASS with clean worker exit and both EOFs.
It does not prove the proposed runtime admission or repair canonical C. The
unresolved proxy-class P remains in the nine-file denominator. Thread-limit
failures to resume/spawn a Sol writer are not evidence of an assigned implementer.
Root requested this placement review before widening source ownership.

### Exact size/source evidence and proposed ownership

Inspected production in the diagnostic checkout
`/Users/thomas/.codex/worktrees/6929-constructor-lexical-identity-sol61/js2`.
Source seals match the previously measured composition for the two target files:

```text
8552 lines  src/codegen/expressions/new-super.ts
cd2870b7016cd0b9e1009ba69f991526b36aec990b6831195963c9f4d92d07c6
257 lines   src/codegen/expressions/non-constructable.ts
83b8ac83a7df0510f9d0f85991b6f39b1bd52b8264d9ae6a435ffdc20e4ca56f
121 lines   src/codegen/expressions/builtin-native-dyn-construct.ts
08f70f80af73d79a041e73503f79579f31429cee07b6fb1604d635012d8e19a8
src/checker/binder.ts (read-only dependency)
e495c71bd7cd26ef36a32f3a504193552a78aa30c61a3deedc77def931bd0c3e
```

Numbered source places tryCompileNativeConstructFromValue at 3854–4138:
285 raw inclusive lines, currently BELOW the 300-line function threshold.
The much larger compileNewExpression is a different function and need not
change. Nevertheless the proposed extraction shrinks the admission-bearing
function as well as the 8,552-line parent, satisfying the requested stronger
no-growth condition. Do not confuse file length with this helper's span.

Proposed production responsibility is THREE existing paths, after root review:
new-super.ts, non-constructable.ts, and builtin-native-dyn-construct.ts. The
latter is a small native dynamic-construction helper already imported by the
parent. It already receives runtime construction services explicitly and owns
native argument-local consumers for Array/Promise. Add the fixed-arity argument
preparation stage there; do not move native constructor drivers or mutate their
ABIs. No new flat/nested file, barrel, inventory path or cap waiver is needed.
Root must reconcile these exact hunks with live writers before release.

### Minimal extraction and admission wiring

1. Move EXACTLY new-super.ts:4036–4061, the complete `const argLocals` plus
   `for (const arg of args)` block, into a new exported helper in the existing
   builtin-native-dyn-construct.ts. Suggested name:
   `compileNativeConstructArgumentLocals`. Inputs: ctx, fctx, the already
   flattened readonly args array, existing proxyCtorValue boolean, and a
   readonly service containing the original compileObjectLiteralAsExternref.
   Return the completed number[] of argument local indices.
2. Copy all 26 lines and their Proxy-handler explanation into the helper;
   add only the function signature and return. Preserve exactly the branch
   on proxyCtorValue plus ts.isObjectLiteralExpression, open-object emitter,
   null fallback, original compileExpression with externref hint, coerceType,
   local name templates `__nc_arg${argLocals.length}_${fctx.locals.length}`,
   allocation/push order and continue. Do not use temp locals in place of the
   original permanent allocLocal slots. No extra original-argument read,
   duplicate compilation, filtering, mapping or spread handling is allowed.
3. In the parent, replace the moved block with one normally formatted helper
   call assigning argLocals. Pass `{ compileObjectLiteralAsExternref }` as the
   service, following the destination's existing explicit-service pattern.
   Destructure that service function once and invoke it as the original bare
   function, preserving the call's this behavior rather than making a method
   call on the services object.
   The parent already imports that original function from literals.ts;
   retain it for this service reference. The leaf's service type can use
   `typeof import("../literals.js").compileObjectLiteralAsExternref` (erased).
   Do NOT add a value import of literals.ts to the leaf or import new-super
   back into it. The service remains call-time data, not a global registry.
4. Keep the call at the exact old position: after native helper/guard/driver
   registration, after callee evaluation/storage and fnctor prototype local,
   and before Function intrinsic setup, TypedArray identity branch, final
   driver call and functionIntrinsicArm.finish. Preserve all these neighboring
   instructions and their order. The runtime-argv spread path returns earlier
   and remains wholly untouched. Do not share or rewrite its separate loop.
5. Add ts from ../../ts-api.js to the destination (for the unchanged object-
   literal predicate), and compileExpression/coerceType to its existing
   shared.ts import. All context/ValType/Instr types and allocLocal are already
   imported. Use the SAME shared delegate exports as the parent, not direct
   expressions.ts/type-coercion.ts imports. Keep the parent's import of the
   existing destination module at its current position and add only the new
   exported name. Put the destination's ts import after its existing shared
   dependency to preserve dependency traversal.
6. Implement the separately named weak lexical-identity query in
   non-constructable.ts under the original approved recovery/refusal contract.
   Do not modify classifyNonConstructableValue, its wrappers or
   resolvesToAmbientGlobal. Return original declaration identity (or absence),
   not a static constructability vote; the runtime value remains authoritative.
7. Add a named standalone/WASI-only recovered-binding admission in
   tryCompileNativeConstructFromValue, alongside the existing admission facts.
   The recovered input is still an identifier, so the earlier shape gate and
   compiled-fnctor exclusion remain unchanged. Retain the EXACT order and
   short-circuit behavior of every existing admission predicate. Prefer placing
   the new final `!recovered...` exclusion AFTER the current final
   `!admitBoundValueConstruct(...)` in the rejection condition. That existing
   predicate is NOT pure: construct-bound.ts:546 onward reserves the bound
   driver and prototype string. A reordered boolean chain can silently drop
   those registrations. No new identity fact should bypass established guards.

Estimated parent saving: remove 26 body lines, add a readable ~8-line call,
several import/admission lines, retain all comments in their proper owner.
This gives meaningful headroom without unrelated cleanup or comment trimming.
Hard POST-FORMAT requirements: new-super.ts <=8552 lines and
tryCompileNativeConstructFromValue <=285 inclusive lines on this exact preimage;
compileNewExpression unchanged. Destination/query files must stay below1500,
each new query/helper below300. These are source estimates, not executed gate
results. If actual formatting consumes the available room, return the exact
diff/count for review instead of packing lines, inventing a grant or changing
baselines/policy. No broad construction-body extraction is needed initially.

### Reader, mutator, lifecycle, import and architecture audit

- New argument helper has ONE caller: the unchanged fixed-arity native-value
  path. Its produced argLocals feeds Function-intrinsic emission, dynamic-TA
  emission and nativeDriverCall in the parent, in their original order. It
  must return the same indices, not reload values or return emitted operands.
- Its effects are exactly original argument evaluation, shared coercion,
  optional Proxy open-object emission and fctx.body/locals/localMap mutation.
  Nested argument compilation may register helpers/shift indices, just as
  before. Do not add/hoist a flush or cache a driver index in the extracted
  helper. The parent retains its final funcMap re-read and existing fallbacks.
- The service is the SAME exported literal-emitter function, not a wrapper
  that changes this/arguments, clones instructions or catches exceptions.
  Shared compileExpression/coerceType remain late-bound delegates and are
  invoked only at compile time after ordinary registration. No new top-level
  execution, mutable table, cache or callback installation is introduced.
- New-super already imports the destination; its call-order changes are local
  function boundaries only. The leaf already imports shared.ts and locals.
  Its additional ts value edge is transitively implied by leaf -> shared ->
  ts-api. Types of ctx/AST/literal-service are erased. No leaf -> literals or
  leaf -> new-super edge is allowed. The extraction adds no SCC member or
  backward runtime-dependency path by construction; root must still measure.
- The query introduces non-constructable -> checker/binder. Binder's only
  runtime module import is ts-api; ts-api loads the frontend/typescript wrapper
  and node/package facilities, with no new constructor-module dependency.
  The source search found no direct checker -> codegen import in this epoch;
  do not confuse that bounded source observation with full graph validation.
  The proposed binder edge is one-way and must be checked against CURRENT
  exact-base cycles and compiler boundaries, not the stale committed baseline.
- Binder creation does mutate its EXISTING per-SourceFile WeakMap and resolve
  memo. Scope/declaration collection and deferred-write application stay in
  FileBinder; the new query is a reader of the returned records and may not
  modify Binding.declarations, assigned RHS nodes or SourceFile parents.
  Do not cache recovery by filename/spelling. Replacement incremental ASTs
  must use distinct binder identities. Assignment flags never prove immutable
  prototype values; do not convert this fact into the old provable classifier.
- Query has one new semantic consumer, native runtime admission. Its pure
  refusal predicates may examine actual source declarations/scopes, but their
  results must not enter oracle caches, class/extern-class/fnctor maps, shared
  nonconstructor sets or runtime constructor metadata. Read all original
  with/eval/shadow/import/duplicate/synthetic-node refusals in the packet.
- Inventory already names all three paths; builtin-native-dyn-construct is
  recorded unmigrated/mixed-needs-split/backend-wasmgc, as are the codegen
  source paths. Binder remains unmigrated/frontend-ts destination. Do not
  relabel either as migrated or introduce an architecture exemption for its
  reuse. No exact-path inventory addition is necessary for this design. If
  current gate policy rejects the new binder dependency, report the concrete
  violation to root; no policy weakening or silent query duplication is allowed.

### Root verification and frozen planning handoff

No production, parser/compiler, tests/native, build/type/format/gate/install,
Git mutation, external issue action or new allocation was performed here.
The source-only placement is ready for root review before any additional hunk
ownership is released. Thread-limit unavailability is an orchestration state,
not permission for this planner to implement the source.

Root must verify formatted file/function counts and meaningful scoped types,
LOC/function/flat/cycle gates against exact candidate base. Flat count may not
increase. Require compiler inventory errors=[]/inventoryValid=true; report
architectureComplete independently, never claim IR completion from inventory.
No copied allowance, baseline bump, or threshold change is part of acceptance.

Retain the original packet's all-nine canonical run, seven PASS controls,
unresolved P, actual original C TypeError/driver proof, mutation/shadow/refusal,
argument order/throws/spread, host/native and causal admission removal gates.
An extraction-only control, with the new recovery admission disabled but the
layout retained, must preserve existing construction behavior and normal bytes
for representative fixed-arity ordinary/bound/Proxy/Function/TypedArray and
runtime-spread controls. Exercise Proxy object-literal handler semantics so a
lost open-object service cannot hide behind ordinary argument tests. Helpers
must leave callee-before-arguments and argument-time alias reassignment intact.
Successful identity observation alone remains zero canonical repair credit.

## Sol6.1 constructor source implementation freeze — 2026-10-09

### Checkout, custody and bounded authority

Own managed checkout:
`/Users/thomas/.codex/worktrees/6929-native-function-constructor-fix/js2`.
Branch `codex/6929-native-function-constructor-fix`; actual HEAD and starting
preimage `7d9e8ce3c6efcd4ebcfca6e14e8f895a69e9ae18`. Managed creation/attachment
operation `7826bf92-85c8-4fc4-bf31-b1ba5bd72bfa` completed. This record's entire
1,667-line approved prefix was read and copied with apply_patch before editing;
its preserved prefix SHA256 is
`07b65e441af5152323224090f37d9101041748a74fe031251d11520077d31182`.
This appendix is chronological, not a replacement of the identity/placement
history or a second issue. The existing allocated issue is still 6929.

Root's prerequisite session24911 exit0 is retained as ROOT OBSERVED evidence:
four source units/eight genuine identity rows, original declaration/initializer/
processed-body identity, unchanged worker bytes and two native controls PASS
with clean exit and both EOFs. No identity-gate or canonical result was produced
by this child. Root alone owns all heavy execution and subsequent publication.
No compiler/parser/native/test/type/build/format/gate/install, commit, push,
issue allocation, corpus/oracle/runner/ABI/IR change was performed here.
Comparison, Map, N and original constructor diagnostic custody were untouched.

The three exact production preimages independently matched the approved seals:
non-constructable `83b8ac83a7df0510f9d0f85991b6f39b1bd52b8264d9ae6a435ffdc20e4ca56f`,
new-super `cd2870b7016cd0b9e1009ba69f991526b36aec990b6831195963c9f4d92d07c6`,
builtin-native-dyn-construct
`08f70f80af73d79a041e73503f79579f31429cee07b6fb1604d635012d8e19a8`.
Readonly binder remains
`e495c71bd7cd26ef36a32f3a504193552a78aa30c61a3deedc77def931bd0c3e`.

### Source changes and reader/effect preservation

- non-constructable.ts owns a separately named weak declaration-identity query,
  recoverAmbientPrototypeConstructorBinding. The existing static classifier,
  its wrappers and resolvesToAmbientGlobal remain unchanged. Only genuine
  original identifier references with a valid original parent/source chain,
  ambient-only or absent checker declarations, one actual top-level initialized
  plain variable binding and ambient unshadowed initializer Root are eligible.
  The returned object is the original VariableDeclaration, never a static throw
  vote, synthesized declaration, spelling allowlist or initializer re-evaluation.
- Duplicate/destructured/import/export/source-checker/nested/shadowed/missing/
  alias-graph/with/direct-eval/Annex-B/synthetic identities decline. The source
  scan is a conservative veto only; binding resolution remains FileBinder's
  nearest-scope lookup. Binding writes, captured writes, argument-time writes
  and mutable prototype reads are NOT immutable lifetime proofs. Existing binder
  WeakMap/resolve memo lifecycle is reused; its records, parents, declarations,
  writes and shared public facts are not mutated by the query.
- Root identified the transparent-parenthesis direct-eval gap during read-only
  review. The final query now unwraps the original nonoptional call callee before
  its Identifier/eval veto. Both `(eval)(...)` and nested parentheses are refusal
  rows. Member, comma-indirect and optional eval calls have explicit positive
  query controls; they are not declined solely by the spelling of a member.
- new-super.ts has the query's sole new production consumer: native standalone/
  WASI runtime admission. Its final rejection conjunct comes AFTER the existing
  side-effectful admitBoundValueConstruct predicate. Every old predicate and
  short-circuit registration order is retained. Host lanes, earlier callee shape
  and compiled-fnctor gates are unchanged. No recovery fact is published into
  oracle, class, constructor, extern-class or nonconstructor tables.
- The complete original fixed-arity 26-line argLocals loop and Proxy-handler
  explanation moved into the already-existing builtin-native-dyn-construct leaf.
  Original compileExpression/coerceType delegate calls, object-literal branch,
  externref hints/null fallback, permanent allocLocal names/order, pushes and
  continue are preserved. The leaf receives the ORIGINAL literal emitter as an
  erased typeof-import service, destructures it once and invokes it bare. No
  literals/new-super value edge, registry, cache, hoisted flush or ABI was added.
- The helper's single call stays after driver registrations/callee storage/
  prototype local and before Function intrinsic/TypedArray/native driver work.
  Its returned indices feed those original consumers. Runtime-argv spread
  lowering and compileNewExpression are untouched. Original shared import
  traversal is retained and ts-api follows the leaf's existing shared import.
  Import-cycle/boundary compatibility is a source hypothesis pending root gates,
  not an executed graph or architecture-completion claim.

Frozen source-only SHA256, BEFORE root formatting:

```text
ff2c44952dbc338a02f0ef90f87cff7d08b14b6b2379af4bbb980d8e0d3f1aa2  src/codegen/expressions/non-constructable.ts
eaba1ffd9d66103c5e9a9c27f3738bafb42a1acdd3e9d61a61ea978af2a403e5  src/codegen/expressions/new-super.ts
1d09be968303c4b5970aa48dfee2cd921f1ba61fc2569643f578e90dfc082dfa  src/codegen/expressions/builtin-native-dyn-construct.ts
fb900bc4947e01739244027ca5e43b0273fc7c4a62790acb9b7db1a935971a0d  tests/issue-6929-native-prototype-constructor-binding.test.ts
```

Actual text counts, NOT formatted/gate counts: parent 8,537 lines vs exact
8,552 preimage; native-value helper inclusive text span 3,859–4,123 =265 lines
vs285. Query file332, destination162, new fixture323. The new query/helper are
below300 text lines. Post-format parent<=8552/helper<=285 and both leaves<1500
remain mandatory. No grant, baseline bump, comment trimming, line packing,
new production file, inventory or cap-policy change is authorized.

### New fixture denominator and honest outcome custody

Only NEW `tests/issue-6929-native-prototype-constructor-binding.test.ts` is owned.
No old fixture, canonical source, original worker or diagnostic expectation was
edited. Planned registrations232: 27 explicit query rows, detached-node unit,
SourceFile-replacement unit, unchanged-nine manifest, semantic-manifest floor,
200 semantic pairs and one reused-service unit. There are30 planned query calls
including the two replacement observations, and406 planned compile/instantiate
visits (200 pairs plus three reused stages, two APIs each). These are PLANNED
counts; measured queries/compiles/instantiations/main calls/verdicts remain zero
for this child's work. They are not nine canonical verdicts or worker-internal
lifecycle counts.

Fifty explicit unannotated-JS bodies cover captured/parenthesized/different-name
aliases, direct/computed members, Reflect/descriptor materialization, callable
native methods and nonconstructor brands, once/in-order arguments, first/second
argument throws, runtime spreads/getters, direct/captured/argument-time writes,
mutable prototype reads and getters, escapes, source/parameter/block/sibling/root
shadowing, duplicate/destructured/unresolved bindings, ordinary/class/bound/proxy
constructors, bound/proxy nonconstructors, Proxy open-object handler extraction,
Function/TypedArray extraction, callee-getter ordering/throws and eval refusal.
All50 are crossed with standalone, WASI, real host GC and native-first host GC.
The reused service preserves allowJs across JS→TS→JS source replacement and
records all three stages before assertion. All correct expectations remain;
unsupported adjacent behavior must fail, never bail/skip/default to success.

Each pair writes original source/options, source/fixture/binder/environment seals,
actual diagnostics/binaries/imports/raw outcomes and both API observations in a
unique new `.tmp/6929-constructor-regression-*` capture before assertions. TS
replacement custody uses source.ts. Compile errors, missing/invalid binaries,
missing main, wrong types, finite wrong answers, instantiation/init/main traps,
and disposal errors remain distinct. Counts record actual visits; no catch
manufactures zero or treats an external Wasm trap as a JavaScript TypeError.
Host rows use the real four buildCompiledImports namespaces and original
setInstance lifecycle, with no fabricated imports. Nonhost rows require zero
imports. Query receipts retain checker/lexical declarations, actual SourceFile/
scope/original declaration identity and original write-node evidence.

The canonical manifest pins all NINE original hashes from this packet, including
unresolved proxy-class, and explicitly yields zero canonical verdicts. Readonly
preflight found those nine corpus paths absent in this fresh checkout; root must
provide the already-authoritative corpus custody or run after integration. The
fixture deliberately does not skip missing files. Neither corpus nor dependencies
were installed/linked by this child. Root's unchanged worker all-nine execution,
all seven previous PASS controls and known P are still required separately.

### Serialized root verification and causal/extraction controls

After comparison execution is terminal and root has reviewed this freeze, root
may format ONLY owned paths, scoped lint/types, and run the new fixture serially:

```text
VITEST_FORK_MAX_OLD_SPACE_SIZE=1024 pnpm exec vitest run tests/issue-6929-native-prototype-constructor-binding.test.ts --no-file-parallelism
```

Then authenticate actual receipts against232 registered tests,203 source pairs,
406 compile/instantiate planned visits, concrete returned/main/init/error floors
and27 manifest query rows, WITHOUT interpreting planned counts as observations.
Run exact7d9 LOC/function/flat/import-cycle/boundary checks; JSON inventories are
not gate passes and architectureComplete must be reported independently.
Run original canonical C and ALL unchanged nine through the maintained worker
with standalone/auto/strict-rerun-always, genuine processed source, fresh normal
binary and settled request/exit/both-EOF custody. Actual C driver/IsConstructor/
TypeError path evidence requires authenticated emitted code, not a query vote.

Causal admission removal recipe: retain this exact query/helper layout and
fixture, but replace ONLY the final rejection conjunct
`!(noJsHost(ctx) && recoverAmbientPrototypeConstructorBinding(ctx, calleeExpr) !== undefined)`
with literal `true`. Preserve the preceding `&&` and every legacy predicate,
especially side-effectful admitBoundValueConstruct. No classifier/driver/worker/
oracle change. Seal that temporary source epoch, run relevant actual pairs and
unchanged C/nine, restore the exact candidate bytes and rerun with fresh captures.
Expected loss/restoration is a hypothesis until root observes both epochs.

Extraction-only control: with that admission disabled, compare exact7d9 original
inline-loop normal binaries to this extracted-loop composition using identical
source/options for ordinary, bound, Proxy-literal-handler, Function and TypedArray
fixed-arity controls plus runtime-argv spread and callee/argument-order controls,
both APIs/appropriate profiles. Preserve actual open-object trap semantics and
native argument local ordering. No debug options or fake TypeError proof can
substitute for normal byte/behavior parity. If WAT is requested, fresh debug
bytes must equal the same source/options epoch's retained normal bytes before
interpreting returned WAT; old original diagnostic custody remains immutable.

SOURCE-ONLY FREEZE: all three production files and the new fixture are handed
to root custody. No further child edits without a precise root follow-up. Repair,
canonical gain, compatibility, extraction parity and ship readiness are UNKNOWN
pending root execution; no source-only PASS or merge-ready claim is made.

## Root constructor preflight and execution custody — 2026-10-09

Root completed the full fixture/source review and provisioned only symlinks to
the existing root node_modules and unchanged test262 test/harness directories;
no install, hooks or corpus edits. The original not-a-constructor source seal
remains 52c3c2aa9b4557c99712505a914eb32b8026c087349dc453bec288e5302b91f2.
Formatting and scoped Biome lint of the three source paths and fixture passed.
Focused TypeScript7 session34467 TERMINATED exit0 with both diagnostic streams
zero bytes. Explicit owned-path git diff --check passed.

Before native execution root added fixture-only isolation: after host runtime
imports are built, retain the actual Function.prototype.toString descriptor,
then restore it after each observation including abrupt exits. This preserves
the runtime-installed facade while preventing deliberate specimen prototype
overwrites/getters contaminating the next API/row. Restoration identity and
attributes are recorded and asserted, not silently assumed. Generated source,
all semantic expectations and the 232-registration denominator are unchanged.

Formatted execution seals:
- non-constructable.ts fc1eed0f7c6a27274a2325fa4b05442d1666648e823bc2e598c5063c9ad7f33f
- new-super.ts eaba1ffd9d66103c5e9a9c27f3738bafb42a1acdd3e9d61a61ea978af2a403e5
- builtin-native-dyn-construct.ts 1d09be968303c4b5970aa48dfee2cd921f1ba61fc2569643f578e90dfc082dfa
- fixture b2311016d7264f6d7a72cd3d0c34a72c3ae57522204423fae1ea34634a02105c
- binder unchanged e495c71bd7cd26ef36a32f3a504193552a78aa30c61a3deedc77def931bd0c3e

Session49185 is LIVE: complete constructor fixture, one fork, parent1024MiB,
worker3072MiB, no parallel heavy execution. Logs .tmp/constructor-candidate-
20261009.stdout and .stderr. Planned232 registrations/203 pairs/406 compiles;
actual counts and canonical verdicts remain UNKNOWN until terminal receipts.
Structural gates and the unchanged nine-original maintained-worker execution
remain outstanding. No full-suite score, canonical gain or readiness claimed.

### Root terminal candidate and original-inline control

Session49185 TERMINATED exit1:128 PASS/104 FAIL/232,135.74s. Parsed203
pair receipts =200 semantic pairs+3 reuse observations;201 distinct specimen
IDs because two reuse stages deliberately repeat original semantic IDs. Every
capture directory is separate. Actual406 compile visits,404 instantiation
visits,390 main calls,300 exported initialization calls,276 finite returns.
Outcomes:2 compile errors,14 instantiation throws,114 main throws; zero
disposal errors and zero reported host descriptor restoration failures.
All27 explicit identity-query receipts present, zero failed identity-query
registrations. Returned is not equivalent to correct; test assertions retain
finite wrong answers and this run is NOT acceptance or readiness.

Candidate logs SHA256:
- stdout 4cd12f1e821ca5c2af8635cafa1b63584da8b5a3b2493fa39ce611a8970d903a
- stderr ebcee78b1d79ec3bab8dc1800b0cac31059879a3f6e0bf30d01b5051f050cf3c

Root prepared diagnostic-only original-inline baseline in the existing L
checkout /Users/thomas/.codex/worktrees/6878-latest-composition/js2, exact7d9.
All three production paths have zero diff and their original approved seals
83b8ac83/cd2870b7/08f70f80 remain unchanged. Only a NEW baseline fixture was
added. It removes the candidate-only declaration query import/definitions/29
query registrations, which do not exist in this baseline; all200 generated
semantic sources/options/expectations and3 reuse stages are byte-identical.
An explicit PRELUDE-to-Observation comparison returned true. No stub query,
fake declaration, production export or production modification was introduced.
Baseline registrations203=unchanged-nine manifest+semantic manifest+200
semantic pairs+reuse. Query population0, not a232-test acceptance rerun.
Baseline fixture seal5a134122f6c1737d1688586fe58f6558a5b13e1d1213c40097ba1d6d9ba20843.

Session62726 LIVE runs that complete203-registration baseline with the same
serialized1024/3072MiB budgets. Logs in L .tmp/constructor-original-inline-
baseline-20261009.stdout/.stderr. Actual baseline counts, regressions and
binary parity remain UNKNOWN until terminal pairing. Do not weaken candidate
expectations or grow WASI host allowlists based on these failures.

### Root terminal matched original-inline baseline; canonical execution live

Session62726 TERMINATED exit1:99 PASS/104 FAIL/203 baseline registrations,
119.36s. Candidate's extra29 query registrations account for its128 versus99
PASS count; semantic registration outcomes are unchanged, not a measured gain.
Root joined ALL203 ordered pair receipts by specimen ID, original source SHA
and complete options (including the three reuse occurrences), floored406
observations. Every outcome/value/diagnostic is identical. ALL404 emitted
binary sides match byte-for-byte; remaining two observations are compile errors
in both epochs. Thus this matrix proves no regression and no benefit from the
candidate for these exact programs. It does not prove the original canonical
constructor failure is repaired or that the weak query was actually reached
by the runtime-admission consumer in the simplified programs.

Baseline logs SHA256 stdout f7a7c84277b824177a6ccef42b068142ae92392be10cf1def8cb741770e9ff42,
stderr eebb40ea308717b9a9c74be90116d7824eca812ade2c2a427e0a54ccfc6fd2c7.
Exact7d9 LOC gate PASS:three changed src paths,net+106; function gate PASS:
no unallowed growth,three changed src paths. No grants/baseline changes.

Both maintained bundle entries built successfully from the candidate source:
compiler435581526aaa9bc436c39d5bca95670d9acb79b55bb104d8665845f5d6ab023d,
runtime9912385db30d14ca9ef206b8f0265df82d3e7203ed370cc381e24eccd059e451.
Maintained worker unchanged be06c73b7ef501985d39313d3c52691d90d5067899225dbc1431e11858e4a233.
The exact original-nine text manifest validated9 existing canonical identities,
SHA2a0051430c36eaa90202866d0816b21e03da8142123f3c2c9cec4f81d6e75bfd.

Session55999 LIVE runs maintained test262 dynamic chunk0/1, standalone/auto,
strict-rerun-always, exact nine-original selection, result prefix
constructor-candidate-6929-20261009. Correct proxy-class failure remains in
scope. Fresh cache directory belongs to this checkout; rebuilt compiler is
used, not old retained worker bytes. Logs .tmp/constructor-original-nine-
20261009.stdout/.stderr. Actual canonical verdicts/completeness/native routes
remain UNKNOWN until terminal evidence. This is nine-file diagnostic scope,
not a11778-file acceptance run. No skip, full score gain or readiness claimed.

### Canonical constructor PASS observed; provider setup retained separately

Session55999 TERMINATED exit1:7 PASS/2 FAIL/9,31.73s. Original
not-a-constructor.js PASS,reached_test=true,strict=both,honest oracle14.
Known proxy-class still FAIL with native syntax `[object Function]`. The
other failure GeneratorFunction.js is missing QuickJS artifact04a9abfac8350642,
not a measured semantic regression. All9 callbacks started/settled and9
verdicts recorded,0 exclusions, shard-completion-v2. Full source gain remains
unproven pending causal removal/restoration and driver/payload custody.

Root verified existing incremental-js-collections artifact WASM SHA
95333826e7c8c8ed7398203891db713dc44368c86a24dae6fe6da7d3004fa36c and ABI
4247f2ff4f03420b939692533177ddd485fbcb058a9377ecc33344ce1697f21b,
matching its build-info. Session32273 TERMINATED exit1:7 PASS/2 FAIL/9,
30.34s with artifact override. GeneratorFunction now names missing CURRENT
adapter39139a409b6feaff, not missing artifact. Completeness validator exit0:
1 shard,9 verdicts,9 registered,0 exclusions. Both setup epochs retained,
not merged into an imaginary all-nine success.

Maintained provider builder was read completely. Session81747 TERMINATED
exit0: copied only verified artifact into candidate cache, built current
adapter39139a409b6feaff for compiler hash06d46f66940dc36a,624579bytes,
2257ms compilation; linked provider capability/native canaries passed before
publication. No source/ABI/builder/worker change or network artifact rebuild.

Session19861 LIVE is the fresh all-nine prewarmed runner. Result
prefix constructor-candidate-6929-prewarmed-20261009, same nine manifest and
standalone/auto/strict-always settings; no scoped subset or expectations
changed. Canonical current result remains pending.

### Fresh prewarmed nine originals terminal; causal control initiated

Session19861 TERMINATED exit1:8 PASS/1 FAIL/9,32.48s. GeneratorFunction
now PASS; original not-a-constructor PASS in both modes; sole remaining
proxy-class FAIL retains `Conforms to NativeFunction Syntax: [object Function]`.
Completeness validator exit0:1 shard,9 verdicts,9 registered,0 exclusions,
all callbacks settled. Oracle14 honest/auto,strict both. This is a fresh single
nine-file epoch, not a sum across the earlier setup failures or a full score.
Adapter normal SHA80484c16c68acbc3e81cedaea397c612801582811810e27adf16cf5d454feb8b.

After terminal, root applied the reviewed causal recipe: replace ONLY the
last new recovery rejection conjunct with literal true. Earlier predicates,
side-effectful bound admission, weak query implementation, extracted argument
emitter, runtime and fixture unchanged. New-super temporary removal SHA
2aaa7ca0255c109017093e1e77be0ab436768a7d3ce414518fc1cfc9e8becff9;
removal compiler bundle780afcab3c527e453a5125ada07754328108ad26f763873457aebbb9fb491dad.
The one-original constructor manifest validated1 exact unchanged corpus file.
Root's removal runner is LIVE; actual handle recorded in next custody update.
It uses standalone/auto/strict-always and the maintained worker; this1-file
causal slice is not a nine-original compatibility or whole-suite rerun.
Candidate source/bundle MUST be restored exactly after terminal, before any
further acceptance or publication. No source/PASS causality claimed yet.

### Root causal admission removal/restoration TERMINAL evidence

Removal session99591 TERMINATED exit1:0 PASS/1 FAIL/1 original,14.67s,
honest oracle14/auto/strict-always. Exact original error restored:
`Expected a TypeError to be thrown but no exception was thrown at all`.
Result/callback completeness receipt is retained alongside the one-file JSONL.
Removal logs stdout aeb70d0e9ed0a8a59dad499942f0f46cdf1944da8e021b33a48ee1b9f23e4b3d,
stderr ed7575f1ffc1bb42b5c2c515dd1a57a3e04100545e3e816f878072e40a9553a1.

Root restored the ONLY modified conjunct after actual terminal. Candidate
new-super eaba1ffd9d66103c5e9a9c27f3738bafb42a1acdd3e9d61a61ea978af2a403e5
and rebuilt compiler435581526aaa9bc436c39d5bca95670d9acb79b55bb104d8665845f5d6ab023d
match their earlier candidate seals EXACTLY. Restore session93244 TERMINATED
exit0:1 PASS/1 original,15.16s. Original source/manifest/expectation unchanged;
all candidate controls/extractions/query definitions retained during removal.
Restore logs stdout06be13ebfbeab1b2b084c9ce4a6ffbdc732261c7f3c7e704897a3fc0f9d3ad23,
stderr empty SHAe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.

These measurements establish causal loss/restoration of the original
not-a-constructor verdict through the added runtime-admission conjunct.
They do not identify every internal driver/payload instruction, certify all
104 simplified-matrix failures as repaired, or change the full ES2015 score.
New matrix's runtime outcomes remain identical to exact7d9 baseline; proxy-class
is still a measured independent canonical failure. Full candidate publication
still requires remaining graph/boundary/compatibility and honest quality-gate
handling; do not claim all232 green or convert diagnostic evidence to skips.

### Remaining constructor gates — root measured 2026-10-09

Exact comparison base remains7d9e8ce3c6efcd4ebcfca6e14e8f895a69e9ae18.
Flat-directory check TERMINAL exit0:830 root codegen files. Coercion-sites
TERMINAL exit0:three changed source files, no net vocabulary growth.
Import-cycle session3835 TERMINATED exit0:largest SCC699 files,4 SCCs>1,
10 two-way directory pairs;1899 files,10516 value edges,3868 type-only refs.
Each uses the explicit comparison base, not a stale committed low-water mark.

Oracle-usage gate TERMINATED exit1:ctxChecker grows2→4 in
src/codegen/expressions/non-constructable.ts. This is a publication blocker,
not an approved allowance. Astra is asked to plan a fail-closed migration to
existing oracle declaration queries, after freezing the receiver diagnostic
plan. No gate grant, hidden checker query or production replacement applied.

Compiler-boundary session19714 TERMINATED exit1:
inventory-valid-architecture-incomplete, graphComplete=false,
inventoryValid=true. This is not a passing architecture proof. Base parity
has not been measured in this pass; do not call all findings pre-existing.
Logs are own `.tmp/constructor-{flat,coercion,import-cycles,oracle,boundaries}-20261009.*`.
The maintained dead-export gate is now running with its actual required
core-type and twelve real core-node observations; result still pending.
No commit, push, PR readiness or whole11778 completion is claimed.

Dead-export session54348 is now actual TERMINAL exit134, not an observation
timeout: its1024MiB parent exhausted V8 heap around1043MiB and produced no final
JSON verdict. This is UNKNOWN, not a passing or semantic-failing gate. The
same maintained command is retried only after this confirmed termination with
the repository team-setup documented3072MiB allowance; no thresholds/source/
required twelve-node group changed. Retry logs use the separate
`.tmp/constructor-dead-exports-retry-20261009.*` epoch. Root remains sole
heavy executor; no parallel compilation or silent restart of a live handle.

Retry session99466 TERMINATED exit0. Inspecting the actual JSON—not only exit
status—proves the preservation-v1 contract:6/6 full and6/6 cut witnesses,
old dead-export count27→27 with zero additions/removals. Required core-types
10/10 full and10/10 cut pass. Required real core-node execution12/12 passes,
child actual status0/signalnull/stderr empty; receipt
`.tmp/core-node-execution-SNdXuz/execution.json`.
Strict modeled closure remains OPEN/FAIL (movedRuntime.ok=false): nonliteral
imports at optimize.ts412 and platform-capability-adapter.ts151 remain unknown.
Retirement/deletion is NOT certified; preservation-only acceptance does not
convert these unresolved dynamic edges into closed architecture proof.

### Upstream synchronization checkpoint

Fresh authenticated loopdive/js2 main remains
dbf5b4f74b37d67e525b2af36fd1fe49803b1348. Root verified exact ancestry,
non-overlap of owned source/test/issue paths and actual post-merge hook before
fast-forwarding ONLY codex/6929-native-function-constructor-fix to that main.
No stash, force, root-main mutation, merge commit, hook bypass or author change.
Post-merge HEAD matches upstream; all three candidate source hashes and fixture
b2311016 remain EXACTLY their prior seals. All src base blobs7d9→dbf are
unchanged; updated hook/scripts and unrelated linear-test evidence are retained.
Earlier gate epochs stay explicitly7d9, not retroactively relabeled freshdbf.
The issue remains in-progress and unpublished pending the actual oracle blocker
repair and remaining validation. No full ES2015 score changes from this sync.

### Root approved strict oracle-boundary implementation plan

Root read the full250-line frozen Astra plan0fb458ef and approves the bounded
checker/oracle-layer ownership below. Unknown in-house evidence must decline,
not consult a hidden checker; this intentionally unsupported backend does not
constitute parity proof. Default checker and differential primary behavior must
preserve actual absence/resolved/exception semantics. No unrelated IR snapshot,
existing lossy API or semantic expectation is authorized to change. A Sol6.1
implementation lane will own this isolated constructor worktree until handoff;
root retains all heavy execution and will stop writing this MD during that lane.

# 6929 constructor recovery: oracle-boundary blocker plan

Status: source-only Astra plan, not production authorization. Existing canonical
issue 6929 owns this work; no new ID, allowance, baseline change, or grant.
The receiver source-authentication plan was frozen first. This document does
not release receiver repair or change either fixture's expected results.

## Finding and decision required

The two new direct checker calls in `recoverAmbientPrototypeConstructorBinding`
cannot safely be replaced mechanically by `declarationsOf` and
`valueDeclarationOf`. Those existing oracle methods erase the distinction
between absent evidence and a failed query. The recovery deliberately permits
an absent callee symbol, but requires positive ambient declarations for the
prototype root. The first distinction is therefore admission-sensitive.

Recommend a small, explicit, strict declaration-evidence method on the real
TypeOracle interface, implemented by all three existing oracle backends, and
used only by this new recovery. Preserve the existing methods unchanged.
The recommended checker implementation propagates checker exceptions, exactly
as the candidate helper does now; it does not convert exceptions to absence.
An explicit `unknown` result is reserved for a backend unable to answer.
Root must approve the added checker-layer ownership before implementation.
Until then, the constructor oracle-ratchet blocker remains open.

## Read-only custody and measured scope

Inspected candidate tree:
`/Users/thomas/.codex/worktrees/6929-native-function-constructor-fix/js2`.
Original exact comparison base supplied by root:
`7d9e8ce3c6efcd4ebcfca6e14e8f895a69e9ae18`. Root subsequently fast-forwarded
its branch to verified upstream `dbf5b4f74b37d67e525b2af36fd1fe49803b1348`,
reporting no source delta and unchanged constructor production/fixture seals.

Read-only source SHA256 seals:

- `src/codegen/expressions/non-constructable.ts`:
  `fc1eed0f7c6a27274a2325fa4b05442d1666648e823bc2e598c5063c9ad7f33f`.
- `src/checker/oracle.ts`:
  `83aa8ba5ee5550eb4113425e19647d8dde6da169ee59cd3da19e350b227fd911`.
- `src/checker/inhouse-oracle.ts`:
  `b9fee8c73bb45c5e6473858ae2e014566908b78b73998c2fda7a294cebae6dc7`.
- `src/checker/oracle-backend.ts`:
  `870ae53149999324e1a71e6f1b818c139e2710d92ffcd4a78f42317becb58d60`.
- `src/checker/oracle-declaration-snapshot.ts`:
  `de905ec491a3e3f06fa4e8f43f1f439663b823c234235a25cc8b535d95eb6808`.
- `tests/issue-6929-native-prototype-constructor-binding.test.ts`:
  `b2311016d7264f6d7a72cd3d0c34a72c3ae57522204423fae1ea34634a02105c`.

Root reports LOC/function gates pass and import cycles pass at 699 SCC,
4 cyclic SCC, 1899 files; oracle-ratchet fails `ctx.checker +2` in this helper.
These are root receipts, not gates rerun by this planning lane.
Root's boundary check exits 1 with inventoryValid true and graphComplete false.
The authorized 3 GiB dead-export retry 99466 exits 0 after the earlier 1 GiB
OOM exit 134: preservation 6/6 full+cut, dead count 27 unchanged, coreTypes
10/10, coreNodes 12/12, real child exit 0. Strict modeled closure remains false
because of two nonliteral imports. No complete architecture claim follows.
Root's candidate 128P/104F/232 and baseline 99P/104F/203 share 203 semantic
pairs with all 406 outcomes/values/diagnostics identical and all 404 emitted
binary hashes identical. The extra 29 candidate registrations are query
checks. This does not establish repair of the genuine original C specimen,
nor a full-suite gain. No newer native result is asserted here.

## Exact source semantics that must survive

`non-constructable.ts:76–153` first validates the actual identifier and its
original parent chain, then queries its checker symbol. A genuinely missing
symbol produces an empty declaration population and no value declaration,
which does not itself veto recovery. Any source declaration or source value
declaration vetoes. A checker exception currently escapes; it is not accepted.
The later binder proof requires the genuine unique, plain, top-level variable
declaration in the same original source. With/eval/Annex-B, imports/exports,
nested bindings, duplicates, destructuring, and synthetic/detached nodes retain
their existing refusals. Mutations are deliberately not an immutability proof:
the admission uses the runtime value, not a synthesized TypeError.

The root identifier query at the end requires nonempty declarations, all in
declaration files. Missing/empty root evidence vetoes. It currently does not
add a separate root value-declaration veto; do not silently strengthen this
different predicate while moving the query boundary.

`new-super.ts:3907–3921` has the sole production consumer, last in its existing
admission disjunction and after `admitBoundValueConstruct`, which may reserve
driver state. Keep call position, short-circuit order, `noJsHost` condition,
runtime-value construction and all existing argument lowering unchanged.

## Why the existing surface is insufficient

`oracle.ts:424–450` memoizes value declarations and caches a miss as null.
Its private implementation catches errors into undefined, handles shorthand
value bindings specially, and returns `valueDeclaration ?? declarations[0]`.
That is not the exact `symbol.valueDeclaration` predicate in this helper.
`oracle.ts:471–483` catches declaration-query failures into a cached empty
array. It reads `symbol.declarations`, whereas the current helper calls the
symbol's genuine `getDeclarations()` method.
`oracle.ts:373–379` also maps failed `isUnresolvableIdentifier` queries to true;
it cannot act as an independent success witness. Type facts and identifier
spelling cannot prove declaration-query success either.

The callee failure could consequently look like permissible absence under a
mechanical two-method replacement, while a successful root lookup still
allows recovery. A catch surrounding those oracle calls cannot recover an
exception already swallowed inside them. Root nonempty checks do not cure
callee uncertainty. Do not change the old methods' global failure contracts
or reinterpret their empty/undefined answers as proven absence.

## Proposed bounded production surface, pending approval

Use the name `bindingDeclarationEvidenceOf` (or one consistently approved
equivalent) on TypeOracle, with a readonly discriminated result:

- `unknown`: this backend cannot provide the exact declaration evidence.
- `absent`: an authoritative query completed and returned no symbol.
- `resolved`: exact readonly declarations and exact optional value declaration
  from one symbol, without exposing a TypeChecker, Symbol, or Type.

The contract is registry-free and query-only. It concerns the exact queried
identifier, not transitive aliases, constructor brands, or matching spelling.
Preserve a resolved empty declaration population as resolved, not unknown or
absent; the current callee/root predicates treat emptiness differently.

1. In `src/checker/oracle.ts`, add the type/interface member and implement it
   in `TsCheckerOracle`. Make one genuine `getSymbolAtLocation` call for an
   uncached valid identifier, then obtain `getDeclarations() ?? []` and exact
   `valueDeclaration` from that same symbol. Copy/freeze the result population
   if needed to prevent a consumer mutating checker storage; retain original
   declaration node identities. Do not use either lossy legacy method to
   manufacture this evidence. A dedicated per-instance WeakMap can memoize
   successfully completed absent/resolved results. No entry is published
   before all reads complete. Let checker/accessor exceptions propagate;
   do not catch and cache them as absence. Detached/synthetic inputs may
   return unknown, but must never become positive evidence.
2. In `src/checker/inhouse-oracle.ts`, implement an explicit unknown answer
   for this strict checker-environment declaration query. Its existing binder
   has no authoritative ambient-library symbol population; spelling/global
   tables are not a substitute. Do not pretend binder absence proves checker
   absence, or change existing in-house declaration methods. A future useful
   in-house implementation requires its own positive evidence and is outside
   this bounded repair.
   This is a conservative backend-specific behavior change: the current helper
   bypasses oracle selection and asks the checker even in an in-house context.
   Root must explicitly accept refusal in that unsupported backend; do not
   claim exact candidate parity there. Do not inject a checker into InHouseOracle
   or force checker backend globally to conceal this limitation.
3. In `src/checker/oracle-backend.ts`, add the DifferentialOracle method via
   its existing compare delegate. Return the exact primary evidence, preserving
   primary throws. Serialize unknown as `unknown`, absent as a distinct token,
   and resolved with both declaration population and exact value declaration.
   Include source/ambient provenance and coordinates in diagnostic descriptions
   so a same-kind/same-position node in another source is not reported as the
   same evidence. Such descriptions are observation only, never admission.
   Existing classifier handles literal unknown as abstention; no classifier
   or policy edit is proposed. Test the new query's ledger classification.
4. In `non-constructable.ts`, change only this helper's context requirement
   from Pick<CodegenContext, "checker"> to Pick<CodegenContext, "oracle"> and
   its two query blocks. Unknown declines immediately. Absent callee may
   continue; resolved callee keeps both original source-declaration vetoes.
   Root must be resolved with a nonempty all-ambient declaration population.
   Do not catch propagated checker failures or invent a runtime TypeError.
5. In the existing 6929 fixture, update all four helper-call sites at current
   lines 730, 798, 816 and 822 to provide a real oracle constructed from that
   phase's actual `ast.checker`, using `createTypeOracle(checker, "checker")`.
   Keep separate new oracles after source replacement. Explicit backend choice
   keeps these identity controls independent of ambient environment settings.
   Genuine raw-checker reads used only to record test evidence may remain;
   do not replace observations with the expected answer.

This strict exception contract preserves the candidate's behavior on checker
failure. An alternative design converting exceptions to unknown and declining
the route is a deliberate behavior change, not equivalent refactoring, and
requires separate root acceptance and evidence. Do not silently choose it.

## Reader, writer, lifetime and import review

The existing TypeOracle implementations are exactly TsCheckerOracle,
InHouseOracle and DifferentialOracle under `src/checker`. All must implement
the new required member in the same change. CodegenContext already contains
TypeOracle; neither its large type file nor `new-super.ts` needs a new hunk.
Factories are `src/checker/oracle-backend.ts:46`, called from
`src/codegen/context/create-context.ts:106` and
`src/codegen-linear/index.ts:263`. Do not introduce a parallel oracle factory
or construct a checker oracle inside production codegen to evade selection.

Only this recovery is a new production reader. Its caller receives a normal
context, so changing the narrow Pick does not relocate the call. The oracle
owns the new WeakMap; successful-query publication is the only writer.
Consumers may inspect declaration nodes but never mutate them or the result
population. Each context/oracle has its own cache; do not cache by spelling,
filename, source hash, module singleton, or a prior incremental generation.
Existing binder cache/source replacement and all legacy oracle caches remain
unchanged. No cache invalidation or registry mutation is introduced.

`oracle-declaration-snapshot.ts:38` explicitly picks only valueDeclarationOf
and declarationsOf. Its recorder/replayer and neutral IR schema do not gain
this method, nor should an empty replay answer be upgraded to strict evidence.
No IR snapshot, IR interface or unrelated active IR file is owned by this plan.
If a later consumer needs this query in replay, stop for separate ownership.

Existing import directions already support the change: backend imports oracle
and in-house; in-house imports oracle types; the helper already imports context
types and binder. Reuse those edges; any new evidence type imports are erased.
The fixture's factory import is test-only. No new production runtime module,
cycle, top-level initialization, flat directory entry or source inventory row
is needed. This is a source argument, not an executed cycle-gate result.

Current actual sizes: oracle 672, in-house 958, backend 347, recovery leaf 337,
fixture 936 lines. Add ordinary readable functions in these existing leaves.
Keep function/LOC ratchets and file budgets after formatting; no line packing,
comment deletion, arbitrary extraction or policy/baseline change. Parent
new-super is already oversized and must not grow for this boundary migration.

## Required source-query and runtime acceptance, root-only execution

Keep all 29 existing identity registrations and all 203 semantic pairs with
unchanged sources and expectations. Add separately counted query controls in
the existing fixture; do not hide new controls inside a claimed unchanged
232-registration total. No new flat test file is needed.

- For genuine returned ASTs, authenticate original SourceFile/declaration
  identity and all successful existing positive/refusal cases. Observe the
  real oracle's original-once callthrough and exact underlying checker node.
- Exercise genuine resolved-source, resolved-ambient and absent identifiers;
  verify absent differs from unknown. Do not fabricate a missing-symbol
  positive recovery case if the actual checker does not produce one. Record
  that branch's admission coverage as unknown until a genuine case exists.
- Add explicit unavailable-backend refusal using the real InHouseOracle and
  differential primary-return/ledger controls using actual factories.
- For checker-error handling, use the real analyzed AST/checker and a scoped
  failure injector that calls the original method once and then throws a
  unique sentinel at the exact callee or root node. Assert the identical
  sentinel propagates and no declaration is returned. Clearly label these
  fault-injection controls, not natural checker outcomes or native evidence.
  Restore observers in finally. Test failures before cache publication and
  retry through a fresh oracle; no thrown answer may be memoized as absent.
- Observe repeated successful evidence queries and verify one underlying
  query per node/oracle, exact declaration identity, and no use of the old
  lossy caches. Retain the existing incremental replacement test with new
  SourceFile, declaration, binder and oracle identities.
- Once root approves source ownership, run proportionate oracle/type/budget/
  cycle gates and the unchanged constructor matrix under checker backend;
  compare all original 203 semantic pairs and emitted byte hashes against
  the sealed candidate, separately counting new query registrations. Preserve
  every known WASI failure and original-nine control. The oracle migration
  alone is not a WASI repair or a constructor semantic-gain claim.
- Genuine original C and current canonical original controls remain mandatory
  before any construction-repair conclusion. Do not infer them from simpler
  source-query or matrix success. Root alone schedules native/heavy execution.

No production source, fixture, gate or canonical issue was edited or executed
for this plan. All suggested ownership remains pending root review/release.

## Sol6.1 strict constructor oracle-boundary source freeze — 2026-10-09

### Authority, source epoch and preserved record

Root explicitly approved the strict oracle packet above and assigned exclusive
source/fixture/append custody in the already attached implementation checkout:
`/Users/thomas/.codex/worktrees/6929-native-function-constructor-fix/js2`, branch
`codex/6929-native-function-constructor-fix`, exact HEAD
`dbf5b4f74b37d67e525b2af36fd1fe49803b1348`. No new worktree or issue was created.
This lane read the actual AGENTS.md, actual worktree MEMORY.md and relevant
shared-structure/measurement/test-ownership context. The older absolute user
memory path is absent; the actual worktree memory remains the source read.
The complete 2,350-line canonical record was read before editing. Its untouched
prefix SHA256 is
`dabe0be1e87bda08c592827ae03c3d3dc2e6edcb22ced846f2af9c055f2ba8df`.
The full 250-line Astra oracle plan was independently read and its frozen seal
verified as `0fb458ef1ae3d052ffc1e1bdd70ec4d56946b3775a41a2042cc39bbd6fe40ebf`.

All seven supplied source/fixture preimages matched before source writes:
non-constructable fc1eed0f, new-super eaba1ffd, argument leaf 1d09be96,
oracle 83aa8ba5, in-house b9fee8c7, backend 870ae531 and fixture b2311016.
Existing constructor source patches and all earlier handoff/evidence sections
were preserved. Root's dirty composition and all IR files were untouched.
No parser/compiler/native/test/type/build/format/gate/install/hooks, Git mutation,
commit, push, PR, claim, baseline, grant, policy or external message occurred.
All work in this appendix is SOURCE ONLY; root owns serialized verification.

### Bounded production change and exact query contract

`BindingDeclarationEvidence` is a readonly discriminated TypeOracle result:
unknown, authoritative absent, or resolved exact declarations plus exact optional
value declaration. TsCheckerOracle uses one genuine getSymbolAtLocation read for
each uncached original identifier, the same symbol's getDeclarations() and exact
valueDeclaration. It copies/freezes the population while retaining every original
declaration object. The dedicated instance WeakMap publishes only after all reads
complete, including genuine absence; checker/accessor exceptions propagate and
publish no entry. Detached/synthesized parent chains decline as unknown.
No old lossy method, shorthand remapping or first-declaration fallback creates
this evidence, and none of those legacy contracts or caches was changed.

InHouseOracle explicitly returns unknown. This is the approved narrow unavailable
backend refusal, not ambient parity, a binder-absence inference or a hidden checker.
DifferentialOracle uses its existing compare delegate, returns the exact primary
object and preserves primary throws. Diagnostic resolved descriptions include
fileName, ambient/source flag, kind, pos and end for every declaration and the
exact value declaration; absent and unknown are distinct tokens. Descriptions
are observation only. The existing divergence classifier and ledger policy were
not changed; actual ledger classifications await root execution.

Only recoverAmbientPrototypeConstructorBinding consumes the strict production
query. Its narrow context now requires oracle, and its two original checker blocks
use strict evidence. Unknown callee evidence declines; absent callee evidence may
continue; resolved callee evidence preserves both original source-declaration and
source-value-declaration vetoes. Root evidence must be resolved/nonempty/all ambient;
no extra root value-declaration veto was introduced. Every lexical/source/with/eval/
Annex-B/mutation refusal and the returned actual variable identity remain intact.
New-super's sole admission position, noJsHost condition, short-circuit ordering,
existing side-effectful bound admission and runtime construction are unchanged.

The new cache has one writer and one production reader, is owned by each oracle,
and has no filename/spelling/module-generation key or shared registry mutation.
All three actual oracle implementations implement the required method. Existing
factories/context fields/import directions are reused; added evidence imports are
erased types. The declaration recorder/replayer still picks only its existing two
lossy methods; its source seal remains de905ec4 and no IR surface was expanded.

### Existing fixture preservation and added query denominator

All four old recovery call sites now use actual phase-specific checker oracles
from createTypeOracle(actualChecker, "checker"). The original 27 query cases and
29 identity registrations retain their source and expected results. Replacement
still uses the same two original programs and additionally asserts distinct
SourceFile/callee/declaration/binder/oracle/evidence identities, with old/new cache
objects independently retained. Genuine raw-checker evidence observations remain.

Thirteen separately registered strict-query controls were added to the SAME file:
three source/ambient/absent success-cache cases; per-instance cache isolation;
real in-house unavailable recovery refusal; differential exact primary/ledger;
real differential-factory source-provenance descriptions; two callee/root checker
faults; two getDeclarations/valueDeclaration read faults; differential primary
fault propagation; and detached synthetic unavailable evidence. Fault injectors
operate on actual analyzed AST/checker/symbol objects, call original reads before
throwing unique sentinels, assert identical exception objects/no returned evidence,
repeat failed queries to reject premature caching, restore observers/descriptors
in finally, and retry the same/fresh real oracles. They are labelled fault-injection
source controls, not natural checker or native-runtime evidence.

Planned total is 245 registrations = the preserved 232 plus 13 strict controls.
The fixture manifest separately reports original identity29/strict13. Actual new
registered/settled/PASS counts remain UNKNOWN until root runs the fixture.
No genuine missing-symbol positive recovered binding was fabricated; that callee
admission branch's positive coverage is explicitly UNKNOWN in strict receipts.
Resolved-empty evidence is preserved by implementation; no natural empty-symbol
case was measured by this source-only lane.

The complete PRELUDE-through-Observation semantic source/options/expectation block
remains byte-identical before/after, SHA256
`30ec4b18c4160832ad9303c4a97a9c55c735c86a5dbdadea31676ceb420d6992`.
All 203 semantic pairs, including the three reuse stages, retain exact input,
options and expectations. No baseline FAIL, WASI refusal, skip or bail was changed.
Root's earlier candidate128P/104F/232 and baseline99P/104F/203, with all406
outcomes and all404 emitted binary sides identical, remain earlier receipts.
The new API has not been run or credited with preserving those outcomes yet.

### Root baseline-boundary receipt received during source custody

Root reports session75728 TERMINAL exit1 on the clean exact-dbf planner tree,
with real dependency links and no source edit: inventory-valid-architecture-incomplete,
1899 tracked source files, zero untracked, errors=[], four unknown edges.
Compared with the PRE-oracle candidate19714/7d9 source-equivalent epoch, errors,
unknown/unresolved/transitive/planned/debt entries are identical. However, candidate
has FOUR additional nonenforced forbidden-edge diagnostics: argument leaf -> ts-api
(two reasons), its erased import-type -> literals, and recovery leaf -> binder.
Ignoring source line coordinates there are no removals: baseline13821 forbidden
versus candidate13825; each added diagnostic has enforced=false. These four are
new diagnostics, not pre-existing graph findings. Root logs are
`.tmp/constructor-boundaries-upstream-baseline-20261009.stdout` and `.stderr`.
This is a ROOT RECEIPT, not a gate executed here. The strict API candidate graph
still requires a fresh root check; neither inventory validity nor nonenforcement
establishes complete architecture or closes unknown dynamic import edges.

### Frozen source seals, text counts and handoff

Preformat SHA256:

```text
b33e9ea792089338b687fe9aabe2d73228d5cd3986ef8be0d092d058821139cf src/checker/oracle.ts
293193e5a879b8014deaf8463e3188fe829679d1f1f0b2528c02e4f0e8b6faf4 src/checker/inhouse-oracle.ts
dd0eb32200362fca61dd15ae94de0a0579d0a9a2119a33d03177b8be9bc45ba1 src/checker/oracle-backend.ts
1e66d97f80ea017f2ed188b950a0600613c51784b78692274854aca54ea3e0ba src/codegen/expressions/non-constructable.ts
ccd796a83f26a8d3c8ee4150ed3491cb4b0e66adb3c34c51de57a622cfa625d7 tests/issue-6929-native-prototype-constructor-binding.test.ts
```

Actual text counts: oracle712, in-house964, backend376, recovery leaf343,
fixture1364. These are readable source counts, not post-format or gate receipts.
Existing new-super8537 and argument leaf162 are untouched with their exact
eaba1ffd/1d09be96 candidate seals. No new production/test file was created.
The complete readable source/fixture/canonical record is frozen in place for
root's full review, owned-path formatting, types, oracle/function/LOC/cycle/
boundary gates, all245 registration accounting and exact203-pair/406-outcome/
404-binary comparison against the earlier sealed candidate. Required genuine
original C and unchanged-nine controls remain root-owned verification.
Earlier measured fresh-nine8P/1F/9 and constructor causal removal0P/1F followed
by exact-restoration1P/1 remain preserved evidence, not rerun results of this API.
The full retained score remains11575P/189F/14CE of11778/all74 Intl; no new full
score, WASI repair, merge readiness or issue completion is claimed.

Source custody returns to root at this freeze. This child makes no further
edits without a precise follow-up; root may now review/format/execute serially.

### Root strict-oracle source review and preflight

Root read complete1364-line fixture, all three oracle source diffs, recovery
diff and2352–2502 source handoff. Owned seven-path formatting completed.
Initial lint found two fixture function expressions not using this; root
converted ONLY those to arrows, preserving explicit original.call(checker/node
or symbol) and sentinel/restoration behavior. Seven-path lint now PASS.
Root also corrected diagnostic provenance to actualdbf base (keeping7d9 as
semanticComparisonBase), recorded the three new oracle file seals and actual
JS2WASM_ORACLE_BACKEND environment. This changes custody metadata only, not
any203 semantic source/options/expected result. No production formatting delta.
Focused strict-oracle TypeScript7 preflight is LIVE, logs
`.tmp/constructor-oracle-types-20261009.stdout/.stderr`. Full245 registration
and406 outcome/404 binary parity are still unmeasured for these new bytes.

Focused types1283 TERMINATED exit0 with both streams0bytes. Corrected
oracle-ratchet TERMINATED exit0 against exactdbf:three changed codegen files,
getTypeAtLocation+0 andctx.checker+0, no allowance. Final formatted fixture
2fedd2b8abc3d66d65e449aeddaddb5c37414da02e37be7dca3af72cce30ae29.
Root launched the full245-registration fixture with1024MiB parent/3072MiB
single fork, separate `.tmp/constructor-oracle-candidate-20261009.*` logs.
All203 semantic pairs and correct expected results remain retained, including
the104 earlier failures; native compatibility and strict13 controls await
actual terminal receipts. No filtered pass-only subset or readiness claim.

### Source-only correction of the incremental identity control

Root's full245 handle54473 TERMINATED exit1:140PASS/105FAIL/245. Directly read
`.tmp/constructor-oracle-candidate-20261009.stderr` lines4–15 identify the one
additional failure in the existing incremental identity registration: fixture953
asserted nextCallee !== priorCallee, but the actual Identifier objects are identical.
The original104 semantic failures remain. Directly read persisted receipt
`.tmp/6929-constructor-regression-query-source-replacement-TtICma/query.json`
has both recoveries true, new SourceFile/declaration/binder/oracle/evidence identities
true, newCalleeIdentity=false, and both original declaration/source identities true.
This is a failed instrument assumption, not attributed constructor/API regression.

The maintained language-service SourceSnapshot.getChangeRange computes the exact
common-prefix/common-suffix edit for the same filename/grammar. The two preserved
query programs change only the initializer parentheses and leave the function/new
statement unchanged. TypeScript's reuse of that unchanged callee subtree is the
directly observed result, consistent with the maintained incremental mechanism.
No parser/compiler was invoked by this lane to reproduce or generalize the result.

Root released ONLY this existing fixture test block plus append custody. Starting
fixture SHA256 exactly matched root's formatted2fedd2b8abc3d66d65e449aeddaddb5c37414da02e37be7dca3af72cce30ae29.
The current2,525-line canonical prefix was preserved byte-for-byte, SHA256
`c6edaf9403882409c7aeb978f837b4b9b6b9bb2c59aec83762f2bd3e094858b8`.
Root's sourcePaths/dbf provenance/7d9 semanticComparisonBase/oracle environment
metadata and prior arrow/formatting changes remain intact. No production hunk,
semantic source, options, expected result, baseline failure or registration changed.

The correction keeps BOTH original replacement programs and all their source/
declaration/binder/oracle/evidence identity assertions. It now positively asserts
the actually measured same callee object in those two generations. Scoped real
checker observers count one underlying callee query in EACH distinct oracle even
though the identifier object is reused; repeated queries retain each oracle's own
exact evidence object. This demonstrates generation cache isolation on the genuine
reuse case, rather than assuming every node is reallocated with a SourceFile.

A THIRD separately labelled source-query phase in the SAME registration changes
the actual call from new toString() to new toString(0). It uses the same maintained
language service, a fresh real phase checker oracle, and only genuine returned AST
nodes. The test asserts the changed argument syntax, distinct parsed callee versus
BOTH earlier objects, new SourceFile/oracle/evidence identities, once-only underlying
checker query, genuine lexical declaration/source identity and independent warm
caches for all three oracles. No AST reconstruction or fake context/query is used.
The new-node assertion is retained as this deliberate changed-site control; it is
not removed or weakened. Both the two-phase reuse receipt and complete three-phase
receipt are persisted before their respective assertions in one new capture.
The third-phase outcome remains UNKNOWN pending root's scoped and full execution.

Root additionally reports a direct complete reconciliation of prior
`.tmp/constructor-candidate-20261009.stdout` against new
`.tmp/constructor-oracle-candidate-20261009.stdout`:203/203 ordered pairs match
ID/sourceSHA/options exactly, all404 emitted binary outputs are identical, and
all406 side observations agree after ONLY projecting error strings to their first
line. Twenty-two stack-line strings differ due to fixture line movement; this is
not complete unprojected diagnostic-string equality. There are zero semantic or
binary mismatches. The105th failure is solely the incremental query-unit assertion;
all104 unchanged baseline failures remain explicit. These are ROOT RECEIPTS, not
tests or comparisons rerun by this source-only lane. Root's architecture-gate
handle41813 remains live at dispatch; no result is inferred here.

Source-only corrected fixture SHA256:
`0963e594c7f28f7a6a591273936eaeeb4d715b60392a5fae965f43bb14ca2cf5`,
actual1453 text lines BEFORE root formatting. Only the incremental identity test
block changed: real query observers, affirmative reuse proof, deliberate changed
new-call phase and persisted complete receipt. All245 registrations remain;
the original27 query cases and203 semantic pairs retain their strings/options/
expectations. Original30 recovery-query call plan remains the original population;
this third labelled query phase adds one recovery visit inside the same registration.
PRELUDE-through-Observation source/options/expectation block still seals
`30ec4b18c4160832ad9303c4a97a9c55c735c86a5dbdadea31676ceb420d6992`.
All seven production seals remain exactly the prior frozen candidate seals.

No parser/compiler/native/test/type/build/formatter/gate/install/hook or Git
operation occurred. Custody returns to root for source review, scoped identity
execution and the full245 rerun; no new PASS, complete-suite score or readiness
is claimed by this correction. The retained full11778/all74 score is unchanged.

### Root strict-oracle validation and corrected identity execution

Root reviewed the entire corrected incremental block and source-only handoff.
Formatting and scoped lint passed; formatted fixture SHA256 is
`1c58b3481d6ac88f40e4e8a00f63a947eaaa2722324402747e5df7907428f65d`.
Session39527 TERMINATED exit0: focused TypeScript7 check had empty streams,
then the exact corrected identity registration passed (1PASS/244 explicitly
filtered registrations). This is scoped instrument validation, NOT full245
acceptance or canonical conformance. The third changed-call phase genuinely
executed and all reused/new-node/cache isolation assertions passed.

Serial gate session41813 TERMINATED: LOC/function/flat/coercion/import-cycles
exit0; compiler-boundaries exit1, inventoryValid=true/graphComplete=false.
Base is exact dbf5b4f74b37d67e525b2af36fd1fe49803b1348. Four unknown edges
are identical to the clean upstream baseline. Forbidden edges13821→13825:
the same four nonenforced extraction edges previously recorded, no additional
strict-oracle API edge. Do not describe architecture as complete or all new
edges as pre-existing. Logs use `.tmp/constructor-strict-*-20261009`.

Maintained preservation gate session36685 TERMINATED exit0 with3072MiB parent:
12/12 observed core-node callers (dispatch-cut UNKNOWN),10/10 full and cut
core-type witnesses,6/6 full and cut preservation witnesses. Graph remains
OPEN; strict modeled closure FAIL; retirement/deletion NOT CERTIFIED. File
`.tmp/constructor-strict-dead-exports-20261009.json` contains actual textual
stdout, NOT JSON (the filename is misleading); root's attempted JSON projection
failed and is NOT a successful parsed-report receipt. Its stderr separately
retains the two nonliteral dynamic-import blockers. No gate weakened.

Current compiler rebuild TERMINATED exit0, bundle SHA256
`a13d37c66ff8096034dde30a628315ee267bcec6deea50a03f684f7f531135cc`.
Provider86726 TERMINATED exit0: verified cached artifact95333826e7c8c8ed,
fresh current adapter73dd74a14415a9c2,624579bytes, genuine capability/native
canaries passed. No artifact, runtime, provider source or ABI change.

Canonical session7800 TERMINATED exit1:8PASS/1FAIL/9,31.83seconds, exact
unchanged nine manifest, standalone/auto/honest14/strict-always, one worker.
All nine reached_test=true and strict=both. Original not-a-constructor.js
PASS; proxy-class.js remains FAIL with native-function syntax `[object Function]`.
Completeness validator exit0:1 shard,9 verdicts,9 registrations,0 exclusions.
Fresh single-epoch result:
`benchmarks/results/constructor-strict-oracle-6929-20261009-results-20261009191243.jsonl`
with its matching shard-1-of-1.complete.json. Logs stdout SHA256
`a0ce9828a652c983775600ea0bc993744c2edb70025980a568d36c504505639c`,
stderr `90ee1576a18f2a696960f0e8d31d020f7fa5f59b7410558b9e1dd43cce519199`.
This retains the prior eight canonical passes without claiming proxy-class
repair, a full-suite score, or updated-API causal removal not yet executed.

Session42401 is LIVE for the corrected complete245 registration fixture,
parent1024MiB/single fork3072MiB. Logs
`.tmp/constructor-oracle-corrected-full-20261009.stdout/.stderr`. All104
baseline failures remain asserted, no filters/skips/expectation changes.
Final counts/parity remain UNKNOWN until this handle is actually terminal.

### Corrected full245 TERMINAL and complete original-pair reconciliation

Session42401 TERMINATED exit1:141PASS/104FAIL/245 in130.40seconds.
All245 registrations executed without a filter or skipped registration.
The corrected incremental identity control and all13 added strict-oracle
controls pass; the original104 semantic failures remain asserted.
Directly compared retained candidate log with this complete corrected epoch:
203/203 ordered pairs retain exact ID/sourceSHA/options;404/404 emitted
binaries match;406/406 side observations match after projecting ONLY error
strings to their first line. Twenty-two error stack strings differ at moved
fixture lines. All104 failed registration labels are identical as complete
sorted multisets (not merely equal counts). No new semantic/binary regression
or fixed baseline semantic row is credited by this matrix.

Final stdout SHA256
`7796219084d47ebe7925d5151b5812d9bb0d22268f4bc3654f9559efe734ecd3`;
stderr `1c6cccb3ddd0fd01c4584586be6059b748087f32e38bdb9ec098cb2cfa8f75ae`.
Fixture remains1c58b348 and all seven production seals remain unchanged.
There is no live constructor test process. Fresh nine-original canonical
8PASS/1FAIL and completeness proof above remain separate from this245 matrix.

Next required work: current strict-oracle causal admission removal/restoration,
honest incomplete-quality publication/handoff disposition, remaining original
proxy-class and semantic matrix failures, then exact unchanged full11778/all74
acceptance. Do not mark this issue completed, claim a green245 quality gate,
or infer 100% from source-query passes, targeted parity or eight canonical passes.

### Current strict-oracle causal control LIVE; mandatory restoration

Root temporarily replaced ONLY new-super's final recovery admission rejection
conjunct with literal true, retaining all strict-oracle implementations and
earlier bound-value admission ordering. Session61165 is LIVE for the exact
original not-a-constructor.js standalone/honest/auto/strict-always causal
removal. Logs `.tmp/constructor-strict-admission-removal-20261009.stdout/.stderr`.
This is a deliberately disabled candidate, NOT publishable source. After actual
terminal root MUST restore exact new-super eaba1ffd and rebuild exact compiler
a13d37c66 before restored-original execution, gates, commits or publication.
No removal outcome is inferred until terminal.

### Strict-oracle causal removal/restoration TERMINAL; publication handoff

Session61165 TERMINATED exit1:0PASS/1FAIL/1 original,14.83seconds;
the original not-a-constructor.js error returned exactly:
`Expected a TypeError to be thrown but no exception was thrown at all`.
Removal source2aaa7ca0 and bundle15a8e11b were temporary and are NOT active.
Root restored exact new-super eaba1ffd9d66103c5e9a9c27f3738bafb42a1acdd3e9d61a61ea978af2a403e5
and rebuilt exact current strict-oracle compiler
a13d37c66ff8096034dde30a628315ee267bcec6deea50a03f684f7f531135cc.
Session3220 TERMINATED exit0:1PASS/1 original,15.24seconds,
reached_test=true/strict=both/honest14/providersauto. Both causal epochs have
separate maintained completeness validator exit0,1 shard/1 registered/
1 verdict/0 exclusions. Removal and restored JSONL timestamps are respectively
20261009191807 and20261009191837 under constructor-strict-removal/restored
prefixes. Exact original manifest and all strict-oracle source retained.
This proves the new admission conjunct causes this original constructor PASS
with the current API; it does not repair proxy-class or any104 matrix failure.

All constructor heavy handles are terminal. Root releases exact eight-path
checkpoint publication custody to the existing Sol lane: six owned production
files, unchanged full245 fixture, this allocated6929 issue record. Publish to
authorized ttraenkler fork, PR against loopdive/js2, conforming body and user
author/Codex actual-model trailers. Checkpoint MUST remain draft because quality
has104 asserted failures and acceptance is unfinished; ready is not justified.
No test expectations, budgets, baseline, policy, CLA acceptance or issue status
may be changed to manufacture readiness. Root will not edit these files during
publication. Preserve all source seals through hooks; inspect any hook rewrite.
Worker must append publication outcome/link or exact blocker and attach PR.
Current full11778 goal stays active and unverified; no finished-fix claim.

### Draft checkpoint publication receipt — 2026-10-09

Published checkpoint commit `7b85b9673184c31f7bee34c6fa573f4307a6d016`
from `ttraenkler/js2:codex/6929-native-function-constructor-fix` to upstream
`loopdive/js2:main` as [draft PR 6605](https://github.com/loopdive/js2/pull/6605).
Remote branch and PR head were read back at that exact SHA; `isDraft=true`
and `mergeStateStatus=BLOCKED`. The PR was attached to this task. No merge,
ready transition, enqueue or CLA acceptance was requested. The reviewed PR
body preserves the unchecked CLA and all unfinished acceptance limits.

Commit hook session46338 TERMINATED exit0 using the sanctioned
`SKIP_SLOW_PRECOMMIT=1`, without hook bypass. Mandatory lint-staged formatting
and lint, LOC and function gates passed. The unsigned commit is authored and
committed by Thomas Tränkler, co-authored by Codex, with actual model trailer
`Model: Codex GPT-6.1 Sol High` and the required checkmark. Exactly the six
allocated source files, the existing full245 fixture and this issue record
were committed; no IR, expectation, hook or policy file was changed.

Unbypassed pre-push session38432 TERMINATED exit0. Whole typecheck and lint,
changed-file formatting, oracle ratchet (both raw-query counts +0), coercion
ratchet, numeric-local IR parity #3765 (18/18) and issue integrity all passed.
All eight file seals and all three hook seals were unchanged after both hook
epochs; the working tree was clean before this local-only receipt append.
CI readback at publication had checks queued/in progress, not a completed
green result. Local hook success does not certify the incomplete245 quality
gate, strict architecture closure or full acceptance.

Root additionally validated the maintained full manifest:11778 real existing
unique paths, including all74 Intl, SHA256
`632db3bbecb0d6ea42b0915b13740912bf3fd8e32e2a15a8b28c1f63b6434360`.
This is manifest validity ONLY, not a new full runner epoch or outcome score.
The same104 fixture failures, remaining proxy-class canonical failure and
incomplete architecture remain open. Issue status and all11778 acceptance
specimens remain unchanged.

This receipt was initially appended locally after the implementation SHA.
Root released the serial slot after receiver session29913 TERMINATED exit0
and authorized this documentation-only follow-up in the SAME draft PR.
The follow-up changes only this record; it does not recertify unchanged
implementation, CI, issue acceptance or the unfinished full-suite outcome.
