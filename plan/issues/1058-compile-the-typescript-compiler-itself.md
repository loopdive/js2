---
id: 1058
title: "Compile the TypeScript compiler itself to Wasm — self-hosting stress test"
status: in_progress
created: 2026-04-11
updated: 2026-09-08
priority: high
feasibility: hard
model: fable
reasoning_effort: max
goal: compiler-architecture
sprint: Backlog
depends_on: [1042, 1044, 1046]
required_by: [1059, 1066, 1165, 1584]
loc-budget-allow:
  # Wire the receiver-aware variadic Function.prototype.call body.
  - src/codegen/array-object-proto.ts
  # Open index-signature objects must use runtime own-property enumeration.
  - src/codegen/object-ops.ts
  # Reified Date.now shares the direct-call clock policy instead of throwing.
  - src/codegen/builtin-value-read.ts
  # Source-level Map.get values must leave the kernel's anyref storage plane.
  - src/codegen/map-runtime.ts
  # The for-of planner shares the generator's region/unwind cursor; its
  # instruction emitter is isolated in generators-native-for-of.ts.
  - src/codegen/generators-native.ts
  - src/codegen/generators-native-consumer.ts
  # Preserve undefined versus null in the native JSON value dispatcher.
  - src/codegen/json-codec-native.ts
  - src/codegen/expressions/call-namespace-static.ts
  # 2026-08-29: the deferred object-literal method install (the Tier-3
  # createIdentifier null-deref fix) adds the patch-up block to
  # compileObjectLiteralForStruct.
  - src/codegen/literals.ts
  # This is a consolidated TypeScript-parser stress harvest. The branch predates
  # the change-scoped file/function ratchets and intentionally spans the
  # compiler frontiers documented in the implementation handoff below.
  - src/codegen/declarations.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/closures.ts
  - src/codegen/stack-balance.ts
  - src/codegen/expressions/operator-assignment.ts
  - src/codegen/index.ts
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/statements/nested-declarations.ts
  - src/codegen/property-access.ts
  - src/emit/binary.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/binary-ops.ts
  - src/codegen/type-coercion.ts
  - src/codegen/expressions/calls-closures.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/literals.ts
  - src/codegen/expressions/call-tail-dispatch.ts
  - src/codegen/closure-exports.ts
  - src/codegen/class-bodies.ts
  - src/codegen/registry/imports.ts
  - src/codegen/expressions/eval-inline.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/context/types.ts
  - src/codegen/extern-declarations.ts
  - src/codegen/typeof-delete.ts
  - src/codegen/statements/variables.ts
  - src/compiler.ts
  - src/codegen/expressions/call-receiver-method.ts
  # 2026-08-29: the main merge composes this branch's runtime-namespace capture
  # guard with main's funcMap identity guard, crossing the 1500-line god-file
  # threshold in the closure capture-analysis phase file.
  - src/codegen/closures/arrow-phases.ts
  # 2026-08-30: the runtime parser follow-up adds narrow module-scale,
  # constructor-ABI, nullable-result, and fresh generic-factory handling at the
  # compiler frontiers documented in the current handoff below.
  - src/codegen/expressions.ts
  - src/codegen/generic-callback-result.ts
  - src/codegen/generic-struct-factory.ts
  - src/codegen/module-scale-profile.ts
  # 2026-09-05: direct Program/namespace functions now share the same
  # optional-scalar forwarding analysis as lifted declarations, so a parser
  # helper can preserve its incoming argc before forwarding an optional flag.
  - src/codegen/function-body.ts
  # 2026-09-01: the binder runtime reaches TypeScript's bounded
  # `Debug[AssertionKeys]` self-replacement protocol. The namespace-value
  # subsystem now materializes that checker-proven callable projection.
  - src/codegen/module-namespace-value.ts
  - src/codegen/native-construct.ts
  # 2026-09-01: the binder runtime's exported computed-option callback is a
  # cross-source callable snapshot. Keep its module-init read on the Wasm
  # carrier path and invoke it through a finalize-filled, ABI-complete driver.
  - src/codegen/property-access-exact-shapes.ts
  - src/codegen/host-fnctor-method-driver.ts
  - src/codegen/object-runtime.ts
  # 2026-08-31: projected NodeArray vecs retain their host-backed sidecar/MOP
  # identity so parser metadata survives element-type widening.
  - src/runtime.ts
func-budget-allow:
  # Select the extracted native collection-size reader for an optional chain's saved receiver.
  - src/codegen/property-access.ts::compileOptionalPropertyAccess
  # Four additional hash instructions honor the string view's length/offset.
  - src/codegen/map-runtime.ts::ensureMapHelpers
  - src/codegen/array-object-proto.ts::makeGlue
  - src/codegen/object-ops.ts::compileObjectKeysOrValues
  # Twelve lines select Date.now's existing clock policy in the static closure owner.
  - src/codegen/builtin-value-read.ts::ensureStandaloneBuiltinStaticMethodClosure
  # Captured native Set lookup is extracted; the optional-call owner must
  # select its boxed boolean/undefined branch result and admit abstract refs.
  - src/codegen/expressions/calls-optional.ts::compileOptionalCallExpression
  # Register tuple numeric-index arms in the existing finalize-time reader.
  - src/codegen/object-runtime.ts::fillExternGetIdxVecArms
  - src/codegen/generators-native.ts::buildNativeGeneratorPlan
  - src/codegen/generators-native.ts::compileState
  - src/codegen/json-codec-native.ts::emitJsonStringifyValue
  # 2026-09-05: prototype presence/storage and inherited lookup share the
  # existing vec side-table reserve/fill lifecycle; native operation wiring
  # is kept separately in vec-prototype.ts.
  - src/codegen/vec-props.ts::fillVecPropHelpers
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
  # Resolve user-defined Buffer bindings before the generic builtin fallback.
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  # 2026-09-01: the standalone apply bridge rejects a local closure whose live
  # declared arity exceeds its fixed eight-position ABI while preserving the
  # existing full-vector linked/native fallback.
  - src/codegen/object-runtime.ts::fillApplyClosure
  # 2026-08-31: parser carrier preservation adds the narrow vec-projection
  # sidecar copy and its runtime import dispatch arm.
  - src/codegen/type-coercion.ts::coerceType
  - src/runtime.ts::resolveImport
  # 2026-08-31: parser runtime identity preservation extends both host closure
  # dispatchers with facade unwrapping and explicit-undefined normalization.
  # Keeping the free and method bridges structurally symmetric is intentional.
  - src/codegen/closure-exports.ts::emitClosureCallExportN
  - src/codegen/closure-exports.ts::emitClosureMethodCallExportN
  # 2026-08-29: same change — the deferred install lives at the end of this
  # function, where the literal's method funcIdxs are finally resolvable.
  - src/codegen/literals.ts::compileObjectLiteralForStruct
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
  - src/codegen/declarations.ts::compileDeclarations
  - src/codegen/property-access-dispatch.ts::finalizeStructAndDynamicMemberGet
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/codegen/expressions/new-super.ts::emitDynamicNewFallback
  - src/codegen/expressions/call-tail-dispatch.ts::compileTailDispatch
  - src/codegen/class-bodies.ts::collectClassDeclaration
  - src/codegen/expressions/assignment.ts::compileElementAssignment
  - src/codegen/property-access-dispatch.ts::tryIdentifierNamespaceAndStaticReceiverRead
  - src/codegen/expressions/calls-closures.ts::compileCallablePropertyCall
  - src/codegen/ir-inline.ts::inlineUserFunctions
  - src/codegen/expressions/assignment.ts::compilePropertyAssignment
  - src/codegen/index.ts::resolveWasmType
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
  - src/codegen/expressions/eval-inline.ts::tryStaticEvalInline
  - src/codegen/binary-ops.ts::compileBinaryExpression
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/statements.ts::compileStatementInner
  - src/codegen/statements/nested-declarations.ts::compileNestedFunctionDeclarationInScope
  - src/codegen/statements/nested-declarations.ts::hoistFunctionDeclarations
  - src/codegen/member-set-dispatch.ts::fillMemberSetDispatch
  - src/codegen/expressions/calls.ts::compileIIFE
  - src/codegen/expressions/calls.ts::ensureFuncValueWrappersRegistered
  - src/emit/binary.ts::emitBinaryWithSourceMapUnguarded
  - src/codegen/closures/arrow-phases.ts::planClosureCaptures
  - src/codegen/function-body.ts::compileFunctionBody
  - src/codegen/typeof-delete.ts::compileTypeofComparison
  - src/codegen/member-get-dispatch.ts::fillMemberGetDispatch
  - src/codegen/statements/variables.ts::compileVariableStatement
  - src/codegen/typeof-delete.ts::compileTypeofExpression
  - src/codegen/index.ts::ensureStructForType
  - src/codegen/registry/imports.ts::addUnionImportsAsNativeFuncs
  - src/codegen/expressions/operator-assignment.ts::compilePropertyCompoundAssignmentExternref
  - src/codegen/index.ts::generateModule
  - src/compiler.ts::runPipeline
  - src/codegen/context/create-context.ts::createCodegenContext
  - src/codegen/native-construct.ts::fillNativeConstructDrivers
  - src/codegen/closures.ts::promoteAccessorCapturesToGlobals
  - src/codegen/expressions.ts::compileExpressionInner
oracle-ratchet-allow:
  # The parser stress harvest predates the ctx.oracle migration and exposes
  # TypeScript checker queries across these existing codegen paths.
  - src/codegen/declarations.ts
  - src/codegen/declarations/struct-type-registration.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/expressions/identifier-module-storage.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/expressions/operator-assignment.ts
  - src/codegen/extern-declarations.ts
  - src/codegen/index.ts
  - src/codegen/literals.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/property-access.ts
  - src/codegen/generic-callback-result.ts
  - src/codegen/generic-struct-factory.ts
  # 2026-08-31: the parser runtime follow-up extends the same reviewed
  # checker-backed specialization harvest across these four existing paths.
  - src/codegen/binary-ops.ts
  - src/codegen/expressions/calls-closures.ts
  - src/codegen/expressions/misc.ts
  - src/codegen/statements/nested-declarations.ts
  # 2026-09-01: admit a runtime-namespace function projection only when the
  # computed write key's checker constraint is a finite string-literal set and
  # every member has one exact executable Program ABI declaration.
  - src/codegen/module-namespace-value.ts
  # 2026-08-30: distinguishing a compiled Scanner implementation from an
  # ambient object requires checker-backed declaration and initializer
  # provenance. This is deliberately local to callback classification.
  - src/codegen/closures/callback-classification.ts
---
# #1058 — Compile the TypeScript compiler to Wasm (self-hosting stress test)

## Main synchronization check — 2026-09-08

### Full-source upstream unit expansion

After the main sync, add a separate source-module runner for the unmodified
upstream `factory.ts` (three callbacks) and `diagnosticCollection.ts` (five).
These import the real compiler namespace with consumer-driven barrel resolution,
not the utility projection. The established 25-test gate is unchanged; these
new files are exploratory until native and zero-import Wasm results agree.
Command: `node --import tsx tests/dogfood/typescript-source-unit-suite.mjs factory`.
The runner retains every original assertion and has an explicit callback floor.

Native source reference is bundled with esbuild (including Node globals needed
by upstream `sys` initialization); the Wasm input remains the source graph.
Direct native execution passes **3/3 factory** and **5/5 diagnostic collection**
callbacks. The new verdict rejects partial callbacks, wrong target, failed
validation, and entry or linked-module imports. Harness controls pass **24/24**
(`.tmp/ts5-source-suite-controls.log`); the final verdict-only rerun passes 3/3.

Both initial full-source runs completed: factory compiles and validates at
**63,631,844 bytes / zero imports / 408,182 ms**, but **0/3 Wasm tests pass**;
diagnostic collection compiles and validates at **89,253,806 bytes / zero imports
/ 399,899 ms**, but **0/5 Wasm tests pass**. Logs are
`.tmp/ts5-source-factory.log` and `.tmp/ts5-source-diagnostics.log`; both drivers
exit 1. All eight throw opaque WebAssembly exceptions, not assertion passes.
These source results do not increase the accepted 25-test count.

Checkpoint `07a6a23cadc41e` records the new runner. Typecheck passed before the
diagnostic addition (`.tmp/ts5-source-suite-typecheck.log`). The next run adds
guest-side message capture, rethrows the same exception, and exposes text through
bounded numeric UTF-16 exports. No host imports or assertion changes. Its raw
Wasm sentinel verifies that the exception still escapes and its exact message
is readable; the diagnostic/worker controls pass **10/10**
(`.tmp/ts5-source-error-controls.log`). Typecheck after the diagnostic addition
also passes (`.tmp/ts5-source-errors-typecheck.log`).

Instrumented factory run completed in **158,195 ms**, valid **63,632,570-byte**
standalone module, **zero imports**, still **0/3 Wasm / 3/3 native**. Each guest
message says `Cannot access property on null or undefined`, at generated
819:27, 849:23, and 860:25: respectively the FIRST `ts.factory` access in each
callback (`createClassExpression`, `createObjectLiteralExpression`, and
`createIdentifier`). This is before any parenthesizing assertion. Next reduce
the namespace-imported exported factory value/initialization path; do not infer
the diagnostic-collection failure has the same cause without its own evidence.
Log: `.tmp/ts5-source-factory-error-text.log`; persistent report:
`tests/dogfood/report/typescript-source-unit-factory.json`. All compilation and
typecheck processes from this expansion are terminal; no live handle to resume.

Reduced the factory failure to a module exporting an accessor-bearing factory
alongside an unrelated mutable export. Both direct and barrel namespace imports
trap before the fix (**0/2**). Namespace-object materialization deliberately
declines when it cannot publish live bindings, but static variable reads also
declined source-module namespaces and fell through to a null receiver.
`tryEmitRuntimeNamespaceVariableValue` now resolves exact source-module export
declarations through the oracle and reads their program-ABI global, retaining
the dynamic TDZ check. Ambient and non-top-level declarations still decline;
the existing runtime-namespace ownership checks remain unchanged. The reduced
cases now pass **2/2**, zero imports, and the LOC/function gates pass without
new allowances. Added a same-named cross-module live-binding control as well.

Namespace fix checkpoint: `59dad92583ede4`. Real-source reruns are terminal:
factory **74714** (`.tmp/ts5-source-factory-binding.log`) compiles/validates in
184,181 ms at 63,616,239 bytes, zero imports, still **0/3 Wasm / 3/3 native**.
Its first/third failures moved past the initial factory reads to
`ts.SyntaxKind.StaticKeyword` (generated 820:78) and `ts.SyntaxKind.CommaToken`
(874:22). The second advances into `createArrowFunction`, where it traps with
an illegal cast (wasm-function 3010 at 0xdd4e8d, through
`__fn_tramp_createArrowFunction_1383`). Diagnostics **38802**
(`.tmp/ts5-source-diagnostics-binding.log`) compiles/validates in 236,473 ms at
89,255,662 bytes, zero imports, still **0/5 Wasm / 5/5 native**. All five fail
at `ts.ScriptTarget.ESNext` on the first `createSourceFile` call (generated
808:73, 830:73, 862:73, 885:73, 904:73). Next reduce qualified namespace enum
reads, then the arrow-factory cast separately. No imported-factory failure
remains at the original three sites; no new upstream pass is claimed.

Namespace controls pass **19/19**
(`.tmp/ts5-namespace-value-controls.log`), including exact cross-module identity,
existing namespace constructor controls and TDZ. Typecheck and scoped lint pass
(`.tmp/ts5-namespace-value-typecheck.log`). All runs from this expansion are now
terminal. The qualified enum dispatch currently calls `getConstantValue` in
`property-access-dispatch.ts`; inspect its receiver guard before changing it.

### Qualified const enum reads — 2026-09-08

Both direct and barrel imports of `ts.Kind.Next` / `ts.Kind.Text` reproduce
the null-namespace failure (**0/2 before**). The exact const-enum member branch
was enclosed in an identifier-only receiver guard, excluding `ts.SyntaxKind`.
It now accepts statically proven namespace qualification via
`static-enum-receiver.ts`. Qualification must resolve to namespace imports or
module declarations, not calls, getters or ordinary object bindings; the
existing exact const-enum declaration check and constant-value emission remain.
Direct/barrel reductions plus the existing nested const enum test pass **3/3**;
LOC/function gates pass without new allowances.

The enum-fixed source runs completed. Factory compiles/validates at 63,606,833
bytes, zero imports, 172,239 ms, still **0/3 Wasm / 3/3 native**. Its first case
now reaches a null dereference in the parenthesizer trampoline, the second still
traps inside `createArrowFunction`, and the third reaches `ts.Debug.formatSyntaxKind`
(generated 806:60), another nested namespace value path. Log:
`.tmp/ts5-source-factory-enum.log`. Diagnostics now fails compilation after
179,705 ms with `Maximum call stack size exceeded (at src/codegen/fixups.ts:207:17)`
(`.tmp/ts5-source-diagnostics-enum.log`); no binary or new pass is claimed.
Expanded enum/worker controls pass **12/12**, and typecheck passes.

The fixup recursion independently reproduces at 20,000 nested shared instruction
bodies (the 28-level and cross-function safety controls pass before the fix).
`repairBody` now uses an explicit child-first stack and a separate unchanged
pattern scan. It marks physical arrays on entry, preserves first-owner order,
and retains the cross-function refusal/diagnostic before traversal. Its child
enumerator is shared with the ownership scan and also covers `catchAll`.
Initial fixup controls pass **16/16**, including the deep graph; function/LOC
gates pass without new allowances. Added idempotence and catch-all coverage.

Both full-source retries completed, confirming stack-safe diagnostic compilation:
**89,252,855 bytes / validates / zero imports / 220,668 ms**, but still **0/5 Wasm
/ 5/5 native**. All five now reach `createDiagnosticForNode` and null-dereference;
the nearest source mapping is utilities.ts:2364 (`getSourceFileOfNode(node)`).
Log: `.tmp/ts5-source-diagnostics-stack-safe.log`. Next distinguish an absent
statement from a broken parent chain or diagnostic argument carrier; the shared
error signature alone does not prove which value is null.

Factory remains **0/3 Wasm / 3/3 native**, with a valid zero-import 63,606,837-byte
module in 164,782 ms (`.tmp/ts5-source-factory-locations.log`). The arrow cast
maps to nodeFactory.ts:3260, the parenthesizer call/body assignment. The first
failure is in `__fn_tramp_parenthesizeExpressionOfExportDefault_675`; its mapping
lands on parenthesizerRules.ts:668 (a different sibling), so treat that source
location as approximate rather than attributing the failure to that statement.
The third still fails at the original assertion's `ts.Debug.formatSyntaxKind`
read (generated 806:60). Investigate qualified runtime namespace function reads
and the lazily created parenthesizer's captured factory independently.

Final controls pass **21/21**, and typecheck passes (logs
`.tmp/ts5-enum-stack-final-controls.log`, `.tmp/ts5-enum-stack-typecheck.log`).
The final catch-all fixture/idempotence rerun passes **4/4**
(`.tmp/ts5-fixups-last-controls.log`). Source and regression formatting, scoped
lint, and function/LOC gates pass. No allowances or upstream assertions changed.
All handles from this turn are terminal. No additional upstream passes claimed;
the established projected suite remains the previously verified 25/25, with the
remaining full 256-file requirement and self-hosting goal still open.

### Qualified namespace and parenthesizer triage (2026-09-08, uncommitted)

Qualified runtime namespace reads/calls now use the static namespace proof for
`ts.Debug.format`, mutable `ts.Debug.enabled`, and direct calls. Direct/barrel
regressions improved from 0/2 to 2/2; focused namespace controls pass 21/21
(`.tmp/ts5-qualified-runtime-final.log`). Typecheck completed successfully
(`.tmp/ts5-qualified-runtime-typecheck.log`). Full factory remains 0/3 Wasm
versus 3/3 native, but the third failure advances into debug.ts:445, which
reflects `(ts as any).SyntaxKind`; runtime enum objects remain unsupported.
The zero-import factory module validates (63,605,817 bytes).

Full-source parser-parent triage passes 3/3: statement existence, parent
identity, and `getSourceFileOfNode` identity (83,351,219-byte valid zero-import
module; `.tmp/ts5-source-node-parent.log`). This rules out a universally broken
parent chain, not the full diagnostic unit's argument transport.

The shorter-arity parenthesizer fixture fails in both GC and standalone.
Standalone inspection independently gives realRules failure / nullRules=421;
disabling experimental IR retains the same result. Staged instrumentation
shows the memoizer callback returns, but the real parenthesizer method is never
entered. Generated Wasm proves the caller dispatch expects `(Node, i32)`, while
the named callback wrapper has `(Node, externref)`. The optional-declaration
parameter policy widens the implementation boolean, whereas
`compileCallablePropertyCall` resolves its interface parameter directly to i32.
The reference-only candidate bridge rejects that scalar/externref mismatch.

Diagnostic A/B on the current working tree, standalone raw Wasm, same extracted
fixture and compiler: changing only `optionalChain?: boolean` to required
`optionalChain: boolean` makes realRules=421 and nullRules=421 (2/2).
Logs: `.tmp/ts5-parenthesizer-no-ir.log`, `.tmp/ts5-parenthesizer-stage2.log`,
`.tmp/ts5-parenthesizer-required.log`; inspector
`.tmp/ts5-inspect-parenthesizer.mts`. This is diagnostic evidence, NOT a source
workaround or an upstream pass. Preserve optionality in the actual fix and cover
named/arrow callbacks, boolean/number values, missing arguments, and side effects.
Do not assume this optional-boolean defect explains every full factory failure.
All processes started during this triage are terminal. Full upstream unit-suite
acceptance and self-hosting remain unfinished.

### Optional callable ABI implementation (2026-09-08, uncommitted)

Callable property and element signature lowering now applies the same optional
scalar policy as named declaration wrappers. Arrow/function-expression wrappers
also apply that policy, and explicit scalar `T | undefined` syntax retains the
dynamic carrier just like `T?`. The latter is required by TypeScript's scanner:
its interface uses optional parameters while its implementation uses explicit
undefined unions. Native annotations and parameters with defaults keep the
existing policy. No runtime dispatch fallback or upstream source workaround was
added.

The original real/null parenthesizer regression passes in GC and standalone
(2/2). New optional-property tests exercise named and arrow boolean/number
callbacks, omission, explicit undefined, false/true/zero, and side-effect count;
they pass in both lanes. Array-held optional callbacks also pass (2/2 updated
tests, `.tmp/ts5-optional-elements.log`). Broader controls pass 27/27 across
eight files (`.tmp/ts5-optional-abi-final-controls.log`), plus optional direct
closure calls 2/2. An intermediate arrow-only NaN result and scanner-padding
failure drove the uniform ABI policy; both now pass.

An additional legacy `tests/optional-params.test.ts` run fails 3/3 during host
instantiation because it supplies only hand-written console imports and omits
the generated `string_constants` imports. Its first expected value also treats
`10 + undefined` as 10 rather than NaN. It was not changed or counted as passing;
baseline attribution has not been measured. Final post-element-edit scoped lint,
typecheck, diff whitespace check, and LOC/function gates pass (logs
`.tmp/ts5-optional-abi-complete-{typecheck,loc,func}.log`).

The first full-source factory retry, launched before the arrow/union alignment,
compiled a valid zero-import 63,092,533-byte module but remains 0/3 Wasm versus
3/3 native (`.tmp/ts5-source-factory-optional-abi.log`, 163,987 ms). Same three
runtime boundaries remain, so the reduced fix is not evidence that the full
factory failures are resolved. The aligned retry completed: valid zero-import
62,956,028-byte module, 155,404 ms, still 0/3 Wasm versus 3/3 native, with the
same null-pointer, arrow-body cast, and debug enum-reflection failures. Log:
`.tmp/ts5-source-factory-optional-abi-final.log`; it started before the final
element-access alignment. All processes from this implementation turn are now
terminal. Next isolate the actual full-source factory node/callback carrier,
not the already-fixed reduced optional-parameter mismatch.

### Actual-source parenthesizer boundary probe (2026-09-08)

Added `typescript-source-factory-parenthesizer-workload.ts` with six independent
numeric oracles against the pinned real compiler source: object/class creation,
direct concise-body/export parenthesizer calls, and arrow/export factory calls.
This avoids depending on debug enum formatting during triage without modifying
or accepting any upstream assertion. The initial probe completed: 2/6, valid
59,974,784-byte zero-import module, 162,709 ms compile. Object/class creation
pass; both direct parenthesizer calls fail just like the enclosing arrow/export
factory calls (concise body illegal cast; export parenthesizer null pointer).
Log `.tmp/ts5-factory-parenthesizer-source.log`. Thus neither upstream assertion
formatting nor its test callback harness is necessary for these failures.
Expanded the same fixture to ten cases: direct parenthesized node construction,
getLeftmostExpression identity, skipPartiallyEmittedExpressions identity, and
the no-parentheses-needed identifier path. Session 59274 is running, log
`.tmp/ts5-factory-parenthesizer-source-expanded.log`.

Fresh namespace controls pass 21/21. The selected upstream adapter was first
run in its default GC lane: 14/25 (compilerCore 5/11, convertToBase64 0/5;
other files 9/9). This is not the standalone goal lane and has no measured
same-lane baseline in this turn. The explicit standalone recheck completed:
25/25 native and Wasm, 5/5 compiled modules, actual target standalone, zero
imports, 251/256 upstream files deferred. Log
`.tmp/ts5-projected-standalone-after-optional.log`. No full-source upstream
unit pass is inferred from this projected selection.

Main-sync verification (2026-09-08): fetched `https://github.com/loopdive/js2.git`
and independently checked live `refs/heads/main` at
`04c8e72156cf576cf584a3ed3a5a66ec5a2b91b0`. That commit is already an ancestor
of `codex/1058-typescript-standalone` HEAD `ac266354848de0`; zero incoming
commits, so no merge was needed. All pending implementation and test changes
were preserved; no tests rerun for this no-op synchronization.

Signed checkpoint: `ac266354848de0`. Post-checkpoint projected-suite regression
run completed with **25/25 native and Wasm**, **5/5 modules compiled/validated**,
**zero imports** (`.tmp/ts5-projected-after-enum-stack.log`, exit 0). This confirms
the existing slice remains intact; its inventory still explicitly defers 251
of 256 files. No live process remains from this turn.

### Source-defined collection carrier investigation (resumed)

Generator-method follow-up after `085c67795aad5e`: WAT for the real `*entries()`
method shows an ordinary closure executing its loop and dropping each yield,
then returning undefined. The open-object method path passes a MethodDeclaration
through the function-expression closure API, whose generator checks only
recognized FunctionExpression nodes. Testing recognition of MethodDeclaration
at signature selection, closure registration, and native frame emission; a new
regression checks lazy creation, captured state, tuple yields and exhaustion.
This fix now passes **25/25 selected upstream tests**, **5/5 modules compiled
and validated**, **zero imports** (`.tmp/ts5-upstream-all-selected.log`). This is
still only **5/256 upstream files**; the 251 deferred files and full compiler /
self-hosting acceptance remain open.

Open-method `this` now uses the existing frame-carried dynamic receiver when
there is no synthesized receiver parameter. Direct `.next()` also exposed a
dead host import retained by `__any_iter_next`; its final fill now includes the
legacy fallback only if a legacy generator factory actually emitted, matching
the native generator dispatcher's existing rule.

Focused final run: **24/24** across five files, including two new open-object
generator tests, lazy generator expressions, destructuring methods, dynamic
receiver capture, and collection iterator prototypes. Log:
`.tmp/ts5-open-generator-final-controls.log`. Shared generator-node recognition
was extracted into `closures/generator-declaration.ts` to keep the signature
and body paths consistent and satisfy the function budget without allowances.
Full parser recheck passed **3/3 exact fingerprints**, with a valid 80,351,322-byte
module and **zero imports**, in 461,664 ms (five warnings, zero errors).
Evidence: `.tmp/ts5-parser-open-generator-method.log`.

Requested main sync: fetched and independently checked live upstream main at
`04c8e72156cf576cf584a3ed3a5a66ec5a2b91b0` (six incoming commits). Saved the
generator-method changes in signed checkpoint `05a791a94bafcc`, then merged
without conflicts in signed merge `8e29e3a4136e2b`. Verified upstream is an
ancestor (zero commits behind). No manual stash or changes to the unrelated
dirty main checkout. Post-merge controls pass **14/14 across three files**:
open-object generator methods and the incoming conditional-alias property-write
tests, including console coverage (`.tmp/ts5-main-sync-controls.log`). The full
parser and selected upstream suite results above precede this merge; neither
was rerun as part of this sync-only request. No push or PR was performed.

Next-boundary investigation after checkpoint `9465e0c392cdd0`: the reduced real
factory probe's `arrayFrom(set.values())` returns all three values (sum 6), while
`forEach` throws `TypeError: Cannot access property on null or undefined` at the
callback invocation in release-core line 152. A separate native-Set callback
with three supplied arguments and a one-parameter consumer passes. These are
diagnostic controls, not evidence that the two remaining upstream cases share
a cause. Diagnostic logs: `.tmp/ts5-custom-set-error.log` and
`.tmp/ts5-collection-callback-minimal.log`.

The decisive reduction is a multi-file source `createSet<T, H>` with a captured
element and a `forEach(action)` method. The number-typed consumer failed while
an otherwise identical `any` consumer passed. Preserve the callback parameter
as externref only when the source factory method itself declares that callback
parameter using a type parameter owned by the factory. Inspect the source
method, not merely the ambient Set interface: the latter incorrectly widened
a non-generic source-method control. No new raw-checker query or shared mutable
registry is introduced.

Verified result after this follow-up: **24/25 original admitted tests pass**,
compilerCore **10/11**, all **5/5 modules compile and validate with zero imports**.
Only upstream `iteration` remains failing in this selected set. `forEach` now
passes unchanged; the adapter regenerated the release projection, removing all
temporary diagnostic edits before this run. Log:
`.tmp/ts5-upstream-source-callback-proof.log`. Scope remains 5/256 files admitted,
251 deferred; this is not completion of the standalone compiler/unit-suite goal.

Focused controls: **16/16** across the new five-case collection-callback test,
four collection-carrier checks, and seven optional standalone Set checks. The
callback cases include native and non-generic source controls plus later-module
number/any/Boolean consumers. Log: `.tmp/ts5-source-callback-final-controls.log`.
Format/lint and LOC/function budgets pass without new allowances. Full parser,
binder, checker and all-unit-suite acceptance have not been rerun or established.
The next reduced failure is `arrayFrom(set.entries())`: it throws
`TypeError: value is not iterable`, while `arrayFrom(set.values())` and `forEach`
each return all three values (sum 6) in the same real-factory probe. Inspect the
`*entries()` method's nested `getElementIterator()` loop next. Log:
`.tmp/ts5-custom-set-entries.log`; probe `.tmp/ts5-custom-set-probe.ts`.

The real `createSet` factory returns an open object, not native Set storage.
Reduced standalone probes now preserve initial size, mutation, and `return this`
identity. Added a durable four-case native-vs-Wasm regression covering a direct
factory, native Set, asserted object literal, and a shorthand callable property
inside a callback; all four pass with zero imports
(`.tmp/ts5-source-collection-test5.log`). Type assertions also need unwrapping
when selecting the local's physical carrier. The final four-case run also
exercises the source-defined `forEach` callback
(`.tmp/ts5-collection-foreach-controls.log`, 4/4 passing).

The selected upstream adapter creates `const ts = { createSet, ... }`, rather
than a module namespace. Its callable-property result ABI was still casting
the factory result to native Set. Resolving the shorthand through oracle
declarations and retaining an externref result exposed a compile-time stack
imbalance: the array `forEach` fast path tried to construct a five-field Map
using a two-field array layout. Declining array/native collection dispatch for
the source-object carrier resolves that compile failure.

Final upstream run: **23/25 passing, 5/5 modules compiled and validated, zero
imports**, up from **19/25** on the previous checkpoint. CompilerCore is **9/11**;
mutation, resizing, clear, and string-hash tests now pass. `forEach` and
`iteration` still throw opaque Wasm exceptions. The suite still admits only
5/256 upstream files; 251 remain deferred. See
`.tmp/ts5-upstream-source-collection-no-array.log` and the generated report.
No assertions or compiler verification gates were weakened. Full parser/binder
checks have not been rerun on this candidate.

Ancillary controls: Date/accessor-import files pass; the accessor-widening file
passes 13/14, with its GC-only data-property control returning 0 instead of 1.
That failure has not been A/B-attributed to this change. All seven standalone
cases in that file pass. Typecheck, scoped lint, LOC and function budgets pass;
no new allowance was added. Temporary stack-balance tracing was removed.
Additional collection/call controls pass 18/20: optional-method padding 7/7,
optional standalone Set 7/7, optional Map-size 3/4, Proxy carrier 1/2.
The remaining failures are GC Map-size (-1 vs 256) and a Proxy-global shape
assertion expecting a non-externref slot; neither is A/B-attributed here.
Log: `.tmp/ts5-collection-native-controls.log`.

Fetched `main` directly from `https://github.com/loopdive/js2.git` and
independently verified its live ref as
`16498efb481cb022ee5c4dcc9bb137b6d4c91a50`. The TypeScript worktree branch
`codex/1058-typescript-standalone` at `5e7d1d1302178a` already contains that
commit (8 commits ahead, 0 behind), so no merge was necessary. Preserved the
four uncommitted source-collection carrier investigation files unchanged.
This synchronization check does not constitute new compiler/test validation.

## PR handoff — 2026-09-06

### Resumed optional-parameter investigation — 2026-09-08

Typed-array delegation follow-up: the numeric-only slot registration hardcoded
the f64 vector even though slots already record an element type. Resolve the
source array's actual vector layout and coerce the loaded element to the
generator result carrier. Include delegated array element facts in carrier
selection (otherwise object-only `yield*` defaults to f64). The generic iterable
admission query now uses the oracle's well-known iterator fact instead of raw
checker property enumeration; this offsets the one layout-resolution query
without adding a checker-usage exception.
Fresh upstream run with typed slots reaches **19/25** tests, native 25/25,
compilerCore 5/11 and zero generator imports. The six now-executing failures
are illegal casts in mutation, resizing, clear, forEach, iteration and string
hash code. Expanded worklist controls are **7/8**: direct object-array iteration
returns 12 and writes back to both original objects; generic factory-backed
`runObjects` still throws a WebAssembly exception. Existing array/iterable/
try-region controls pass **32/32**. Logs: `.tmp/ts5-typed-delegate-carrier.log`,
`.tmp/ts5-typed-delegate-stable-controls.log` and
`.tmp/ts5-upstream-typed-delegate-final.log`. Typecheck/lint pass. Layout
resolution was extracted into a helper to pass the function-size gate, without
adding an exception. This is not a full-suite passing claim; 251 files remain
deferred, and the newly executable createSet tests expose the next cast frontier.

