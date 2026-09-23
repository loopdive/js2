// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6656 slice 4) BigInt values WIDER than 64 bits under the native (standalone)
 * semantic providers.
 *
 * ## Representation
 *
 * The standalone bigint carrier is `$BigInt`, a one-field struct holding an
 * i64. A value outside [-2^63, 2^63-1] is a `$BigIntWide`, a SUBTYPE of it:
 *
 * ```wat
 * (type $BigInt     (sub (struct (field $value i64))))
 * (type $BigIntLimbs (array (mut i32)))                       ;; |v|, base 2^32, little-endian
 * (type $BigIntWide (sub final $BigInt
 *   (struct (field $value i64) (field $sign i32) (field $mag (ref $BigIntLimbs)))))
 * ```
 *
 * Subtyping is the load-bearing choice. Every existing `ref.test $BigInt` site
 * — `typeof`, truthiness, `===`, the link boundary, `__to_bigint` — keeps
 * recognising a wide value as a BigInt with no edit, and a site that reads
 * field 0 sees `BigInt.asIntN(64, v)`, which is exactly the value the i64 lane
 * computed for it before this slice. So a site that does not know about the
 * wide form degrades to the pre-existing (wrapped) answer and never to a
 * wrong TYPE. Only the sites that must be exact test `$BigIntWide` first.
 *
 * Canonical form is mandatory: a value that fits in i64 is ALWAYS a plain
 * `$BigInt`, never a `$BigIntWide`, so the two forms never describe one value.
 *
 * The provider and the consumer of a linked graph mint both types in the same
 * seeding block (`addUnionImportsAsNativeFuncs`), so WasmGC canonicalisation
 * gives them one runtime identity across the link.
 *
 * ## What produces a wide value (this slice)
 *
 * - A bigint CONSTANT expression — literals combined by `+ - * / % ** & | ^
 *   << >>` and unary `-`/`~` — is evaluated exactly at compile time when any
 *   step of it leaves the i64 range (the i64 lowering would wrap). A result
 *   that fits is emitted as its exact `i64.const`; a wide result is
 *   materialised as a `$BigIntWide` where the context holds a reference
 *   (`externref`/`anyref`), and otherwise keeps the wrapped i64 it always had.
 *   `BigInt(<string literal>)` and `BigInt.asIntN/asUintN(<integer literal>,
 *   <constant>)` fold the same way.
 * - `BigInt(x)` whose result lands in a reference slot — bigint-wide-parse.ts.
 * - A `BigUint64Array` element or `DataView#getBigUint64` read landing in a
 *   reference slot, boxed as the unsigned value (`__bigint_from_u64`).
 * - Unary `-` on a bigint held in a reference slot (a script-global `var`) —
 *   which used to run ToNumber and answer the NUMBER `NaN`.
 *
 * Runtime arithmetic on the i64 lane is unchanged (it still wraps), because an
 * i64 slot cannot hold the wider result.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { isGlobalBuiltinIdentifier } from "./expressions/calls.js";
import { compileExpression } from "./shared.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { usesHostBigIntCarrier } from "./host-bigint-carrier.js";
import { emitNativeBigIntFormat } from "./bigint-format-native.js";
import { ensureNativeStringHelpers } from "./native-strings.js";
import { addFuncType } from "./registry/types.js";

const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
/** Compile-time folding refuses to build anything larger than this. */
const MAX_FOLD_BITS = 1 << 16;

const WIDE_FIELD_VALUE = 0;
const WIDE_FIELD_SIGN = 1;
const WIDE_FIELD_MAG = 2;

/**
 * Register `$BigIntLimbs` and `$BigIntWide` right after `$BigInt`. Called from
 * the one block that mints `$BigInt`, so every module that has the carrier
 * has the wide form too — that is what keeps `$BigInt`'s finality (and so its
 * canonical identity) the same in a provider and its consumer.
 */
export function registerWideBigIntTypes(ctx: CodegenContext, bigIntStructIdx: number): void {
  const limbsIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "array", name: "$BigIntLimbs", element: { kind: "i32" }, mutable: true });
  const wideIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$BigIntWide",
    superTypeIdx: bigIntStructIdx,
    fields: [
      { name: "value", type: { kind: "i64", bigint: true }, mutable: false },
      { name: "sign", type: { kind: "i32" }, mutable: false },
      { name: "mag", type: { kind: "ref", typeIdx: limbsIdx }, mutable: false },
    ],
  });
  ctx.nativeBigIntLimbsTypeIdx = limbsIdx;
  ctx.nativeBigIntWideTypeIdx = wideIdx;
}

