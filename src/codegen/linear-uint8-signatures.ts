// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1886 Slice C helpers shared by declaration, body, and call lowering.
 *
 * The analysis result is symbol-keyed. These helpers keep every consumer using
 * the same lookup and the same source-param-index -> wasm-param-index mapping:
 * a linear-backed `Uint8Array` parameter expands from one source parameter into
 * two wasm i32 parameters, `(ptr, len)`.
 */
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";

type FnDecl = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;

function fnSymbolOf(checker: ts.TypeChecker, node: FnDecl): ts.Symbol | undefined {
  if (ts.isFunctionDeclaration(node) && node.name) return checker.getSymbolAtLocation(node.name);
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return checker.getSymbolAtLocation(node.name);
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return checker.getSymbolAtLocation(parent.name);
  }
  if (ts.isFunctionExpression(node) && node.name) return checker.getSymbolAtLocation(node.name);
  return undefined;
}

function nonEmpty(set: Set<number> | undefined): Set<number> | undefined {
  return set && set.size > 0 ? set : undefined;
}

export function isLinearU8SafeBinding(ctx: CodegenContext, node: ts.Node): boolean {
  if (!ctx.linearUint8 || !ts.isIdentifier(node)) return false;
  const sym = ctx.checker.getSymbolAtLocation(node);
  return !!sym && ctx.linearUint8.safeBindings.has(sym);
}

export function isLinearU8RepresentableNew(ctx: CodegenContext, newExpr: ts.NewExpression): boolean {
  const args = newExpr.arguments;
  if (!args || args.length === 0) return true; // `new Uint8Array()` => length 0
  if (args.length > 1) return false; // view start/length overloads are not a byte count
  const arg = args[0]!;
  if (ts.isArrayLiteralExpression(arg)) return true;
  const t = ctx.checker.getTypeAtLocation(arg);
  return (t.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.Any)) !== 0;
}

export function getLinearU8ParamIndicesForDeclaration(ctx: CodegenContext, decl: FnDecl): Set<number> | undefined {
  if (!ctx.linearUint8) return undefined;
  const sym = fnSymbolOf(ctx.checker, decl);
  return sym ? nonEmpty(ctx.linearUint8.linearParams.get(sym)) : undefined;
}

export function getLinearU8ParamIndicesForCall(ctx: CodegenContext, call: ts.CallExpression): Set<number> | undefined {
  if (!ctx.linearUint8 || !ts.isIdentifier(call.expression)) return undefined;
  const sym = ctx.checker.getSymbolAtLocation(call.expression);
  return sym ? nonEmpty(ctx.linearUint8.linearParams.get(sym)) : undefined;
}

export function functionHasLinearU8Params(ctx: CodegenContext, name: string): boolean {
  if (!ctx.linearUint8) return false;
  for (const [sym, params] of ctx.linearUint8.linearParams) {
    if (sym.name === name && params.size > 0) return true;
  }
  return false;
}

export function expandLinearU8ParamTypes(ctx: CodegenContext, decl: FnDecl, sourceParamTypes: ValType[]): ValType[] {
  const linearParams = getLinearU8ParamIndicesForDeclaration(ctx, decl);
  if (!linearParams) return sourceParamTypes;
  const out: ValType[] = [];
  for (let i = 0; i < sourceParamTypes.length; i++) {
    if (linearParams.has(i)) {
      out.push({ kind: "i32" }, { kind: "i32" });
    } else {
      out.push(sourceParamTypes[i] ?? { kind: "f64" });
    }
  }
  return out;
}

export function wasmParamIndexForSourceParam(
  sourceIndex: number,
  linearParams: Set<number> | undefined,
  leadingParams = 0,
): number {
  if (!linearParams || linearParams.size === 0) return leadingParams + sourceIndex;
  let wasmIndex = leadingParams + sourceIndex;
  for (const idx of linearParams) {
    if (idx < sourceIndex) wasmIndex++;
  }
  return wasmIndex;
}

export function sourceParamCountFromExpanded(
  wasmParamCount: number,
  linearParams: Set<number> | undefined,
  leadingParams = 0,
): number {
  return wasmParamCount - leadingParams - (linearParams?.size ?? 0);
}

/**
 * #2045: look up a linear-backed buffer by the binding's `ts.Symbol`, resolved
 * from the identifier `node`. Symbol identity is scope-correct, so a param
 * `buf` and an inner-block `const buf` (distinct symbols, same text) no longer
 * collide — the previous name-keyed map addressed whichever was registered last
 * in both shadowing directions (silent corruption).
 */
export function getLinearU8Buffer(
  ctx: CodegenContext,
  fctx: FunctionContext,
  node: ts.Node,
): { ptrLocalIdx: number; lenLocalIdx: number } | undefined {
  if (!fctx.linearU8Buffers || !ts.isIdentifier(node)) return undefined;
  const sym = ctx.checker.getSymbolAtLocation(node);
  if (!sym) return undefined;
  return fctx.linearU8Buffers.get(sym);
}

export function registerLinearU8Buffer(
  fctx: FunctionContext,
  sym: ts.Symbol,
  ptrLocalIdx: number,
  lenLocalIdx: number,
): void {
  if (!fctx.linearU8Buffers) fctx.linearU8Buffers = new Map();
  fctx.linearU8Buffers.set(sym, { ptrLocalIdx, lenLocalIdx });
}
