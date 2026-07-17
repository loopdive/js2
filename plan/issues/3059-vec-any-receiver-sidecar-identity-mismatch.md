---
id: 3059
title: "codegen: concrete-vec any-receiver — dynamic property-write and dynamic method-call box the receiver with different host identities (sidecar prop lost); breaks aliased-function-property idiom (~19+ slice/toString test262)"
status: ready
sprint: Backlog
created: 2026-07-06
updated: 2026-07-06
priority: medium
feasibility: hard
model: fable
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: arrays, dynamic-dispatch, host-marshaling
goal: spec-completeness
related: [1359, 2836, 1135]
test262_bucket: array-getclass-aliased-toString
test262_count: 19
origin: "2026-07-06 harvest (dev-cycleB). origin/main; default (JS-host) lane. Distinct residual of #1359 (done); non-empty slice, not the zero-length-null case."
---

# #3059 — concrete-vec `any`-receiver: property-write vs dynamic-method-call box with different host identities

## TL;DR

When an array value with a **concrete** static type (e.g. the result of
`Array.prototype.slice`, whose local stays `(ref $__vec_*)` rather than
`externref`) is used as an `any` receiver, the compiler boxes it to the host
**inconsistently** across use sites:

- **dynamic property WRITE** (`arr.f = fn`) → plain `extern.convert_any` →
  the host sees the **raw wasmGC struct** (stable JS identity), stores `f`
  in `_wasmStructProps` keyed by that struct.
- **dynamic method CALL** (`arr.f()`) → `extern.convert_any` **+
  `__make_iterable`** → `__make_iterable`'s `convertToJS` **returns a brand-new
  JS array** (`new Array(len); … return arr`), i.e. a **different object
  identity**. The sidecar lookup `_sidecarGet(freshArray, "f")` misses → host
  throws `TypeError: f is not a function`.

So a function stored on a slice result and then invoked dynamically is lost.
This is the live root cause of the `arr.getClass = Object.prototype.toString;
arr.getClass()` idiom failing on **non-empty** slices (the zero-length-null
sub-case was already fixed by #1359).

## Reproduction (verified on current main)

```ts
export function test(): any {
  const x = [0, 1, 2, 3, 4];
  const arr: any = x.slice(3, 5);
  arr.f = function () { return 7; };
  return arr.f();            // → throws "f is not a function"
}
```

Matrix (identical body, only the array producer differs):

| producer          | `arr` local type  | store-fn + dyn-call |
|-------------------|-------------------|---------------------|
| `[3,4]` literal   | `externref`       | ✅ 7                |
| `x.slice(3,5)`    | `(ref null $vec)` | ❌ throws           |
| `[3,4].map(v=>v)` | `externref`       | ✅ 7                |
| `[].concat([3,4])`| `externref`       | ✅ 7                |
| `x.splice(3,2)`   | `externref`       | ✅ 7                |

Only `slice` keeps `arr` at the **concrete vec type** (`(local $arr (ref null
4))` in the emitted WAT); the others land it in `externref` and therefore
intern **once** via `__make_iterable` at the assignment, so every later use
shares that single fresh-array identity. `slice`'s vec-typed local is instead
re-boxed **per use**: the write site emits `extern.convert_any` (object-ops
deliberately avoids `__make_iterable` — see `object-ops.ts:3096/3673/3839`),
the call site emits `extern.convert_any; call $__make_iterable`. Different
objects ⇒ sidecar miss.

Note: plain **data** properties work on the slice result
(`arr.foo = 99; arr.foo === 99`) because read and write both box via plain
`extern.convert_any` (same raw-struct identity). Only the **method-call** path
diverges by adding `__make_iterable`.

## Why the local types diverge

`compileArraySlice` and `compileArraySplice` both `return { kind: "ref_null",
typeIdx: vecTypeIdx }`. The divergence is upstream in the checker-inferred type
of the initializer that decides the **declaration local type**: `x.slice(...)`
resolves to a concrete `number[]` (→ vec local), while `x.splice(...)` resolves
to `any`/externref. So this is a type-representation-consistency problem, not a
per-method codegen bug.

## Candidate fixes (all touch shared substrate — hence hard/fable)

1. **Unify the any-receiver boxing.** Make the dynamic method-call receiver box
   the same way as property read/write (plain `extern.convert_any`, no
   `__make_iterable`), and move the vec→JS-array materialization **inside** the
   host `__extern_method_call` — but only for native array builtins, after a
   sidecar lookup on the raw struct fails. Risk: the any-receiver method-call
   path is broad; every `anyval.method()` flows through it.
2. **Intern concrete-vec `any` bindings once.** When a value with a concrete vec
   type is stored into an `any`/inferred binding that later receives dynamic
   property writes, coerce it to `externref` (interned via `__make_iterable`)
   at the assignment, matching splice. Risk: perf (extra marshaling) + deciding
   "later receives dynamic writes" at declaration time.
3. **Give `__make_iterable` stable identity** by caching the fresh array per
   source struct and sharing the sidecar between struct and array. Risk: broad;
   `__make_iterable` is used pervasively (Map/Set/spread/#2836 acorn params).

Option 1 is the most principled; all three are substrate-level and cross the
host-marshaling contract (#2100), so this is `feasibility: hard` / `model:
fable`.

## Affected test262 (default lane, ~19 + related)

- `built-ins/Array/prototype/slice/S15.4.4.10_A1.{1..4}_T*.js` (the `arr is
  Array object. Actual: null`/throw idiom on non-empty slices) — ~15.
- `built-ins/Array/prototype/sort/S15.4.4.11_A3_T{1,2}.js` (plain-object
  receiver `[object Object]` variant).
- The same aliased-function-property idiom recurs across other categories
  wherever a concrete-typed value receives `x.method = <fn>; x.method()`.

## Acceptance criteria

1. The reproduction above returns `7`.
2. `built-ins/Array/prototype/slice/S15.4.4.10_A1.1_T5.js` passes.
3. `Object.prototype.toString` aliased onto a `slice()` result and invoked as a
   method returns `"[object Array]"`.
4. No regression in the any-receiver native method-call path (`arr.push`,
   `arr.map`, Map/Set iteration, #2836 acorn arrow params).
