---
id: 4527
title: "axios: class rest dispatch bridge is fixed; finish the remaining dynamic callback ABI"
status: in-progress
sprint: current
created: 2026-08-16
updated: 2026-08-26
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: classes, rest-parameters
goal: npm-library-support
related: [3995, 4302]
loc-budget-allow:
  - src/codegen/array-methods.ts
  - src/codegen/array-nonindex-key.ts
  - src/codegen/closures.ts
  - src/codegen/context/types.ts
  - src/codegen/declarations.ts
  - src/codegen/default-expression-import-global.ts
  - src/codegen/index.ts
  - src/codegen/named-this-call.ts
  - src/codegen/property-access.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/expressions/call-tail-dispatch.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/statements.ts
  - src/codegen/statements/control-flow.ts
  - src/codegen/statements/tdz.ts
  - src/runtime.ts
func-budget-allow:
  - src/codegen/closures.ts::preferJavaScriptBodyArrayReturn
  - src/codegen/declarations.ts::jsArrayParamNeedsOpenObjectCarrier
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/named-this-call.ts::resolveObjectBindingFunction
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
  - src/codegen/expressions/calls.ts::calleeMayBeHostCallable
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/codegen/index.ts::emitIteratorMethodExport
  - src/codegen/index.ts::emitMethodDispatch
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/expressions/call-tail-dispatch.ts::compileTailDispatch
  - src/codegen/statements.ts::compileStatementInner
  - src/runtime.ts::resolveImport
  - src/codegen/index.ts::resolveWasmType
files:
  - src/codegen/array-methods.ts
  - src/codegen/array-nonindex-key.ts
  - src/codegen/closures.ts
  - src/codegen/context/types.ts
  - src/codegen/declarations.ts
  - src/codegen/index.ts
  - src/codegen/default-expression-import-global.ts
  - src/codegen/named-this-call.ts
  - src/codegen/property-access.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/expressions/call-tail-dispatch.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/statements.ts
  - src/codegen/statements/control-flow.ts
  - src/codegen/statements/tdz.ts
  - tests/dogfood/axios-upstream-suite.mjs
  - tests/issue-1279.test.ts
  - tests/issue-4527.test.ts
  - tests/issue-4527-call-dyn-bridge.test.ts
  - tests/dogfood/axios-upstream-suite-pin.json
  - tests/dogfood/upstream-suite-compile-worker.mjs
---

# axios: the vararg class-method dispatch bridge for `concat` is fixed

## Problem

The original class-rest defect is fixed generically in the dispatch bridge.
The reduced two-class case now compiles and validates, and all 33 selected
Axios modules compile and validate. The remaining limitation is later in the
same host callback path: 208 callbacks stop during module initialization when
an erased numeric callback bridge invokes a Wasm closure with a reference
argument.

The fresh selected slice registers 231 original callbacks: native 231/231,
Wasm 21/231 passed, 2/231 scored assertions failed, and 208/231 stopped in
module initialization. Sixteen other upstream files (414 registrations) stay
explicitly deferred as unavailable infrastructure. Measured 2026-08-21 on the
current Axios pin.

## Mechanism

`__class_call_concat_vararg` uses a per-struct `ref.test` cascade. The old
bridge reused a receiver local across arms and included the receiver slot in
the fixed-parameter slice, so one arm could store a different class type and
the generated call had the wrong stack shape. The fix uses the receiver's
Wasm-indexed rest metadata, counts only fixed user parameters, and reloads the
cast receiver immediately before the `(receiver, rest-vector)` call. It is
generic and covers same-named rest methods on unrelated classes.

## Reproduction

```bash
node --import tsx tests/dogfood/axios-upstream-suite.mjs
```

## Implementation Plan (Fable; implement per the plan/implement split)

1. **Reduce**: two classes, each with `concat(...xs: any[])` of different
   field shapes, both dynamically called through the host bridge (export the
   instances). Compile with the same options the harness uses; expect the
   identical `local.set` type error. Commit the reduction as
   `tests/issue-4527.test.ts` asserting `WebAssembly.validate` on the binary.
