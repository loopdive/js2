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
import { OBJECT_PROTOTYPE_KEYS } from "./realm-keys.js";

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
 *     alias the carrier) that `isLiteralDefine` says the lane lowers with
 *     literal keys and descriptors ({@link definesLiteralsOnly});
 *   - U2: a named read `o.k` whose key `Object.prototype` does not own and
 *     whose consumer is `isProvenReadConsumer`'s strict comparison. The IR reader
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
  isLiteralDefine: (call: ts.CallExpression) => boolean,
): boolean {
  const parent = reference.parent;
  if (ts.isCallExpression(parent)) {
    return parent.arguments[0] === reference && ts.isExpressionStatement(parent.parent) && isLiteralDefine(parent);
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

/**
 * The one consumer a U2 read `o.k` is proven for — consumed DIRECTLY, never
 * passed on: one side of a strict `===`/`!==` whose other side is a primitive
 * literal, `null` or the global `undefined`. Everything else stays on legacy, which is
 * correct by construction:
 *   - an alias (`var y = o.k`, `y = o.k`, `return`, `throw`) hands the value to
 *     the dynamic-value scan, whose own gaps (`y.z` must throw on undefined,
 *     `y?.z`) then miscompile;
 *   - arithmetic, relational and loose-equality operands demote after the claim
 *     for some operand kinds (`o.k - "2"`, `o.k == null`), as does `+` — an
 *     untracked gap that predates S1, named in
 *     plan/issues/7128-ir-standalone-define-property-open-object-carrier.md
 *     ("Corrections to the design", item 5);
 *   - ToBoolean, member, element and non-null consumers.
 * Three review rounds on PR #6957 each found a new failing shape in a wider
 * rule; this one is the set they proved exact.
 */
function isProvenReadConsumer(read: ts.PropertyAccessExpression): boolean {
  const consumer = read.parent;
  if (!ts.isBinaryExpression(consumer)) return false;
  const op = consumer.operatorToken.kind;
  if (op !== ts.SyntaxKind.EqualsEqualsEqualsToken && op !== ts.SyntaxKind.ExclamationEqualsEqualsToken) return false;
  const other = consumer.left === read ? consumer.right : consumer.left;
  return (
    isPrimitiveLiteral(other) ||
    other.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(other) && other.text === "undefined" && !declaresUndefined(read.getSourceFile()))
  );
}

/**
 * Is `undefined` possibly a source binding anywhere in `file`? Against a
 * shadowing `var undefined = {}` the comparison is not with the carrier's
 * undefined, and the lowering demotes after the claim. Matched by syntax: an
 * `undefined` identifier in any `name` slot counts, a property name included,
 * which can only refuse.
 */
function declaresUndefined(file: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node)) {
      if (node.text === "undefined" && (node.parent as { readonly name?: ts.Node }).name === node) found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** The ToPropertyDescriptor fields of a data descriptor (§6.2.5.5). */
const DATA_DESCRIPTOR_FIELDS: ReadonlySet<string> = new Set(["value", "writable", "enumerable", "configurable"]);

/** One field of a literal data descriptor, in source order. */
export interface DataDescriptorField {
  readonly name: string;
  readonly initializer: ts.Expression;
}

/** One key a define applies, with its inline data descriptor's fields in source order. */
export interface DescriptorDefinition {
  /** A literal key's ToPropertyKey string, else the key's own expression. */
  readonly key: string | ts.Expression;
  readonly fields: readonly DataDescriptorField[];
}

/**
 * The properties of an object literal whose every member is a
 * `name: initializer` assignment with a distinct identifier or string-literal
 * name, in source order; else null.
 */
function staticNamedProperties(literal: ts.Expression): readonly DataDescriptorField[] | null {
  if (!ts.isObjectLiteralExpression(literal)) return null;
  const properties: DataDescriptorField[] = [];
  for (const property of literal.properties) {
    if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
      return null;
    }
    const name = property.name.text;
    if (properties.some((field) => field.name === name)) return null;
    properties.push({ name, initializer: property.initializer });
  }
  return properties;
}

/**
 * An inline data descriptor's fields in source order, every value admitted by
 * `admitsValue`; else null: an accessor (`get` / `set`), a field no
 * descriptor has, a method or a spread.
 */
