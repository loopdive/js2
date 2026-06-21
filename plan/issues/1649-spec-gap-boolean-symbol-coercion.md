---
id: 1649
title: "spec gap: Boolean wrapper + Symbol coercion TypeErrors (24 + 45 test262 fails)"
status: blocked
created: 2026-05-08
updated: 2026-06-19
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen, runtime
language_feature: types
goal: spec-completeness
sprint: Backlog
renumbered_from: 1342
parent: 1328
escalation: needs-architect-spec-OR-carve
related: 1319
---
# #1342 — Boolean wrapper coercion + Symbol primitive coercion

## Problem

`built-ins/Boolean`: **27 / 51 (52.9%) — 24 fails (23 assertion_fail)**.
`built-ins/Symbol`: **53 / 98 (54.1%) — 45 fails (20 type_error, 18 assertion_fail)**.

Spec requirements:
1. **§20.3.3.2 Boolean.prototype.toString** — receiver coercion: must accept Boolean wrapper or
   primitive boolean, otherwise TypeError. The 23 assertion_fail tests expect "true"/"false"
   from `Boolean.prototype.toString.call(0)` etc. (per ToBooleanthisValue) — but we likely
   throw TypeError on primitive 0.

2. **§20.4.3 Symbol.prototype.toString / valueOf / [@@toPrimitive]**: must throw on string-hint
   coercion (Symbol cannot be implicitly converted to string except via explicit Symbol.prototype.toString).

3. **§20.4.1 Symbol.for / Symbol.keyFor**: maintain a global registry. Symbol.keyFor on a non-registered
   Symbol returns undefined.

