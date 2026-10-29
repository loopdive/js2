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

import { NATIVE_REALM_CATALOG } from "../runtime/contracts/native-realm-catalog.js";
import { ts } from "../ts-api.js";

export interface EmptyObjectLiteralBinding {
  readonly literal: ts.ObjectLiteralExpression;
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
  return { literal: expr, decl, name, references };
}

/**
 * #7128 S1 — is `reference` an open-carrier use?
 *
 *   - U1: the target of an `Object.defineProperty` STATEMENT (its result would
 *     alias the carrier) with an `openCarrierDefinePlan`;
 *   - U2: a named read `o.k` whose key `Object.prototype` does not own and
 *     whose consumer is in `isProvenReadConsumer`. The IR reader
 *     (`__dyn_member_get`) answers undefined for an inherited key, where legacy
 *     and node see the `Object.prototype` method.
 *
 * Any other reference — a write, a method call, passing `o` on, an alias — keeps
 * the literal on legacy. This test is per reference and owner-blind: a read
 * inside a nested function passes it, and the capture is refused instead by the
 * selector's free-variable scope check.
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
  return (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === reference &&
    parent.questionDotToken === undefined &&
    ts.isIdentifier(parent.name) &&
    !OBJECT_PROTOTYPE_KEYS.has(parent.name.text) &&
    isProvenReadConsumer(parent)
  );
}

/** The string keys `Object.prototype` owns (§20.1.3, Annex B.2.2 included). */
const OBJECT_PROTOTYPE_KEYS: ReadonlySet<string> = new Set(
  NATIVE_REALM_CATALOG.intrinsics
    .find((intrinsic) => intrinsic.id === "%Object.prototype%")!
    .properties.flatMap((property) => (property.key.kind === "string" ? [property.key.value] : [])),
);

/** Binary operators whose operand the U2 read is measured for: equality, relational, `- * / %`. */
const PROVEN_READ_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
]);

/**
 * An ALLOW-list of the consumers a U2 read `o.k` is proven for: a
 * `PROVEN_READ_OPERATORS` operand, an identifier binding's initializer, a
 * `return` or a `throw`. Everything else is refused by default, the ToBoolean
 * consumers (`if`, `?:`, `!`, `&&`) and member, element and non-null
 * consumers (`o.k.y` must throw on undefined; `o.k?.y` throws under the IR)
 * among them. `+` is absent because the move-only scan admits `<dynamic> + v`
 * and from-ast then demotes it — an untracked gap that predates S1, named in
 * plan/issues/7128-ir-standalone-define-property-open-object-carrier.md
 * ("Corrections to the design", item 5).
 */
function isProvenReadConsumer(read: ts.PropertyAccessExpression): boolean {
  const consumer = read.parent;
  if (ts.isBinaryExpression(consumer)) return PROVEN_READ_OPERATORS.has(consumer.operatorToken.kind);
  if (ts.isVariableDeclaration(consumer)) return consumer.initializer === read && ts.isIdentifier(consumer.name);
  return ts.isReturnStatement(consumer) || ts.isThrowStatement(consumer);
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
