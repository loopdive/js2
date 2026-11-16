// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Whether an identifier reads the realm's own global of its name: the lib
 * binding no source declaration shadows, and the global constants; and
 * (#7294) the builtin-prototype member shapes answered by named support
 * functions. The admission of a built-in global read as a value is
 * `ir/builtin-globals.ts`.
 */
import ts from "typescript";
import { outermostParenthesized } from "./binding-writes.js";

/** `===` and `!==`: positions that observe a value's identity only. */
const STRICT_EQUALITY_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

/**
 * The built-in globals whose realm property is the value legacy's bare read
 * yields, measured with a legacy `return <Name>` against the module's read and
 * against `globalThis.<Name>`. `Function` takes the provider-owned
 * `%Function%` when the module reads it bare (`function-intrinsic-carrier.ts`),
 * on both sides alike.
 *   - `every-lane`: #7118's names, measured on standalone and the JS
 *     environment;
 *   - `standalone`: the rest of the ES5 namespaces and global functions
 *     (#7350, 2026-11-15), measured on standalone only, so they ask the lane's
 *     `native-builtin-globals` capability: the JS environment's output stays
 *     byte-identical.
 * The ES2015+ constructors (`Map`, `Promise`, `Proxy`, …) are not measured.
 */
const BUILTIN_GLOBAL_LANES: ReadonlyMap<string, "every-lane" | "standalone"> = new Map([
  ...[
    "Object",
    "Function",
    "Array",
    "String",
    "Boolean",
    "Number",
    "Symbol",
    "Error",
    "EvalError",
    "RangeError",
    "ReferenceError",
    "SyntaxError",
    "TypeError",
    "URIError",
  ].map((name) => [name, "every-lane"] as const),
  ...[
    "Math",
    "JSON",
    "Date",
    "RegExp",
    "parseInt",
    "parseFloat",
    "isNaN",
    "isFinite",
    "decodeURI",
    "decodeURIComponent",
    "encodeURI",
    "encodeURIComponent",
    "escape",
    "unescape",
  ].map((name) => [name, "standalone"] as const),
]);

/** The lanes a built-in global was measured on, or `undefined` for any other name (`ir/builtin-globals.ts`). */
export function builtinGlobalLanes(name: string): "every-lane" | "standalone" | undefined {
  return BUILTIN_GLOBAL_LANES.get(name);
}

/** Also consulted by the codegen `instanceof` arm (`ir-dynamic-instanceof.ts`): the names the realm read admits. */
export function isBuiltinGlobalName(name: string): boolean {
  return BUILTIN_GLOBAL_LANES.has(name);
}

/**
 * Every declaration of `node`'s symbol is a lib one AND nothing in its file
 * declares the name: a script's top-level `function Error() {}` is reported by
 * the checker as the lib declarations alone. (#7274) Also the native
 * ArrayBuffer surface's constructor identity, (#7276) the `Object.create`
 * admission (`ir/object-create-call.ts`), and the #7253 / #7267 ambient-call
 * admission (`ir/ambient-global-function-call.ts`).
 */
export function isUnshadowedLibBinding(
  node: ts.Identifier,
  isLibOnlyBinding: (node: ts.Identifier) => boolean,
): boolean {
  return isLibOnlyBinding(node) && !declaredNames(node.getSourceFile()).has(node.text);
}

/** (#7274) `undefined` read as the global value: nothing in the file declares the name. */
export function isUnshadowedUndefined(node: ts.Expression): boolean {
  return ts.isIdentifier(node) && node.text === "undefined" && isUnshadowedGlobalConstant(node);
}

const GLOBAL_CONSTANTS: ReadonlySet<string> = new Set(["undefined", "NaN", "Infinity"]);

/** (#7339) `undefined`, `NaN` or `Infinity` read as the global value: nothing in the file declares the name. */
export function isUnshadowedGlobalConstant(node: ts.Expression): boolean {
  return ts.isIdentifier(node) && GLOBAL_CONSTANTS.has(node.text) && isUndeclaredInFile(node);
}

/** Nothing in `node`'s file declares its name, so the read is of the global (a syntactic test, no checker). */
export function isUndeclaredInFile(node: ts.Identifier): boolean {
  return !declaredNames(node.getSourceFile()).has(node.text);
}

const declaredNamesCache = new WeakMap<ts.SourceFile, ReadonlySet<string>>();

/** Every name the file itself declares (function, class, variable, parameter, binding). */
function declaredNames(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const cached = declaredNamesCache.get(sourceFile);
  if (cached !== undefined) return cached;
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node) ||
        ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name)
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  declaredNamesCache.set(sourceFile, names);
  return names;
}

// ── (#7294) Builtin-prototype own members, answered by named support functions ──