function wideTypes(ctx: CodegenContext): { wide: number; limbs: number; narrow: number } | undefined {
  const wide = ctx.nativeBigIntWideTypeIdx;
  const limbs = ctx.nativeBigIntLimbsTypeIdx;
  if (wide === undefined || limbs === undefined || ctx.nativeBigIntTypeIdx < 0) return undefined;
  return { wide, limbs, narrow: ctx.nativeBigIntTypeIdx };
}

// ── compile-time evaluation ────────────────────────────────────────────────

function bitLength(v: bigint): number {
  return (v < 0n ? -v : v).toString(2).length;
}

interface FoldState {
  overflow: boolean;
  /** Is `id` the unshadowed global binding (so `BigInt` really is %BigInt%)? */
  isGlobal: (id: ts.Identifier) => boolean;
}

/**
 * `BigInt(<string literal | bigint constant>)` and
 * `BigInt.asIntN/asUintN(<integer literal>, <bigint constant>)`, exactly. The
 * runtime lowering of both is i64: it wraps a wide result, and with a wide
 * literal on the other side of a comparison that is now visible.
 */
function evalBigIntCall(expr: ts.CallExpression, state: FoldState): bigint | undefined {
  const callee = expr.expression;
  const args = expr.arguments;
  if (ts.isIdentifier(callee)) {
    if (callee.text !== "BigInt" || args.length !== 1 || !state.isGlobal(callee)) return undefined;
    const arg = args[0]!;
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
      // StringToBigInt is the host's own; a SyntaxError stays a runtime throw.
      return literalValue(arg.text, false);
    }
    return evalBigIntConstant(arg, state);
  }
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return undefined;
  const name = callee.name.text;
  if (callee.expression.text !== "BigInt" || (name !== "asIntN" && name !== "asUintN")) return undefined;
  if (args.length !== 2 || !ts.isNumericLiteral(args[0]!) || !state.isGlobal(callee.expression)) return undefined;
  const bits = Number(args[0].text);
  if (!Number.isInteger(bits) || bits < 0 || bits > MAX_FOLD_BITS) return undefined;
  const value = evalBigIntConstant(args[1]!, state);
  if (value === undefined) return undefined;
  return name === "asIntN" ? BigInt.asIntN(bits, value) : BigInt.asUintN(bits, value);
}

function literalValue(text: string, sourceLiteral = true): bigint | undefined {
  try {
    return BigInt(sourceLiteral ? text.replace(/_/g, "").replace(/n$/i, "") : text);
  } catch {
    return undefined;
  }
}

function applyBinary(op: ts.SyntaxKind, l: bigint, r: bigint): bigint | undefined {
  const K = ts.SyntaxKind;
  switch (op) {
    case K.PlusToken:
      return l + r;
    case K.MinusToken:
      return l - r;
    case K.AsteriskToken:
      return l * r;
    case K.SlashToken:
      return r === 0n ? undefined : l / r;
    case K.PercentToken:
      return r === 0n ? undefined : l % r;
    case K.AsteriskAsteriskToken:
      if (r < 0n) return undefined;
      if (l === 0n || l === 1n || l === -1n) return l ** r;
      return BigInt(bitLength(l)) * r > BigInt(MAX_FOLD_BITS) ? undefined : l ** r;
    case K.AmpersandToken:
      return l & r;
    case K.BarToken:
      return l | r;
    case K.CaretToken:
      return l ^ r;
    case K.LessThanLessThanToken:
      return r > BigInt(MAX_FOLD_BITS) || r < -BigInt(MAX_FOLD_BITS) ? undefined : l << r;
    case K.GreaterThanGreaterThanToken:
      return r > BigInt(MAX_FOLD_BITS) || r < -BigInt(MAX_FOLD_BITS) ? undefined : l >> r;
    default:
      return undefined;
  }
}

/** The exact value of a bigint constant expression, or undefined. */
function evalBigIntConstant(expr: ts.Expression, state: FoldState): bigint | undefined {
  const t = ts;
  let value: bigint | undefined;
  if (t.isBigIntLiteral(expr)) {
    value = literalValue(expr.text);
  } else if (t.isParenthesizedExpression(expr)) {
    return evalBigIntConstant(expr.expression, state);
  } else if (t.isPrefixUnaryExpression(expr)) {
    if (expr.operator !== t.SyntaxKind.MinusToken && expr.operator !== t.SyntaxKind.TildeToken) return undefined;
    const operand = evalBigIntConstant(expr.operand, state);
    if (operand === undefined) return undefined;
    value = expr.operator === t.SyntaxKind.MinusToken ? -operand : ~operand;
  } else if (t.isBinaryExpression(expr)) {
    // Right operand first: a long left-deep chain (`s + a + b + …`) then
    // declines in O(1) per node instead of re-walking to its leftmost leaf.
    const right = evalBigIntConstant(expr.right, state);
    if (right === undefined) return undefined;
    const left = evalBigIntConstant(expr.left, state);
    if (left === undefined) return undefined;
    value = applyBinary(expr.operatorToken.kind, left, right);
  } else if (t.isCallExpression(expr)) {
    value = evalBigIntCall(expr, state);
  }
  if (value === undefined || bitLength(value) > MAX_FOLD_BITS) return undefined;
  if (value < I64_MIN || value > I64_MAX) state.overflow = true;
  return value;
}

