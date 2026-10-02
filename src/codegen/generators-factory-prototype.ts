// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Initialize generator function values without changing their callable identity. */
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { ensureNativeDelegatedResultHelpers } from "./generators-delegation-runtime.js";
import { NATIVE_GENERATOR_FACTORY_PROTO } from "./generators-native-protocol.js";

/**
 * A native generator factory returns its private WasmGC state struct on a
 * direct, compiler-known call.  A JavaScript function value, however, crosses
 * the ordinary closure ABI and must advertise the checker-visible Generator
 * object carrier (`externref`).  Keeping the state result in a first-class
 * trampoline makes an indirect `var f = generator; f()` miss every
 * checker-derived closure signature, even though the function itself is
 * callable.
 *
 * Do not generalize this to arbitrary reference results: the registry proves
 * that this exact type is a native generator state, and only this boundary has
 * the deliberate direct-call specialization to undo.
 */
export function nativeGeneratorFunctionValueWrapperResults(
  ctx: CodegenContext,
  results: readonly ValType[],
): ValType[] {
  if (!(ctx.standalone || ctx.wasi) || results.length !== 1) return [...results];
  const result = results[0]!;
  if (result.kind !== "ref" && result.kind !== "ref_null") return [...results];
  for (const info of ctx.nativeGenerators.values()) {
    if (info.stateTypeIdx === result.typeIdx) return [{ kind: "externref" }];
  }
  return [...results];
}

/** True when a first-class generator trampoline must export its state result. */
export function nativeGeneratorFunctionValueNeedsResultBridge(
  ctx: CodegenContext,
  directResults: readonly ValType[],
): boolean {
  const wrapperResults = nativeGeneratorFunctionValueWrapperResults(ctx, directResults);
  return (
    directResults.length === 1 &&
    wrapperResults.length === 1 &&
    wrapperResults[0]!.kind === "externref" &&
    (directResults[0]!.kind === "ref" || directResults[0]!.kind === "ref_null")
  );
}

/**
 * (#6651 A8) A top-level `g.prototype = v` on a sync generator DECLARATION,
 * under the native generator lanes (standalone / WASI). The module-init
 * collector keeps `F.prototype = …` only for a user constructor (#2660 S2) and
 * excludes `prototype` from its function-static keep, so this write compiled
 * to NOTHING: `g.prototype` still read the original object and every later
 * `g()` inherited from it (`statements/generators/default-proto.js`). The same
 * write inside a function body already reaches the function's own writable
 * `prototype` (created by the initializer below); keeping the statement is the
 * whole fix.
 */
export function isGeneratorDeclarationPrototypeWrite(ctx: CodegenContext, target: ts.Expression): boolean {
  if (!(ctx.standalone || ctx.wasi) || !ts.isPropertyAccessExpression(target)) return false;
  if (!ts.isIdentifier(target.name) || target.name.text !== "prototype") return false;
  let receiver: ts.Expression = target.expression; // `(g as any).prototype` is the same write
  while (ts.isParenthesizedExpression(receiver) || ts.isAsExpression(receiver) || ts.isNonNullExpression(receiver)) {
    receiver = receiver.expression;
  }
  if (!ts.isIdentifier(receiver)) return false;
  const declaration = ctx.oracle.valueDeclarationOf(receiver);
  return (
    declaration !== undefined &&
    ts.isFunctionDeclaration(declaration) &&
    declaration.asteriskToken !== undefined &&
    !declaration.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
  );
}

export function initializeNativeGeneratorFunctionValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  declaration: ts.Node | undefined,
  type: ValType,
): ValType {
  if (
    !(ctx.standalone || ctx.wasi) ||
    !declaration ||
    // (#6651 A8) A generator METHOD is a generator function too: §15.5.4 /
    // MethodDefinition evaluation gives it the same own `prototype`
    // ({w:true, e:false, c:false}, [[Prototype]] %GeneratorPrototype%).
    !(
      ts.isFunctionDeclaration(declaration) ||
      ts.isFunctionExpression(declaration) ||
      ts.isMethodDeclaration(declaration)
    ) ||
    !declaration.asteriskToken ||
    declaration.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
  )
    return type;
  ensureNativeDelegatedResultHelpers(ctx);
  const value = allocLocal(fctx, "__generator_function_value", type);
  fctx.body.push({ op: "local.set", index: value }, { op: "local.get", index: value });
  if (type.kind !== "externref") fctx.body.push({ op: "extern.convert_any" });
  fctx.body.push(
    { op: "call", funcIdx: ctx.funcMap.get(NATIVE_GENERATOR_FACTORY_PROTO)! },
    { op: "drop" },
    { op: "local.get", index: value },
  );
  return type;
}
