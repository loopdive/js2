// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Bounded standalone JSON support for #1599.
 *
 * This is a runtime-host-independent slice: statically known JSON values are
 * folded by the compiler and materialized as Wasm constants/native strings.
 * Dynamic JSON text and dynamic object graphs still refuse in standalone/WASI
 * until the full runtime parser/value representation lands.
 */
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { emitUndefined } from "./expressions/late-imports.js";
import { compileStringLiteral } from "./string-ops.js";

type JsonStaticValue = null | boolean | number | string | JsonStaticValue[] | { [key: string]: JsonStaticValue };

const UNSUPPORTED = Symbol("unsupported-json-static-value");
type StaticResult = JsonStaticValue | typeof UNSUPPORTED;

function unwrapTransparentExpression(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isTypeAssertionExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isNonNullExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

function constInitializerForIdentifier(ctx: CodegenContext, expr: ts.Identifier): ts.Expression | undefined {
  const sym = ctx.checker.getSymbolAtLocation(expr);
  const decl = sym?.valueDeclaration;
  if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return undefined;
  const list = decl.parent;
  if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return undefined;
  return decl.initializer;
}

function staticStringValue(ctx: CodegenContext, expr: ts.Expression, seen = new Set<ts.Node>()): string | undefined {
  const cur = unwrapTransparentExpression(expr);
  if (ts.isStringLiteral(cur) || ts.isNoSubstitutionTemplateLiteral(cur)) return cur.text;
  if (ts.isIdentifier(cur)) {
    const init = constInitializerForIdentifier(ctx, cur);
    if (init && !seen.has(init)) {
      seen.add(init);
      return staticStringValue(ctx, init, seen);
    }
  }
  return undefined;
}

/**
 * #2166 — resolve a `JSON.stringify` `space` argument (3rd parameter) to a
 * compile-time number or string, so the static stringify path can produce the
 * indented form. Returns `undefined` when the value isn't statically known
 * (caller then refuses / keeps the compact form gate). Per §25.5.2 only the
 * first 10 characters of a string space (or `min(10, floor(n))` for a number)
 * are used; JS's own `JSON.stringify` applies that, so we just forward.
 */
function staticSpaceValue(ctx: CodegenContext, expr: ts.Expression): number | string | undefined {
  const cur = unwrapTransparentExpression(expr);
  if (ts.isNumericLiteral(cur)) return Number(cur.text.replace(/_/g, ""));
  if (ts.isPrefixUnaryExpression(cur) && ts.isNumericLiteral(cur.operand)) {
    const n = Number(cur.operand.text.replace(/_/g, ""));
    if (cur.operator === ts.SyntaxKind.MinusToken) return -n;
    if (cur.operator === ts.SyntaxKind.PlusToken) return n;
  }
  if (ts.isStringLiteral(cur) || ts.isNoSubstitutionTemplateLiteral(cur)) return cur.text;
  if (ts.isIdentifier(cur)) {
    const init = constInitializerForIdentifier(ctx, cur);
    if (init) return staticSpaceValue(ctx, init);
  }
  return undefined;
}

function staticPropertyName(ctx: CodegenContext, name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return String(Number(name.text));
  if (ts.isComputedPropertyName(name)) return staticStringValue(ctx, name.expression);
  return undefined;
}

function staticJsonValue(ctx: CodegenContext, expr: ts.Expression, seen = new Set<ts.Node>()): StaticResult {
  const cur = unwrapTransparentExpression(expr);
  if (seen.has(cur)) return UNSUPPORTED;
  seen.add(cur);

  if (cur.kind === ts.SyntaxKind.NullKeyword) return null;
  if (cur.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (cur.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isStringLiteral(cur) || ts.isNoSubstitutionTemplateLiteral(cur)) return cur.text;
  if (ts.isNumericLiteral(cur)) return Number(cur.text.replace(/_/g, ""));

  if (ts.isPrefixUnaryExpression(cur) && ts.isNumericLiteral(cur.operand)) {
    const n = Number(cur.operand.text.replace(/_/g, ""));
    if (cur.operator === ts.SyntaxKind.MinusToken) return -n;
    if (cur.operator === ts.SyntaxKind.PlusToken) return n;
  }

  if (ts.isIdentifier(cur)) {
    if (cur.text === "NaN") return NaN;
    if (cur.text === "Infinity") return Infinity;
    if (cur.text === "undefined") return UNSUPPORTED;
    const init = constInitializerForIdentifier(ctx, cur);
    if (init) return staticJsonValue(ctx, init, seen);
  }

  if (ts.isArrayLiteralExpression(cur)) {
    const out: JsonStaticValue[] = [];
    for (const element of cur.elements) {
      if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) return UNSUPPORTED;
      const value = staticJsonValue(ctx, element, seen);
      if (value === UNSUPPORTED) return UNSUPPORTED;
      out.push(value);
    }
    return out;
  }

  if (ts.isObjectLiteralExpression(cur)) {
    const out: { [key: string]: JsonStaticValue } = {};
    for (const prop of cur.properties) {
      if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) return UNSUPPORTED;
      const key = ts.isShorthandPropertyAssignment(prop) ? prop.name.text : staticPropertyName(ctx, prop.name);
      if (key === undefined) return UNSUPPORTED;
      const valueExpr = ts.isShorthandPropertyAssignment(prop) ? prop.name : prop.initializer;
      const value = staticJsonValue(ctx, valueExpr, seen);
      if (value === UNSUPPORTED) return UNSUPPORTED;
      out[key] = value;
    }
    return out;
  }

  return UNSUPPORTED;
}