/** A comparison of two bigint constant expressions, decided exactly. */
function compareBigIntConstants(expr: ts.BinaryExpression, state: FoldState): boolean | undefined {
  const K = ts.SyntaxKind;
  const op = expr.operatorToken.kind;
  const relational =
    op === K.LessThanToken ||
    op === K.LessThanEqualsToken ||
    op === K.GreaterThanToken ||
    op === K.GreaterThanEqualsToken;
  const equality =
    op === K.EqualsEqualsEqualsToken ||
    op === K.EqualsEqualsToken ||
    op === K.ExclamationEqualsEqualsToken ||
    op === K.ExclamationEqualsToken;
  if (!relational && !equality) return undefined;
  const right = evalBigIntConstant(expr.right, state);
  if (right === undefined) return undefined;
  const left = evalBigIntConstant(expr.left, state);
  if (left === undefined) return undefined;
  switch (op) {
    case K.LessThanToken:
      return left < right;
    case K.LessThanEqualsToken:
      return left <= right;
    case K.GreaterThanToken:
      return left > right;
    case K.GreaterThanEqualsToken:
      return left >= right;
    case K.EqualsEqualsEqualsToken:
    case K.EqualsEqualsToken:
      return left === right;
    default:
      return left !== right;
  }
}

function isFoldCandidate(expr: ts.Expression): boolean {
  const t = ts;
  return (
    t.isBigIntLiteral(expr) ||
    t.isBinaryExpression(expr) ||
    t.isPrefixUnaryExpression(expr) ||
    t.isParenthesizedExpression(expr) ||
    t.isCallExpression(expr)
  );
}

// ── materialisation ────────────────────────────────────────────────────────

/** Instructions leaving the carrier for an exact bigint value, as externref. */
function carrierInstrs(types: { wide: number; limbs: number; narrow: number }, value: bigint): Instr[] {
  if (value >= I64_MIN && value <= I64_MAX) {
    return [{ op: "i64.const", value }, { op: "struct.new", typeIdx: types.narrow }, { op: "extern.convert_any" }];
  }
  const magnitude = value < 0n ? -value : value;
  const limbs: Instr[] = [];
  for (let rest = magnitude; rest > 0n; rest >>= 32n) {
    limbs.push({ op: "i32.const", value: Number(BigInt.asIntN(32, rest & 0xffffffffn)) });
  }
  return [
    { op: "i64.const", value: BigInt.asIntN(64, value) },
    { op: "i32.const", value: value < 0n ? -1 : 1 },
    ...limbs,
    { op: "array.new_fixed", typeIdx: types.limbs, length: limbs.length },
    { op: "struct.new", typeIdx: types.wide },
    { op: "extern.convert_any" },
  ];
}

/**
 * The expression-level entry point: a bigint expression whose i64 lowering
 * would lose the value — a constant that leaves the i64 range, or an
 * unsigned 64-bit read landing in a reference slot.
 *
 * Returns undefined — leaving the ordinary lowering, byte for byte — otherwise.
 */
export function tryCompileWideBigIntExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
  expectedType: ValType | undefined,
): ValType | undefined {
  if (usesHostBigIntCarrier(ctx)) return undefined;
  return tryFoldBigIntConstant(ctx, fctx, expr, expectedType) ?? tryCompileUnsignedRead(ctx, fctx, expr, expectedType);
}

/**
 * `u64[i]` on a `BigUint64Array`, or `dv.getBigUint64(…)`. Both lower to the
 * i64 holding the element's bits, which the signed carrier reads as
 * `v - 2^64` for `v >= 2^63`. In a reference slot, box it unsigned. A
 * `BigInt64Array` element is boxed as the signed BigInt it is (its read is an
 * unbranded i64, which otherwise boxed as a Number).
 */
function tryCompileUnsignedRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
  expectedType: ValType | undefined,
): ValType | undefined {
  if (expectedType?.kind !== "externref" && expectedType?.kind !== "anyref") return undefined;
  const view = ts.isElementAccessExpression(expr) ? ctx.oracle.builtinReceiverOf(expr.expression) : undefined;
  const unsigned =
    view === "BigUint64Array" ||
    (ts.isCallExpression(expr) &&
      ts.isPropertyAccessExpression(expr.expression) &&
      expr.expression.name.text === "getBigUint64" &&
      ctx.oracle.builtinReceiverOf(expr.expression.expression) === "DataView");
  const types = wideTypes(ctx);
  if ((!unsigned && view !== "BigInt64Array") || types === undefined) return undefined;
  const box: Instr[] = unsigned
    ? [{ op: "call", funcIdx: ensureBigIntFromU64(ctx, types) }]
    : [{ op: "struct.new", typeIdx: types.narrow }, { op: "extern.convert_any" }];
  // No expected type: the ordinary read, which this hook then declines.
  // The code is emitted now, so every outcome must answer a type: a result
  // that is not the i64 goes back to the caller's coercion as is.
  const type = compileExpression(ctx, fctx, expr);
  if (type === null) {
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }
  if (type.kind !== "i64") return type;
  fctx.body.push(...box);
  return { kind: "externref" };
}

/** Fold a bigint constant expression whose i64 lowering would wrap. */
function tryFoldBigIntConstant(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
  expectedType: ValType | undefined,
): ValType | undefined {
  if (!isFoldCandidate(expr)) return undefined;
  const state: FoldState = { overflow: false, isGlobal: (id) => isGlobalBuiltinIdentifier(ctx, fctx, id) };
  const relation = ts.isBinaryExpression(expr) ? compareBigIntConstants(expr, state) : undefined;
  if (relation !== undefined) {
    if (!state.overflow) return undefined;
    fctx.body.push({ op: "i32.const", value: relation ? 1 : 0 });
    return { kind: "i32", boolean: true };
  }
  const value = evalBigIntConstant(expr, state);
  if (value === undefined || !state.overflow) return undefined;
  if (value >= I64_MIN && value <= I64_MAX) {
    fctx.body.push({ op: "i64.const", value });
    return { kind: "i64", bigint: true };
  }
  const types = wideTypes(ctx);
  const wantsRef = expectedType?.kind === "externref" || expectedType?.kind === "anyref";
  if (types === undefined || !wantsRef) {
    // No reference slot to hold it: the i64 this expression always produced.
    fctx.body.push({ op: "i64.const", value: BigInt.asIntN(64, value) });
    return { kind: "i64", bigint: true };
  }
  fctx.body.push(...carrierInstrs(types, value));
  return { kind: "externref" };
}

// ── runtime helpers ────────────────────────────────────────────────────────

function pushHelper(
  ctx: CodegenContext,
  name: string,
  params: ValType[],
  results: ValType[],
  locals: { name: string; type: ValType }[],
  body: Instr[],
): number {
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(name, funcIdx);
  pushDefinedFunc(ctx, funcIdx, { name, typeIdx: addFuncType(ctx, params, results), locals, body, exported: false });
  return funcIdx;
}

/**
 * `__bigint_from_u64(i64) -> externref` — the carrier for the UNSIGNED value
 * of 64 bits: a plain `$BigInt` below 2^63, else a two-limb `$BigIntWide`.
 */
function ensureBigIntFromU64(ctx: CodegenContext, types: { wide: number; limbs: number; narrow: number }): number {
  const existing = ctx.funcMap.get("__bigint_from_u64");
  if (existing !== undefined) return existing;
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "i64.const", value: 0n },
    { op: "i64.ge_s" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [{ op: "local.get", index: 0 }, { op: "struct.new", typeIdx: types.narrow }, { op: "extern.convert_any" }],
      else: [
        { op: "local.get", index: 0 },
        { op: "i32.const", value: 1 },
        { op: "local.get", index: 0 },
        { op: "i32.wrap_i64" },
        { op: "local.get", index: 0 },
        { op: "i64.const", value: 32n },
        { op: "i64.shr_u" },
        { op: "i32.wrap_i64" },
        { op: "array.new_fixed", typeIdx: types.limbs, length: 2 },
        { op: "struct.new", typeIdx: types.wide },
        { op: "extern.convert_any" },
      ],
    },
  ];
  return pushHelper(ctx, "__bigint_from_u64", [{ kind: "i64" }], [{ kind: "externref" }], [], body);
}

/**
 * Unary `-` on a statically-bigint operand that compiled to an `externref`
 * carrier (a script-global `var`, say). The generic path ran ToNumber on it and
 * answered the NUMBER `NaN`. True when it emitted the negation (an externref
 * carrier is then on the stack); false leaves the body untouched.
 */
export function emitBigIntCarrierNegate(ctx: CodegenContext, fctx: FunctionContext, operandType: ValType): boolean {
  if (operandType.kind !== "externref" || usesHostBigIntCarrier(ctx)) return false;
  const negIdx = ensureBigIntCarrierNeg(ctx);
  if (negIdx === undefined) return false;
  fctx.body.push({ op: "call", funcIdx: negIdx });
  return true;
}

