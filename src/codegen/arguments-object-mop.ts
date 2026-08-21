// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The `arguments` object's property behaviour, kept out of the `typeof`/`delete`
 * driver (#4555).
 *
 * ES5 §10.6: `arguments` is an ordinary Object whose backing store, here, is an
 * opaque WasmGC vec. Every operation that has to reconcile "ordinary Object"
 * with "opaque vec" belongs together — the unmapped-index delete writeback and
 * the `typeof arguments` answer are two faces of the same reconciliation.
 */
import { ts } from "../ts-api.js";
import type { Instr } from "../ir/types.js";
import { allocLocal, getLocalType } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { emitUndefined } from "./expressions/late-imports.js";
import { getArrTypeIdxFromVec } from "./registry/types.js";
import { coerceType } from "./type-coercion.js";

/**
 * (#4555) Is `ident` the `arguments` binding of a function that HAS an
 * arguments object?
 *
 * The materialized vec lives in a local literally named `arguments` — the same
 * `fctx.localMap` predicate every property-access path already uses. The TS
 * checker reports no `valueDeclaration` for the identifier in a plain JS file,
 * so `typeof`'s unresolvable-Reference arm answered "undefined" for the bare
 * form while `var a = arguments; typeof a` answered "object" off this very
 * local. Callers use this to take the §10.6 answer ("object") first.
 */
export function isArgumentsObjectIdentifier(ctx: CodegenContext, fctx: FunctionContext, ident: ts.Identifier): boolean {
  if (ident.text !== "arguments") return false;
  const localIdx = fctx.localMap.get("arguments");
  if (localIdx === undefined) return false;

  // A later assignment can move the same source binding to a widened carrier.
  // Only the canonical externref vec local proves that this reference still
  // denotes the compiler-materialized arguments object.
  const localType = getLocalType(fctx, localIdx);
  if (
    (localType?.kind !== "ref" && localType?.kind !== "ref_null") ||
    getArrTypeIdxFromVec(ctx, localType.typeIdx) < 0
  ) {
    return false;
  }

  // The localMap is keyed only by spelling, so an explicit parameter, var, or
  // function binding named `arguments` occupies the same slot-name as the
  // implicit object. Resolve the reference back to its source declaration
  // through the oracle before claiming the §10.6 fast path.
  const oracleDeclaration = ctx.oracle.valueDeclarationOf(ident);
  if (oracleDeclaration && !oracleDeclaration.getSourceFile().isDeclarationFile) {
    const declarationList = oracleDeclaration.parent;
    const isUninitializedVarRedeclaration =
      ts.isVariableDeclaration(oracleDeclaration) &&
      oracleDeclaration.initializer === undefined &&
      ts.isVariableDeclarationList(declarationList) &&
      (declarationList.flags & ts.NodeFlags.BlockScoped) === 0;
    if (!isUninitializedVarRedeclaration) return false;
  }

  return true;
}

/**
 * Return the exact primitive `typeof` verdict carried by a local named
 * `arguments`, or `null` when the carrier is reference-shaped or dynamic.
 *
 * FunctionDeclarationInstantiation can bind a hoisted function and a later
 * `var arguments = value` to the same source name. TypeScript keeps the
 * function declaration's flow type at a later read, while codegen has already
 * repointed `localMap` at the initializer's physical carrier. A scalar carrier
 * is the authoritative IR fact in that disagreement. Reference carriers are
 * not: they can be closure or eval-environment wrappers around the source value
 * and must fall through to the normal binding-aware lowering (#4555).
 */
function staticPrimitiveTypeofForArgumentsLocal(
  ctx: CodegenContext,
  fctx: FunctionContext,
  ident: ts.Identifier,
): string | null {
  if (ident.text !== "arguments") return null;
  const hasHoistedFunctionDeclaration = ctx.oracle
    .declarationsOf(ident)
    .some((declaration) => ts.isFunctionDeclaration(declaration) && !declaration.getSourceFile().isDeclarationFile);
  if (!hasHoistedFunctionDeclaration) {
    return null;
  }
  const localIdx = fctx.localMap.get("arguments");
  if (localIdx === undefined) return null;
  const localType = getLocalType(fctx, localIdx);
  if (localType === undefined) return null;

  if (localType.kind === "f32" || localType.kind === "i8" || localType.kind === "i16") return "number";
  if (localType.kind === "f64") return localType.undefSentinel === true ? null : "number";
  if (localType.kind === "i32") {
    if (localType.symbol === true) return "symbol";
    return localType.boolean === true ? "boolean" : null;
  }
  if (localType.kind === "i64") return localType.bigint === true ? "bigint" : null;
  return null;
}

/** Binding-aware `typeof arguments` verdict, or `null` for the dynamic path. */
export function staticTypeofForArgumentsIdentifier(
  ctx: CodegenContext,
  fctx: FunctionContext,
  ident: ts.Identifier,
): string | null {
  if (isArgumentsObjectIdentifier(ctx, fctx, ident)) return "object";
  return staticPrimitiveTypeofForArgumentsLocal(ctx, fctx, ident);
}

/** Emit a constant comparison when the arguments binding has an exact verdict. */
export function emitArgumentsTypeofComparison(
  ctx: CodegenContext,
  fctx: FunctionContext,
  ident: ts.Identifier,
  expected: string,
  isEq: boolean,
): boolean {
  const actual = staticTypeofForArgumentsIdentifier(ctx, fctx, ident);
  if (actual === null) return false;
  const matches = actual === expected;
  fctx.body.push({ op: "i32.const", value: isEq ? (matches ? 1 : 0) : matches ? 0 : 1 });
  return true;
}

/** Locals holding a runtime `arguments[<expr>]` delete key as an array index. */
export interface DynamicArgumentsDeleteIndex {
  /** i32 — the truncated index; only meaningful when `isIndexLocal` is 1. */
  readonly indexLocal: number;
  /** i32 flag — the key round-tripped through a non-negative integer. */
  readonly isIndexLocal: number;
}

/**
 * Is this a `delete arguments[…]` whose every index is UNMAPPED, so clearing
 * the backing vec slot is the whole observable effect?
 *
 * A zero-formal function still gets a `mappedArgsInfo` record (its
 * [[ParameterMap]] is simply empty), and the old `fctx.mappedArgsInfo` bail
 * treated that as "mapped" and skipped the writeback — which is why
 * `function __func(){ delete arguments[i]; }` never cleared anything. Functions
 * that DO have formals keep the old behaviour: their mapped indices are
 * handled by the §10.4.4.5 arm in the delete driver, which severs the
 * param↔arguments map as well as clearing the slot.
 */
function isUnmappedArgumentsElementDelete(
  fctx: FunctionContext,
  inner: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): boolean {
  if ((fctx.mappedArgsInfo?.paramCount ?? 0) > 0) return false;
  return (
    ts.isElementAccessExpression(inner) && ts.isIdentifier(inner.expression) && inner.expression.text === "arguments"
  );
}

/**
 * Materialize a runtime `delete arguments[k]` key as an array index, BEFORE the
 * `__delete_property` import is resolved — a late import registered after that
 * funcIdx is captured would shift it out from under the already-planned call.
 * Returns `undefined` when this delete needs no dynamic index (a literal index,
 * a non-`arguments` receiver, or a function with real formals).
 *
 * The externref→f64 step goes through `coerceType`, the single coercion engine:
 * a key can be a boxed number, a numeric string, or something that is not an
 * index at all, and picking a raw unbox here would hand-roll that decision.
 */
export function prepareDynamicArgumentsDeleteIndex(
  ctx: CodegenContext,
  fctx: FunctionContext,
  inner: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  keyLocal: number,
): DynamicArgumentsDeleteIndex | undefined {
  if (!isUnmappedArgumentsElementDelete(fctx, inner) || !ts.isElementAccessExpression(inner)) return undefined;
  const idxArg = inner.argumentExpression;
  if (ts.isNumericLiteral(idxArg) || ts.isStringLiteral(idxArg)) return undefined;
  if (fctx.localMap.get("arguments") === undefined) return undefined;

  const numLocal = allocLocal(fctx, `__del_args_key_f64_${fctx.locals.length}`, { kind: "f64" });
  const indexLocal = allocLocal(fctx, `__del_args_key_i32_${fctx.locals.length}`, { kind: "i32" });
  const isIndexLocal = allocLocal(fctx, `__del_args_key_ok_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: keyLocal });
  coerceType(ctx, fctx, { kind: "externref" }, { kind: "f64" }, "number");
  fctx.body.push(
    { op: "local.tee", index: numLocal },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.tee", index: indexLocal },
    // `f64(trunc(v)) === v` rejects NaN (a non-numeric key) and any fraction.
    { op: "f64.convert_i32_s" },
    { op: "local.get", index: numLocal },
    { op: "f64.eq" },
    { op: "local.get", index: indexLocal },
    { op: "i32.const", value: 0 },
    { op: "i32.ge_s" },
    { op: "i32.and" },
    { op: "local.set", index: isIndexLocal },
  );
  return { indexLocal, isIndexLocal };
}

/**
 * A strict or non-simple-parameter function has an *unmapped* `arguments`
 * object, so it intentionally has no `mappedArgsInfo`. Its backing value is
 * still the same externref vec used by mapped arguments. The generic
 * `__delete_property` path records the successful deletion (and honors any
 * descriptor-sidecar refusal), but it cannot clear the opaque vec slot; a
 * subsequent compiled `arguments[i]` read therefore still sees the old value.
 *
 * Consume the generic delete result and, on success, clear a statically-known
 * in-bounds vec slot to the canonical `undefined` value. Leave the result on
 * the stack for the caller's normal strict-delete check.
 */
export function emitPropertyDeleteWithUnmappedArgumentsWriteback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  inner: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  delIdx: number,
  dynamicIndex?: DynamicArgumentsDeleteIndex,
): void {
  fctx.body.push({ op: "call", funcIdx: delIdx });
  if (
    !isUnmappedArgumentsElementDelete(fctx, inner) ||
    !ts.isElementAccessExpression(inner) ||
    !ts.isIdentifier(inner.expression)
  ) {
    return;
  }

  const idxArg = inner.argumentExpression;
  const idxText = ts.isNumericLiteral(idxArg) ? idxArg.text : ts.isStringLiteral(idxArg) ? idxArg.text : undefined;
  const argIndex = idxText !== undefined ? Number(idxText) : NaN;
  const hasStaticIndex = Number.isInteger(argIndex) && argIndex >= 0;
  // (#4491) `delete arguments[i]` with a RUNTIME index — `S13_A11_T4` loops
  // `for (var i = 0; i < arguments.length; i++) delete arguments[i]` — has no
  // literal to fold, so the static arm below never fired and the vec slot kept
  // its value while `typeof arguments[i]` was expected to answer "undefined".
  if (!hasStaticIndex && dynamicIndex === undefined) return;

  const argsLocalIdx = fctx.localMap.get("arguments");
  if (argsLocalIdx === undefined) return;
  const argsType =
    argsLocalIdx < fctx.params.length
      ? fctx.params[argsLocalIdx]?.type
      : fctx.locals[argsLocalIdx - fctx.params.length]?.type;
  if (!argsType || (argsType.kind !== "ref" && argsType.kind !== "ref_null")) return;

  const vecTypeIdx = argsType.typeIdx;
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) return;

  const resultLocal = allocLocal(fctx, `__del_args_res_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.set", index: resultLocal });
  emitUndefined(ctx, fctx);
  const undefLocal = allocLocal(fctx, `__del_args_undef_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: undefLocal });

  const pushIndex: Instr = hasStaticIndex
    ? { op: "i32.const", value: argIndex }
    : { op: "local.get", index: dynamicIndex!.indexLocal };
  const clearIfInBounds: Instr[] = [
    { op: "local.get", index: argsLocalIdx },
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
    pushIndex,
    { op: "i32.gt_u" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: argsLocalIdx },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
        pushIndex,
        { op: "local.get", index: undefLocal },
        { op: "array.set", typeIdx: arrTypeIdx },
      ],
      else: [],
    },
  ];
  // A runtime key only names an array index when it round-trips through a
  // non-negative integer; anything else ("foo", 1.5, a Symbol) leaves the vec
  // untouched and keeps the generic delete's own answer.
  const guardedClear: Instr[] = hasStaticIndex
    ? clearIfInBounds
    : [
        { op: "local.get", index: dynamicIndex!.isIndexLocal },
        { op: "if", blockType: { kind: "empty" }, then: clearIfInBounds, else: [] },
      ];

  fctx.body.push({ op: "local.get", index: resultLocal });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then:
      argsType.kind === "ref_null"
        ? [
            { op: "local.get", index: argsLocalIdx },
            { op: "ref.is_null" },
            { op: "if", blockType: { kind: "empty" }, then: [], else: guardedClear },
          ]
        : guardedClear,
    else: [],
  });
  fctx.body.push({ op: "local.get", index: resultLocal });
}
