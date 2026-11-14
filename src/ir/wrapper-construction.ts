// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #7340 — `new String(x)` / `new Number(x)` / `new Boolean(x)`: the one
 * recognizer, the one table and the one lowering of an ambient primitive-wrapper
 * construction, for the selector and from-ast alike.
 *
 * A construction is admitted in two positions ({@link wrapperConsumer}):
 *   - as the operand of a ToPrimitive operator (#4208 S4, #7106): the result
 *     stays `extern:Object` and the operator converts it ({@link emitToPrimitive});
 *   - as the whole value stored into a script `var` on the dynamic module home
 *     (#7340 S1): the result is boxed onto the dynamic carrier, as #7280 boxes
 *     the open `$Object` of `var o = {}`, and every later use reads it through
 *     the dynamic arms. The selector proves the target and the uses
 *     ({@link wrapperStoreRefusal}); from-ast boxes because the position says so.
 *
 * Both sides ask the same syntactic questions here, so they cannot disagree on
 * which construction is which position.
 */

import { isUnshadowedLibBinding } from "../shared/ambient-intrinsics.js";
import { hasDynamicScope, isStoreTarget, outermostParenthesized, stripParens } from "../shared/binding-writes.js";
import {
  sourceMayPatchPrototype,
  sourceNamesReflectiveRoute,
  sourceRunsDynamicCode,
  sourceWritesMemberNamed,
} from "../shared/intrinsic-prototype-writes.js";
import { ts } from "../ts-api.js";
import type { OperandFamily } from "./analysis/operand-admissibility.js";
import type { IrFunctionBuilder } from "./builder.js";
import { irRuntimeFuncRef } from "./callable-bindings.js";
import { isServedUse, referencesNamed, type ServedUsePolicy } from "./dynamic-home-uses.js";
import { irDynamic, irVal, type IrType, type IrValueId } from "./nodes.js";
import { OBJECT_PROTOTYPE_KEYS } from "./realm-keys.js";
import type { IrSelectionOptions } from "./select.js";

/** One constructor: its name and the primitive family it wraps. */
export interface WrapperRow {
  readonly name: "String" | "Number" | "Boolean";
  readonly family: "string" | "number" | "boolean";
}

const ROWS: readonly WrapperRow[] = [
  { name: "String", family: "string" },
  { name: "Number", family: "number" },
  { name: "Boolean", family: "boolean" },
];

/** An ambient wrapper construction with exactly one non-spread argument. */
export interface WrapperConstruction {
  readonly expr: ts.NewExpression;
  readonly row: WrapperRow;
  /** `undefined` when the arity is not one or the argument is a spread. */
  readonly argument: ts.Expression | undefined;
}

/** The binding facts each side answers the realm question with. */
export interface WrapperAmbience {
  readonly isAmbient: (node: ts.Identifier) => boolean;
  /** `String` has its own predicate (`isAmbientStringBinding`). */
  readonly isAmbientString: (node: ts.Identifier) => boolean;
}

/** The row `callee` names when it is the ambient constructor (a call, `instanceof` or `new` callee). */
export function ambientWrapperRow(callee: ts.Identifier, ambience: WrapperAmbience): WrapperRow | undefined {
  const row = ROWS.find((candidate) => candidate.name === callee.text);
  if (row === undefined) return undefined;
  const ambient = row.name === "String" ? ambience.isAmbientString(callee) : ambience.isAmbient(callee);
  return ambient ? row : undefined;
}

/** `expression`, parentheses peeled, as an ambient wrapper construction. */
export function wrapperConstruction(
  expression: ts.Expression,
  ambience: WrapperAmbience,
): WrapperConstruction | undefined {
  let expr = expression;
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (!ts.isNewExpression(expr) || !ts.isIdentifier(expr.expression)) return undefined;
  const row = ambientWrapperRow(expr.expression, ambience);
  if (row === undefined) return undefined;
  const args = expr.arguments ?? [];
  const single = args.length === 1 && !ts.isSpreadElement(args[0]!) ? args[0] : undefined;
  return { expr, row, argument: single };
}

/** The construction's argument, when the selector's `familyOf` proves it the row's own family. */
export function admissibleArgument(
  construction: WrapperConstruction | undefined,
  familyOf: (argument: ts.Expression) => OperandFamily,
): ts.Expression | undefined {
  const argument = construction?.argument;
  return argument !== undefined && familyOf(argument) === construction!.row.family ? argument : undefined;
}

/** The IR hint the argument is lowered under: its row's own representation. */
export function wrapperArgumentHint(row: WrapperRow): IrType {
  if (row.family === "number") return irVal({ kind: "f64" });
  if (row.family === "boolean") return irVal({ kind: "i32", boolean: true });
  return { kind: "string" };
}

/**
 * Where the construction's value goes: the whole initializer of, or the right
 * side of a plain `=` to, an identifier (`store`, with that identifier); any
 * other position is a ToPrimitive operand's (`operand`), the only other one
 * the selector admits.
 */
export type WrapperConsumer = { readonly kind: "store"; readonly target: ts.Identifier } | { readonly kind: "operand" };

export function wrapperConsumer(expr: ts.NewExpression): WrapperConsumer {
  const node = outermostParenthesized(expr);
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isIdentifier(parent.name)) {
    return { kind: "store", target: parent.name };
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.right === node &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(parent.left)
  ) {
    return { kind: "store", target: parent.left };
  }
  return { kind: "operand" };
}

/** A construction in store position, with the identifier it is stored to. */
export interface StoredWrapper extends WrapperConstruction {
  readonly target: ts.Identifier;
}

/**
 * `expr` as a construction in store position. A construction anywhere else is
 * not this lever's: the selector refuses or admits it on its pre-#7340 arms.
 */
export function storedWrapperConstruction(
  expr: ts.NewExpression,
  ambience: WrapperAmbience,
): StoredWrapper | undefined {
  const consumer = wrapperConsumer(expr);
  if (consumer.kind !== "store") return undefined;
  const construction = wrapperConstruction(expr, ambience);
  return construction && { ...construction, target: consumer.target };
}

/** The selector's lane options a store-position construction needs. */
type WrapperStoreLane = Pick<IrSelectionOptions, "isOpenObjectBinding" | "supportsBackendCapability"> | undefined;

/** The selector's module-binding resolver: the store target's slot kind, and the constructor's lib-only identity. */
interface WrapperStoreResolver {
  (node: ts.Identifier): { readonly valueKind: { readonly kind: string } } | undefined;
  isLibOnlyBinding(node: ts.Identifier): boolean;
}

/**
 * The selector's refusal of a store-position construction, or `undefined` to
 * admit it; `argumentFamily` is the selector's proven family of the argument.
 * The argument itself still has to be a Phase-1 expression. Asks, in order:
 * the lane (#7280's dynamic-home carrier arms run where the lane supplies
 * `isOpenObjectBinding`; a carrier is read through the native member read,
 * which WASI lacks, #7177), the store target's slot, the realm, the argument
 * rule, and every use of the stored-to name.
 */
export function wrapperStoreRefusal(
  stored: StoredWrapper,
  lane: WrapperStoreLane,
  resolver: WrapperStoreResolver | null,
  argumentFamily: (argument: ts.Expression) => OperandFamily,
): string | undefined {
  const supports = lane?.supportsBackendCapability;
  if (
    lane?.isOpenObjectBinding === undefined ||
    supports?.("primitive-wrapper-to-primitive") !== true ||
    supports?.("native-dynamic-member-read") !== true
  ) {
    return "expr-new-wrapper-lane";
  }
  if (resolver === null || resolver(stored.target)?.valueKind.kind !== "dynamic") return "expr-new-wrapper-home";
  if (!realmIsUnpatched(stored, (node) => resolver.isLibOnlyBinding(node))) return "expr-new-wrapper-realm";
  if (admissibleArgument(stored, argumentFamily) === undefined) return "expr-new-wrapper-argument";
  return everyUseIsServed(stored) ? undefined : "expr-new-wrapper-use";
}

/**
 * The constructor and the wrapper's prototype chain are the realm's, in every
 * way the program could change them: the constructor has only lib
 * declarations and none in the file (a script's `function String`, a
 * parameter) and is never written (`String = f`, `this.String = f`); neither
 * its prototype nor `Object.prototype` is patched, and no reflective route
 * reaches a prototype; no `eval`, `Function` or `with` could do any of it
 * unseen.
 */
function realmIsUnpatched(stored: StoredWrapper, isLibOnlyBinding: (node: ts.Identifier) => boolean): boolean {
  const callee = stored.expr.expression as ts.Identifier;
  const file = callee.getSourceFile();
  return (
    isUnshadowedLibBinding(callee, isLibOnlyBinding) &&
    !sourceWritesMemberNamed(file, callee.text) &&
    !sourceMayPatchPrototype(file, stored.row.name) &&
    !sourceMayPatchPrototype(file, "Object") &&
    !sourceNamesReflectiveRoute(file) &&
    !sourceRunsDynamicCode(file) &&
    !hasDynamicScope(file)
  );
}

/**
 * Every reference to the stored-to name, anywhere in the file, comes after
 * the construction and is served by {@link wrapperPolicy} (measured against
 * node, `tests/issue-7340.test.ts`). Name-based (`referencesNamed`): a
 * same-named binding elsewhere is judged too, which can only refuse more. A
 * use before the store (`var r = w + 1; var w = new Number(5)`) reads
 * `undefined`, which the claimed lowering does not expect.
 */
function everyUseIsServed(stored: StoredWrapper): boolean {
  const policy = wrapperPolicy(stored);
  return referencesNamed(stored.target, stored.target.getSourceFile()).every(
    (reference) => isDeclarationName(reference) || (reference.pos >= stored.expr.end && isServedUse(reference, policy)),
  );
}

/** `var w` (another declaration of the name): a store at most, never a read. */
function isDeclarationName(reference: ts.Identifier): boolean {
  return ts.isVariableDeclaration(reference.parent) && reference.parent.name === reference;
}

/**
 * The wrapper's allow-list for the shared scan (`isServedUse`). Served: a
 * store into the name; an operand of a binary operator other than a
 * relational one, except a loose comparison with `null`; a Number or Boolean
 * wrapper's relational operand against a numeric literal; an operand of a
 * prefix operator or `typeof`; a condition; and a plain member store. Not served — each either answers wrong, or is claimed and then
 * withdrawn, or hands the object to code no scan sees (measured,
 * `tests/issue-7340.test.ts`):
 *   - every member read. The dynamic member read answers only own properties
 *     the program stored: not a String wrapper's own `length`, not a member
 *     inherited from `String.prototype`, `Number.prototype`,
 *     `Boolean.prototype` or `Object.prototype`; and the realm catalog lists
 *     no keys for the first three to screen by;
 *   - any other relational operand. The dynamic relational (main's #2949
 *     S5.P producer, numeric-abstract) compares as strings only when both
 *     operands are strings before ToPrimitive, and its ToNumber does not
 *     convert a string: `new String("a") < "b"` and `new Number(1) < "9"`
 *     both answer wrong;
 *   - an element read, `void`, a loose `== null`, a `switch` discriminant, an
 *     alias, a call argument, a return value, a literal element, a template
 *     substitution, and a `for…in` / `in` / `instanceof` / `delete` operand.
 */
function wrapperPolicy(stored: StoredWrapper): ServedUsePolicy {
  const numericRelational = stored.row.family !== "string";
  return {
    unreadableKeys: OBJECT_PROTOTYPE_KEYS,
    servesMemberRead: () => false,
    servesReference: (use) => {
      const parent = use.parent;
      if (isStoreTarget(use)) return true;
      if (ts.isBinaryExpression(parent)) {
        const op = parent.operatorToken.kind;
        if (RELATIONAL_OPERATORS.has(op)) return numericRelational && againstNumericLiteral(use, parent);
        return SERVED_BINARY_OPERATORS.has(op) && !isLooseNullTest(parent);
      }
      return ts.isPrefixUnaryExpression(parent) || ts.isTypeOfExpression(parent) || isConditionOf(use, parent);
    },
  };
}

const SERVED_BINARY_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.CaretToken,
  ts.SyntaxKind.LessThanLessThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

const RELATIONAL_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

/** The other operand of `comparison` is a numeric literal, so the numeric-abstract compare is exact. */
function againstNumericLiteral(use: ts.Expression, comparison: ts.BinaryExpression): boolean {
  const other = stripParens(comparison.left === use ? comparison.right : comparison.left);
  return ts.isNumericLiteral(other);
}

/** `w == null` / `w != null`: from-ast folds the `null` operand before the carrier compare (#7212's case). */
function isLooseNullTest(comparison: ts.BinaryExpression): boolean {
  const op = comparison.operatorToken.kind;
  if (op !== ts.SyntaxKind.EqualsEqualsToken && op !== ts.SyntaxKind.ExclamationEqualsToken) return false;
  return [comparison.left, comparison.right].some((side) => stripParens(side).kind === ts.SyntaxKind.NullKeyword);
}

/** The test of an `if`, a loop or a conditional expression. */
function isConditionOf(use: ts.Expression, parent: ts.Node): boolean {
  return (
    ((ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) &&
      parent.expression === use) ||
    (ts.isForStatement(parent) && parent.condition === use) ||
    (ts.isConditionalExpression(parent) && parent.condition === use)
  );
}

/** `new <row>(argument)` through the row's native constructor; the result is `extern:Object`. */
export function emitWrapperConstruction(builder: IrFunctionBuilder, row: WrapperRow, argument: IrValueId): IrValueId {
  const native =
    row.family === "boolean"
      ? builder.emitUnary("f64.convert_i32_s", argument, irVal({ kind: "f64" }))
      : row.family === "string"
        ? builder.emitCoerceToExternref(argument)
        : argument;
  const value = builder.emitCall(irRuntimeFuncRef(`__new_${row.name}`), [native], {
    kind: "extern",
    className: "Object",
  });
  if (value === null) {
    // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
    throw new Error(`ir/wrapper-construction: __new_${row.name} produced no value`);
  }
  return value;
}

/** A store-position construction's value: the wrapper on the dynamic carrier, untagged. */
export function boxWrapper(builder: IrFunctionBuilder, wrapper: IrValueId): IrValueId {
  return builder.emitBox(builder.emitCoerceToExternref(wrapper), irDynamic());
}

/**
 * The canonical `__to_primitive(value, hint)` call, as an externref. `default`
 * passes the null hint; `number` the string `"number"`.
 */
export function emitToPrimitive(builder: IrFunctionBuilder, value: IrValueId, hint: "default" | "number"): IrValueId {
  const externref = irVal({ kind: "externref" });
  const hintValue =
    hint === "default"
      ? builder.emitConst({ kind: "null", ty: externref }, externref)
      : builder.emitCoerceToExternref(builder.emitStringConst("number"));
  const primitive = builder.emitCall(irRuntimeFuncRef("__to_primitive"), [value, hintValue], externref);
  if (primitive === null) {
    // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
    throw new Error("ir/wrapper-construction: __to_primitive produced no value");
  }
  return primitive;
}
