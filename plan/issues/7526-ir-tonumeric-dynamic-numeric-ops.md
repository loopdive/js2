---
id: 7526
title: "IR: ToNumeric dynamic numeric ops (neg, - * / %, ++/--, BigInt-aware + and ==)"
status: ready
sprint: Backlog
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: m
feasibility: hard
reasoning_effort: high
task_type: feature
area: ir
goal: backend-agnostic-ir
related: [7525, 7135, 2949, 7403, 7506]
---

# #7526 — IR: ToNumeric dynamic numeric ops

## Problem

The IR's dynamic-operand numeric arms run ToNumber (`dyn.to_number`), then an f64 op. The spec takes ToNumeric for
unary `-`, binary `- * / %` and `++` / `--` (§13.5.5, §13.15.3, §13.4.2–5): a BigInt operand stays a BigInt, and a
BigInt mixed with a Number throws TypeError. Unary `+` is ToNumber, which throws on a BigInt; `+` addition and loose
equality have their own BigInt steps (§13.15.3 step 1.b, §7.2.15). The IR has no BigInt value, so it cannot lower any
of these on a BigInt.

#7525 stops the IR from claiming such units when the checker types an operand with a BigInt member (host-free lanes),
so legacy compiles them. That is a refusal, not support. Still wrong after #7525, measured by S18 on main 1a726b3e64:

| shape | node | gc (legacy) | standalone |
| --- | --- | --- | --- |
| `-t` on `t` narrowed to `bigint \| number`, `5n` | `-5n` | wrong | right after #7525 (refused) |
| `-t`, `t * t`, … on an un-narrowed `t: any` holding a BigInt | BigInt result | NaN | NaN |

