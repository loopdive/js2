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
units #7525 refuses. It does not move a measured test262 number. **Backlog** (lead's decision after PRV-7526,
2026-11-26): 0 measured yield, the Prepared path out of scope, not a foundations-list item.

## Implementation Plan (revised after PRV-7526, 2026-11-26; backlog — re-measure before picking it up)

### Order: after B3bc (#7350)

The Prepared path legalizes `dyn.to_number` through `program/dynamic-value-chains.ts`' ToNumber arm, whose ToPrimitive
is OrdinaryToPrimitive (`program/ordinary-to-primitive.ts`). B3bc rewrites that ToPrimitive (the realm's `valueOf` /
`toString` by identity, wrappers). ToNumeric is ToPrimitive(hint number) followed by a BigInt test, so a #7526 that
lands first would either add a second ToPrimitive or be rewritten by B3bc.

### Scope: one native core, both environments

The op is the one native semantic core (#6708), so it serves the standalone / WASI lanes **and** the JavaScript
environment's native-first core. The gc lane's IR-claimed units that carry a dynamic numeric operator therefore change
bytes; that change is intended and listed in the PR (the gc lane is wrong today on un-narrowed BigInt arithmetic, see
Measurement). The #7525 host-free gate goes away with the refusal it gated.

Out of scope, each answered by a named refusal (`operand-coercion-unsupported`), never a wrong value:

- BigInt values on the Prepared path (it has no producer: `5n` → `body-shape-rejected`, `BigInt(…)` →
  `call-graph-closure`); the Prepared legalization of the op is its Number arm plus a refusal of the BigInt arm.
- Wrapped BigInts (`Object(2n)`, legacy's 52 failures above): they need a BigInt wrapper family, a sibling of B3bc's
  three.

### The operators — `NUMERIC_OPS`, the one enumeration

One table in `src/ir/dynamic-numeric-ops.ts` (new; the dialect, builder, selector and runtime body import it), each row
`{ op, arity, number: <f64 lowering>, bigint: <BigInt step>, mixed }`. The table carries the arity, so no arm tests for a
missing right operand.

| op | arity | both Number | both BigInt (§6.1.6.2) | BigInt × Number |
| --- | --- | --- | --- | --- |
| `neg` | 1 | `f64.neg` | unaryMinus; `-INT64_MIN` → wide carrier (`__bigint_carrier_neg`) | — |
| `bitnot` | 1 | ToInt32, `i32.xor -1` | bitwiseNOT (`-x - 1`) | — |
| `plus` | 1 | identity | TypeError (ToNumber of a BigInt) | — |
| `sub` `mul` | 2 | `f64.sub` / `f64.mul` | i64 op; a result outside i64 → refuse (below) | TypeError |
| `div` `mod` | 2 | `f64.div` / exact `__fmod` | `0n` divisor → RangeError; `INT64_MIN / -1n` → exact `2^63` (wide carrier) | TypeError |
| `exp` | 2 | `Math.pow` path | negative exponent → RangeError; a result outside i64 → refuse | TypeError |
| `shl` `shr` | 2 | ToInt32 shifts (`i32.shl` / `i32.shr_s`) | i64 shift; a `<<` result outside i64 → refuse | TypeError |
| `ushr` | 2 | ToUint32 `>>>` | TypeError (§6.1.6.2.11) | TypeError |
| `and` `or` `xor` | 2 | ToInt32 ops | i64 op (exact for i64 operands) | TypeError |
| `inc` `dec` | 1 | `± 1` | `± 1n`; `INT64_MAX + 1n` / `INT64_MIN - 1n` → wide carrier | — |

"Refuse" for a result past i64: the runtime body throws the realm's RangeError with the message
`BigInt result wider than 64 bits is not supported`. That differs from node (which answers the exact value) but is
never a wrapped, wrong value. A **wide carrier operand** (`$BigIntWide`) takes the same throw on every row except
`neg`: the i64 lane cannot read it exactly, and #6656 made only constants, `neg` and equality exact.

### Where the other BigInt steps live (not `NUMERIC_OPS`)

- `+` (§13.15.3): ToPrimitive both, then the string step (`1n + "x"` → `"1x"` through the native BigInt ToString,
  `bigint-format-native.ts`), then BigInt + BigInt / TypeError. It goes into the existing dynamic-add runtime helper
  `__ir_dyn_add` (`IR_DYN_ADD_FN`, `src/shared/contracts/dynamic-add-helper.ts`), which `emitDynamicAdd` already calls;
  no new IR op.
- Loose `==` / `!=` (§7.2.15): the BigInt steps (BigInt × String through StringToBigInt, BigInt × Number by exact
  value) go into the native loose-equality helper the `dyn.eq { loose }` lowering calls (`__any_eq`), the same helper
  #7403's open rows name. No new IR op.
- Relational `< <= > >=` (§7.2.13): today `dyn.to_number` + `f64.lt` etc. The BigInt step (BigInt × BigInt by value,
  BigInt × Number exact, BigInt × String through StringToBigInt) needs an exact carrier ordering. PR #7438 (#7403) adds
  `__bigint_carrier_compare` (narrow and wide carriers); until it merges there is no such helper on main. The relational
  arm then calls a `dyn.compare` helper built on it; that is a second, smaller slice, after this one.

### Target structure

1. **Dialect.** `dyn.numeric { op, operands }` in `core/nodes.ts` and `core/dialect/js.ts`, result `dynamic`, `op` a
   `NUMERIC_OPS` key. One `dyn.numeric` case in each of the 14 files that name `dyn.to_number` today (nodes, dialect,
   builder, verify, effects, inline-small, monomorphize, program legalization, lower-generic, integration, prepared
   dependencies, prepared dynamic support, async-linear, compiler-timer-shim).
2. **Fast path inline, slow path one call.** The lowering (`IrDynamicLowering.emitNumeric(op)`, `backend/handles.ts`,
   implemented in `integration.ts` beside `emitToNumber`) emits: both operands Number (`$BoxedNumber` / i31 test, the
   test `extern-eq-fast.ts` already uses) → the table's f64 lowering inline, boxed back; otherwise one call to
   `__any_numeric(op: i32, a, b) -> $AnyValue`. Size: ~25 instructions inline per site plus one shared body; time: the
   Number × Number case pays two `ref.test`s over today's `__any_to_f64` calls and no call. Runtime op dispatch (`op`
   as an i32 into one body, `br_table`) is chosen over one helper per op: one body, one table, and the cold path's
   dispatch cost sits only off the fast path.
3. **Runtime body.** `src/runtime/wasmgc/values/any-numeric-body.ts`, sibling of `bigint-carrier-body.ts`: ToNumeric
   of each operand (the carrier's existing ToPrimitive, then `$BigInt` payload → BigInt, else ToNumber), then the
   table's BigInt or mixed column. Reuses `__bigint_carrier_neg` (#6656) for `neg` and the `-INT64_MIN` /
   `INT64_MIN / -1n` promotions.
4. **Builder.** `lowerPrefixUnary`, `tryLowerDynamicArithmetic`, the dynamic update and compound arms emit
   `dyn.numeric` for a dynamic operand, and keep `dyn.to_number` + the f64 op where the checker proves Number (bytes
   of those units unchanged).
5. **Selector.** `refusesBigInt` (#7525) becomes an admission once the op exists; `src/ir/bigint-operand-refusal.ts`
   keeps only the Prepared refusal (above).

### Acceptance criteria

- **Correctness.** A pin file over every `NUMERIC_OPS` row × operand pair (BigInt × BigInt, BigInt × Number,
  Number × Number, narrowed and un-narrowed), plus the edge rows (`INT64_MIN / -1n`, `-INT64_MIN`, `0n` divisor,
  negative `**` exponent, `>>>`, unary `+` on a BigInt, a `<<` / `**` / `*` result past i64, a wide carrier operand) and
  the `+` string steps (`1n + "x"`, `"x" + 1n`), on gc and standalone against node's answer — the "refuse" rows assert
  the RangeError message, not node's value. `trackIrOutcomes` shows the units IR-emitted; the #7525 pins still pass.
- **Bytes.** Units whose operands the checker proves Number: identical to main on both lanes. Units with a dynamic
  numeric operand: changed on gc and standalone, every such unit in the 160-file test262 sample listed in the PR. IR
  fallback gate unchanged or lower.
- **Code quality.** One table (`NUMERIC_OPS`) read by dialect, builder, selector and runtime body; one dialect op; one
  runtime body; one handle method; one arm per exhaustive switch; no per-operator helper, no arity test in an arm.
  Adversarial review before release.

### Left open

- `dyn.compare` (relational BigInt steps), after PR #7438 lands `__bigint_carrier_compare`.
- Wide runtime BigInt arithmetic (results past i64 throw here instead of wrapping).
- BigInt wrappers; BigInt values on the Prepared path.
