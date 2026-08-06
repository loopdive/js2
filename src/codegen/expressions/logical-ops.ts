// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Logical operator compilation: &&, ||, ??, and mapped arguments helpers.
 */
import { ts } from "../../ts-api.js";
import type { Instr, ValType } from "../../ir/types.js";
import { pushBody } from "../context/bodies.js";
import { reportError } from "../context/errors.js";
import { allocLocal, allocTempLocal, releaseTempLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { ensureI32Condition } from "../index.js";
import { coerceType, compileExpression, valTypesMatch } from "../shared.js";
import { defaultValueInstrs } from "../type-coercion.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";

type MappedArgsInfo = NonNullable<FunctionContext["mappedArgsInfo"]>;

/** Runtime half of the mapped-arguments guard. A null state local means no
 * runtime eval has initialized/severed the map yet, so the correspondence is
 * still live. Once initialized, a null vector entry means it was severed. */
function runtimeMappedEntryIsLive(
  ctx: CodegenContext,
  fctx: FunctionContext,
  info: MappedArgsInfo,
  argIndex: number,
): Instr[] | null {
  const mapLocal = info.runtimeMappedNamesLocalIdx;
  if (mapLocal === undefined) return null;
  const externref: ValType = { kind: "externref" };
  const getIdx = ensureLateImport(ctx, "__extern_get_idx", [externref, { kind: "f64" }], [externref]);
  flushLateImportShifts(ctx, fctx);
  const liveGetIdx = ctx.funcMap.get("__extern_get_idx") ?? getIdx;
  if (liveGetIdx === undefined) return null;
  return [
    { op: "local.get", index: mapLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 1 }],
      else: [
        { op: "local.get", index: mapLocal },
        { op: "f64.const", value: argIndex },
        { op: "call", funcIdx: liveGetIdx },
        { op: "ref.is_null" },
        { op: "i32.eqz" },
      ],
    },
  ];
}

export function compileLogicalAnd(ctx: CodegenContext, fctx: FunctionContext, expr: ts.BinaryExpression): ValType {
  // JS semantics: a && b → if a is falsy, return a; else return b
  const leftType = compileExpression(ctx, fctx, expr.left);
  if (!leftType) {
    ensureI32Condition(fctx, leftType, ctx);
    return { kind: "i32" };
  }

  // Save LHS value for JS value semantics, then check truthiness
  const tmp = allocTempLocal(fctx, leftType);
  fctx.body.push({ op: "local.tee", index: tmp });
  ensureI32Condition(fctx, leftType, ctx);

  // Compile RHS in a side buffer to discover its natural type
  const savedBody = pushBody(fctx);
  const rightType = compileExpression(ctx, fctx, expr.right);
  let thenInstrs = fctx.body;
  fctx.body = savedBody;

  // If the RHS is void, push a default value so the if-block has a consistent result.
  // JS coerces undefined to NaN for numbers, null for externref, etc.
  if (!rightType) {
    // RHS produced no value — use the left type as the result and push a default
    // for the then-branch (RHS path). The else-branch returns the LHS value.
    const resultType = leftType;
    thenInstrs.push(...defaultValueInstrs(resultType));
    const elseInstrs: Instr[] = [{ op: "local.get", index: tmp }];
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: resultType },
      then: thenInstrs,
      else: elseInstrs,
    });
    releaseTempLocal(fctx, tmp);
    return resultType;
  }

  const rType: ValType = rightType;

  // Determine common result type (like conditional expression)
  let resultType: ValType = leftType;
  if (!valTypesMatch(leftType, rType)) {
    if ((leftType.kind === "i32" || leftType.kind === "f64") && (rType.kind === "i32" || rType.kind === "f64")) {
      resultType = { kind: "f64" };
    } else {
      resultType = { kind: "externref" };
    }
  }

  // Coerce then-branch (RHS) to common type if needed
  if (!valTypesMatch(rType, resultType)) {
    const coerceBody: Instr[] = [];
    fctx.body = coerceBody;
    coerceType(ctx, fctx, rType, resultType);
    fctx.body = savedBody;
    thenInstrs = [...thenInstrs, ...coerceBody];
  }

  // Build else-branch (LHS value) with coercion if needed
  let elseInstrs: Instr[] = [{ op: "local.get", index: tmp }];
  if (!valTypesMatch(leftType, resultType)) {
    const coerceBody: Instr[] = [];
    fctx.body = coerceBody;
    coerceType(ctx, fctx, leftType, resultType);
    fctx.body = savedBody;
    elseInstrs = [...elseInstrs, ...coerceBody];
  }

  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: resultType },
    then: thenInstrs,
    else: elseInstrs,
  });
  releaseTempLocal(fctx, tmp);

  return resultType;
}