2. **Fix in `emitMethodDispatch`** (src/codegen/index.ts, vararg arm,
   `arity === -1`): the receiver local that holds the `ref.cast` result must
   be per-arm (declare one local per struct type in the cascade) or the cast
   result must stay on the stack for the immediate `call` instead of a
   `local.set`. Follow whichever pattern the fixed-arity arm already uses —
   the error appearing only in the `_vararg` bridge says the fixed-arity
   cascade handles this correctly; mirror it.
3. **Check the `settle` variant** (`call[0] expected (ref null 35)`): same
   cascade, mismatch surfaces at the call instead of the local store — one
   fix should cover both; assert both files validate.
4. **Validation gates**: (a) the reduction test is present and green; (b) the
   Axios harness keeps all 33 selected modules validated and records the exact
   21/231 Wasm result; (c) equivalence and the host-bridge arity tests stay
   green. The remaining callback ABI work is tracked separately below.

## Remaining callback ABI checkpoint

The runtime now normalizes a WasmGC closure before invoking the existing
`__call_1_f64`/`__call_2_f64` host bridge. This removes the misleading
`fn is not a function` failure, but the bridge still carries its argument as a
number. Axios's `typeOfTest` callback receives a string element and then fails
at `toLowerCase`. A reference-preserving bridge must be registered before the
function-index freeze and must preserve closure identity through module init;
an experimental late bridge exposed a null-closure trap and was intentionally
not retained. Do not count this as fixed until a focused reduction passes both
module initialization and callback execution.

## Acceptance criteria

### Current checkpoint (2026-08-21)

The selected 33 modules all compile and validate. The reduction is committed.
The exact fresh result is 21/231 Wasm callbacks passed, 2/231 scored failures,
and 208/231 module-initialization failures; 16 upstream files remain deferred
as unavailable infrastructure. The remaining checkbox is the reference-valued
callback ABI, which must be fixed without a module-init closure trap.

- [ ] All 25 axios test modules validate.
- [ ] Reduction test committed; general fix, no axios-specific casing.
- [ ] Fresh axios pass/total recorded in this file after the fix.

## 2026-08-21 checkpoint (curated-npm-tests lane)

The reference-preserving bridge the previous checkpoint asked for is landed as
the `__call_dyn_<n>` host-import family (src/runtime.ts) plus a codegen arm in
`compileIdentifierCall`'s final fallback (call-identifier.ts): a call on a
KNOWN `any`-typed variable that no dispatch arm claimed — the cross-module
callback case, where the callee module compiles before the caller's arrow
exists so `ctx.closureInfoByTypeIdx` has no candidates — now crosses the host
boundary with the callee and every argument as externref (i32/f64 boxed and
unboxed host-side, reference args LIVE) instead of lowering to the graceful
`ref.null.extern` that silently never invoked the callee.

Reduction tests: `tests/issue-4527-call-dyn-bridge.test.ts` (cross-module
arrow callbacks; diff-sequences-shaped index loop — both exact previously-
failing shapes). No module-init closure trap: the bridge is call-site-emitted,
no function-index freeze interaction.

Remaining for this issue: re-measure the axios suite (the 21/231 checkpoint
predates this bridge) and the in-body null-deref cluster that the bridge does
not address (diff-sequences' real `diffSequence` internals still null-deref —
that is a capture/carrier defect, not a call-boundary one).

## 2026-08-24 checkpoint (destructured inline-IIFE parameters)

Axios's shared `utils.hasOwnProperty` helper exposed a separate generic
inline-IIFE defect:

```js
const hasOwnProperty = (({hasOwnProperty}) =>
  (object, property) => hasOwnProperty.call(object, property)
)(Object.prototype);
```

The inline fast path stored the argument only in a synthetic `__iife_p0`
local. It never initialized the binding pattern, so the returned closure had
no lexical `hasOwnProperty` to capture. Its read fell through to the
same-named module global being initialized with that closure, and `.call`
recursively invoked the closure itself until the stack overflowed. The generic
fix now applies the existing object/array parameter destructuring machinery
after all IIFE arguments and the `arguments` object have been prepared, before
the body is compiled.