/**
 * `__bigint_carrier_neg(externref) -> externref` — §6.1.6.2.1
 * BigInt::unaryMinus on a carrier, exact across the i64 boundary:
 * `-(-2^63)` is promoted to the wide form and `-(2^63)` demoted back to i64.
 * A value that is not a BigInt carrier is negated as a Number (ToNumeric).
 */
function ensureBigIntCarrierNeg(ctx: CodegenContext): number | undefined {
  const existing = ctx.funcMap.get("__bigint_carrier_neg");
  if (existing !== undefined) return existing;
  const types = wideTypes(ctx);
  const toNumber = ctx.funcMap.get("__unbox_number");
  const boxNumber = ctx.funcMap.get("__box_number");
  if (types === undefined || toNumber === undefined || boxNumber === undefined) return undefined;
  const ANY = 1;
  const WIDE = 2;
  const VALUE = 3;
  const TWO_POW_63 = carrierInstrs(types, 1n << 63n);
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: ANY },
    { op: "ref.test", typeIdx: types.wide },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: ANY },
        { op: "ref.cast", typeIdx: types.wide },
        { op: "local.set", index: WIDE },
        // +2^63 (sign 1, mag [0, 0x80000000]) negates to i64 MIN: demote.
        { op: "local.get", index: WIDE },
        { op: "struct.get", typeIdx: types.wide, fieldIdx: WIDE_FIELD_SIGN },
        { op: "i32.const", value: 1 },
        { op: "i32.eq" },
        { op: "local.get", index: WIDE },
        { op: "struct.get", typeIdx: types.wide, fieldIdx: WIDE_FIELD_MAG },
        { op: "array.len" },
        { op: "i32.const", value: 2 },
        { op: "i32.eq" },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: WIDE },
            { op: "struct.get", typeIdx: types.wide, fieldIdx: WIDE_FIELD_VALUE },
            { op: "i64.const", value: I64_MIN },
            { op: "i64.eq" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "i64.const", value: I64_MIN },
                { op: "struct.new", typeIdx: types.narrow },
                { op: "extern.convert_any" },
                { op: "return" },
              ],
            },
          ],
        },
        { op: "i64.const", value: 0n },
        { op: "local.get", index: WIDE },
        { op: "struct.get", typeIdx: types.wide, fieldIdx: WIDE_FIELD_VALUE },
        { op: "i64.sub" },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: WIDE },
        { op: "struct.get", typeIdx: types.wide, fieldIdx: WIDE_FIELD_SIGN },
        { op: "i32.sub" },
        { op: "local.get", index: WIDE },
        { op: "struct.get", typeIdx: types.wide, fieldIdx: WIDE_FIELD_MAG },
        { op: "struct.new", typeIdx: types.wide },
        { op: "extern.convert_any" },
        { op: "return" },
      ],
    },
    { op: "local.get", index: ANY },
    { op: "ref.test", typeIdx: types.narrow },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: ANY },
        { op: "ref.cast", typeIdx: types.narrow },
        { op: "struct.get", typeIdx: types.narrow, fieldIdx: 0 },
        { op: "local.tee", index: VALUE },
        { op: "i64.const", value: I64_MIN },
        { op: "i64.eq" },
        { op: "if", blockType: { kind: "empty" }, then: [...TWO_POW_63, { op: "return" }] },
        { op: "i64.const", value: 0n },
        { op: "local.get", index: VALUE },
        { op: "i64.sub" },
        { op: "struct.new", typeIdx: types.narrow },
        { op: "extern.convert_any" },
        { op: "return" },
      ],
    },
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: toNumber },
    { op: "f64.neg" },
    { op: "call", funcIdx: boxNumber },
  ];
  return pushHelper(
    ctx,
    "__bigint_carrier_neg",
    [{ kind: "externref" }],
    [{ kind: "externref" }],
    [
      { name: "any", type: { kind: "anyref" } },
      { name: "wide", type: { kind: "ref_null", typeIdx: types.wide } },
      { name: "value", type: { kind: "i64" } },
    ],
    body,
  );
}

/**
 * `bigint_wide_toString_radix(anyref, i32) -> externref` — exact ToString of a
 * `$BigIntWide` in radix 2..36, by repeated short division of a copy of the
 * magnitude. The argument must already be known to be a `$BigIntWide`.
 */
