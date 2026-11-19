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
import { sourceMayPatchPrototype, sourceMayWriteBindingUnseen } from "../shared/intrinsic-prototype-writes.js";
import { ts } from "../ts-api.js";
import type { OperandFamily } from "./analysis/operand-admissibility.js";
import type { IrFunctionBuilder } from "./builder.js";
import { irRuntimeFuncRef } from "./callable-bindings.js";
import { isServedUse, referencesNamed, type ServedUsePolicy } from "./dynamic-home-uses.js";
import { JS_TAG_IDS } from "./js-tag-domain.js";
import { IrInvariantError } from "./outcomes.js";
import { irBool } from "./boolean-brand.js";
import { irDynamic, irVal, type IrType, type IrValueId } from "./nodes.js";
import { carrierStringFamily, lowerPrimitiveToString } from "./primitive-to-string.js";
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

/**
 * (#7340 S2) The argument families a row converts to its own: ToString of a number or a boolean
 * (§7.1.17), ToNumber of a string (§7.1.4). `Number(boolean)` and `Boolean(<other family>)` are sound
 * too but left out: no blocked ES5 file constructs them, and each needs a conversion lowering of its own.
 */
const CONVERTED_FAMILIES: Readonly<Record<WrapperRow["family"], readonly OperandFamily[]>> = {
  string: ["number", "boolean"],
  number: ["string"],
  boolean: [],
};

/** An ambient wrapper construction; (#7341 S2) `new Object(v)` with an argument is one too. */
export interface WrapperConstruction {
  readonly expr: ts.NewExpression;
  /** The constructor's row; `undefined` for `Object`, whose argument's family picks it ({@link constructedRow}). */
  readonly row: WrapperRow | undefined;
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
  const args = expr.arguments ?? [];
  // `new Object()` is the empty object (#7341 S1); with an argument it is ToObject's wrapper.
  const toObject = expr.expression.text === "Object" && args.length > 0 && ambience.isAmbient(expr.expression);
  const row = ambientWrapperRow(expr.expression, ambience);
  if (row === undefined && !toObject) return undefined;
  const single = args.length === 1 && !ts.isSpreadElement(args[0]!) ? args[0] : undefined;
  return { expr, row, argument: single };
}

/**
 * The construction's argument, when the selector's `familyOf` proves it the row's own family. `new
 * Object(v)` has no row of its own: only a store picks one ({@link constructedRow}), so it has none here.
 */
export function admissibleArgument(
  construction: WrapperConstruction | undefined,
  familyOf: (argument: ts.Expression) => OperandFamily,
): ts.Expression | undefined {
  const row = construction?.row;
  const argument = construction?.argument;
  if (row === undefined || argument === undefined) return undefined;
  return familyOf(argument) === row.family ? argument : undefined;
}

/**
 * (#7340 S2, #7341 S2) The row a stored construction builds, or `undefined` to refuse it: no argument
 * (the row's own empty value), or one argument of the row's family or of a family the row converts
 * ({@link CONVERTED_FAMILIES}). For `new Object(v)` the argument's primitive family picks the row
 * (ToObject, §9.9). `null`, `undefined` and an object are refused: the IR has no dynamic `null`, and an
 * object's ToPrimitive would run user code.
 */