Measured on the exact pinned Axios 1.16.1 files after the fix:

- focused compiler regression: 13/13 passed, including the ordinary capture
  and same-named-module-binding cases;
- `tests/unit/utils/merge.test.js`: 8/9 passed (previously 0/9; the remaining
  `should support caseless option` is an assertion-value mismatch);
- `tests/unit/helpers/formDataToJSON.test.js`: 0/8 passed, but all 8 now run to
  assertion comparison with zero runtime failures instead of stack-overflowing.
  Its remaining failures are result-shape/value mismatches, not this call loop.

## 2026-08-24 checkpoint (default-expression imports and current Axios census)

An imported `default` whose source module exports an expression could be
silently rebound by the graph-wide name registries. In the reduced case,
`import bind from "./bind.js"` selected an unrelated same-named `bind`
declaration instead of the source module's default-expression global. This
made `Function.prototype.bind` either non-callable or gave its derived
`hasOwnProperty` helper the wrong identity.

The generic reduction now resolves that import through the TypeScript symbol
of its exact `export default <expression>` declaration and reads the matching
module global before consulting the legacy name-keyed function/closure maps.
The exact reductions in `tests/issue-4527-call-dyn-bridge.test.ts` are green:

- a default import stays distinct from an unrelated same-named function;
- `Function.prototype.bind` remains callable in a default-export fallback;
- the derived bound `hasOwnProperty` remains callable across modules and
  before a dynamically read alias table.

The final unfiltered pinned Axios run on the combined shared tree improved
from the last honest **61/231** baseline to **135/231** original tests passing
in Wasm. The fresh split is 135 passed and 96 scored failures, with zero
suite-level runtime failures; native remains 231/231. Thirty-two of 33
admitted modules compile and validate. Sixteen upstream files (414
registrations) remain explicitly deferred as unavailable infrastructure. This
+74 result is a combined-tree measurement and is not attributed solely to the
default-import fix.

The former `mergeConfig` module-initialization frontier at
`lib/defaults/index.js:173` (`utils.forEach`) was cleared by the concurrent
generic object/array carrier work recorded below. The file now executes its
whole original suite and passes **27/57**; the remaining 30 callbacks report
`null is not a function`, so the next reduction starts in the in-test merged-
property callback path, not in module initialization. The one admitted module
that still does not complete compilation is `composeSignals.test.js`: a
timer-driven Wasm callback dereferences null/undefined after compilation. Any
follow-up must remain generic and must not special-case Axios names.

Two adjacent residuals remain deliberately unclaimed by this checkpoint:
the CommonJS `Function.prototype.bind || implementation` reduction in
`tests/issue-1279.test.ts` returns false, and host `Object.getPrototypeOf`
results do not yet compare identical to the imported host prototype. Neither
case traps in the focused reductions.

## 2026-08-24 checkpoint (Axios array/object carriers and caseless merge)

The two remaining exact upstream slices are now green against the original
Axios 1.16.1 tests:

- `tests/unit/helpers/formDataToJSON.test.js`: **8/8 Wasm**. Axios's stale
  `@returns {Array<boolean>}` on `matchAll` no longer destroys the actual
  `RegExp.exec()` match arrays: JavaScript closure returns prefer the body's
  representation-safe array carrier when its element representation conflicts
  with JSDoc, and inline `map` callbacks use that carrier. Dynamic string keys
  on JS-host native vecs now take the host property bridge, preserving named
  array expandos such as `target.bar`. A JSDoc `Array<any>` parameter that
  enumerates/string-indexes those named properties remains externref across the
  declaration ABI rather than copying only indexed elements into a native vec.