function ensureWideFormatter(ctx: CodegenContext): number | undefined {
  const existing = ctx.funcMap.get("bigint_wide_toString_radix");
  if (existing !== undefined) return existing;
  const types = wideTypes(ctx);
  if (types === undefined || !ctx.nativeStrings || ctx.nativeStrTypeIdx < 0) return undefined;
  ensureNativeStringHelpers(ctx);
  const data = ctx.nativeStrDataTypeIdx;
  const P_VALUE = 0;
  const P_RADIX = 1;
  const WIDE = 2;
  const WORK = 3;
  const N = 4;
  const BUF = 5;
  const CURSOR = 6;
  const I = 7;
  const REM = 8;
  const CUR = 9;
  const DIGIT = 10;
  const CAP = 11;
  const write = (code: Instr[]): Instr[] => [
    { op: "local.get", index: BUF },
    { op: "local.get", index: CURSOR },
    ...code,
    { op: "array.set", typeIdx: data },
    { op: "local.get", index: CURSOR },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "local.set", index: CURSOR },
  ];
  const trim: Instr = {
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          { op: "local.get", index: N },
          { op: "i32.eqz" },
          { op: "br_if", depth: 1 },
          { op: "local.get", index: WORK },
          { op: "local.get", index: N },
          { op: "i32.const", value: 1 },
          { op: "i32.sub" },
          { op: "array.get", typeIdx: types.limbs },
          { op: "br_if", depth: 1 },
          { op: "local.get", index: N },
          { op: "i32.const", value: 1 },
          { op: "i32.sub" },
          { op: "local.set", index: N },
          { op: "br", depth: 0 },
        ],
      },
    ],
  };
  // One short division of WORK[0..N) by the radix; the remainder is a digit.
  const divide: Instr[] = [
    { op: "i64.const", value: 0n },
    { op: "local.set", index: REM },
    { op: "local.get", index: N },
    { op: "local.set", index: I },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: I },
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: I },
            { op: "i32.const", value: 1 },
            { op: "i32.sub" },
            { op: "local.set", index: I },
            { op: "local.get", index: REM },
            { op: "i64.const", value: 32n },
            { op: "i64.shl" },
            { op: "local.get", index: WORK },
            { op: "local.get", index: I },
            { op: "array.get", typeIdx: types.limbs },
            { op: "i64.extend_i32_u" },
            { op: "i64.or" },
            { op: "local.set", index: CUR },
            { op: "local.get", index: WORK },
            { op: "local.get", index: I },
            { op: "local.get", index: CUR },
            { op: "local.get", index: P_RADIX },
            { op: "i64.extend_i32_u" },
            { op: "i64.div_u" },
            { op: "i32.wrap_i64" },
            { op: "array.set", typeIdx: types.limbs },
            { op: "local.get", index: CUR },
            { op: "local.get", index: P_RADIX },
            { op: "i64.extend_i32_u" },
            { op: "i64.rem_u" },
            { op: "local.set", index: REM },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "local.get", index: REM },
    { op: "i32.wrap_i64" },
    { op: "local.set", index: DIGIT },
    ...write([
      { op: "local.get", index: DIGIT },
      { op: "i32.const", value: 10 },
      { op: "i32.lt_u" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [{ op: "local.get", index: DIGIT }, { op: "i32.const", value: 48 }, { op: "i32.add" }],
        else: [{ op: "local.get", index: DIGIT }, { op: "i32.const", value: 87 }, { op: "i32.add" }],
      },
    ]),
  ];
  const body: Instr[] = [
    { op: "local.get", index: P_VALUE },
    { op: "ref.cast", typeIdx: types.wide },
    { op: "local.tee", index: WIDE },
    { op: "struct.get", typeIdx: types.wide, fieldIdx: WIDE_FIELD_MAG },
    { op: "array.len" },
    { op: "local.tee", index: N },
    { op: "array.new_default", typeIdx: types.limbs },
    { op: "local.set", index: WORK },
    { op: "local.get", index: WORK },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: WIDE },
    { op: "struct.get", typeIdx: types.wide, fieldIdx: WIDE_FIELD_MAG },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: N },
    { op: "array.copy", dstTypeIdx: types.limbs, srcTypeIdx: types.limbs },
    // radix 2 needs 32 digits per limb, plus the sign and one spare.
    { op: "local.get", index: N },
    { op: "i32.const", value: 32 },
    { op: "i32.mul" },
    { op: "i32.const", value: 2 },
    { op: "i32.add" },
    { op: "local.tee", index: CAP },
    { op: "array.new_default", typeIdx: data },
    { op: "local.set", index: BUF },
    { op: "local.get", index: CAP },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "local.set", index: CURSOR },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            trim,
            { op: "local.get", index: N },
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            ...divide,
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "local.get", index: WIDE },
    { op: "struct.get", typeIdx: types.wide, fieldIdx: WIDE_FIELD_SIGN },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    { op: "if", blockType: { kind: "empty" }, then: write([{ op: "i32.const", value: 45 }]) },
    { op: "local.get", index: CAP },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "local.get", index: CURSOR },
    { op: "i32.sub" },
    { op: "local.get", index: CURSOR },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.get", index: BUF },
    { op: "struct.new", typeIdx: ctx.nativeStrTypeIdx },
    { op: "extern.convert_any" },
  ];
  return pushHelper(
    ctx,
    "bigint_wide_toString_radix",
    [{ kind: "anyref" }, { kind: "i32" }],
    [{ kind: "externref" }],
    [
      { name: "wide", type: { kind: "ref_null", typeIdx: types.wide } },
      { name: "work", type: { kind: "ref_null", typeIdx: types.limbs } },
      { name: "n", type: { kind: "i32" } },
      { name: "buf", type: { kind: "ref_null", typeIdx: data } },
      { name: "cursor", type: { kind: "i32" } },
      { name: "i", type: { kind: "i32" } },
      { name: "rem", type: { kind: "i64" } },
      { name: "cur", type: { kind: "i64" } },
      { name: "digit", type: { kind: "i32" } },
      { name: "cap", type: { kind: "i32" } },
    ],
    body,
  );
}

