---
id: 6701
title: "standalone: remaining `any`-receiver Array gaps — `splice` answers null, `[].slice.call(arguments, k)` is empty, `Math.max.apply(null, arr)` is -Infinity"
status: done
sprint: current
created: 2026-09-27
updated: 2026-09-27
completed: 2026-09-27
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6683, 6447, 2717, 2933]
loc-budget-allow:
  # 2026-09-27 (#6701) — the mechanisms live in two new modules,
  #   `src/codegen/array-splice-native.ts` (splice) and
  #   `src/codegen/apply-closure-variadic-builtin.ts` (variadic builtin arms),
  #   plus helpers added to `array-slice-native.ts`. The god-files only gain
  #   their call sites: array-object-proto.ts +6 (2 imports, the splice body
  #   hook, the slice end-default + array-like fallback calls, the variadic
  #   member flag); calls.ts +6 (the omitted-`end` undefined pad predicate and
  #   its 3-line rationale); closure-exports.ts +4 and object-runtime.ts +3
  #   (one import + the arm's call site each).
  - src/codegen/array-object-proto.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/closure-exports.ts
  - src/codegen/object-runtime.ts
func-budget-allow:
  # 2026-09-27 (#6701) — each function gains only the call to the new arm
  #   builder in apply-closure-variadic-builtin.ts: the `__call_fn_method_<n>`
  #   dispatcher +3 (comment, restore tail, push) and `__apply_closure` +2
  #   (build + splice into the body).
  - src/codegen/closure-exports.ts::emitClosureMethodCallExportN
  - src/codegen/object-runtime.ts::fillApplyClosure
---

# #6701 — standalone: remaining `any`-receiver Array gaps

## Problem