function dataDescriptorFields(
  descriptor: ts.Expression,
  admitsValue: (value: ts.Expression) => boolean,
): readonly DataDescriptorField[] | null {
  const fields = staticNamedProperties(descriptor);
  const admitted = fields?.every(
    ({ name, initializer }) => DATA_DESCRIPTOR_FIELDS.has(name) && admitsValue(initializer),
  );
  return admitted === true ? fields : null;
}

/**
 * `Object.defineProperty`'s key and descriptor as one definition, else null.
 * A string or numeric literal key is its text: the scanner has canonicalised
 * the numeric text, so it is the ToPropertyKey string.
 */
export function keyedDescriptorDefinition(key: ts.Expression, descriptor: ts.Expression): DescriptorDefinition | null {
  const fields = dataDescriptorFields(descriptor, () => true);
  if (fields === null) return null;
  return {
    key: ts.isStringLiteral(key) || ts.isNumericLiteral(key) ? key.text : key,
    fields,
  };
}

const CANONICAL_ARRAY_INDEX = /^(?:0|[1-9]\d*)$/;

/**
 * A literal descriptor map's definitions in source order, every value
 * admitted by `admitsValue`; else null. A canonical array-index key is
 * refused because §20.1.2.3.1 defines in [[OwnPropertyKeys]] order (indices
 * first), and `__proto__` because it sets the map's prototype and defines no
 * key.
 */
export function descriptorMapDefinitions(
  map: ts.Expression,
  admitsValue: (value: ts.Expression) => boolean,
): readonly DescriptorDefinition[] | null {
  const entries = staticNamedProperties(map);
  if (entries === null) return null;
  const definitions: DescriptorDefinition[] = [];
  for (const { name: key, initializer } of entries) {
    if (key === "__proto__" || CANONICAL_ARRAY_INDEX.test(key)) return null;
    const fields = dataDescriptorFields(initializer, admitsValue);
    if (fields === null) return null;
    definitions.push({ key, fields });
  }
  return definitions;
}

/** A number, string or boolean literal. */
export function isPrimitiveLiteral(expr: ts.Expression): boolean {
  return (
    ts.isNumericLiteral(expr) ||
    ts.isStringLiteral(expr) ||
    expr.kind === ts.SyntaxKind.TrueKeyword ||
    expr.kind === ts.SyntaxKind.FalseKeyword
  );
}

/**
 * #7128's U1 define: every key is a literal and every descriptor value a
 * primitive literal, so it installs known keys that hold no callable.
 */
export function definesLiteralsOnly(definitions: readonly DescriptorDefinition[]): boolean {
  return (
    definitions.length > 0 &&
    definitions.every(
      ({ key, fields }) =>
        typeof key === "string" && fields.every(({ initializer }) => isPrimitiveLiteral(initializer)),
    )
  );
}

const inKeysByUnit = new WeakMap<ts.Node, boolean>();

/**
 * Every `in` under the enclosing unit of `expr` (its function, or the source
 * file for `<module-init>`), nested functions included, has a string-literal
 * key that `%Object.prototype%` does not own: an own-key probe, which the
 * native `in` answers for a fresh open `$Object` exactly as legacy does. The
 * IR's native `in` (`__extern_has`) does not reach that object's implicit
 * `%Object.prototype%` terminal, while legacy's fixed-name helper answers it
 * for exactly the receivers it knows to be one (#7142 review). Read wherever
 * the IR builds such an object: the #7280 carrier, `Object.create`'s result.
 */
export function unitInKeysAreOwnOnly(expr: ts.Node): boolean {
  let unit: ts.Node = expr.getSourceFile();
  for (let node: ts.Node | undefined = expr.parent; node; node = node.parent) {
    if (ts.isFunctionLike(node)) {
      unit = node;
      break;
    }
  }
  let answer = inKeysByUnit.get(unit);
  if (answer === undefined) {
    answer = true;
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.InKeyword &&
        !(ts.isStringLiteral(node.left) && !OBJECT_PROTOTYPE_KEYS.has(node.left.text))
      ) {
        answer = false;
      }
      if (answer) ts.forEachChild(node, visit);
    };
    ts.forEachChild(unit, visit);
    inKeysByUnit.set(unit, answer);
  }
  return answer;
}