Generator frontier follow-up: fresh upstream adapter on `3e0d2386` still
measures native 25/25, standalone 14/25, 251/256 files deferred. The worklist
reduction reproduces generator imports (runAll) and rejected cleanup shapes
(runReturn/runThrow). Implementing structured unwind for numeric-vector
delegation, preserving the guard for generic/native-generator delegates until
their full return/throw/done-false forwarding is implemented. Array delegation
must replace a thrown value with TypeError when its iterator lacks `throw`,
then run enclosing cleanup; removing the admission guard alone is unsound.
The new path passes **6/6** standalone/native-oracle checks: complete worklist,
outer iterator close on return, missing-throw TypeError and cleanup, caught
TypeError followed by a yield, original thrown value before delegation starts,
and finally suspension with done=false before resuming the pending return.
The last case's generator declares a numeric return via `return 0` so its
`.return(9)` call is type-correct; expected native/standalone behavior is 1.
The existing array/generic iterable/try-region controls pass 32/32 separately.
Fresh upstream rerun remains **14/25**: compilerCore still imports four host
generator helpers. Its `getElementIterator` delegates generic `TElement[]`
after `isArray(value)`; widening typed vector delegation beyond numeric storage
and implementing general iterator protocol forwarding remain the next steps.
Do not claim the reduced numeric worklist resolves compilerCore yet.

The merged optional-vector reduction still returns `[7, 7, 8]` instead of
`[17, 7, 8]`. Its emitted WAT declares `wrap` with parameters `(ref null 50),
i32`, while nested `make` takes `(ref null 50), externref`: the omitted optional
boolean is already false before the factory sees it. Both resolved-generic
registration paths in `declarations.ts` bypass the existing optional declaration
parameter helper. Applying that helper to copied resolved parameter arrays
fixes both original failing cases without changing their expected values.
Added explicit-undefined boolean and optional-number controls in both lanes.
The expanded factory file plus generic identity/callback and main's dynamic
result/rest-callable controls pass **107/107**. Nested optional-parameter and
rest-vector controls measured **11/13** before the new tests: only the two
already documented absent optional-array-field assertions fail.
Full standalone parser acceptance on `3e0d2386f83a30` now passes **3/3**:
performance 49645738923599, builder 13386537220945, core 40098163538143.
The binary is **80,351,322 bytes**, validates and executes with **zero imports**.
Elapsed wall time 255,164 ms; five diagnostics are warnings, not errors.
Local log: `.tmp/ts5-parser-main-sync-optional.log`; process completed normally.
Typecheck, lint, formatting and file/function size gates pass. Full binder and
upstream unit-suite coverage still require fresh post-sync verification; the
next broad frontier remains generator support and expansion beyond 5/256 files.

2026-09-08: merging this work branch with fetched `loopdive/js2` main
`16498efb481cb022ee5c4dcc9bb137b6d4c91a50` (680 incoming commits).
The pre-sync measurements below are not validation of the merged candidate.
Resolved three textual conflicts, retaining both source-function shadowing and
main's WASI ArrayBuffer identity, both candidate snapshot and rest dispatch
support, and both object-spread/accessor imports. Removed a duplicate import
and an overlapping abstract-reference truthiness arm exposed by typecheck.
Focused merged-candidate check: 102/104 tests pass across six files. The two
optional-vector factory preregistration cases (GC and standalone) return 7
instead of 17; their origin has not been established by a baseline comparison.
Main's dynamic-result/rest-callable/ArrayBuffer tests and the branch's builtin
shadowing/module-function-identity controls pass. No full parser/binder rerun.

This is an incomplete checkpoint, not completion of the TypeScript 5 unit-suite
or self-hosting goal. Work is paused at the user's request. This summary
supersedes pending-run and binder-trap attribution in the chronological notes.

**Publishing blocker:** signed checkpoint `1e18c20f9740220425c3eb94c86789d1cb7130f9`
is local; no PR has been opened. Pre-push typecheck, lint and formatting pass,
but the oracle ratchet rejects net new checker usage in eight paths:
`expressions.ts`, `expressions/optional-native-set.ts`,
`generic-scalar-union-result.ts`, `indexed-object-spread.ts`,
`json-record-array.ts`, `optional-declaration-parameter.ts`,
`source-function-call.ts`, and `uninitialised-variable-undefined.ts`
(all under `src/codegen/`). The reported unallowed growth is five
`getTypeAtLocation` and fifteen `ctx.checker` references. Migrate these to
`ctx.oracle` while preserving source identity and ABI decisions, or obtain
explicit user approval for issue-scoped exceptions. Automated safety review
rejected adding those exceptions without approval; no exceptions were added
and neither hooks nor signing were bypassed.

### Measured state

- **Latest binder candidate: 5/5 exact checks pass**, including both original
  binder workload cases (2/2). It compiles to 88,010,457 bytes, validates and
  instantiates with **zero imports**. Results: diagnostic array before bind 0;
  push before bind 1; const-local fingerprint 65792; duplicate-let fingerprint
  131330; detailed duplicate diagnostics 1 (positions, messages and file identity).
  Local evidence: `.tmp/ts5-binder-rest-fixed.log`, completed run 85103.
- **Parser: 3/3 original fingerprints passed** at the earlier parser checkpoint:
  performance 49645738923599, builder 13386537220945, core 40098163538143;
  79,134,616 bytes, zero imports. This measurement predates the latest factory,
  rest-vector and stack-safety changes; rerun it on the final checkpoint.
- **Selected upstream unit adapter: native 25/25, standalone 14/25**, measured
  on an earlier candidate. Only 5/256 upstream files were selected; 251 files
  and 1,736 registrations remained deferred. All five modules compiled and
  validated; compilerCore's 11 cases stopped before execution on generator
  imports (`__gen_create_buffer`, `__gen_push_ref`, `__gen_yield_star`,
  `__create_generator`). This is not full-suite coverage.
- Latest source gates passed: TypeScript typecheck, function/LOC budgets and
  whitespace check. Focused results: WAT stack/format controls 21/21;
  peephole DAG/order controls 13/13 plus dead-load runtime controls 4/4;
  diagnostic array initialization 5/5; capture controls 2/2; formatter controls
  4/4. No full repository regression suite was completed for this checkpoint.

### What changed and what remains

The latest binder fix registers rest metadata for resolved generic signatures
and compiles the trailing spread against the callee's vector type. The old
illegal cast was **relatedInformation passed to addRelatedInfo**, not the
bindDiagnostics getter: exact trap bytes identified `ref.cast_null 517` with
the source vector stored as type 494. The latest full binder run confirms both
duplicate-diagnostic cases now execute successfully.

The checkpoint also preserves exact source-function identity across modules,
respects source shadowing of builtin Symbol, bridges tagged callback results,
preserves already-tagged AnyValue payloads, supports fresh asserted object
factories, and makes peephole traversal and diagnostic WAT printing stack-safe.
Earlier runtime/collection/Buffer and upstream-harness work is retained below.

Known red tests are deliberately retained, so this PR is genuinely WIP:

1. Rest-spread diagnostic reduction: **3/5 pass**. The empty optional array
   field reads as null instead of strict undefined; a no-rest control reproduces
   it independently. Do not misattribute this to the now-passing binder cast.
2. Generic scalar roundtrip: **1/2 pass**, dependent on first instantiation.
3. Source diagnostic constructor reduction: **1/2 pass**; explicit TypeScript
   `this` is treated as a user parameter in the failing constructor path.
4. Generator worklist delegation: native **3/3**, standalone **0/3**. Implement
   correct iterator return/throw, done-false and outer-unwind behavior; do not
   simply remove the state/finally guard.
5. Some GC/factory and legacy host-harness controls remain red as detailed
   below. Existing rest lowering also needs fresh-array semantics and general
   multiple-rest/spread handling; the latest fix does not claim to solve these.

Resume by rerunning parser acceptance on this checkpoint, fixing the retained
reductions and generator frontier, then expanding actual upstream unit coverage.
Checker compilation/execution, all 256 unit files and self-hosting remain open.
Keep the original fingerprints and strict assertions; do not weaken them.

### Reproduce the expanded binder check

Use the pinned runtime setup described in `tests/dogfood/README.md`, then:

```sh
node --experimental-wasm-exnref tests/dogfood/typescript-upstream-build-probe.mjs \
  --root tests/dogfood/.npm-upstream-suites/typescript --prepare-pinned-typescript \
  --mode source --entry ../../fixtures/typescript-binder-diagnostic-details.ts \
  --consumer-driven-barrels --target standalone --require-invocations 5 \
  --invoke-zero-case runDiagnosticArrayBeforeBind=0 \
  --invoke-zero-case runDiagnosticArrayPushBeforeBind=1 \
  --invoke-zero-case runConstLocal=65792 \
  --invoke-zero-case runDuplicateLet=131330 \
  --invoke-zero-case runDuplicateDiagnosticDetails=1 \
  --timeout-ms 1200000 --heap-mb 4096 --json
```

Generated `.tmp` logs, Wasm binaries and million-line WAT dumps are local
diagnostic artifacts, not PR contents. No verification process remains running.

## Goal

