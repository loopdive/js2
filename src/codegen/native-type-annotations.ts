// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Native type annotations (#323, revived by #3673) — syntactic resolution.
 *
 * ## Why this file exists
 *
 * `#323` shipped `type i32 = number; let x: i32` as a **performance escape
 * hatch**: the annotation asks the compiler to store the value in a Wasm `i32`
 * instead of the default `f64`. The original implementation
 * (`resolveNativeTypeAnnotation` in `codegen/index.ts`) detected the annotation
 * from `tsType.aliasSymbol?.name`.
 *
 * **That detection can never fire.** TypeScript populates `aliasSymbol` for
 * aliases of *object* and *union* types, but NOT for an alias of an intrinsic
 * primitive: `type i32 = number` resolves to the shared `numberType`, which
 * carries no alias identity. Measured on TypeScript 5.9.3:
 *
 * ```
 * type i32 = number;  declare const x: i32;  →  aliasSymbol = (none)
 * type Pair = {a: number};  declare const y: Pair;  →  aliasSymbol = Pair
 * type Uni = number | string;  declare const z: Uni;  →  aliasSymbol = Uni
 * ```
 *
 * Instrumenting the live compiler over the #3673 tokenizer benchmark (which is
 * `i32`-annotated throughout) gave **84 calls to `resolveNativeTypeAnnotation`,
 * 0 hits, and not a single alias name observed**. The emitted code agrees: in
 * `gc` / `standalone` / `wasi` mode every `i32`-annotated local came out `f64`.
 * The feature only appeared to work in `fast` mode, where *every* `number`
 * becomes `i32` regardless of annotation.
 *
 * So the inertness is **accidental, not a deliberate semantic gate** —
 * `resolveWasmType` consults the native map *before* any `ctx.fast` branch, so
 * there is no fast-gate to remove. The annotation simply never resolved.
 *
 * ## What this file does
 *
 * Resolve the annotation **syntactically, from the declaration's type node**,
 * which is the only place the alias identity survives. This is deliberately
 * narrow:
 *
 *  - only an explicit `TypeReference` whose name is one of the native names;
 *  - the name must resolve to a **type alias declared in user code** whose
 *    right-hand side is the `number` keyword — an import, an interface, a
 *    generic instantiation or an alias of anything else is rejected, so a
 *    user type genuinely called `i32` cannot be hijacked;
 *  - **no inference**: an unannotated `number` is untouched. Writing `i32` is
 *    the user's opt-in, exactly as `#323` specified ("purely a performance
 *    escape hatch for developers who know their value ranges").
 *
 * ## Semantic contract of an `i32`-annotated binding
 *
 * The annotation is an assertion by the author, and it changes observable
 * behaviour for values outside its range — that is the point of the escape
 * hatch, and it is why it is opt-in per binding:
 *
 *  - values are stored as a **signed 32-bit integer**; assignment of a value
 *    outside [-2^31, 2^31-1] saturates (`i32.trunc_sat_f64_s`) rather than
 *    wrapping, and a fractional value truncates toward zero;
 *  - `NaN` and `±Infinity` are not representable — they store as `0`,
 *    `2147483647` and `-2147483648` respectively (saturating truncation);
 *  - `-0` is not representable — it stores as `+0`, so `Object.is(x, -0)`
 *    reads `false`;
 *  - arithmetic on two `i32` operands is done in i32 (see
 *    `binary-ops.ts` `bothNativeI32`), which wraps on overflow rather than
 *    growing into f64 precision.
 *
 * Unannotated `number` bindings keep full IEEE-754 semantics.
 */
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";

/**
 * Native type annotation map: type alias names that map to Wasm types.
 * Mirrors `#323`'s table. `i64` is intentionally absent — it needs BigInt
 * integration.
 */
export const NATIVE_TYPE_MAP: Record<string, ValType> = {
  i32: { kind: "i32" },
  u8: { kind: "i32" }, // unsigned 8-bit — stored as i32 (masked at boundaries)
  u16: { kind: "i32" }, // unsigned 16-bit — stored as i32 (masked at boundaries)
  u32: { kind: "i32" }, // unsigned 32-bit — stored as i32
  i8: { kind: "i32" }, // signed 8-bit — stored as i32
  i16: { kind: "i32" }, // signed 16-bit — stored as i32
  f32: { kind: "f32" },
  f64: { kind: "f64" },
};

/**
 * True when `decl` is a `type <name> = number;` alias declared in user code
 * (not a `.d.ts` lib file). Generic aliases are rejected — `type i32<T> = …`
 * is not the documented form and instantiating it would lose the identity we
 * are matching on.
 */
function isNumberAliasDeclaration(decl: ts.Declaration): boolean {
  if (!ts.isTypeAliasDeclaration(decl)) return false;
  if (decl.typeParameters && decl.typeParameters.length > 0) return false;
  if (decl.getSourceFile().isDeclarationFile) return false;
  return decl.type.kind === ts.SyntaxKind.NumberKeyword;
}

/**
 * Resolve a native type annotation from an explicit **type node**.
 *
 * Returns the Wasm `ValType` the annotation asks for, or `null` when the node
 * is absent, is not a bare type reference, names something that is not one of
 * the native aliases, or names a symbol that is not a user-declared
 * `= number` alias.
 */
