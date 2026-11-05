---
id: 7119
title: "IR: brand-dispatch wrapper for method calls on dynamic receivers (host-free lanes)"
status: in-review
sprint: current
created: 2026-10-22
updated: 2026-10-29
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: feature
area: ir
goal: ir-full-coverage
parent: 7106
assignee: "ttraenkler/session-d"
depends_on: [7117, 7115]
# 2026-10-22 (#7119): the wrapper's resolver hook (+3 lines in
# makeFromAstResolver), its reservation in preregisterDynamicSupport, the
# from-ast routing in lowerMethodCall, the selector predicate and capability.
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/select.ts
  - src/ir/backend/legality.ts
# 2026-10-29 (revive onto main): #7113's carrier-method-call cut learns that a
# wrapped call throws its own TypeError (the walk's source hook + predicate).
  - src/ir/select-planned-closure-operands.ts
  - src/ir/analysis/operand-admissibility.ts
func-budget-allow:
  - src/ir/integration.ts::makeFromAstResolver
  - src/ir/integration.ts::preregisterDynamicSupport
  - src/ir/from-ast.ts::lowerMethodCall
  - src/ir/select.ts::dynamicUsesAreMoveOnly
# 2026-10-29 (merge of main after #6967): +3 is prettier wrapping the one added
# `wrapped` argument of `carrierMethodCallAdmissible` in the nested
# `callRefusal`; main's post-merge baseline re-set this ceiling below the size
# the PR already passed at.
  - src/ir/select-planned-closure-operands.ts::plannedClosureOperandRefusal
# 2026-10-24 (#7119 review): the builder is its own module,
# src/codegen/object-model/ir-dynamic-method-call.ts, which integration imports
# like the S3a/S3c wrapper module; the module joins the codegen SCC.
import-cycles-allow:
  - largestSccSize: 725 # 2026-10-29 (#7119, restated on main's 724): object-model/ir-dynamic-method-call.ts joins the SCC through integration
  - ir->codegen: 82 # 2026-10-29 (#7119, restated on main's 81): integration imports the method-call wrapper module
---

# IR: brand-dispatch wrapper for method calls on dynamic receivers

Parent: [#7106](7106-ir-test262-harness-units.md). Replaces the two stopgaps
that kept these calls legacy: #7110's `plannedClosureDynamicMethodCall` (member
closures) and #7117's `dynamicMethodCallIsExact` (top-level move-only
functions).

## Problem

On the host-free lanes (standalone, wasi, and the default JS lane, which is the
native regime and projects as standalone), the IR lowered `recv.m(args)` on a
dynamic receiver through `__ir_dyn_method_call_N` → `__extern_method_call`. The
native object runtime dispatches open-`$Object` / instance / closure methods
only. For a primitive or vec receiver it answers `undefined`
(`list.join(", ")`, `n.toString()`, `sym.toString()`), where legacy dispatches
by brand. The stopgaps kept every built-in method name legacy there, and with
it the harness line `message = message.toString();` (assert.js).

## Implementation Plan

- **Module.** `src/codegen/object-model/ir-dynamic-method-call.ts` holds the
  builder (one concern: this wrapper); `src/ir/dynamic-method-call-names.ts`
  holds the naming and the needs-wrapper predicate. Integration reserves the
  wrapper in `preregisterDynamicSupport` beside the S3a/S3c helpers.
- **Reuses.** The S3a/S3c helper-context, publish and sequence-capture helpers
  (`receiverHelperContext`, `publishReceiverHelper`, `captureReceiverSequence`
  in `ir-dynamic-construct.ts`, the capture gaining a `park` option); legacy's
  own any-receiver emitters through `compileExpression` over the template;
  `__is_callable` and `emitThrowTypeError`. The identifier predicate exists
  once (`METHOD_NAME`); codegen does not re-test the name.
- **Acceptance — correctness.** Every program in
  `tests/issue-7106-ir-dynamic-method-wrapper.test.ts` agrees with node on the
  standalone and default lanes, including a non-callable own property
  (TypeError), a nullish receiver, an own `undefined` property and an accessor
  read once; spread and arity > 3 are refused at select.
- **Acceptance — code quality.** No wrapper mechanics duplicated between this
  module and `ir-dynamic-construct.ts`; no predicate duplicated between
  codegen and the names module; no `loc-budget-allow` on a file the change
  shrinks; the ir-layering and import-cycles growth is paid in the baseline
  and this frontmatter, not avoided by placing code in a sibling file.

## Fix

A per-(method, arity) runtime wrapper, `__ir_dyn_mcall_<m>_<n>(recv, a0, …) ->
externref`. Its parameters and result are the dynamic carrier, externref. It is
built once per (method, arity) from legacy's own emitters, over a fixed
template whose only free names are its parameters:

```
f = recv.m
IsCallable(f)     ? f.call(recv, a0, …)   // an own / inherited method value
: f === undefined ? recv.m(a0, …)         // legacy's any-receiver brand dispatch
                  : throw TypeError       // a non-callable own property
```

- **Why the [[Get]] first.** Legacy's brand arms do not consult the receiver
  for a built-in name. Its `join` on any receiver is the generic array-like
  algorithm, so `{ join() {…} }.join()` and a constructor-prototype `join` came
  out wrong when the template was only `recv.m(…)` (measured). A built-in
  method of a primitive or vec receiver has no runtime value, so the read
  answers undefined there and the brand arm runs. A defined, non-callable
  value (`{ join: 1 }`) throws TypeError, as node does; before the review fix
  it fell through to the brand arm and ran the generic algorithm (measured).