export function compileLogicalOr(ctx: CodegenContext, fctx: FunctionContext, expr: ts.BinaryExpression): ValType {
  // JS semantics: a || b → if a is truthy, return a; else return b
  const leftType = compileExpression(ctx, fctx, expr.left);
  if (!leftType) {
    ensureI32Condition(fctx, leftType, ctx);
    return { kind: "i32" };
  }

  // Save LHS value for JS value semantics, then check truthiness
  const tmp = allocTempLocal(fctx, leftType);
  fctx.body.push({ op: "local.tee", index: tmp });
  ensureI32Condition(fctx, leftType, ctx);

  // Compile RHS in a side buffer to discover its natural type
  const savedBody = pushBody(fctx);
  const rightType = compileExpression(ctx, fctx, expr.right);
  let elseInstrs = fctx.body;
  fctx.body = savedBody;

  // If the RHS is void, push a default value so the if-block has a consistent result.
  if (!rightType) {
    const resultType = leftType;
    elseInstrs.push(...defaultValueInstrs(resultType));
    const thenInstrs: Instr[] = [{ op: "local.get", index: tmp }];
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: resultType },
      then: thenInstrs,
      else: elseInstrs,
    });
    releaseTempLocal(fctx, tmp);
    return resultType;
  }

  const rType: ValType = rightType;

  // Determine common result type (like conditional expression)
  let resultType: ValType = leftType;
  if (!valTypesMatch(leftType, rType)) {
    if ((leftType.kind === "i32" || leftType.kind === "f64") && (rType.kind === "i32" || rType.kind === "f64")) {
      resultType = { kind: "f64" };
    } else {
      resultType = { kind: "externref" };
    }
  }

  // Build then-branch (LHS value) with coercion if needed
  let thenInstrs: Instr[] = [{ op: "local.get", index: tmp }];
  if (!valTypesMatch(leftType, resultType)) {
    const coerceBody: Instr[] = [];
    fctx.body = coerceBody;
    coerceType(ctx, fctx, leftType, resultType);
    fctx.body = savedBody;
    thenInstrs = [...thenInstrs, ...coerceBody];
  }

  // Coerce else-branch (RHS) to common type if needed
  if (!valTypesMatch(rType, resultType)) {
    const coerceBody: Instr[] = [];
    fctx.body = coerceBody;
    coerceType(ctx, fctx, rType, resultType);
    fctx.body = savedBody;
    elseInstrs = [...elseInstrs, ...coerceBody];
  }

  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: resultType },
    then: thenInstrs,
    else: elseInstrs,
  });
  releaseTempLocal(fctx, tmp);

  return resultType;
}

/** Nullish coalescing: a ?? b → if a is null, return b, else return a */
/**
 * #2004 — `String.prototype.codePointAt(pos)` returns `undefined` when `pos`
 * is out of range (§22.1.3.4 step 5). js2wasm lowers codePointAt to an f64
 * result, so that `undefined` is erased to NaN at the externref→f64 boundary.
 * A code point is always an integer in [0, 0x10FFFF], so NaN is an unambiguous
 * "was undefined" sentinel. For `codePointAt(...) ?? rhs`, recognise the LHS
 * and branch on NaN instead of short-circuiting (an f64 LHS would otherwise be
 * treated as never-nullish, so `?? rhs` never fires for the OOB case).
 */
function isCodePointAtCall(expr: ts.Expression): boolean {
  let inner: ts.Expression = expr;
  while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) || ts.isNonNullExpression(inner)) {
    inner = inner.expression;
  }
  return (
    ts.isCallExpression(inner) &&
    ts.isPropertyAccessExpression(inner.expression) &&
    inner.expression.name.text === "codePointAt"
  );
}

