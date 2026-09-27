// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { addUnionImports } from "../index.js";
import { compileCollectionElementArg, ensureMapHelpers } from "../map-runtime.js";
import { ensureSetHelpers } from "../set-runtime.js";
import { compileExpression } from "../shared.js";

/** Read size from the non-null receiver already on the optional-chain stack. */
export function compileOptionalNativeCollectionSize(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiverType: ValType,
  receiverTsType: ts.Type,
  property: string,
): ValType | null {
  if (!ctx.nativeStrings || property !== "size") return null;
  const symbol = receiverTsType.getSymbol();
  if (!symbol || !["Map", "ReadonlyMap", "Set", "ReadonlySet"].includes(symbol.name)) return null;
  if (!symbol.declarations?.length || symbol.declarations.some((decl) => !decl.getSourceFile().isDeclarationFile))
    return null;
  addUnionImports(ctx);
  ensureMapHelpers(ctx);
  if (receiverType.kind === "externref") fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "ref.cast", typeIdx: ctx.mapTypeIdx });
  fctx.body.push({ op: "call", funcIdx: ctx.mapHelpers.get("__map_size")! });
  return { kind: "i32" };
}

/** Native collection lookups on the receiver already saved by `?.`. */
export function compileOptionalNativeCollectionLookup(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  className: string | undefined,
  methodName: string,
  receiverLocal: number,
  receiverType: ValType,
): boolean {
  if (!ctx.standalone) return false;
  const map = className === "Map" || className === "ReadonlyMap" || className === "WeakMap";
  const set = className === "Set" || className === "ReadonlySet" || className === "WeakSet";
  if (!map && !set) return false;
  if (methodName !== "has" && methodName !== "delete" && !(map && methodName === "get")) return false;
  const receiver = (expr.expression as ts.PropertyAccessExpression).expression;
  const declarations = ctx.oracle.typeDeclarationsOf(receiver);
  if (!declarations?.length || declarations.some((declaration) => !declaration.getSourceFile().isDeclarationFile))
    return false;
  if (expr.arguments.some(ts.isSpreadElement)) return false;
  addUnionImports(ctx);
  ensureSetHelpers(ctx);
  const helper = ctx.mapHelpers.get(`__map_${methodName}`);
  if (helper === undefined) throw new Error(`Missing native ${className}.${methodName} helper`);
  fctx.body.push({ op: "local.get", index: receiverLocal });
  if (receiverType.kind === "externref") fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "ref.cast", typeIdx: ctx.mapTypeIdx });
  compileCollectionElementArg(ctx, fctx, expr.arguments[0]);
  for (const arg of expr.arguments.slice(1)) {
    if (compileExpression(ctx, fctx, arg) !== null) fctx.body.push({ op: "drop" });
  }
  fctx.body.push({ op: "call", funcIdx: helper });
  // Keep both a missing get result and false distinct from short-circuiting.
  // Map.get already returns the stored value in anyref, without coercing it.
  if (methodName === "get") fctx.body.push({ op: "extern.convert_any" });
  else fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__box_boolean")! });
  return true;
}