Also pre-existing, identical on main (RV7497, review of PR #7497 at f510d93c):

- legacy, both lanes: `let k = t; k *= 2` and `t >>> u` on a narrowed BigInt do not throw a TypeError; `t *= u`,
  `t += u` and `t++` written to a narrowed **parameter** throw a wasm exception; on a module `var g: any = 5n`,
  `g *= 2n`, `g += 2n`, `g -= h` and `g++` answer wrong;
- Prepared path: `t += u` on a narrowed BigInt threw `PreparedIrProgramInvariantError: runtime support: support
  supplied without primary demand` instead of refusing. #7525 now refuses it by name (`operand-coercion-unsupported`).

## Direction

A dynamic numeric op family whose lowering is ToNumeric on the carrier:

- `dyn.neg`, `dyn.arith(op)` for `- * / % **`, `dyn.inc` / `dyn.dec`: a BigInt operand goes through the native BigInt
  carrier helpers (`__bigint_carrier_neg` exists, #6656; the binary ones need adding), a Number through f64, a mix
  throws TypeError. The result is `dynamic`, not `f64`.
- `dyn.add` and loose `dyn.eq` gain their BigInt steps; the latter overlaps #7403's open loose-equality rows (a BigInt
  case in `__extern_loose_eq`).
- Selector and builder then claim the #7525 shapes instead of refusing them, and #7525's refusal helper goes away.

Cost to plan for: a new op touches every exhaustive dynamic-op switch (builder, verifier, effects, inline-small,
monomorphize, legalization, lower-generic, prepared dependencies, async-linear), and the `dynamic` result changes what
the selector and builder promise for these expressions today (`f64`).

## Acceptance criteria

- The #7525 pins pass with the IR claiming `f` (`trackIrOutcomes`), on standalone and gc.
- The rows above answer like node on both pipelines.
- An Implementation Plan reviewed before code, per the IR code-quality rule.

## Measurement (S18, 2026-11-26, main 1a726b3e64, branch issue-7525-bigint-neg-narrowed f510d93c)

- **Static yield of lifting #7525's refusal: none in test262.** Every test262 file whose path or body mentions BigInt
  (3,499 files): compiled standalone without the harness, 0 of 3,640 units move between main and #7525; with the real
  harness (`assembleOriginalHarness`, every third file: 1,154 files, 15,174 units, 9,220 IR-emitted), 0 units move. No
  IR-claimed test262 unit has a dynamic numeric operator on an operand the checker types as BigInt.
- **Runtime yield: none attributable.** The standalone baseline (fetched 2026-11-26, 48,735 rows) fails 677 of those
  files. The 52 whose error names BigInt arithmetic (`Cannot mix BigInt and other types`, `Cannot convert value to a
  BigInt`, a NaN where a BigInt was expected) are all `compilerPath: legacy`: wrapped BigInts through ToPrimitive
  (`Object(2n) * 1n`, `*-wrapped-values.js`, `*-toprimitive.js`) in the legacy module init, not an IR arm.
- **Where it is wrong today** (probes, TypeScript, `f(t: any, u: any)` with no narrowing, called with BigInts):
  `t * u`, `t - u`, `t + u`, `t++`, `t < u`, `t * 1` (no TypeError) are wrong on gc (legacy) and on standalone (IR
  claims them); `t == u` is right on gc, wrong on standalone; `-t` is refused by the IR and wrong in legacy on both.

So #7526 buys correctness for programs that do arithmetic on `any` values holding BigInts, and lets the IR claim the
units #7525 refuses. It does not move a measured test262 number. Priority stays medium; horizon m.

## Implementation Plan

### Order: after B3bc (#7350)

The Prepared path legalizes `dyn.to_number` through `program/dynamic-value-chains.ts`' ToNumber arm, whose ToPrimitive
is OrdinaryToPrimitive (`program/ordinary-to-primitive.ts`). B3bc rewrites exactly that ToPrimitive (the realm's
`valueOf` / `toString` by identity, wrappers). ToNumeric is ToPrimitive(hint number) followed by a BigInt test, so a
#7526 that lands first would either add a second ToPrimitive or be rewritten by B3bc. After B3bc, ToNumeric reuses
B3bc's ToPrimitive. The ordinary-pipeline part does not depend on B3bc, but splitting it off would land the new op
with only one of its two legalizations; one slice after B3bc keeps the op whole.

### Scope

- Standalone / WASI (host-free) only. The JavaScript-environment lane keeps today's behaviour (no new JS-host work).
- Operators: unary `-`, binary `- * / % **`, `++` / `--` (prefix, postfix, compound), the bitwise operators on a
  BigInt pair (`& | ^ << >>`; `>>>` throws), and the BigInt steps of `+` and of loose `==` / `!=`.
- Relational `< <= > >=` on a BigInt pair or a BigInt × Number pair (exact, §7.2.13) — the #7403 compare helpers.
- Not in scope: BigInt values on the Prepared path (it has no producer; `5n` and `BigInt(…)` are refused there), wide
  results of runtime arithmetic (the i64 lane wraps today in legacy too; the #6656 note), wrapped BigInts
  (`Object(2n)`, legacy's 52 failures above — they need BigInt wrappers, a sibling of B3bc's three).

### Target structure

1. **One dialect op, not one per operator.** `dyn.numeric { op: NumericOp; lhs; rhs? }` in `core/nodes.ts` and
   `core/dialect/js.ts`, result `dynamic`. `NumericOp` is the closed set above. The exhaustive switches that list
   `dyn.to_number` today gain one `dyn.numeric` case each: the 14 files that name it (nodes, dialect, builder,
   verify, effects, inline-small, monomorphize, program legalization, lower-generic, integration, prepared
   dependencies, prepared dynamic support, async-linear, compiler-timer-shim), one arm each.
2. **Runtime body, one per operator family.** `src/runtime/wasmgc/values/any-numeric-body.ts` (sibling of
   `bigint-carrier-body.ts`): `__any_numeric(op: i32, a, b) -> $AnyValue`. ToNumeric of each operand (the carrier's
   existing ToPrimitive, then: a `$BigInt` payload → BigInt, else ToNumber); both BigInt → the i64 operation with the
   §6.1.6.2 errors (`/` and `%` by 0n → RangeError, `>>>` → TypeError, negative `**` exponent → RangeError) and
   `__bigint_carrier_neg` / `__bigint_carrier_compare` for the cases they already make exact; both Number → the f64
   operation; mixed → TypeError. One `op` argument, one body: the operator table is data, not N helpers.
3. **Lowering handle.** `IrDynamicLowering.emitNumeric(op)` in `backend/handles.ts`, implemented once for the native
   carrier (`integration.ts`, next to `emitToNumber`). The JavaScript-environment implementation is absent, so the
   selector keeps that lane on today's path.
4. **Builder.** `lowerPrefixUnary`, `tryLowerDynamicArithmetic`, the dynamic update and compound arms emit
   `dyn.numeric` where the operand may hold a BigInt (the #7525 predicate answers true, or the operand is an
   un-narrowed `any` / `unknown`), and keep `dyn.to_number` + the f64 op where the checker proves Number. That keeps
   every Number-typed unit's bytes.
5. **Selector.** The #7525 checks become admissions: `refusesBigInt` admits when `emitNumeric` is available. The
   `src/ir/bigint-operand-refusal.ts` module shrinks to the predicate; its refusal stays only for the Prepared path
   until that path has BigInt values.
6. **Prepared legalization.** `dyn.numeric` legalizes to the existing ToNumber chain plus the f64 op: the Prepared
   path has no BigInt producer, so its BigInt arm is provably dead there. It is reached only through the predicate's
   refusal today, so this arm exists for the op's totality, not for a measured row.

### What it reuses, what it removes

- Reuses the carrier ToPrimitive, `__bigint_carrier_neg`, `__bigint_carrier_compare` (#7403), the #7525 predicate and
  `isBigIntUnsafeDynamicOperator` as the admission rule.
- Removes the #7525 refusal from the ordinary pipeline, and legacy-equivalent wrong answers for un-narrowed `any`
  arithmetic on standalone.

### Acceptance criteria

- **Correctness.** A pin file over the operator × operand matrix (BigInt × BigInt, BigInt × Number, Number × Number,
  narrowed and un-narrowed, the RangeError / TypeError rows), on standalone against node's answer; `trackIrOutcomes`
  shows the units IR-emitted. The #7525 pins still pass, now with `f` emitted.
- **No regression.** gc and JavaScript-environment bytes identical to main; standalone bytes identical for units whose
  operands the checker proves Number; the 160-file test262 sample and the IR fallback gate unchanged or better.
- **Code quality.** One op with an operator table, one runtime body, one handle method; one `dyn.numeric` arm per
  exhaustive switch; no per-operator helpers. Adversarial review before release.

### Left open

- BigInt wrappers (`Object(2n)`, `new Object(1n)`), legacy's wrapped-value failures above: a B3-style wrapper family.
- BigInt values on the Prepared path.
- Wide runtime arithmetic past i64.