export function compileNullishCoalescing(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
): ValType {
  // Compile LHS and store in temp
  const leftType = compileExpression(ctx, fctx, expr.left);
  if (!leftType) {
    reportError(ctx, expr, "Failed to compile nullish coalescing LHS");
    return { kind: "externref" };
  }
  const resultKind: ValType = leftType ?? { kind: "externref" };
  const tmp = allocTempLocal(fctx, resultKind);
  fctx.body.push({ op: "local.tee", index: tmp });

  // #2004 — codePointAt's f64 NaN result encodes an out-of-range `undefined`.
  // Branch on NaN so `codePointAt(oob) ?? rhs` yields `rhs`, then unify the
  // result type with the RHS exactly like the generic path below.
  if (resultKind.kind === "f64" && isCodePointAtCall(expr.left)) {
    // isNaN(lhs): a value is NaN iff it is not equal to itself.
    fctx.body.push({ op: "local.get", index: tmp });
    fctx.body.push({ op: "f64.ne" });
    return finishNullishBranch(ctx, fctx, expr, resultKind, tmp);
  }

  // If the left side is a value type (i32/f64), it can never be null/undefined — short-circuit
  if (resultKind.kind === "i32" || resultKind.kind === "f64") {
    releaseTempLocal(fctx, tmp);
    return resultKind;
  }

  // Check if null or undefined (JS `??` triggers for both null and undefined)
  // ref.is_null checks for wasm null; __extern_is_undefined checks for JS undefined
  fctx.body.push({ op: "ref.is_null" });
  const isUndefIdx = ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
  flushLateImportShifts(ctx, fctx);
  if (isUndefIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: tmp });
    if (resultKind.kind !== "externref") {
      fctx.body.push({ op: "extern.convert_any" });
    }
    fctx.body.push({ op: "call", funcIdx: isUndefIdx });
    fctx.body.push({ op: "i32.or" });
  }

  return finishNullishBranch(ctx, fctx, expr, resultKind, tmp);
}

/**
 * Shared tail of `compileNullishCoalescing`: with the "is-nullish" condition
 * (i32, non-zero ⇒ use RHS) already on the stack and the LHS value saved in
 * `tmp`, compile the RHS, unify the two branch types, and emit the `if`.
 */
function finishNullishBranch(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  resultKind: ValType,
  tmp: number,
): ValType {
  // Compile RHS in a side buffer to discover its natural type
  const savedBody = pushBody(fctx);
  const rhsType = compileExpression(ctx, fctx, expr.right);
  let thenInstrs = fctx.body;
  fctx.body = savedBody;

  // If the RHS is void, push a default value so the if-block has a consistent result.
  if (!rhsType) {
    thenInstrs.push(...defaultValueInstrs(resultKind));
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: resultKind },
      then: thenInstrs,
      else: [{ op: "local.get", index: tmp }],
    });
    releaseTempLocal(fctx, tmp);
    return resultKind;
  }

  const rType = rhsType;

  // Unify types: if LHS and RHS have different wasm types, pick a common type
  if (valTypesMatch(resultKind, rType)) {
    // Types match — use as-is
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: resultKind },
      then: thenInstrs,
      else: [{ op: "local.get", index: tmp }],
    });
    releaseTempLocal(fctx, tmp);
    return resultKind;
  }

  // Types differ — use externref as the unified type when both sides are
  // different types (e.g., struct ref vs f64). This ensures both branches
  // can produce a compatible wasm type. If the RHS is already externref
  // or a ref type, use externref; if both are numeric but different, prefer f64.
  let unifiedType: ValType;
  if (
    rType.kind === "f64" &&
    (resultKind.kind === "externref" || resultKind.kind === "ref" || resultKind.kind === "ref_null")
  ) {
    unifiedType = { kind: "externref" };
  } else {
    unifiedType = rType;
  }

  // Coerce RHS (then branch) to unified type if needed (usually already matches)
  if (!valTypesMatch(rType, unifiedType)) {
    const coerceRhsBody: Instr[] = [];
    fctx.body = coerceRhsBody;
    coerceType(ctx, fctx, rType, unifiedType);
    fctx.body = savedBody;
    thenInstrs = [...thenInstrs, ...coerceRhsBody];
  }

  // Coerce LHS (else branch) to unified type
  const elseInstrs: Instr[] = [{ op: "local.get", index: tmp }];
  const coerceLhsBody: Instr[] = [];
  fctx.body = coerceLhsBody;
  coerceType(ctx, fctx, resultKind, unifiedType);
  fctx.body = savedBody;
  elseInstrs.push(...coerceLhsBody);

  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: unifiedType },
    then: thenInstrs,
    else: elseInstrs,
  });
  releaseTempLocal(fctx, tmp);

  return unifiedType;
}

/**
 * Emit code to sync a parameter local's value into the mapped arguments array (#849).
 * Called after local.tee for parameter assignments in functions with mapped arguments.
 * The expression result is on the stack; we save it, do the sync, then restore it.
 */