Use the actual [`typescript`](https://github.com/microsoft/TypeScript) npm package as the **fifth** real-world stress test for js2wasm, alongside #1031 (lodash), #1032 (axios), #1033 (react), and #1034 (prettier). The TypeScript compiler is the ultimate self-hosting milestone: **js2wasm compiling the compiler that js2wasm itself uses as its TypeScript frontend.**

This is distinct from the already-done **#452** ("Compile TypeScript compiler to Wasm"), which was a feasibility study using a hand-written 411-line toy scanner/parser that imitated TypeScript patterns. #452 concluded "95% of TypeScript patterns compile" — necessary validation, but not an attempt on the real thing. This issue is the real attempt.

## Why the TypeScript compiler specifically

- **~500K lines of mature production TypeScript** — biggest real-world corpus anywhere (vs 17K lodash, ~100K prettier, ~70K react, ~7K axios)
- **Exercises every language feature simultaneously** — parser, binder, type checker, emitter, language service, incremental compiler, module resolution
- **Self-hosting signal is the strongest correctness test possible**. If js2wasm compiles tsc, and compiled-tsc can then compile a non-trivial `.ts` file that matches native-tsc's output, that's a full round-trip semantic check of every path the compiler uses itself
- **No DOM, no Node builtins beyond `node:fs`** — clean host-import boundary (same approach as axios #1032 + WASI #1035 + #1044)
- **Recursive AST traversal + visitor pattern at massive scale** — surfaces every latent codegen issue
- **Huge switch statements on `SyntaxKind`** — hundreds of cases per binder/checker/emitter function; stresses large-switch codegen
- **Known challenges embedded:** template literals with `${}` interpolation (the 1/20 failure in #452), complex conditional/mapped types, recursive type definitions, AST node pool lifetime

## The moonshot — tiered acceptance

Escalating difficulty:

1. **Tier 1 (pattern validation — already done in #452):** TypeScript-compiler-shaped patterns compile. ✅ 19/20
2. **Tier 2 (real compiler leaves):** individual source files from `typescript/src/compiler/` compile without modification
3. **Tier 3 (scanner + parser):** compile `typescript/src/compiler/scanner.ts` + `parser.ts` so the resulting Wasm parses simple `.ts` source to an AST
4. **Tier 4 (checker subset):** compile enough of `checker.ts` to type-check `const x: number = "str"` and report TS2322
5. **Tier 5 (emit):** compile enough of `emitter.ts` to emit a `.js` file from a compiled AST
6. **Tier 6 (full round-trip):** compile a tsc subset end-to-end; hand it a `.ts` file, produce a `.js` file that matches native-tsc byte-for-byte (parallel to prettier's self-format diff #1034)
7. **Tier 7 — the moonshot (self-hosting):** compile js2wasm's own source with compiled-tsc and verify the second-stage js2wasm still compiles test262 correctly

**Tier 7 is aspirational. Tier 3 is the realistic sprint target. Tier 4 is the headline win.**

## Hard prerequisites

This issue depends on:

- **#1042 async/await state-machine lowering** — TypeScript's incremental compiler and project references use `async` extensively. Without real async, Tier 3+ is blocked.
- **#1044 Node builtin modules as host imports** — TypeScript uses `node:fs`, `node:path`, `node:util`, `node:crypto`. Required for loading the compiler's own source files from disk.
- **#1046 separate ES-module compilation with consumer-driven type specialization** — TypeScript's source is split across ~300 ES modules with a complex import graph. Current whole-program compile won't scale; this is a hard architectural blocker for Tier 2+.

Soft prerequisites (not strict blockers but would improve realization rate):

- **Template literal with `${}` interpolation** — #452's only known pattern gap. TypeScript uses these in hundreds of places for error message formatting
- **Large switch codegen scaling** — `binder.ts`, `emitter.ts`, and `checker.ts` each have switch statements with 200+ `SyntaxKind` cases. Our codegen currently emits linear if/else chains — won't fit
- **Recursive generic types** — `ts.Type`, `ts.Node`, `ts.Symbol` are deeply recursive with polymorphic `parent: Node | undefined` chains. If WasmGC struct layout doesn't support this cleanly, we hit walls in Tier 2
- **BigInt** — TypeScript uses BigInt in a few places (checksum/hash); not critical but breaks some modules

## Approach

### Step 1 — Start with leaf modules

Before touching the real compiler, pick the smallest self-contained files in `typescript/src/compiler/` with minimal external dependencies. Candidates:

- `typescript/src/compiler/core.ts` — pure utility functions (mapping, hashing, string helpers)
- `typescript/src/compiler/path.ts` — path manipulation (pure string operations)
- `typescript/src/compiler/debug.ts` — debug assertions
- `typescript/src/compiler/performance.ts` — performance instrumentation

Start with `core.ts` or `path.ts`. These are leaf dependencies with minimal external surface.

### Step 2 — Build a harness

Create `scripts/ts-compiler-stress.ts`:

```ts
import { compile } from '../src/index.ts';
import { readFileSync } from 'node:fs';

const tiers = {
  t2_leaf: [
    'node_modules/typescript/src/compiler/core.ts',
    'node_modules/typescript/src/compiler/path.ts',
  ],
  t3_scanner_parser: [
    'node_modules/typescript/src/compiler/scanner.ts',
    'node_modules/typescript/src/compiler/parser.ts',
  ],
  t4_checker_subset: [
    'node_modules/typescript/src/compiler/checker.ts',
  ],
  t5_emitter_subset: [
    'node_modules/typescript/src/compiler/emitter.ts',
  ],
};

for (const [tier, files] of Object.entries(tiers)) {
  console.log(`=== ${tier} ===`);
  for (const file of files) {
    const src = readFileSync(file, 'utf-8');
    const result = await compile(src, {
      fileName: file,
      esModulesAsHostImports: true,
      nodeBuiltinsAsHostImports: true,
    });
    console.log(result.success ? `  OK   ${file}` : `  FAIL ${file}: ${result.errors[0]?.message?.slice(0, 100)}`);
  }
}
```

### Step 3 — Categorize failures

Same as other stress tests (#1031-#1034): cluster by pattern, sample 2-3 per bucket, file follow-up issues for each concentrated cluster. Expected top buckets:

- Large switch dispatch codegen failures
- Template literal with interpolation (known #452 gap)
- Recursive generic types in declarations
- Module graph compile errors once #1046 lands
- New AST node kinds used internally by TypeScript that js2wasm doesn't handle

### Step 4 — The partial-compile validation

Once Tier 3 compiles (scanner + parser), build an incremental end-to-end test:

```ts
const compiledTs = await loadCompiledTypescript();
const sampleSource = 'const x: number = 1 + 2;';
const compiledAst = compiledTs.parseSource(sampleSource);
const nativeAst = ts.createSourceFile('sample.ts', sampleSource, ts.ScriptTarget.Latest);
assertASTEqual(compiledAst, nativeAst);
```

If compiled scanner+parser produces the same AST as native TypeScript for a set of representative input files, Tier 3 passes.

### Step 5 — Follow-up issues

Expected 5-15 new follow-up issues from Tier 2-3, each scoped narrowly enough for one sprint (one PR).

## Upstream-source experiment (2026-08-09)

### Provenance and comparison lane

The experiment used the exact upstream `microsoft/TypeScript` `v5.9.3` tag
(`c63de15a992d37f0d6cec03ac7631872838602cb`). The downloaded source archive
had SHA-256
`d371a2430d6305290d1bddaf195fdd629d1a8708cda08f4a72fc923b65d36c4a`.
Its checked-in `lib/typescript.js` and the pinned npm-compat fixture's
`package/lib/typescript.js` are byte-identical (both SHA-256
`3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675`).
This makes `--mode bundle` versus `--mode source` a representation comparison,
not a version comparison.

The committed worker-isolated probe runs both representations through the same
options:

```text
allowJs: true
skipSemanticDiagnostics: true
target: "gc"
platform: "node"
```

`allowJs: true` deliberately keeps the npm-compat diagnostic policy identical
for both lanes; `.ts` files are still parsed as TypeScript by extension. The
probe streams compiler phases and samples CPU, RSS, and worker event-loop
utilization, so a bounded timeout is distinguishable from an idle/deadlocked
process.

```bash
node tests/dogfood/typescript-upstream-build-probe.mjs \
  --root /path/to/TypeScript-5.9.3 --mode source \
  --timeout-ms 1800000 --heap-mb 4096 --json
```

### Full upstream source

`src/typescript/typescript.ts` resolves **280 input files / 13,780,098 bytes**.
On the clean overload-fix snapshot
`1d260d48a0d01ce3319f3017b81bf8f831f4f6f5`, the compiler passed the four
generic overload-owner frontiers recorded in #4267, #4268, #4270, and #4272.
At the 900-second cap it was actively emitting bodies: the last completed file
was `src/compiler/_namespaces/ts.moduleSpecifiers.ts`, followed by
`src/compiler/checker.ts`. At a near-terminal snapshot it had accumulated
11:22.67 CPU time; peak observed heap was 1,994.0 MB. This was a throughput
frontier, not a new semantic diagnostic.

A second run gave the source path twice as long and doubled the worker heap:

| budget | heap limit | result | CPU time | average cores | peak RSS | binary |
| ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 1,800,000 ms | 4,096 MiB | bounded timeout | 1,681,964 ms | 0.93 | 2,531.7 MiB | 0 bytes |

That run remained CPU-active and repeatedly grew and garbage-collected its
heap through the exact 1,800,022 ms wall-clock cutoff. It was measured from the
npm-compat integration worktree at head
`8173091329ed37bf7e641e31456005e0e6e79aa4`; unrelated uncommitted dogfood
changes were present, so use the run as a scale/liveness measurement, not as a
stable performance baseline. It produced no result object or Wasm binary.

For comparison, the canonical published-bundle catalog run also produces no
binary before its 600,000 ms cap (`600,076 ms` observed). Upstream source is
therefore **not a compile-time shortcut today**. Its advantage is structural:
module boundaries turn the bundle's opaque large-IIFE frontier into named,
measurable source-file work and exposed four generic overload bugs that are now
fixed.

### Original parser-source slice

The smallest unmodified parser consumer used this wrapper only to make the
result observable:

```ts
import { createSourceFile } from "./src/compiler/parser.js";
import { ScriptKind, ScriptTarget } from "./src/compiler/types.js";

export function runCase(): number {
  const source = createSourceFile(
    "input.ts",
    "export const answer: number = 6 * 7;",
    ScriptTarget.Latest,
    true,
    ScriptKind.TS,
  );
  return source.kind * 1000 + source.statements.length;
}
```

Native TypeScript returns **308001** (`SourceFile.kind === 308`, one
statement). The unchanged upstream parser graph was compiled with:

```bash
node tests/dogfood/typescript-upstream-build-probe.mjs \
  --root /path/to/TypeScript-5.9.3 --mode source \
  --entry js2-parser-workload.ts --timeout-ms 900000 --heap-mb 4096 --json
```

The resolver admitted **82 input files / 82 user source files / 86 TypeScript
Program files** and planned 336 module-init statements. It reached the same
`ts.moduleSpecifiers.ts` → `checker.ts` boundary, then remained CPU-bound until
the exact 900,028 ms cutoff: 918,534 ms CPU, 1.02 average cores, 1,308.7 MiB
peak RSS, worker event-loop utilization 1.0, and no binary. Because no Wasm
module exists, **308001 is only the native oracle; no parser parity or package
test pass is claimed**.

The unexpected checker dependency is not inherent to parsing. Upstream
`parser.ts` imports `./_namespaces/ts.js`, and that generated barrel re-exports
`checker.ts`, the emitter, transformers, builders, watch support, and the rest
of the compiler. Direct parser source removes the `services`, `server`, and
`jsTyping` graphs (280 → 82 inputs), but the current recursive resolver retains
every re-export instead of only the named bindings consumed by the parser.

### Consumer-driven specialization slice

The first #1046-shaped slice is now implemented as an explicit
`resolve.consumerDrivenBarrels` mode. It tracks named demand through pure
import/re-export barrels, derives demand from static namespace property reads,
and specializes ordinary provider files by blanking unreachable function and
type declarations while preserving line positions. A dynamic namespace use,
an incomplete/cyclic export surface, or a side-effect-only import retains the
full edge. The option remains **off by default**: opting in is the caller's
explicit assertion that unused import/re-export targets and unreachable
declaration bodies in the generated source tree do not have required
initialization effects.

On the exact upstream `v5.9.3` parser wrapper this reduces the graph from **82
input files / 86 Program files to 31 input files / 35 Program files**. The
selected graph no longer contains the emitter, build, watch, or language-service
subsystems. `checker.ts` is still present only for the `getNodeId` leaf used by
`nodeFactory`; specialization blanks 98.3% of its non-whitespace source
(2,178,565 → 38,005 characters). The largest remaining provider is
`nodeFactory.ts`: its single demanded factory returns a large method object, so
declaration-level specialization cannot yet remove individual returned
properties.

The probe now accepts an invocation export, a runtime string, and a numeric
oracle. This keeps the parser input dynamic instead of embedding it in the
wrapper. Native TypeScript returns **308001** for
`"export const answer: number = 6 * 7;"` and **308002** for
`"let a = 1; let b = 2;"`; a future Wasm success must invoke the compiled
`runCase(sourceText)` export and match the requested value before the probe can
pass.

With the four generic overload fixes (#4267, #4268, #4270, #4272) layered for
validation, the specialized static-input wrapper reached final codegen in
251,093 ms at 555.5 MiB peak observed RSS instead of timing out at 900,028 ms
and 1,308.7 MiB on the unspecialized graph. It exposed two generic finalization
gaps: nested `InterfaceDeclaration` statements were incorrectly reported as
runtime statements, and the constant-box walker revisited shared instruction
arrays once per incoming edge. Focused fixes now ignore nested type-only
declarations and visit instruction-array DAG nodes once.

The authoritative **dynamic-input** run still produces no binary. With the
same 31-file graph it remained CPU-active through a 300,300 ms cap (264,014 ms
CPU, 609.5 MiB peak RSS) after compiling 3,252 function bodies. Disabling
constant-box hoisting also timed out after the last profiled
`declared-func-refs` phase (300,083 ms, 206,033 ms CPU, 643.6 MiB peak), proving
that the residual finalization tail is not solely that pass. Consequently
there is still **no 308001 Wasm parity claim**. The next leverage is
consumer-driven property specialization of returned method tables—especially
`createNodeFactory`—plus phase-level profiling of the post-body finalizers.

### Suspended handoff (2026-08-09)

The consumer-driven specialization is committed as `7a50f7fd9a34fd` on the
published `codex/npm-compat-handoff` branch. There is no later uncommitted
TypeScript experiment.
The authoritative dynamic probe remains CPU-active rather than idle: it has
compiled 3,252 bodies when the 300.3-second child budget terminates it, but it
never emits a binary. Therefore TypeScript does **not** compile yet and 308001
is still only the native oracle.

Resume with phase-level profiling after the final body and consumer-driven
property specialization of returned method tables, starting with
`createNodeFactory`. Recompiling the upstream TypeScript source is already the
preferred experiment; merely raising the timeout repeats the measured
post-body tail without addressing it.

### Decision

Keep the upstream TypeScript source route as the migration substrate, but do
not replace the npm-compat package result with it and do not claim that
TypeScript compiles. Land consumer-driven specialization as a measurable,
default-off #1046 slice: it removes 51 irrelevant files and more than halves
peak memory, but the remaining returned-method table and finalization work
still prevent a binary. Raising the timeout or heap alone does not close the
gap; both the 4 GiB / 30-minute full-source run and the 31-file dynamic run
prove that.

## Codex implementation handoff (2026-08-28)

Branch: `codex/1058-typescript5-selfhost`.

The pinned TypeScript 5.9.3 parser graph now compiles to a valid WasmGC module.
The latest authoritative run produced an 81,241,283-byte binary in 298,177 ms
(3,638.8 MiB peak RSS); compilation succeeded and `WebAssembly.validate`
returned true. This closes the former no-binary/finalization frontier, but Tier
3 is not complete because runtime AST fingerprints do not yet return.

```bash
JS2WASM_TYPESCRIPT_PROBE_DIAGNOSTIC=1 \
JS2WASM_TYPESCRIPT_PROBE_SOURCE_MAP=1 \
pnpm run dogfood:typescript-parser-source
```

Diagnostic artifacts are written to
`/private/tmp/ts2wasm-typescript-parser-latest.wasm` and the adjacent `.map`.

### Completed in this branch

- Pins/prepares the exact upstream source and adds a three-file AST fingerprint
  harness; consumer-driven barrel pruning and post-body DAG finalizers now
  complete within the five-minute worker budget.
- Repairs recursive layouts, mapped readonly erasure, constructor/factory
  identity, late fixups, nested captures, module initialization, enum aliases,
  and the large instruction graphs reached by the parser build.
- Preserves omitted optional numeric arguments as `undefined` at callable
  property boundaries (`scanner.setText(sourceText)` previously received zero
  and produced an empty AST).
- Widens mixed-`undefined` nested returns so `getDirectiveFromComment` no longer
  boxes the undefined f64 sentinel as a Number.
- Pre-registers safe zero-argument boolean/GC-reference callbacks and bridges
  erased generic results, clearing `scanner.speculationHelper<T>` and
  `parser.parseListElement<T>` without admitting unsafe argument-bearing ABIs.

The latest focused checkpoint passed 14/14 optional-padding, generic-callback,
and scalar-callable safety tests. `pnpm run typecheck` also passed.

### Remaining Tier-3 blocker

All three required inputs now converge on one runtime frontier:

```text
RuntimeError: dereferencing a null pointer
  at createIdentifier
  at parseIdentifier
  at parsePrimaryExpression
source: src/compiler/parser.ts:2649:9
wasm offset: 2106116 (source-map anchor 2098406)
```

`builderStatePublic.ts`, `corePublic.ts`, and `performanceCore.ts` therefore do
not yet return their expected fingerprints. Resume by extracting
`createIdentifier` (function index 927 in the latest diagnostic module) and
tracing the null receiver/argument at parser line 2649. Do not revisit the
resolved empty-AST, comment-directive, or generic callback paths unless their
focused regressions fail. After this frontier, rerun the three fingerprints,
then the strict 11-callback upstream suite and final TS5/TS7 typechecks/oracle
ratchet.

### PR refresh against current main (2026-08-29)

PR #5183 was refreshed onto `main` through
`81e54a98ebf95285e22bd2a82ff339cfd06a3fc8`. The merge keeps the parser
branch's nested-capture offset for spread calls while honoring main's newer
`arguments`-based spread path, uses the prepared multi-source module-init
finalizer, profiles both return- and parameter-unboxing statistics, and
combines inherited-array carriers with builtin-shadow protection. The latter
also guards recursive base-type discovery so a user-defined `Array` cannot be
reclassified as the intrinsic.

After the refresh, both TS5 and TS7 typechecks pass, repository lint reports no
errors, all 45 issue-1058 test files pass (151 tests), and the merge-sensitive
main regressions pass (8 files, 94 tests). The runtime `createIdentifier` null
deref above remains the only known Tier-3 fingerprint blocker; this refresh
does not claim it is resolved.

## Runtime parser handoff (2026-08-30)

Branch: `codex/1058-typescript5-runtime`, synchronized to `origin/main` at
`275216c74c7299ea07a72c8d5479f7e1a477000c`.

The canonical consumer-driven TypeScript 5.9.3 scanner/parser graph **compiles
and validates** after the sync. The authoritative diagnostic run on this tree
finished in 467,608 ms worker time / 468,686 ms wall time and produced an
**84,817,448-byte** Wasm module from 30 input/source files, 34 program files,
and 4,284 functions. Peak RSS was **3,848.6 MiB**, below the 4 GiB gate, and the
result contained 16 non-fatal IR/projection warnings. `compileSuccess` and
`WebAssembly.validate` are both true.

Runtime parser equivalence remains open. The same fresh build invoked all three
canonical inputs; none returned its required fingerprint:

- `builderStatePublic.ts = 13386537220945`
- `corePublic.ts = 40098163538143`
- `performanceCore.ts = 49645738923599`

`builderStatePublic.ts` and `performanceCore.ts` both reach semicolon recovery
with a missing Identifier whose `escapedText` is `undefined`, then fail in
`unescapeLeadingUnderscores` / `utilitiesPublic.ts:851`. `corePublic.ts` reaches
an `illegal cast` in `__call_fn_method_2` from
`parseBinaryExpressionRest`. The diagnostic Wasm and source map were preserved
at `/private/tmp/ts2wasm-typescript-parser-latest.wasm{,.map}` for the next
investigation; they match this exact source tree and must not be confused with
the earlier 83.6 MB artifact used for the size audit.

### Compiler fixes in this follow-up

- Generic calls returning callable values (TypeScript's `memoize` family) keep
  a callable closure carrier instead of freezing to the first apparent result.
- Fresh generic node factories use the exact checker declaration and explicit
  result type argument, recover a concrete binding destination during prepared
  program replay, and remain on the legacy materializing frontend when the IR
  overlay cannot preserve that proof.
- `Node -> Declaration -> StringLiteral/NumericLiteral/BinaryExpression` now
  materializes fresh structural extensions rather than performing a nominal
  guard-cast that can only yield null.
- Missing non-null reference fields are widened to nullable carriers across the
  highest owning nominal ancestor and its complete descendant subtree. This
  keeps mutable WasmGC prefixes exact for TypeScript's
  `IterationStatement -> Do/While/For*Statement` hierarchy.
- Interface layout stability now treats its set as an active recursion stack.
  Legal diamonds may revisit an already-completed `Node` branch, while genuine
  active cycles remain rejected. This preserves `StringLiteral`'s nominal
  `LiteralExpression` identity across `parseLiteralLikeNode`.
- Focused coverage includes cross-module memoizers, cached-getter freshness
  rejection, prepared multi-module factories, concrete nullable `Symbol`
  fields, sibling loop layouts, and the exact four-module literal/parser
  diamond that previously trapped.
- Callable-property invocation now bridges erased generic reference ABIs in
  both directions. In particular, a generic `(externref) -> externref`
  identity stored as `Rules.apply(Box): Box` no longer freezes or miscasts its
  argument/result carrier. The focused regressions in
  `issue-1058-generic-identity-return.test.ts` and
  `issue-1058-generic-base-node-factory.test.ts` compile, validate, and return
  their expected values.
- Callback ownership and registration now span the whole prepared source
  graph. Later-source named callbacks are discovered before an earlier generic
  dispatcher is compiled, while an inline arrow passed to a method declared by
  a compiled interface stays on the Wasm-closure path instead of being wrapped
  as a host callback. This is the exact TypeScript parser shape
  `scanner.tryScan(() => scanner.reScanInvalidIdentifier() === Identifier)`;
  before the fix `speculationHelper<T>` cast the host wrapper to a null Wasm
  closure root. All five focused cases in
  `issue-1058-multifile-generic-callback-registration.test.ts` now pass,
  including the inline-arrow case returning `42` and the later-source
  boolean/node/enum callback case returning `14243`.
- Cross-source callback discovery is cached graph-wide. Registration still
  runs per source so a later exact ABI can replace a conservative entry, but
  the compiler no longer walks the roughly 10 MB TypeScript graph once for
  every source.
- Body-proven generic identity helpers can recover the concrete input carrier
  after an erased `externref -> externref` call. The proof fails closed: every
  outer value return must name the same generic parameter symbol and the
  binding may not be assigned, updated, rebound, or used as a loop write
  target. Property writes remain valid for TypeScript's `finishNode<T>`.
  Negative regressions cover returning a fresh asserted value and rebinding
  the parameter before return.

Current-main validation is green for all **53** `tests/issue-1058-*.test.ts`
files (**183/183 tests**), including all **6/6** multi-file callback cases and
the new generic-identity safety controls. TS5 and TS7 typechecks, repository
lint/format, the IR fallback ratchet, the oracle ratchet, and
`git diff --check` pass. The strict upstream callback suite is intentionally
not claimed: its prerequisite parser fingerprints still fail as documented
above.

### Artifact size note

The roughly **84 MB** output is not an intrinsic cost of TypeScript's parser;
it exposes a js2wasm code-generation pathology. A measured 83,585,611-byte
diagnostic artifact has an **81,488,148-byte code section (97.49%)** and no
embedded source/data payload. Of that code, 1,176 generated `__closure_*`
bodies occupy 76,499,060 bytes. TypeScript's 88 KB `visitorPublic.ts` accounts
for **75,571,430 bytes** of closure code because its visitor callback cohort is
emitted during discovery and then twice during the final two-pass compile. The
two final cohorts include an exact byte-for-byte duplicated
**36,791,280-byte** block.

This is why comparison with an approximately 100 KB QuickJS parser is only
partly apples-to-apples: this gate links about 6.82 MB across 28 TypeScript
frontend modules, factories, utilities, diagnostics, and initialization, and
emits raw unoptimized WasmGC. Even so, the current size is not acceptable as a
normal parser baseline. Binaryen's `--remove-unused-module-elements` alone
reduces the measured artifact from 83,585,611 to **41,141,284 bytes**, proving
that almost half is removable duplicate/dead module code rather than required
runtime behavior.

Size follow-up priorities, in order, are:

1. Make callback discovery transactional/analyze-only, or prune the functions
   it emits, so the final pass does not retain the discovery cohort.
2. Reuse the final two-pass closure bodies instead of minting a second identical
   function for the same AST node and capture ABI.
3. Replace per-call expansion over roughly 1,034 closure candidates with shared
   or ABI-narrowed dispatch helpers.
4. Reduce exports and run unused-module elimination/optimization before
   delivery; pool the 12,057 imported string globals separately.

### Exact remaining work

1. Reduce the remaining `builderStatePublic.ts` / `performanceCore.ts`
   `undefined.length` failure through `unescapeLeadingUnderscores` and
   `parseErrorForMissingSemicolonAfter` (`utilitiesPublic.ts:851:5`). The
   optional-argument closure metadata now survives captured and constructible
   subtypes, so this later parser-list carrier miss needs a focused trace rather
   than another broad arity exception.
2. Reduce the independent `corePublic.ts` two-argument method cast in
   `parseBinaryExpressionRest` / `__call_fn_method_2`.
3. Make all three invocations return the expected fingerprints above, then run
   the strict 3-file / 11-callback upstream suite.

This is a real-package compile/validation milestone, not a claim that the
three AST fingerprints or the whole TypeScript unit suite pass yet.

## Runtime carrier follow-up handoff (2026-08-31)

Branch: `codex/1058-typescript5-runtime-followup`, synchronized to the actual
`loopdive/js2` `main` at
`b1085049ed2ed722c33480528b2741369ed73822`. This supersedes the earlier
handoff's `origin/main` wording; that remote points at the legacy
`loopdive/js2wasm` repository.

The final post-sync diagnostic run compiled and validated the canonical
TypeScript 5.9.3 parser graph. It produced an **84,901,009-byte** Wasm module in
363,428 ms worker time / 364,469 ms wall time from 30 source files, 34 Program
files, and 4,284 functions. Peak RSS was **4,027.9 MiB**, below the 4 GiB
worker cap, and the result retained 16 non-fatal IR/projection warnings.
`compileSuccess` and `WebAssembly.validate` are both true. The diagnostic Wasm
and source map are at
`/private/tmp/ts2wasm-typescript-parser-latest.wasm{,.map}`.

### Compiler fixes in this follow-up

- Fail-closed semantic recognition of generic callback-result helpers now
  preserves `<T>(callback: () => T): T` across nested/lifted declarations,
  runtime namespaces, forwarded scanner methods, and constraint-backed
  `current as T` parser fallbacks. `parseListElement` no longer freezes its
  result ABI to the first `Statement` instantiation and nulls a later sibling
  `VariableDeclaration`.
- Closure metadata records the minimum accepted source arity. Dynamic callback
  dispatch pads only proven omitted `externref` suffixes with the canonical
  JavaScript `undefined`, and captured/constructible closure subtypes preserve
  that metadata. Callable-property dispatch likewise accepts safe shorter
  runtime arities without widening scalar suffixes.
- Fresh generic Node/token factories preserve their declared source carrier,
  project concrete sibling results at the call site, and allow only proven
  fresh, non-escaping structural extensions. Arbitrary constructors,
  conditional fallthrough, nested mutator captures, and returned-factory
  escapes all fail closed in focused negative tests.
- Nested FunctionDeclaration result lowering, first-void runtime-namespace
  registration, lossless asserted reference-field export, and immutable
  hoisted-function rematerialization were repaired. Reassignment discovery now
  includes destructuring, updates, and loop assignment targets so a live
  replacement is not overwritten by a later rematerialization.

The former `createIdentifier`/factory failure and the later
`parseVariableDeclarationList` null dereference are both cleared. Runtime
fingerprint equivalence is still open:

- `builderStatePublic.ts` and `performanceCore.ts` stop with
  `TypeError: Cannot read properties of undefined (reading 'length')` through
  `unescapeLeadingUnderscores`, `parseErrorForMissingSemicolonAfter`, and
  `parseListElement` (source-map location `utilitiesPublic.ts:851:5`, Wasm
  offset 1,764,823).
- `corePublic.ts` advances through `parseVariableDeclarationList`, then reaches
  the known `illegal cast` in `__call_fn_method_2` from
  `parseBinaryExpressionRest` (Wasm offset 83,123,160; the retained source-map
  fallback anchor is `parser.ts:10709:1`).

All **56** `tests/issue-1058-*.test.ts` files pass (**285/285 tests**). The four
merge-sensitive dynamic-dispatch suites add **65/65** passing tests. TS5 and
TS7 typechecks pass. This remains a compile/validation and runtime-frontier
advance, not a claim that the three AST fingerprints or TypeScript's upstream
unit tests pass.

## Current-main parser and size handoff (2026-08-31)

The follow-up branch is now merged forward to `loopdive/js2` `main` at
`f08c7c62ce96ce4cbfe8ec89dc7ec2e9a5d10dba` (merge commit
`b8f25effd2826109075f5dba053b60b6841f68df`). The final post-merge canonical
source probe still compiles TypeScript 5.9.3 successfully and emits valid Wasm.
The latest run took 372,529 ms in the worker / 373,428 ms wall time, retained
4,283 source functions after body compilation, and produced an
**85,102,452-byte** module. Peak RSS was **4,379.1 MiB**: the worker completed
within its configured 4,096 MiB V8 heap limit, but process RSS exceeded the 4
GiB target and must not be reported as a memory-gate pass. Its SHA-256 is
`fb1fbb02d76f1e2a514325154bfffec6f45d2b0c936cde1105d3e97ed33b73b0`;
the artifact and source map are
`/private/tmp/ts2wasm-typescript-parser-latest.wasm{,.map}`.

The size is generated-code amplification, not 9 MB of source being copied into
the module. In the measured 84.9 MB predecessor (the same retained source
graph and code-generation regime), the code section was 82,807,923 bytes
(97.53% of the whole module). `visitorPublic.ts` alone accounted for 589
functions and 76,811,865 function-body bytes (90.47% of the module), while
`parser.ts` accounted for 9,579 functions but only 3,667,500 bytes (4.32%).
Exact duplicate function bodies represented 37,099,453 bytes (44.81% of all
body bytes); gzip reduced the raw module to 14,153,303 bytes. This is why an
approximately 100 KB hand-written QuickJS parser is not comparable to this raw
artifact: js2 currently specializes TypeScript's large visitor callback table
into hundreds of 0.5--0.87 MB closures and retains duplicate discovery/final
cohorts. The result has not received whole-module unused-function elimination,
identical-code folding, or ordinary Wasm optimization. Removing unused module
elements alone previously reduced the artifact to about 41.1 MB, so the first
size fix belongs in reachability/deduplication rather than parser semantics.

This round added focused fixes for four concrete compiler gaps:

- TypeScript's merged brand-only `TypeNode` interface now aliases its exact
  physical `Node` parent under the source-authored zero-runtime brand contract.
  Token identity and post-store mutations remain observable; spoofed or
  value-read brands fail closed and retain a real field.
- Generic factory/callback detectors avoid whole-program binding scans before
  resolving a declaration and treat non-mutating unary property reads as reads,
  not writes.
- Nullable vec-to-vec/tuple projections preserve `undefined` before reading the
  source length. This clears the `createInterfaceDeclaration` heritage-clause
  null dereference while retaining populated element projection.
- Minimum callback arity is persistent across replacement of a shared
  `ClosureInfo` record. Optional declarations discovered before their source
  function handle exists now remain in a small pending set; later calls revisit
  only that set and register the exact capture/TDZ-stripped physical ABI.
  Parameter-expanded linear `Uint8Array` ABIs retain both pointer and length
  slots. This clears the former `parseIdentifierName` candidate miss.

The three runtime fingerprints do **not** pass yet:

- `builderStatePublic.ts` and `performanceCore.ts` clear the former
  `parseModuleExportName` / `parseIdentifierName` miss. They now advance through
  `parseImportSpecifier` and stop in `parseImportOrExportSpecifier` with a
  terminal TypeError at `parser.ts:8614:13`. This later carrier/callable miss
  needs its own focused trace; it is not evidence that the earlier callback
  registration fix failed.
- `corePublic.ts` cleared the former illegal cast and nullable heritage-array
  dereference. It now finishes parsing and fails in `clearState`; the reported
  `parser.ts:1784:32` location is one call early. Runtime instrumentation proves
  `scanner.setOnError(undefined)` succeeds. The actual miss is the following
  `scanner.setScriptKind(ScriptKind.Unknown)`: the live captured closure and its
  finalized `__call_fn_1` arm work, but the earlier call-site-local ladder was
  frozen before `createScanner` published that exact nominal trampoline type.
  The sound follow-up is a deferred/finalized callable-property dispatcher, not
  another eager signature guess or a `setOnError` special case.

The next focused follow-up now implements both diagnosed parser seams:

- Conditional expressions joining different nominal reference siblings no
  longer select the first arm's concrete layout and guarded-cast the other arm
  to null. Each arm first honors a lossless contextual reference carrier; with
  no contextual carrier, the result uses the nearest declared common struct
  ancestor (or `externref` when no such ancestor exists). The exact
  `StringLiteral | Identifier` shape behind
  `parseImportOrExportSpecifier` is covered, as is the contextual vec-union
  counterexample that would regress Redux reducers if joined at `__vec_base`.
- Eligible externref-backed callable properties now reserve one typed private
  dispatcher per declared ABI/result while lowering early call sites, then fill
  its body from the complete closure registry after all source bodies have been
  emitted. This admits `createScanner`'s later-published `setScriptKind(number)`
  trampoline without guessing another eager signature or shifting already
  baked module indices. The order-independent path is deliberately limited to
  zero-argument or all-scalar signatures: any admitted reference parameter can
  be indistinguishable from a source-rest closure prefix and still needs an
  argc/argv-aware carrier before it can be widened soundly.

At this checkpoint all **59** `tests/issue-1058-*.test.ts` files pass
(**301/301 tests**). The merge-sensitive #3996/#4294/#4470/#4486/#5166 and
TypeScript verdict controls add **117/117** passing tests. Both TS5 and TS7
typechecks pass, as do the focused formatter/linter, issue-ID, IR-fallback,
LOC/function-budget, and oracle-ratchet gates. The bounded pinned TypeScript
5.9.3 upstream adapter now passes **14/14** native and **14/14** Wasm callbacks
across four selected original files, including all three admitted
`comments.ts` scanner callbacks; **252** files / **1,747** registrations remain
explicitly deferred. These are focused and inventory-honest results, not a
claim that TypeScript's complete upstream unit suite passes. The post-fix
canonical three-fingerprint parser run remains the next required measurement.

## Parser-first carrier checkpoint and module plan (2026-08-31)

The latest pre-fix canonical artifact is **84,770,324 bytes** with **4,298
functions** (SHA-256
`7f2a39eea88146b5c5b595b0dd576d9bd217e574d7b138468fb2fe9dc6c2f464`). It
compiles, validates, and all three
workloads enter the compiled parser. The two remaining failures were reduced to
exact representation/order boundaries rather than parser algorithms:

- `builderStatePublic.ts` and `performanceCore.ts` reached NodeFactory with a
  generic `PunctuationToken` allocation carrier, while the generated
  `createPropertySignature` / `createMethodSignature` ABI demanded a distinct
  nominal `QuestionToken` alias leaf.
- `corePublic.ts` reached `cast(value, isLeftHandSideExpression)`, but the
  generic predicate's callable ladder was finalized before the later imported
  `Node -> boolean` predicate wrapper was visible.

Direct object type-reference aliases now reuse the referenced declaration's
exact carrier when their field ABI and source-level scalar brands match. The
referenced declaration remains the sole owner of shared field metadata, so
sibling specializations such as `Box<A>` and `Box<B>` cannot rewrite each
other's generic field carrier. Cross-source callback discovery now resolves
import aliases to their exported declarations, records exact source-declared
reference predicates, and admits their guarded `externref -> ref` argument
bridge only inside a callable type-predicate signature. Focused coverage passes
in both GC and standalone lanes; all **61** issue-1058 files pass (**306/306
tests**), the nine merge-sensitive/verdict controls pass **117/117**, the pinned
TypeScript slice passes **14/14** native and **14/14** Wasm callbacks, and TS7
typecheck passes.

The subsequent canonical run at `4f153cc9eb4bac` compiled and validated but did
not pass parser acceptance. It took 495,805 ms in the worker / 496,708 ms wall
time, retained 4,301 functions, and emitted a **91,625,084-byte** module. Peak
RSS was **4,310.3 MiB**, so it again completed within the configured 4,096 MiB
V8 heap while exceeding the 4 GiB process-RSS target. All three invocations
failed:

- `builderStatePublic.ts` and `performanceCore.ts` reached the exact registered
  `createPropertySignature` / `createMethodSignature` method arms but trapped
  while converting a parser-produced token. TypeScript's overload exposes a
  `PunctuationToken<T>`, whereas the implementation deliberately allocates its
  generic `Token<T>` parent. `PunctuationToken<T> extends Token<T> {}` had no
  physical members but was emitted as a distinct WasmGC child, making the
  original parent allocation fail the child-typed argument cast.
- `corePublic.ts` reached `createExpressionWithTypeArguments` and the exact
  `isLeftHandSideExpression` predicate target was present in `cast`. The value
  came from TypeScript's generic base-`Node` allocator, then crossed the
  `Expression -> UnaryExpression -> UpdateExpression ->
  LeftHandSideExpression` checker-only brand chain. Those documented zero-cost
  brands had nevertheless become physical fields and distinct nominal WasmGC
  children, so the original base allocation failed the predicate's `Node`
  carrier conversion.

A runtime-empty, single-base interface with stable physical layout now aliases
its parent's exact carrier. The rule requires one unmerged base, no physical
members, and exact ordered field/mutability/physical-brand equality. A merged
brand-only alias also records its carrier provenance so a later single-base
descendant can link through that alias to the real parent instead of remaining
a flat sibling. TypeScript's single-underscore syntax brands are erased only
under the source-authored "never actually given values / zero cost" contract,
only for interfaces descending from `Node`, and only when the complete selected
source graph contains no runtime read or write of that brand. Ordinary brands,
value-observed brands, member-bearing shapes, multiple-base interfaces, and
unstable layouts remain physical.

Production-shaped regressions now cover `NodeFactory.createToken`, the fourth
`createPropertySignature` `TypeNode` argument through a merged base, and the
generic base-`Node` allocation entering `cast(...,
isLeftHandSideExpression)`. They pass in the canonical GC lane (the token and
merged-`TypeNode` cases also pass standalone), while the sibling generic object
specialization and value-observed-brand controls remain green. All **62**
issue-1058 files pass (**309/309 tests**); the nine
merge-sensitive/verdict controls pass **117/117**, and TS7 typecheck passes.
Another canonical three-fingerprint run remains required before parser
acceptance can be claimed.

The immediate product boundary is a runnable **parser-only** artifact. Its
entry graph should link scanner, parser, syntax/node factories, and only their
required core/diagnostic initialization. Binder, checker, emitter, and language
services are not parser-milestone roots. Subsequent public entry graphs should
layer these capabilities explicitly:

1. scanner/parser and AST construction;
2. binder over an existing AST;
3. checker over parser+binder;
4. language/editor/incremental/server services as an opt-in graph.

Source-graph elimination must start from the selected entry API. Type-only
imports disappear, and a runtime module that is neither reachable nor
re-exported may be omitted only when its top-level evaluation is proven
effect-free. Side-effect imports, observable initializers, and module evaluation
order remain roots. Consumer-driven barrels should retain the named parser
bindings, not every export from `_namespaces/ts.js`.

A second DCE pass is required after lowering. Its roots are public exports,
module/start initialization, host-visible callbacks, and functions genuinely
reachable through `ref.func`, tables/elements, or dynamic registries.
Unreachable functions, globals, types, data, and table entries should be
removed, followed by identical-body folding. Current barriers are the broad
`ts` namespace barrel, eager module initialization, runtime namespace and
callable-dispatch registries, conservative `ref.func` rooting, and duplicate
discovery/final closure cohorts. The measured reduction from roughly 83.6 MB
to 41.1 MB using unused-module elimination already proves that a large fraction
of the parser artifact is removable generated code.

## Parser runtime identity follow-up (2026-08-31)

The next canonical parser-only run compiled and validated a **89,140,516-byte**
module with **4,300 functions**, but did not yet pass runtime acceptance. It
took 520,426 ms in the worker / 521,733 ms wall time and peaked at **4,529.9
MiB RSS**. The three real parser invocations advanced beyond the earlier token,
TypeNode, generic-callback, and vec-carrier failures, then exposed two exact
identity boundaries:

- `builderStatePublic.ts` reached `forEachChildInInterfaceDeclaration`, but an
  `InterfaceDeclaration` stored in `NodeArray<Node>` had been structurally
  projected to a physical `Node`. The later syntax-kind handler therefore
  could not cast it back to `InterfaceDeclaration`.
- `corePublic.ts` and `performanceCore.ts` reached
  `parenthesizeTypeArguments`. The factory method dispatcher converted the
  host Array facade through a fresh vec materializer instead of recovering the
  original NodeArray, dropping its identity-bound `pos` / `end` properties
  before `isNodeArray` observed it.

Flattened multiple-heritage interfaces now consider stable, unmerged
**transitive** declared ancestors and install only the largest exact
mutable-field-prefix edge. The production-shaped hierarchy now remains
`InterfaceDeclaration -> Declaration -> Node`, so a derived allocation keeps
its runtime identity through a base Node array. Method closure dispatch now
mirrors free-call dispatch by unwrapping live host facades before concrete
reference conversion. It also normalizes both omitted and explicitly supplied
JavaScript `undefined` to a nullable Wasm ref before casting.

The parser's earlier `forEach<T, U>` frontier is handled by a narrowly
source-certified bridge for direct, capture-free, single-parameter callbacks
whose physical formal is a **non-null** declared ref. Nullable generic callback
formals are deliberately excluded: JavaScript `undefined` is not Wasm null,
and admitting them would reintroduce an unconditional `ref.cast_null` trap.
Constrained type parameters are resolved to their base constraint only in
array-element position. This establishes the canonical `readonly T[]` /
`NodeArray<Node>` carrier needed here; it is not a claim that multiple distinct
derived-array instantiations of the same generic body are fully canonicalized.
That pre-existing order-dependent specialization case remains follow-up work.

Zero-cost syntax-brand erasure is now limited to the known TypeScript Node
brand allowlist declared in `src/compiler/types.ts` under TypeScript's own
zero-runtime-cost contract. Direct and constant-computed runtime observation
disables erasure. This keeps the parser optimization package-scoped instead of
treating similarly named fields in ordinary programs as phantom state.

All **62** issue-1058 files now pass (**313/313 tests**). The nine
merge-sensitive/verdict controls pass **117/117**, and both TS5 and TS7
typechecks pass. Parser acceptance is still intentionally unchecked here: the
branch must first merge the current `loopdive/js2` main and then rerun all three
canonical fingerprints on that final tree. Checker, emitter, and language
services remain outside this parser-first gate.

## Synced parser-first canonical checkpoint (2026-08-31)

The follow-up branch was rebuilt directly on `loopdive/js2` main
`3193ca16685de143af1ae1d6066978b2590c687d`. The canonical consumer-driven
parser graph still contains only **30 input/source files** (**34** total program
files) and **310** module-initialization statements; checker, emitter, and
language-service entry points remain outside this gate.

The first synced run compiled and validated a **69,179,695-byte** module in
345,273 ms wall time and peaked at **3,684.7 MiB RSS**. All three invocations
reached NodeFactory, then converged on one producer defect: a valid
StringLiteral allocated through TypeScript's generic base-node factory was
tested against a separately materialized `LiteralLikeNode` WasmGC carrier and
became null. A TypeScript-only, unmerged `LiteralLikeNode -> Node` carrier alias
now follows the package's documented zero-runtime-cost syntax contract. A
production-shaped regression reproduces the original `parseLiteralLikeNode`
null dereference before the fix and returns the expected value afterward.

The post-fix canonical run again compiled and validated. It emitted a
**69,178,167-byte** module (SHA-256
`32f0ab847dc6c0a2760345cc3285f399e14c204812469d59689586444ba8d0bb`) with
**4,413** source functions after body generation and **16** non-fatal IR
fallback warnings. It took 326,946 ms in the worker / 328,038 ms wall time,
used 360,403 ms CPU (1.10 average cores), and peaked at **3,915.7 MiB RSS**,
inside the 4 GiB process-RSS gate. The literal/import failure is gone, but the
three fingerprints are not yet accepted:

- `builderStatePublic.ts` and `corePublic.ts` now expose the next exact syntax
  seam. Concrete property/index-signature nodes already use the shared Node
  carrier, while `parseTypeMember(): TypeElement` returned through a distinct
  physical `TypeElement` carrier and converted those valid members to null.
  The same tightly gated TypeScript allocation-view rule now covers the
  unmerged `TypeElement` interface. A focused regression exercises both
  PropertySignature and IndexSignatureDeclaration values through the
  TypeElement return/array boundary.
- `performanceCore.ts` reaches its first heritage clause, `Performance extends
  PerformanceTime`. `tryParseTypeArguments()` correctly takes the `undefined`
  source branch, but the externref-to-nullable-NodeArray coercion tests only
  Wasm null. Host JavaScript `undefined` is a non-null externref, so it falls
  through `__array_from_iter(undefined)` and fabricates a truthy empty vec with
  no NodeArray `pos` / `end` metadata. The later `isNodeArray` cast correctly
  rejects it. Exhaustive WAT inspection proves every cache writer and the
  executable funcref target the exact `isNodeArray` trampoline; the misleading
  `'map'` text is only stale reflective function-name metadata. Nullable
  externref-to-vec materialization must preserve both null and undefined instead
  of synthesizing an empty collection.

After the two syntax-view repairs, the focused carrier set passes **58/58**.
Before the TypeElement follow-up, the complete issue-1058 suite passed all
**62** files (**315/315 tests**), both TS5 and TS7 typechecks passed, and
Prettier plus `git diff --check` were clean. Parser acceptance remains
intentionally unchecked until the cached-function identity defect is fixed and
all three canonical fingerprints match in one final synced run. This is still
not a claim that TypeScript's complete upstream unit suite passes.

## Final parser-first handoff checkpoint (2026-08-31)

The final synced branch still **compiles and validates the complete selected
parser graph**. The canonical run retained the same 30 input/source files, 34
program files, and 310 module-initialization statements. It emitted a
**69,198,117-byte** Wasm module with **4,403** functions after body generation
and 16 non-fatal IR-fallback warnings. Compilation took 386,124 ms in the
worker / 387,478 ms wall time. Peak process RSS was **4,479.9 MiB** with a
4,096 MiB V8 heap limit, so the module completed but did not meet the stricter
4 GiB process-RSS target. The exact runnable artifact and source map are
preserved at `/private/tmp/ts2wasm-typescript-parser-latest.wasm` and
`/private/tmp/ts2wasm-typescript-parser-latest.wasm.map`.

Two production-shaped carrier defects were closed before this run:

- vec-to-vec element projection now preserves host-backed expando/MOP state on
  the new physical vec. The focused NodeArray regression covers direct
  `DerivedNode[] -> Node[]` widening and the `forEachChild` optional `cbNodes`
  callback path, retaining `pos`, `end`, `hasTrailingComma`, and indexed
  elements;
- TypeScript's `PropertyAccessChain` now follows its exact
  `PropertyAccessExpression`/`Node` allocation carrier. The focused multi-file
  regression uses the real `src/compiler/types.ts` zero-cost-brand contract,
  multi-heritage base, repeated `name` declaration, full wrapper writes,
  contextual `NodeFactory`, and destructured parser alias. Renaming the view to
  an unrecognized control reproduces the null carrier; the exact TypeScript
  name passes.

The final runtime gate nevertheless remains open:

- `builderStatePublic.ts` still returns **13,385,293,184,043** instead of
  **13,386,537,220,945**;
- `corePublic.ts` still returns **40,101,707,600,196** instead of
  **40,098,163,538,143**;
- `performanceCore.ts` advanced beyond the earlier optional-property failure at
  parser line 6421, then trapped while parsing an arrow-function expression at
  parser line 5566 (`parseArrowFunctionExpressionBody`).

The unchanged first two values prove the focused vec projector is not the last
canonical metadata-loss path. The saved prebuilt-module replay driver at
`/private/tmp/run-prebuilt-typescript-parser.mjs` reconstructs the import
manifest and reruns a selector in roughly 14 seconds, so the next pass should
trace the identity of the `NodeArray<Node>` received by the fingerprint
visitor and locate the additional materialization/copy boundary before another
full rebuild. The performance follow-up should breakpoint the line-5566 ternary
and determine whether the selected context callback or its returned expression
is null. The earlier detailed trace is preserved at
`/private/tmp/ts-parser-trace-result-final-20260831.log`.

The complete focused #1058 suite passes **67 files / 330 tests**, including the
new PropertyAccessChain file at **4/4**, and TS5 typecheck passes. This
checkpoint is therefore a real compiling,
validating, partly runnable parser artifact, not parser semantic acceptance and
not a claim that TypeScript's upstream unit suite passes. Binder, checker,
emitter, language services, and post-link DCE remain the explicit later module
layers described above.

## Current-main publication checkpoint (2026-08-31)

The publication tree is now fast-forwarded to `loopdive/js2` main
`c281669805ea987c0c5c08e4681370d199b77a34`. Reapplying the parser work was
text-conflict-free, but the post-sync suite correctly exposed two semantic
composition gaps. Runtime-namespace destructuring now records each exact
`BindingElement` in the Program ABI and accepts a bare projected global only
when its allocator belongs to that binding; this restores namespace-local
NodeFactory callables without leaking writes to same-named outer or sibling
bindings. The synthetic IR-inline DAG context also supplies main's new
`moduleInitChunkHelperNames` field instead of weakening production validation.

After those repairs, the complete focused suite passes **67/67 files and
330/330 tests**. The nine merge-sensitive controls pass **117/117**, and both
TS5 and TS7 typechecks pass. Prettier and `git diff --check` are clean.

The canonical consumer-driven parser probe was rebuilt on this exact main tip.
It still selects **30 source files**, **34 program files**, and **310** module
initialization statements. Compilation succeeded, the emitted
**69,187,969-byte** Wasm module validates, and body generation retained
**4,439 functions** with 16 non-fatal IR warnings. The worker completed in
487,770 ms / 489,550 ms wall time, used 539,981 ms CPU (1.10 average cores),
and peaked at **3,685.6 MiB RSS**, now inside the stricter 4 GiB process target.
The refreshed artifact and source map remain at
`/private/tmp/ts2wasm-typescript-parser-latest.wasm` and
`/private/tmp/ts2wasm-typescript-parser-latest.wasm.map`.

The semantic frontier is unchanged, rather than regressed by the sync:
`builderStatePublic.ts` returns **13,385,293,184,043** instead of
**13,386,537,220,945**; `corePublic.ts` returns **40,101,707,600,196** instead
of **40,098,163,538,143**; and `performanceCore.ts` reaches the same mapped
`parser.ts:5566` null dereference in `parseArrowFunctionExpressionBody`. This
proves the parser module compile/validate gate on current main, but it is still
not parser semantic acceptance and not a claim that TypeScript's complete
upstream unit suite passes.

## Runnable parser publication checkpoint (2026-08-31)

The final publication candidate remains based directly on `loopdive/js2` main
`c281669805ea987c0c5c08e4681370d199b77a34`. Two additional runtime boundaries
were closed after the checkpoint above:

- TypeScript's generic parser context helpers may bind `callback()` to a stable
  `const` inside a nested lexical block. Certifying that binding by its
  enclosing function, rather than requiring it to be a direct function-body
  statement, preserves the callback's result carrier across calls. In
  particular, `doInAwaitContext` / `doOutsideOfAwaitContext` may first return a
  `NodeArray<ModifierLike>` and later return an `Expression` without freezing
  the helper to the first array carrier. The former null dereference at
  `parser.ts:5566` is gone.
- A host-facing Array mirror now resolves back to its authoritative Wasm vec
  before ordinary-property sidecars are copied. Both the reserved
  `__vec_from_extern` materializer and the direct `externref -> vec` coercion
  copy that state to the fresh typed vec. TypeScript's `NodeArray` `pos`, `end`,
  `hasTrailingComma`, descriptor, prototype, and extensibility state therefore
  survive the `createSourceFile -> forEachChildInSourceFile -> visitArray`
  round trip.

The canonical three-case consumer-driven probe compiled and validated a
**69,196,938-byte** Wasm module (SHA-256
`adc32174d19dfa6f2dd98b1cea9d50d6c761175592792d82d705b56e5f03c27e`). It
retained **30 input/source files**, **34 program files**, **310** module
initialization statements, and **4,439 functions** after body generation. The
16 diagnostics are the same non-fatal IR fallback warnings; there are no
compile or validation errors. The worker completed in 367,871 ms / 369,064 ms
wall time, used 404,945 ms CPU (1.10 average cores), and peaked at **4,240.2 MiB
RSS** with a 4,096 MiB V8 heap limit. This completed reliably but remains 144.2
MiB above the stricter 4 GiB whole-process RSS target. The exact artifact and
its source map (SHA-256
`7e224bc5d9eb9efaaa437bcb1133ae83386042a5fd31dfe5e47a6c2a3b00d565`) are
preserved at `/private/tmp/ts2wasm-typescript-parser-latest.wasm` and
`/private/tmp/ts2wasm-typescript-parser-latest.wasm.map`.

All three workloads now execute the compiled parser without trapping. Two are
exactly native-equivalent under the canonical structural fingerprint:

- `builderStatePublic.ts`: **13,386,537,220,945** expected and actual;
- `corePublic.ts`: **40,098,163,538,143** expected and actual;
- `performanceCore.ts`: **49,594,442,228,282** actual versus
  **49,645,738,923,599** expected.

The remaining performance difference is bounded and reproducible rather than
an execution failure. Statement count is exact at 11; the compiled traversal
visits 283 nodes versus native's 295. Statement-prefix isolation accounts for
all 12 missing nodes as three four-node type-annotation subtrees: the top-level
`performance: Performance | undefined` declaration and two
`() => PerformanceHooks | undefined` return annotations. Each missing subtree
is `UnionType -> TypeReference -> Identifier` plus `UndefinedKeyword`; the
other top-level statements and all 18 minimized parser controls are exact.

The exact residual is a result-carrier projection, not deliberate annotation
elision or a traversal-table defect. `parseUnionOrIntersectionType` builds and
finishes the concrete `UnionTypeNode`, but its terminal `externref -> TypeNode`
`ref.test` rejects that allocation carrier and returns null. The parent
therefore never receives its `.type` subtree. The probe's CLI status is
non-zero only because this one semantic fingerprint is not yet accepted; its
worker exited normally with successful compilation and validation.

The publication tree passes all **67/67** focused #1058 files and **332/332
tests**. The production-adjacent NodeArray/context matrix passes **9/9 files and
139/139 tests**. TS5 and TS7 typechecks, Prettier, `git diff --check`, the LOC
and function budgets, and the checker-oracle ratchet all pass. The pinned
TypeScript 5.9.3 upstream adapter also passes **14/14** admitted original
callbacks natively and **14/14** in Wasm across four selected test files; 252
upstream files remain explicitly deferred.

This checkpoint establishes the requested first module boundary: the selected
TypeScript parser graph compiles, validates, and runs real parser workloads,
with two canonical files exact and one precisely localized union-result carrier
residual. It is not a claim that the entire TypeScript unit suite or parser
semantic surface is complete. Binder, checker, emitter, language services, and
post-link dead-code elimination remain the separately layered follow-up work
described above.

## Exact parser acceptance and binder handoff (2026-09-01)

The parser-only milestone is now accepted. A fresh build of the pinned
TypeScript 5.9.3 consumer-driven scanner/parser graph selected **30 source
files**, **34 program files**, and **310 module-initialization statements**. It
compiled successfully, validated, and emitted a **68,781,935-byte** WasmGC
module with **4,440 functions** after body generation and the same **16**
non-fatal IR fallback warnings. The worker completed in 366,821 ms / 368,018 ms
wall time, used 400,412 ms CPU (1.09 average cores), and peaked at **4,002.7 MiB
RSS** with a 4,096 MiB V8 heap limit. That peak is **93.3 MiB below the strict
4 GiB whole-process RSS target**. The artifact
SHA-256 is
`033de5a467fe492ba8bf531c9daa927c436ee1b43b0c7cc98467f72fd0c63f72`;
the adjacent 48,038-byte source map SHA-256 is
`52fbd62d169554bc5c8d2abbc51da37eb1b077aa52950e5669037d1df27c02d6`.

All three canonical real-source fingerprints are exactly native-equivalent:

| workload | native | Wasm | status |
| --- | ---: | ---: | --- |
| `builderStatePublic.ts` | 13,386,537,220,945 | 13,386,537,220,945 | exact |
| `corePublic.ts` | 40,098,163,538,143 | 40,098,163,538,143 | exact |
| `performanceCore.ts` | 49,645,738,923,599 | 49,645,738,923,599 | exact |

The final two defects were separate representation boundaries. TypeScript's
hosted `UnionTypeNode` and `IntersectionTypeNode` are explicit allocation views
of the exact merged `TypeNode`/`Node` carrier; standalone retains their concrete
physical `types` field. After that repair, the remaining hash difference was
one event: `VariableDeclarationList.flags` held `Ambient` instead of `Ambient |
Const`. Proven fresh generic factories now keep their physical source carrier
when the logical instantiation is opaque, and `finishNode<T>` compound writes
use the finalized typed-member dispatcher before its genuine-host-object
fallback. The exact full-layout flag repro now returns **33,554,434** as native
does. This establishes the selected parser module, not the complete upstream
TypeScript parser unit suite.

The publication tree passes all **69/69** focused #1058 test files and
**336/336 tests**. The nine merge-sensitive and TypeScript-verdict controls pass
**117/117**, and both TS5 and TS7 typechecks pass.

The next self-host slice is a separate binder entry over an already parsed
`SourceFile`. Root `createSourceFile` and `bindSourceFile` directly rather than
the broad `_namespaces/ts.js` barrel. The intended capability boundary excludes
checker semantics, emitter, services, and server code; the current graph still
retains a specialized checker shell solely for `getNodeId`/`getSymbolId`. The
first bounded native/Wasm binder smoke oracle is:

```text
symbolCount * 65,536 + locals.size * 256 + bindDiagnostics.length
```

This packed count is intentionally only a first smoke oracle: different binder
states can collide on the same number, so it is not a semantic fingerprint.
The tracked binder workload now pins two committed controls whose exact fixture
bytes are authoritative:

| committed fixture | native binder smoke oracle |
| --- | ---: |
| `tests/dogfood/fixtures/typescript-binder/const-local.ts` | 65,792 |
| `tests/dogfood/fixtures/typescript-binder/duplicate-let.ts` | 131,330 |

A third value, **459,008**, was previously measured for an exported-class case
with a nested declaration, but the exact source text was not recorded. It is
not an acceptance control: first commit the literal fixture, then remeasure and
record its native result. Acceptance requires compile+validate, unchanged
pre-bind parser fingerprints, and exact native/Wasm results for every committed
binder smoke fixture. The oracle must then grow a deterministic sorted
name-and-flags sequence (or its stable hash) for locals and exports so distinct
binder states cannot pass solely by colliding on the packed count.

`binder.ts` is the smallest next capability slice at approximately 199 KB /
4,008 lines. The tracked workload resolves cleanly to **32 source files / 36
program files**, **6,974,097 selected input source bytes**, and **312
module-initialization statements**. Native TypeScript 5.9.3 recomputes the two
table values exactly from the committed fixtures.

The first full 900-second-budget compile attempt did not time out: it completed
body generation for **4,827 functions** and all late codegen passes in 625,740
ms / 626,423 ms wall, used 692,469 ms CPU (1.11 average cores), and peaked at
**3,970.7 MiB RSS**, 125.3 MiB below the strict 4 GiB process target. It emitted
no binary (`compileSuccess: false`), so no validation or binder invocation is
claimed. The result contained 25 diagnostics; its original bounded report put
20 IR warnings first and hid the decisive tail diagnostics. The probe now
prioritizes non-warning failures, with a focused fail-closed regression.

After that reporting fix, a fresh diagnostic-prioritized rerun again completed
all codegen phases without timing out: **4,827 functions**, 615,304 ms worker /
616,254 ms wall, 656,412 ms CPU (1.07 average cores), and **3,778.9 MiB peak
RSS**, 317.1 MiB below 4 GiB. It still emitted no binary, so validation and
invocation did not run. The 25 diagnostics were **four instances of the same
hard error and 21 warnings**. Each hard error is the #2090 fail-closed
stack-balance diagnostic in `createBinder`: operand-stack underflow by 3 in an
empty-typed block (body delta -3, expected 0). The active binder blocker is
localizing and repairing the missing value producer; the repeated signature is
not yet evidence of four independent defects.

An instrumented localization rerun completed in 634,968 ms worker / 635,901 ms
wall, used 676,862 ms CPU (1.06 average cores), and peaked at **3,703.4 MiB
RSS**, 392.6 MiB below 4 GiB. It confirmed four distinct physical bodies, at
`function body[190].if.then`, `function body[231].if.then[5].if.then`,
`function body[293].if.then[14].if.then`, and
`function body[293].if.then[60].if.then[5].if.then`. Every body constructs the
same memoized nested-function closure and has the same first negative net
prefix: 37 live operands immediately before a 40-field `struct.new`, followed
by the memo-local `local.set`. The deficit is therefore exactly three closure
constructor operands, not a stack-diagnostic accounting artifact.

A producer-provenance rerun completed in 630,303 ms worker / 631,263 ms wall,
used 703,130 ms CPU, and peaked at **3,897.4 MiB RSS**, 198.6 MiB below 4 GiB.
It identified all four sites as memoized reads of `bind`: the current plan has
33 value captures, no TDZ-flag fields, and one constructibility field (37
fields with the three-field closure header), while the cached type was already
40 fields wide at each emission site (36 captures plus the same header and
constructibility field). This rules out late type growth, DCE, and net-delta
accounting. A ten-line reproducer confirmed the general failure mode: Phase 0
publishes a wider capture ABI; compiling an earlier sibling promotes three
owner locals; the real reserved-entry compile recomputes a narrower plan while
the already-minted closure type and trampoline retain the provisional ABI. The
repair must therefore make the reserved Phase-0 capture plan canonical for the
function body, metadata, trampoline, and every constructor rather than padding
only the failing `struct.new`.

The capability graph is also not honestly checker-free yet. `binder.ts` and
`nodeFactory.ts` obtain `getNodeId` through the broad namespace, while private
name binding reaches `getSymbolId` through `utilities.ts`; both allocators and
their counters live in `checker.ts`. Consumer-driven specialization already
blanks more than 99% of that file's semantic content (only 13,444 non-whitespace
characters, 20/4,547 function-like nodes, and 2,114/261,341 AST nodes remain),
so its 3,094,493 blank-preserved raw bytes are not the present codegen bottleneck.
Move both ID allocators to a small shared identity module and direct-import it
to make the parser/binder/checker module boundary truthful, not as a claimed
performance fix. A local extraction would forfeit the unmodified-upstream-source
claim, so treat it as an explicit module-hygiene follow-up (or upstream it), not
as the current stack-balance or performance repair.

### Binder compile, validation, and runtime-namespace frontier (2026-09-01)

This supersedes the earlier stack-balance frontier above. On snapshot
`0280bc394964f1`, the canonical TypeScript 5.9.3 binder workload selected **32
input/source files**, **36 Program files**, and **312 module-initialization
statements**. It completed body generation for **4,828 functions**, compiled
successfully, and emitted a **76,915,977-byte** module that
`WebAssembly.validate` accepted. The worker used 718,317 ms CPU (1.12 average
cores) and peaked at **3,850.2 MiB RSS**, 245.8 MiB below the strict 4 GiB
process target. The result had **21 non-fatal warnings and no hard compile
errors**.

Both committed binder controls instantiated and reached execution, but first
stopped at the same runtime boundary: `visitorPublic.ts:374:5` called the
overloaded `Debug.assertEachNode` through a null namespace receiver. TypeScript
nominates the first bodyless overload as that property's `valueDeclaration`,
so the static namespace-call path had declined to the extern-method bridge.
Commit `b0f313de1f8af204ace11750c3bda9012180b26c` selects the unique body-bearing
declaration and retains the exact Program ABI identity check. Its circular
export-star regression executes the call and emits no
`__extern_method_call_*` import.

A fresh post-fix run again compiled and validated successfully. It completed in
656,354 ms worker / 657,223 ms wall, used 718,349 ms CPU (1.09 average cores),
peaked at **3,494.3 MiB RSS**, and emitted a **76,914,855-byte** module with
**4,828 functions**, **21 non-fatal warnings**, and no hard compile errors. Both
fixtures then entered `Debug.assertEachNode` and reached the next shared
boundary inside `shouldAssertFunction`: the computed self-read `Debug[name]` at
`debug.ts:189:56` still treated the mixed runtime namespace as its legacy null
placeholder. The probe correctly rejected both invocations and did not publish
`/private/tmp/ts2wasm-typescript-binder-latest.wasm{,.map}`.

The focused repair materializes one symbol-keyed namespace function projection
only when the checker proves that every possible computed-write key is a finite
string-literal set of unique executable exports. It selects overload
implementations by their body-bearing declarations, re-resolves exact Program
ABI handles after late-import shifts, and never serves the partial projection
for a bare/escaping namespace value or a non-admitted member. The exact
`Debug[AssertionKeys]` circular-barrel regression now compiles, validates, and
executes.

The first full rerun after that lowering change remained byte-identical to the
previous module and stopped at the same `Debug[name]` boundary. The projection
had not been admitted because consumer-driven specialization retained the
exported runtime variable `Debug.loggingHost` but blanked its annotation owner,
`LoggingHost`. The checker consequently treated the member as `any`, collapsed
`MatchingKeys<typeof Debug, AnyFunction>` to `any`, and could no longer prove a
finite key set. Commit `2fb2e6281be880a15d07ee8d669e0933933732ee`
adds a checker-only type closure rooted narrowly at retained exported namespace
variable annotations. It keeps the transitive `HostAlias` / `LoggingHost` /
`LogRecord` chain without turning type-only declarations or exported function
signatures into runtime roots. All four real `Debug` index sites then resolve to
the same 51-member string-literal union, while the selected graph remains
exactly **32 source files / 36 Program files**.

The authoritative namespace post-fix run completed in 679,516 ms worker /
680,545 ms wall, used 725,668 ms CPU (1.07 average cores), and peaked at
**3,859.4 MiB RSS**, 236.6 MiB below the strict 4 GiB process target. It
compiled and validated a **77,236,087-byte** module with **4,862 functions**,
**21 non-fatal warnings**, and no hard compile errors. Relative to the
pre-admission module, the additional 321,232 bytes and 34 functions prove that
the bounded namespace projection reached the binary. Both committed fixtures
passed the former `Debug[name]` frontier and then stopped while invoking the
imported property-derived callback `getEmitScriptTarget(options)` at
`binder.ts:586:9` (Wasm offset 14,612,147, source-map anchor 14,612,053).

The callback itself was present, but its exported const snapshot had been
initialized to null. `_computedOptions.target.computeValue` is a Wasm closure
field on a generic object whose receiver is represented as externref. During
module initialization, the JS-host property bridge cannot inspect WasmGC fields
because instance wiring has not completed. Callable exact-shape reads now stay
on the Wasm carrier/member-dispatch path in the host lane. Cross-source const
aliases then invoke the stored snapshot through a finalize-filled driver rather
than a body-time signature ladder: this sees closures registered by later
source units, pads under-applied calls to the implementation arity while
preserving the true argument count, and falls back directly for genuine host
callables. Both host and standalone bridges now trap when the live closure
exceeds their eight-formal ABI cap, so contextual types, property replacement,
aliasing, or spreads cannot turn an unsupported closure into a silent undefined
result. Standalone keeps its existing structural property reads.

The focused multi-module regression now verifies the original computed-option
callback, snapshot identity after the source property is replaced, a preceding
truthy alias, positional argument order, under-application, the >8-formal
boundary, direct/escaped/hoisted/factory/spread replacements before snapshot,
and a host-free build with zero function imports (**8/8 passing**). A
narrow real-upstream TypeScript probe selected **17
source files / 21 Program files**, emitted and validated **2,465,088 bytes** in
7.6 seconds with an 819.4 MiB peak, and invoked the previously null alias with
the expected result **99**.

The next authoritative binder run completed in 638,618 ms worker / 639,467 ms
wall, used 720,370 ms CPU (1.13 average cores), and peaked at **4,089.9 MiB
RSS**. It compiled and validated a **77,013,373-byte** module with **4,863
functions**, the same **32 source files / 36 Program files / 312 module-init
statements**, **21 non-fatal warnings**, and no hard compile errors. Both binder
oracles passed `getEmitScriptTarget` and reached `bindSourceFileAsExternalModule`
before trapping with a null dereference at `binder.ts:3133:9` (Wasm offset
14,778,839; source-map anchor 14,778,791). Focused probes prove the allocator,
its `getSymbolConstructor()` result, the exact small-graph late-assigned
constructor, and the individual filename, symbol, declaration-array, and
export-table operations; the remaining investigation is whether the complete
closure registry changes that dynamic constructor ABI or whether another
operation inside the call is the first null. Until both exact binder oracles
match, the binder slice is not accepted and the failed invocation does not
publish the latest artifact.

### 2026-09-01 stop handoff — draft PR #5390

Work is published from `codex/1058-typescript-binder` in draft PR **#5390**.
The parser milestone remains accepted; this checkpoint fixes the next binder
runtime boundary but does **not** claim binder or full TypeScript completion.

Validated at handoff:

- `tests/issue-1058-barrel-computed-option-capture.test.ts`: **8/8 passing**
  across host and standalone, including snapshot identity, under-application,
  runtime arity overflow, and direct/escaped/hoisted/factory/spread mutation
  controls.
- `tests/standalone-shared-globalthis-import.test.ts`: **2/2 passing**, proving
  the arity guard preserves linked-realm callable delegation.
- `pnpm run typecheck:ts5` and `pnpm run typecheck`: passing.
- `pnpm run check:ir-fallbacks`, issue-ID validation, formatting, and diff
  checks: passing.
- A narrow real TypeScript callback graph compiles, validates, and returns 99;
  the latest full binder module compiles and validates before the runtime trap
  described above.

Non-authoritative broader checks still expose existing branch/environment
noise: the #1712 dynamic suite has its prior Acorn `parse is not a function`
failure, #4384 retains its prior native-array 0-versus-42 failure, and direct
#3592 execution requires Node's experimental Wasm exception-reference support.
None is on the focused #1058 path.

Resume at `binder.ts:3133:9` inside `bindAnonymousDeclaration`, using both
committed binder oracles. First distinguish the complete-graph dynamic
constructor ABI from the filename/symbol/declaration/export-table operations
already proven independently. Do not rerun the ten-minute authoritative binder
until a focused discriminator changes that boundary. After binder parity, move
to the checker TS2322 oracle, then printer/emitter, and only then self-hosting.

### 2026-09-05 current-main sync and resumed frontier

Branch `codex/1058-typescript-binder` is synchronized with loopdive/js2 main at
`0a5a3e87df074982cc3022a95899fc62ad69b036` by merge commit
`0c9f00a0f3fb4f`. The two content conflicts were resolved by composition, not
side selection: module namespace objects retain main's immutable-global and
Node-builtin re-export entries together with this branch's declaration-aware
callable-handle refresh, while nested declarations retain main's promoted and
forwarded pre-registration ABI together with this branch's canonical reserved
capture plan. The seven conflict-focused suites pass **34/34**.

Main advanced again during the resumed probe. Merge commit
`22c990ab481a0d` brings the branch through
`33a532e9344667`; that delta contains benchmark/edition artifacts and no
binder-path conflict. Its new edition import test passes and both compiler
typechecks remain green.

The sync exposed a TypeScript 5-only source typecheck regression inherited
from main: TS5's DOM declarations do not yet contain `WebAssembly.Tag`, while
TS7's do. Commit `45b7d783353d04` describes the feature-detected tag locally by
the only contract this runtime uses (constructible object identity). Both
`pnpm run typecheck:ts5` and `pnpm run typecheck:ts7` pass, and the linked
provider exception-identity suite passes **4/4**. `AGENTS.md` now uses
repository-relative memory links in commit `d3ff3a70028dd1`, so the documented
context resolves from every worktree rather than one retired checkout.

Current main also contains the focused discriminator for the prior
`binder.ts:3133:9` null-constructor hypothesis: a read-only GC-reference capture
whose declaring slot was boxed later is forwarded as its value instead of the
ref cell. The capture/constructor regression set passes **12/12**, including
both TypeScript late-constructor factories. This makes the mainline capture fix
a credible mover for the old runtime boundary, but it is not yet authoritative
proof for the full graph.

The first authoritative post-sync binder run used the same **32 source files /
36 Program files / 312 module-init statements** and remained actively in
codegen until the probe's 900,000 ms limit. It timed out after **900,044 ms**
wall / **647,781 ms CPU** (0.72 average cores), peaked at **1,882.5 MiB RSS**,
and last reported `src/compiler/parser.ts`; it produced no compile diagnostic,
no module, and therefore no binder invocation result. This is a measured
compile-time frontier, not evidence that the old runtime null survived. Resume
with a longer completion budget against this already-prepared pinned checkout,
then compare both exact binder oracle results. If construction succeeds but
each result is exactly 65,536 too high, inspect
`externalModuleIndicator`/`isExternalModule` before changing constructor
lowering.

The lower-load 30-minute rerun then completed in **680,967 ms** wall /
**766,863 ms CPU** (1.13 average cores), peaking at **3,784.5 MiB RSS**. It
compiled and validated a **75,812,899-byte** module with **4,864 functions**,
the same **32 source files / 36 Program files / 312 module-init statements**,
**21 non-fatal warnings**, and no hard compile errors. This is authoritative
evidence that main's read-only capture repair removed the old
`binder.ts:3133:9` constructor failure. Both binder inputs now enter the parser
and stop at the same earlier runtime operation: the destructured
`factoryCreateIdentifier(...)` call at `parser.ts:2657:31`.

That new frontier was reduced to the already-committed sub-second
`issue-1058-node-array-factory` regression and bisected to main commit
`c0213bad543aba2c74c8249bb314f49897f3a21a` (#5290's omitted-parameter ABI
repair). The public contextual signature widens an optional Boolean to
externref, while the lifted nested implementation intentionally retains its
branded i32 ABI and carries omission through `__argc`; the dynamic identifier
dispatcher consequently omitted the live funcref from its candidate set. The
candidate bridge now admits only a call-site-proven Boolean (including an
omitted or forwarded nested optional Boolean), uses the existing branded
`__unbox_boolean` helper for supplied values, and supplies i32 zero for an
omitted slot while preserving the real argument count. Unproven externref and
unbranded i32 candidates remain excluded. The affected #1058 factory,
contextual, forwarding, generic callback, and #5290 suites pass **116/116**;
both TS5 and TS7 typechecks pass. The next authoritative run must establish
whether both binder fingerprints now match or expose the next bounded runtime
frontier.

### 2026-09-05 standalone pivot and parser-wrapper frontier

The first authoritative run after the contextual optional-Boolean repair
completed in **992,561 ms wall / 1,065,682 ms CPU** (1.07 average cores),
peaked at **3,687.6 MiB RSS**, and compiled and validated a
**75,813,710-byte** module. The graph remained **32 source files / 36 Program
files / 312 module-init statements / 4,864 functions** with **21 non-fatal
warnings**. The two committed binder controls then exposed different later
parser call boundaries: `factoryCreateNumericLiteral(...)` at
`parser.ts:3768:50` and `factoryCreateVariableDeclaration(...)` at
`parser.ts:7659:22`.

Focused regressions identified two ABI gaps. A non-null union whose every
member is numeric is now sufficient call-site proof for unboxing a contextual
numeric enum such as `TokenFlags`; the ordinary static-JS-type oracle
deliberately reports all unions as mixed. Separately, a public omittable
reference parameter may select a nested implementation's exact nullable GC
reference ABI only when the actual argument is omitted, statically undefined,
or an identifier already backed by that exact physical local type. Asserted
host/plain-object values remain excluded. The focused and related #1058
callable suites pass **120/120**, and both compiler typechecks pass.

The next authoritative run completed in **786,825 ms wall / 857,649 ms CPU**
(1.09 average cores), peaked at **3,980 MiB RSS**, and compiled and validated a
**75,814,890-byte** module with the same graph shape and warning count. Both
old call boundaries are gone. Both binder inputs now converge on
`factoryCreateNodeArray(elements, hasTrailingComma)` at `parser.ts:2595:23`.
The exact sub-second reproduction is the parser wrapper around a destructured
generic node-array factory. It showed that the contextual signature exposes
both optional parameters as externref, while the live implementation expects
the exact node-vector carrier plus branded i32 Boolean. The exact vector bridge
was excluded, and direct namespace functions did not share lifted functions'
incoming-argc cache. The working-tree repair admits only the exact vector and
extends the declaration-identity-based optional-scalar tracker to direct
functions. Its focused omitted-versus-explicit-false oracle passes; a new full
binder run is still required before this frontier is considered cleared.

The deployment target is now explicit in the TypeScript build probe. `gc`
remains the default compatibility lane; `standalone` omits the Node platform,
records requested and actual target provenance, inventories the emitted
module's imports, requires **zero imports** for acceptance, and uses a separate
diagnostic artifact name. Unknown targets and JS-string runtime oracles in
standalone fail closed. Instead, tracked static fixtures embed the same pinned
input bytes and expose zero-argument numeric exports. A standalone canary
compiled, validated, instantiated with `{}`, reported zero imports, and
returned its expected raw-Wasm value. The real parser/binder workloads still
need that same proof.

The existing TypeScript upstream-unit adapter now has the same explicit target
and raw-Wasm lane. Its first standalone measurement compiled and validated all
**4/4** selected modules as actual target `standalone`, emitted **4,871,809
bytes** in aggregate in **12,279 ms**, and reported zero imports for every
module. The isolated Node 24.4.1 worker enables its experimental Wasm exnref
flag for this lane; without it, all four otherwise-emitted modules fail host
validation at opcode `0x1f`. Native remained **14/14**. Wasm passed **6/14**
callbacks: the base64 control and all five `parsePseudoBigInt` cases. The three
comment-scanner callbacks threw WebAssembly exceptions, and `convertToBase64`
threw during module initialization, making its five callbacks runtime-failed.
This is a real standalone frontier, not a suite pass. The adapter still covers
only 4 of 256 files and 14 of 1,761 static registrations, leaving 252 files and
1,747 registrations deferred. Standalone TypeScript 5 and its full unit suite
are therefore the active end goal, not a completed milestone.

The broad #1058 regression sweep also exposed an older module-evaluation
cycle, reproduced unchanged at the clean pre-checkpoint head: importing the
codegen index could reach collection-brand and standalone-subclass tables
before `map-runtime` had initialized `COLLECTION_KIND`. Both tables now resolve
their tags lazily. The scope-cache regression and the Map/Set subclass controls
pass, and the current checkpoint passes all **76** `issue-1058` files and all
**364** assertions. TS5/TS7 typechecks and the LOC, function-size, oracle, IR,
and codegen-fallback ratchets also pass.

### 2026-09-05 resumed standalone measurements

The omitted generic-vector review regression now passes in both GC and
standalone: omission, explicit `undefined`, and populated vectors preserve
their values (**11/11** node-array factory tests). The strict harness review
checks and upstream runner tests pass **41/41**. Missing target evidence,
orphaned legacy invocation flags, non-zero-argument standalone invocation
records, and mismatched native/Wasm callback counts are rejected.

A fresh upstream unit run (`DOGFOOD_TARGET=standalone DOGFOOD_SOURCE_DIAG=1
node --import tsx tests/dogfood/typescript-upstream-suite.mjs`) reproduces
**6/14** passing callbacks. A new working-tree reduction,
`tests/issue-1058-comment-accumulator.test.ts`, returns the expected **282**
in GC but throws in standalone. It retains the scanner's generic reducer and
six-argument callback with a defaulted array accumulator. The emitted
standalone dispatcher omitted the concrete append callback signature and ended
in its exception arm. The subsequent repair retains the vector's exact GC
carrier across the erased callback boundary, preserving accumulator identity
and its typed-null default sentinel. The inverse cast rejects incompatible
representations. This reduction now passes in both lanes; the node-array tests
pass **11/11**, and related callback/vector regressions pass **103/103**.

The authoritative upstream rerun after that repair improves standalone from
**6/14 to 9/14**: all **3/3** original comment-scanner callbacks now pass.
All **4/4** modules compile and validate with zero imports, emitting
**4,872,713 bytes** in **13,494 ms** aggregate compile time. The five
`convertToBase64` callbacks still fail during module initialization; their
upstream source reads the Node `Buffer` global before registration, which is
the next environment boundary to investigate. Coverage remains **4/256**
files and **14/1,761** static registrations. The full updated regression
sweep passes **77/77** files and **368/368** assertions; TS7 typechecking and
`git diff --check` pass.

The first full standalone parser probe completed in **255,435 ms wall /
267,141 ms CPU**, peaking at **2,945 MiB RSS**. Its graph contains **31 source
files / 35 Program files / 313 module-init statements / 5,581 functions after
bodies**. Compilation failed with **two errors and five warnings**, emitted
**zero bytes**, and executed **0/3** requested parser oracles:

- `core.ts:332:1`: `mapIterator` requires generator lowering beyond sequential
  numeric yields in standalone.
- `tracing.ts:356:38`: `dumpLegend` uses an unsupported native
  `JSON.stringify(legend)` shape.

Next work must determine whether these functions are semantically reachable
from the selected parser root before either implementing the capabilities or
removing proven-unreachable declarations before code generation. Merely
suppressing the errors would not establish parser correctness. The standalone
convertToBase64 initialization failure also remains open. No replacement PR
has been opened yet.

### 2026-09-05 standalone Buffer dependency investigation

The remaining unit file requires the Node `Buffer` global, whose current
compiler support delegates to the JavaScript host. An available `buffer@5.7.1`
package provides a real source implementation to investigate as a standalone
dependency. The diagnostic fixture
`tests/dogfood/fixtures/typescript-buffer-standalone-probe.ts` checks UTF-8
bytes for `hé` and the independent expected base64 string `aMOp`. It currently
uses the installed pnpm package path; packaging it as a reproducible harness
dependency remains follow-up work.

Its initial compile failed because generic method dispatch classified the
package's own `Buffer` function as a host builtin by name. The receiver path
now checks the resolved binding before requesting `__get_builtin`.
`tests/issue-1058-buffer-shadow-static.test.ts` reproduces the original failure
and now executes successfully with zero imports. All **7/7** existing host
Buffer tests and TS7 typechecking pass.

The real Buffer package now compiles and validates as **1,543,838 bytes** of
standalone Wasm with **zero imports**, but module initialization traps with
`illegal cast` before the oracle executes (**0/1**). A source-map-enabled rerun
points to the module-init chunk near
`buffer/index.js:16:1` (nearest mapping, not an exact statement attribution).
The source-map binary is **1,543,928 bytes** and still has zero imports. The
TypeScript unit result remains **9/14**. Commit and main
synchronization are still pending: signing failed, and the current process
cannot connect to an SSH authentication agent.

### 2026-09-05 Buffer initialization Symbol boundary

The module-init cast is reproduced by the Buffer source's guarded
`Symbol['for'](...) : null` initializer. Two repairs are required: preserve
the `symbol: true` marker on `Symbol.for`'s i32 result so conditional boxing
does not produce a Number, and register the native Symbol carrier before an
externref-to-symbol conversion instead of importing `__unbox_symbol` when
that carrier has not been registered yet. The focused initializer now runs
with zero imports. TS7 typechecking passes. The registry, symbol-array, and
host symbol regressions pass **72/73**; the remaining empty-string-description
test also fails with both repairs removed, establishing it as pre-existing
relative to this change.

The real Buffer package now initializes and reaches its oracle. It still
returns an incorrect result: the expanded five-export probe reports byte
length **0** (expected **3**), non-finite byte reads (serialized as `null`),
and an exception from base64 conversion (**0/5**). All four source modules
compile into a valid **1,552,698-byte** module with zero imports. Next work
must trace `Buffer.from`'s byte construction; initialization is no longer
the failing stage. This does not change the TypeScript unit score of **9/14**.

### 2026-09-05 Buffer prototype augmentation reproduction

The four additional real-package controls return `Buffer.byteLength('hé',
'utf8') === 3`, `Buffer.alloc(3).length === 3`, and
`Buffer.from([104, 195, 169])[0] === 104`; all three pass. The fourth,
`Buffer.TYPED_ARRAY_SUPPORT`, returns false instead of true. The module is
valid, has zero imports, and is **1,556,461 bytes**. These controls narrow
the next investigation to augmentation, not UTF-8 length calculation.

`tests/issue-1058-buffer-prototype.test.ts` reproduces the package's
`typedArraySupport` pattern without Buffer. It compiles and instantiates
with zero imports but returns **-2**: immediately after
`Object.setPrototypeOf(arr, proto)`, `Object.getPrototypeOf(arr) !== proto`.
The later checks separately distinguish a missing method (-3) from a wrong
call result (-1), with 42 as the required result. This regression currently
fails and the patch is not merge-ready.

Code inspection identifies the non-`$Object` return in
`src/codegen/object-runtime-prototype.ts`'s `__object_setPrototypeOf` as a
candidate write-side gap; standalone has no host boundary fallback there.
The receiver-method fallback also does not dispatch this native typed-array
receiver. Merely routing that call through the existing native dispatcher
still returns the wrong result, so that speculative change was removed.
Next: trace the actual typed-array prototype storage/read path and implement
identity-preserving set/get/prototype lookup before retrying method dispatch.
Do not hardcode the Buffer support flag or replace the upstream assertions.

Further emitted-Wasm inspection confirms the receiver is the packed-byte
`__vec_*` representation (length plus array), not `$__ta_dyn_view`. Therefore
adding only a dynamic-view prototype override cannot fix this source. The
`Object.getPrototypeOf(arr)` expression emits the intrinsic Uint8Array
prototype singleton directly, without a runtime receiver lookup; its fold is
in `expressions/object-get-prototype-of.ts` (the declared-name typed-array
arm). The writer passes the raw vec identity to `__object_setPrototypeOf`,
whose ordinary-object guard rejects it. Both write and read need repair.

A positive control in `tests/issue-1058-typed-array-expando-call.test.ts`
passes unchanged: an own method on `new Uint8Array(2)` receives ordered
arguments, reads `this[0]`, and writes `this[1]` on the original array.
Expected numeric oracle **1**, observed **1**, zero imports. This establishes
that own-method compilation and receiver identity work for that concrete
shape; do not replace that path wholesale while adding inherited lookup.

Implementation direction: extend the identity-keyed vec side-table substrate
in `vec-props.ts` with an explicit prototype override (distinguishing absent
from explicitly null), consult it before the declared-type intrinsic fallback,
and use the same link in inherited property lookup. Preserve own-property
precedence, getter receiver, extensibility refusal, and cycle checks. Include
both packed-byte vecs and dynamic typed-array views in the regression matrix,
but do not assume their storage layouts are interchangeable. The inherited
method call must then delegate only after existing compiled method paths
decline. The full Buffer prototype reproduction remains failing.

### 2026-09-05 prototype-store implementation checkpoint (not merge-ready)

Implemented an explicit prototype/presence pair on the identity-keyed vec
record, native get/set/status integration in `vec-prototype.ts`, inherited
lookup with the original receiver, and a packed-typed-array method fallback.
The declared-type getPrototypeOf path now consults the override before using
the intrinsic prototype. The Buffer prototype reproduction now passes (42),
and the own-method control still passes (1), both with zero imports.

Real Buffer measurements improve: `TYPED_ARRAY_SUPPORT` now returns **1**;
`Buffer.from('hé', 'utf8')` now reports length **3** and bytes **104, 195, 169**
instead of length 0/non-finite byte reads. The expanded byte/base64 probe is
**4/5**, valid **1,557,095 bytes**, zero imports. Base64 still raises a Wasm
exception; neither the full Buffer oracle nor the deferred TypeScript base64
unit file passes yet. Do not change the TypeScript **9/14** score from this.

Focused checks are **7/8**: null replacement, distinct identities, own-property
precedence, Buffer init, shadowed static binding, own method, and inherited
method pass. The new top-level-array/nonextensible check fails its identity
assertion immediately after setup, before checking refusal. It needs tracing;
do not claim full extensibility correctness. Also test a frozen array with its
unmodified intrinsic prototype: the generic runtime reader still lacks the
packed carrier's intrinsic kind, so SameValue handling needs scrutiny.

Existing nearby checks: **25/28** with a computed `length` write mismatch in
`issue-3537.test.ts` (not baseline-attributed yet) and two Node exnref-flag
failures in `issue-5194-es2015-typedarray-r3.test.ts`. Passing the flag on the
Vitest parent did not propagate it to that test's execution context. The
host expando and both-lane extensibility suites pass **7/7**. Next: repair the
top-level identity case, baseline-attribute the length failure, exercise dynamic
views and getter receivers, then diagnose Buffer's remaining base64 exception.

### 2026-09-05 integrity-fold repair and base64 isolation

The top-level identity failure was an earlier `getPrototypeOf` fast path:
`nonExtensibleVars` caused the compiler to emit `Object.prototype` for the
typed-array binding. Excluding typed arrays from that plain-object fold fixes
all **4/4** prototype-storage checks, including self-cycle refusal, unchanged
prototype acceptance after preventExtensions, and rejected replacement with
identity preserved. This does not yet settle the separate unmodified-intrinsic
SameValue concern above.

The computed-length failure is reproduced with `vec-props.ts` restored to
its HEAD version (f8ab271d), while all other worktree changes are held fixed:
the same single targeted test returns **2** instead of **1**. The edited
vec-props file was restored after this diagnostic. This attributes that
failure as independent of the new vec prototype storage/wiring, not as a
whole-branch clean baseline result.

Further real-package controls: base64-js `fromByteArray([104,195,169])` returns
the expected `aMOp` (**1/1**); Buffer's zero-argument UTF-8 `toString` oracle
returns **0** instead of **1**. The two-export module validates with zero
imports (**1,557,386 bytes**). A focused inherited-method
`slow.apply(this, arguments)` control also passes **1/1**. Emitted Wasm shows
the zero-argument Buffer `toString()` goes through `__extern_toString`, whereas
the encoding-argument call goes through `__call_m_toString_1`, whose body
delegates to `__extern_method_call`. Next trace that runtime member lookup and
Buffer's own toString closure; do not substitute the direct base64 control for
the failing upstream Buffer behavior.

### 2026-09-05 Buffer toString diagnostic refinement

The method-forwarding reproduction now includes a function constructor's
prototype, a named method expression, `this.length`, `arguments.length`, and
two omitted parameters of `slow.apply(this, arguments)`. Both `foo` and
`toString` pass when the receiver crosses an untyped identity function.
The concrete typed-array `toString` call fails where `foo` passes; preserve
both receiver forms in the regression matrix. This is evidence of a static
builtin fast-path defect, not evidence that generic apply is broken.

In the real Buffer package, method identity compares equal and callable-type
checks return the expected mask **7** for prototype toString, instance
toString, and prototype write. Directly calling
`Buffer.prototype.toString.call(bytes, 'base64')` returns a non-string; the
normal argument-bearing call throws. The exception-message diagnostic has
length **30** and begins `ca`, consistent with the native `called value is not
a function` guard (not a decoded full-message proof). Its numeric diagnostic
is **97099030**. These diagnostic exports are not upstream test passes.
The direct-base64 encoder remains a passing control. Next inspect the
prototype method value/body and its module-init assignment separately from
the static zero-argument `__extern_toString` shortcut.

### 2026-09-05 concrete toString dispatch checkpoint

`vec-prototype-method-call.ts` adds a guarded two-arm call for local packed
typed-array identifiers. An explicit prototype override resolves its method
before evaluating arguments and applies the captured callee to the original
receiver. The no-override arm retains builtin lowering. Spread, arbitrary
receiver expressions, and non-standalone lanes remain on their existing paths.
The four method/receiver combinations now pass **4/4**; builtin fallback and
two string-result ordering controls bring the focused file to **7/7**.

The initial ordering controls returned numbers from `toString` and assigned
the result to a variable inferred as string; those failed and diagnostic
arithmetic reached string coercions. The ordering controls now use string
results to isolate ordering. Numeric results in the direct comparison matrix
remain covered. A numeric override result stored in an inferred-string local
is a separate unresolved representation case, not claimed fixed by the
string-result controls.

The real Buffer module remains **0/2** for combined byte/base64 and no-argument
UTF-8 string conversion: base64 raises a Wasm exception and UTF-8 reports 0.
It validates with zero imports (**1,560,459 bytes**). The concrete-local fix
does not reach the package's erased-return call. WAT inspection locates its
actual toString implementation in `__closure_45`, which references
`__fn_tramp_slowToString_cached`; `__set_member_toString` is only the write
dispatcher, not the method body. Continue tracing the closure invocation and
runtime string-conversion path. Full upstream TypeScript score remains 9/14.
Retry verification: all **22/22** tests across the six focused Buffer/vec
files and the host-expando/both-lane-extensibility suites pass. TS7 typecheck
and whitespace validation pass. This does not cover the unresolved cases
explicitly recorded above or establish full TypeScript unit-suite completion.

### 2026-09-05 CommonJS dependency isolation

Temporary runtime error instrumentation (removed after measurement) identified
the failing Buffer base64 method as `fromByteArray`, called through the
`base64-js` CommonJS default object. Direct named ESM invocation of the encoder
works. A two-file standalone CommonJS control returns 299 for bytes 104/195;
adding a second CommonJS module makes the first import's method disappear
(`typeof` callable check returns 0) and the nested call throws. The focused
`issue-1058-cjs-dependency-method.test.ts` records these runtime expectations,
not merely validation. Investigating exact imported-variable storage instead
of graph-wide name aliases; no TypeScript-suite score improvement claimed yet.

WAT establishes the collision: both module initializer sections write globals
26/27/28 (`__cjs_default_export`, `exports`, `module`) and the imported read
uses global 26. The second object replaces the first. Program ABI's exact
declaration lookup also resolves to that same allocator object, so an
import-read-only patch was tested, did not fix either failure, and was removed.
`registerModuleGlobal` in `src/codegen/module-global-registration.ts` reuses
`ctx.moduleGlobals.get(name)` and observes the existing allocator under each
declaration. Next fix must isolate module storage and project each source's
bindings consistently for initialization, reads, writes, and import aliases.
Do not merely special-case `base64-js` or rename its method. Temporary debug
instrumentation is removed; the regression matrix includes a single-module
positive control, a sibling-module collision, and a nested dependency call.

Implementation checkpoint: module variable registration now allocates separate
cells for external-module declarations from different source files, retaining
same-source redeclaration reuse. Source-owned cells and import aliases are
projected before body compilation and each accumulated initializer statement.
The focused matrix is **4/4**, including independently mutable ESM bindings
and live import aliases across repeated calls. The real Buffer byte/base64
oracle now returns **1** (previously threw); UTF-8 no-argument conversion still
returns **0**. Thus actual Buffer is **1/2**, valid **1,560,672 bytes**, zero
imports. Nearby module tests are **51/53**: the two failures are missing local
Test262 `namespace/internals/set-prototype-of-null.js` fixtures, not runtime
verdicts. TS7 typecheck passes. Broader regression/TDZ and source-scoped metadata
coverage remains required before calling this storage change merge-ready.

Broad checkpoint verification completed: **84/84 `issue-1058` files, 387/387
assertions pass** (79.55 seconds). Formatting, whitespace, LOC and function
budget gates pass. This does not replace full module/TDZ conformance coverage.
Next goal-facing step: make the real Buffer polyfill an explicitly pinned
standalone test-environment dependency and wire it into the original
`convertToBase64` unit file, without changing its assertions. Current adapter
still has the previously measured 9/14 score; no new upstream-unit pass is
claimed from the separate Buffer probe. UTF-8 `.toString()` remains independently
open. The polyfill is currently available only under PNPM's transitive store,
not a root `buffer` package dependency; avoid baking that store path into the
production adapter.

### 2026-09-05 independent base64 oracle and 14/14 standalone unit checkpoint

The adapter's old `ts.sys.base64encode` called TypeScript's own base64 function,
so the convertToBase64 comparison was not an independent oracle. Restored the
Buffer-based system implementation while preserving the original test bodies
and assertions. `typescript-runtime-pin.json` pins buffer 5.7.1, base64-js 1.5.1,
and ieee754 1.2.1 as published npm tarballs with verified digests. Setup extracts
and links only its private cache; it does not install into shared node_modules.
The report now carries runtime oracle version **2**. A negative-control test
substitutes a broken TypeScript encoder and verifies that the comparison fails;
another test compares the pinned Buffer implementation with native Node Buffer.

`DOGFOOD_TARGET=standalone pnpm run dogfood:typescript-upstream-suite` now exits
0: **14/14 native and 14/14 standalone callbacks**, **4/4 modules compiled and
validated**, **zero imports**, **6,659,948 aggregate Wasm bytes**. Per file:
base64 **1/1**, comments **3/3**, convertToBase64 **5/5**, parsePseudoBigInt
**5/5**. Full inventory remains **256 files / 1,761 registrations**; selected
coverage is **4 files / 14 callbacks**, with **252 files / 1,747 registrations
deferred**. Do not mark the goal complete. Runtime/verdict regression tests
are **20/20**. Buffer's no-argument UTF-8 conversion is still open separately.

### 2026-09-05 fresh full standalone parser measurement

After the module-storage/runtime-oracle fixes, reran the documented three-case
standalone parser command against verified generated TypeScript diagnostics.
It completed (not timed out) in **238,296 ms**, peak RSS **2,837.4 MiB**, with
**31 source files / 35 program files**. Compilation still fails: **two errors**
(`core.ts:332` generator `mapIterator`, `tracing.ts:356` JSON.stringify legend)
plus five IR fallback warnings. No Wasm artifact and no parser invocation
results; the three required runtime cases are **unexecuted**, not passes.

Added focused reproductions for both remaining shapes. The legend test has two
variants: its declared TraceRecord[] type is refused at compile time; an
`unknown as object` assertion bypasses that gate but yields the wrong runtime
JSON (**0/2**). Thus removing the array refusal is NOT a fix. The codec has a
packed-vector normalization arm, but closed record elements still lack the
required serialization behavior. The generator reproduction checks laziness,
callback counts, two yields, and undefined completion, not merely compilation;
the needed implementation is resumable iterable-loop lowering, not eager
array buffering. These new regressions deliberately remain red pending fixes;
the earlier 387/387 checkpoint predates these newly added assertions.

### 2026-09-05 tracing-record JSON implementation checkpoint

Implemented compact/nullish-replacer serialization of flat data-record arrays
via the existing closed-record materializer and ObjVec codec. This path reads
the array once and preserves null arrays/elements; class records, nested field
carriers, and record `toJSON` members are not admitted by this bounded layout
check. Nullable string slots proven to represent optional/undefined properties
are restored to canonical undefined in the temporary open record. The native
JSON dispatcher previously serialized the undefined singleton as `null`; it now
returns an absent serialization piece, letting object callers omit it and array
callers emit null. Other replacer paths retain their existing behavior.

The exact legend tests and nullable controls pass **5/5**; the combined focused
JSON run passes **28/28**. An attempted dynamic-key record route was removed
after measuring `[{}]` (closed-record runtime enumeration exposes no fields),
not shipped as a substitute. Full-parser remeasurement is running; do not claim
the tracing error removed from that graph until its result is inspected. The
generic mapIterator standalone regression remains a known compile failure.
The expanded JSON matrix is now **6/6**, including side-effectful array
production (evaluated once) and boolean/numeric fields. TS7 typecheck,
formatting, whitespace and size/function gates pass. The independent-oracle
upstream slice was rerun after the JSON dispatcher change and remains **14/14
standalone**, with all four modules free of host imports.
The full issue-1058 regression run completed with **393/394 assertions across
86 files**: **85 files pass**, and the only failure is the explicitly added
generic `mapIterator` standalone reproduction. This is not an all-green run.
Full-parser remeasurement completed in **319,969 ms**, peak RSS **3,505.1 MiB**,
with the same **two hard errors plus five warnings**, no artifact and no
invocations. The tracing JSON error is **NOT removed from the complete graph**
despite the local runtime improvement. Next isolate the full graph's actual
namespace-record/vector carrier; do not widen the JSON gate without validating
the runtime representation. A namespace-scoped, declaration-after-functions
control is being added to distinguish that source shape from graph interactions.
That namespace control reproduced the refusal: its anonymous record layout uses
externref for optional string fields instead of nullable native-string refs.
The layout gate now accepts boxed fields only when the source property type is
provably a scalar JSON union (string/number/boolean/null/undefined). These fields
already preserve canonical undefined, so they do not use nullable-slot repair.
The expanded tracing suite now passes **7/7**, including the namespace case.
Temporary layout logging was removed. A new full-parser build is still needed
after this last boxed-field change; the prior full-graph failure remains the
latest authoritative full-parser result until that measurement completes.

The subsequent full-parser run (started 2026-09-05T17:58:24Z, recovered from
session 32215) completed in **260,376 ms**, peak RSS **3,088.9 MiB**. It now
reports **one hard error plus five warnings**: the tracing JSON refusal is gone;
`core.ts:332` generic `mapIterator` remains unsupported. There is still **no
Wasm artifact, no validation, and no invocation**. The next implementation is
resumable `for...of` lowering, preserving lazy iteration and IteratorClose on
abrupt completion; the module-initializer call must not be discarded as dead.

### Resumable for-of implementation checkpoint (2026-09-05)

The worktree now has synchronous iterator-init/step/close state terminators,
with separate instruction emission in `generators-native-for-of.ts`. The body
uses a state-lowered close region: normal exhaustion and IteratorStep failure
do not close; injected return/throw and body exceptions do. An existing throw
keeps precedence over a close error. Captured loop bindings, colliding frame
names, async iteration, and unsupported own break/continue remain declined.
The existing shared-pending-slot restriction also applies inside yielding
finally blocks. Explicit source returns through such a region remain refused
by the existing planner, rather than bypassing close.

Two representation fixes were necessary after the first emitted code:
generic generator callable parameters use the finalize-filled apply bridge
instead of a prematurely frozen ABI candidate list, and numeric `.value`
consumers include boxed result carriers rather than silently returning zero.

The new regression suite currently passes **12/14**. It validates Wasm and
asserts zero imports in a Node child with standardized exception handling
enabled (10-second runtime timeout). Numeric/generic reads, callback laziness,
normal exhaustion, return-before-start, return/throw close, body/next exceptions,
and close-error precedence pass. Two explicit regressions remain **failing**:

- TypeScript's inverse option Map initializer compiles but returns the wrong
  result; isolate tuple mapping versus Map's iterable constructor next.
- Mutating/appending to a numeric array between suspensions observes a stale
  element (`-2`): the shared native `__iterator` materializes a boxed copy of
  numeric vectors. A real iterator must retain the live original source.

This is an uncommitted implementation checkpoint, **not** a completed parser
or conforming generic-iteration claim. A fresh full graph is running in session
22820; recover that handle before starting another full build. Two accidentally
misconfigured Vitest launchers (sessions 1055 and 37949; PIDs 68543/69314) are
waiting for stdin, not executing tests. Permission to stop only those launchers
was requested; do not confuse them with the correctly completed 12/14 run.

The nearby compatibility run passes **172/172 tests in 8/8 files** (generator
carriers, terminal undefined, boolean done, try-regions, generic callback
results/registration, and the original host-lane inverse-Map fixture).
Typechecking, formatting, whitespace, and both change-scoped size budgets pass.
Further isolation adds a fifteenth regression: mapped heterogeneous Map entries
already have a wrong first key before the inverse Map constructor sees them
(`-20`). The initializer's first Map has size 2, but the inverse has size 1
(`-21`), consistent with key collapse; this is not yet a proven root cause.
That two-test isolation run is **0/2**, with 13 tests intentionally unselected;
do not report the entire new suite as green.

Full-parser session **22820 completed**: **275,557 ms**, **3,092.4 MiB peak
RSS**, **80,283,267 emitted Wasm bytes**, actual target **standalone**. Both
former hard errors are gone (**compileSuccess=true**, five warnings), but
**validation fails** in function 235, `measure`: `if[0] expected type i32,
found local.tee of type anyref`, Wasm offset 2,541,151. Therefore the parser is
**not runnable**, all **3/3 requested workloads fail before invocation**, and
the import count remains **unmeasured** (module construction failed). Diagnostic
artifact saving was disabled; do not claim that the emitted binary is saved at
the suggested artifact path. Next isolate `measure`'s optional performance
receiver/truthiness lowering, or rerun with environment variable
`JS2WASM_TYPESCRIPT_PROBE_DIAGNOSTIC=1` for the full
binary if needed. No second full-parser build is currently running.

The final combined new-suite run is **12/15 passing**, with exactly the three
Map/tuple and live-array failures described above. No tests are skipped in that
run. The 172/172 compatibility result remains separate from this failing suite.

The `measure` validation failure now has a small source-level reproduction in
`tests/issue-1058-performance-measure-standalone.test.ts`. It copies the upstream
optional-mark lookup/nullish fallback, numeric duration accumulation, and
optional performance method call. Compilation succeeds but validation reports
the same `if[0] expected type i32, found local.tee of type anyref` in `measure`
(function 51, offset 53,946 in this smaller module). This permits local
optimization/codegen isolation without another full-parser build.

The local WAT proves the malformed condition belongs to `durations.get(name)
|| 0`, not the optional performance receiver. `emitToBoolean` omitted abstract
`anyref`/`eqref`, leaving a reference directly on the `if` condition stack.
Both representations now externalize by identity and use the existing canonical
truthiness classifier. Optimization disabled also reproduced the invalid code.
After that fix, accumulation returned 40 but inline `Map.get(...) === 40`
still folded false: typed Map.get exposed its kernel anyref storage carrier to
source-expression dispatch. The Map.get boundary now returns externref, like
the existing IR Map adapter; keys and stored values are unchanged.

The initial combined Map/performance run passes **26/26**, including correct
duration accumulation, 13 truthiness/identity/short-circuit cases, and 12 nearby
Map/Set tests. Two direct emitter tests additionally pin abstract-reference
truthiness so normalizing Map.get cannot mask regression of the coercion fix.

The expanded performance test passes **16/16**, including both emitter controls.
Full-parser session **47254 completed** in **244,335 ms**, peak RSS **2,940.1
MiB**, with **80,283,472 Wasm bytes**. It now **compiles AND validates** under
the actual standalone target. It still has **one host import: `env.Set_has`**,
so the host-free gate correctly prevents all **3/3** workload invocations.
The five IR fallback warnings remain. Diagnostic publication is false (the
host-free/run verdict failed), so no newly saved artifact is claimed. This
measurement predates the subsequent tuple-index-reader edit. Next resolve the
source/ABI path retaining `Set_has`; do not provide a host shim to pass the gate.

The tuple failure was isolated by comparing a direct `.next().value` binding
with indexing through a saved IteratorResult. The yielded value was a physical
tuple struct; the dynamic `__extern_get_idx` reader knew vectors but not tuple
`_N` storage fields. New `tuple-index-read.ts` emits exact numeric-index arms
from `ctx.tupleTypeMap` into the existing finalize-time reader, using the actual
field carrier and preserving boolean brands/object identity. It does not change
the tuple allocation or copy the value. TypeScript's inverse option Map and
the intermediate mapped-entry regression now both pass.

Latest combined focused run: **31/32 passing** — performance **16/16** and
generator/tuple **15/16**. The one remaining failure is numeric-array mutation
between generator suspensions (shared iterator snapshot, `-2`). The escaped
tuple test checks string/number/boolean/object values and negative, fractional,
and out-of-range indices. Typechecking, formatting, whitespace and both size
budgets pass. No full-parser process is running; its latest complete-graph
measurement remains the validating, one-import session 47254 above.

### Optional native Set follow-up (2026-09-05)

The parser contains `notParenthesizedArrow?.has(tokenPos)`. Optional calls had
their own extern method dispatch, bypassing native Set helpers. Added a captured
native Set `has`/`delete` adapter, preserving receiver single evaluation and
argument short-circuiting. Its boolean result is boxed so the nullish arm can
return canonical undefined rather than false. Abstract-reference receivers now
participate in the existing null/undefined guard instead of being discarded.

Focused tests: **7/7**, validating, zero imports, correct return values. The
pre-change control loads `HEAD:src/codegen/expressions/calls-optional.ts` through
an ignored Vitest pre-load plugin without modifying any production files;
all other dirty worktree code is identical. That control fails **6/6** initial
new tests. A seventh concretely typed receiver test directly reproduces
`env.Set_has` in the control and passes import-free with the adapter. These
controls attribute both the semantic and host-import fixes to this change.
Neighbor run: **21/22** across four files (before adding the last three Set
cases). The `o.f?.(x)` case in `issue-2049.test.ts` returns -1 rather than 6 in
both candidate and the pre-change control: not introduced by this change,
but still open. Typechecking, formatting, whitespace and size gates pass.
Full parser session **55162 is complete**: started 2026-09-05T18:50:26.287Z,
**380,009 ms**, peak RSS **2,950.9 MiB**, **80,285,778 bytes**,
`actualTarget=standalone`, `compileSuccess=true`, `validates=true`,
**zero imports**. Same 31-source/35-program-file graph and five IR fallback
warnings. This is the first measured complete-graph zero-import result in this
handoff. It includes the tuple-index change as well as the optional Set fix.

All **3/3 requested invocations remain failing before invocation**: instantiation
throws `[object WebAssembly.Exception]` during module initialization, with no
stack/offset available from the current error formatter. No diagnostic binary
was published because the verdict failed. Next: expose the startup exception's
payload/source through a diagnostic-only path and fix the offending initializer;
do not weaken the raw instantiation/import/oracle gates or count this as a
working parser. No full-parser process remains live.

Startup diagnostic control: a standalone module whose initializer throws a
known Error reproduces an actual `WebAssembly.Exception` with no own properties
and no `.stack`; changing the formatter alone cannot recover a location. V8
tracing enabled only around instantiation reports `__module_init` and
`__new_Error` in that control. Added opt-in
`JS2WASM_TYPESCRIPT_PROBE_TRACE_STARTUP=1` to the build worker, resetting the
flag in `finally`. It leaves the original binary, imports, invocation handling,
and verdict gates unchanged. Do not use Node's global `--trace-wasm` flag for
this probe: that also traces tsx's compiler-side Wasm parser and floods output.
The actual probe control is now automated in
`tests/dogfood/typescript-startup-trace.test.ts`: **1/1** passes, with the known
startup throw still producing a failed verdict despite valid zero-import Wasm.
The existing harness verdict tests also pass **18/18**; typechecking and
formatting pass. Complete-graph traced session **50763 is complete**:
**380,866 ms**, peak RSS **3,215.1 MiB**, same **80,285,778 bytes**, validating,
zero imports, still failing all three cases at instantiation. No artifact
published and no full-parser process remains live.

The startup trace pinpoints:
`__module_init -> __module_init_chunk_1 -> Version_new -> Version_init -> every
-> __extern_get_idx -> __new_TypeError`. Actual pinned `semver.ts` initializes
`Version.zero = new Version(0, 0, 0, ["0"])`; its constructor calls
`every(prereleaseArray, s => prereleasePartRegExp.test(s))` and the equivalent
build predicate. Trace reaches the element read and TypeError without entering
the predicate, making callback dispatch/registration a candidate, not a proven
root cause. Do not broaden the generic-generator callback adapter merely on
this hypothesis.

`tests/issue-1058-version-startup.test.ts` currently provides **4/4 passing
controls**: exported generic every, static Version initialization, string/array
union narrowing and one-argument string/RegExp predicates, both single-file and
two-module compilation. These DO NOT reproduce the complete-graph failure.
Next reduction must preserve more real semver constructor overload/default and
module-scale callback registration context (including the module-level RegExp
binding) until it produces the same startup TypeError. No runtime fix claimed.

### Version initializer callback registration (2026-09-05)

The reduction now reproduces the startup exception when it retains every's
overloads, the five-parameter overloaded Version constructor, module-level
RegExp predicates, and the barrel import. Four simpler controls pass; the new
fifth case fails during instantiation with a WebAssembly.Exception.
Focused WAT (`.tmp/ts5-version-types.txt.wat`) proves the mismatch: `every`
accepts function types 124–132, none taking a native string, while Version_init
passes a later-created closure with function type 135
`(ref null 123, ref null 6) -> i32`. The closure struct is a valid subtype of
the shared closure carrier; the stale function-signature ladder cannot call it
and reaches `__new_TypeError` instead. This is not a RegExp parsing failure.

Extended the existing finalize-filled generic-generator callable adapter to
ordinary generic function/method parameters as well. The standalone, callable
parameter, no-spread and maximum-eight-arguments boundaries remain unchanged.
Focused Version plus neighboring callback suites initially passed **103/103**.
Additional negative controls found that the shared apply bridge deliberately
returns undefined for non-callables (it also serves optional probes). Generic
source calls now use the finalize-filled `__typeof_function` classifier and
throw TypeError after evaluating arguments when the value is not callable.
Current Version/callback suite **9/9**, including null, undefined, number and
plain-object callees plus an argument-side-effect check. Typechecking and
formatting pass. The nearby standalone suites remain **38/39**, with only the
known live-array iterator snapshot failure. After the callable guard, the
generic/multifile/iterator run is **113/114** with that same sole failure;
both size gates and typechecking pass on the guarded code.

Complete-graph session **98374 finished**, started
2026-09-05T19:15:26.084Z: **325,234 ms**, peak RSS **2,479.7 MiB**,
**78,984,248 bytes**, validates, zero imports, same five warnings. This run
contains the generic callback dispatch fix but **predates the new callable
guard**. The trace proves the Version failure is fixed in the actual graph:
`every -> __apply_closure -> __call_fn_method_2 -> __closure_671 -> __regex_search`
returns true, both assertions pass, and `Version_init` returns.

The next startup failure is
`tryGetPerformanceHooks -> tryGetPerformance -> __new_TypeError`, before any
workload invocation (**0/3 invoked**, all blocked by instantiation). No artifact
was published; no full-parser process is live. `performanceCore.ts` starts with
`isNodeLikeSystem()`; its real implementation in `core.ts:2586` tests
`typeof process !== "undefined" && !!process.nextTick && !process.browser &&
typeof require !== "undefined"`. Investigate ambient/global presence and the
call site rather than adding a performance host shim. Full guarded-compiler
measurement is still required.

### Standalone ambient capability presence (2026-09-05)

A three-case reduction found Node detection already correct, but absent
`declare const performance: Performance | undefined` incorrectly classified as
an object in standalone (**1/3 before**, **3/3 after**). The explicit ambient
identity helper was disabled for standalone, so both runtime lookup and typeof
anti-folding guards were bypassed. Standalone now uses the same explicit typed
ambient identity path, backed by its existing **native global environment**;
no host import or performance implementation is introduced. WASI/other strict
host-disabled lanes retain their prior gating. This also gives ambient reads
priority over unrelated flat-map locals, including the dead destructuring
binding in TypeScript's performanceCore.

Full traced run **16487 is complete** with this change and the generic-callable
guard: started 2026-09-05T19:25:38.471Z, **320,524 ms**, peak RSS
**2,783.3 MiB**, **79,395,997 bytes**, validates, zero imports, five warnings.
Version initialization still passes, but the same
`tryGetPerformanceHooks -> tryGetPerformance -> __new_TypeError` remains.
All three workloads fail before invocation; no artifact was published and no
full-parser process remains live. The ambient-presence defect is fixed in the
reduction, but **was not the only cause of this full-graph startup failure**.
Next run should use the existing `JS2WASM_DUMP_TYPES=<worktree>/.tmp/<name>`
and `JS2WASM_DUMP_WAT_FN=tryGetPerformance,isNodeLikeSystem` diagnostics to inspect
the emitted failing operation rather than infer it from adjacent source.
Runtime-presence/removal and
lexical-shadow controls plus the existing host ambient suite pass **13/13**
(5 standalone presence cases, 8 existing ambient cases). Supplied native
capabilities remain observable, deletion changes subsequent plain/compared
typeof results, and dead locals/real lexical shadows retain their behavior.
Typechecking, formatting, whitespace and both size gates pass.

Follow-up diagnostic session **13180 completed**, emitting focused WAT for
`tryGetPerformance,isNodeLikeSystem` to
`.tmp/ts5-performance-full-types.txt.wat` using the existing debug emitter.
The real pinned `performanceCore.ts`, compiled with its exact
`isNodeLikeSystem` function extracted from core.ts and a re-export barrel,
**initializes and returns 1** from a no-native-hooks check (scratch driver
`.tmp/ts5-performance-debug.mts`). Thus the remaining full-graph exception is
not reproduced by performanceCore source alone; inspect the full emitted call
and binding representation before changing the environment behavior again.

The full WAT identifies the mismatch precisely: `isNodeLikeSystem` begins with
`i32.const 1` for `typeof process !== "undefined"`, then loads `ref.null extern`
for process and throws TypeError before reading nextTick. The same body is
inlined into `tryGetPerformance`, explaining why the runtime trace did not show
an isNodeLikeSystem entry. The checker injects `__js2wasm_node_env.d.ts` when
the joined graph contains a `node:` reference; even a comment can trigger this
type-level hint. That declaration is not runtime provision of process.

Two focused controls reproduce both errors before the fix: absent process has
the wrong typeof, and an explicitly supplied native process value cannot be
read. Standalone ambient `process` variables from declaration files now enter
the existing native-global-environment reader and typeof anti-folding guards.
No unconditional absent/present answer is used. Both controls pass afterward;
the combined presence suite is **7/7** before adding the exact Node-detector
guard control. Existing host paths and concrete lexical shadows stay separate.
Full traced session **58591 completed** with the fix: started
2026-09-05T19:41:33.496Z, **274,238 ms**, peak RSS **2,858.1 MiB**,
**79,447,831 bytes**, validates, zero imports, five warnings. The trace now
gets through performance-hook detection and finishes module-init chunk 1.
Chunk 2 calls `__builtin_static_Date_now`, whose body throws TypeError.
All three workloads still fail before invocation; no artifact published and
no full-parser process remains live. Presence suite is now **8/8**, host ambient
suite **8/8**, typecheck and both size gates pass.

Next identified mismatch: first-class `Date.now` enters builtin-value-read.ts's
generic throwing static-method fallback, unlike direct Date.now() in
call-namespace-static.ts. The latter already has an explicit standalone clock
policy (legacy epoch-zero fallback, or certified clock capability); WASI uses
its clock helper. Reified Date.now should share the existing policy, not invent
a clock source or add an unapproved host import. Inspect
`standalone-clock-capability.ts` before wiring the extracted function path.

Follow-up: added typed and dynamic stored-Date.now module-initializer tests.
Both reproduce an instantiation exception before the fix. The value closure
now returns f64 through the existing standalone clock emitter (or existing
WASI helper), preserving singleton identity and the no-clock epoch fallback.
No new clock source or capability import is introduced. Both focused tests
now pass (2/2); the existing clock capability suite also passes (23/23).
TypeScript typechecking, whitespace, LOC and function-budget checks pass.

Full parser session 10479 completed (started 2026-09-05T19:54:54.481Z):
253,722 ms wall time, 2,631.3 MiB peak RSS, 79,447,650 binary bytes,
compileSuccess=true, validates=true, standalone, zero imports. Startup now
passes the former Date.now exception in chunk 2 and reaches chunk 5.
All three required oracle cases still fail at instantiation (0/3):
`RuntimeError: illegal cast` in `__module_init_chunk_5`, function 5464,
binary offset 47035288 (0x2cdb398). The final traced helper is `__map_new`.
The diagnostic publisher correctly did not publish the rejected binary.

Next: dump chunk 5's WAT and identify the cast immediately after Map creation;
reproduce its source initializer independently before changing carrier code.
The five existing IR fallback warnings remain. This is startup progress, not
parser-oracle or upstream unit-suite completion.

Diagnostic session 73633 reproduced the same binary and offset in 256,468 ms,
peak RSS 2,862.4 MiB. `.tmp/ts5-chunk5-types.txt.wat` identifies the first
scanner Map initializer: `new Map(Object.entries(textToKeywordObj))`.
The source is `MapLike<KeywordSyntaxKind>` with a string index signature;
the object literal is emitted through native dynamic-object writes. At WAT
line 25240 its externref global is cast to the empty MapLike struct (type 80),
before an incorrectly empty entries array is constructed. Thus the runtime
Map kernel is not the failing cast. Add single-/multi-module reproductions and
route open index-signature enumeration through the existing runtime helpers.
Both reproductions failed with `illegal cast` before the fix and pass afterward
(2/2), verifying three Map entries and ordered keys/values with zero imports.
The fix excludes string-/number-index-signature types from closed-struct
enumeration; their runtime own properties, not the checker's declared field
list, determine keys/values/entries. Typecheck, whitespace and both size gates
pass. Six neighboring test files: 57 passed, 2 failed, 17 skipped (76 total).
Both failures reproduce identically with object-ops.ts loaded from HEAD via
`.tmp/ts5-enumeration-baseline.config.mts`: host array hasOwnProperty returns
10 rather than 1, and the interface-slot sort returns `aAbB` rather than the
test's `bBaA`. The latter test explicitly pins an older broken no-op sort.
The same control makes both new MapLike regressions fail again, establishing
the enumeration change's causal effect without reverting production files.
Full parser rerun session 1077 completed: started 2026-09-05T20:08:04.921Z,
301,719 ms, peak RSS 3,167.9 MiB, 79,446,815 bytes, valid standalone Wasm,
zero imports. The trace now iterates and seeds the keyword Map successfully,
then creates the next Map and traps in chunk 5 at offset 47034701
(0x2cdb14d), still 0/3 oracles, no published artifact.

Next reproducer added to the same test: `new Map(Object.entries({ ...keywords,
extra: 4 }))`. Spreading alone passes, but adding the own field recreates
`illegal cast`; current test result is 2 passed / 1 failed (3 total).
`compileObjectLiteralForStruct` in literals.ts around line 3229 resolves the
index-signature spread source to the empty MapLike struct and stores its
dynamic-object value in `__spread_obj_*` with that static type. Inspect the
literal's runtime-spread routing and enumeration together: merely removing
the cast must not lose copied keys or property order. No spread fix yet.

Spread follow-up implementation: a shared indexed-spread predicate selects the
existing open-object builder even when generic contextual inference lists only
the added fields. Hoisted var storage follows the same decision; inline
keys/values/entries enumerate the runtime property set. Original three tests
pass, including single evaluation, insertion order, and later-field overwrite
checks. Neighbor suites: 30 passed, 10 pre-existing skips. Adding explicit
module-level `var`/`const` annotations found that moduleGlobalWasmType also
needed the shared predicate; both failed before that storage fix. The final
focused suite passes 5/5 afterward, all validated with zero imports.
Full probe session 13014 completed with the spread/enumeration fix but
predates the final module-global storage adjustment. Do not label that probe
as verification of the later storage edit. Started 2026-09-05T20:17:14.131Z,
273,735 ms, peak RSS 3,078.6 MiB, 79,411,211 bytes: compileSuccess=true,
validates=true, standalone, zero imports, unchanged five IR fallback warnings.
Startup passes chunk 5 and reaches chunk 10. All three oracles still fail at
instantiation: `illegal cast` in `__str_to_number` (function 50, offset
2427982 / 0x250c4e), called by `__module_init_chunk_10` (function 5470,
offset 0x2cdef4a). No diagnostic binary published. No full probe remains live.
Next dump chunk 10 and the string-number helper; identify the actual value
passed to conversion and reproduce that initializer without the full graph.
Latest focused suite 5/5, typecheck, formatting, whitespace and function-budget
gate pass after the module-global storage adjustment.

Chunk-10 diagnostic session 89444 completed on the latest storage code:
244,889 ms, peak RSS 2,874.2 MiB, same 79,411,211-byte valid zero-import binary
and same failure. `.tmp/ts5-chunk10-types.txt.wat` line 23099 calls
`__str_to_number` while converting makeReverseMap's string-vector return to
the numeric `regExpFlagCharCodes` vector. The preceding call initializes
`tokenStrings` using the same generic function. Scanner source line 401:
`makeReverseMap<T>(source: Map<T, number>): T[]` captures an empty T[] in
Map.forEach and stores each key at its numeric value index. First call has
string keys, second numeric enum keys. Added a small mixed-instantiation
regression to distinguish generic array specialization from numeric parsing.
The small test reproduced the same __str_to_number illegal cast. Generic
declaration return lowering now keeps the declaration's erased array carrier
for unconstrained T[] instead of the first call's concrete array element type.
Both call orders pass, along with 91 generic identity/callback neighbors
(93/93). An added array-identity control then caught a copying regression in
the broad result rule. The final rule preserves the agreed parameter carrier
when a parameter has the exact same array type as the declared return; only
otherwise does the unconstrained T[] result use the erased declaration carrier.
Both reverse-map call orders including identity now pass (2/2). Final
typecheck, whitespace and both size gates pass. Full probe session 72670
predates this final identity refinement; do not call it a full verification of
that later edit. It completed: started 2026-09-05T20:32:06.911Z, 245,593 ms,
peak RSS 3,010.6 MiB, 79,411,533 bytes, valid standalone Wasm, zero imports,
five existing IR fallback warnings. Startup moved beyond __str_to_number and
now throws a catchable TypeError (0/3 oracles, no published diagnostic binary).
Tail trace: __call_m_call_2 -> __extern_method_call -> __closure_method_call ->
__apply_closure -> __call_fn_method_2 -> __proto_method_-1073741805_call ->
__new_TypeError. Next identify the source .call receiver and inspect reified
Function.prototype.call support. The retained 100-line tail does not establish
which source initializer/chunk owns this call. No full probe remains live.

Stored hasOwnProperty.call repro (alias and holder property) reproduces the
startup exception, with Function.prototype.call explicitly reified. The
Function glue advertised call but supplied only the generic refusal body.
Added a receiver-aware variadic body: validate callable this, split the first
argument as thisArg (undefined if omitted), forward the remaining complete
argument list to the existing apply-closure bridge. Focused verification pending.
The first emitter test caught invalid branch field names (`labelIdx` instead
of IR `depth`); corrected before any full probe. The focused hasOwn tests now
trace directly into the separate hasOwnProperty refusal body, not call's
body. An isolated ordinary-function control using stored callValue.call
passes with zero imports. Added multi-argument forwarding and non-callable
TypeError checks; neighbor verification is running. Full probe rerun started
with filtered startup trace retaining chunk and hasOwnProperty/call events.
Ordinary-function control passes all added checks. Neighbor run: 21 passed,
10 failed (31 total). Two are the separately identified hasOwnProperty refusal;
eight cannot run because their Test262 source files are absent (ENOENT), not
compiler verdicts. The 7 closure-call/apply and 10 function-expression-this
tests pass, as do three self-contained null/undefined call/apply controls.
Final typecheck passes after the branch-field correction. Full probe session
13232 is live; no new hasOwnProperty implementation yet.
The ordinary-call control also passes strict omitted-this forwarding.
Loading HEAD's array-object-proto.ts through the Vitest pre-load control
`.tmp/ts5-call-baseline.config.mts` restores its startup exception, proving
the new call body is exercised rather than a pre-existing direct-call route.
Full session 13232 completed: started 2026-09-05T20:45:02.192Z, 248,855 ms,
peak RSS 2,804.2 MiB, 79,411,815 bytes, valid standalone Wasm, zero imports,
five existing warnings, 0/3 oracles (instantiation failure), no published
artifact. Filtered trace reaches __module_init_chunk_23 (function 5551),
hasProperty (119), the now-executing Function.prototype.call body (2705), then
__proto_method_-1073741806_hasOwnProperty (1510) -> __new_TypeError (56).
Next implement the reified Object.prototype.hasOwnProperty body through the
existing native own-property predicate, preserving ToPropertyKey-before-
ToObject ordering and nullish receiver errors. Its kernel alone returns false
for null, so wiring only a raw __hasOwnProperty call would be incorrect.

Resume checkpoint: implemented the reified hasOwnProperty body in
`object-proto-has-own.ts`, wired through the prototype closure factory. It
converts the key before rejecting nullish receivers, then calls the native
own-property predicate. Expanded the stored-function regression to exercise
primitive receivers, inherited properties, throwing key conversion, and
undefined receivers. Session 23830 measured 1/3 passing: ordinary call passes;
both native modes return -5 on primitive-string own properties. The predicate's
String-exotic helper only recognized boxed strings. Extended that helper to
recognize primitive strings too, using the same string-data representation and
canonical-index checks without allocating an unobservable temporary wrapper.
Session 56731 is testing this correction; no full-parser success claimed.

Session 56731 completed 3/3 passing. Expanded again for canonical-index
rejections, boxed strings, booleans, symbol keys, undefined-valued own
properties, and undefined keys: session 24487 passed 19/19 across the new
stored-function regression and hasownproperty-call, issue-2934 function
receiver coercion, and issue-4187 delete controls. The three issue-2934 cases
assert Wasm validity only; the new regression explicitly instantiates with
zero imports and checks returned values. Typecheck, formatting, whitespace,
and both size gates passed. Full real-source standalone parser session 73211
is live with the same three required fingerprints; verdict pending.

Full session 73211 completed (started 2026-09-05T20:58:07.818Z): 311,934 ms,
2,747 MiB peak RSS, 79,445,165 bytes, valid standalone Wasm, zero imports.
Startup now completes: every failure moved from instantiate to invoking the
requested parser workload. Still 0/3 matching fingerprints. All three fail
with `dereferencing a null pointer` at createIdentifier, function 885, binary
offset 0x34d445 (3462213), called by parseMemberExpressionOrHigher (1064),
parseLeftHandSideExpressionOrHigher (1063), parseUpdateExpression (1062).
The five existing IR fallback warnings remain. Diagnostic artifact was NOT
published because the verdict failed. Final typecheck session 8424 passed.
Next: inspect emitted createIdentifier and its factory receiver in standalone;
do not assume this is identical to the earlier GC-lane createIdentifier fix
merely because the function name matches. Full units and self-hosting remain
unverified and incomplete.

Next-turn diagnostic: full session 42468 rebuilds the same graph with only
createIdentifier WAT dumped to `.tmp/ts5-create-identifier-types.txt.wat`.
The earlier Identifier constructor regression is now parameterized for GC and
standalone (raw exports and asserted zero imports in standalone), to test
whether the existing factory controls reproduce this runtime frontier.
Session 49118 passed 6/6 (3 GC + 3 standalone), including the late-assigned
Identifier constructor, namespace factory destructuring, and generic
finishNode chain. These reduced factory cases do not reproduce the full
parser failure. Formatting and whitespace checks passed for the test change.

Session 42468 completed: 281,562 ms, peak RSS 2,960.6 MiB, identical
79,445,165-byte valid zero-import module and 0/3 invoke failures at 0x34d445.
The emitted parser createIdentifier (WAT line 22510 onward) guard-casts its
factory result from Node (219) to ArrayLiteralExpression (289), then executes
ref.as_non_null before finishNode. The declared generic constraint is Node;
the first caller's sibling specialization is not a sound shared ABI.
Changed the reduced test's primeFinishNodeSpecialization input from Node to
ArrayLiteralExpression: session 25375 measured 5/6 passing, with exactly the
standalone Identifier chain now reproducing a null dereference (GC passes).
Changed resolveGenericDeclarationCallSiteTypes to use the declared constraint
parameter carrier for native constrained object T -> T contracts, and keep
the matching reference result carrier. This does not open all native structs
or change unconstrained scalar generics. Session 5145 is testing this fix and
neighboring generic identity/factory/array controls; full post-fix run pending.
Session 5145 passed 11/11 across four files, including the newly failing
standalone sibling-prime case. Full post-fix parser session 75523 is live;
typecheck session 92371 and size/whitespace gates session 70839 are pending.
Sessions 92371 and 70839 completed successfully: typecheck, formatting, both
size gates, and whitespace checks pass. Parser session 75523 remains live;
resume that handle rather than starting another build.
Continuation regression session 88186 passed 107/107 across five files:
generic asserted write-through, nested asserted identity, nullable generic
results, generic base-node factories (including negative freshness controls),
and generic callback results. Parser session 75523 remains pending.

Session 75523 completed, started 2026-09-05T21:13:05.021Z: 281,689 ms,
peak RSS 2,950.5 MiB, 79,407,334-byte valid standalone module, zero imports.
All three workloads pass the former createIdentifier trap and now fail while
invoking unescapeLeadingUnderscores (317), offset 0x2cd231 (2937393), through
parseErrorForMissingSemicolonAfter (865), parseExpressionOrLabeledStatement
(1124), parseStatement (1140), and parseList (916). Still 0/3 fingerprints.
Next diagnose the missing identifier text and why semicolon recovery is
entered; do not patch unescapeLeadingUnderscores to hide the invalid value.

Added `typescript-parser-startup-probe.ts` as a diagnostic entry, re-exporting
the three unchanged acceptance workloads and adding scanner keyword/value
and single-Identifier parsing controls. Native `node --import tsx` session
46825 measured both controls returning 1. This diagnostic entry is not a
replacement for the canonical standalone acceptance entry. The next Wasm run
executes all five oracles and dumps unescapeLeadingUnderscores,
parseErrorForMissingSemicolonAfter, and createBaseIdentifier WAT to
`.tmp/ts5-parser-text-types.txt.wat` to locate the missing text upstream.
That live diagnostic build is session 54588; poll it on resume. No new
compiler fix has been made for the missing-text failure yet.
Expanded the Identifier factory regression with TypeScript's branded
string/void-intersection union for escapedText. Session 10828 passed 6/6
(3 GC + 3 standalone); the reduced branded field round trip is not the cause.

Diagnostic session 54588 completed: 307,972 ms, peak RSS 3,153.5 MiB,
79,430,783-byte valid zero-import module, 32 source / 36 program files.
Scanner control returns -1 (first token is not ImportKeyword); Identifier
control throws a Wasm exception. The three re-exported acceptance functions
were absent from the module, so these were lookup failures, NOT three new
parser verdicts. Replaced the diagnostic re-exports with explicit forwarding
functions; the canonical fixture remains unchanged. Missing re-export
emission is a separate unresolved compiler defect, not fixed by this wrapper.
The scanner control now reports the mismatched token as -1000-token.
Added a scanner-only real-source entry to split keyword recognition from
token text and parser factory behavior. Native session 43092 returns
importToken=102, importValue=1, identifierToken=80, identifierValue=1.
The scanner-only standalone probe is running with those four exact oracles,
and dumps getIdentifierToken/scan/setText and entry functions to
`.tmp/ts5-scanner-probe-types.txt.wat`.

Scanner-only session 55605 completed: 121,593 ms, 1,592.3 MiB peak RSS,
6,049,462-byte valid standalone module, zero imports, 18 source / 22 program
files. Three of four controls pass; importToken is 80 (Identifier), not 102
(ImportKeyword), while the text "import" is correct. Native corrected-wrapper
session 38143 passes all five controls/fingerprints unchanged.
The scanner lookup uses a substring token against literal Map keys.
Added a substring-key lookup to the indexed-object regression: session 92904
fails all six cases with -5 at that lookup, including a computed-key mode.
Found __hash_anyref hashes the entire NativeString backing array with no
offset. Changed it to hash exactly len code units starting at off; equal
literal and slice strings must choose the same bucket. Focused rerun pending.
Session 26968 passed 6/6 after the hash correction. Expanded Map replacement,
size, lookup and deletion plus Set deduplication/has/delete controls:
session 19900 passed 13/13 across indexed enumeration and optional Set tests.
Canonical three-workload full parser session 27660 is live after this fix;
typecheck/format session 15192 is also live. No post-hash parser success yet.
Typecheck/format session 15192 passed. Session 18281 passed whitespace and
file-size checks but flagged four lines of intentional ensureMapHelpers
growth for the substring hash instructions. Added the function-specific
allowance here (no baseline reseed); rerun pending.
Function gate rerun 26188 passed. Canonical parser session 27660 completed,
started 2026-09-05T21:33:08.076Z: 274,645 ms, peak RSS 2,891.6 MiB,
79,407,345-byte valid standalone module, zero imports. All three calls now
throw opaque WebAssembly.Exception instead of the previous null-pointer
stack; still 0/3. Added opt-in TRACE_INVOKE diagnostics around the actual
invocation only, always disabled in finally, with startup/invocation throwing
controls to ensure failures remain rejected. No acceptance logic changed.
Trace tests session 44943 passed 2/2. Canonical invocation-trace session 50947
is live (filtered source/call-dispatch/error-constructor entries, final 80
lines). Resume this handle rather than duplicate the build. Harness-verdict
regression session 19098 is pending; whitespace check passed.
Session 19098 passed 18/18 harness-verdict tests. While invocation-trace
session 50947 continues, rerunning the admitted four-file/14-callback original
upstream slice under DOGFOOD_TARGET=standalone after the recent compiler fixes.
This is regression evidence only, not the full 256-file unit acceptance bar.
Unit session 48639 was a launcher failure: omitted `--import tsx`, so all
four compiler children failed resolving bundle-manifest.js before compilation
(14/14 native, zero Wasm callbacks executed). This is not a code regression
measurement. Correct command is `DOGFOOD_TARGET=standalone node --import tsx
--experimental-wasm-exnref tests/dogfood/typescript-upstream-suite.mjs`;
session 43008 is now running that command.
Session 43008 completed successfully: native 14/14, standalone 14/14,
four valid modules with zero imports, 6,417,424 aggregate binary bytes.
Read-back report confirms actualTargets=[standalone], no missing result files,
and counts 1+3+5+5. Still 252 files / 1,747 registrations explicitly deferred;
the full upstream unit goal is not complete.

Invocation trace session 50947 completed: started 2026-09-05T21:40:10.501Z,
323,588 ms, 2,656.6 MiB peak RSS, same 79,407,345-byte valid zero-import
module and 0/3 fingerprints. Final traced call chain (performance workload):
createExpressionStatement (3586) -> __closure_612 (2578) ->
__get_member_parenthesizeExpressionOfExpressionStatement (3947), then
__new_TypeError (56). The missing callable belongs to memoized parenthesizer
rules. Added a raw zero-import standalone case to the existing parenthesizer
identity regression to distinguish the memoized object path from later
generic callable dispatch; test run pending.
Session 12073 measured 2/3 passing: the new raw standalone parenthesizer case
throws WebAssembly.Exception; both existing GC cases pass. A fast reduced
trace/dump is now running before any compiler change for this defect.
Reduced traces 7830/41542 reproduce the same getter failure. In
`.tmp/ts5-parenthesizer-types.txt.wat`, probe's live type-169 memoize arm
executes call_ref, drops its externref result, then pushes ref.null 40
(ParenthesizerRules). The later null fallback consults the original closure
as the receiver, explaining the misleading member-get trace. Memoized body
and callback dumps show a normal stored result. Added an import-free
externref-to-instantiated-reference return bridge restricted to bindings
proven to come from a generic callable factory. Focused rerun pending.
Session 17445 passed 94/94 (3 parenthesizer, 89 callback-result, 2 generic
identity tests). Typecheck/format session 50532 passed; size/whitespace gates
80300 completed. Full canonical invocation-trace session 53327 is live after
the return bridge; no post-fix parser fingerprint result yet. Resume 53327.
Function gate session 2487 passed. Post-bridge upstream unit rerun 97877
passed native 14/14 and standalone 14/14. Report read-back confirms four
zero-import standalone modules and unchanged byte counts totaling 6,417,424;
252 files / 1,747 registrations remain deferred. Updated the stale dispatch
comment that incorrectly asserted every live arm matched the public return
ABI; this comment-only follow-up does not affect the running parser binary.
Full session 53327 completed: started 2026-09-05T21:52:17.891Z, 290,908 ms,
2,717.4 MiB peak RSS, 79,407,481-byte valid zero-import module, still 0/3.
Final trace now runs createExpressionStatement -> __closure_612 -> TypeError
without the prior __get_member lookup failure. The real null parenthesizer's
expression-statement method is the generic `identity` function, unlike the
existing reduced cast-arrow methods. Added that exact callable property and
a raw numeric probe to the regression; measurement pending.
Both pending alias/property tests already capture this failure. No live probe.

Reduced generic-property runs 86139/94881 measured 2/3 passing, with the raw
standalone statement probe throwing before identity executes. The existing
callablePropertyRefBridge admitted raw ref/externref transport only in the host
lane (except native generator results), excluding the erased identity candidate
from standalone dispatch. Removed that lane-only restriction: raw references use
import-free extern.convert_any / any.convert_extern plus the declared result
cast. Tagged AnyValue carriers remain excluded in both directions. Expanded
generic identity controls to both gc and standalone, checking zero imports in
standalone. Focused generator/property tests and typecheck are running; this is
not yet evidence of a passing full parser workload.
Focused run 92971 passed 13/13 (3 parenthesizer, 2 pre-expansion identity,
8 generator receiver controls). Expanded run 52698 passed 115/115: 4 two-lane
identity, 89 generic callback, 4 deferred property, 5 property-wrapper, and
13 boxed-string controls. Typecheck 87389 and function/LOC/whitespace gates
23518 passed. Full canonical trace run 60073 is in progress after this fix;
resume its result before claiming any new parser fingerprint count.
Post-property-bridge upstream run 38417 passed 14/14 native and 14/14
standalone. Report read-back confirms all four modules have zero imports;
252 files / 1,747 registrations remain deferred. Formatting check 93717 passed.
Full session 60073 completed: started 2026-09-05T22:04:36.791Z, 265,130 ms,
2,815.4 MiB peak RSS, 79,595,968-byte valid standalone module, zero imports,
still 0/3 fingerprints. BuilderStatePublic and PerformanceCore now fail with
`illegal cast` at parser createNodeArray (function 881, offset 0x34efb1), called
from parseBlock -> parseList -> parseSourceFile. CorePublic still throws a Wasm
exception; the tail trace does not identify its separate cause. The performance
trace now passes createExpressionStatement's memoized rules call, writes its
expression, propagates flags, finishes the node, and reaches createNodeArray.
Next: reduce/dump parser createNodeArray's argument/return carrier at this site;
do not assume the reduced NodeArray controls cover the full graph's generic
array layout. No full build remains live. No new commit or PR in this checkpoint.

Next continuation: full createNodeArray dump run 57611 started on the same
compiler state. Expanded parser wrapper to standalone; run 59943 passes 12/12.
New parser-list-array-carrier regression reproduces illegal cast at createNodeArray
in both gc and standalone (63562: 0/2), adding a generic callback-built list and
sibling Parameter/Statement element types. Reduced standalone dump 77608 is
running to locate the precise carrier mismatch before a compiler change.
Full dump 57611 completed unchanged: 264,202 ms, 2,729.2 MiB RSS,
79,595,968 bytes, valid zero-import module, 0/3. Full and reduced WAT agree:
parser createNodeArray receives vec_externref; the live factory arm directly
casts its public externref argument to vec_ref_Node. Those vector types are
siblings, not cast-compatible. Added physical vector argument snapshots at
the original evaluation point and use existing vector coercion in the selected
candidate arm instead of the erased scalar cast. No source-name special case.
Run 95005 passed 14/14 (new regression both lanes + 12 factory controls),
typecheck 46444 and function/LOC/whitespace gates 45253 passed. Added an
argument-order regression that reassigns the source list in the next argument.
Broader regression run 10878, order check 94334, and full trace run 58034 are
in progress. Full parser success remains unproven.
Run 10878 passed 95/95 (89 callback, 1 NodeArray metadata projection,
2 reverse-map, 3 parenthesizer); order check 94334 passed both lanes. Upstream
rerun 48456 remains 14/14 native and 14/14 standalone; report read-back confirms
four zero-import modules, with 252 files / 1,747 registrations still deferred.
Formatting check 39662 passed. A subsequent comment-only change clarifies that
vector snapshots apply in both lanes; it does not change the running binary.
Full 58034 completed: started 2026-09-05T22:16:18.642Z, 275,907 ms,
2,895.2 MiB peak RSS, 79,599,898-byte valid zero-import standalone module;
still 0/3 (all Wasm exceptions). Performance trace confirms the former input
cast is cleared: parser createNodeArray invokes the real factory, isNodeArray,
aggregateChildrenFlags and attachNodeArrayDebugInfo, then reaches
setTextRangePosEnd -> setTextRangePos -> TypeError. Next reduce the generic
TextRange setter on the factory-returned vector; existing reduced tests set
array.pos/end directly, so they do not cover this boundary. No full run live.

Setter continuation: replaced direct metadata writes in the list regression
with the real generic setTextRangePos/End/PosEnd shape. Run 47475 passes gc
and fails standalone (1/2). Reduced WAT shows the standalone setter already
accepts externref but casts it to TextRange before writing, nulling a vector.
Allow the existing asserted-structural identity marker for native parameters
whose ABI is already externref/ref_extern; concrete native structs retain their
current dispatch. Focused run 90628 is in progress.
Run 90628 passed 9/9 (two-lane list/range regression, original asserted-write
control, six Identifier factory controls). Typecheck 27061 passed. Expanded
the original asserted-write control to standalone with zero-import checking;
broader run 11941 and full canonical trace 38098 are running. No post-fix
full parser fingerprint count yet.
Run 11941 passed 94/94 (2 two-lane asserted writes, 89 callbacks,
3 parenthesizer controls). Function/LOC/whitespace gate 26779 and formatting
44543 passed. Upstream rerun 5969 passed 14/14 native and 14/14 standalone;
report confirms four zero-import modules, 252 files / 1,747 registrations
remain deferred. Full trace 38098 remains live.
Full 38098 completed: started 2026-09-05T22:24:29.464Z, 259,593 ms,
2,837.7 MiB peak RSS, 79,640,038-byte valid zero-import standalone module,
still 0/3. BuilderStatePublic and PerformanceCore now null-trap in
unescapeLeadingUnderscores (317, offset 0x2cd51f), called by
parseErrorForMissingSemicolonAfter -> parseExpressionOrLabeledStatement.
CorePublic remains a Wasm exception with no stack. Trace confirms native
setTextRangePos/End now call the generated pos/end member setters successfully.
Next separate incorrect scanning/parsing (why a missing-semicolon recovery path
is reached) from identifier escapedText preservation. The earlier minimal
scanner probe has not been rerun after the string-view hash fix; it is a useful
control before attributing the new null to the older Identifier ABI defect.
No full build remains live at this checkpoint.
Pragma cast continuation: started full processCommentPragmas/
processPragmasIntoFields WAT dump and canonical trace in session 89274.
Expanded the reduced pragma callback to capture and mutate its context,
matching an additional full-source feature. Run 55754 passes both lanes (2/2),
including checking that the callback write is visible on the original object.
Context capture alone therefore does not reproduce the current full illegal cast.
Run 79300 also passes four reduced pragma cases with/without the TypeScript
shared-Node allocation-view representation, in both lanes. No compiler changes
were made in this continuation. Full dump 89274 completed: started
2026-09-05T23:32:21.785Z, 306,699 ms, 2,733.4 MiB peak RSS, unchanged
79,033,650-byte valid zero-import module, same 0/3 verdict and Builder illegal
cast at processPragmasIntoFields1271 offset0x3d8bf4. The function has an
unguarded native Map108 cast immediately after __extern_get(context,"pragmas")
and before callback construction. processCommentPragmas creates Map via call1283
and writes it through call4011. Inspect those full getter/setter paths next;
the reduced shared-Node and captured-context variants both pass, so neither
feature alone explains the mismatch. Started the fuller access-helper dump
with __set_member_pragmas/__extern_get/__map_new selected.
Access-helper dump session 96397 is active; output stem
`.tmp/ts5-pragma-access-types.txt`. Resume that handle rather than restarting it.
Bare-node allocation continuation: changed only the reduced shared-Node variant
to allocate kind/pos/end first, then assign SourceFile properties, matching the
factory's allocation order. Run 71955 reproduces the illegal cast in standalone
(3/4 pass), while object-literal initialization and both GC cases pass.
The instance-expando whitelist recognizes classes/fnctors/anonymous shapes but
not source-declared named interface structs. A bare Node consequently drops
its new pragma property. Added physical-type-object provenance for non-.d.ts
interfaces and object aliases; the existing shared user-struct predicate now
admits those exact carriers for both expando storage and enumeration. A builtin
later reusing the same display name does not inherit the provenance.
Run 82335 passes all four reduced pragma variants after this change. Broader
reflection/expando/inherited-set checks and typecheck are running. Full access
dump 96397 remains the pre-fix control, not evidence for this new change.
Typecheck 37303 and function/LOC/whitespace gate 57341 passed. Broader 22424
has passed 30/30 closed-struct reflection and 12/12 instance-expando tests;
computed-write suite is 2/3 (computedWriteCtorField returns 1 instead of 11).
Control 63762 disabled the new provenance admission and reproduced that same
computed-write failure, then the candidate admission was restored.
The inherited-set suite worker exited before ready; parent session 22424 is
still alive and has not yielded a usable verdict for that suite. Do not count
it as passed or launch a duplicate blindly. Added direct named-interface and
object-alias expando/visibility controls with Map/Date internal-slot negatives.
Direct named-struct expando controls passed 2/2 in 12451. The pre-fix full
access-helper dump 96397 ended without a runtime verdict: selected __extern_get
WAT formatting exceeded the JS string-length limit (RangeError in emit/wat.ts,
548,123 ms total, 3,878.2 MiB peak RSS). This is a diagnostic serialization
failure, not evidence of a new Wasm regression. Do not repeat that giant WAT
selection. Started the post-provenance-fix canonical run without WAT dumping,
plus a fresh upstream unit run.
Post-fix full parser session is 85869 and is active. Upstream rerun 34923
completed 14/14 native and standalone, still 252 deferred files. Formatting
checks passed. Requested permission to stop only the stalled inherited-set
runner (PID9805/session22424); do not kill it without an answer and rechecking
the exact process. Its beforeAll allows 600 seconds, so it may terminate itself.
Confirmed the inherited-set worker prerequisites scripts/compiler-bundle.mjs
and scripts/runtime-bundle.mjs were absent. Built both from the current worktree
using the repository esbuild commands (compiler build 73571 succeeded; runtime
build succeeded). They are ignored generated artifacts, not source changes.
Wait for 22424 to terminate (or approved targeted shutdown) before rerunning
that suite with the prerequisites present.

Resume verification: session 22424 is terminal (exit 1): 44 passed, one
computed-write failure, and 36 inherited-set tests skipped after the 600-second
beforeAll timeout. No process was killed. Session 85869 is no longer available;
process inspection confirms no matching parser worker remains, but its final
verdict was not recovered, so it cannot support an acceptance claim. Fresh
canonical parser run 81578 saves filtered invocation output and its JSON result
to `.tmp/ts5-parser-resume-provenance.log`. Inherited-set retry 33610 is running
with both generated worker bundles now present. The full goal remains open.
Run 76581 confirms 11/13 focused controls: named structural expandos 2/2 and
sibling projections 9/11, including all four pragma variants. Both previously
recorded standalone user-Map-name negatives still fail. Inherited retry 33610
now initializes but reports 10 passed, 14 failed, 12 skipped: twelve failures
are missing `test262/harness/assert.js`, while the physical-field/side-bag test
throws and fnctor flow-slot lookup returns 6 instead of 7. Linked the existing
main checkout's harness and test directories into this worktree's empty
Test262 directory for a complete retry; no fixtures were copied or modified.
Fixture-complete retry 68103 is terminal: 13/36 pass, 23 fail. Worker-backed
rows now reach compilation but this local Node 24 runtime rejects exception
opcode 0x1f: CompilerPool replaces execArgv without preserving the exnref flag.
Run 40477 uses an ignored `.tmp/ts5-enable-wasm-exnref.cjs` V8-flag preload,
inherited through NODE_OPTIONS, to enable the same runtime feature in child
workers. This is local diagnostic setup, not an acceptance waiver or compiler
change. Direct physical-field/side-bag and fnctor flow-slot failures are still
unattributed and are not explained by this worker-flag failure.
Run 40477 completed 34/36 after enabling exnref in children: all nine authentic
Test262 acceptance rows pass, while the two direct failures above remain.
Canonical run 81578 completed in 288,467 ms, peak RSS 2,733 MiB: valid
79,487,196-byte zero-import module, still 0/3 exact fingerprints. Builder now
returns 13,383,740,112,891 rather than trapping (expected 13,386,537,220,945).
Both decode to three statements and 44 visited nodes; their 32-bit hashes are
622,018,555 versus 3,419,126,609. Thus node/statement counts match, but AST
content/ranges/flags or hashing still diverge. Core and Performance still throw
Wasm exceptions. The filtered trace only contains Builder entry through its
first isNodeArray call, despite Builder returning a numeric result; do not
interpret that truncated trace tail as the other workloads' failure location.
Strengthened the reduced generic parser-list regression with the real
hasOwnProperty-based isNodeArray predicate and small-array slice branch;
run 25660 is pending. No full parser process remains live.
Run 25660 passed 2/2; formatting and whitespace checks pass. Control 42977
temporarily disabled only the new named-struct admission line and reproduced
both direct inherited-set failures unchanged (exception and 6 versus 7), then
restored the candidate. Those failures are not attributable to this admission
change. Started full run 82201 with Core first, then Performance and Builder,
keeping all three original expected fingerprints. This tests fresh parser
state as well as capturing the early Core trace without Builder preceding it.
Output: `.tmp/ts5-parser-core-first-provenance.log`. Resume that live handle.
Added a two-lane fingerprint arithmetic control: derive the numeric mix stream
from the tracked Builder fixture using installed TypeScript 5.9.3, assert the
native 44-node/three-statement/hash oracle, then hash that exact stream inside
Wasm using the same captured mix closure and unsigned arithmetic. This
separates hashing/packing errors from a wrongly constructed AST; it does not
replace the actual parser acceptance test. Run 76667 is pending.
Run 76667 passed 2/2: native stream hashing and packing reproduce the exact
Builder oracle in both lanes. Typecheck 89093 passed. Native diagnostic checks
also reject simple global substitutions (all node flags zero/synthesized,
array positions/ends zero/-1, all trailing-comma bits false, node positions or
ends zero) as explanations for the observed hash. No single mix-value change
to an integer in [-1, 4999] transforms the native 410-value stream into the
observed hash (reverse FNV check). These are hypothesis eliminations, not
proof of AST correctness. Core-first run 82201 remains active.
Core-first run 82201 completed: 252,158 ms, 2,823.9 MiB peak RSS, identical
79,487,196-byte valid zero-import module and identical 0/3 results regardless
of invocation order. Core's trace reaches variable-declaration-list completion:
createNodeArray, setTextRangePosEnd, setContextFlag, then __new_TypeError before
factoryCreateVariableDeclarationList enters. This is the next candidate ABI
boundary, not yet a proven cause. Added a reduced parsed-list / defaulted-flags
factory test, run 12494 pending. Gates 74143 passed. No full build remains live.
Reduced factory run 12494 stopped at minimal-lib never[] semantic diagnostics;
rerun 8007 with the full probe's skipSemanticDiagnostics policy reached a
namespace object null at Parser.parse before the intended factory boundary
(both lanes). Run 79440 uses default experimental-IR routing, matching the
full compileProject probe and existing namespace controls, to avoid attributing
that earlier namespace failure to the intended array/default-parameter call.
Run 79440 now passes GC and fails standalone at runtime (1/2); this is a
small lane-specific reproduction candidate. Started a standalone-only bounded
WAT dump selecting probe, parse, createVariableDeclarationList, with output
stem `.tmp/ts5-variable-list-factory-types.txt` for the next ABI inspection.
Dump 57452 confirms the actual wrapper accepts (vec, f64) while the public
interface dispatch only includes (vec, externref) candidates. Its TypeError
terminal is reached because standalone scalarBridgePlan admits proven Boolean
unboxing but not proven Number unboxing. Added the native __unbox_number bridge
under the existing call-site Number proof, retaining rejection of arbitrary
any/Boolean/BigInt and sentinel-branded target carriers. Candidate discovery
and invocation share this same plan. Run 6791 passes 2/2 after the change.
Strengthened the omitted-argument check with a nonzero default of 4 (oracle
221) so zero padding cannot masquerade as a working initializer. Broader run
34020 and typecheck/gates are running; post-fix full Core-first parser run
saves `.tmp/ts5-parser-numeric-factory.log` with all three original oracles.
Run 34020 passed 106/106 (90 generic callback, 12 node-array factory, two
literal factory, two variable-list factory including the nonzero default).
Typecheck, formatting, function/LOC gates, and whitespace checks 41582 passed.
Full run 82508 remains active; a fresh upstream unit adapter rerun is also
running. Neither the focused success nor the previous 14 admitted unit tests
establishes the full 256-file upstream goal.
Upstream rerun 40189 passed 14/14 native and standalone. Report read-back
confirms all four entry modules have zero imports, 256 total files, 252
deferred files and 1,747 deferred registrations. NaN/infinity supplied-argument
checks added to the numeric factory regression also pass in both lanes (1688,
2/2): neither takes the nonzero default intended for omitted arguments. Full
parser 82508 remains active.
Full numeric-bridge run 82508 completed in 312,201 ms, 3,073.4 MiB peak RSS:
valid 79,493,304-byte zero-import module, still 0/3 exact fingerprints. Core
now returns 40,099,680,121,158 (expected 40,098,163,538,143), clearing its
factory-call TypeError. Builder remains 13,383,740,112,891; Performance still
throws. Added diagnostic-only `typescript-parser-builder-fields.ts` to compare
separate hashes for node kinds/positions/ends/flags, array metadata/trailing
commas, and texts. Native evaluation uses installed TypeScript 5.9.3 and verifies
the embedded source equals the tracked canonical Builder input. Its seven
expected hashes are 356767627, 3958391185, 3952552808, 2614092085, 826173832,
953171930, 1233566727 respectively. Field diagnostic run saves
`.tmp/ts5-parser-builder-fields.log`; the original three full-AST oracles are
unchanged and remain the acceptance requirements.
Core's post-fix packed results both decode to nine statements and 120 nodes;
only the hash differs (1865445702 versus 348862687). Diagnostic session is
81072; resume that handle. No canonical parser run remains live.
While the field diagnostic runs, extended the existing NodeArray vec-projection
test from GC-only to both lanes. Standalone checks raw numeric exports for
direct, widened, and callback metadata reads plus zero imports; the host
mirror/host dispatcher checks remain GC-only because those APIs are not part
of the standalone contract. Run 88710 is pending.
Run 88710 passes GC but fails standalone: sourceMetadata returns 171591,
while widening the array makes test() return NaN. This isolates a real
metadata-loss path. emitVecToVecBody in type-coercion.ts copies ordinary
property sidecars only in host-backed mode; standalone's vec-props identity
table has no projection transfer hook. Before implementing one, preserve the
table's shared bag semantics and audit prototype/descriptor consumers rather
than copying only pos/end keys. The full field diagnostic remains active.
Field diagnostic 81072 completed: 254,058 ms, 2,747.4 MiB peak RSS, valid
79,489,179-byte zero-import module. Five of seven hashes match exactly: node
kinds, positions, ends, flags, and texts. Array metadata is 4096183195 instead
of 826173832; trailing-comma bits are 2138539933 instead of 953171930.
Implemented native projection-to-source identity registration for typed vec
conversions, with flattened aliases. Bag lookup/ensure and all prototype
read/write helpers canonicalize their lookup key; ordinary getters retain
their original receiver. This shares existing and future property state rather
than copying pos/end or taking a prototype snapshot. The identity registry
is append-only and used only for fresh physical projections; it does not
claim to fix indexed-element mutation aliasing or separate numeric overlays.
Run 90088 passes the reduced metadata test 2/2. Added shared-property write,
deletion, and bidirectional prototype-update controls; run 46258 and gates
22186 are pending. No full parser process remains live.
Run 46258: 3/4 pass. Both parser-list cases and the standalone projection
case pass, including shared writes, deletion and bidirectional prototype
changes. The strengthened GC projection case returns -2 on shared deletion;
the host sidecar path was not changed, but no dedicated removal-control run
has yet attributed that new assertion failure. Keep it visible, not waived.
Full parser run 17668 is active with Performance first and all three original
oracles, saving `.tmp/ts5-parser-vec-identity.log`. Broader vec-prototype and
instance-expando checks are running in 85065; gates 22186 remain active.
Run 85065 passed 16/16 (four prototype-storage, twelve instance-expando).
Typecheck and function/LOC gates 22186 passed. Full parser 17668 remains live.
Added an erased-metadata control to the projection test: makeDerived passes
through unknown and fingerprintFromExtern before its fields are read. This
checks the separate externref materialization path, which still transfers
sidecars only in host mode. Run 7141 is pending. If extending alias transfer
there, guard the source as a real vec first; non-array inputs materialize a
new array and must not inherit the input object's identity.
Run 7141 passes standalone, including the erased-metadata control. This
input does not demonstrate a remaining materializer defect, so no additional
source change was made to that path. Full parser 17668 remains active.
Post-identity upstream rerun 85405 passed 14/14 native and standalone, with
252 files still deferred. Formatting and whitespace check 61935 passed. Full
parser 17668 was revalidated live with active CPU use; wait on that handle,
not a duplicate build.
Full run 17668 completed: 290,566 ms, 2,740.4 MiB peak RSS, valid
79,497,551-byte zero-import module, still 0/3. Builder is unchanged at
13383740112891; Core changed to 40100245097399 but remains wrong; Performance
still throws. Its complete first trace reaches parseTokenNode/createToken,
then createNodeArray and setTextRangePosEnd, then TypeError (trace lines
6165–6194). The typed projection metadata fix alone is insufficient.
Added a dynamic assignment into a typed NodeArray property to exercise the
separate field-setter materializer; standalone run 10616 is pending. No full
parser build remains live.
Run 10616 passes standalone; the reduced typed-property assignment does not
reproduce the full remaining metadata loss. Native Builder has six visited
arrays. Its observed trailing-comma hash equals all six bits being false
(2138539933), losing the import-specifier list's sole true bit. Continue with
the full conversion/metadata evidence rather than assuming the reduced
assignment test covers that production path.
Native hash reconstruction reproduces the observed array-metadata hash exactly
when only the import-specifier and two modifier arrays have pos/end reset to
-1 (rows [8,53,2], [84,94,1], [220,230,1]); their other counts remain intact.
This suggests repeated factory reconstruction, not generic zero/undefined
reads, and remains an inference pending direct production verification.
Extended identity transfer to both remaining native externref-to-vec
materialization paths, matching the existing host sidecar transfer sites.
The alias helper now explicitly rejects non-vec sources before registration;
array-like non-array materialization cannot inherit the input's identity.
Helper indices are read after late-import flushing. Regression run 27909
is pending; no full build is active yet.
Run 27909: 15/16 pass; only the previously observed GC shared-deletion
assertion fails at -2. All standalone projection checks and the parser-list /
node-array factory regressions pass. Typecheck/gates 61262 and a full
Performance-first parser rerun are active. Full output saves
`.tmp/ts5-parser-all-vec-identity.log`; all three original oracles are retained.
Typecheck, function/LOC gates, and whitespace check 61262 passed. Full parser
session is 72044; resume it rather than starting another build.
Broader run 92997 is 8/9: nullable vecs, contextual factory, typed-array
expando, and prototype tests pass. Optional vec-factory preregistration's
host default run(0) returns 7 rather than 17; this failure is recorded but
not yet attributed by removal control. Upstream 17343 still passes 14/14
native and standalone with 252 deferred files.
Performance's preceding trace identifies parseUnionOrIntersectionType calling
its createTypeNode callback immediately after createNodeArray. Extended the
existing union-carrier test to exercise union/intersection callback paths in
standalone with raw exports/zero imports, not only its prior direct concrete
factory controls. Run 94838 is pending. Full 72044 remains active.
Run 94838 passes GC and fails the expanded standalone callback case (1/2).
Started a standalone-only bounded WAT dump of parseUnionOrIntersectionType,
createUnionTypeNode and createIntersectionTypeNode; output stem
`.tmp/ts5-union-callback-types.txt`. This is a reduced candidate for the
remaining Performance failure, not yet a verified root-cause attribution.
Full all-materializer run 72044 completed: 275,775 ms, 2,466.1 MiB peak RSS,
valid 79,509,039-byte zero-import module. Builder and Core now match their
original exact fingerprints: 2/3. Performance still throws. This validates
the missing native materializer identity transfer, without claiming full goal
completion.
Union callback dump 48798 omitted live concrete-return funcrefs from its
externref-result dispatch. Added lossless native reference export under the
existing declaration-proven factory-callback admission (excluding AnyValue).
Run 60799 still fails the full reduced factory, but dump 6040 confirms the
two real wrapper arms are now present. Added separate callback controls using
the already-working concrete constructors to distinguish dispatch from the
reduced generic union constructor's own narrowing failure. No full parser
build remains active; the reference-export candidate is not fully validated.
Concrete-constructor callback controls 91262 pass 2/2, checking both union
and intersection returns in each lane. The complete reduced generic-union
constructor failure remains visible. Started full Performance-first rerun
with all original oracles, saving `.tmp/ts5-parser-union-callback.log`, plus
broader callback/factory regressions. Typecheck/gates 64153 are pending.

Literal-factory continuation: added a two-lane regression matching
factoryCreateStringLiteral(text, undefined, hasExtendedUnicodeEscape()).
Run 44210 fails both lanes with Wasm exceptions (0/2). It explicitly checks
that the middle argument remains undefined while the later flag is true.
Reduced dump 67395 and full literal-factory dump 96208 are active; no new
compiler change yet for this defect.
Reduced WAT confirms createStringLiteral's implementation takes string/i32/i32,
while its public optional slots are externref. Explicit undefined in the middle
cannot be represented by an argument-count-only protocol, and candidate
discovery rejects it. Added a shared optional declaration scalar ABI helper,
used by both nested declaration phases and function-declaration closure wrapper
signature derivation. Optional booleans without initializers now retain
externref, like optional numeric declaration parameters; explicit native
annotations remain unchanged. Focused run 4287 and typecheck are running.
Run 4287 clears the exception but fails the undefined-field assertion in both
lanes (-1), with 12/12 factory neighbors passing. The second defect is declared
nullable boolean fields using i32, erasing undefined on assignment. Updated
their declared field carrier to externref; run 30261 passes 17/17 (2 literal,
12 factory, 3 parenthesizer). Added false-vs-undefined and omitted-tail controls.
The earlier full pre-fix dump 96208 completed: 308,622 ms, 3,271.5 MiB
peak RSS, 79,655,021-byte valid zero-import module, still 0/3 Wasm exceptions.
Expanded controls and callback/Identifier neighbors passed 98/98 in run 78383.
Both pending typechecks (78590 and 2315) completed successfully. Function/LOC
and whitespace checks 57286 passed without new allowances; formatting passed.
Post-fix canonical full parser invocation trace 12608 and upstream unit rerun
23498 are active. The post-fix full parser verdict is not yet known.
Upstream 23498 completed 14/14 in both lanes; report read-back still shows
252 deferred files / 1,747 registrations. Broader run 62405 passed 31/37:
one old scalar-ABI assertion, four descriptor tests in issue-2984, and the
standalone live-closure arity-cap control in issue-1058-barrel-computed-option-capture.
The arity control reproduced solo (91920); descriptor failures reproduced in
58019. Attribution to the current optional-boolean changes remains unproven.
Replacing the scalar-ABI assertion with the new shared ABI plus an actual
runtime check exposed a shadowed `undefined` equality defect (0 instead of 2).
The binary nullish shortcut recognized only the spelling, not the operand type.
It now requires the undefined type before using that shortcut; run 91030 checks
the shadowed parameter and literal-factory controls. Full 12608 began before
this separate equality change and must be labeled accordingly.
Full 12608 completed: started 2026-09-05T23:06:54.481Z, 362,612 ms,
2,823.4 MiB peak RSS, 79,233,535-byte valid zero-import module, still 0/3.
BuilderStatePublic now null-traps in parseSourceFile (806, offset 0x33dc72);
CorePublic and PerformanceCore remain Wasm exceptions. The last trace tail
ends in a TypeError after vec-property writes; its enclosing source caller
is not retained in this short tail. No full build remains live.
The shadowed-undefined runtime also required fixing the direct identifier
read in expressions.ts; equality-only run 91030 exposed the second spelling
shortcut (and a WAT regex that did not allow a named type). After both fixes,
25008 passed 7/7. The runtime control is now expanded to both lanes.
Control 33516 removed only the nullable-boolean-field change and reproduced
the same five descriptor/arity failures (19/24); that field change alone
does not explain those failures. A second control disables optional boolean
parameter widening as well before restoring both candidate changes.
Control 97843 disabled both optional-boolean changes and reproduced the same
five failures (19/24). Both candidate changes were then restored. Final focused
run 37303 passed 23/23: six optional-parameter checks (including both lanes for
the shadowed binding), two literal-factory, eight nullable primitive, and seven
loose-equality checks. Function/LOC/format/whitespace gate 8156 passed.
The old routing WAT suggests the next parseSourceFile null is a SourceFile
shape conversion (219 to 379) before metadata setters, but that is historical
evidence, not yet a confirmed cause in the current binary. Started a fresh
canonical dump of parseSourceFile/createSourceFile/createSourceFileWorker to
verify the current shape and caller. The trace filter now requires an
alphabetic first character after the function-name opening quote; the old
negated-underscore pattern also matched a closing quote and retained helper
noise instead of useful callers.
Fresh full dump/invocation run is session 45982, writing
`.tmp/ts5-sourcefile-post-literal-types.txt.wat`; it is still active.
Typecheck 65683 completed successfully.
Pragma identity continuation: historical WAT type 379 is PragmaContext,
not SourceFile. The parser deliberately passes `sourceFile as {} as
PragmaContext` to processCommentPragmas/processPragmasIntoFields. Added a
two-lane regression that writes a new referencedFiles array and boolean
through such a call, then reads the original object's fields and marker.
Run 22113 passed GC but returned NaN rather than 725 in standalone (3/4 total).
The existing double-assertion identity proof was disabled by a blanket
concrete-native parameter bail. Moved that restriction to the generic
asserted-write case only, so proven double-asserted mutable call parameters
use identity-preserving externref in both lanes. Full diagnostic 45982 began
before this change and remains the pre-fix control.
Pragma identity fix run 36572 passed 12/12 (four asserted-write, two parser
list, six Identifier tests). Typecheck 2506 and function/LOC/whitespace gate
2961 passed. Expanded the existing sibling-projection regression to both lanes
for Map-backed pragma writes and a cross-module ordinary caller. Run 60958
passed 97/98 (90 generic callback, one nested identity, six sibling checks),
with the new standalone Map-backed pragma case throwing; cross-module identity
passed both lanes. Reduced dump 35450 confirms the receiver is still cast to
the nominal PragmaMap interface even though new Map produces the native Map
struct. Testing native resolveWasmType inheritance recognition in 62930.
Full pre-pragma-fix dump 45982 completed: started 2026-09-05T23:16:08.165Z,
338,847 ms, 2,431.3 MiB peak RSS, 79,233,535 bytes, valid and zero imports,
still 0/3. Builder null remains parseSourceFile806 offset0x33dc72. Current WAT
confirms the PragmaContext379 guarded cast immediately before call1270.
No full build remains live; the Map-backed regression is the next local check.
Native carrier-only run 62930 still failed validation; diagnostic 62575 shows
processPragmasIntoFields constructing a five-field Map with a two-field vector
sequence. The unresolved refined-interface method was falling through to array
forEach lowering. Enabled the existing ambient-Map inheritance proof for method
and property dispatch in native mode too, while keeping host carrier resolution
externref and native resolution on the existing Map type. Real subclasses and
user-defined Map names remain excluded by the inheritance proof.
Run 18049 passes all seven sibling-projection checks, including the standalone
Map-backed pragma case. Canonical post-fix parser trace 32058, broader Map run
2769, and typecheck 5883 are active. No post-fix full fingerprint verdict yet.
Broader Map run 2769 passed 28/29 executable tests: seven sibling-projection,
six native Map.forEach, and 15/16 mapIterator. The known array-mutation-between-
suspensions test still returns -2 instead of 1. tests/map-set-basic.test.ts
did not collect because its ../../src/runtime.js import does not resolve from
tests/; this is not a passing control. Function/LOC/whitespace gate 60114 and
format checks passed. Upstream 75045 passed 14/14 native and 14/14 standalone;
252 files remain deferred. Full parser run 32058 is still active.
Typecheck 5883 completed successfully.
Expanded the user-class/interface Map-name controls to standalone and added
runtime checks (88 and 5), rather than accepting validation alone. Run 8729
passed 7/9; both new standalone name-shadow controls fail (class: invalid Wasm;
interface: module-init struct.new underflow by four). Control 68162 disabled
both native Map-inheritance carrier/dispatch changes and reproduced the same
two failures. Restored the candidate changes afterwards. These newly exposed
failures are retained as failing coverage, not waived or claimed fixed.
Upstream report read-back confirms all four artifacts remain zero-import,
6,424,494 bytes total, 14/14 passing with 252 files / 1,747 registrations deferred.
Full post-fix 32058 completed: started 2026-09-05T23:26:27.604Z,
313,770 ms, 3,132.8 MiB peak RSS, 79,033,650-byte valid zero-import module,
still 0/3. BuilderStatePublic clears the PragmaContext call-boundary null and
now illegal-casts inside processPragmasIntoFields (1271, offset0x3d8bf4),
called from parseSourceFile806 offset0x33db05. CorePublic and PerformanceCore
remain Wasm exceptions. Next dump processPragmasIntoFields and its concrete
Map/array/callback operands; the reduced Map-backed case now passes, so its
shape must be compared against the full source rather than assumed identical.
No full build remains live at this checkpoint.

Scanner/identifier continuation: expanded the minimal scanner fixture with an
eight-token import sequence control (including EOF). Native run 74569 matches
all five expected values (102, 1, 80, 1, 1); standalone run 29752 is active.
Added a minimal import-declaration AST control beside the existing identifier
and scanner controls in the full-graph diagnostic fixture; this does not
replace the three canonical real-source workload oracles.
Standalone scanner run 29752 passed 5/5: started 2026-09-05T22:30:51.273Z,
107,461 ms, 1,231.2 MiB RSS, 6,070,644-byte valid zero-import module.
This directly verifies the earlier keyword hash fix in the scanner-only graph,
including import/from classification and EOF sequencing. Full-graph native
controls 53612 pass all six expected values; standalone diagnostic run 80272
is active (three small controls plus all three original workload wrappers).
Reduced Identifier constructor run 5410 passes 6/6 after adding the real
factory's optional token-kind and Unicode-escape arguments. Now matching its
inferred createBaseIdentifier return (instead of an explicit Identifier
annotation) as another control while the full diagnostic graph compiles.
Inferred-return run 17771 passes 6/6; adding actual Map<string,string>
internIdentifier and a substring input also passes 6/6 (72005). Typecheck
67875 passed before the final interning-only fixture extension.
Full diagnostic 80272 completed: started 2026-09-05T22:32:32.818Z,
263,853 ms, 3,155.1 MiB RSS, 79,664,794-byte valid zero-import module,
1/6 invocations passing. The full-graph scanner control passes. `x;` parsing
null-traps in parseSourceFile (806, offset 0x33df57); minimal import and
BuilderStatePublic/PerformanceCore null-trap in unescapeLeadingUnderscores
(317, 0x2cd765) from missing-semicolon recovery; CorePublic throws a Wasm
exception. All original 3 fingerprints still fail. Scanner success in this
same graph rejects the simple keyword-map hypothesis. Next trace parser
lookahead/current-token routing for the minimal import and dump parseSourceFile
for the separate post-list null. No build remains live.

Routing continuation: full diagnostic trace/dump 99253 is running, selecting
parseSourceFile, isDeclaration/isStartOfDeclaration, token/nextTokenWithoutCheck,
and both speculation helpers. Inspection found the stateful scalar/TypeNode
callback regression used only target gc. Added a standalone variant with
zero-import verification; focused run 13290 is active before any new fix.
Focused run 13290 passes both lanes (2/2, 88 unrelated cases filtered out).
Whole generic-callback file run 23307 passes 90/90. The added native case
therefore does not reproduce the real parser failure; do not attribute the
failure to generic lookahead transport without the full trace/dump evidence.
Full run 99253 completed 0/2, same diagnostic binary 79,664,794 bytes,
302,210 ms, 3,635.7 MiB RSS. WAT at `.tmp/ts5-parser-routing-types.txt.wat`
shows parser lookAhead calls speculationHelper then returns i32.const 0;
speculationHelper has a void own result ABI. The generic callback proof is
not active for this full graph, letting the first void invocation freeze its
shared result. Real scanner installs a debug getter, whereas the passing
stateful reduced fixture installed a data value; changed that control to a
getter to test the fallback path before changing lowering.
Getter-only control 85044 passes both lanes, so that hypothesis alone was
rejected. Adding a globalThis reference to invalidate global builtin stability
exposes dropped node results in gc (50037); a first void instantiation makes
its later scalar result zero (15856). Standalone reduced control still passes,
but the real standalone dump directly demonstrates the same void result ABI.
Changed the unconstrained generic result fallback to externref when no earlier
identity/factory/array carrier applies; this preserves a shared T result even
without callback provenance. The conservative semantic detector is unchanged.
Focused regression run 51452 and typecheck are running.
Run 51452 passed 96/96 (90 callback/detector, 4 identity, 2 reverse-map).
Typecheck 90032 passed. Canonical full invocation trace 59790 is running after
the fallback fix; no post-fix full fingerprint verdict yet.
Function/LOC/whitespace gate 64235 and formatting 54972 passed. Upstream
rerun 58385 passed 14/14 native and 14/14 standalone; report read-back confirms
all four modules have zero imports. Still 252 files / 1,747 registrations
deferred. Full 59790 remains live.
Full 59790 completed: started 2026-09-05T22:49:41.200Z, 241,148 ms,
4,261.2 MiB peak RSS, 79,655,021-byte valid zero-import standalone module,
still 0/3 (all Wasm exceptions). Performance trace now reaches parseExpected,
scans the quoted module path, enters parseModuleSpecifier -> parseLiteralNode
-> parseLiteralLikeNode, then TypeError after getTokenValue/Unicode-escape
scanner calls. The prior import-as-expression/missing-semicolon null is cleared
on this trace. Next inspect the string-literal factory callable's argument ABI.
The separate simple `x;` post-list null has not been rerun after this change.
No full build remains live at this checkpoint.

The module plan remains capability-based: parser, binder, checker, and
printer/emitter are separate public roots. A runtime module that is neither
reachable from the selected runtime entry nor re-exported may be removed only
when its top-level evaluation is proven unobservable. A linked but otherwise
unused module remains rooted when import evaluation, an observable initializer,
or module evaluation order can affect behavior; side-effect imports therefore
remain roots. Post-lowering DCE starts from public exports,
module/start initialization, host callbacks, and genuine `ref.func`, table, or
dynamic-registry targets, then removes unreachable functions, globals, types,
data, and table entries before identical-body folding. The checker oracle after
the binder slice must be `const x: number = "str"` producing TS2322; `1 +
"str"` is valid TypeScript and is not a checker-negative control. Printer
equivalence should be a separate `createPrinter().printFile` slice before full
emit and self-hosting.

### Resume: Performance executes but its AST still differs

Full standalone run 19103 is terminal: 303982 ms, 79,578,110 bytes,
valid Wasm with zero imports. Builder and Core retain their exact fingerprints
(2/3 total). Performance now returns 49594410090848 instead of
49645738923599; clearing the exception is not a passing parser result.
The authoritative output is `.tmp/ts5-parser-union-callback.log`.
Callback/factory regression run 5895 passed 94/94. Gate handle 64153 is
no longer available, so its final verdict is not claimed.

Next diagnostic: partition Performance's AST into independently hashed node
kinds, positions, ends, flags, array metadata, trailing commas, and text using
`typescript-parser-performance-fields.ts`. Keep canonical acceptance unchanged;
native TypeScript supplies the diagnostic expectations, not the candidate.
The full 256-file unit-suite and self-hosting scope remains unfinished.

Native reconstruction now reproduces Performance's **exact** wrong packed
fingerprint by omitting its three UnionType subtrees. Native has 295 nodes and
11 statements; standalone has 283 nodes and 11 statements. Each union subtree
contains four nodes, at source positions 827, 1985, and 2992. Running the
unchanged canonical fingerprint with only those child callbacks suppressed
returns 49594410090848, exactly the candidate's result (normal native:
49645738923599). This is a focused attribution, not an acceptance workaround.

Reduced union test run 77145 is 3/4: both concrete-constructor callback lanes
and the host production-shaped factory pass; standalone generic union
construction fails. WAT `.tmp/ts5-union-construction-types.txt.wat` shows
createUnionOrIntersectionTypeNode retaining a base Node (heap type 38), storing
`types` through the open-property setter, and returning it as externref.
createUnionTypeNode then tests for the physical UnionTypeNode (heap type 40)
and replaces a failed test with null. The next implementation must preserve
the original object's identity and fields across this assertion; merely
copying fields into a new record would leave alias/mutation semantics broken.
The full diagnostic seven-field build 82742 completed in 262069 ms with a
valid 79,581,577-byte zero-import module, peak RSS 2862.1 MiB. All seven
field hashes differ from complete native TypeScript (0/7), and all seven
exactly match native TypeScript with only the three union subtrees omitted:
nodeKinds 1190267654, nodePositions 3306985177, nodeEnds 1648673728,
nodeFlags 3603851679, arrayMetadata 1555702382, trailingCommas 325998914,
texts 502775548. This independently corroborates the missing-union diagnosis;
none of those altered-native values replace acceptance expectations.
Output: `.tmp/ts5-parser-performance-fields.log`. No diagnostic parser run
remains live. Typecheck, fixture/test formatting, and whitespace checks 83075
all passed. Next: repair the generic union constructor's identity-preserving
carrier/narrowing behavior, then rerun the reduced union test and all three
original standalone parser fingerprints before expanding the upstream units.

### Native union allocation-view candidate

The existing proven shared-Node allocation-view registration already handles
UnionTypeNode and IntersectionTypeNode in the host lane, but explicitly excludes
standalone/WASI. Removed only that target restriction: the exact source contract,
single TypeNode base, and proven merged TypeNode-to-Node alias checks remain.
This keeps union nodes on their actual base allocation and uses the existing
native ordinary-property sidecar for `types`, instead of copying a new struct.
Reduced factory and alias/mutation tests plus full parser acceptance must verify
this candidate before claiming the third parser workload passes.

Initial reduced run 24442 passes 4/4. Expanded run 97887 passes 40/42,
including all 6 union tests with shared-reference equality, sidecar writes in
both directions, and base-field writes in both lanes. The two failures are
GC/Node literal diamond/Shared LiteralLikeNode tests in the generic-base-node
suite; neither fixture declares UnionTypeNode or IntersectionTypeNode, and
the host allocation-view predicate is unchanged by this candidate. They remain
visible unresolved failures, not waived acceptance. Token specialization,
property-access chain, shape DAG and NodeArray factory checks pass.
Typecheck, function/LOC gates and whitespace run 51098 passed. Upstream run
86846 remains 14/14 native and standalone, with 252 deferred files.
Full parser run 46082 is live with all three original expectations, output
`.tmp/ts5-parser-native-union-carrier.log`; poll the same handle.

Run 46082 completed successfully: **3/3 original standalone parser
fingerprints pass**, valid 79,155,162-byte Wasm, zero imports, 258041 ms total,
3094.6 MiB peak RSS. Performance 49645738923599, Builder 13386537220945,
Core 40098163538143 all match exactly. The five reported diagnostics are
IR-selection warnings, not compilation errors. No oracle or upstream source
was changed. The target-independent shared allocation view fixes the missing
union nodes without introducing copied-object aliasing.
Expanded union/intersection alias tests 83987 pass 6/6, and generic callback
regressions 27521 pass 90/90. Native TypeScript revalidated binder smoke
expectations from the committed fixtures: const-local 65792, duplicate-let
131330. Continue with the standalone binder entry, then broaden original
unit coverage; parser acceptance is not full TypeScript/unit-suite completion.
Standalone binder run 66820 is active, with both original smoke expectations
and zero-import enforcement; output `.tmp/ts5-binder-native-union-carrier.log`.
Resume this handle rather than launching another binder build.

### Broaden original upstream unit coverage after parser acceptance

Added the complete original `compilerCore.ts` unit file (11 registrations),
raising the adapter's required floor from 4 files/14 tests to 5 files/25 tests.
The exact release-source projection now includes arrayFrom, equalOwnProperties,
createSet and their original helper implementations. Test bodies/assertions are
unchanged. This exposes custom-set mutation, iteration, collision and object
equality behavior, not a hand-written substitute. Updated verdict canaries and
bumped the report oracle version to 3. The expanded run must report failures
honestly; selection is not a passing claim, and 251 files remain deferred.
Initial expanded run 62869 is active; binder run 66820 is still active.

Binder 66820 completed: compile succeeds, 88,206,186-byte module validates,
268063 ms total, 2990.4 MiB peak RSS. It still imports `env.WeakMap_get`,
so the zero-import gate correctly rejects both smoke invocations before
instantiation (0/2, no runtime result). Next binder repair is the native
WeakMap method routing, not changing import enforcement or adding a host shim.

Initial expanded unit run 62869 completed with 25 registered tests but only
15 native passes: 10 compilerCore tests exposed missing isTrue/isFalse in the
assertion adapter. Added exact-boolean assertion helpers and positive/negative
canaries (truthy/falsy substitutes must fail). Also split the exact core source
projection into its own module: importing its generator definitions into every
utility module introduced four host generator imports in otherwise independent
tests. CompilerCore retains its entire implementation, including generators;
those imports must be fixed, not hidden. Rerun 36448 is active, with unchanged
25-test/5-file gate and explicit 251-file deferral.

Run 36448 completed: **25/25 native, 14/25 standalone**. All original four
modules retain their zero-import passes. CompilerCore registers and passes all
11 original callbacks natively, but its compiled module is rejected for four
host generator imports: `__gen_create_buffer`, `__gen_push_ref`,
`__gen_yield_star`, `__create_generator`. The strict gate returns failure,
as required; none of the 11 newly exposed tests is silently deferred.
Report: `tests/dogfood/report/typescript-upstream-suite.json` (oracle version 3).
Harness/verdict/worker controls 28801 pass 24/24; typecheck and whitespace
22334 pass. No binder or upstream adapter run remains live at this checkpoint.

Next frontiers: (1) binder's single WeakMap_get import, with actual native
WeakMap semantics rather than a host shim; (2) the original core createSet's
nested getElementIterator/yield-star and generator entries method, which still
select host generator helpers. Preserve the 3/3 parser fingerprints and the
now-expanded 25-test denominator during these repairs.

### Binder WeakMap import investigation

Added captured WeakMap/getter and module-global cache controls. Run 25188
passes 2/2 in GC and standalone, checking object-key identity, cached strings,
and zero imports in the native lane. The reduced valid case does not reproduce
the binder's import. A full binder diagnostic now logs only native WeakMap/
WeakSet calls declined by the native emitter (`JS2WASM_TRACE_WEAK_DISPATCH`).
The temporary trace must be removed after locating the real fallback; no host
shim or import-gate relaxation is permitted.
Full diagnostic run is 76102, log `.tmp/ts5-binder-weak-dispatch.log`; it is
still live. Resume its handle. The source diagnostic in expressions/extern.ts
is temporary and must be removed after the observation.

Generator investigation correction: the early nested-declaration comment and
no-capture registration are not the complete implementation. The later
capturing branch (nested-declarations.ts around 2094) already passes captured
cells/TDZ flags into registerNativeGenerator, and resume restores them. Do not
implement duplicate capture machinery or claim capture alone is the root cause.
The host-import pre-scan still checks generatorCapturesOuterScope; determine
the actual rejected plan/emitter for the original core generators before
changing that admission or its imports.

Direct compilerCore diagnostic 58907 locates the actual rejection:
buildNativeGeneratorPlan -> lowerForOf -> lowerIf -> emitYield rejects
`yield* value` because its unwind chain contains the implicit IteratorClose
finally region from the enclosing for-of. Both the import pre-scan and real
nested-function registration hit that same rejection. The original nested
getElementIterator is the rejected generator; captures alone are not the
cause. Removed the temporary generator trace after collecting this stack.
Fix requires yield-star abrupt-mode forwarding through state-lowered unwind
regions, including inner completion/throw/return and outer IteratorClose; do
not merely remove the admission guard to pass normal-iteration tests.

Binder trace 76102 completed byte-identically (88,206,186 bytes; same lone
WeakMap_get import), with no direct native WeakMap-method fallback logged.
Removed that temporary trace and moved it to registry/imports.ts addImport
for WeakMap_get only. New full trace run 35445 is active; log
`.tmp/ts5-binder-weak-import-producer.log`. Remove this temporary registry
trace once its producer stack is known.

Run 35445 completed with the WeakMap_get registration stack in the extern
property-call pre-scan (registry/imports.ts visit/register). Removed the
temporary registry trace. TypeScript factory/nodeChildren.ts uses the exact
nested lookup `sourceFileToNodeChildren.get(sourceFile)?.get(node)`, and the
optional-call emitter had native Set.has/delete only before its extern path.
Extended the saved-receiver native helper to Map/ReadonlyMap/WeakMap get,
has/delete plus WeakSet has/delete, with declaration-file provenance to avoid
hijacking user classes sharing builtin names. get preserves its anyref payload
as externref; short-circuiting still returns canonical undefined.

Expanded regression 55154 reproduces an invalid standalone optional get
(externref import called with anyref receiver). Its GC lane separately returns
-2 at the missing-receiver key-evaluation check, retained as a visible failure.
Candidate test run checks the nested lookup, missing receiver key suppression,
array identity, has/delete booleans, and existing optional Set behavior.

Run 88617: all 7 existing optional Set checks pass. The expanded WeakMap
module now validates with zero imports in standalone, clearing its prior
externref/anyref call mismatch, but both lanes fail the local keyCalls control.
Diagnostic 79542 returns NaN for `-200 - keyCalls`: this is not evidence of an
extra key invocation. Preserve the captured numeric-counter failure and add
an independent object-state counter control (run 60802 pending) to test lookup
semantics without conflating the capture representation defect.
Full binder candidate run 99624 is active with the two unchanged smoke
oracles; output `.tmp/ts5-binder-optional-weakmap.log`. Typecheck/gates 47670
are also pending. All temporary WeakMap/generator tracing edits were removed.

### Resumed verification: optional collection runtime boundary

Recovered terminal binder run 99624: compile succeeds, 88,206,870-byte Wasm
validates with **zero imports**, but **0/2** unchanged binder invocations pass:
both throw a WebAssembly.Exception during invocation. Total 285514 ms,
peak 3161.6 MiB. This clears the host-import blocker, not binder acceptance.
Invocation-only trace run 18350 is investigating the exception, with output in
`.tmp/ts5-binder-optional-weakmap-invoke-trace.log`.

Missing handles 60802/47670 did not preserve a recoverable verdict. Fresh
WeakMap run 32626 established that the standalone object-backed counter
control passes while the numeric captured counter returns NaN. Split all three
exports into independent tests, keeping every failing assertion. Run 61014:
**10/13 pass** across WeakMap and optional Set tests; all seven Set tests pass,
ordinary captured WeakMap getter passes in both lanes, object-backed optional
WeakMap lookup passes standalone but traps with illegal cast in GC, and the
numeric-counter optional lookup fails with NaN in both lanes.

The existing `emitEagerCaptureBoxes` explicitly skips TDZ (`let`/`const`)
captures and documents conditional-call lazy boxing as residual follow-up.
This is a concrete lead for the numeric counter, not yet an attributed fix.
Do not weaken the counter assertion or substitute the object-backed control
for its semantics. Full upstream scope remains 256 files.

Reduced regression `tests/issue-1058-conditional-let-capture.test.ts` removes
collections and optional chaining entirely. Run 3799: **2/4 pass**; both `var`
controls pass, both `let` variants return NaN only when the capturing call is
skipped. The taken-call assertion passes for every variant. This isolates a
lexical-capture initialization defect independently of the new native lookup
helper. Fresh run 42250 passes TypeScript no-emit checking, function/LOC gates,
and whitespace checks; both new/updated regression files pass Prettier.

### Conditional lexical capture repair and binder exception trace

Direct nested-call boxing now records `rawLocalIdx` and uses a nullable cell,
matching the existing conditional capture repair contract. Already-boxed
direct calls repair the cell before forwarding it. This reuses the existing
identifier/assignment/update read and write repairs, rather than changing
lexical declaration timing. No context map is moved; the existing
`boxedCaptures` lifecycle and original-slot guards remain in force.

Run 67311: **23/25 pass**, including all four reduced let/var cases, all twelve
eager-box controls, three destructuring controls, and all three standalone
WeakMap exports. The two GC optional WeakMap exports still trap with illegal
cast; the numeric case now gets past the prior NaN failure. Expanded control
run 86815 passes **35/35**, including conditional-arm capture, lifted cell
identity and capture-depth suites. The reduced test also checks writes and
unconditional forwarding after a skipped first call. New gates run 84565 is
pending; formatting of the implementation and capture regression passes.

Binder trace 18350 completed: byte-identical 88,206,870-byte, zero-import,
valid Wasm; still **0/2** invocation matches. Total 279502 ms. Both trace paths
reach `bindJSDocImports`, which immediately constructs a TypeError. Its source
first guards `jsDocImports === undefined` and then iterates the array. Added
`tests/issue-1058-binder-pending-array.test.ts` to check an unset captured typed
worklist, population and reset across calls; run 99743 is pending. This trace
predates the direct-call capture repair, so it is not a full candidate verdict.

Run 99743 reproduces a WebAssembly.Exception in both lanes (**0/2**) for the
reduced binder pending-array case. It is retained as the next investigation,
not yet proof of the precise representation defect. Gates 84565 pass
typechecking, both code-size gates and whitespace checks. Pending-array test
formatting passes.

Parser compile recheck 62530 is running in
`.tmp/ts5-parser-conditional-capture-repair.log`, but its invocation arguments
were mistakenly named runPerformance/runBuilder/runCore. The actual exports
are runPerformanceCore/runBuilderStatePublic/runCorePublic, with unchanged
expected values 49645738923599/13386537220945/40098163538143. Consequently this
run can provide compile/validation/import evidence only, NOT parser invocation
acceptance; let it finish under the no-test-kill rule and use the correct
export names for the next full recheck. No parser regression verdict is yet
available for the capture repair.

### Binder unset worklist: strict comparison preserves declaration default

Diagnostic 22638 shows the reduced `flush` emits a captured array read followed
by `drop; i32.const 0` for `pending === undefined`; the following for-of throws
on the null vector. The physical slot uses ref.null for the unset value, but
the comparison relied only on the declared `Tag[]` type and folded the guard
away. This matches the full trace's `bindJSDocImports` entry shape.

Added `readsUninitialisedVariableSlot` for identifiers resolving to explicitly
typed variable declarations without initializers. Concrete reference strict
nullish comparisons now treat those declaration defaults as undefined.
Declarations admitting null/any/unknown stay out of this additional predicate;
the existing mixed-carrier policy remains unchanged. This is not a global
null-equals-undefined change and does not modify the externref comparison path.
Run 79732 passes the reduced binder lifecycle **2/2**, up from two exceptions.
Run 40049 adds an explicit nullable-array control and checks field and vector
nullish suites; gates 90172 are pending. No full binder acceptance credit yet.

Run 40049 completes **75/75** regression checks, including the explicit-null
variable control. The field suite intentionally includes known-divergence
assertions; these counts are regression stability, not 75 newly conforming
behaviors. Full standalone binder retry 45060 is running with the original
runConstLocal=65792 and runDuplicateLet=131330 oracles, logging to
`.tmp/ts5-binder-unset-worklist.log`. Parser compile-only diagnostic 62530 and
gates 90172 remain live at this checkpoint. All 256 upstream files and the
generator-delegation blocker remain in the goal's scope.

### Generator worklist delegation acceptance controls

Added `tests/issue-1058-generator-worklist-delegation.test.ts`: native-JS
oracles and strict zero-import standalone checks for Map.values()-backed
flattening (123), `.return(9)` closing the enclosing iterator once, and
`.throw(9)` on an array delegate producing TypeError while closing the
enclosing iterator once. Array iterators lack a throw method: do not replace
that TypeError with propagation of the original numeric payload.

Initial run 7728 exposed a test-source return-type mismatch; corrected the
generator's normal return to numeric 0 rather than suppressing semantic
diagnostics. Run 49509: all **3/3 native oracles pass**, all **0/3 standalone**
checks stop at the native-generator unsupported-shape diagnostic. The
planner's non-replay unwind guard remains intact: lifting that guard alone
would skip delegate abrupt-method semantics. These tests are not a substitute
for the eleven original compilerCore tests or the full 256-file unit scope.

Gates 90172 completed successfully. Parser run 62530 completed in 305896 ms,
peak 2837.8 MiB: 79,155,603-byte valid Wasm, zero imports; all three invocation
lookups failed solely on the documented wrong export names. Correct full
parser run 45226 is now active with runPerformanceCore/runBuilderStatePublic/
runCorePublic and the unchanged original fingerprints, logging to
`.tmp/ts5-parser-unset-worklist-repair.log`. Binder candidate 45060 remains
active. No runtime acceptance inferred from either pending run.

Binder candidate 45060 completed: **0/2** unchanged invocation oracles still
throw WebAssembly.Exception. Compile succeeds; 88,207,292-byte Wasm validates
with zero imports; total 319691 ms, peak 3232.2 MiB. The reduced worklist fix
is therefore not sufficient evidence of a full binder repair. Invocation
trace 18167 is now running on this candidate, logging to
`.tmp/ts5-binder-unset-worklist-trace.log`, to distinguish a moved exception
from a source-projection case missed by the reduction. Correct parser run
45226 remains active.

Generator implementation audit: `__iterator_return` is IteratorClose and
deliberately discards its result; it cannot implement yield-star forwarding
where `.return()` may yield `{ done: false }`. The iterable delegation state
only invokes `__iterator_next`, while the legacy native-generator delegation
abrupt arm drives the inner once and discards its result. A correct extension
must retain delegate results and route completion through the outer unwind
chain, including missing `.throw` producing TypeError and enclosing iterator
cleanup. Do not substitute `__iterator_return` or remove the planner guard
as if either were full delegation support.

Correct parser recheck 45226 completed successfully: **3/3 exact original
fingerprints match**, valid 79,155,603-byte standalone Wasm, zero imports.
Performance=49645738923599, Builder=13386537220945, Core=40098163538143.
Total 271764 ms, peak 3307.8 MiB. This verifies parser acceptance after the
conditional-capture and unset-worklist comparison changes; it does not prove
binder or upstream-unit completion. Binder trace 18167 remains live. A fresh
expanded upstream adapter run is logging to `.tmp/ts5-upstream-unset-worklist.log`.

Expanded adapter run 52174 completed on the current candidate: **25/25 native,
14/25 standalone**, five selected files and 251 explicitly deferred files.
All five modules compile and validate. Four modules run with zero imports;
compilerCore's eleven tests remain blocked before execution by exactly
`__gen_create_buffer`, `__gen_push_ref`, `__gen_yield_star`, and
`__create_generator`. Report retains oracleVersion 3 and all original counts.
No new unit acceptance credit; this is fresh evidence that the capture and
worklist fixes preserve the current floor and do not remove the delegation
blocker.

### Binder trace moves past binding; optional native collection size

Trace 18167 completes in 263472 ms on the same 88,207,292-byte candidate:
both invocations still throw, but now `bindSourceFile` RETURNS before the
failure. The tail reads `symbolCount` and `locals`, then attempts Map primitive
conversion via valueOf/toString and throws TypeError. The committed oracle
reads `source.locals?.size` before its range checks and arithmetic.

Reduced `tests/issue-1058-optional-map-size.test.ts` run 68974 reproduces
standalone's populated-size failure (-2); GC separately fails the missing
receiver case (-1). The optional-property extern reader emits no getter when
its host import is absent, leaving the collection receiver in place of size.
Added an extracted native size reader before that branch. It consumes the
saved non-null receiver, calls the existing `__map_size`, and requires actual
declaration-file Map/ReadonlyMap/Set/ReadonlySet symbols, excluding user classes.

Run 8961 passes **8/9**: standalone size now passes and all seven optional Set
controls pass; GC's initial missing-value failure remains. Expanded size
controls (read-only collections and getter receiver evaluated exactly once)
run 21012 is pending; typecheck 38770 is pending. Full binder retry 34787 is
active, logging `.tmp/ts5-binder-optional-map-size.log` with the unchanged two
smoke oracles. No binder acceptance credited until this full run succeeds.

Expanded run 21012 confirms the standalone read-only Map/Set and exactly-once
receiver controls pass; GC still fails the initial absent optional property
check. Both function and LOC gates pass (the combined command's exit 0 is
the gate result, NOT a green Vitest result). Typecheck 38770 passes. Binder
34787 remains the authoritative pending full candidate check.

Run 25536 adds and passes both user-defined Map/Set size-getter controls;
standalone collection-size test also passes (**3/4** total, the retained GC
missing-value failure is the fourth). Formatting and whitespace run 51918
passes. Split the generator normal-worklist source from cleanup sources to
avoid attributing a shared-module compile failure to every behavior. Run
24794 retains **3/3 native, 0/3 standalone** but now precisely distinguishes:
normal Map.values flattening compiles and validates, then fails the zero-import
gate on three generator imports; cleanup fixtures fail code generation.
Both kinds of missing support remain required. Binder 34787 is still live.

Binder 34787 has now completed: **both invocations execute without exception**,
but both return **0**, versus unchanged expected 65792 and 131330 (**0/2
matches**). Compile succeeds; 88,207,339-byte Wasm validates with zero imports.
Total 256928 ms, peak 3139.3 MiB. The optional-size repair clears the TypeError
but does not establish semantic correctness. Next diagnosis must separate the
symbol/local/diagnostic counts and verify binding ran on the returned source
object; retain original smoke expectations, never reseed them to zero.

### Binder zero counts: cross-module traversal-function collision

Diagnostic fixture `typescript-binder-fields.ts` decomposes the packed oracle
without replacing it. Native TypeScript 5.9.3 yields parse-shape 3080101,
const symbols/locals/diagnostics/has-x = 1/1/0/1, duplicate counts = 2/1/2.
Full standalone run 50234 (236551 ms, 88,208,095 bytes, zero imports) matches
only parse-shape and const diagnostics (**2/8** diagnostic matches); every
post-bind count and has-x is zero. Parser output is nonempty and initially
unbound, so missing symbols are not merely a packed-arithmetic problem.

Existing trace 18167 shows `bindEachChild -> forEachChild -> visitNodes ->
visitArrayWorker`. That last helper belongs to visitorPublic.ts's transforming
`visitNodes`, not parser.ts's same-named traversal function. Both declarations
have incompatible parameter order. This suggests a module-initializer closure
compiled under another module's bare-name function binding.

New multi-module regression 51158 reproduces exceptions in both lanes.
Candidate `fixedSourceFunctionCallHandle` uses the exact fixed-arity top-level
declaration's registered handle and suppresses stale name-keyed inlining and
nested captures. Run 85700 preserves five existing collision controls, but
the new two tests now trap with illegal cast in `__closure_16`; candidate is
NOT yet a verified fix. WAT diagnostic 47547 is examining the remaining call
ABI mismatch. Do not claim the new handle selection fully fixes module scope.

WAT diagnostic 89680 exposed one final `finalFuncIdx` lookup still reverting
to the bare-name map AFTER the arguments had been compiled for the exact
declaration; mismatch repair then cast the callback into the other function's
array parameter. Preserve the exact handle at that final emission too.
Run 1423 now passes **8/8**: both new module-initializer collision tests,
five existing module collision controls, and the nested factory-name control.
Formatting run 94096 passes. Wider generic-callback/capture run 14215 and
gates 6661 are pending. Full binder retry 95759 is active with unchanged
65792/131330 oracles, logging `.tmp/ts5-binder-source-function-identity.log`.
This is the first full binder run with the exact-call handle repair; its
success is not presumed from the reduced regression.

Wider run 14215 passes **94/94** (90 generic callback-result cases and four
conditional-capture cases). Full binder 95759 and gates 6661 remain pending.

Gates 6661 pass typecheck, function/LOC gates and whitespace checks. Parser
recheck 78543 is running in `.tmp/ts5-parser-source-function-identity.log` with
the three unchanged fingerprints. Binder 95759 remains live.

Expanded collision regression 40649 adds a same-named foreign rest function:
the two original rows pass, but both rest rows emit invalid calls (two required
operands versus one packed array). Exact function identity must also reject
the unrelated name-keyed rest/default metadata. The exact-handle predicate
already proves the source declaration has neither; suppress those two metadata
lookups for proven fixed-arity source calls. Run 80913 confirms all **4/4**
collision rows now pass; its source-callable ABI suite is still running.
Formatting passes; renewed typecheck 90998 is pending. Full compiler runs
95759/78543 began before this last metadata refinement; label their results
accordingly rather than presenting them as a final whole-candidate verdict.

Run 80913 completed **17/17** (four collision rows plus thirteen exact source
callable-ABI controls). Binder 95759 completed: valid 87,966,578-byte Wasm,
zero imports, total 304778 ms, peak 3237.5 MiB, **0/2** matches. Both cases now
trap at `declareSymbol` (offset 0x151b8ea / 22132970), reached through
bindBlockScopedDeclaration -> bindVariableDeclarationOrBindingElement ->
bindWorker -> bind -> forEach -> bindEach. This is a new, concrete downstream
failure: traversal now reaches variable declarations instead of silently
skipping them. Next diagnosis should inspect declareSymbol's null operand,
not revert expected counts or count an exception as acceptance.

Parser 78543 completes **3/3 unchanged exact fingerprints**, valid
79,099,700-byte Wasm and zero imports, total 261813 ms. This run includes the
exact source-handle selection, before the final rest/default metadata guard.
Typecheck 90998 passes after that guard. No full compiler process remains
running at this checkpoint.

### Binder Symbol constructor shadowing follow-up

Source-mapped trace 35124 completed with **0/2** unchanged binder oracles:
both traps map to binder.ts:889 after `createSymbol` returns without invoking
a constructor (`__closure_arity` returns -1). The reduced captured symbol-table
matrix (35281) passes the standalone object-literal control but traps with the
allocator-returned constructor; both GC rows also fail (1/4 overall).
Reduced WAT identifies the standalone defect: `() => Symbol as any` materializes
the builtin Symbol singleton instead of the source `function Symbol`. The bare
builtin value arm precedes source function wrapping and lacked a declaration
shadowing guard. Add the existing resolved-declaration/ambient check at that
arm; targeted and full-graph validation remain required. No acceptance values
or full-unit-suite denominators changed.

Validation after the guard: 10411 is **8/10** (both standalone symbol-table
cases plus all six existing constructor-factory tests pass; the two existing
GC symbol-table cast failures remain). Builtin identity controls 4268 pass
**14/14**. New source-function value controls 60552 pass **4/4** for Symbol,
Map, Set and RegExp. Typecheck 85145 passes. Full binder retry 6509 is live,
logging to `.tmp/ts5-binder-symbol-shadowing.log`, with original 65792/131330
oracles; do not infer a full binder pass from the reduced constructor result.
Typed-this twin and module-function collision controls 90172 pass **16/16**.
Function/LOC gates 11530 and `git diff --check` pass after the change.

Full binder 6509 is now terminal: **1/2** original acceptance workloads pass.
`runConstLocal` returns exactly **65792** (previously trapped); duplicate-let
still throws a WebAssembly.Exception rather than returning **131330**. Binary
size is 87,999,385 bytes. This establishes a real binder gain, not completion.
Next trace should target duplicate-declaration/diagnostic handling; the former
Symbol-constructor null trap is cleared for the const workload. No full build
process remains live at this checkpoint. Full 256-file upstream unit coverage,
generator delegation, checker and self-hosting remain unfinished.

Duplicate-declaration follow-up: trace/source-map retry 31476 is running at
`.tmp/ts5-binder-duplicate-trace.log`, retaining both original binder oracles.
Add a reduced diagnostic rest-argument/regexp replacement control while tracing
the real exception; it is a diagnostic hypothesis, not an attributed root cause.

31476 completed **1/2**, preserving const=65792. Trace stops at
`getTextOfNodeFromSourceText -> isJSDocTypeExpressionOrChild -> findAncestor ->
__new_TypeError`, before diagnostic formatting. `findAncestor` accepts a
boolean-or-"quit" callback; this caller passes the boolean type predicate
`isJSDocTypeExpression`. Add the ancestor predicate callback reduction next.
Separately, formatter matrix 66625 is **1/2**: direct indexed args pass,
generic `checkDefined(args[index])` fails. A character-code probe shows
`Cannot redeclare [object Object].` instead of `Cannot redeclare x.`; WAT
shows the already-tagged argument reboxed before stringification. This is a
separate defect, not evidence explaining the current binder exception.

Ancestor reduction initially throws (10912). Removing the zero-argument
restriction on externref Boolean boxing did not help (37232), so that edit
was reverted. WAT instead shows a callback result of `$AnyValue`, with an
i32 Boolean predicate omitted from the funcref dispatch ladder. Explicit
`__any_box_bool` adapts that proven result; matrix 84156 then passes match
and missing, while the string "quit" callback still throws (2/3). Add the
matching native-string-to-union result conversion via `__any_box_string`.
Both are representation-proven boxing, not arbitrary object downcasts.
Validation 85549 passes **93/93**: all three ancestor cases plus 90 existing
generic callback tests. Full binder retry is logging to
`.tmp/ts5-binder-predicate-union.log`; it must retain 65792/131330. Formatter
generic-return reboxing remains unfixed, and broader/full-graph acceptance
is not implied by the reduced tests.

Live handles at this checkpoint: binder **34295**, function/LOC/diff gates
**7039**. Typecheck and formatting **55951** completed successfully. Poll the
existing handles before starting replacement runs.

Gates 7039 completed successfully; binder 34295 remains live. Formatter
follow-up changes `__any_box_extern_s1` to recover an existing `$AnyValue`
for every tag instead of only undefined. This preserves compiler-owned
tagged values crossing erased generic ABIs without enabling honest
classification of arbitrary raw externrefs. The helper's emitting call site
is `value-tags.ts`; its contract comment is updated too. Targeted tests
77438 are pending; broader nullish/boxing regression checks are required.

77438 completes **95/95** (formatter direct/generic 2/2, ancestor 3/3,
generic callback controls 90/90). Nullish/boxing regression run 94696 passes
**27/27** across host default returns, hoisted regexp values, any-array tags,
undefined-singleton behavior and array absence/defaults. Binder 34295 began
before this boxing edit and must be labelled as the predicate-union candidate,
not as validation of the formatter repair.

Typecheck 77632, formatting/diff check 80963 and function/LOC/diff gates
72138 pass. Full parser regression 66724 is live with all three unchanged
fingerprints, logging to `.tmp/ts5-parser-union-box-roundtrip.log`; unlike
binder 34295, this run includes the formatter boxing repair.

Binder 34295 completed: **1/2**, const=65792 and duplicate-let still throws,
valid 88,001,151-byte Wasm, zero imports, 284714 ms. This predates formatter
boxing preservation; no assertion about the remaining exception's location
is justified without tracing again. A current-candidate trace is logging to
`.tmp/ts5-binder-union-box-trace.log` while parser 66724 remains live.
The binder trace handle is **18044**. Poll 18044 and 66724 on continuation;
do not replace either run merely because a polling interval expires.

Additional representation guard: `issue-1058-union-generic-roundtrip.test.ts`
passes runtime-selected string/number/true/false union-array elements through
generic `defined<T>` and checks both `typeof` and exact value. Run 41548 is
pending; parser 66724 and binder trace 18044 were confirmed live on resume.

Parser 66724 completes **3/3 exact original fingerprints**, valid
79,134,618-byte Wasm, zero imports, 300676 ms. This includes the predicate
union callback and existing-AnyValue preservation repairs. Broader union
roundtrip test 41548 fails number/boolean rows; split control 31877 is **1/2**:
direct reads preserve all four brands/values, generic-return reads give
[1,-2,-3,-4]. Thus formatting now works but general generic union brands are
not yet correct. Binder trace 18044 remains live.

Binder trace 18044 is terminal: valid 88,001,430 bytes, zero imports, **1/2**.
The trace now executes `__fn_tramp_isJSDocTypeExpression_cached` through the
ancestor walk, then reaches diagnostic formatting. The remaining throw is
`formatStringFromArgs -> __closure_861 -> checkDefined ->
__call_accessor_get -> __call_fn_method_0 ->
__proto_method_-1073741806_toString -> __new_TypeError`. The full-graph
formatter carrier still differs from the passing reduction; adding an
assertion-function-style guard passes all three formatter rows (69286).

For the separately measured generic scalar-brand loss, add
`generic-scalar-union-result.ts` at expression result coercion: only erased
externref results of generic calls with proven string/number/boolean union
types recover tags via the existing honest classifier. Unrestricted any
results retain their existing path. Test run 90074 is pending. Both full
build processes are finished; no new full acceptance result is claimed.

90074 passes **5/5**: generic/direct union brands and all three formatter
variants. Regression 48264 passes **108/108** (90 generic callbacks, three
ancestor cases, six constructor-factory cases, nine undefined-singleton
controls). Typecheck/format handle 71921 is still pending. Parser 66724's
3/3 result predates this latest generic-scalar-union-result helper.

71921 completed typecheck/format successfully. `builtin-brands.ts` identifies
the full-graph throw's brand -1073741806 as **Object.prototype.toString**,
not String.prototype. Its classifier can refuse unknown carriers. Next work
should inspect the diagnostic argument at the full graph's erased generic
return / concatenation boundary; do not "fix" it by swallowing this refusal
or accepting diagnostic counts with wrong message text. No full build is live.
Final function/LOC/diff gates 62241 pass after the scalar-union result helper.

Formatter graph diagnosis: 98591 runs `compileProject` on the same tracked
binder entry and standalone options, emitting only selected formatter/caller
function WAT into `.tmp/ts5-binder-formatter-wat.log` and then invoking both
original exports. This is diagnostic output, not an acceptance artifact.
Cross-module captured-rest/same-name diagnostic-function reduction 77245 is
pending in `issue-1058-diagnostic-module-forwarding.test.ts`.

77245 passes **1/1**. Native TypeScript **5.9.3** verifies the unchanged
duplicate-let input produces two code-2451/category-1 diagnostics at starts
4 and 94, length 1 each, both message `Cannot redeclare block-scoped variable
'x'.`. Add `typescript-binder-diagnostic-details.ts` to check these fields and
source-file identity; it reexports the original two count oracles rather than
replacing them. Its standalone detail export is not yet measured.

98591 completed: compile succeeds, 88,001,121 bytes, zero imports,
const=65792, duplicate-let throws. Full `__closure_861` WAT reads the captured
union vec through `__extern_get_idx`, calls erased `checkDefined`, then sends
the result straight to external string conversion. It never enters an
expected-AnyValue coercion site. Move proven generic scalar-union recovery
to the expression's natural result boundary, before expected-type coercion,
so concatenation receives a tagged scalar too. Targeted tests are pending.
The new detail fixture returns 1 under native TypeScript (53301); standalone
detail acceptance remains unverified.

Moving recovery to the natural result initially passed 95/96 (46574) but
regressed the standalone boolean-first parser scalar control from 1042 to
42. The checker represents boolean as `true | false`; the helper must not
change that homogeneous scalar ABI. Require at least two primitive brands
(string/number/boolean), not merely `type.isUnion()`. Rerun 58114 is pending.
Typecheck/format 15159 passes before this final classifier refinement.

58114 passes **96/96**, restoring the boolean-first parser control while
preserving all diagnostic/union tests. Full diagnostic-details trace is
running at `.tmp/ts5-binder-diagnostic-details.log`: original const=65792,
duplicate-let=131330, plus diagnostic details=1 (three required invocations).
The original two acceptance values are unchanged; the third strengthens
the result with message/location/category/file-identity checks.
Live handles: full binder **88439**, typecheck/format/function/LOC/diff gates
**70054**. Poll these handles on continuation instead of restarting them.
70054 has now passed all gates; only full binder 88439 remains live.

88439 is confirmed live on continuation. Start a current-candidate parser
regression at `.tmp/ts5-parser-natural-scalar-union.log`, retaining the three
original fingerprints, to check the natural-result recovery plus primitive
brand discrimination (the preceding full parser run predates that change).

Current parser handle is **97684**. Add homogeneous boolean/string-literal/
number-literal union checks to the generic-roundtrip regression, preserving
the existing heterogeneous-brand assertions. Test 42198 is pending; binder
88439 and parser 97684 remain live.

42198 completes **1/2** after strengthening the regression. With the earlier
heterogeneous generic call present, homogeneous checks pass; without that
call (direct-read control), homogeneous checks return [21,121] instead of
[22,111]. This is an additional first-instantiation-sensitive generic result
defect, not permission to remove the new assertion. Previous 96/96 predates
these additional assertions. Full binder/parser runs are still pending.

88439 completed: valid 88,009,347 bytes, zero imports, **0/3** matches.
Two rows did not execute: re-export-only count entrypoints were absent.
Replace those fixture reexports with explicit wrappers calling the original
functions; do not reinterpret missing exports as binder behavior. The detail
row executes and now passes `formatStringFromArgs -> checkDefined ->
__any_from_extern_honest`, then traps after `__get_member_bindDiagnostics`
with an illegal cast in declareSymbol (offset 22179008). The prior formatter
TypeError is cleared in this trace, but no diagnostic-detail pass is claimed.
Next inspect the diagnostic array's element carrier. Parser 97684 is live.

Parser 97684 completes **3/3 original fingerprints**, valid 79,134,616 bytes,
zero imports, 309909 ms, including the heterogeneous natural-result repair.
Add `issue-1058-source-diagnostic-array.test.ts` (7344) for empty diagnostic
array initialization on a constructor-backed extended Source node. Start
selected WAT diagnosis for declareSymbol/createFileDiagnostic/the diagnostic
array getter at `.tmp/ts5-binder-diagnostic-array-wat.log`, invoking all three
detail-fixture exports now that the count wrappers are explicit.

Source diagnostic array reduction 7344 null-dereferences. Split matrix 49967
is **1/2**: plain-object Source passes, constructor-backed extended Source
null-dereferences. This distinguishes constructor/projection setup from an
ordinary diagnostic-array push, but does not yet attribute the full graph's
illegal cast to the same cause. Full selected-WAT build **98119** is live at
`.tmp/ts5-binder-diagnostic-array-wat.log`; no other full build is running.
Formatting/diff check 17538 is pending. Keep the homogeneous generic failure
from 42198 as a separate remaining defect.

Reduced WAT 78331 attributes its null trap earlier than array access:
`new (Node as any)(308)` drops 308, emits `ref.null Node; ref.as_non_null`,
then calls the typed-this constructor with a zero numeric argument. This is
an erased direct-new/typed-this ABI defect, not evidence that the full
binder's diagnostic-array cast has the same cause. Keep the reduced test;
inspect full WAT 98119 before changing array conversion.

98119 completed: compile succeeds, 88,009,123 bytes, zero imports. Explicit
count wrappers now execute: const=65792; duplicate-let and detail both
illegal-cast in declareSymbol at 0x1526c05. Full WAT line 57825 reads
bindDiagnostics through getter 5445, then `any.convert_extern; ref.cast_null
494` before array push. Getter's direct SourceFile arm reads field 47 of
type 395; fallback reads through __extern_get. The selected-function log
discarded type declarations, so allocation-vs-read mismatch is not yet
attributed. A new selected type/parseSourceFileWorker WAT run is logging to
`.tmp/ts5-binder-diagnostic-types-wat.log` to recover that evidence.

On continuation, handle 31023 is missing and its log contains only
`COMPILE false 0` (the diagnostic command omitted errors). This is terminal,
not a live wait. Error-reporting retry **48505** uses the same entry/options
and selected parseSourceFileWorker WAT; inspect its errors before attributing
the failed diagnostic run. The prior approval-service usage-limit rejection
prevented the last handoff edit; tool reads and a subsequent test edit now
succeed. Strengthen the constructor reduction with `source.kind === 308` so
future repairs cannot pass while dropping the constructor's assigned value.

### Retry checkpoint: stack-safe peephole traversal

Type-inspection retry 48505 terminated with `success:false`, zero bytes and
`Maximum call stack size exceeded (at src/codegen/peephole.ts:114:10)`.
Replace recursive child-first optimization with an explicit postorder stack,
preserving physical-array deduplication and cross-function local-type guards.
Add a deep-nesting regression before retrying the full diagnostic compile.
The strengthened source diagnostic-array reduction remains 1/2: plain objects
pass, constructor mode traps. No new binder acceptance gain is claimed.

Implemented the explicit postorder traversal, retaining the shared child
enumerator and per-module visited set. The 20,000-level shared-body test first
failed with the original recursive optimizer, then passed with the fix.
Current focused checks: 13/13 DAG/order/catchAll/pattern tests and 4/4
dead-load runtime controls pass. The older ref-cast suite is 1/7: six cases
fail at instantiation on missing `string_constants` imports; this retry has
not attributed those failures. Full type-inspection retry is recorded in
`.tmp/ts5-binder-stack-safe-type-probe.log` (handle 27490), with typecheck and
quality gates running separately (74401). Do not infer full compilation or
diagnostic-array repair from the focused optimizer checks.

TypeScript `tsc --noEmit` passed. The first formatting gate caught the new
test's array layout; formatting was corrected and the rerun passed formatting,
function/LOC budgets, and `git diff --check`. Parser source initializes
`bindDiagnostics = []` inside `createSourceFile`'s nested `setFields`, not
directly inside `parseSourceFileWorker`; target that function for the next
allocation trace after obtaining the actual field/vector type declarations.

Retry 27490 is now terminal: compile **success**, **88,009,123 bytes**, no
error-severity diagnostics. The same direct compile that overflowed before
now completes. This diagnostic command did not instantiate or invoke exports;
do not promote it to runtime acceptance. Its name-filtered type output exposes
JsonSourceFile.bindDiagnostics as `(ref null 494)` but omits the main SourceFile
carrier (its emitted name does not match the filter). Next trace must retain
all type declarations (bounded extraction afterwards) and nested `setFields`
WAT, avoiding another misleading name-filtered view. No processes from this
retry remain live. Binder acceptance remains the previously measured 1/2,
expanded diagnostic-detail acceptance 1/3; all 256 upstream files remain the goal.

### Diagnostic field initialization trace

The previous turn made progress (stack-safe optimizer plus successful full
compile). Current full trace 33765 retains all emitted types and selected
`setFields`/`createSourceFile`/diagnostic getter WAT via the existing dump
hooks, and invokes all three binder exports. Logs are
`.tmp/ts5-binder-field-all-types.log` and `.tmp/ts5-binder-field-all-types.txt.wat`.
Upstream nodeFactory initially writes `bindDiagnostics = undefined!`, then
parser.createSourceFile.setFields writes `[]`. Added a focused matrix for
that initialization through nested functions, including a base-Node view.
This is separate from the explicit-this constructor reduction.

The new matrix measured 2/3: plain Source and a fresh Node returned through
a local both pass; directly returning the identical Node object literal
traps in factory before field initialization. Reduced WAT proves a nominal
test against the not-yet-allocated Source carrier falls back to null. Extend
the existing fresh-wrapper factory proof to direct returned object literals,
with the same source/target assignability checks. Full trace 33765 started
before this extension; keep its candidate provenance separate. Regression
checks are running before claiming the direct-return case fixed.

Full trace 33765 terminated: success, 88,009,123 bytes, imports `[]`, const
65792; duplicate-let and details both illegal-cast. Flat type 395 is actually
JsonSourceFile, not the general SourceFile carrier. `setFields` receives Node
223, allocates vector **494** (data array 493 / DiagnosticWithLocation 442),
then extern-converts it and calls setter 4160. Thus allocation agrees with the
failing expected vector type. The getter tests JsonSourceFile 395, otherwise
calls `__extern_get` (1495). Next inspect setter/property storage and the
fallback getter's result representation, not the empty-array type choice.

The direct-return factory extension passed the initialization matrix 3/3;
combined node-array/parenthesizer/sibling controls measured 27/29, with two
standalone user-Map failures (one invalid binary, one module-init stack
underflow). Temporarily remove only this turn's nine-line extension and run
the Map controls (25147) to attribute those failures before restoring it.
Typecheck, formatting, function/LOC budgets and diff checks passed with the
extension present. No binder acceptance gain is attributed to that extension.

Map A/B 25147 reproduces the identical two standalone failures with the
extension absent. Restored the extension; additional base-node and SourceFile
controls measured 16/18 (including initialization 3/3). Both failing diamond /
LiteralLikeNode cases also reproduce without the extension (40223, 0/2), so
neither pair is caused by this change. The extension is restored in the worktree.

Next storage trace **41081** runs the current candidate with the restored
extension and includes a new `runDiagnosticArrayBeforeBind` export. Native
TypeScript 5.9.3 confirms the expected pre-bind diagnostics length is 0.
The trace retains setter/getter and `__extern_set[_strict]`/`__extern_get`
WAT, plus all types, under `.tmp/ts5-binder-field-storage*`. It executes the
new pre-bind check and all three original binder exports. Await this live
handle; do not restart on an observation timeout.

Expanded initialization matrix now passes **4/4**, including dynamic expando
storage of the typed diagnostic vector on a base Node, identity equality,
push, and write-through. This rules out the simplest generic expando roundtrip
as a reproduction. Formatting and diff checks pass. Storage trace 41081 is
still confirmed live on the last poll; its log has no result yet. No source
change beyond the restored direct-object-literal proof was made while it ran.

### Stack-safe WAT diagnostic printer

Storage trace 41081 is terminal, but failed before invocation: the selected
`__extern_get` WAT dump overflows `formatInstrIndented` in src/emit/wat.ts.
This is a second recursive traversal issue, not a failed binary acceptance
run. Replace recursive formatting with an explicit work stack, preserving
child order, repeated shared-body occurrences, and exact empty-arm formatting.
Add deep nesting and formatting controls before retrying storage inspection.

The 3,000-level WAT test first reproduced the exact formatInstrIndented
overflow. Iterative string/instruction frames now pass it, preserving repeated
shared arms (not deduplicating semantic occurrences), catchAll and empty-arm
whitespace. WAT stack/escaping/SIMD/emit-option controls pass **21/21**.
The expanded diagnostic initialization matrix also passes **5/5**, including
overwriting an undefined dynamic entry after adjacent field writes.

Full storage retry **14691** runs with the stack-safe WAT printer; output is
`.tmp/ts5-binder-storage-stack-safe.log` and matching `-types.txt[.wat]`.
It retains all four requested runtime invocations and the same selected
storage functions. Quality gates are running separately as **64375**. Both
handles are live at launch; do not treat an empty log as a terminal result.

64375 completed successfully: typecheck, formatting, function and LOC budgets,
and diff checks all pass. Storage trace 14691 remains confirmed live; no new
runtime result has been reported yet.

14691 is now terminal: iterative traversal clears the stack overflow, but
the selected giant helper hits `RangeError: Invalid string length` at the
final chunks.join in formatInstrIndented. Cap cosmetic indentation at 64
levels to avoid quadratic whitespace growth; ordinary-depth output is
unchanged and no instruction is removed. Add output-size/indentation bounds
to the 3,000-level regression before retrying the same storage trace.

Bounded-indentation printer checks pass **21/21**, and formatting/function/LOC
budgets/diff checks pass (82609). The previous typecheck passed before this
Math.min-only printer adjustment. Full retry **16992** uses
`.tmp/ts5-binder-storage-bounded.log` and matching `-types.txt[.wat]`, with the
same four runtime exports and selected helpers; it remains live on the latest
30-second wait. This retry is diagnostic infrastructure progress, not a new
binder acceptance claim.

16992 completed: compile success **88,009,782 bytes**, zero imports;
pre-bind length=0 and const=65792, duplicate-let/details still illegal-cast in
declareSymbol (5279, 0x1526e79): **2/4 expanded diagnostic checks**. Bounded
WAT succeeded and retained the full storage helpers. Important caveat: the
pre-bind length WAT tests vector 494 but falls back to generic __extern_length
when that brand fails. Thus length=0 proves a readable length, not the exact
push-compatible vector representation. Do NOT conclude binding corrupted a
previously proven exact vector. Add a pre-bind push export (native expected 1)
to distinguish this representation hypothesis from captured-file corruption.

Pre-bind push run **86230** is live; output `.tmp/ts5-binder-prebind-push.log`.
Prepared `.tmp/ts5-binder-inspect.mts` for subsequent runs: it retains a
diagnostic-only binary and prints the exact trap bytes/offset along with all
five expected values. Existing source maps are too coarse to attribute the
trap to one particular cast (the old mapping is >100 KB before the trap).
Do not promote the nearest WAT cast as proven without matching binary bytes.
The retained-artifact runner has not yet been executed; wait for 86230 first.

86230 completed: compile success **88,010,437 bytes**, zero imports,
pre-bind length=0, pre-bind push=1, const=65792; duplicate-let/details both
illegal-cast in declareSymbol (5280, 0x15270e5). Expanded checks **3/5**,
original binder acceptance still **1/2**. Native 5.9.3 confirms push length=1
and diagnostic.file identity. This rules out a generally unpushable freshly
parsed diagnostics array, but not capture/projection effects inside binding.
Launch the retained-binary runner next to identify the actual cast instruction
at the trap offset, rather than inferring it from the coarse source map.

Retained-binary runner is live as **1046**, logging
`.tmp/ts5-binder-retained.log`; on compile success it writes the diagnostic-only
`.tmp/ts5-binder-retained.wasm`. Added a binder-shaped file-cell regression
covering direct/nested generic forEach callbacks, diagnostic creation, two
source files in succession, and exact diagnostic file identity. This tests
the simple capture hypothesis while the authoritative binary is compiling.

1046 completed, preserving `.tmp/ts5-binder-retained.wasm`: 88,010,437 bytes,
zero imports, **3/5** exact checks. Trap bytes at 22180069 are
`fb 17 85 04` = `ref.cast_null 517`, NOT 494. Existing matching WAT shows
`local.get 52; ref.cast_null 517; call 638`, where local 52 is
`relatedInformation: (ref null 494)`. This is the rest-spread argument to
`addRelatedInfo`, after successfully obtaining bindDiagnostics for push.
Correct the earlier attribution: the diagnostic-array getter was not proven
to be failing. The binder-shaped capture matrix passes **2/2**.

`compileSpreadCallArgs`' rest arm compiles a trailing spread with no expected
type, then passes its vector directly. The callee's different invariant Wasm
vector type is patched by a nominal cast and traps. Add empty/non-empty
derived-diagnostic-vector regressions, then apply the callee's expected rest
type through the existing coercion path instead of relying on stack repair.

The reduction exposed two layers. Applying a rest-type hint alone leaves its
binary unchanged: resolved generic declarations skipped funcRestParams
registration, so the caller treated the spread as positional arguments and
passed element zero as the rest vector. Added `resolved-rest-parameter.ts`
to recover metadata from the exact resolved vector ABI at both top-level
registration sites, plus the callee-type hint in the rest spread emitter.
The non-empty diagnostic vector now passes; the empty case no longer traps
and passes returned identity/code/start checks, but returns -3 at its strict
optional-field undefined assertion (**1/2**, not green). Formatter controls
remain **4/4**. The old spread-rest suite fails **13/13** at missing
string_constants host imports and cannot validate these changes in this harness.

Full retained-binary retry is logging `.tmp/ts5-binder-rest-fixed.log`, preserving
its candidate as `.tmp/ts5-binder-rest-fixed.wasm` separately from the prior
binary. Verify all five runtime rows before attributing a binder improvement.

Full run handle is **85103**, still live. Gates **51566** completed: typecheck,
function/LOC budgets and diff checks pass; formatting also passed separately.
Numeric resolved-generic rest controls pass **2/2** (spread and ordinary args).
An absent optional diagnostic-vector control with NO rest call returns 0
instead of expected 1 (**0/1**), independently reproducing the empty row's
strict-undefined issue. Current rest diagnostic file is therefore **3/5**
across the measured rows, with the two optional-field assertions unresolved.

## Acceptance criteria

- [ ] `scripts/ts-compiler-stress.ts` exists and runs against a local `typescript` install
- [ ] Tier 2 (leaf modules: `core.ts`, `path.ts`) compiles cleanly
- [x] Tier 3 scanner+parser graph compiles, validates, and executes all three
      pinned real-source workloads in the GC/Node compatibility lane
- [x] Tier 3 scanner+parser graph compiles and validates as standalone Wasm,
      has zero imports, and executes equivalent tracked zero-argument oracles
- [x] Consumer-driven source resolution narrows the parser graph with default
      resolution unchanged and focused static/dynamic-demand tests
- [ ] Binder slice compiles, validates, preserves the three accepted parser
      fingerprints, and matches both committed native/Wasm binder oracles in
      both GC/Node and standalone lanes
- [ ] The pinned TypeScript 5.9.3 upstream unit adapter runs all 256 files with
      no deferred registrations in standalone mode
- [ ] ≥ 5 follow-up issues filed for concrete gap patterns
- [x] Results document the real-package compile rate, not hand-written toy subset (supersedes #452's scope)
- [x] **Stretch 1 (Tier 3):** compiled scanner+parser produces native-equivalent AST fingerprints for all three pinned real `.ts` files
- [ ] **Stretch 2 (Tier 4):** compiled checker subset reports TS2322 for `const x: number = "str"`
- [ ] **Moonshot (Tier 7):** js2wasm-compiled tsc can compile js2wasm's own source, and the second-stage output passes test262 at the same rate

## Non-goals

- Compiling the language service (`typescript/lib/tsserver.js`) — out of scope
- Performance parity with native tsc — correctness first
- Incremental compilation state across runs — the real tsc caches; we don't need that for single-shot
- Type-checker edge cases even native TypeScript struggles with (infinite conditional types, deeply nested `infer`)

## Design notes

**Why this is harder than prettier (#1034).**

Prettier is a pure source-to-source transformer whose acceptance test is "compiled output == native output byte-for-byte" — a mechanical diff. TypeScript is a type checker whose acceptance test is "compiled checker arrives at the same type assignments as native checker" — a semantic test over a graph of Type nodes, not a string diff. Much harder to verify, much more informative when it passes.

**Why this is easier than it looks.**

TypeScript compiles itself every day at Microsoft. The code is battle-tested. If a pattern works in real tsc, it's a pattern we *should* handle. Every failure in our compile is a concrete bug in js2wasm, not ambiguous tooling interaction. Unambiguous feedback: either we handle TypeScript's idioms or we don't.

**Self-hosting is the ultimate integration test.**

Every compiler gap today hides behind test262 or equivalence abstractions. Self-hosting breaks that — if we can't compile our own frontend, we know *exactly* which path is broken because tsc compiled that path a million times before. Strongest correctness signal available.

**Relationship to #452.**

#452 proved feasibility at the *pattern* level — 19/20 TypeScript idioms compile. This issue is the implementation at the *codebase* level — real modules, real call graphs, real type definitions. Complementary: #452 said "the puzzle pieces fit," this issue says "now build the puzzle."

**Why backlog-level dependency on #1046.**

TypeScript's source is split across ~300 ES modules with an intricate import graph. Current `compile(src, options)` assumes whole-program input. #1046 (separate ES-module compilation) is the architectural enabler that lets each file compile against declared imports without inlining the entire graph. Until #1046 is at least partially landed, Tier 2+ is blocked on "can we even load the second file."

## Related

Fifth in the real-world stress-test set:
- **#1031 lodash** — pure compute (generic algorithms)
- **#1032 axios** — I/O, Node host imports
- **#1033 react** — closures, hooks, DOM host imports
- **#1034 prettier** — parsers, recursive AST, string-heavy, self-format diff
- **#1058 TypeScript (this)** — self-hosting, type checking, everything at once

**Supersedes the scope of #452** (pattern-level feasibility study, #452 stays in done/ as historical validation).
**Depends on** #1042 (async/await), #1044 (Node builtins as host imports), #1046 (separate ES-module compilation).
**Soft dependencies:** template literal interpolation, large-switch codegen, recursive type inference.
**Unlocks:** ultimate self-hosting milestone, concrete stewardship-pitch deliverable ("js2wasm compiles tsc").

## Stewardship angle

"js2wasm compiles 60% of test262" is a percentage. "js2wasm compiles the TypeScript compiler itself" is a story. Landing even Tier 3 is the single strongest artifact for conversations with potential maintainers or funders — it demonstrates the compiler has enough depth to handle production TypeScript, not just hand-picked benchmark inputs. The gap between "a toy subset compiles" and "the real compiler compiles" is exactly what separates a proof-of-concept from a usable tool.
