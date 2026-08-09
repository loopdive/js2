// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

const DESCRIPTOR_FIELD_NAMES = new Set(["value", "writable", "enumerable", "configurable", "get", "set"]);

export function unwrapTransparentExpression(expr: ts.Expression): ts.Expression {
  while (
    ts.isAsExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isNonNullExpression(expr) ||
    ts.isParenthesizedExpression(expr) ||
    ts.isSatisfiesExpression(expr)
  ) {
    expr = (
      expr as
        | ts.AsExpression
        | ts.TypeAssertion
        | ts.NonNullExpression
        | ts.ParenthesizedExpression
        | ts.SatisfiesExpression
    ).expression;
  }
  return expr;
}

export function descriptorFieldName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return DESCRIPTOR_FIELD_NAMES.has(name.text) ? name.text : undefined;
  }
  return undefined;
}

/**
 * Try to constant-fold `ToBoolean(<expr>)` at compile time. Returns:
 *   - `true`/`false` if the expression has a statically-known truthiness
 *   - `undefined` if the value cannot be determined at compile time (caller
 *     must evaluate at runtime or fall back to the dynamic path).
 *
 * Per ES spec §6.2.5.6 step 5.b, every descriptor attribute (writable,
 * enumerable, configurable) is run through `ToBoolean` before being stored.
 */
export function tryConstantFoldToBoolean(init: ts.Expression): boolean | undefined {
  while (ts.isParenthesizedExpression(init)) init = init.expression;
  while (ts.isNonNullExpression(init) || ts.isAsExpression(init) || ts.isTypeAssertionExpression(init)) {
    init = init.expression;
  }

  if (init.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (init.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (init.kind === ts.SyntaxKind.NullKeyword) return false;
  if (ts.isIdentifier(init) && init.text === "undefined") return false;
  if (ts.isIdentifier(init) && init.text === "NaN") return false;
  if (ts.isIdentifier(init) && init.text === "Infinity") return true;
  if (ts.isNumericLiteral(init)) {
    const n = Number(init.text);
    return !!n && !Number.isNaN(n);
  }
  if (ts.isBigIntLiteral(init)) {
    const txt = init.text.replace(/n$/, "");
    return BigInt(txt) !== 0n;
  }
  if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
    return init.text.length > 0;
  }
  if (ts.isTemplateExpression(init)) {
    return init.head.text.length > 0 || init.templateSpans.length > 0;
  }
  if (ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init)) return true;
  if (ts.isFunctionExpression(init) || ts.isArrowFunction(init) || ts.isClassExpression(init)) return true;
  if (ts.isPrefixUnaryExpression(init)) {
    const inner = tryConstantFoldToBoolean(init.operand);
    if (init.operator === ts.SyntaxKind.MinusToken || init.operator === ts.SyntaxKind.PlusToken) {
      if (ts.isNumericLiteral(init.operand)) {
        const n = Number(init.operand.text);
        return !!n && !Number.isNaN(n);
      }
    }
    if (init.operator === ts.SyntaxKind.ExclamationToken) {
      return inner !== undefined ? !inner : undefined;
    }
    if (init.operator === ts.SyntaxKind.TildeToken && ts.isNumericLiteral(init.operand)) {
      const n = Number(init.operand.text);
      return ~(n | 0) !== 0;
    }
  }
  if (ts.isVoidExpression(init)) return false;
  return undefined;
}

type DescriptorBooleanField = "writable" | "configurable";
type DescriptorField = DescriptorBooleanField | "value" | "enumerable" | "get" | "set";

/**
 * Identify the intrinsic prototype that supplies inherited descriptor fields
 * for a statically fieldless native descriptor carrier.
 *
 * ES5's ToPropertyDescriptor uses ordinary [[HasProperty]]/[[Get]], so a Date
 * instance after `Date.prototype.writable = true` is a writable descriptor even
 * though the instance has no own `writable` field. Native carriers do not share
 * the compiler's `$NativeProto` object representation in either lane, which
 * makes the generic runtime reader miss that inherited data property. Keep this
 * proof deliberately syntactic and narrow: only carriers whose initializer is
 * known not to own any of the six descriptor fields qualify.
 */
