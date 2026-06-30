---
id: 2891
title: "Standalone: ToPrimitive on a nominal struct accepts an object-returning valueOf — no valueOf→toString fall-through / no §7.1.1.1 TypeError"
status: done
completed: 2026-06-30
assignee: ttraenkler/sendev-toprim-ops
created: 2026-06-30
priority: high
task_type: bug
area: codegen
goal: standalone
sprint: current
horizon: m
related: [2873, 2862, 2638, 1900]
umbrella: 2860
---

# Standalone: object-operand relational/additive coercion drops the valueOf→toString fall-through

## Problem (verify-first, `--target standalone`, current main)

The dominant residual of #2873 `language/expressions` is object-operand
relational/additive coercion where `valueOf` returns a **non-primitive**
(an object). Real test262 reproductions (host pass / standalone fail):

- `language/expressions/less-than/S11.8.1_A2.2_T1.js` — `1 < {valueOf:()=>({}),
toString:()=>2}` should be `true`; standalone yields the wrong value.
- `language/expressions/addition/S11.6.1_A2.2_T1.js` — `1 + {valueOf:()=>({}),
toString:()=>({})}` must throw a TypeError (§7.1.1.1 step-6); standalone
  returns `NaN` (no throw).
- `greater-than/S11.8.2_A2.2_T1.js`, etc. share the signature.

(The runner reports these as `"Cannot convert object to primitive value"`,
which is the #2862 JS-host runner-formatter artifact masking the REAL
in-Wasm failure — a wrong comparison value / missing TypeError, NOT an
in-Wasm ToPrimitive throw. Verified host-free.)

Minimal host-free repros (`result.imports` empty):

- `1 < {valueOf:function(){return {}}, toString:function(){return 2}}` → `false` (want `true`).
- `1 + {valueOf:function(){return {}}, toString:function(){return {}}}` → `NaN` (want TypeError).

## Root cause

Statically-typed object literals stay nominal WasmGC structs. When the
inlined `valueOf` returns a ref (object), the static `ref→f64`/`ref→string`
coercion path (`type-coercion.ts`) correctly delegates to the runtime
`__to_primitive` engine, whose non-`$Object` arm routes the struct through
`__class_to_primitive` (`src/codegen/class-to-primitive.ts`, #2638), which
dispatches the per-struct `__call_valueOf` / `__call_toString` exports.

`fillClassToPrimitive` accepted the FIRST dispatcher's **non-null** result as
"a primitive was produced" — but `boxResult` for a ref/ref_null-returning
method does `extern.convert_any`, returning the **object itself** as a
non-null externref. So a `valueOf` that returns an object short-circuits the
driver: it returns the object, `__to_primitive`'s `returnIfPrimitive` then
rejects it, and the engine returns the struct unchanged → `__unbox_number` →
`NaN`. §7.1.1.1's "if the result is not primitive, try the next method" step
is skipped, and the both-objects TypeError is never thrown.

## Fix (standalone-only — GC/host path is untouched; driver is reserved only

under `ctx.standalone`)

Rewrite `fillClassToPrimitive` to implement §7.1.1.1 OrdinaryToPrimitive over
the dispatchers, **sequentially** (preserving method call ordering + side
effects, so a throwing `valueOf`/`toString` propagates correctly):

- Call the hint-ordered first method; if its result is non-null AND a
  primitive (`__typeof_number`/`__typeof_boolean`/`__typeof_string`), return it.
- Else call the second method; same primitive check.
- Neither produced a primitive — classify by **presence** to model the
  inherited `Object.prototype` methods that standalone does not materialize:
  - inherited `valueOf` returns the object (non-primitive);
  - inherited `toString` returns `"[object Object]"` (a primitive string).
  - number/default hint: valueOf-present-object + toString-absent →
    `"[object Object]"`; both present-object (or valueOf-absent +
    toString-present-object) → **TypeError**; both absent → unchanged.
  - string hint: toString-absent → `"[object Object]"`; toString-present-object
    - (valueOf present-object or absent) → **TypeError**.

## Test plan / acceptance

