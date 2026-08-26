---
id: 4435
title: "Marked upstream suite host-method and object-spread compatibility"
status: in-review
sprint: current
created: 2026-08-14
priority: high
horizon: l
feasibility: hard
task_type: bug
area: codegen
loc-budget-allow:
  - src/codegen/class-bodies.ts
  - src/codegen/class-member-keys.ts
  - src/codegen/closed-method-dispatch.ts
  - src/codegen/closures/method-trampolines.ts
  - src/codegen/context/create-context.ts
  - src/codegen/context/types.ts
  - src/codegen/declarations.ts
  - src/codegen/declarations/param-return-inference.ts
  - src/codegen/declarations/object-shape-widening.ts
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/expressions/call-tail-dispatch.ts
  - src/codegen/expressions/calls-closures.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/expressions/calls-optional.ts
  - src/codegen/expressions/internal-call-argument.ts
  - src/codegen/expressions/operator-assignment.ts
  - src/codegen/expressions/extern.ts
  - src/codegen/index.ts
  - src/codegen/literals.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/property-access.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/runtime.ts
func-budget-allow:
  - src/codegen/class-bodies.ts::collectClassDeclaration
  - src/codegen/declarations.ts::compileDeclarations
  - src/codegen/class-bodies.ts::compileClassBodiesInner
  - src/codegen/literals.ts::compileObjectLiteralForStruct
  - src/codegen/context/create-context.ts::createCodegenContext
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/declarations/param-return-inference.ts::anyIdentifierHasOpaqueLocalOrigin
  - src/codegen/declarations/param-return-inference.ts::inferParamTypeFromCallSites
  - src/codegen/declarations/object-shape-widening.ts::collectEmptyObjectWidening
  - src/codegen/expressions/internal-call-argument.ts::compileInternalCallArgument
  - src/codegen/expressions/operator-assignment.ts::tryCompileExternrefStructFieldPlusEquals
  - src/codegen/expressions/calls-closures.ts::compileCallablePropertyCall
  - src/codegen/expressions/calls-optional.ts::compileCapturedDynamicOptionalReceiverMethodCall
  - src/codegen/expressions/calls-optional.ts::compileOptionalCallExpression
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  - src/codegen/closed-method-dispatch.ts::fillClosedMethodDispatch
  - src/codegen/literals.ts::compileObjectLiteralAsExternref
  - src/codegen/literals.ts::compileObjectLiteralWithAccessors
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/index.ts::emitIteratorMethodExport
  - src/codegen/index.ts::emitMethodDispatch
  - src/codegen/property-access-dispatch.ts::tryIdentifierNamespaceAndStaticReceiverRead
  - src/ir/from-ast.ts::lowerMethodCall
  - src/ir/from-ast.ts::lowerFunctionAstToIr
  - src/ir/integration.ts::compileIrPathFunctions
  - src/codegen/literals.ts::isPlainDataLiteralSpreadSource
  - src/codegen/literals.ts::materializableSpreadStructTypeIdx
oracle-ratchet-allow:
  - src/codegen/class-bodies.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/literals.ts
  - src/codegen/declarations/param-return-inference.ts
coercion-sites-allow:
  - src/codegen/expressions/calls-optional.ts
  - src/codegen/expressions/internal-call-argument.ts
  - src/codegen/expressions/operator-assignment.ts
  - src/codegen/index.ts
---

# #4435 — Marked upstream host-runtime compatibility

## Problem

Marked's original upstream hook tests compile to valid Wasm after the class
identity, closure receiver, and object-spread fixes, but the admitted runtime
tests still fail because dynamic calls such as `del` do not yet resolve the
compiled class method through the JS host bridge. The watchdog also needs to
bound synchronous compiler work so a pathological upstream file cannot wedge
the compatibility workflow.

## Scope of this draft

- preserve class static/instance identities and method ABI keys;
- preserve callable receivers when method trampolines cross object shapes;
- materialize open spread sources before they enter a closed object field;
- run each upstream compilation in a killable child process with a hard
  deadline;
- retain the exact upstream tests and report compile, validation, and runtime
  results separately.

## Current measurement

`test/unit/Hooks.test.js` compiles and validates (`4,510,972` bytes in about
10.3 seconds). The 15 admitted synchronous tests currently run `0/15` in Wasm
with `br is not a function`; the remaining method-dispatch bridge is therefore
explicitly left for follow-up rather than presented as a passing fix.

The generic method-trampoline fix also removes a separate regression in the
iterator-protocol equivalence test: methods that never read `this` now retain a
nullable receiver instead of being narrowed with `ref.as_non_null`. The
iterator, class-method, and related closure tests pass locally (`17/17`), and
typecheck plus formatting pass. Marked's upstream hooks remain `0/15` until
mixed-arity receiver dispatch (`br`/`del`) is implemented; this checkpoint does
not claim upstream runtime compatibility.

## 2026-08-15 checkpoint