export function constructedRow(
  construction: WrapperConstruction,
  familyOf: (argument: ts.Expression) => OperandFamily,
): WrapperRow | undefined {
  if ((construction.expr.arguments ?? []).length === 0) return construction.row;
  if (construction.argument === undefined) return undefined;
  const family = familyOf(construction.argument);
  const row = construction.row ?? ROWS.find((candidate) => candidate.family === family);
  return row && (row.family === family || CONVERTED_FAMILIES[row.family].includes(family)) ? row : undefined;
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
  const row = constructedRow(stored, argumentFamily);
  if (!realmIsUnpatched(stored, row, (node) => resolver.isLibOnlyBinding(node))) return "expr-new-wrapper-realm";
  if (row === undefined) return "expr-new-wrapper-argument";
  return everyUseIsServed(stored, row) ? undefined : "expr-new-wrapper-use";
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
function realmIsUnpatched(
  stored: StoredWrapper,
  row: WrapperRow | undefined,
  isLibOnlyBinding: (node: ts.Identifier) => boolean,
): boolean {
  const callee = stored.expr.expression as ts.Identifier;
  const file = callee.getSourceFile();
  return (
    isUnshadowedLibBinding(callee, isLibOnlyBinding) &&
    !sourceMayWriteBindingUnseen(file, callee.text) &&
    (row === undefined || !sourceMayPatchPrototype(file, row.name)) &&
    !sourceMayPatchPrototype(file, "Object") &&
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
function everyUseIsServed(stored: StoredWrapper, row: WrapperRow): boolean {
  const policy = wrapperPolicy(row);
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
function wrapperPolicy(row: WrapperRow): ServedUsePolicy {
  const numericRelational = row.family !== "string";
  return {
    unreadableKeys: OBJECT_PROTOTYPE_KEYS,
    servesMemberCall: () => false,
    servesMemberRead: () => false,
    servesReference: (use) => {
      const parent = use.parent;
      if (isStoreTarget(use)) return true;
      if (ts.isBinaryExpression(parent)) {
        const op = parent.operatorToken.kind;
        if (RELATIONAL_OPERATORS.has(op)) return numericRelational && againstNumericLiteral(use, parent);
        return SERVED_BINARY_OPERATORS.has(op) && !isLooseNullTest(parent) && !isSumReceiver(parent);
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

/**
 * `(w + "").length`: a `+` over the wrapper is the dynamic carrier's `+`, so a member or element read of the
 * sum is a dynamic read, which a binding the checker types from that read (`.length` as a number) does not
 * take: the claim would be withdrawn.
 */
function isSumReceiver(binary: ts.BinaryExpression): boolean {
  if (binary.operatorToken.kind !== ts.SyntaxKind.PlusToken) return false;
  let sum: ts.Expression = outermostParenthesized(binary);
  while (ts.isBinaryExpression(sum.parent) && sum.parent.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    sum = outermostParenthesized(sum.parent);
  }
  const access = sum.parent;
  return (ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access)) && access.expression === sum;
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

/**
 * `new <row>(admitted)` through the row's native constructor; the result is `extern:Object`. `admitted`
 * is the lowered argument, of a family {@link constructedRow} admits and converted here; `undefined`
 * builds the row's empty value.
 */
export function emitWrapperConstruction(
  builder: IrFunctionBuilder,
  row: WrapperRow,
  admitted: IrValueId | undefined,
): IrValueId {
  const argument = rowPrimitive(builder, row, admitted);
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
    throw new IrInvariantError(
      "unknown-function-ref",
      "build",
      `ir/wrapper-construction: __new_${row.name} produced no value`,
    );
  }
  return value;
}

/** The row's own primitive: `""`, `+0` or `false` for no argument; else the argument, converted. */
function rowPrimitive(builder: IrFunctionBuilder, row: WrapperRow, argument: IrValueId | undefined): IrValueId {
  if (argument === undefined) {
    if (row.family === "string") return builder.emitStringConst("");
    if (row.family === "number") return builder.emitConst({ kind: "f64", value: 0 }, irVal({ kind: "f64" }));
    return builder.emitConst({ kind: "bool", value: false }, irBool());
  }
  const type = builder.typeOf(argument);
  if (row.family === "string" && type.kind !== "string") {
    const string = lowerPrimitiveToString(builder, argument, carrierStringFamily(type));
    // invariant: the selector admits only a number or a boolean here (`constructedRow`), and from-ast checks it.
    if (string === null) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "build",
        "ir/wrapper-construction: no ToString for the String argument",
      );
    }
    return string;
  }
  if (row.family === "number" && type.kind === "string") {
    return builder.emitDynToNumber(builder.emitBox(argument, irDynamic(JS_TAG_IDS.String)));
  }
  return argument;
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
    throw new IrInvariantError(
      "unknown-function-ref",
      "build",
      "ir/wrapper-construction: __to_primitive produced no value",
    );
  }
  return primitive;
}
