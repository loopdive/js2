// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Standalone Annex B RegExp constructor statics.
 *
 * The legacy accessors are installed on `%RegExp%`, not on a user subclass.
 * Their getter/setter algorithms nevertheless receive the constructor as
 * `this` and throw when it is not the intrinsic `%RegExp%`.  A compiled class
 * subclass has a native class-object carrier, but standalone's generic
 * `__extern_get` path does not model that inherited accessor identity.  Keep
 * this bridge deliberately narrow: only a proven RegExp subclass receiver
 * and a proven legacy property are handled here; all other class statics keep
 * their existing ordinary static-member lowering.
 */
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { staticIntegerRange } from "../ir/analysis/static-numeric-range.js";
import { compileExpression, resolveComputedKeyExpression, skipTransparentExpressions } from "./shared.js";
import { withSpeculativeCompile } from "./context/speculative.js";
import { localGlobalIdx } from "./registry/imports.js";

/** Annex B B.2.2 legacy RegExp accessor names, including their aliases. */
export const STANDALONE_REGEXP_LEGACY_STATIC_NAMES: ReadonlySet<string> = new Set([
  "input",
  "lastMatch",
  "lastParen",
  "leftContext",
  "rightContext",
  "$_",
  "$&",
  "$+",
  "$`",
  "$'",
  "$1",
  "$2",
  "$3",
  "$4",
  "$5",
  "$6",
  "$7",
  "$8",
  "$9",
]);

const REGEXP_SUBCLASS_STATIC_ERROR = "RegExp legacy static accessor requires the RegExp constructor as this";

/**
 * Try the standalone-only subclass receiver rule for one class static read.
 *
 * `keyName` is supplied by the dot/property-access path when the name is
 * already static.  The element-access path supplies both the expression and
 * its statically resolved name; a counted `$` + integer expression is proved
 * from the same oracle range analysis used by numeric lowering.  `undefined`
 * means "not this narrow shape" and leaves the caller's existing path intact.
 */
export function tryCompileStandaloneRegExpLegacyStaticRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  resolvedClass: string | ts.PropertyAccessExpression | ts.ElementAccessExpression,
  keyExpression?: ts.Expression,
  keyName?: string,
): ValType | undefined {
  if (typeof resolvedClass !== "string") {
    const expression = resolvedClass;
    if (ts.isPropertyAccessExpression(expression)) {
      const receiver = skipTransparentExpressions(expression.expression);
      if (!ts.isIdentifier(receiver)) return undefined;
      const receiverClass = resolveRegExpClassReceiver(ctx, receiver);
      if (receiverClass === undefined) return undefined;
      resolvedClass = receiverClass;
      keyExpression = undefined;
      keyName = expression.name.text;
    } else {
      if (!ts.isIdentifier(expression.expression)) return undefined;
      const receiverClass = resolveRegExpClassReceiver(ctx, expression.expression);
      if (receiverClass === undefined) return undefined;
      resolvedClass = receiverClass;
      keyExpression = expression.argumentExpression;
      keyName = resolveComputedKeyExpression(ctx, keyExpression);
    }
  }
  if (!ctx.standalone || !isRegExpSubclass(ctx, resolvedClass)) return undefined;

  const provenName = keyName ?? (keyExpression && resolveComputedKeyExpression(ctx, keyExpression));
  if (provenName !== undefined) {
    if (!STANDALONE_REGEXP_LEGACY_STATIC_NAMES.has(provenName)) return undefined;
    const staticProperty = emitInheritedStaticPropertyRead(ctx, fctx, resolvedClass, provenName);
    if (staticProperty !== undefined) return staticProperty;
    if (ownsLegacyStatic(ctx, resolvedClass, provenName)) return undefined;
    return emitSubclassTypeError(ctx, fctx);
  }

  if (keyExpression === undefined || !isProvenLegacyDynamicKey(ctx, keyExpression)) return undefined;
  // Preserve evaluation of the dynamic key before the accessor throws.  The
  // exact Test262 shape is a native string local, but use the transactional
  // wrapper so an unsupported key expression cannot strand partial IR.
  const keyEmitted = withSpeculativeCompile(ctx, fctx, () => {
    const keyType = compileExpression(ctx, fctx, keyExpression);
    if (keyType === null) return { commit: false, value: false };
    fctx.body.push({ op: "drop" });
    return { commit: true, value: true };
  });
  if (!keyEmitted) return undefined;
  return emitSubclassTypeError(ctx, fctx);
}

function emitInheritedStaticPropertyRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  className: string,
  propertyName: string,
): ValType | undefined {
  const seen = new Set<string>();
  let current: string | undefined = className;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const fullName = `${current}_${propertyName}`;
    const globalIdx = ctx.staticProps.get(fullName);
    if (globalIdx !== undefined) {
      fctx.body.push({ op: "global.get", index: globalIdx });
      const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
      return globalDef?.type ?? { kind: "externref" };
    }
    current = ctx.classParentMap.get(current);
  }
  return undefined;
}

/**
 * Resolve a statically immutable constructor alias to its compiled class name.
 *
 * `classExprNameMap` covers class-expression bindings, but not `const Alias =
 * RegExpSubclass`.  Following only `const` initializers keeps this bridge from
 * claiming a mutable binding whose constructor may have changed before the
 * read.  An unresolved alias deliberately falls through to the ordinary
 * dynamic path.
 */
function resolveRegExpClassReceiver(
  ctx: CodegenContext,
  receiver: ts.Identifier,
  seen = new Set<ts.Identifier>(),
): string | undefined {
  if (seen.has(receiver)) return undefined;
  seen.add(receiver);

  const mapped = ctx.classExprNameMap.get(receiver.text) ?? receiver.text;
  if (ctx.classSet.has(mapped)) return mapped;

  const initializer = ctx.oracle.constInitializerOf(receiver);
  if (initializer === undefined) return undefined;
  const source = skipTransparentExpressions(initializer);
  if (ts.isIdentifier(source)) return resolveRegExpClassReceiver(ctx, source, seen);
  if (ts.isClassExpression(source)) return ctx.anonClassExprNames.get(source);
  return undefined;
}

function ownsLegacyStatic(ctx: CodegenContext, className: string, propertyName: string): boolean {
  const seen = new Set<string>();
  let current: string | undefined = className;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const fullName = `${current}_${propertyName}`;
    if (ctx.staticProps.has(fullName) || ctx.staticAccessorSet.has(fullName) || ctx.staticMethodSet.has(fullName))
      return true;
    current = ctx.classParentMap.get(current);
  }
  return false;
}

/** Recognize direct and user-class-transitive RegExp subclasses. */
function isRegExpSubclass(ctx: CodegenContext, className: string): boolean {
  const seen = new Set<string>();
  let current: string | undefined = className;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (ctx.classBuiltinParentMap.get(current) === "RegExp") return true;
    current = ctx.classParentMap.get(current);
  }
  return false;
}

function emitSubclassTypeError(ctx: CodegenContext, fctx: FunctionContext): ValType {
  fctx.body.push(...buildThrowJsErrorInstrs(ctx, "TypeError", REGEXP_SUBCLASS_STATIC_ERROR, { flush: fctx }));
  return { kind: "externref" };
}

/** Prove the exact `$1` … `$9` family without claiming arbitrary strings. */
function isProvenLegacyDynamicKey(ctx: CodegenContext, expression: ts.Expression, seen = new Set<ts.Node>()): boolean {
  const resolved = resolveComputedKeyExpression(ctx, expression);
  if (resolved !== undefined) return STANDALONE_REGEXP_LEGACY_STATIC_NAMES.has(resolved);

  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  if (seen.has(current)) return false;
  seen.add(current);

  if (ts.isIdentifier(current)) {
    const initializer = ctx.oracle.variableInitializerOf(current);
    return initializer !== undefined && isProvenLegacyDynamicKey(ctx, initializer, seen);
  }
  if (!ts.isBinaryExpression(current) || current.operatorToken.kind !== ts.SyntaxKind.PlusToken) return false;

  let numericPart: ts.Expression | undefined;
  const left = current.left;
  const right = current.right;
  if (ts.isStringLiteral(left) && left.text === "$") numericPart = right;
  else if (ts.isStringLiteral(right) && right.text === "$") numericPart = left;
  if (numericPart === undefined) return false;

  const range = staticIntegerRange(ctx, numericPart);
  return range !== undefined && range.min >= 1 && range.max <= 9;
}
