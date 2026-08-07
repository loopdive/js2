---
id: 4207
title: "A builtin prototype method reached by property TRANSFER (not `.call`) skips both the [[Class]] brand check and the primitive-receiver coercion — 70 ES5 standalone files"
status: ready
sprint: current
created: 2026-08-07
updated: 2026-08-07
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 5
language_feature: native-prototypes, this-coercion
goal: es5
related: [3992, 4076, 3254, 2742, 2875, 4176, 4193]
origin: "2026-08-07 W23 census of the ES5 standalone failing residue. #3992 fixed the transferred-method ARGUMENT-SLOT bug and #4076 fixed brand checks on the `.call` form; neither covers the `this`-handling of the transfer form."
---

# #4207 — transferred builtin prototype methods: no brand check, no receiver coercion

## The lever

**98 failing ES5 standalone files** contain the transfer idiom
`<X>.<m> = <Builtin>.prototype.<m>` followed by an invocation through `<X>`.
28 of them fail earlier because the method is simply unimplemented in
standalone (`String.prototype.split`, `concat`, `search`, `replace`, `match` —
those belong to **#2875**, not here). The remaining **70** are this issue:

| sub-mechanism | files | shape |
| --- | --- | --- |
| **A — no [[Class]] brand check** | 20 | `var i = new Number(1); i.exec = RegExp.prototype.exec; i.exec("s")` must throw TypeError; standalone returns a value |
| **B — no primitive-receiver coercion** | 50 | `Number.prototype.toLowerCase = String.prototype.toLowerCase; NaN.toLowerCase()` must be `"nan"`; standalone answers wrong / null |
| total | **70** | |

16 of the 70 pass in the host lane, so most of this is a shared-semantics gap
rather than a standalone-lowering gap.

## Why the existing fixes do not cover it

- **#3992 (done)** fixed the transferred-method **argument-slot shift** —
  `__call_fn_method_N`'s generic dispatch filled every closure param from the
  argument vector, so `thisValue` received `arg0`. That is orthogonal to *what
  the method does with a receiver once it gets one*.
- **#4076 (done)** made a borrowed method throw on an invalid `this`, but only
  through the **syntactic `.call` form**. The transfer form never reaches that
  check.
- **#3254 / #2742 (ready)** cover `RequireObjectCoercible` + `ToString` for the
  **`.call`** receiver of `String.prototype` members.

The distinguishing fact: `String.prototype.toLowerCase.call(NaN)` and
`Number.prototype.toLowerCase = String.prototype.toLowerCase; NaN.toLowerCase()`
must behave identically, and today they do not. The syntactic form is the one
with the plumbing.

## Two distinct receiver kinds inside B

1. **Assignment onto another builtin prototype** —
   `Number.prototype.toLowerCase = String.prototype.toLowerCase`, then invoked
   through a *primitive* number. Needs the named-expando write on a builtin
   prototype (#4176 / #4193 territory) **and** ToString(this) at entry.
   Members observed failing: `toLowerCase`, `toUpperCase`,
   `toLocaleLowerCase`, `toLocaleUpperCase`, `substring`, `slice`, `match`.
   `charAt` and `substring` had per-member clones from the #3992 era and behave
   differently — treat any per-member special case as a smell, not a template.
2. **Assignment onto an ordinary object / wrapper instance** —
   `var i = new Object(42); i.charAt = String.prototype.charAt; i.charAt(0)`.

## Representative files

Brand check (A):
`built-ins/RegExp/prototype/exec/S15.10.6.2_A2_T{6,7,8,9}.js`,
`built-ins/RegExp/prototype/test/S15.10.6.3_A2_T{4,6,7,8,9}.js`,
`built-ins/Number/prototype/valueOf/S15.7.4.4_A2_T{01,03,04,05}.js`,
`built-ins/Boolean/prototype/toString/S15.6.4.2_A2_T{1,3,5}.js`,
`built-ins/Number/prototype/toString/S15.7.4.2_A4_T{01,03}.js`.

Coercion (B):
`built-ins/String/prototype/toLowerCase/S15.5.4.16_A1_T{6,7,8,14}.js`,
`built-ins/String/prototype/toLocaleUpperCase/S15.5.4.19_A1_T{6,7,8,14}.js`,
`built-ins/String/prototype/substring/S15.5.4.15_A1_T15.js`,
`built-ins/String/prototype/slice/S15.5.4.13_A{1_T5,1_T15,3_T3,3_T4}.js`,
`built-ins/String/prototype/charAt/S15.5.4.4_A1_T{1,2}.js`,
`built-ins/Array/prototype/concat/S15.4.4.4_A{1_T1,2_T1,2_T2,3_T1}.js`.

## Codegen sites

- `src/codegen/closures/transferred-native-proto.ts` — the transfer-time
  receiver plumbing (`collectTransferredSubstringReceivers` is the per-member
  clone to generalise away).
- `src/codegen/char-at-transfer.ts` — `buildTransferredCharAtApplyArm`, the
  other per-member clone.
- `src/codegen/closure-exports.ts` — `__call_fn_method_N` generic dispatch,
  where the receiver arrives.
- `src/codegen/array-prototype-borrow.ts` / `builtin-prototype-brand.ts` — where
  the `.call` form's brand check lives and which the transfer form bypasses.

## Acceptance criteria

- [ ] `<Builtin>.prototype.<m>` invoked through a transferred property performs
      the same `this` handling as the `.call` form: brand check where the spec
      requires one (RegExp `exec`/`test`, `Number.prototype.valueOf`/`toString`,
      `Boolean.prototype.toString`), `RequireObjectCoercible` + `ToString`
      otherwise.
- [ ] No new per-member special case is added; the two existing ones
      (`charAt`, `substring`) are folded into the general path or explicitly
      justified.
- [ ] A/B over the 70-file set with a control drawn from currently-passing
      transfer-idiom files; report both.
- [ ] The 28 method-missing files are excluded from this issue's yield and
      re-attributed to #2875.

## Measurement provenance

`classifyEdition() === 5` over the standalone baseline (48,619 rows, oracle v13,
2026-08-07): 8,931 files, 7,566 pass, 1,365 fail. Host-lane comparison from the
same-day host baseline.