function parsedJsonLiteral(ctx: CodegenContext, arg: ts.Expression): StaticResult {
  const text = staticStringValue(ctx, arg);
  if (text === undefined) return UNSUPPORTED;
  try {
    return JSON.parse(text) as JsonStaticValue;
  } catch {
    return UNSUPPORTED;
  }
}

export function isJsonParseCall(expr: ts.Expression): expr is ts.CallExpression {
  const cur = unwrapTransparentExpression(expr);
  return (
    ts.isCallExpression(cur) &&
    ts.isPropertyAccessExpression(cur.expression) &&
    ts.isIdentifier(cur.expression.expression) &&
    cur.expression.expression.text === "JSON" &&
    cur.expression.name.text === "parse" &&
    cur.arguments.length >= 1
  );
}

function emitJsonStaticValue(ctx: CodegenContext, fctx: FunctionContext, value: JsonStaticValue): ValType | null {
  if (value === null) {
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }
  if (typeof value === "boolean") {
    fctx.body.push({ op: "i32.const", value: value ? 1 : 0 });
    return { kind: "i32" };
  }
  if (typeof value === "number") {
    fctx.body.push({ op: "f64.const", value });
    return { kind: "f64" };
  }
  if (typeof value === "string") {
    return compileStringLiteral(ctx, fctx, value);
  }
  return null;
}

export function tryEmitJsonStringifyStatic(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arg: ts.Expression,
  replacerArg?: ts.Expression,
  spaceArg?: ts.Expression,
): ValType | null | undefined {
  const value = staticJsonValue(ctx, arg);
  if (value === UNSUPPORTED) return undefined;

  // #2166: only a `null`/`undefined`/omitted replacer is supported statically
  // (a function/array replacer needs runtime observation). Bail otherwise so
  // the caller keeps its refusal path rather than silently ignoring it.
  if (replacerArg !== undefined) {
    const r = unwrapTransparentExpression(replacerArg);
    const isNullish = r.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(r) && r.text === "undefined");
    if (!isNullish) return undefined;
  }

  // #2166: resolve a static `space` (number or string) and forward to JS's own
  // JSON.stringify, which applies the §25.5.2 clamping/indentation rules. A
  // dynamic space falls back to the caller's refusal.
  let space: number | string | undefined;
  if (spaceArg !== undefined) {
    space = staticSpaceValue(ctx, spaceArg);
    if (space === undefined) return undefined;
  }

  const serialized = space === undefined ? JSON.stringify(value) : JSON.stringify(value, null, space);
  if (serialized === undefined) return undefined;
  return compileStringLiteral(ctx, fctx, serialized);
}

export function tryEmitJsonParseLiteral(
  ctx: CodegenContext,
  fctx: FunctionContext,
  call: ts.CallExpression,
): ValType | null | undefined {
  const value = parsedJsonLiteral(ctx, call.arguments[0]!);
  if (value === UNSUPPORTED || (value !== null && typeof value === "object")) return undefined;
  return emitJsonStaticValue(ctx, fctx, value);
}

export function tryEmitJsonParsePropertyAccess(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
): ValType | null | undefined {
  if (!(ctx.standalone || ctx.wasi) || !isJsonParseCall(expr.expression)) return undefined;
  const value = parsedJsonLiteral(ctx, expr.expression.arguments[0]!);
  if (value === UNSUPPORTED || value === null || Array.isArray(value) || typeof value !== "object") return undefined;
  if (!Object.prototype.hasOwnProperty.call(value, expr.name.text)) {
    emitUndefined(ctx, fctx);
    return { kind: "externref" };
  }
  return emitJsonStaticValue(ctx, fctx, value[expr.name.text]!);
}

export function tryEmitJsonParseElementAccess(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ElementAccessExpression,
): ValType | null | undefined {
  if (!(ctx.standalone || ctx.wasi) || !isJsonParseCall(expr.expression)) return undefined;
  const value = parsedJsonLiteral(ctx, expr.expression.arguments[0]!);
  if (value === UNSUPPORTED) return undefined;

  const keyExpr = unwrapTransparentExpression(expr.argumentExpression);
  let selected: JsonStaticValue | undefined;
  if (Array.isArray(value) && ts.isNumericLiteral(keyExpr)) {
    selected = value[Number(keyExpr.text)];
  } else if (value !== null && !Array.isArray(value) && typeof value === "object") {
    const key = ts.isStringLiteral(keyExpr) || ts.isNoSubstitutionTemplateLiteral(keyExpr) ? keyExpr.text : undefined;
    if (key !== undefined) selected = value[key];
  }

  if (selected === undefined) {
    emitUndefined(ctx, fctx);
    return { kind: "externref" };
  }
  return emitJsonStaticValue(ctx, fctx, selected);
}