PR [#4507](https://github.com/loopdive/js2wasm/pull/4507) remains deliberately
draft. The branch is synchronized with current `main`; the earlier CI quality
failure was the equivalence baseline ratchet, not a compile or validation
failure in this change.

The watchdog now compiles the selected Hooks module with WAT emission disabled
(the binary is the artifact under test), then runs the unchanged upstream
callbacks in a killable worker. The current local result is `1/1` module
compiled, `1/1` validated, `4,549,831` bytes, and `0/15` admitted synchronous
tests in Wasm (`br is not a function`). The vector bridge export table is now
finalized from allocator-owned function objects after dead-import elimination,
so the runner reports the real method failure instead of an empty marshaled
status vector.

The remaining runtime work is to make Marked's mixed-arity class-method and
renderer initialization path callable without allowing the method-cache arm to
select a closure with the wrong ABI. No passing upstream-runtime claim is made
until that path is covered by the unchanged Hooks suite.

## 2026-08-15 handoff

The follow-up implementation added a real host bridge for ordinary compiled
class methods, including method-arity dispatch, JavaScript under-application
padding, and a vector adapter for rest parameters. The generated module now
validates and instantiates; a focused generic rest-method probe passes. The
regression coverage is in `tests/issue-4507-class-method-dispatch.test.ts`.

The remaining Marked-specific failure is narrower than the old validation
failure: `new Marked()` succeeds, but the dynamic `any` call `marked.use()`
still throws `TypeError: Cannot convert object to primitive value` inside the
compiled `use(...extensions)` body. The unchanged upstream Hooks suite
therefore remains `0/15` in Wasm. This is a semantic receiver/closure capture
problem in the `use` callback path, not a compiler watchdog or Wasm validation
problem. Continue from the current branch/PR with the existing probes removed;
do not report the bridge as upstream-runtime complete until the Hooks suite
passes.

## 2026-08-24 checkpoint — generic WasmGC receiver bridge

The remaining `space is not a function` failure was reduced to a minimal
generic call: a compiled `Renderer` instance is read from a dynamic field,
returned through `getRenderer(parser: any)`, and then called by
`invoke(renderer: any)`. The field read crosses as a live host proxy. The
runtime's class-member resolver previously rejected that proxy because only
fnctor and externref-backed instances were registered; it therefore never
consulted the already-emitted `__member_kind_space`/`__class_call_space_1`
Wasm discriminator. The fix unwraps the proxy at this boundary and admits the
positive WasmGC carrier check; the generated `ref.test` remains the receiver
identity decision.

Focused regression: `tests/dogfood/marked-runtime.test.ts` passes **1/1**.
The pinned `marked@18.0.2` surface was re-measured with the original eight
fixtures:

| | compile | diagnostics | binary | validation | fixture result |
|---|---:|---:|---:|---:|---:|
| before bridge | passed | 0 | 4,169,367 bytes | valid | **0/8** equal; all 8 `space is not a function` |
| after bridge | passed | 0 | 4,169,367 bytes | valid | **0/8** equal; all 8 reach `Cannot read properties of null (reading 'exec')` |

This is a genuine runtime progression, not a passing Marked claim: the class
method dispatch failure is removed, and the next independent regex/property
carrier gap is now exposed. The unchanged upstream Hooks denominator remains
**0/15** until that subsequent gap and the existing `use()` path are fixed.

## 2026-08-24 checkpoint — module-init spread and internal vec arguments

The `null.exec` failure was not a RegExp implementation bug. Marked constructs
its GFM and pedantic rule tables with module-level spreads such as
`{ ...blockNormal, paragraph: ... }`. Module initialization invokes host
`Object.assign` before `setExports` has installed the generated struct-field
readers, so the spread source is still an opaque WasmGC object with zero host
keys. Only Marked's explicit override fields survived; inherited rules such as
`newline` were absent before `.exec()` was called.

The generic fix materializes a host-readable copy only when the source resolves
to a compiler-visible, statically named data-only literal. Accessor, method,
computed-key, and nested-spread sources retain the lazy host path; this keeps
the getter-order safeguard from [#4466](4466-4507-landed-seven-test262-regressions-on-main.md)
intact. The focused spread and prior class-receiver probes passed, as did the
host half of the [#2804](2804-host-object-spread-assign-value-copy.md) suite
(10/10). This first step changed the eight original fixtures from **0/8** with
`null.exec` to **3 equal, 2 divergent, 3 errored**.

The three remaining traps had one shared stack shape:
`Tokenizer.{blockquote,list}` called the in-Wasm
`__call_m_blockTokens_{2,3}` dispatcher with an inline `[]`. Although the call
never left the module, its uniform externref ABI caused ordinary JS-host
coercion to run `__make_iterable`, replacing the raw Wasm vec with a host Array;
the dispatcher's required `ref.cast $__vec_externref` then trapped. The internal
argument helper now preserves inline array literals as raw vec externrefs, just
as it already did for identifier-held vecs. Host fallback remains correct
because `__extern_method_call` wraps raw vec arguments at the real boundary.

Fresh pinned `marked@18.0.2` result after both fixes:

| compile | diagnostics | binary | validation | exact fixtures |
|---:|---:|---:|---:|---:|
| passed | 0 | 4,171,028 bytes | valid | **4/8 equal, 4 divergent, 0 errored** |

The four byte-equal fixtures are `blockquote-hr.md`, `code-blocks.md`,
`emphasis.md`, and `headings.md`. No fixture now throws. The remaining work is
semantic rather than infrastructure: reference links lose their resolved
`href`/`title`, table bodies lose rows, and nested-list state drifts (the mixed
fixture reaches the same list/blockquote family). Focused Marked regressions
pass **3/3**. The upstream Hooks denominator remains **0/15** and must be
remeasured separately; this checkpoint does not claim the original unit suite
is green.

## 2026-08-24 checkpoint — resolved struct-field string `+=`

The largest shared semantic divergence in the remaining fixtures was Marked's
list token accumulator. Its inferred token object has an externref-backed
`raw` field and repeatedly executes `token.raw += chunk`. The unresolved-object
compound-assignment path already used JavaScript's dynamic `+` semantics, but
both resolved Wasm struct-field paths unconditionally coerced the field and RHS
to `f64`. Consequently the token's accumulated raw source became `NaN`, and the
lexer reparsed each unconsumed suffix as duplicate paragraphs and lists.

Resolved externref fields now use the existing ToPrimitive-aware dynamic `+`
dispatcher and store the resulting externref back into the struct. Numeric
fields and every other compound operator retain their prior lowering. A focused
closed-token regression reproduces the original `NaN` and now preserves both
string chunks; the focused Marked regressions pass **4/4**, and the existing
resolved/unresolved property-compound suites pass **10/10**.

Fresh pinned `marked@18.0.2` result with the original fixtures:

| | compile | diagnostics | binary | validation | exact fixtures |
|---|---:|---:|---:|---:|---:|
| before struct-field `+=` fix | passed | 0 | 4,171,028 bytes | valid | **4/8 equal, 4 divergent, 0 errored** |
| after struct-field `+=` fix | passed | 0 | 4,171,026 bytes | valid | **6/8 equal, 2 divergent, 0 errored** |

`lists.md` and `mixed-readme-like.md` are newly byte-equal; all four previously
green fixtures remain green. The two residuals are independent: reference
links/images lose the resolved `href`/`title` after lexer definition storage,
and table tokenization retains the regex capture but does not append body rows.
The original upstream Hooks denominator remains **0/15** and is not claimed by
this fixture-level checkpoint.

## 2026-08-24 checkpoint — final fixture carrier reductions

The two residual fixture mismatches reduce to independent, generic carrier
mistakes rather than Marked-specific output patches.

Reference definitions cross an open dictionary before entering the shared link
builder. A local identifier initialized from that dynamic member read remained
typed `any`, but call-site inference treated the name as transparent and let a
second object-literal call narrow the builder parameter to that literal's
nominal struct. Following the local initializer/alias chain and withdrawing
that speculative narrowing preserves the runtime definition record, including
its `href` and `title`. Plain forwarded parameters remain eligible for the
existing byte-vector narrowing.

Table bodies use the exact expression `match[3]?.trim()`. The optional-call
lowering captured `match[3]` once for the nullish check, then declined generic
dispatch because an element access cannot be re-evaluated without observable
effects. Its live branch therefore returned the default value and produced no
rows. The JS-host lane now calls `trim` through the ordinary dynamic method
bridge using the already-captured receiver, preserving both single evaluation
and the method's `this` value.

The combined reference/table carrier regression passes, and all focused Marked
regressions pass **7/7**. A concurrent direct-rest regression briefly exposed a
module-start failure in Marked's
`constructor(...extensions) { this.use(...extensions) }`: the direct known-rest
method path expanded the empty rest vector to element zero and called
`use(null)`. The generic rest ABI now forwards a sole trailing spread intact
when it starts exactly at the callee's rest index.

Fresh pinned `marked@18.0.2` result with the original fixtures unchanged:

| | compile | diagnostics | binary | validation | exact fixtures |
|---|---:|---:|---:|---:|---:|
| before final carrier fixes | passed | 0 | 4,171,026 bytes | valid | **6/8 equal, 2 divergent, 0 errored** |
| after final carrier + rest fixes | passed | 0 | 4,174,549 bytes | valid | **8/8 equal, 0 divergent, 0 errored** |

All six previously green fixtures remain byte-equal; `image-html.md` and
`table.md` are newly byte-equal. The broader optional-chain and native-string
adjacent suites plus the focused Marked tests pass **18/18**.
This closes the fixture carrier frontier measured by `marked-harness.mjs`; it
does not by itself claim that the separately adapted original Hooks suite is
fully green.

As an adjacent-control check, the [#4530 import-alias suite](4530-clsx-variadic-argument-classification.md)
is **10/11** on both this tree and clean base `f85b3bd520`: its pre-existing
`default === named` case traps with `illegal cast`. The identical clean-base
failure rules out the new dynamic-local-origin withdrawal as its cause.
