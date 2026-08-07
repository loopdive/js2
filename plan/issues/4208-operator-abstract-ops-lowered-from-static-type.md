---
id: 4208
title: "Operator abstract-ops are lowered from the STATIC type: ToNumber / ToPrimitive / Type() are skipped for string, wrapper and `{valueOf}` operands — 59 ES5 files, `1 === true` answers true"
status: ready
sprint: current
created: 2026-08-07
updated: 2026-08-07
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 5
language_feature: abstract-operations, value-representation
goal: es5
related: [3055, 4183, 4173, 2733, 3216, 3397]
origin: "2026-08-07 W23 census of the ES5 standalone failing residue. #3055 covers only `any === any` on boxed numbers; nothing covers ToNumber/ToPrimitive in update, compound-assignment and relational operators."
---

# #4208 — operator abstract-ops follow the static type, not the value

## The lever

**59 failing ES5 standalone files** under `language/expressions/<operator>/`.
45 of them fail in the host lane too, so this is a shared-semantics defect, not
a standalone-lowering one.

| operator family | files |
| --- | --- |
| `equals` / `does-not-equals` | 13 |
| `strict-equals` / `strict-does-not-equals` | 8 |
| `postfix-`/`prefix-increment`/`decrement` | 20 |
| `compound-assignment` | 5 |
| `addition`/`concatenation`/`unary-plus`/`unary-minus`/`bitwise-*`/shifts | 9 |
| relational (`<`, `<=`, `>`, `>=`) | 4 |
| total | **59** |

## Four observable shapes, one root cause

The compiler chooses the lowering of `ToNumber` / `ToPrimitive` / `Type(x)`
from the operand's **TypeScript static type**. Every failure is a case where
the runtime value's type is not the static one.

1. **`Type()` collapses across the f64 representation.**
   `1 === true` → `true` (`strict-equals/S11.9.4_A8_T{1,2,3}.js`,
   `strict-does-not-equals/S11.9.5_A8_T{1,2,3}.js`). Booleans and numbers share
   the f64 slot and `===` compares slots, not types.
2. **ToNumber is skipped in update expressions.**
   `var x = "1"; x--;` leaves `x === 1`, not `0`
   (`postfix-decrement/S11.3.2_A3_T3.js`, `prefix-increment/S11.4.4_A3_T3.js`,
   `postfix-increment/S11.3.1_A3_T3.js`, `prefix-decrement/S11.4.5_A3_T3.js`).
   Same with a wrapper: `var x = new Boolean(true); x++` (`S11.3.1_A3_T1.js`).
3. **ToPrimitive is skipped for `{valueOf}` / `{toString}` operands.**
   `var object = {valueOf: function(){return 1}}; object--`
   (`postfix-decrement/S11.3.2_A2.2_T1.js`, `prefix-decrement/S11.4.5_A2.2_T1.js`,
   `postfix-increment/S11.3.1_A2.2_T1.js`, `equals/S9.1_A1_T3.js`,
   `equals/S11.9.1_A7.9.js`, `does-not-equals/S11.9.2_A7.8.js`,
   `concatenation/S9.8_A5_T2.js`, `less-than/S11.8.1_A3.2_T1.2.js`,
   `greater-than/S11.8.2_A3.2_T1.2.js`, `addition/S11.6.1_A3.2_T1.2.js`).
4. **The same defect crashes instead of answering wrong** when the static type
   drives an unchecked cast: `illegal cast [in __str_to_number() ← __module_init]`
   (8 files: `equals/S11.9.1_A7.{2,3,4,5}.js`, `does-not-equals/S11.9.2_A7.{2,5}.js`,
   …), `illegal cast [in __module_init()]` (6 update-operator files),
   `dereferencing a null pointer [in __module_init()]`
   (`bitwise-not/S9.5_A3.1_T4.js`, `unary-minus/S11.4.7_A2.2_T1.js`,
   `unary-plus/S11.4.6_A2.2_T1.js`, `unsigned-right-shift/S9.6_A3.1_T4.js`),
   and one `invalid Wasm binary`
   (`compound-assignment/S11.13.2_A4.4_T2.7.js`).

Shape 4 matters for triage: **~16 of these files currently sit in the
"crash cluster" (#3442/#3443) by error text, but they are not an independent
crash mechanism** — the crash is this defect's failure mode when the mis-typed
value reaches a cast rather than a comparison. Fixing the coercion removes the
crash; hardening the cast alone converts a crash into a wrong answer.

5. **Compound assignment picks the numeric operator from the static type.**
   `x = 1; x += "1"` gives `2`, not `"11"`
   (`compound-assignment/S11.13.2_A4.4_T2.6.js`).

## Relationship to existing issues

- **#3055** (`ready`, unassigned) — `any === any` on boxed numbers returns
  equal-for-unequal. That is shape 1 restricted to boxed numbers; this issue is
  the general case including primitives (`1 === true`) and the other four shapes.
- **#4183** (`ready`) — `$AnyValue === nativeString` inline vs through a local.
  A narrow slice of shape 1.
- **#3397** (`ready`) — boxed value used in a scalar op without unbox. The
  standalone-invalid-Wasm framing of shape 4.

None of them owns ToNumber/ToPrimitive in update, compound-assignment or
relational operators. Sequence this **before** #3055/#4183 or fold those in;
they are strictly narrower.

## Codegen sites

- `src/codegen/binary-ops.ts` — abstract equality / relational dispatch.
- `src/codegen/binary-ops-typed-dispatch.ts` — the static-type dispatch that
  chooses the numeric arm.
- `src/codegen/coercion-plan.ts` / `coercion-engine.ts` — where a
  ToNumber/ToPrimitive plan is (not) inserted.
- `src/codegen/type-coercion.ts` — `coerceType`; and `__str_to_number` /
  `__to_primitive` / `__class_to_primitive` on the runtime side.
- Update expressions: the `PostfixUnaryExpression` / `PrefixUnaryExpression`
  arms in `src/codegen/expressions.ts`.

## Acceptance criteria

- [ ] `Type(x)` is a runtime property of the value for `===`/`!==`, not a
      compile-time property of its declared type: `1 === true` is `false`,
      `"0" === 0` is `false`, `new Number(0) === 0` is `false`.
- [ ] Update operators apply `ToNumber(ToPrimitive(v, number))` before the ±1,
      including for string, wrapper-object and `{valueOf}` operands.
- [ ] `+=` on a string operand concatenates.
- [ ] Relational and `+` apply ToPrimitive with the correct hint and call a
      user `valueOf`/`toString`.
- [ ] A/B over the 59-file set. **Report the 16 crash-signature files
      separately** and cross-check the delta against #3442/#3443's buckets so
      the two lanes do not double-count the same files.

## Measurement provenance

`classifyEdition() === 5` over the standalone baseline (48,619 rows, oracle v13,
2026-08-07): 8,931 files, 7,566 pass, 1,365 fail. Host comparison from the
same-day host baseline (`test262-current.jsonl`, `env` imports only).