- `1 < {valueOf:()=>({}), toString:()=>2}` → `true`, host-free (`imports`
  empty); `1 + {both objects}` → TypeError, host-free.
- GC/host unchanged; 0 regressions; full `merge_group` + honest
  standalone-floor.
- NOTE: the bundled `_A2.2_T1` test262 files do NOT fully flip yet — see the
  "Residual" section (orthogonal `#7`/`#8` forked-closure + `instanceof`
  sub-problems, already failing on main).

## Outcome (2026-06-30, sendev-toprim-ops)

Implemented two standalone-only changes (GC binary byte-identical — verified
3028 bytes on main and fix for the repro):

1. **`fillClassToPrimitive`** (`src/codegen/class-to-primitive.ts`) — rewritten
   to do §7.1.1.1 sequentially: each dispatcher result is accepted only if it is
   a PRIMITIVE (`__typeof_number`/`__typeof_boolean`/`__typeof_string`); an
   object-returning method falls through to the next; the both-objects (or
   inherited-valueOf-object + present-toString-object) case throws the
   §7.1.1.1 TypeError, while valueOf-present-object + toString-absent yields the
   inherited `"[object Object]"`.
2. **`emitToPrimitiveMethodExports`** (`src/codegen/index.ts`) — single-literal
   object-method structs now get `__call_valueOf`/`__call_toString` entries in
   standalone (was forked-only), via a new GUARDED `closure-eqref-multi` dispatch
   that `ref.test`s both the candidate closure STRUCT type AND its funcref type
   before `call_ref` — avoiding the wrong-field-cast trap that previously
   justified gating single literals out.

Verified host-free (`imports` empty) on current main → fixed:

- `1 < {valueOf:()=>({}), toString:()=>2}` → `true` (was wrong/`false`).
- `1 < {valueOf:()=>({}), toString:()=>(x+1)}` (non-const) → `true`.
- `1 + {valueOf:()=>({}), toString:()=>1}` → `2`; valueOf-primitive wins over
  toString.
- `1 + {both objects}` → throws (§7.1.1.1 TypeError).
- class-instance `1 < (new C() as any)` with `valueOf(){return {}}; toString(){return 2}` → `true` (was `false`).

Regression checks: 60/60 existing ToPrimitive-suite tests pass (the 2 failures in
issue-1900 / issue-2679 are PRE-EXISTING on main — a stale Symbol-deferred
assertion and a `wasm:js-string` host-instantiate wiring artifact). Diverse
standalone sample: 0 regressions. New: `tests/issue-2891-standalone-toprimitive-operators.test.ts`.

## Residual — blocks the full `_A2.2_T1` test262 flip (route to architect / #2862)

The `language/expressions/**/_A2.2_T1.js` files still report FAIL standalone
because each bundles two ORTHOGONAL hard sub-problems that this coercion fix does
NOT address (and which were already failing on main — not regressions):

- **#7-style: exception thrown from `valueOf` + forked closure dispatch.** When a
  throwing-`valueOf` literal (`function(){throw "error"}`) shares a struct shape
  with a later both-objects literal, `__call_valueOf`/`__call_toString` start
  returning `null` for the both-objects instance (all candidate guards miss),
  so its §7.1.1.1 TypeError is not thrown. Isolated, `#7` and `#8` each pass;
  only the `#7`-then-`#8` sequence regresses the dispatch. This is a
  forked-closure-type-tracking correctness gap in `valueOfClosureTypes` /
  `closure-eqref-multi`. (`String`-thrown exception propagation through the
  inlined `valueOf` call path also belongs here.)
- **#8-style: standalone `instanceof TypeError`** for the caught native error.

These overlap the `#2862` `architect_spec: candidate` substrate (value-rep
classifier + forked-closure dispatch). They want a design pass, not a point fix.

## Out of scope (separate follow-ups)

- `any`-typed object additive (`(o:any) + 1` where `o={valueOf:()=>1}`) routes
  through `__any_add`, which blindly treats a tag-6 object operand as
  string-concat (`__extern_toString`) instead of `ToPrimitive(default)`-reducing
  it first — a distinct helper bug (file separately if it survives this fix).
  </content>
