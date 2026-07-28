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
import { resolvesToAmbientGlobal } from "./expressions/new-super.js";
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
 * indented form. `null` is the internal "ignore this pure value" result for
 * statically-known non-Number/non-String shapes; `undefined` means unresolved
 * and keeps the caller on its refusal path. Per §25.5.2 only the first 10
 * characters of a string space (or `min(10, floor(n))` for a number) are used.
 */
export function staticSpaceValue(ctx: CodegenContext, expr: ts.Expression): number | string | null | undefined {
  return staticSpaceValueInner(ctx, expr, true);
}

function staticSpaceValueInner(
  ctx: CodegenContext,
  expr: ts.Expression,
  allowInlineNumberWrapper: boolean,
): number | string | null | undefined {
  const cur = unwrapTransparentExpression(expr);
  if (ts.isNumericLiteral(cur)) return Number(cur.text.replace(/_/g, ""));
  if (ts.isPrefixUnaryExpression(cur) && ts.isNumericLiteral(cur.operand)) {
    const n = Number(cur.operand.text.replace(/_/g, ""));
    if (cur.operator === ts.SyntaxKind.MinusToken) return -n;
    if (cur.operator === ts.SyntaxKind.PlusToken) return n;
  }
  if (ts.isStringLiteral(cur) || ts.isNoSubstitutionTemplateLiteral(cur)) return cur.text;
  if (ts.isNewExpression(cur) && ts.isIdentifier(cur.expression) && resolvesToAmbientGlobal(ctx, cur.expression)) {
    if (cur.expression.text === "Number" && allowInlineNumberWrapper) {
      if ((cur.arguments?.length ?? 0) === 0) return 0;
      if (cur.arguments?.length === 1) {
        const primitive = staticSpaceValueInner(ctx, cur.arguments[0]!, false);
        if (typeof primitive === "number") return primitive;
      }
      return undefined;
    }
    if (
      cur.expression.text === "Boolean" &&
      cur.arguments?.length === 1 &&
      (cur.arguments[0]!.kind === ts.SyntaxKind.TrueKeyword || cur.arguments[0]!.kind === ts.SyntaxKind.FalseKeyword)
    ) {
      return null;
    }
  }
  if (
    ts.isCallExpression(cur) &&
    ts.isIdentifier(cur.expression) &&
    cur.expression.text === "Symbol" &&
    cur.arguments.length === 0 &&
    resolvesToAmbientGlobal(ctx, cur.expression)
  ) {
    return null;
  }
  if (
    cur.kind === ts.SyntaxKind.NullKeyword ||
    cur.kind === ts.SyntaxKind.TrueKeyword ||
    cur.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isObjectLiteralExpression(cur) && cur.properties.length === 0)
  ) {
    return null;
  }
  if (ts.isIdentifier(cur)) {
    const init = constInitializerForIdentifier(ctx, cur);
    // Primitive const bindings stay foldable. Do not fold a Number wrapper
    // reached through a binding: its valueOf/toString methods can be mutated
    // before JSON.stringify observes it.
    if (init) return staticSpaceValueInner(ctx, init, false);
  }
  return undefined;
}

/**
 * (#2166 PR-B) Resolve a static `space` argument to the per-level indent unit
 * string (the "gap") per §25.5.2 step 6: a Number → `min(10, floor(n))` spaces
 * (≤0 / NaN → ""); a String → its first 10 code units. Returns `""` for any
 * gap that produces no indentation (the dynamic-graph codec then serialises
 * compactly). The caller passes the gap to `__json_stringify_root_indent`.
 */
export function jsonGapFromStaticSpace(space: number | string | null): string {
  if (space === null) return "";
  if (typeof space === "number") {
    if (!Number.isFinite(space)) return "";
    const n = Math.min(10, Math.floor(space));
    return n > 0 ? " ".repeat(n) : "";
  }
  return space.slice(0, 10);
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
    if (init) {
      // #2166 soundness: a `const`-bound object/array is still MUTABLE in place
      // (`const o = {}; o.x = f()`), so folding its *declaration* literal would
      // silently drop later property/element assignments and emit wrong JSON
      // (it produced `"{}"` for any runtime-built graph). Only follow an
      // identifier to a PRIMITIVE const initializer; object/array bindings fall
      // through to UNSUPPORTED, which routes them to the dynamic native codec
      // (or, before PR-A, the Phase-1 refusal) instead of a wrong static fold.
      const initUnwrapped = unwrapTransparentExpression(init);
      if (ts.isObjectLiteralExpression(initUnwrapped) || ts.isArrayLiteralExpression(initUnwrapped)) {
        return UNSUPPORTED;
      }
      return staticJsonValue(ctx, init, seen);
    }
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
  let space: number | string | null | undefined;
  if (spaceArg !== undefined) {
    space = staticSpaceValue(ctx, spaceArg);
    if (space === undefined) return undefined;
  }

  const serialized = space === undefined || space === null ? JSON.stringify(value) : JSON.stringify(value, null, space);
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
  // #3384 — unwrap transparent wrappers (`as`, parens, `!`) BEFORE reading
  // `.arguments`. `isJsonParseCall` unwraps internally, so `(JSON.parse(s) as
  // any).a` passes the guard while `expr.expression` is still the AsExpression
  // (no `.arguments` field) — reading `expr.expression.arguments[0]` then threw
  // "Cannot read properties of undefined (reading '0')" (its predicate lies at
  // runtime). Read args off the unwrapped call node instead.
  const call = unwrapTransparentExpression(expr.expression);
  if (!(ctx.standalone || ctx.wasi) || !isJsonParseCall(call)) return undefined;
  const value = parsedJsonLiteral(ctx, call.arguments[0]!);
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
  // #3384 — unwrap before reading `.arguments` (see tryEmitJsonParsePropertyAccess).
  const call = unwrapTransparentExpression(expr.expression);
  if (!(ctx.standalone || ctx.wasi) || !isJsonParseCall(call)) return undefined;
  const value = parsedJsonLiteral(ctx, call.arguments[0]!);
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