/**
 * A guard for a ToString site that already holds a bigint carrier in the
 * anyref local `anyLocal`: when it is a `$BigIntWide`, format it exactly and
 * run `tail` on the externref result. Empty when the module has no wide form,
 * so the caller's i64 path is untouched.
 */
export function wideToStringArm(ctx: CodegenContext, anyLocal: number, radix: Instr[], tail: Instr[]): Instr[] {
  const types = wideTypes(ctx);
  if (types === undefined) return [];
  const formatIdx = ensureWideFormatter(ctx);
  if (formatIdx === undefined) return [];
  return [
    { op: "local.get", index: anyLocal },
    { op: "ref.test", typeIdx: types.wide },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: anyLocal }, ...radix, { op: "call", funcIdx: formatIdx }, ...tail],
    },
  ];
}

/**
 * A ToString site that just compiled a bigint operand: when the operand's
 * last instruction is the `call __to_bigint` a checker-narrowed
 * (`typeof x === "bigint"`) reference slot gets on read, drop that unbox and
 * format the CARRIER instead, so a wide value is not reduced to its low 64
 * bits. `radixF64Local` is the f64 local holding the radix argument (absent:
 * radix 10). True when it emitted the call (the externref string is then on
 * the stack); false leaves the body untouched.
 */
export function emitNarrowedCarrierToString(
  ctx: CodegenContext,
  fctx: FunctionContext,
  radixF64Local?: number,
): boolean {
  const radix: Instr[] =
    radixF64Local === undefined
      ? [{ op: "i32.const", value: 10 }]
      : [{ op: "local.get", index: radixF64Local }, { op: "i32.trunc_sat_f64_s" }];
  const toBigInt = ctx.funcMap.get("__to_bigint");
  const last = fctx.body[fctx.body.length - 1];
  if (toBigInt === undefined || last === undefined || last.op !== "call" || last.funcIdx !== toBigInt) return false;
  const formatIdx = ensureBigIntCarrierFormatter(ctx);
  if (formatIdx === undefined) return false;
  fctx.body.pop();
  fctx.body.push(...radix, { op: "call", funcIdx: formatIdx });
  return true;
}

/**
 * `bigint_carrier_toString_radix(externref, i32) -> externref` — exact
 * ToString of any bigint carrier: the wide form, else the i64 (a non-carrier
 * goes through `__to_bigint`, which throws the TypeError it always threw).
 */
function ensureBigIntCarrierFormatter(ctx: CodegenContext): number | undefined {
  const existing = ctx.funcMap.get("bigint_carrier_toString_radix");
  if (existing !== undefined) return existing;
  const types = wideTypes(ctx);
  const toBigInt = ctx.funcMap.get("__to_bigint");
  if (types === undefined || toBigInt === undefined || !ctx.nativeStrings || ctx.nativeStrTypeIdx < 0) return undefined;
  if (!ctx.funcMap.has("bigint_toString_radix")) emitNativeBigIntFormat(ctx, new Set(["bigint_toString_radix"]));
  const narrowFormat = ctx.funcMap.get("bigint_toString_radix");
  if (narrowFormat === undefined) return undefined;
  const ANY = 2;
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.set", index: ANY },
    ...wideToStringArm(ctx, ANY, [{ op: "local.get", index: 1 }], [{ op: "return" }]),
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: toBigInt },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: narrowFormat },
  ];
  return pushHelper(
    ctx,
    "bigint_carrier_toString_radix",
    [{ kind: "externref" }, { kind: "i32" }],
    [{ kind: "externref" }],
    [{ name: "any", type: { kind: "anyref" } }],
    body,
  );
}