export function nativeTypeFromTypeNode(checker: ts.TypeChecker, node: ts.TypeNode | undefined): ValType | null {
  if (!node || !ts.isTypeReferenceNode(node)) return null;
  if (node.typeArguments && node.typeArguments.length > 0) return null;
  const nameNode = node.typeName;
  if (!ts.isIdentifier(nameNode)) return null;
  const mapped = NATIVE_TYPE_MAP[nameNode.text];
  if (!mapped) return null;
  // The name must actually bind to a user-declared `= number` alias. Without
  // this check a program that declares `interface i32 { … }` (or imports an
  // unrelated `i32`) would be silently miscompiled to a Wasm i32.
  const symbol = checker.getSymbolAtLocation(nameNode);
  const declarations = symbol?.declarations;
  if (!declarations || declarations.length === 0) return null;
  if (!declarations.every(isNumberAliasDeclaration)) return null;
  return mapped;
}

/**
 * `nativeTypeFromTypeNode` for a declaration that carries an optional type
 * annotation (`ts.VariableDeclaration`, `ts.ParameterDeclaration`,
 * `ts.PropertyDeclaration`, signature return types, …).
 */
export function nativeTypeOfDeclaration(
  checker: ts.TypeChecker,
  decl: { readonly type?: ts.TypeNode } | undefined,
): ValType | null {
  return nativeTypeFromTypeNode(checker, decl?.type);
}

/**
 * `s.length` / `arr.length` where the receiver is a string or an array.
 *
 * These are the only `number`-typed reads whose value is provably a
 * non-negative int32 without any user annotation, and the emitted code already
 * holds them as an i32 field — so admitting them into an i32 arithmetic chain
 * neither loses precision nor changes a comparison result.
 */
function isI32ValuedLengthRead(checker: ts.TypeChecker, expr: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(expr)) return false;
  if (ts.isPrivateIdentifier(expr.name) || expr.name.text !== "length") return false;
  const recvType = checker.getTypeAtLocation(expr.expression);
  if (recvType.flags & ts.TypeFlags.StringLike) return true;
  const symbolName = (recvType as ts.TypeReference).symbol?.name ?? recvType.symbol?.name;
  return symbolName === "Array" || symbolName === "ReadonlyArray";
}

/** Strip parens / `as` / `!` so operand inspection sees the real expression. */
function unwrapExpression(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) {
    e = e.expression;
  }
  return e;
}

/**
 * The native annotation an EXPRESSION's value carries, by looking through to
 * the declaration it reads.
 *
 * Handles the three shapes a typed hot loop is built from: an identifier
 * (local / parameter), a property access (`this.pos`), and a call whose
 * signature declares a native return type. Anything else — and anything whose
 * declaration has no explicit annotation — returns `null`, so the caller keeps
 * the default f64 numeric hint.
 */
export function nativeTypeOfExpression(checker: ts.TypeChecker, expr: ts.Expression): ValType | null {
  const e = unwrapExpression(expr);
  if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
    const nameNode = ts.isIdentifier(e) ? e : e.name;
    if (ts.isPrivateIdentifier(nameNode)) return null;
    const symbol = checker.getSymbolAtLocation(nameNode);
    const decl = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (!decl) return null;
    if (ts.isVariableDeclaration(decl) || ts.isParameter(decl) || ts.isPropertyDeclaration(decl)) {
      return nativeTypeFromTypeNode(checker, decl.type);
    }
    return null;
  }
  if (ts.isCallExpression(e)) {
    const decl = checker.getResolvedSignature(e)?.declaration;
    if (!decl || ts.isJSDocSignature(decl)) return null;
    return nativeTypeFromTypeNode(checker, decl.type);
  }
  return null;
}

/**
 * An operand that may participate in an `i32` arithmetic/comparison chain
 * WITHOUT being able to start one.
 *
 * Two forms qualify, both exactly representable in i32 and f64 alike:
 *  - an int32 literal (`this.pos + 1`);
 *  - a `.length` read on a string or array — held as an i32 field in the
 *    emitted code and a non-negative int32 by construction, which is what keeps
 *    `pos < src.length` (the commonest comparison in a character loop) off the
 *    f64 path.
 *
 * Deliberately NOT an anchor: the i32 hint is only taken when at least one
 * operand carries a real user annotation, so unannotated code such as
 * `arr.length - 1` keeps its existing f64 lowering byte-for-byte.
 */
export function isI32CompatibleOperand(checker: ts.TypeChecker, expr: ts.Expression): boolean {
  return isInt32Literal(expr) || isI32ValuedLengthRead(checker, unwrapExpression(expr));
}

/**
 * An integer literal (optionally negated) that fits in int32. Such a literal is
 * exactly representable in BOTH i32 and f64, so mixing it into an otherwise
 * `i32`-annotated arithmetic chain cannot change the result — which is what
 * lets `this.pos + 1` stay in i32 instead of round-tripping through f64.
 */
export function isInt32Literal(expr: ts.Expression): boolean {
  const e = unwrapExpression(expr);
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken) {
    if (!ts.isNumericLiteral(e.operand)) return false;
    const v = -Number(e.operand.text.replace(/_/g, ""));
    return Number.isInteger(v) && v >= -2147483648 && v <= 2147483647;
  }
  if (!ts.isNumericLiteral(e)) return false;
  const v = Number(e.text.replace(/_/g, ""));
  return Number.isInteger(v) && v >= -2147483648 && v <= 2147483647;
}
