---
id: 2583
title: "standalone: any-typed array method dispatch (indexOf/etc.) returns undefined — $__vec_base brand arm in __extern_method_call"
status: done
sprint: 65
created: 2026-06-21
updated: 2026-06-21
completed: 2026-06-21
assignee: sdev-vecdispatch
priority: high
feasibility: hard
reasoning_effort: high
model: opus
task_type: bugfix
area: codegen, runtime
language_feature: arrays, method dispatch, any-typed receivers
goal: host-independence
related: [1888, 2151, 1461, 2186]
origin: "2026-06-21 — deferred #1888 Slice-4 brand-arm residual, surfaced by sdev-strdispatch during s64 value-rep keystone work; #1888 itself is done (s61)."
---

## Problem

Standalone, an array method invoked on a genuinely-`any` receiver returns
`undefined` (→ `0`/`NaN` in numeric context) instead of running:

```ts
const a: any = ["x", "y"];
a.indexOf("y");   // → 0  (expected 1)
```

Repro confirmed failing on main HEAD (93e53919f), `--target standalone`:
`a.indexOf("y")` returns `+0`. The same gap affects every non-callback array
method (`lastIndexOf`, `includes`, `join`, `slice`, `concat`, …) when the
receiver's static type is `any` so the typed array-method fast path
(array-methods.ts) is not taken.

### Root cause (WAT-confirmed)

`["x","y"]` typed `any` compiles to a `$__vec_externref` struct (subtyping the
shared `$__vec_base` supertype) boxed to externref. `a.indexOf("y")` lowers to
the **closed-method dispatcher** `__call_m_indexOf_1`
(`src/codegen/closed-method-dispatch.ts`), whose per-struct arms only match
object-literal structs carrying an `<Struct>_indexOf` method (none exist for a
plain array). It therefore falls to the **bottom arm**, which forwards to:

```
__extern_method_call(recv, "indexOf", [args…])
```

`__extern_method_call` (`src/codegen/object-runtime.ts` ~L5613–5670) handles
ONLY the open `$Object` brand. Its non-`$Object` `else` arm
(object-runtime.ts:5660) is:

```ts
// Non-$Object receiver: brand arms ($Vec/string/Map/Set) are Slice 4;
// return undefined for now (never invalid Wasm).
else: [{ op: "ref.null.extern" }],
```

So a `$__vec_base` array receiver hits `ref.null.extern` → `undefined`. This is
the explicitly-deferred "#1888 Slice 4" brand-arm residual.

## Implementation Plan

### Approach

Add a `$__vec_base` brand arm to `__extern_method_call` that services the
non-callback array search/predicate methods by **reusing the existing native
helpers** the typed array-method path already composes:

- `__extern_length(recv) -> f64` — array length over an externref array
- `__extern_get_idx(recv, f64) -> externref` — positional element read
  (already has the `$__vec_base` arm, #2186; returns null out of range)
- `__extern_strict_eq(a, b) -> i32` — native `===` over two externrefs
  (`src/codegen/any-helpers.ts:280`, `ensureExternStrictEqHelper`)
- `__extern_same_value_zero(a, b) -> i32` — native SameValueZero for `includes`
  (`src/codegen/any-helpers.ts:318`)

This avoids re-deriving search logic and matches the semantics array-methods.ts
already ships for typed arrays (#1461/#54).

### Scope (Slice 1)

Cover the **argument-taking, callback-free search/predicate methods** that are
the high-frequency any-array failures and need no closure bridge:

- `indexOf` (§23.1.3.14) — Strict Equality, forward, default fromIndex 0,
  returns f64 index or -1
- `lastIndexOf` (§23.1.3.17) — Strict Equality, backward, default fromIndex
  len-1, returns f64 index or -1
- `includes` (§23.1.3.13) — SameValueZero, forward, returns boolean

Defer `join`/`slice`/`concat`/`map`/`filter`/`reduce` (callback or
allocation-producing) to a follow-up slice; note them in a `## Deferred`
section, do NOT widen Slice 1.

### Changes

**File: `src/codegen/closed-method-dispatch.ts`**

The cleanest insertion point is the dispatcher bottom arm, because the method
name is statically known there (one dispatcher per method name) and the search
arm can be specialized per method without a runtime string compare.

- In `fillClosedMethodDispatch` (line ~264), in the **fixed-arity** loop
  (line ~276), BEFORE building the open-`$Object` fallback `current` (line
  ~292), check whether `methodName` ∈ {`indexOf`, `lastIndexOf`, `includes`}
  AND `arity >= 1`. If so, prepend a `$__vec_base` brand arm to `current`:

  ```
  any = <already set in dispFn.body to local anyLocalIdx>
  if (ref.test $__vec_base) {
    v   = ref.cast $__vec_base       ;; the array
    len = __extern_length(recv)      ;; f64
    target = local.get 1             ;; the search element (externref arg0)
    ;; linear scan: i = 0..len-1 (or len-1..0 for lastIndexOf)
    ;;   eq = (includes ? __extern_same_value_zero : __extern_strict_eq)
    ;;        (__extern_get_idx(recv, i), target)
    ;;   if eq → return (includes ? box_boolean(1) : box_number(i))
    ;; not found → return (includes ? box_boolean(0) : box_number(-1))
  } else { <existing open-$Object fallback> }
  ```

  Get `$__vec_base` typeIdx via `getOrRegisterVecBaseType(ctx)` (already
  imported/used in object-runtime.ts; import it here). Box the f64 result via
  `__box_number` (already wired through `ci.boxNumIdx`); box the boolean via
  `__box_boolean` (fetch `ctx.funcMap.get("__box_boolean")`).

- Register the dependencies at **reserve** time, not fill time (the
  reserve-then-fill #1719 discipline — fill only READS funcMap). In
  `reserveClosedMethodDispatch` (line ~78), after `ensureObjVecBuilders(ctx)`,
  when `methodName` is one of the three search methods, also call:
  - `ensureExternStrictEqHelper(ctx)` (indexOf/lastIndexOf)
  - `ensureExternSameValueZeroHelper(ctx)` (includes)
  - ensure `__extern_length` and `__extern_get_idx` are registered
    (`ensureObjVecBuilders` already pulls `__extern_method_call`; verify it
    also pulls `__extern_length`/`__extern_get_idx` — if not, add the
    `ensureLateImport` calls here so the funcIdx is stable before fill).
  - ensure `__box_boolean` exists (`addUnionImportsViaRegistry(ctx)` if needed,
    matching the proxy runtime's pattern).

  Import `ensureExternStrictEqHelper` / `ensureExternSameValueZeroHelper` from
  `./any-helpers.js` and `getOrRegisterVecBaseType` from `./object-runtime.js`
  (or wherever it is exported — grep confirms object-runtime.ts uses it).

### Wasm IR pattern (indexOf $__vec_base arm)

```wasm
local.get $any
ref.test $__vec_base
(if (result externref)
  (then
    ;; len = __extern_length(recv)  (recv is param 0, externref)
    local.get 0
    call $__extern_length            ;; f64
    local.set $len_f64
    ;; i = 0
    f64.const 0
    local.set $i
    (block $found
      (loop $scan
        local.get $i
        local.get $len_f64
        f64.ge                       ;; i >= len ?  → exit not-found
        br_if 1                      ;; break out of block (fall to -1)
        ;; eq = __extern_strict_eq(__extern_get_idx(recv,i), arg0)
        local.get 0
        local.get $i
        call $__extern_get_idx        ;; externref element
        local.get 1                   ;; search target (arg0)
        call $__extern_strict_eq      ;; i32
        (if
          (then
            local.get $i
            call $__box_number        ;; return externref index
            return))
        local.get $i
        f64.const 1
        f64.add
        local.set $i
        br 0))
    f64.const -1
    call $__box_number)              ;; not found → -1
  (else <existing open-$Object fallback> ))
```

`lastIndexOf` iterates `i = len-1` down to `0` (decrement, `f64.lt 0` exit).
`includes` uses `__extern_same_value_zero` and returns `__box_boolean(1)` on
hit, `__box_boolean(0)` otherwise.

### Edge cases

- **Empty array** → `len = 0`, loop never enters → `indexOf`/`lastIndexOf`
  return -1, `includes` returns false. Correct.
- **fromIndex argument** (`indexOf(x, 3)`): Slice 1 dispatches the `arity == 1`
  dispatcher only. A 2-arg call lands on `__call_m_indexOf_2`, a SEPARATE
  dispatcher — leave that on the existing fallback for now and note in
  `## Deferred`. (Do NOT silently ignore arg1.)
- **NaN search target**: `indexOf(NaN)` must return -1 (Strict Equality,
  NaN≠NaN — `__extern_strict_eq` already gives this); `includes(NaN)` must
  return true if present (SameValueZero — `__extern_same_value_zero` gives
  this). This is exactly why the two helpers are split.
- **Mixed-type elements** (`[1,"x",true]`): `__extern_get_idx` returns the
  boxed element; `__extern_strict_eq` recovers tags via `__any_from_extern` and
  compares with no cross-type coercion. Correct.
- **`$Object` array-like receiver** (`{0:"x",length:1}` typed any): NOT a
  `$__vec_base` → falls to the existing open-`$Object` fallback arm unchanged
  (no regression).
- **wasi target**: `__extern_get_idx`'s `$Object` array-like delegation arm is
  standalone-gated (object-runtime.ts), but the `$__vec_base` arm itself is
  representation-direct. Gate this whole brand arm on `ctx.standalone` to match
  the surrounding any-method machinery; do not extend to wasi in Slice 1.

### Test plan

Add `tests/issue-2583-any-array-method-brand.test.ts` (standalone harness,
mirror `tests/issue-2358-array-toprimitive.test.ts`'s `runStandalone`):

- `const a:any=["x","y"]; a.indexOf("y")` → 1
- `const a:any=["x","y"]; a.indexOf("z")` → -1
- `const a:any=["x","y","x"]; a.lastIndexOf("x")` → 2
- `const a:any=[1,2,3]; a.includes(2)` → true
- `const a:any=[1,2,3]; a.includes(9)` → false
- `const a:any=[NaN]; a.indexOf(NaN)` → -1 (StrictEq)
- `const a:any=[NaN]; a.includes(NaN)` → true (SameValueZero)
- `const a:any=[]; a.indexOf("x")` → -1 (empty)
- regression: typed `const a:string[]=["x","y"]; a.indexOf("y")` → 1 (still
  the fast path, unchanged)
- regression: open-$Object method still dispatches (`const o:any={m(){return 5}};
  o.m()` → 5)

Scoped local check before PR; CI validates conformance. Expect a positive
test262 delta in `built-ins/Array/prototype/{indexOf,lastIndexOf,includes}/`.

## Implementation Notes (sdev-vecdispatch, 2026-06-21)

The spec's `$__vec_base` brand-arm design was implemented as written, but
WAT-probing the actual lowering on `04ef72a7c` revealed the spec's *routing*
assumption was incomplete, and a *second, deeper* substrate bug. Both had to be
fixed for the repro to pass.

### Finding 1 — the dispatcher is never reached (routing intercept)

The spec assumed `a.indexOf("y")` reaches `__call_m_indexOf_1`'s bottom arm
(forwarding to `__extern_method_call`). It does NOT. For an `any` receiver and a
STRING_METHODS name, `compileMethodCall` (calls.ts ~L8926) fires FIRST through
`compileGuardedNativeStringMethodCall` (string-ops.ts): a runtime
`ref.test $AnyString` guard whose **then**-arm runs the native string method and
whose **else**-arm (non-string receiver) returned a *benign default* (`0`/`NaN`).
The array case lands in that else-arm and silently got `0` — the dispatcher was
emitted but dead for this path.

**Fix:** route the guarded else-arm through the closed-method dispatcher for
`indexOf`/`lastIndexOf`/`includes` (arity ≥ 1, standalone/wasi): build
`__call_m_<m>_<arity>(recvExt, …boxedArgs)` and **unbox** its boxed-externref
result back to the string-arm's result ValType (`__unbox_number` → f64 →
`i32.trunc_sat_f64_s` for index methods; `__unbox_boolean` for `includes`). For
any non-string, non-array receiver the dispatcher's terminal `ref.null.extern`
unboxes to the SAME benign sentinel as before → no regression
(`closed-method-dispatch.ts` brand arm + `string-ops.ts` else-arm).

### Finding 2 — `__any_strict_eq`/`__any_eq` tag-5 string compare was host-only

With the dispatcher reached, NUMBER-element arrays worked but STRING-element
arrays still missed every element. Root cause: the dispatcher compares via
`__extern_strict_eq` → `__any_strict_eq`, whose **tag-5 (string)** arm compared
content via the **`wasm:js-string equals` host import** (`strEqualsIdx`). In
standalone/wasi that import is ABSENT (`strEqualsIdx === -1`), so the arm
collapsed to `i32.const 0` — two equal boxed strings always compared *unequal*.
This was a latent standalone substrate bug in `__any_strict_eq` **and**
`__any_eq` (identical arms), not specific to arrays; any boxed-string `===`
routed through `__any_strict_eq` was broken standalone. (`a === b` on bare
identifiers worked because it uses the *static* `===` lowering with native
`__str_equals`, a different path.)

**Fix:** `tag5StringEqThen()` in `any-helpers.ts` prefers the host import when
present (gc/host mode, unchanged) and otherwise falls back to a **native** path:
recover each operand's tag-5 `externval` (`extern.convert_any` + `ref.cast
$AnyString`), `__str_flatten` to `$NativeString`, then native `__str_equals`.
Shared by both `__any_eq` and `__any_strict_eq`. This also covers the tag-5 arm
that #2585 touches — kept minimal and content-only here, no `ref.eq`
short-circuit added (that is #2585's scope).

### Verified

All slice-1 cases + NaN (StrictEq vs SameValueZero), empty, mixed-type, and the
typed-array / string-receiver / open-`$Object` regressions pass standalone
(`tests/issue-2583-any-array-method-brand.test.ts`, 17/17). The array-method
equivalence suite (`array-externref-indexof`, `array-prototype-methods`, …) and
the string/eq regression files (`issue-2503b`, `issue-1461-*-search`,
`issue-2186`, `issue-2190`, `issue-2063`, `issue-1910d`) stay green.

`tests/issue-2081.test.ts` fails identically WITH and WITHOUT this change
(verified by reverting all three source files) — a pre-existing
`__defineProperty_value` late-import index-shift (#2043 class) on wasi loose-eq,
out of scope here.

### Deferred (follow-up slice)

- 2-arg forms `indexOf(x, fromIndex)` (land on `__call_m_<m>_2`, not yet a brand
  arm — kept on the existing fallback; not silently mis-evaluated).
- callback/allocation methods `join`/`slice`/`concat`/`map`/`filter`/`reduce`.
