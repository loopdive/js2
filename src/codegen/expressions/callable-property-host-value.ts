// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Declaration-proof that a closed object's callable property holds a HOST
 * function value rather than a compiled Wasm closure.
 *
 * Why this proof has to exist at all: the field's runtime carrier is
 * `externref` either way, and `compileCallablePropertyCall` reads a callable
 * `externref` field by `any.convert_extern` + a guarded cast to the closure
 * wrapper root. For a genuine host function that `ref.test` fails, so the cast
 * yields `ref.null` — and `emitNullCheckThrow` deliberately rethrows ONLY when
 * the value was nullish BEFORE the cast (#789: a wrong struct type is meant to
 * fall through to a multi-struct dispatch). A live host function is not
 * nullish, so the null cast reaches `struct.get` and the module TRAPS with
 * "dereferencing a null pointer". A wasm trap is not catchable by wasm
 * exception handling, so it takes the whole calling program with it.
 *
 * A proven host value is therefore routed to the ordinary host method bridge
 * (`emitWrapperDynamicMethodCall`) instead, which also materializes Wasm array
 * arguments for native observers such as `Array.isArray`.
 *
 * (#5342) The proof used to admit exactly ONE shape — a shorthand whose value
 * is a binding element of `const { isArray } = Array`. Published packages
 * mostly do not look like that. lodash ships
 * `var isArray = Array.isArray; module.exports = isArray`, the consumer writes
 * `import isArray from 'lodash/isArray.js'` and `const _ = { …, isArray, … }`,
 * and `valueDeclarationOf` stops at the import clause — so `_.isArray([1,2,3])`
 * trapped and killed lodash's whole test file. The walk below follows import
 * aliases and single-initializer hops, accepts a plain `PropertyAssignment`
 * initializer, and accepts an ambient (`.d.ts`) binding, which additionally
 * covers `{ f: parseInt }`, `{ f: isNaN }`, `{ f: Math.max }` and
 * `{ f: Object.keys }` — every one of which trapped identically.
 *
 * Deliberately NOT a runtime test. "Is this externref a wasm closure?" is a
 * runtime question and #4618 answers it that way for the `__call_fn_N`
 * dispatchers, but doing so here means wrapping the entire callable-property
 * dispatch — the inline funcref ladder AND the shared
 * `__call_cprop_deferred_N` helper, whose ABI passes only the already-cast
 * root and so cannot see the raw externref — in a runtime branch on the
 * hottest object-literal call path. A declaration proof is byte-identical for
 * every shape it does not claim. A host function that arrives dynamically
 * (through a parameter, or a later write) is the residual, recorded in #5342.
 */
import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";
import { BUILTIN_CLASS_NAMES } from "./builtin-class-names.js";

/** Alias/initializer hops walked before the proof gives up. */
const HOST_VALUE_ALIAS_DEPTH = 8;

function stripParens(expr: ts.Expression): ts.Expression {
  let node = expr;
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

/** A name whose every declaration is ambient (`lib.d.ts`) is a host binding. */
function bindingIsAmbient(ctx: CodegenContext, id: ts.Identifier): boolean {
  const decls = ctx.oracle.declarationsOf(id);
  return decls.length > 0 && decls.every((decl) => decl.getSourceFile().isDeclarationFile);
}

/**
 * True when `expr` provably evaluates to a host function value — a member of a
 * builtin class (`Array.isArray`, `Math.max`) or an ambient global binding
 * (`parseInt`) — rather than to a compiled Wasm closure.
 */
function resolvesToHostFunctionValue(ctx: CodegenContext, expr: ts.Expression, depth = 0): boolean {
  if (depth > HOST_VALUE_ALIAS_DEPTH) return false;
  const node = stripParens(expr);

  if (ts.isPropertyAccessExpression(node)) {
    let root = stripParens(node.expression);
    while (ts.isPropertyAccessExpression(root)) root = stripParens(root.expression);
    if (ts.isIdentifier(root) && (BUILTIN_CLASS_NAMES.has(root.text) || ctx.declaredGlobals.has(root.text)))
      return true;
    return !ts.isPrivateIdentifier(node.name) && bindingIsAmbient(ctx, node.name);
  }
  if (!ts.isIdentifier(node)) return false;
  // A shorthand's own name resolves to the object-literal property, so only a
  // non-shorthand position can answer "ambient" here.
  const shorthand =
    node.parent !== undefined && ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node;
  if (!shorthand && bindingIsAmbient(ctx, node)) return true;

  const valueDecl = ctx.oracle.aliasedValueDeclarationOf(node) ?? ctx.oracle.valueDeclarationOf(node);
  if (!valueDecl) return false;

  // `const { isArray } = Array;`
  if (ts.isBindingElement(valueDecl) && ts.isObjectBindingPattern(valueDecl.parent)) {
    const variableDecl = valueDecl.parent.parent;
    if (!ts.isVariableDeclaration(variableDecl) || !variableDecl.initializer) return false;
    const source = stripParens(variableDecl.initializer);
    return ts.isIdentifier(source) && (BUILTIN_CLASS_NAMES.has(source.text) || ctx.declaredGlobals.has(source.text));
  }
  // `var isArray = Array.isArray;` — including the alias target of an import.
  if (ts.isVariableDeclaration(valueDecl) && valueDecl.initializer !== undefined) {
    return resolvesToHostFunctionValue(ctx, valueDecl.initializer, depth + 1);
  }
  return valueDecl.getSourceFile().isDeclarationFile && !ts.isVariableDeclaration(valueDecl);
}

/**
 * True when the callable property named by `propAccess` is declaration-proven
 * to hold a host builtin, so the caller must route the call through the host
 * method bridge instead of the typed closure-wrapper path.
 */
export function callablePropertyIsExtractedHostBuiltin(
  ctx: CodegenContext,
  propAccess: ts.PropertyAccessExpression,
): boolean {
  for (const decl of ctx.oracle.declarationsOf(propAccess.name)) {
    if (ts.isShorthandPropertyAssignment(decl)) {
      if (resolvesToHostFunctionValue(ctx, decl.name)) return true;
    } else if (ts.isPropertyAssignment(decl) && !ts.isPrivateIdentifier(decl.name)) {
      if (resolvesToHostFunctionValue(ctx, decl.initializer)) return true;
    }
  }
  return false;
}