function fieldlessDescriptorCarrierPrototype(
  ctx: CodegenContext,
  descArg: ts.Expression,
  call: ts.CallExpression,
): string | undefined {
  const seen = new Set<ts.Node>();

  const classify = (raw: ts.Expression): string | undefined => {
    const expr = unwrapTransparentExpression(raw);
    if (seen.has(expr)) return undefined;
    seen.add(expr);

    if (ts.isArrayLiteralExpression(expr)) return "Array";
    if (ts.isRegularExpressionLiteral(expr)) return "RegExp";
    if (ts.isFunctionExpression(expr) || ts.isArrowFunction(expr) || ts.isClassExpression(expr)) return "Function";
    if (ts.isObjectLiteralExpression(expr)) {
      const ownsDescriptorField = expr.properties.some((prop) => {
        if (
          !ts.isPropertyAssignment(prop) &&
          !ts.isShorthandPropertyAssignment(prop) &&
          !ts.isMethodDeclaration(prop) &&
          !ts.isGetAccessorDeclaration(prop) &&
          !ts.isSetAccessorDeclaration(prop)
        ) {
          return false;
        }
        return descriptorFieldName(prop.name) !== undefined;
      });
      return ownsDescriptorField ? undefined : "Object";
    }
    if (ts.isNewExpression(expr) && ts.isIdentifier(expr.expression)) {
      const name = expr.expression.text;
      const ctorDeclaration = ctx.oracle.valueDeclarationOf(expr.expression);
      if (ctorDeclaration?.getSourceFile() === call.getSourceFile()) return undefined;
      if (
        name === "Object" ||
        name === "String" ||
        name === "Boolean" ||
        name === "Number" ||
        name === "Date" ||
        name === "RegExp" ||
        name === "Error"
      ) {
        return name;
      }
    }
    // The ES5 descriptor corpus's arguments-object carrier is an immediately
    // invoked function whose body returns `arguments`.
    const callTarget = ts.isCallExpression(expr) ? unwrapTransparentExpression(expr.expression) : undefined;
    if (
      ts.isCallExpression(expr) &&
      callTarget !== undefined &&
      (ts.isFunctionExpression(callTarget) || ts.isArrowFunction(callTarget)) &&
      callTarget.body &&
      ts.isBlock(callTarget.body) &&
      callTarget.body.statements.some(
        (stmt) =>
          ts.isReturnStatement(stmt) &&
          stmt.expression !== undefined &&
          ts.isIdentifier(unwrapTransparentExpression(stmt.expression)) &&
          (unwrapTransparentExpression(stmt.expression) as ts.Identifier).text === "arguments",
      )
    ) {
      return "Object";
    }
    if (!ts.isIdentifier(expr)) return undefined;

    const declaration = ctx.oracle.valueDeclarationOf(expr);
    if (expr.text === "Math" || expr.text === "JSON") {
      return declaration?.getSourceFile() === call.getSourceFile() ? undefined : "Object";
    }
    if (!declaration) return undefined;
    if (ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration)) return "Function";
    if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) return undefined;
    if (declaration.getSourceFile() !== call.getSourceFile()) return undefined;

    // Any use between declaration and defineProperty may mutate or alias the
    // carrier. Decline instead of pretending this is whole-program analysis.
    const declarationEnd = declaration.getEnd();
    const callStart = call.getStart();
    let interveningReference = false;
    const visit = (node: ts.Node): void => {
      if (interveningReference) return;
      const start = node.getStart();
      if (start >= callStart || node.getEnd() <= declarationEnd) return;
      if (ts.isIdentifier(node) && start >= declarationEnd && ctx.oracle.valueDeclarationOf(node) === declaration) {
        interveningReference = true;
        return;
      }
      node.forEachChild(visit);
    };
    call.getSourceFile().forEachChild(visit);
    if (interveningReference) return undefined;
    return classify(declaration.initializer);
  };

  return classify(descArg);
}