- `tests/unit/utils/merge.test.js`: **9/9 Wasm**. The last caseless assertion
  was receiver loss in `merge.call({caseless: true}, ...)` after
  `const {merge} = utils`. The named receiver trampoline now resolves an
  immutable object-destructured shorthand through its default-export object to
  the exact function declaration. Rest-parameter targets are admitted because
  the existing call lowering already packs source arguments into the target's
  declared vec ABI before invoking the trampoline.

Focused generic regressions cover stale JSDoc match arrays, named array
properties across a JSDoc array parameter, and both direct and imported-object
rest-function `.call` receiver preservation. No Axios source or test was
patched.

The full curated Axios run now passes **135/231** admitted original tests (up
from the 21/231 checkpoint). Native remains 231/231. Thirty-two of 33 selected
modules compile and validate; `composeSignals.test.js` is the one exception,
where an asynchronous timer callback throws after the isolated compile worker
has finished its scored test body. Sixteen files / 414 registrations remain
explicitly reported as unavailable infrastructure. This full count was
measured from the pinned `v1.16.1` suite after the focused 8/8 and 9/9 runs.

## 2026-08-25 checkpoint (two-hop default forwarding)

The exact `mergeConfig` slice had fallen back to **0/57** after compilation:
all 57 original callbacks were classified as runtime failures because module
initialization dereferenced a null `mime-db` value inside the transitive
`form-data` dependency. The producer is a normal CommonJS forwarding chain:
`mime-types` imports `mime-db`, whose `module.exports = require('./db.json')`
rewrite becomes a default import followed by `export default importedValue`.

Identifier-backed defaults previously had no expression-owned cell, so the
alias pass returned without connecting the consumer to the JSON value. Linked
non-entry modules now evaluate every `export default identifier` once in source
order into an exact allocator-owned snapshot cell. The cell and its TDZ flag
are keyed by `ExportAssignment`/`GlobalDef` identity, never published in the
graph-wide bare-name registries. Default imports resolve the exact cell through
the recorded import-declaration target; a cycle therefore throws at the
uninitialized read instead of acquiring an unrelated same-named export.

Forwarded top-level function values likewise resolve through the source
callable registry's declaration/unit/handle identity. This fixes two leaf
modules that both declare `function source()` without collapsing them into the
last bare-name entry. Reassigned function declarations are tracked by exact
declaration identity and decline that immutable fast path; an unrelated
same-named reassignment cannot hide an immutable callable leaf. Their
pre-existing cross-module live-binding gap is still follow-up work. Ambient
declarations are also excluded from source
module name registries, so `export default Infinity` cannot capture another
module's `Infinity` variable. A script's real same-source binding that
TypeScript resolves to a colliding ambient (for example `const name`) is
recovered only when the lexical declaration and Program ABI allocator identity
agree, preserving #2176 without reopening the cross-module name collision.
`new importedDefault()` uses the exact snapshot before any static
constructor-name routing on the JS-host lane; host-free dynamic construction
of this carrier is an explicit compile-time refusal.

