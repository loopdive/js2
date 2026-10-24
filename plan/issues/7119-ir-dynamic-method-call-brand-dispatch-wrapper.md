---
id: 7119
title: "IR: brand-dispatch wrapper for method calls on dynamic receivers (host-free lanes)"
status: in-review
sprint: current
created: 2026-10-22
updated: 2026-10-22
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
  - src/codegen/ir-dynamic-construct.ts # the wrapper builder joins the S3a/S3c wrappers
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/select.ts
  - src/ir/backend/legality.ts
func-budget-allow:
  - src/ir/integration.ts::makeFromAstResolver
  - src/ir/integration.ts::preregisterDynamicSupport
  - src/ir/from-ast.ts::lowerMethodCall
  - src/ir/select.ts::dynamicUsesAreMoveOnly
  - src/ir/select.ts::scanExprInner
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

## Fix

A per-(method, arity) runtime wrapper, `__ir_dyn_mcall_<m>_<n>(recv, a0, …) ->
externref`. Its parameters and result are the dynamic carrier, externref. It is
built once per (method, arity) from legacy's own emitters, over a fixed
template whose only free names are its parameters:

```
f = recv.m                        // the call's single [[Get]]
IsCallable(f) ? f.call(recv, a0, …)   // an own / inherited method value
              : recv.m(a0, …)       // legacy's any-receiver brand dispatch
```

- **Why the [[Get]] first.** Legacy's brand arms do not consult the receiver
  for a built-in name. Its `join` on any receiver is the generic array-like
  algorithm, so `{ join() {…} }.join()` and a constructor-prototype `join` came
  out wrong when the template was only `recv.m(…)` (measured). A built-in
  method of a primitive or vec receiver has no runtime value, so the read
  answers undefined there and the brand arm runs.
- **Why `__is_callable` is emitted directly.** A template `typeof f ===
  "function"` was folded to `false` by legacy, because a detached node has no
  checker type (measured: `i32.const 0`).
- **A runtime operation, not source.** The template text is a function of
  (method, arity) alone and lives in its own detached source file. No source
  expression is wrapped. This follows S3a's `__ir_dyn_construct_N`, and the
  builder lives beside it in `src/codegen/ir-dynamic-construct.ts`. The IR
  names the wrapper and passes the name in, so the builder adds no
  codegen→ir edge, and integration adds no new codegen import (the
  import-cycles and ir-layering ratchets are unchanged).

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