type PrototypeFieldState = { kind: "absent" } | { kind: "value"; value: boolean } | { kind: "unknown" };

function lexicalStatementContainer(node: ts.Node): ts.Block | ts.SourceFile | undefined {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isBlock(current) || ts.isSourceFile(current)) return current;
  }
  return undefined;
}

/** Last direct mutation of `<Builtin>.prototype.<field>` before `call`. */
function prototypeDescriptorFieldState(
  call: ts.CallExpression,
  builtinName: string,
  field: DescriptorField,
): PrototypeFieldState {
  let state: PrototypeFieldState = { kind: "absent" };
  let lastStart = -1;
  const callStart = call.getStart();
  const callContainer = lexicalStatementContainer(call);

  const matches = (node: ts.Expression): boolean => {
    const target = unwrapTransparentExpression(node);
    const prototypeAccess = ts.isPropertyAccessExpression(target)
      ? unwrapTransparentExpression(target.expression)
      : undefined;
    return (
      ts.isPropertyAccessExpression(target) &&
      target.name.text === field &&
      prototypeAccess !== undefined &&
      ts.isPropertyAccessExpression(prototypeAccess) &&
      prototypeAccess.name.text === "prototype" &&
      ts.isIdentifier(prototypeAccess.expression) &&
      prototypeAccess.expression.text === builtinName
    );
  };

  const visit = (node: ts.Node): void => {
    const start = node.getStart();
    if (start >= callStart) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      lexicalStatementContainer(node) === callContainer &&
      matches(node.left)
    ) {
      if (start > lastStart) {
        const folded = tryConstantFoldToBoolean(node.right);
        state = folded === undefined ? { kind: "unknown" } : { kind: "value", value: folded };
        lastStart = start;
      }
      return;
    }
    if (ts.isDeleteExpression(node) && lexicalStatementContainer(node) === callContainer && matches(node.expression)) {
      if (start > lastStart) {
        state = { kind: "absent" };
        lastStart = start;
      }
      return;
    }
    node.forEachChild(visit);
  };
  call.getSourceFile().forEachChild(visit);
  return state;
}

/**
 * Fold the inherited TRUE attributes of a proven fieldless native descriptor.
 * A specific intrinsic prototype shadows Object.prototype; an absent/deleted
 * field falls through to Object.prototype exactly like ordinary [[Get]].
 *
 * False/unknown-only descriptors stay on the existing runtime path. That keeps
 * the opposite (#3661) direction byte-for-byte unchanged while this fix repairs
 * the over-restricted TRUE direction.
 */
export function inheritedTrueDescriptorFlags(
  ctx: CodegenContext,
  descArg: ts.Expression,
  call: ts.CallExpression,
): Partial<Record<DescriptorBooleanField, true>> | undefined {
  const carrierPrototype = fieldlessDescriptorCarrierPrototype(ctx, descArg, call);
  if (!carrierPrototype) return undefined;

  // This lowering emits a flag-only descriptor. Decline if another descriptor
  // field is also present on the proven prototype chain; the generic runtime
  // path must preserve that value/accessor/enumerability information.
  for (const field of ["value", "enumerable", "get", "set"] as const) {
    const ownState = prototypeDescriptorFieldState(call, carrierPrototype, field);
    const state =
      ownState.kind !== "absent" || carrierPrototype === "Object"
        ? ownState
        : prototypeDescriptorFieldState(call, "Object", field);
    if (state.kind !== "absent") return undefined;
  }

  const result: Partial<Record<DescriptorBooleanField, true>> = {};
  for (const field of ["writable", "configurable"] as const) {
    const ownState = prototypeDescriptorFieldState(call, carrierPrototype, field);
    const state =
      ownState.kind !== "absent" || carrierPrototype === "Object"
        ? ownState
        : prototypeDescriptorFieldState(call, "Object", field);
    if (state.kind === "value" && state.value) result[field] = true;
  }
  return result.writable || result.configurable ? result : undefined;
}