Current state:
- Boolean.prototype.toString.call(prim) likely fails because we don't unbox via ToBooleanthisValue.
- Symbol→primitive in template literals/concatenation does not throw TypeError (#1319 partial).
- Symbol.for/keyFor: passes for simple cases but fails on cross-realm symbol identity tests.

## Acceptance criteria

1. `built-ins/Boolean/prototype/toString/this-val-non-boolean.js` passes.
2. `built-ins/Boolean/prototype/valueOf/this-val-boolean.js` passes.
3. `built-ins/Symbol/prototype/toString/symbol-thisvalue.js` passes.
4. `built-ins/Symbol/for/registry.js` passes.
5. `built-ins/Symbol/keyFor/symbol-not-in-symbol-registry.js` passes.
6. Pass-rate for `built-ins/Boolean` rises from 53% to ≥85%, Symbol from 54% to ≥75%.

## Files to modify

- `src/codegen/registry/boolean.ts` — Boolean prototype methods
- `src/codegen/registry/symbol.ts` — Symbol prototype methods
- `src/runtime.ts` — `__symbol_for`, `__symbol_key_for`

## Implementation Plan

### Root cause

Two distinct issues:

1. **Boolean.prototype methods on primitives**: receiver is `f64` (when called via `.call(0)`)
   but our method dispatch expects an externref Boolean wrapper. Solution: emit ToBooleanthisValue
   first, which unboxes wrapper or coerces primitive.

2. **Symbol coercion**: Symbol values are externref-tagged objects with a hidden brand. Our
   coercion paths (template-literal concat, ToString) don't check for the brand and end up
   calling __to_string which silently returns "Symbol()". Spec says ToString(Symbol) throws TypeError;
   ToPrimitive(Symbol, "string") also throws unless explicit toString().

### Approach

For Boolean:
```
function compileBooleanToString(receiver) {
  // §20.3.3.2 step 1: b = thisBooleanValue(this)
  // - if Boolean wrapper → unbox
  // - if primitive boolean → use as-is
  // - else → TypeError
  emit BooleanThisValue dispatch + select "true"/"false".
}
```

For Symbol coercion:
- In ToString and template-literal concat, emit `ref.test $SymbolBrand` before the host call;
  if true, throw TypeError("Cannot convert Symbol to string").

### Edge cases

- `Boolean.prototype.toString.call(undefined)` → TypeError.
- `String(Symbol("x"))` (explicit String()) → "Symbol(x)" per spec — explicit OK, implicit not.
- Template literal `${sym}` → TypeError.

### Test262 sample

- `test262/test/built-ins/Boolean/prototype/toString/S15.6.4.2_A1_T1.js`
- `test262/test/built-ins/Symbol/prototype/toString/toString.js`
- `test262/test/built-ins/Symbol/for/retrieve-value.js`

## 2026-05-28 dev triage (dev-1594, post PR #665)

Ran the full `built-ins/Boolean` (51) + `built-ins/Symbol` (98) suites on
`origin/main` HEAD `d2f684f3a` (after PR #665 `issue-1637-boolean-symbol-coercion`
landed). Real current state:

- **Boolean**: 31/51 pass (60.8 %) — 20 fails
- **Symbol**: 54/98 pass (55.1 %) — 44 fails
- **Combined residual**: 64 fails

The earlier `~69` issue estimate is close; PR #665 fixed only the
`Boolean.prototype.method.call(prim)` and `Boolean.prototype.method.apply(prim)`
paths (runtime.ts:5023-5042 + 5311 receiver coercion). The bare-receiver path
(`Boolean.prototype.toString()` with no `.call`) is still broken because
`Boolean.prototype` *itself* is a Boolean wrapper with `[[BooleanData]] = false`,
which our codegen doesn't recognise as having a thisBooleanValue.

### Failure breakdown by bucket (64 residual fails)

| Bucket | Fails | Diagnosis |
|---|---|---|
| `cross-realm` | 17 | Architectural — needs realm support; out of scope for a localized fix |
| `proto-toString` | 11 | Bare `X.prototype.toString()` receiver coercion (real, addressable gap) |
| `proto-valueOf` | 8 | Bare `Boolean.prototype.valueOf()` receiver coercion (real gap) |
| `proto-toPrimitive` | 5 | `Symbol.prototype[@@toPrimitive]` (real gap) |
| `boolean-misc` (`S15.6.2.1_A2`, …) | 4 | `x.constructor.prototype` / `isPrototypeOf` — prototype-chain on instances; same family as #1364b |
| `symbol-for-registry` | 4 | `Symbol.for()` registry round-trip; partial — for(s).description, cross-realm |
| `boolean-proto-misc` | 2 | `Boolean.prototype` itself is a Boolean wrapper |
| `symbol-keyFor` | 2 | `Symbol.keyFor(non-symbol)` brand check + TypeError |
| `proto-description` | 2 | `Symbol.prototype.description` is an accessor on prototype, not an own data prop on instances |
| `desc-to-string` | 2 | Symbol description rendered as wasmGC string vs host string |
| `species` | 2 | `Symbol.species` |
| `is-a-constructor` | 1 | `Reflect.construct(Boolean, …)` |
| `not-callable` | 1 | `new Symbol()` must throw TypeError |
| `auto-boxing-strict` | 1 | Strict-mode Symbol primitive `this` |
| `proto-from-ctor-realm` | 1 | Cross-realm proto link |

After excluding the 17 cross-realm cases (architectural), **47 residual fails
across ~12 distinct sub-buckets** remain. This is not a single coherent
"~2-line fix" task; it spans:

- Receiver-coercion for bare-receiver bound-method calls (`proto-toString` /
  `proto-valueOf` / `proto-toPrimitive` — ~24 fails). The hot fix would extend
  PR #665's `wrappedObj === Boolean.prototype.toString` guards to the
  non-`.call`/`.apply` dispatch path. Touches `runtime.ts` proto-method dispatch
  + `compileCallExpression`.
- Prototype-chain semantics on primitive wrappers (`boolean-misc` /
  `boolean-proto-misc` / `proto-description` — ~8 fails). Overlaps with #1364b.
- Symbol-specific brand checks (`not-callable` / `symbol-keyFor` / `auto-boxing` —
  ~4 fails) — small, isolable.
- Symbol registry (`symbol-for-registry` / `desc-to-string` — ~6 fails) —
  runtime.ts only.

### Recommendation

**Carve into sub-issues** before attempting another implementation PR. This
issue overlaps with #1637 (PR #665, just merged), #1564 (#145, just merged),
and #1364b (prototype-chain). Three sequential PRs landing in the same hot
runtime.ts proto-method dispatch in a single sprint creates merge-conflict
drift; the next step should be **architect carve** into:

- **#1649A** — bare-receiver bound-method receiver coercion (`proto-toString` +
  `proto-valueOf` + `proto-toPrimitive` ~24 fails). Extension of PR #665.
- **#1649B** — Symbol brand-check residuals (`not-callable`, `symbol-keyFor`,
  `auto-boxing-strict` ~4 fails). Small, separate.
- **#1649C** — Symbol description / registry runtime polish (~6 fails).
- **#1649D** — Defer to #1364b (`boolean-misc` ~8 fails, prototype-chain).
- **#1649E** — Defer cross-realm (~17 fails) to a separate architectural issue
  (realm support is wholly out of scope).

Sub-issue split avoids stepping on #665/#1564 drift and lets a dev claim one
small bucket at a time with clear acceptance.