/**
 * The two support functions codegen mints per (builtin, member) — the member's
 * singleton value and its `getOwnPropertyDescriptor` result — named by the
 * runtime symbols below. Selection, from-ast and the provider resolution all
 * name them through this one pair of functions.
 */
export type BuiltinProtoMemberRole = "value" | "descriptor";

const SYMBOL_PREFIX: Readonly<Record<BuiltinProtoMemberRole, string>> = {
  value: "__builtin_proto_value$",
  descriptor: "__builtin_proto_gopd$",
};

/** The runtime symbol naming one (builtin, member) support function. */
export function builtinProtoMemberSymbol(role: BuiltinProtoMemberRole, builtin: string, member: string): string {
  return `${SYMBOL_PREFIX[role]}${builtin}$${member}`;
}

/** Inverse of {@link builtinProtoMemberSymbol}; `undefined` for any other symbol. */
export function parseBuiltinProtoMemberSymbol(
  symbol: string,
): { readonly role: BuiltinProtoMemberRole; readonly builtin: string; readonly member: string } | undefined {
  for (const role of ["value", "descriptor"] as const) {
    if (!symbol.startsWith(SYMBOL_PREFIX[role])) continue;
    const key = symbol.slice(SYMBOL_PREFIX[role].length);
    const split = key.indexOf("$"); // a builtin name never contains `$`; a member key may
    return split > 0 && split < key.length - 1
      ? { role, builtin: key.slice(0, split), member: key.slice(split + 1) }
      : undefined;
  }
  return undefined;
}

/** The `<B>` and `"<m>"` of a `<B>.prototype.<m>` value read or a `gOPD(<B>.prototype, "<m>")` call. */
export interface BuiltinProtoMemberRef {
  readonly builtin: ts.Identifier;
  readonly member: string;
  /** Lib globals the shape reads besides `builtin` (`Object` in `Object.getOwnPropertyDescriptor`). */
  readonly namespaces: readonly ts.Identifier[];
}

/** `<Identifier>.prototype` → the identifier. */
function prototypeReceiver(expr: ts.Expression): ts.Identifier | undefined {
  return ts.isPropertyAccessExpression(expr) &&
    expr.name.text === "prototype" &&
    !expr.questionDotToken &&
    ts.isIdentifier(expr.expression)
    ? expr.expression
    : undefined;
}

/**
 * `<B>.prototype.<m>` read as a value where only its identity is observed: a
 * `===` / `!==` operand, a call argument (`assert.sameValue(d.value,
 * Array.prototype.slice)`) or a variable initializer. Anything that reads the
 * value further (`.length`, `.call`, `delete`, `"" + f`) is not this shape.
 */
export function builtinProtoMemberValueRead(expr: ts.Expression): BuiltinProtoMemberRef | undefined {
  if (!ts.isPropertyAccessExpression(expr) || expr.questionDotToken || !ts.isIdentifier(expr.name)) return undefined;
  const builtin = prototypeReceiver(expr.expression);
  if (builtin === undefined) return undefined;
  const use = outermostParenthesized(expr);
  const parent = use.parent;
  const valuePosition =
    parent !== undefined &&
    ((ts.isVariableDeclaration(parent) && parent.initializer === use) ||
      (ts.isBinaryExpression(parent) && STRICT_EQUALITY_OPERATORS.has(parent.operatorToken.kind)) ||
      (ts.isCallExpression(parent) && parent.expression !== use));
  return valuePosition ? { builtin, member: expr.name.text, namespaces: [] } : undefined;
}

/** `Object.getOwnPropertyDescriptor(<B>.prototype, "<m>")` with a literal key. */
export function builtinProtoDescriptorCall(call: ts.CallExpression): BuiltinProtoMemberRef | undefined {
  const callee = call.expression;
  if (call.questionDotToken || call.arguments.length !== 2 || !ts.isPropertyAccessExpression(callee)) return undefined;
  if (callee.name.text !== "getOwnPropertyDescriptor" || !ts.isIdentifier(callee.expression)) return undefined;
  if (callee.expression.text !== "Object") return undefined;
  const builtin = prototypeReceiver(call.arguments[0]!);
  const key = call.arguments[1]!;
  return builtin !== undefined && ts.isStringLiteralLike(key)
    ? { builtin, member: key.text, namespaces: [callee.expression] }
    : undefined;
}

/** Every global the shape names is the lib one: no source declaration in the file shadows it. */
export function builtinProtoMemberGlobalsUnshadowed(
  ref: BuiltinProtoMemberRef,
  isLibOnlyBinding: (node: ts.Identifier) => boolean,
): boolean {
  return [ref.builtin, ...ref.namespaces].every(
    (node) => isLibOnlyBinding(node) && !declaredNames(node.getSourceFile()).has(node.text),
  );
}