- **Known limit: the brand arm re-reads.** `recv.m(a0, …)` is legacy's
  emission and performs its own [[Get]], so an accessor `m` whose getter
  answers undefined runs twice (node runs it once and throws).
- **Why `__is_callable` is emitted directly.** A template `typeof f ===
  "function"` was folded to `false` by legacy, because a detached node has no
  checker type (measured: `i32.const 0`).
- **A runtime operation, not source.** The template text is a function of
  (method, arity) alone and lives in its own detached source file. No source
  expression is wrapped. This follows S3a's `__ir_dyn_construct_N`; the
  builder is its own module, `src/codegen/object-model/ir-dynamic-method-call.ts`,
  sharing the helper-context, publish and capture helpers with
  `ir-dynamic-construct.ts`. The IR names the wrapper and passes the name in,
  so the builder adds no codegen→ir edge; integration's one new codegen
  import is banked in the ir-layering baseline and the import-cycles growth
  granted above.

### Routing (`src/ir/dynamic-method-call-names.ts`)

`irDynamicMethodCallNeedsWrapper(m, n)` is true for any built-in prototype
method name except `charCodeAt` (the string runtime's exact fast path), and for
any call with two or more arguments.

- **User method names with at most one argument** keep the generic open-`$Object`
  call. The #4780 devirtualization guard pins that ladder.
- **Selector.** `dynamicMethodCallIsAdmitted` admits a call that needs the
  wrapper only under the new `dynamic-method-call-wrapper` capability (wasmgc,
  non-fast, standalone/wasi). Host lanes keep `host-dynamic-method-call` for at
  most one argument, unchanged.
- **from-ast.** The dynamic branch of `lowerMethodCall` emits the wrapper call
  when the resolver's `dynamicMethodCallWrapper` agrees.
- **Integration.** `preregisterDynamicSupport` reserves each wrapper before
  Phase 3 and observes its Program ABI identity, exactly like the S3a/S3c
  helpers.

## Measured

`tests/issue-7106-ir-dynamic-method-wrapper.test.ts` compares every result with
node:

- **Top-level IR functions, standalone and default lanes.** 23 checks:
  - `toString` on number, boolean, string, symbol, vec, plain object, an own
    method, a fnctor instance with and without a prototype override;
  - `join`, `push` and `slice(a, b)` on vec, string, an own method and a fnctor
    prototype;
  - `f.call(t, a, b)` on closures and on function-object receivers (a
    declaration with an expando, and a bare one).
- **Planned member closures in `<module-init>`.** 15 checks, harness-shaped.
- **#7110's regression program** is now an IR initializer and returns 111.
- **#7117's t/u/k program** is now three IR bodies and returns 111111.
- **Honest harness census.** The unstubbed default harness's `<module-init>` is
  now blocked by row 2 alone (`array-method-unsupported`). With row 2 stubbed,
  every unit ships IR, including the real `message.toString()` line, and agrees
  with node.

## Not changed (pre-existing, measured)

- **Host-assisted lanes.** Under `JS2WASM_NATIVE_REGIME_JS=0` and the explicit
  host-assisted profile, the generic host `__extern_method_call` sees a vec as
  an opaque object, so `list.join("-")` is wrong there; this predates #7117.
  The wrapper is not used there: under the kill switch, the native-first
  adapter refuses `__js_array_new`, which the legacy emitters reach.
- **Legacy's own typed paths.** `function j(x, s) { return x.join(s); }` with x
  typed `number[] | {join}` is wrong for the vec. That function is legacy (the
  selector refuses `param-type-not-resolvable`), so it is not affected here.

## Revive onto main (2026-10-29)

Main merged #7117 (#6845) in its final form, #7113's operand walk (#7144) and
`helpers/ir-helper-function.ts`. On the merge:
- The #7117 stopgap `dynamicMethodCallIsExact` is deleted: this issue's
  `dynamicMethodCallIsAdmitted` lifts it (main's `host-dynamic-method-call`
  capability is kept for the host lanes).
- `receiverHelperContext` / `publishReceiverHelper` are dropped in favour of
  main's `helperFunctionContext` / `publishHelperFunction`; only the `park`
  option of `captureReceiverSequence` stays.
- The `dynamic-method-call-wrapper` capability shares the
  `native-number-conversion` lane predicate (one fall-through arm).
- #7113's `closure-carrier-method-call` cut refused `message.toString()` in
  assert.compareArray (the carrier join makes it a new shape). Its defect
  (#7177: the generic call answers a value where JS throws) does not apply to
  a wrapped call, which throws TypeError for a nullish receiver or a
  non-callable member. `carrierMethodCallAdmissible(receiver, wrapped)` now
  admits it; a user method name on the generic call stays refused.

## Wrapper-object receivers (2026-10-29, owner decision: option a)

`issue-6610`'s `wrapperReceiver` regressed: a primitive wrapper object
(`new Number(x)`, `Object(sym)`) can read a built-in method value through its
native prototype (#4248), and the own-method branch's reflective
`f.call(recv, …)` on it throws, where main kept the call legacy (#7117).
The wrapper now tests the receiver first: a `$Object` carrying the internal
`[[PrimitiveValue]]` slot with no OWN `m` takes legacy's brand branch
`recv.m(…)`; an own `m` on the wrapper, and every other callable `f`, keeps
the own-method branch. Two `__obj_find` lookups, as legacy's `__extern_get`
wrapper arm does; no host import, no target arm. Measured per method in
isolated modules: `toPrecision` on `new Number` went -1 → 1;
`toString`/`valueOf` on Number/String/Boolean/Symbol wrappers were and stay
correct; `toFixed` through any receiver throws on legacy too (pre-existing).