/**
 * `__bigint_carrier_eq(anyref, anyref) -> i32` — BigInt::equal (§6.1.6.2.13)
 * for two values already known to be bigint carriers. Canonical form makes a
 * wide value never equal to an i64 one, and two wide values equal exactly when
 * sign and magnitude limbs agree.
 */
function ensureBigIntCarrierEq(ctx: CodegenContext): number | undefined {
  const existing = ctx.funcMap.get("__bigint_carrier_eq");
  if (existing !== undefined) return existing;
  const types = wideTypes(ctx);
  if (types === undefined) return undefined;
  const WA = 2;
  const WB = 3;
  const N = 4;
  const I = 5;
  const isWide = (index: number): Instr[] => [
    { op: "local.get", index },
    { op: "ref.test", typeIdx: types.wide },
  ];
  const field = (local: number, fieldIdx: number): Instr[] => [
    { op: "local.get", index: local },
    { op: "struct.get", typeIdx: types.wide, fieldIdx },
  ];
  const returnFalse: Instr[] = [{ op: "i32.const", value: 0 }, { op: "return" }];
  const body: Instr[] = [
    ...isWide(0),
    ...isWide(1),
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...isWide(0),
        ...isWide(1),
        { op: "i32.and" },
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "empty" }, then: returnFalse },
        { op: "local.get", index: 0 },
        { op: "ref.cast", typeIdx: types.wide },
        { op: "local.set", index: WA },
        { op: "local.get", index: 1 },
        { op: "ref.cast", typeIdx: types.wide },
        { op: "local.set", index: WB },
        ...field(WA, WIDE_FIELD_SIGN),
        ...field(WB, WIDE_FIELD_SIGN),
        { op: "i32.ne" },
        { op: "if", blockType: { kind: "empty" }, then: returnFalse },
        ...field(WA, WIDE_FIELD_MAG),
        { op: "array.len" },
        { op: "local.tee", index: N },
        ...field(WB, WIDE_FIELD_MAG),
        { op: "array.len" },
        { op: "i32.ne" },
        { op: "if", blockType: { kind: "empty" }, then: returnFalse },
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: I },
            { op: "local.get", index: N },
            { op: "i32.ge_u" },
            { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
            ...field(WA, WIDE_FIELD_MAG),
            { op: "local.get", index: I },
            { op: "array.get", typeIdx: types.limbs },
            ...field(WB, WIDE_FIELD_MAG),
            { op: "local.get", index: I },
            { op: "array.get", typeIdx: types.limbs },
            { op: "i32.ne" },
            { op: "if", blockType: { kind: "empty" }, then: returnFalse },
            { op: "local.get", index: I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "local.get", index: 0 },
    { op: "ref.cast", typeIdx: types.narrow },
    { op: "struct.get", typeIdx: types.narrow, fieldIdx: 0 },
    { op: "local.get", index: 1 },
    { op: "ref.cast", typeIdx: types.narrow },
    { op: "struct.get", typeIdx: types.narrow, fieldIdx: 0 },
    { op: "i64.eq" },
  ];
  return pushHelper(
    ctx,
    "__bigint_carrier_eq",
    [{ kind: "anyref" }, { kind: "anyref" }],
    [{ kind: "i32" }],
    [
      { name: "wa", type: { kind: "ref_null", typeIdx: types.wide } },
      { name: "wb", type: { kind: "ref_null", typeIdx: types.wide } },
      { name: "n", type: { kind: "i32" } },
      { name: "i", type: { kind: "i32" } },
    ],
    body,
  );
}

/**
 * `===` of two bigint carriers held in anyref locals `a` and `b` (both already
 * tested to be `$BigInt`), leaving an i32. Exact for the wide form; the plain
 * i64 comparison when the module has none.
 */
export function bigIntCarrierEqInstrs(ctx: CodegenContext, a: number, b: number): Instr[] {
  const eqIdx = ensureBigIntCarrierEq(ctx);
  if (eqIdx !== undefined) {
    return [
      { op: "local.get", index: a },
      { op: "local.get", index: b },
      { op: "call", funcIdx: eqIdx },
    ];
  }
  return [
    { op: "local.get", index: a },
    { op: "ref.cast", typeIdx: ctx.nativeBigIntTypeIdx },
    { op: "struct.get", typeIdx: ctx.nativeBigIntTypeIdx, fieldIdx: 0 },
    { op: "local.get", index: b },
    { op: "ref.cast", typeIdx: ctx.nativeBigIntTypeIdx },
    { op: "struct.get", typeIdx: ctx.nativeBigIntTypeIdx, fieldIdx: 0 },
    { op: "i64.eq" },
  ];
}
