// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6788) JS-host ToPrimitive for a compiled ARRAY carrier — and the ToString
 * tail for any struct carrier that reaches the host unreduced.
 *
 * ## The defect
 *
 * On the JS-host lane a `number[]` is a WasmGC vec struct. Measured 2026-09-30
 * against Node, several primitive-expecting entry points treated that struct
 * as if it were already a primitive:
 *
 * ```js
 * const arr: number[] = [0, 9, 0];
 * String(arr);       // the array itself — must be "0,9,0"
 * `${arr}`;          // the array itself
 * +[1];              // NaN — must be 1
 * Number([5]);       // NaN — must be 5
 * [] + [];           // NaN — must be ""
 * [1, 2] == "1,2";   // false — must be true
 * [10] < [9];        // false — must be true (two STRING primitives compare lexically)
 * ```
 *
 * String()/template ran the string-hint coercion, found no in-Wasm `toString`
 * on the vec, and returned the carrier. ToNumber handed the RAW vec to the host
 * `__to_primitive`, whose struct walker answers "[object Object]" → NaN. The
 * `+`/relational/`==` lowerings never ran the ToPrimitive step at all: they
 * applied ToNumber to the raw operand.
 *
 * ## The fix: OrdinaryToPrimitive of an array is its join
 *
 * For an array, `valueOf` returns the object itself, so OrdinaryToPrimitive
 * (any hint) reaches `Array.prototype.toString` — `join(",")`. The JS-host lane
 * already owns a value-level join that stringifies every element kind the vec
 * can hold, including struct and nested-vec elements: `__extern_join_str`,
 * the element stringifier `arr.join()`/`arr.toString()` use (#1998/#3637). On
 * a vec it recurses into `join(",")`. {@link emitHostArrayToPrimitive} applies
 * it, and each entry point then performs only its own final conversion:
 *
 *   - ToNumber (unary `+`, `Number()`, `-`/`*`/`**`/bitwise) — host ToNumber of
 *     the joined string ({@link emitHostArrayCarrierToNumber});
 *   - ToString (`String()`, template substitution, `String.raw`) — the joined
 *     string itself; a non-array struct with no in-Wasm `toString` gets the
 *     host ToString instead ({@link emitHostCarrierToStringTail});
 *   - `+`, relational, loose `==` — both operands are evaluated first, then the
 *     array side is reduced and the host operator applies the rest of
 *     §13.15.3 / §7.2.13 / §7.2.15 ({@link emitHostArrayCarrierBinary}).
 *
 * The `__make_iterable` host MIRROR is deliberately not the reduction path: it
 * keeps struct elements raw, and a host `join` over a raw WasmGC struct throws
 * "Cannot convert object to primitive value".
 *
 * ## Scope
 *
 * JS-host lane only ({@link hostLane}); standalone already reduces a vec
 * in-module (`array-to-primitive.ts`, #2358). The binary arms admit an operand
 * whose static fact is an ARRAY and never an `any`/`unknown`/string/bigint one,
 * so `arr + ""` (the reference spelling), `any + x` and BigInt arithmetic keep
 * their existing lowering. Loose equality is admitted only against a
 * primitive-typed other side: two objects compare by identity and never reach
 * ToPrimitive (§7.2.15 step 1), and `arr == null` keeps its nullish path.
 *
 * Known residue: a `boolean[]` vec stores i32 elements, so the value-level join
 * renders `[true]` as "1" — the same answer `arr + ""` gives today. The static
 * `arr.toString()` lowering, which can see the element type, is unaffected.
 */
import type { TypeFact } from "../checker/oracle.js";
import type { Instr, ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { emitHostEqualityFromStack } from "./coercion-engine.js";
import { allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { getArrTypeIdxFromVec } from "./registry/types.js";
import {
  coerceType,
  compileExpression,
  ensureExternrefToStringProvider,
  ensureLateImport,
  flushLateImportShifts,
} from "./shared.js";

const EXTERN: ValType = { kind: "externref" };

/** The JS-host lane: a compiled carrier reaches a host operation, not an in-module one. */
function hostLane(ctx: CodegenContext): boolean {
  return !ctx.standalone && !ctx.wasi && ctx.targetProfile.semanticProviders !== "native-first";
}

/**
 * Is a ref of `typeIdx` a JS-host ARRAY carrier — the vec structs that cross
 * the boundary as a `__make_iterable` array mirror (#854)? Byte vecs
 * (ArrayBuffer / DataView backing, #1056) are excluded: they are not arrays,
 * and their method dispatch depends on keeping the WasmGC identity.
 */
export function isHostArrayCarrier(ctx: CodegenContext, typeIdx: number): boolean {
  return hostLane(ctx) && getArrTypeIdxFromVec(ctx, typeIdx) >= 0 && ctx.vecTypeMap.get("i32_byte") !== typeIdx;
}

/**
 * ToPrimitive of an array carrier ALREADY converted to externref on the stack:
 * its `join(",")` string, or the null itself when the reference is null (so the
 * consumer's own conversion sees ToPrimitive(null) = null). Leaves externref.
 */
function emitHostArrayToPrimitive(ctx: CodegenContext, fctx: FunctionContext, nullArm: Instr[]): void {
  const joinIdx = ensureLateImport(ctx, "__extern_join_str", [EXTERN], [EXTERN]);
  flushLateImportShifts(ctx, fctx);
  const finalIdx = ctx.funcMap.get("__extern_join_str") ?? joinIdx;
  if (finalIdx === undefined) return;
  const value = allocTempLocal(fctx, EXTERN);
  fctx.body.push(
    { op: "local.tee", index: value },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: EXTERN },
      then: nullArm,
      else: [
        { op: "local.get", index: value },
        { op: "call", funcIdx: finalIdx },
      ],
    },
  );
  releaseTempLocal(fctx, value);
}

/**
 * ToNumber of an array carrier on the stack (§7.1.4: ToPrimitive with hint
 * number, then StringToNumber of the join). Emits nothing and returns false off
 * the host lane, for a non-array ref, and for the DEFAULT hint: a `+`/`==` that
 * reaches an f64 lowering with an array operand has already skipped its
 * string-vs-number (or identity) decision, and turning its NaN into the join's
 * number would make `[1] == [1]` true. Those operators are routed through
 * {@link emitHostArrayCarrierBinary} before they get that far.
 */
export function emitHostArrayCarrierToNumber(
  ctx: CodegenContext,
  fctx: FunctionContext,
  typeIdx: number,
  hint: "number" | "string" | "default" | undefined,
): boolean {
  if (hint === "default" || !isHostArrayCarrier(ctx, typeIdx)) return false;
  fctx.body.push({ op: "extern.convert_any" });
  emitHostArrayToPrimitive(ctx, fctx, [{ op: "ref.null.extern" }]);
  coerceType(ctx, fctx, EXTERN, { kind: "f64" }, "number");
  return true;
}

/**
 * The ToString half of a string-hint `coerceType(ref → externref)` on the host
 * lane, called right after the struct's `extern.convert_any` on the arm where
 * no in-Wasm `@@toPrimitive` or `toString` reduced it. A string-hint consumer
 * (`String()`, a template span, `String.raw`) must receive a string, not the
 * object: an array carrier yields its join, any other struct the host ToString
 * (which runs the remaining OrdinaryToPrimitive walk: the struct's own methods,
 * else "[object Object]"). Returns false off the host lane (nothing emitted).
 */
export function emitHostCarrierToStringTail(ctx: CodegenContext, fctx: FunctionContext, typeIdx: number): boolean {
  if (!hostLane(ctx)) return false;
  if (isHostArrayCarrier(ctx, typeIdx)) {
    addStringConstantGlobal(ctx, "null");
    emitHostArrayToPrimitive(ctx, fctx, stringConstantExternrefInstrs(ctx, "null"));
    return true;
  }
  const toStringIdx = ensureExternrefToStringProvider(ctx, fctx, "string");
  if (toStringIdx !== undefined) fctx.body.push({ op: "call", funcIdx: toStringIdx });
  return true;
}

const NON_REDUCING = ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.BigIntLike | ts.TypeFlags.StringLike;

const isArrayFact = (fact: TypeFact): boolean => fact.kind === "array";

const isPrimitiveFact = (fact: TypeFact): boolean =>
  fact.kind === "number" || fact.kind === "string" || fact.kind === "boolean";

const isObjectFact = (fact: TypeFact): boolean =>
  fact.kind === "array" ||
  fact.kind === "tuple" ||
  fact.kind === "object" ||
  fact.kind === "class" ||
  fact.kind === "function" ||
  fact.kind === "builtin";

/** The host operator an array-carrier binary expression needs (see {@link hostArrayCarrierBinaryArm}). */
export type HostArrayCarrierArm = "add" | "relational" | "loose-eq" | "identity";

const RELATIONAL = new Set([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

/**
 * Which host operator an array-carrier binary expression needs, or undefined to
 * keep the existing lowering. Loose equality against another OBJECT is
 * `"identity"` (§7.2.15 step 1 → IsStrictlyEqual): no ToPrimitive happens.
 */
export function hostArrayCarrierBinaryArm(
  ctx: CodegenContext,
  expr: ts.BinaryExpression,
  leftTsType: ts.Type,
  rightTsType: ts.Type,
): HostArrayCarrierArm | undefined {
  if (!hostLane(ctx)) return undefined;
  const leftFact = ctx.oracle.typeFactOf(expr.left);
  const rightFact = ctx.oracle.typeFactOf(expr.right);
  if (!isArrayFact(leftFact) && !isArrayFact(rightFact)) return undefined;
  const op = expr.operatorToken.kind;
  if (op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken) {
    const other = isArrayFact(leftFact) ? rightFact : leftFact;
    if (isObjectFact(other)) return "identity";
    return isPrimitiveFact(other) ? "loose-eq" : undefined;
  }
  if ((leftTsType.flags & NON_REDUCING) !== 0 || (rightTsType.flags & NON_REDUCING) !== 0) return undefined;
  if (op === ts.SyntaxKind.PlusToken) return "add";
  return RELATIONAL.has(op) ? "relational" : undefined;
}

/**
 * `==`/`!=` between an array carrier and another object: reference identity.
 * Two GC refs compare with `ref.eq`; an operand that is already externref (a
 * host value) sends both across — an array as its identity-cached mirror — to
 * the host strict equality.
 */
function emitObjectIdentityEquality(ctx: CodegenContext, fctx: FunctionContext, expr: ts.BinaryExpression): ValType {
  const negate = expr.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken;
  const isRef = (type: ValType): boolean => type.kind === "ref" || type.kind === "ref_null";
  const left = compileExpression(ctx, fctx, expr.left) ?? pushNullExtern(fctx);
  const right = compileExpression(ctx, fctx, expr.right) ?? pushNullExtern(fctx);
  if (!isRef(left) || !isRef(right)) return emitHostEqualityFromStack(ctx, fctx, left, right, true, negate);
  fctx.body.push({ op: "ref.eq" });
  if (negate) fctx.body.push({ op: "i32.eqz" });
  return { kind: "i32" };
}

function pushNullExtern(fctx: FunctionContext): ValType {
  fctx.body.push({ op: "ref.null.extern" });
  return EXTERN;
}

/** Host `__host_compare`'s -1/0/1/2 (2 = incomparable) → the operator's boolean. */
function relationalFromCompare(op: ts.SyntaxKind, cmp: number): Instr[] {
  const is = (value: number): Instr[] => [
    { op: "local.get", index: cmp },
    { op: "i32.const", value },
    { op: "i32.eq" },
  ];
  if (op === ts.SyntaxKind.LessThanToken) return is(-1);
  if (op === ts.SyntaxKind.GreaterThanToken) return is(1);
  const strict = is(op === ts.SyntaxKind.LessThanEqualsToken ? -1 : 1);
  return [...strict, { op: "local.get", index: cmp }, { op: "i32.eqz" }, { op: "i32.or" }];
}

/**
 * Emit `+` / relational / loose `==` for an expression {@link hostArrayCarrierBinaryArm}
 * admitted. Both operands are evaluated BEFORE either is reduced (§13.15.3 step
 * 1-4, §13.10.1, §7.2.15), because the join can run user `toString`s on the
 * elements. Each array carrier is then replaced by its ToPrimitive, every other
 * operand crosses as usual, and the host operator finishes the job.
 */
export function emitHostArrayCarrierBinary(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  arm: HostArrayCarrierArm,
): ValType {
  if (arm === "identity") return emitObjectIdentityEquality(ctx, fctx, expr);
  const saved: { local: number; type: ValType }[] = [];
  for (const operand of [expr.left, expr.right]) {
    const type = compileExpression(ctx, fctx, operand) ?? pushNullExtern(fctx);
    const local = allocTempLocal(fctx, type);
    fctx.body.push({ op: "local.set", index: local });
    saved.push({ local, type });
  }
  for (const { local, type } of saved) {
    fctx.body.push({ op: "local.get", index: local });
    if ((type.kind === "ref" || type.kind === "ref_null") && isHostArrayCarrier(ctx, type.typeIdx)) {
      fctx.body.push({ op: "extern.convert_any" });
      emitHostArrayToPrimitive(ctx, fctx, [{ op: "ref.null.extern" }]);
    } else if (type.kind !== "externref") {
      coerceType(ctx, fctx, type, EXTERN);
    }
    releaseTempLocal(fctx, local);
  }
  const op = expr.operatorToken.kind;
  if (arm === "loose-eq") {
    return emitHostEqualityFromStack(ctx, fctx, EXTERN, EXTERN, false, op === ts.SyntaxKind.ExclamationEqualsToken);
  }
  const name = arm === "add" ? "__host_add" : "__host_compare";
  const result: ValType = arm === "add" ? EXTERN : { kind: "i32" };
  const provisional = ensureLateImport(ctx, name, [EXTERN, EXTERN], [result]);
  flushLateImportShifts(ctx, fctx);
  const funcIdx = ctx.funcMap.get(name) ?? provisional;
  if (funcIdx === undefined) throw new Error(`Missing import after ensureLateImport: ${name}`);
  fctx.body.push({ op: "call", funcIdx });
  if (arm === "add") return EXTERN;
  const cmp = allocTempLocal(fctx, { kind: "i32" });
  fctx.body.push({ op: "local.set", index: cmp }, ...relationalFromCompare(op, cmp));
  releaseTempLocal(fctx, cmp);
  return { kind: "i32" };
}
