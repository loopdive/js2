// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * A narrow representation proof for structural values read from the realm
 * global object.
 *
 * TypeScript assertions and annotations are erased at runtime. Consequently,
 *
 *   const api = (globalThis as any).api as Api;
 *
 * must retain the value returned by the global object's live [[Get]]. A
 * checker-derived `$Api` WasmGC struct is not runtime evidence: guarded-casting
 * the open-object externref to that unrelated nominal struct turns a valid API
 * object into null. This predicate identifies only that already-raw externref
 * producer, and only when the receiving declaration is a non-callable
 * structural object contract. Scalar coercions and arbitrary `any as T` values
 * deliberately remain on their existing paths.
 */
import { ts } from "../../ts-api.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { receiverIsRealmGlobalObject } from "../helpers/sloppy-this-global.js";

const admittedDeclarationsByContext = new WeakMap<CodegenContext, WeakSet<ts.VariableDeclaration>>();

function unwrapTransparent(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * True when `declaration` receives a structural object through a live property
 * read from the unshadowed realm global object.
 */
export function declarationReadsStructuralObjectFromRealmGlobal(
  ctx: CodegenContext,
  fctx: FunctionContext,
  declaration: ts.VariableDeclaration,
): boolean {
  // The native global-object runtime can continue dynamic structural reads
  // from the raw externref without a JS host. Host/gc needs a separate
  // declaration-keyed dynamic-access route for genuine host objects; changing
  // only its slot would be incomplete, so leave that lane byte-identical.
  if (!ctx.standalone && !ctx.wasi) return false;
  if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) return false;
  // The oracle keeps this proof representation-based without leaking checker
  // objects: classes, arrays, builtins, and callables have distinct fact kinds.
  if (ctx.oracle.typeFactOf(declaration).kind !== "object") return false;

  const source = unwrapTransparent(declaration.initializer);
  if (!ts.isPropertyAccessExpression(source) && !ts.isElementAccessExpression(source)) return false;
  if (!receiverIsRealmGlobalObject(ctx, fctx, source.expression)) return false;

  let admittedDeclarations = admittedDeclarationsByContext.get(ctx);
  if (admittedDeclarations === undefined) {
    admittedDeclarations = new WeakSet();
    admittedDeclarationsByContext.set(ctx, admittedDeclarations);
  }
  admittedDeclarations.add(declaration);
  return true;
}

/**
 * True when `expression` is a property chain rooted in a declaration admitted
 * by {@link declarationReadsStructuralObjectFromRealmGlobal}.
 *
 * Resolve the root by symbol rather than spelling so an unrelated same-named
 * local cannot inherit the dynamic carrier behavior. The declaration-keyed
 * registry also preserves the original planning proof through a nested closure
 * capture. In particular, a nested local named `globalThis` must not invalidate
 * an outer declaration that was initialized from the actual realm global.
 */
export function expressionDescendsFromRealmStructuralBinding(
  ctx: CodegenContext,
  _fctx: FunctionContext,
  expression: ts.Expression,
): boolean {
  let root = unwrapTransparent(expression);
  while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) {
    root = unwrapTransparent(root.expression);
  }
  if (!ts.isIdentifier(root)) return false;

  const admittedDeclarations = admittedDeclarationsByContext.get(ctx);
  if (admittedDeclarations === undefined) return false;
  for (const declaration of ctx.oracle.declarationsOf(root)) {
    if (ts.isVariableDeclaration(declaration) && admittedDeclarations.has(declaration)) {
      return true;
    }
  }
  return false;
}