Entry identifier defaults deliberately retain the established raw callable
Wasm export ABI ([#1074](1074-surface-esm-default-export-as.md)); this
slice changes only linked-module snapshots. Focused regressions cover the
physical CommonJS → JSON chain, post-export mutation, same-named callable
leaves, an unrelated reassigned same-named function, ambient-name collision, a
circular forwarding graph, and construction after replacement. The related
suites pass **36/36**, **5/5**, and the #2176 ambient-shadow suite passes
**13/13**. Filtered
runs can write to `DOGFOOD_AXIOS_REPORT_PATH`, so reductions no longer
overwrite the canonical 231-test report.

The exact pinned `tests/unit/core/mergeConfig.test.js` rerun now reaches all
callbacks again: **27/57 Wasm**, **57/57 native**, compile/validate **1/1**, and
zero suite-level runtime failures. The remaining 30 scored failures are 23
`null is not a function` results and seven object-identity assertion
mismatches; they are a separate frontier and were not chased in this slice.
## 2026-08-25 checkpoint (host-callback fallback materialization)

The 23 `mergeConfig` null-call failures had one generic cause. The callback
passed to `utils.forEach` captures `mergeDeepProperties`, a hoisted nested
`FunctionDeclaration` used only as the fallback of a dynamic strategy lookup.
The compiler allocated its stable function-value slot at function entry, but
host-callback construction eagerly materialized that slot only when the nested
declaration itself captured another local. A capture-free declaration was
therefore copied into the callback as the slot's initial null sentinel, and
`merge(a, b, prop)` failed before reaching any Axios assertion.

Host-callback construction now runs the existing hoisted-function materializer
for every captured binding before copying it. The materializer checks whether
the binding is an observed hoisted declaration and is a no-op for ordinary
locals, so this preserves lazy identity semantics without package-specific
dispatch. A focused regression covers a capture-free nested fallback that is
referenced only from inside an imported host callback; it fails with the same
`null is not a function` before the fix and returns the expected value after it.

Fresh results on the unchanged pinned Axios `v1.16.1` commit
`1337d6b537af`, after synchronizing with the current package branch and main:

- `tests/unit/core/mergeConfig.test.js`: **50/57 Wasm**, up from **27/57**;
  native remains **57/57**, compile/validate **1/1**, and the seven remaining
  failures are the pre-existing object-identity mismatches.
- Full admitted original suite: **150/231 Wasm**, up from a freshly reproduced
  **127/231** baseline on the same branch; native remains **231/231** and there
  are zero suite-level runtime failures.
- Compile/validate remains **32/33**. Sixteen upstream files / 414 registrations
  remain honestly reported as unavailable infrastructure.

Handoff: the next largest exact `mergeConfig` frontier is the seven
object-identity mismatches. Across the full 231-test denominator, 81 scored
failures and the separate asynchronous `composeSignals.test.js` compile-worker
failure remain. Do not attribute the older combined-tree 135/231 checkpoint to
this slice; the paired fresh comparison for this mechanism is 127 to 150.
## 2026-08-25 checkpoint (ordinary data-struct prototype identity)

All seven remaining `mergeConfig` failures came from the same generic
prototype-bridge mismatch. Axios deliberately passes `Object.create({})` as a
non-mergeable value. The first host `Object.getPrototypeOf` correctly returned
the original Wasm data struct by identity, but a second
`Object.getPrototypeOf` inspected that struct's physical host representation.
Opaque WasmGC structs have a null host prototype, so Axios's `isPlainObject`
mistook the ordinary `{}` prototype for a null-prototype dictionary and cloned
the value. The clone then failed Axios's original identity assertion.

The host `__getPrototypeOf` bridge now distinguishes physical representation
from ECMAScript `[[Prototype]]`. Explicit prototype records and fnctor-instance
prototype links still win first. For an otherwise-unlinked value, the bridge
uses the program-associated, positive `__is_data_struct` export to recognize a
named ordinary-object carrier and returns the host realm's
`Object.prototype`, as required by ECMA-262 §§20.1.2.2 and 20.1.2.12. It does
not infer from a negative classifier result: vecs, closures, foreign values,
and missing or stale bridge metadata retain their existing native fallback.
The standalone lowering is unchanged.

A focused reduction recreates Axios's callback-driven strategy lookup and
plain-object predicate without package-specific names or patched expectations.
The complete issue 4527 regression file passes **29/29**. The host-side ES5
prototype relations pass **4/4**, the data-classifier/fnctor prototype suites
pass **5/5**, and the authenticated classifier checks pass **2/2**.

Fresh results on the unchanged pinned Axios `v1.16.1` commit
`1337d6b537af`:

- `tests/unit/core/mergeConfig.test.js`: **57/57 Wasm**, up from **50/57**;
  native remains **57/57**, compile/validate remains **1/1**, and there are no
  runtime failures.
- Full admitted original suite: **158/231 Wasm**, up from **150/231** with no
  withdrawals. Besides the seven identity assertions, the same generic fix
  closes Axios's original `isPlainObject` validation. Native remains
  **231/231**, with zero suite-level runtime failures.
- Compile/validate remains **32/33**. Sixteen upstream files / 414
  registrations remain explicitly reported as unavailable infrastructure.
  Seventy-three scored failures and the asynchronous
  `composeSignals.test.js` compile-worker failure remain.

Open-PR audit: [PR 4849](https://github.com/loopdive/js2/pull/4849) contains
the shared Axios baseline and the previous checkpoints above. No other open PR
mentions Axios or issue 4527, and no open work overlaps this prototype bridge;
the generic fix remains necessary on top of that baseline.
## 2026-08-26 checkpoint (default-exported builtin-subclass constructors)

The largest remaining full-suite cluster was 25 instances of `null is not a
constructor`: Axios defines `class AxiosError extends Error`, assigns its
error-code constants as module-scope static properties, then exports the class
with `export default AxiosError`. TypeScript resolves a default import through
the inferred class symbol, but the linker deliberately replaced that target
with the exact default-expression snapshot cell. Compiling the bare identifier
into that cell produced `null` because an externref-backed builtin subclass has
no ordinary Wasm class-object singleton. Imported `new AxiosError(...)` then
fell into dynamic host construction with `null` as the constructor.

For an unreassigned class declaration, the default expression snapshots the
same compiled constructor identity for the module's lifetime. Import alias
registration now preserves that exact class declaration target, allowing the
existing compiled constructor, static-method, and `instanceof` paths to serve a
renamed default import. Directly reassigned class bindings conservatively keep
the expression-cell path instead, so `export default C` is not treated as a
live class declaration when source syntax can change `C`.

Axios also creates constants with `AxiosError.ERR_NETWORK = "ERR_NETWORK"`
rather than class-field syntax. Those statements were dropped from
`__module_init` because class declarations are neither function declarations
nor module globals, and builtin subclasses cannot fall back to a host class
object. A graph prepass now registers representation-neutral static cells for
direct module-scope assignments on unreassigned class declarations, while the
top-level statement collector retains the source-ordered writes. Declared
fields, methods, accessors, intrinsic `name`/`length`/`prototype`, class
expressions, and reassigned class bindings keep their existing paths.

The focused regression covers direct construction, a static factory, an
assignment-created static constant, Error-instance fields, and `instanceof`
through a renamed default import. The relevant import/class/module-init suites
pass **93/93**.

Fresh paired results on the unchanged pinned Axios `v1.16.1` commit
`1337d6b537af`:

- all **25/25** `null is not a constructor` results disappear;
- the full admitted suite improves **158/231 → 176/231 Wasm**, with **18
  improvements and zero withdrawals**; native remains **231/231**;
- all **33/33** admitted modules compile and validate, with zero suite-level
  runtime failures;
- sixteen upstream files / **414 registrations** remain separately and
  explicitly reported as unavailable infrastructure.

The 55 remaining scored failures are separate mechanisms. The largest exact
clusters are 11 iterable/destructuring failures in AxiosError redaction, seven
null property reads in `buildURL`, six mixed assertion-value mismatches, and
the Error-instance/prototype gaps exercised by `settle` and the Node
`util/types` checks. No Axios source, upstream expectation, cached answer, or
performance gate was changed.

Open-PR audit: [PR 4849](https://github.com/loopdive/js2/pull/4849) remains the
only open Axios-related PR and supplies this branch's shared baseline. It
touches the same broad compiler and regression files but does not implement
class-declaration default routing or assignment-created static cells; this
checkpoint remains a necessary continuation rather than duplicate work.

## 2026-08-26 combined integration report audit

The fresh combined report now measures **186/231 Wasm** and **231/231 Node** on
the unchanged admitted Axios denominator. The other **45/231** admitted rows
are scored compatibility failures; this branch-wide result is not attributed
to any one integrated slice. A paired comparison against the isolated
**176/231** Axios branch finds **10 improvements and zero withdrawals**: eight
original `settle` rows and both original `spread` rows. All **33/33 selected
modules compile and validate**. Separately, **414 registrations in 16 deferred
files** remain unavailable infrastructure and are not included in the 231
scored rows.
