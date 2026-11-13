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
import { sourceRunsDynamicCode, sourceWritesMemberNamed } from "../shared/intrinsic-prototype-writes.js";
import { ts } from "../ts-api.js";
import { type OperandFamily, wrapperArgumentAdmissible } from "./analysis/operand-admissibility.js";
import type { IrFunctionBuilder } from "./builder.js";
import { irRuntimeFuncRef } from "./callable-bindings.js";
import { irDynamic, irVal, type IrType, type IrValueId } from "./nodes.js";
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

/** The construction's argument, when `wrapperArgumentAdmissible` admits it under the selector's `familyOf`. */
export function admissibleArgument(
  construction: WrapperConstruction | undefined,
  familyOf: (argument: ts.Expression) => OperandFamily,
): ts.Expression | undefined {
  const argument = construction?.argument;
  return argument !== undefined && wrapperArgumentAdmissible(construction!.row.family, familyOf(argument))
    ? argument
    : undefined;
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
type WrapperStoreLane = Pick<IrSelectionOptions, "dynamicHomeCarrierLane" | "supportsBackendCapability"> | undefined;

/** The selector's module-binding resolver: the store target's slot kind, and the constructor's lib-only identity. */
interface WrapperStoreResolver {
  (node: ts.Identifier): { readonly valueKind: { readonly kind: string } } | undefined;
  isLibOnlyBinding(node: ts.Identifier): boolean;
}

/**
 * The selector's refusal of a store-position construction, or `undefined` to
 * admit it; `argumentFamily` is the selector's proven family of the argument.
 * The argument itself still has to be a Phase-1 expression. Asks, in order:
 * the lane (#7280's dynamic-home carrier arms run there — a
 * String wrapper in a carrier is read through the native member read, which
 * WASI lacks, #7177), the store target's slot, the constructor's identity,
 * the argument rule, and every use of the stored-to name.
 */
export function wrapperStoreRefusal(
  stored: StoredWrapper,
  lane: WrapperStoreLane,
  resolver: WrapperStoreResolver | null,
  argumentFamily: (argument: ts.Expression) => OperandFamily,
): string | undefined {
  const supports = lane?.supportsBackendCapability;
  if (
    lane?.dynamicHomeCarrierLane !== true ||
    supports?.("primitive-wrapper-to-primitive") !== true ||
    supports?.("native-dynamic-member-read") !== true
  ) {
    return "expr-new-wrapper-lane";
  }
  if (resolver === null || resolver(stored.target)?.valueKind.kind !== "dynamic") return "expr-new-wrapper-home";
  const callee = stored.expr.expression as ts.Identifier;
  if (!realmConstructorUnrebound(callee, (node) => resolver.isLibOnlyBinding(node))) return "expr-new-wrapper-realm";
  if (admissibleArgument(stored, argumentFamily) === undefined) return "expr-new-wrapper-argument";
  return everyUseIsServed(stored.target) ? undefined : "expr-new-wrapper-use";
}

/**
 * The constructor is the realm's, in every way the program could rebind it:
 * only lib declarations and none in the file (a script's `function String`,
 * a parameter), never written (`String = f`, `this.String = f`), and no
 * `eval`, `Function` or `with` that could do either unseen.
 */
function realmConstructorUnrebound(callee: ts.Identifier, isLibOnlyBinding: (node: ts.Identifier) => boolean): boolean {
  const file = callee.getSourceFile();
  return (
    isUnshadowedLibBinding(callee, isLibOnlyBinding) &&
    !sourceWritesMemberNamed(file, callee.text) &&
    !sourceRunsDynamicCode(file) &&
    !hasDynamicScope(file)
  );
}

/**
 * Every reference to the stored-to name, anywhere in the file, is a use the
 * dynamic arms answer correctly for a wrapper (measured against node,
 * `tests/issue-7340.test.ts`). Name-based: a same-named binding elsewhere is
 * judged too, which can only refuse more.
 */
function everyUseIsServed(target: ts.Identifier): boolean {
  let served = true;
  const visit = (node: ts.Node): void => {
    if (!served) return;
    if (ts.isIdentifier(node)) {
      if (node.text === target.text && !isNameNotReference(node)) served = isServedUse(node);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(target.getSourceFile());
  return served;
}

/** A property name or a declaration's own name: not a read of the binding. */
function isNameNotReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isVariableDeclaration(parent) && parent.name === node)
  );
}

/**
 * One reference, judged on its outermost parenthesized form. Served: a store
 * into the name; an operand of a binary operator other than a loose
 * comparison with `null`; an operand of a prefix operator or `typeof`; a
 * condition; the receiver of a named member read that is not called and whose
 * value is not stored into a binding. Not served — each either answers wrong,
 * or is claimed and then withdrawn, or hands the object to code no scan sees
 * (measured, `tests/issue-7340.test.ts`): an element read (`s[0]` of a String
 * wrapper answers wrong), `void`, a loose `== null`, a `switch` discriminant,
 * an alias, a call argument, a return value, a literal element, a template
 * substitution, and a `for…in` / `in` / `instanceof` / `delete` operand.
 */
function isServedUse(reference: ts.Identifier): boolean {
  const use = outermostParenthesized(reference);
  const parent = use.parent;
  if (isStoreTarget(use)) return true;
  if (ts.isBinaryExpression(parent))
    return SERVED_BINARY_OPERATORS.has(parent.operatorToken.kind) && !isLooseNullTest(parent);
  if (ts.isPrefixUnaryExpression(parent)) return true;
  if (ts.isTypeOfExpression(parent)) return true;
  if (isConditionOf(use, parent)) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === use) return isServedMemberRead(parent);
  return false;
}

const SERVED_BINARY_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
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

/** A member read of the wrapper that is not a call's callee, a `delete` operand, or a binding's stored value. */
function isServedMemberRead(member: ts.PropertyAccessExpression): boolean {
  const node = outermostParenthesized(member);
  const consumer = node.parent;
  if (ts.isCallExpression(consumer) && consumer.expression === node) return false;
  if (ts.isTaggedTemplateExpression(consumer) || ts.isDeleteExpression(consumer)) return false;
  if (isStoreTarget(node)) return true;
  if (ts.isVariableDeclaration(consumer) && consumer.initializer === node) return false;
  return !(
    ts.isBinaryExpression(consumer) &&
    consumer.right === node &&
    consumer.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    consumer.operatorToken.kind <= ts.SyntaxKind.LastAssignment
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