Found while fixing [#6683](./6683-standalone-any-array-slice-returns-null.md)
(which served `slice`/`at`/`reverse` on an `any` receiver). Measured
2026-09-26 on the #6683 branch, `--target standalone`, zero imports:

```js
function id(v) { return v; }
id([1, 2, 3]).splice(0, 2);                          // null      (expected [1, 2])
function f() { return [].slice.call(arguments, 1); }
f(1, 2, 3).length;                                    // 0         (expected 2)
Math.max.apply(null, [3, 9, 1]);                      // -Infinity (expected 9)
```

- `splice` is the last pure-ish producer with no `$__vec_base` arm in the
  closed-method dispatcher (`dyn-array-producers.ts`); it is pinned as the
  residual in `tests/issue-6447-standalone-dynamic-array-producers.test.ts`.
  It mutates length, so it needs a shrink/grow primitive on the array-like
  substrate, not only `__extern_set`.
- `[].slice.call(arguments, k)` does not reach `__arrprod_slice`; the
  `.call` form on an `arguments` object answers an empty array.
- `Math.max.apply(null, arr)` folds nothing — the variadic Math closure is not
  fed the spread array through `.apply`.

## Acceptance

- The three rows answer the Node values in `--target standalone`, no new host
  import; remove the `splice` pin in the #6447 test.

## Implementation Plan

Executed as written, 2026-09-27. Three independent defects, one per row.

1. **`splice` on an `any` receiver** — new `src/codegen/array-splice-native.ts`:
   `__arrprod_splice(recv, argsVec)` (§23.1.3.31) on the array-like substrate
   (`__extern_length`/`__extern_get_idx`/`__extern_has_idx`/
   `__delete_property`, and `__extern_set_strict` for every `Set(O, P, V, true)`,
   which grows a vec on an index store at/after the end and truncates on the
   final `length` store). Registered in `DYN_ARRAY_PRODUCER_METHODS` (every
   arity), so the closed-method dispatcher's `$__vec_base` producer arm serves
   it. It throws the step-8 TypeError (result length > 2^53 − 1) BEFORE any
   shift and the ArrayCreate RangeError (deleteCount > 2^32 − 1). The
   reflective `Array.prototype.splice` VALUE, which refused with "not yet
   callable as a value", now takes the packed-args vec ABI
   (`memberIsVariadic`, standalone only) and calls the same helper.
2. **`[].slice.call(arguments, k)`** — two faults in the reflective
   `Array.prototype.slice` closure: the reflective call site padded the
   omitted `end` with `null` (⇒ ToIntegerOrInfinity 0 ⇒ empty), and a non-vec
   `this` (an `arguments` object, `$ObjVec`, open object) returned the
   receiver itself (the guard's host arm leaves `this` on the stack and the
   `ref.null` pushed after it was dropped). Fix: pad `end` with the canonical
   `undefined` (calls.ts, standalone Array `slice` only) and map `undefined` to
   INT32_MAX in the closure body; serve a non-vec `this` with
   `__arrprod_slice(this, [begin, end])`. `__arrprod_slice` gains the
   ArrayCreate RangeError for a count > 2^32 − 1 (was a trap in
   `__objvec_push`).
3. **`Math.max.apply(null, arr)`** — the variadic builtin value closures
   (`Math.max`/`Math.min`/`String.fromCharCode`, #2933) take ONE
   `(ref null $vec_externref)` param. Only the direct-call site packed it;
   `__apply_closure` (every `.apply`, `Reflect.apply`, dynamic `.call`) and the
   `.call` fast path's `__call_fn_method_<n>` ran the body with a null vec.
   New `src/codegen/apply-closure-variadic-builtin.ts` adds one front arm to
   each: `ref.test` the variadic wrapper + func type, pack the argument
   carrier into a fresh vec, `call_ref`. Modules with no such value read emit
   nothing.

JS-host is untouched: every change is gated on `ctx.standalone`
(the apply/dispatcher arms on `ctx.standalone || ctx.wasi`).

## Resolution

All three rows answer the Node values in `--target standalone` with zero
imports (`[1, 2]`, length 2, `9`), and the #6447 `splice` pin is now a
passing assertion.

- Regression tests: `tests/issue-6701-any-receiver-residuals.test.ts` (11).
  On the parent 10 fail; with the fix 11 pass. The control (a user function's
  `.apply`, `String.fromCharCode.call`) passes both ways.
- Scoped standalone test262 (`Array.prototype.{slice,splice}`,
  `Function.prototype.{apply,call}`, `Math.{max,min}`, `String.fromCharCode`,
  286 rows, `scripts/run-test262-paths.mts --standalone`): parent 221 pass →
  fix 239 pass, **+18, 0 losses**. The gains are the 11 generic `slice` rows
  (array-like `this`, RangeError for a count > 2^32 − 1) and 7 `splice` rows
  (the reflective value, `set_length_no_args`, `clamps-length-to-integer-limit`,
  `create-non-array*`). 26 rows fail both ways because the quickjs eval provider
  is not built locally.
- JS-host is byte-identical: 16 modules (the four #6701 shapes plus the
  playground examples) hash the same on parent and fix.

npm-compat `standalone-dynamic` lane (`--no-write --perf-only`), parent
c2601efa89 → fix. **None of the four packages is unblocked by this change**;
each fails at the same point both ways:

| package | before | after | next blocker (verbatim) |
| --- | --- | --- | --- |
| hono | measured | measured | — |
| lodash | runtime-error (module-init) | runtime-error (module-init) | `TypeError: Cannot access property on null or undefined at 1468:21` |
| prettier | compile-error | compile-error | `Codegen error: native generator lowering currently supports only sequential numeric yields in standalone/WASI targets (#680). Recompile with a JS host target for complex generator shapes.` |
| jest | runtime-error (module-init) | runtime-error (module-init) | `uncaught Wasm-GC exception (non-stringifiable payload): raised by compiler-generated code (the module has no source throw, so no __exn_render_* exports; see #6666)` |

Residuals:

- [#6718](./6718-standalone-any-receiver-shift-unshift.md) — `shift`/`unshift`
  on an `any` receiver do not mutate (no dispatcher arm).
- [#6719](./6719-standalone-closed-literal-numeric-key-set.md) — an index store
  through the generic bodies misses a closed object literal's numeric field
  (`splice` `S15.4.4.12_A2_T1`–`T4`).
- The `Math.max`/`Math.min` value body answers 0 for string arguments
  (`m("3", "10")`), on the direct call path too — not introduced here.
- `arguments.length` is 1 inside a function with a rest parameter
  (`function f(...x) { return arguments.length }` → 1 for `f(1, 2, 3)`).
- Holes in `splice`'s deleted range come back as `undefined`, and species is a
  plain Array (as for #6683's `slice`).