function emitMappedArgParamSync(
  ctx: CodegenContext,
  fctx: FunctionContext,
  paramIdx: number,
  resultType: ValType,
): void {
  const info = fctx.mappedArgsInfo;
  if (!info) return;
  // Check if this local index corresponds to a mapped parameter
  const argIndex = paramIdx - info.paramOffset;
  if (argIndex < 0 || argIndex >= info.paramCount) return;
  // #1511: the param↔arguments link for this slot may have been severed
  // (defineProperty writable:false / accessor, or delete arguments[i]) per
  // §10.4.4.2 — once severed, a parameter write must NOT propagate to
  // arguments[i].
  if (info.unmappedIndices?.has(argIndex)) return;
  const runtimeLive = runtimeMappedEntryIsLive(ctx, fctx, info, argIndex);

  // Save the expression result (currently on stack from local.tee)
  const tmp = allocLocal(fctx, `__arg_sync_${fctx.locals.length}`, resultType);
  fctx.body.push({ op: "local.set", index: tmp });

  // Build coercion instructions for param → externref
  const paramType = info.paramTypes[argIndex]!;
  const coerceInstrs: Instr[] = [];
  if (paramType.kind === "f64") {
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx !== undefined) {
      coerceInstrs.push({ op: "call", funcIdx: boxIdx });
    }
  } else if (paramType.kind === "i32") {
    coerceInstrs.push({ op: "f64.convert_i32_s" });
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx !== undefined) {
      coerceInstrs.push({ op: "call", funcIdx: boxIdx });
    }
  } else if (paramType.kind === "ref" || paramType.kind === "ref_null") {
    coerceInstrs.push({ op: "extern.convert_any" });
  }
  // externref: no coercion needed

  // Sync param value to arguments backing array (null-guarded).
  const syncBody: Instr[] = [
    { op: "local.get", index: info.argsLocalIdx },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [],
      else: [
        { op: "local.get", index: info.argsLocalIdx },
        { op: "struct.get", typeIdx: info.vecTypeIdx, fieldIdx: 1 },
        { op: "i32.const", value: argIndex },
        { op: "local.get", index: paramIdx },
        ...coerceInstrs,
        { op: "array.set", typeIdx: info.arrTypeIdx },
      ],
    },
  ];
  if (runtimeLive === null) fctx.body.push(...syncBody);
  else {
    fctx.body.push(...runtimeLive, { op: "if", blockType: { kind: "empty" }, then: syncBody, else: [] });
  }

  // Restore expression result
  fctx.body.push({ op: "local.get", index: tmp });
}

/**
 * Emit code to sync an arguments element write back to the parameter local (#849).
 * Called after array.set in compileElementAssignment when target is the arguments object.
 */
function emitMappedArgReverseSync(
  ctx: CodegenContext,
  fctx: FunctionContext,
  idxLocal: number,
  valLocal: number,
): void {
  const info = fctx.mappedArgsInfo;
  if (!info) return;

  // For each mapped parameter, check if the index matches and sync
  for (let i = 0; i < info.paramCount; i++) {
    // #1511: skip slots whose param↔arguments link has been severed
    // (§10.4.4.2) — an arguments[i] write must not flow back into the param.
    if (info.unmappedIndices?.has(i)) continue;
    const paramType = info.paramTypes[i]!;
    const localIdx = i + info.paramOffset;
    const runtimeLive = runtimeMappedEntryIsLive(ctx, fctx, info, i);

    // Build instructions to convert externref value to param type
    const convertInstrs: Instr[] = [];
    convertInstrs.push({ op: "local.get", index: valLocal });
    if (paramType.kind === "f64") {
      const unboxIdx = ctx.funcMap.get("__unbox_number");
      if (unboxIdx !== undefined) {
        convertInstrs.push({ op: "call", funcIdx: unboxIdx });
      }
    } else if (paramType.kind === "i32") {
      const unboxIdx = ctx.funcMap.get("__unbox_number");
      if (unboxIdx !== undefined) {
        convertInstrs.push({ op: "call", funcIdx: unboxIdx });
      }
      convertInstrs.push({ op: "i32.trunc_sat_f64_s" });
    } else if (paramType.kind === "ref" || paramType.kind === "ref_null") {
      convertInstrs.push({ op: "any.convert_extern" });
      if (paramType.kind === "ref") {
        convertInstrs.push({ op: "ref.cast", typeIdx: (paramType as any).typeIdx });
      }
    }
    // externref → externref: just local.get valLocal (already in convertInstrs)

    const writeParam: Instr[] = [...convertInstrs, { op: "local.set", index: localIdx }];
    const mappedWrite: Instr[] =
      runtimeLive === null
        ? writeParam
        : [...runtimeLive, { op: "if", blockType: { kind: "empty" }, then: writeParam, else: [] }];
    fctx.body.push({ op: "local.get", index: idxLocal });
    fctx.body.push({ op: "i32.const", value: i });
    fctx.body.push({ op: "i32.eq" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: mappedWrite,
      else: [],
    });
  }
}

export { emitMappedArgParamSync, emitMappedArgReverseSync };
