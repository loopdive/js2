// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The two selector arms for an empty object literal `{}`. Each requires the
 * literal to initialize an un-annotated identifier binding and classifies every
 * reference to that binding:
 *
 *   - #4471 INERT: no reference at all. The literal lowers to a zero-field
 *     `object.new`.
 *   - #7128 S1 OPEN CARRIER: every reference is a U1 define or a U2 read (see
 *     `isOpenCarrierUse`). The literal lowers to legacy's open-hash `$Object`
 *     (`__new_plain_object`, raw externref), which a define can extend and a
 *     later `o.k` can read; an IR `object.new` could serve neither.
 */

import { ts } from "../ts-api.js";
import { propertyAccessIsWriteTarget } from "./select-expression-structure.js";

export interface EmptyObjectLiteralBinding {
  readonly decl: ts.VariableDeclaration;
  readonly name: ts.Identifier;
  readonly references: readonly ts.Identifier[];
}

/**
 * The binding an empty literal initializes, with every reference to it in
 * `owner` (its projection owner), or undefined.
 *
 * The binding must be a plain, UN-ANNOTATED identifier. An annotation is
 * disqualifying on its own: `any` / `object` / `{}` each pick a different
 * legacy representation for `{}` (an open `$Object` externref built by
 * `__new_plain_object`, or a struct WIDENED with the fields a later expando
 * write adds — see `compileWidenedEmptyObject` in codegen/literals.ts).
 *
 * #4471 — the INERT arm admits the binding only when it is UNREFERENCED. A
 * fieldless `object.new` is itself fine (measured 2026-08-15: it registers as an
 * ordinary struct, emits, instantiates, and matches legacy); the constraint is
 * downstream. The measured failing uses are property read/write (incl. through
 * an `as any` escape), flow into a `dynamic` (`any`) parameter, `typeof`,
 * array-literal element, conditional-expression test, and a `{}` return
 * TypeNode (which `IrType.object` cannot express at all). The 2026-08-15
 * battery tried to admit a whitelist of "obviously inert" reference forms and
 * every candidate leaked: `if (o)` lowered and matched legacy, but
 * `if (o) {…} else {…}` demoted with "if condition must be bool" — the IR has no
 * `ToBoolean` for a ref — and `o ? a : b` demoted too. Neither truthiness nor an
 * alias (`const p = o`, whose own uses no arm tracks) is safe, so the honest
 * inert rule is zero references.
 *
 * References are matched by TEXT, not by symbol, over the WHOLE owner, nested
 * functions included: a capture by an inner closure, a same-named property key
 * or a shadowing binding all count. That over-approximates, which is the safe
 * direction — it can only refuse to claim.
 */
export function emptyObjectLiteralBinding(
  expr: ts.ObjectLiteralExpression,
  owner: ts.Node | undefined,
): EmptyObjectLiteralBinding | undefined {
  const decl = expr.parent;
  if (owner === undefined || !ts.isVariableDeclaration(decl) || decl.initializer !== expr) return undefined;
  if (decl.type !== undefined || !ts.isIdentifier(decl.name)) return undefined;
  const name = decl.name;
  const references: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      if (node.text === name.text && node !== name) references.push(node);
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(owner, visit);
  return { decl, name, references };
}

/**
 * #7128 S1 — is `reference` an open-carrier use?
 *
 *   - U1: the target of an `Object.defineProperty` STATEMENT (its result would
 *     alias the carrier) with an `openCarrierDefinePlan`;
 *   - U2: a named read `o.k` used as a value. Parentheses, array/object literal
 *     positions and spreads are refused with the write targets, as each can be
 *     a destructuring or assignment target `propertyAccessIsWriteTarget` does
 *     not see. A `+` operand is refused too: the move-only scan admits
 *     `<dynamic> + v`, which from-ast then demotes (the same post-claim gap a
 *     dynamic parameter has).
 *
 * Any other reference — a write, a method call, passing `o` on, an alias — keeps
 * the literal on legacy.
 */
export function isOpenCarrierUse(
  reference: ts.Identifier,
  isAmbientDefineProperty: (call: ts.CallExpression) => boolean,
): boolean {
  const parent = reference.parent;
  if (ts.isCallExpression(parent)) {
    return (
      parent.arguments[0] === reference &&
      ts.isExpressionStatement(parent.parent) &&
      isAmbientDefineProperty(parent) &&
      openCarrierDefinePlan(parent) !== null
    );
  }
  if (!ts.isPropertyAccessExpression(parent) || parent.expression !== reference) return false;
  const consumer = parent.parent;
  return (
    ts.isIdentifier(parent.name) &&
    parent.questionDotToken === undefined &&
    !propertyAccessIsWriteTarget(parent) &&
    !((ts.isCallExpression(consumer) || ts.isNewExpression(consumer)) && consumer.expression === parent) &&
    !ts.isTaggedTemplateExpression(consumer) &&
    !ts.isTypeOfExpression(consumer) &&
    !(ts.isBinaryExpression(consumer) && consumer.operatorToken.kind === ts.SyntaxKind.PlusToken) &&
    !ts.isParenthesizedExpression(consumer) &&
    !ts.isArrayLiteralExpression(consumer) &&
    !ts.isPropertyAssignment(consumer) &&
    !ts.isSpreadElement(consumer)
  );
}

/** The ToPropertyDescriptor fields of a data descriptor (§6.2.5.5). */
const DATA_DESCRIPTOR_FIELDS: ReadonlySet<string> = new Set(["value", "writable", "enumerable", "configurable"]);

/** A U1 define: its static property key and the descriptor fields in source order. */
export interface OpenCarrierDefinePlan {
  readonly key: string;
  readonly fields: readonly { readonly name: string; readonly initializer: ts.Expression }[];
}

/**
 * The U1 plan of `Object.defineProperty(target, key, descriptor)`, or null.
 * The key is a string or numeric literal (the scanner already canonicalised the
 * numeric text, so it is the ToPropertyKey string). The descriptor is an inline
 * literal of distinct data-descriptor fields whose values are number, string
 * or boolean literals: source order is then unobservable, as no getter runs.
 */
export function openCarrierDefinePlan(call: ts.CallExpression): OpenCarrierDefinePlan | null {
  const [, key, descriptor] = call.arguments;
  if (call.arguments.length !== 3 || !(ts.isStringLiteral(key!) || ts.isNumericLiteral(key!))) return null;
  if (!ts.isObjectLiteralExpression(descriptor!)) return null;
  const fields: { name: string; initializer: ts.Expression }[] = [];
  for (const property of descriptor.properties) {
    if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
      return null;
    }
    const name = property.name.text;
    if (!DATA_DESCRIPTOR_FIELDS.has(name) || fields.some((field) => field.name === name)) return null;
    if (!isPrimitiveLiteral(property.initializer)) return null;
    fields.push({ name, initializer: property.initializer });
  }
  return { key: key.text, fields };
}

function isPrimitiveLiteral(expr: ts.Expression): boolean {
  return (
    ts.isNumericLiteral(expr) ||
    ts.isStringLiteral(expr) ||
    expr.kind === ts.SyntaxKind.TrueKeyword ||
    expr.kind === ts.SyntaxKind.FalseKeyword
  );
}
