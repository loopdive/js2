---
id: 6980
title: "Native regime in a JS environment: iterator / generator protocol defects (custom iterables, generator .return(), async generator methods)"
status: in-progress
created: 2026-10-14
updated: 2026-10-14
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: compiler
language_feature: iterators, generators
goal: architecture
sprint: current
parent: 5385
related: [6708, 6979]
# 2026-10-14: the GetIterator/step arms live in iterator-native.ts (closed-struct
# closure-`next` arm + boundary host-object carrier test); runtime.ts carries the
# boundary-import exception wrapping hookup and the `any`-argument null fix;
# destructuring.ts excludes the native Map/Set struct from the vec probe;
# call-tail-dispatch.ts routes `x[Symbol.iterator]()` on a compiled method to the
# method and unwraps a generator record; generators-native*.ts carry the async-gen
# host-import gate, the nested binary-chain yield path and the `.return(v)` value fix.
loc-budget-allow:
  - src/codegen/iterator-native.ts
  - src/runtime.ts
  - src/codegen/statements/destructuring.ts
  - src/codegen/expressions/call-tail-dispatch.ts
  - src/codegen/generators-native.ts
  - src/codegen/generators-native-consumer.ts
func-budget-allow:
  - src/codegen/iterator-native.ts::buildIteratorBody
  - src/codegen/iterator-native.ts::fillNativeIteratorLateArms
  - src/runtime.ts::resolveImport
  - src/codegen/generators-native.ts::buildNativeGeneratorPlan
  - src/codegen/expressions/call-tail-dispatch.ts::compileTailDispatch
---

# #6980 — regime iterator / generator protocol in a JS environment

Surfaced by slice A of #6708 (default `semanticProviders: "native-first"`).
When the native regime is selected in a JS environment (exports read through
`wrapCompiledExports`), these `tests/equivalence/` rows fail:

- `issue-2033-custom-iterable-spread-destructure` — all eight custom-iterable spread / destructure rows
- `iterator-protocol-custom` — generator returned from `[Symbol.iterator]()` is itself
- `symbol-iterator-class` — bracket-access `[Symbol.iterator]`; object-literal computed key
- `issue-1454` — plain-array fast path; Map destructure; null/undefined throws; rest element
- `generator-return-method` — `return()` propagates the supplied value
- `issue-1388` — static async generator method, detached + iterator
- `yield-as-expression` — yield in template literal

Typical failure: "value is not iterable" on spread/destructuring of a user
object with `[Symbol.iterator]`.

## Acceptance criteria

- All rows above pass with `{ semanticProviders: "native-first" }` through
  `wrapCompiledExports`.
- Standalone output byte-identical or improved; equivalence gate reports no new
  regressions.
- Regression test `tests/issue-6980-regime-iterator-protocol.test.ts` covers
  each construct under native-first (JS environment) and `target: "standalone"`.

## Implementation notes

Each fix is on the native path shared with `target: "standalone"`. The
JS-environment-only arms are keyed on the boundary imports existing
(`__boundary_object_*`, i.e. native-first + JS value boundary), never on
`standalone || wasi`.

1. **Closure-valued `next` (issue-2033, 8 rows; standalone too).** `{ next: () => … }`
   lowers to a closed struct with a closure FIELD and no `<Struct>_next` method.
   `__iterator`'s tails only admitted `$Object`/`$Proxy` iterators or USER (method)
   records, so GetIterator threw "value is not iterable", or the USER
   `__call_next` read nothing (NaN). Now a truthy `__sget_next(iter)` makes it an
   OBJ record (`closedNextFieldObjArm`); the OBJ step already reads `next` via
   `__sget_next` on non-`$Object` carriers.
2. **Host iterables (issue-1454: array fast path, rest; JS environment).** An
   admitted JS array/Set reached the OBJ arm, but `__apply_closure` never called
   the host `@@iterator`: its `__boundary_object_apply` arm needs
   `__boundary_object_callable_kind`, which nothing registered. The iterator
   runtime now registers it (`ensureBoundaryCallableKind`, a no-op outside
   native-first + JS boundary). `objCarrierTest` also admits an admitted host object
   (non-null, not struct/array/i31) when the boundary exists, so the step,
   result and close reads go through `__extern_get` → `__boundary_object_get`.
3. **Boundary exceptions (keeps issue-1454's throwing-iterator rows).** A JS
   throw inside a boundary import was a foreign exception that the module's
   `try_table (catch $__exn)` cannot see. `withModuleTagThrow`
   (runtime/boundary-value-adapter.ts) rethrows it on the module's exported
   `__exn_tag`; uncaught, it unwraps back to the same JS error.
4. **Host `null` argument (issue-1454 null/undefined).** `_nativeDynamicFromHost`
   boxed null as a tag-0 `$AnyValue`, which no in-module null check recognises.
   `any` (dynamic) export arguments now pass null raw (`ref.null`). The boundary
   object adapter keeps the box, because there a raw null means "not admitted".
5. **Map/Set array destructuring (issue-1454 Map; standalone too).** The native
   `$Map` struct's field 1 is its entries array, so `getArrTypeIdxFromVec` called
   it a vec and the destructure read `$MapEntry` slots (null deref). `$Map` is now
   excluded and takes the externref GetIterator path.
6. **`x[Symbol.iterator]()` on a compiled method (symbol-iterator-class, 2 rows).**
   It always lowered to `__iterator(x)`, and natively that validates/wraps the
   result (a method returning 42 → "not iterable"). Under the regime, a receiver
   whose class/struct carries a compiled `@@iterator` method now falls through
   to the ordinary method call.
7. **Generator `@@iterator` identity (iterator-protocol-custom).** At an explicit
   `[Symbol.iterator]()` site, a GENSTATE/ASYNCGEN record is unwrapped back to
   its frame (§27.5.1: `return this`). USER/OBJ records are deliberately
   left alone.
8. **`gen.return(v)` value (generator-return-method).** The numeric-carrier result
   struct stores `value` as f64, so `"done"` → NaN. The opaque `.return`
   dispatcher re-issues a DONE result whose value is bit-identical to
   `__gen_numeric_payload(v)` of a non-number `v` as an externref
   `{ value: v, done: true }`. A `finally { return 7 }` keeps 7.
9. **Async generator `IteratorResult` reads (issue-1388).**
   `sourceNeedsGeneratorHostImports` counted every async generator as needing
   the legacy `__gen_*` imports, even in modules whose async gens all drive
   host-free (`moduleHasNonDrivableAsyncGen` false). `r.value`/`r.done` then
   routed to `__gen_result_value_f64`: NaN in standalone, a policy rejection
   under native-first. Such async gens no longer count.
10. **Yield nested in a binary chain (yield-as-expression, template row).**
    `"a" + (yield) + "b"` is `(("a" + yield) + "b")`. The #680 continuation's
    binary arm only looked at direct children. `sequencedBinaryYieldPath` descends
    the single yield-holding path and keeps each yield-free sibling whole, so it
    is captured (operators included) before the suspension, in §13.15.3 order.

Residuals deliberately left out:
- `yield-as-expression` "yield with value used as expression" is a TypeScript
  diagnostic (`Type 'undefined' is not assignable to type 'number'`) in every
  mode, host included. It is not a regime defect and not on this issue's list.
- A boundary-object property read that returns null (`hostObj.x === null`) still
  sees the tag-0 box (the adapter's null-means-miss protocol); pre-existing.
- `e instanceof Error` is false for a host Error caught in-module; pre-existing.
- `for (const v of new G())` where `G` has `*[Symbol.iterator]()` throws under
  nf/sa on main as well; not on this issue's list.
