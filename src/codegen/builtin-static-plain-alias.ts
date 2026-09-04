// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4491 wave-5 T6) Plain single-name aliases of a VARIADIC builtin static —
 * `var f = String.fromCharCode`, `var m = Math.max`.
 *
 * `resolveBuiltinStaticBindingAlias` (builtin-static-globals.ts) recognises only
 * the DESTRUCTURING spelling `const { ownKeys } = Reflect`, which is the shape
 * Deno's primordials bootstrap uses. Every Sputnik-era genericity test writes
 * the plain form instead, so the call site fell back to the TypeScript lib
 * signature — and for a rest-parameter static that signature's single slot is a
 * `number[]` vec, against which the generic slot-by-slot loop compiles call-site
 * argument 0. The emitted WAT for `f(97)` was literally
 * `f64.const 97` / `drop` / `ref.null` — evaluated, discarded, replaced by a
 * null vec.
 *
 * SCOPE IS DELIBERATELY NARROW. Only the variadic-convention statics
 * ({@link VARIADIC_VALUE_STATICS}) resolve here. A fixed-arity static's lib
 * signature does not destroy its arguments, so routing plain aliases of those
 * through the closure signature would be a behaviour change with no defect
 * behind it — and would move every such call off today's foreign-callable
 * fallback. Widening this set is a separate, separately-measured change.
 *
 * Soundness gates: the namespace identifier must be the AMBIENT global (no user
 * declaration shadowing it), and neither the alias binding nor the namespace may
 * be written to anywhere in the file — otherwise the value at the call site is
 * not determined by the initializer.
 */

import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { BUILTIN_STATIC_METHOD_ARITY } from "./builtin-fn-meta.js";
import { identifierIsWrittenTo } from "./native-ordinary-instanceof.js";
import { isVariadicValueStatic } from "./string-fromcharcode-value-read.js";

function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) {
    e = e.expression;
  }
  return e;
}

/**
 * True when `ident` denotes an ambient global (its symbol has no declaration in
 * a non-declaration source file). A `var String = …` / `function Math(){}` in
 * user code therefore declines.
 */
function isAmbientGlobalIdentifier(ctx: CodegenContext, ident: ts.Identifier): boolean {
  const decls = ctx.oracle.declarationsOf(ident);
  if (decls.length === 0) return true;
  return decls.every((d) => d.getSourceFile().isDeclarationFile);
}

/**
 * (#5196 R3 review F4) The one FIXED-arity static that also resolves here.
 *
 * `Proxy.revocable` reifies as a two-`externref` closure, but its TypeScript lib
 * signature types the handler as `ProxyHandler<T>` — a named object type that
 * `resolveWasmType` maps to a registered STRUCT. Without an alias the generic
 * slot-by-slot call path therefore compiled an inline handler literal as that
 * closed struct, and the trap read off it was not a callable: measured
 * 2026-09-04, standalone, `var R = Proxy.revocable; R({a:1}, {get(t,k){return 7}})`
 * then `pr.proxy.a` TRAPPED with `illegal cast` (a handler bound to a `var`
 * first was fine). A trap is not an acceptable answer anywhere; routing the
 * call through the closure ABI makes the value spelling construct a real proxy
 * and print node's `7`.
 *
 * Kept as a named exception rather than "every fixed-arity static" for the
 * reason in the file header: widening the whole set is a separate change with
 * its own measurement.
 */
const FIXED_ARITY_PLAIN_ALIAS_STATICS: ReadonlySet<string> = new Set(["Proxy.revocable"]);

function isFixedArityPlainAliasStatic(builtinName: string, propName: string): boolean {
  return FIXED_ARITY_PLAIN_ALIAS_STATICS.has(`${builtinName}.${propName}`);
}

/**
 * Resolve `var f = <Namespace>.<staticMethod>` for the variadic-convention
 * statics plus {@link FIXED_ARITY_PLAIN_ALIAS_STATICS}. Returns undefined for
 * every other shape.
 */
export function resolveVariadicBuiltinStaticPlainAlias(
  ctx: CodegenContext,
  expr: ts.Expression,
): { builtinName: string; propName: string } | undefined {
  const unwrapped = unwrap(expr);
  if (!ts.isIdentifier(unwrapped)) return undefined;
  const declaration = ctx.oracle.variableDeclarationOf(unwrapped);
  if (declaration === undefined) return undefined;
  if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) return undefined;

  const init = unwrap(declaration.initializer);
  if (!ts.isPropertyAccessExpression(init) || !ts.isIdentifier(init.expression)) return undefined;
  const builtinName = init.expression.text;
  const propName = init.name.text;
  if (!isVariadicValueStatic(builtinName, propName) && !isFixedArityPlainAliasStatic(builtinName, propName)) {
    return undefined;
  }
  if (BUILTIN_STATIC_METHOD_ARITY[builtinName]?.[propName] === undefined) return undefined;
  if (!isAmbientGlobalIdentifier(ctx, init.expression)) return undefined;

  const file = declaration.getSourceFile();
  if (identifierIsWrittenTo(file, declaration.name.text)) return undefined;
  if (identifierIsWrittenTo(file, builtinName)) return undefined;
  return { builtinName, propName };
}
