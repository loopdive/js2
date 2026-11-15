// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Inline property-descriptor literals as the IR reads them at compile time:
 * the data descriptor of `Object.defineProperty(o, k, { … })` and the
 * descriptor map of `Object.defineProperties` / `Object.create`. Shared by the
 * `Object` statics table (`object-statics.ts`), the JS environment's
 * `Object.create` (`object-create-call.ts`) and #7128's open-carrier define.
 */

import { isUnshadowedUndefined } from "../shared/ambient-intrinsics.js";
import { stripParens } from "../shared/binding-writes.js";
import { ts } from "../ts-api.js";

/** The ToPropertyDescriptor fields of a data descriptor (§6.2.5.5). */
const DATA_DESCRIPTOR_FIELDS: ReadonlySet<string> = new Set(["value", "writable", "enumerable", "configurable"]);

/** An accessor descriptor's function fields (§6.2.5.5). */
const ACCESSOR_FIELDS: ReadonlySet<string> = new Set(["get", "set"]);

/**
 * The fields a descriptor literal may hold: a data descriptor's only (the JS
 * environment's `Object.create`), or also `get` / `set` that carry no function
 * value (#7338 S4a, {@link carriesNoFunction}).
 */
export type DescriptorFieldSet = "data" | "no-function";

/** One field of a literal data descriptor, in source order. */
export interface DataDescriptorField {
  readonly name: string;
  readonly initializer: ts.Expression;
}

/** One key a define applies, with its inline descriptor's fields in source order. */
export interface DescriptorDefinition {
  /** A literal key's ToPropertyKey string, else the key's own expression. */
  readonly key: string | ts.Expression;
  /** (#7338 S3) null for a primitive descriptor, which ToPropertyDescriptor throws for. */
  readonly fields: readonly DataDescriptorField[] | null;
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
 * A value that is a primitive by its spelling: a number (signed or not),
 * string or boolean literal, `null`, or the global `undefined`. Neither an
 * object nor callable, so ToPropertyDescriptor of it throws (§6.2.5.5 step 1)
 * and, as a `get` / `set`, it is undefined or not callable.
 */
export function isPrimitiveValue(expr: ts.Expression): boolean {
  const e = stripParens(expr);
  if (isPrimitiveLiteral(e) || e.kind === ts.SyntaxKind.NullKeyword || isUnshadowedUndefined(e)) return true;
  return (
    ts.isPrefixUnaryExpression(e) &&
    (e.operator === ts.SyntaxKind.MinusToken || e.operator === ts.SyntaxKind.PlusToken) &&
    ts.isNumericLiteral(e.operand)
  );
}

/**
 * (#7338 S4a) A `get` / `set` value that is no function by its spelling: a
 * primitive ({@link isPrimitiveValue}), an array literal or an object literal.
 * ToPropertyDescriptor reads `undefined` as an empty half and throws for the
 * rest; neither needs a function value. A name, a call or a function
 * expression may be callable and stays refused.
 */
function carriesNoFunction(value: ts.Expression): boolean {
  const e = stripParens(value);
  return isPrimitiveValue(e) || ts.isArrayLiteralExpression(e) || ts.isObjectLiteralExpression(e);
}

/**
 * An inline descriptor's fields in source order, every value admitted by
 * `admitsValue`; else null: a field `fieldSet` does not take, a method or a
 * spread.
 */
function descriptorFields(
  descriptor: ts.Expression,
  admitsValue: (value: ts.Expression) => boolean,
  fieldSet: DescriptorFieldSet,
): readonly DataDescriptorField[] | null {
  const fields = staticNamedProperties(descriptor);
  const takes = ({ name, initializer }: DataDescriptorField) =>
    DATA_DESCRIPTOR_FIELDS.has(name) ||
    (fieldSet === "no-function" && ACCESSOR_FIELDS.has(name) && carriesNoFunction(initializer));
  const admitted = fields?.every((field) => takes(field) && admitsValue(field.initializer));
  return admitted === true ? fields : null;
}

/**
 * `Object.defineProperty`'s key and descriptor as one definition, else null.
 * A string or numeric literal key is its text: the scanner has canonicalised
 * the numeric text, so it is the ToPropertyKey string. (#7338 S3) A primitive
 * descriptor is a definition without fields: ToPropertyDescriptor throws.
 */
export function keyedDescriptorDefinition(key: ts.Expression, descriptor: ts.Expression): DescriptorDefinition | null {
  const fields = isPrimitiveValue(descriptor) ? null : descriptorFields(descriptor, () => true, "no-function");
  if (fields === null && !isPrimitiveValue(descriptor)) return null;
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
 * key. (#7338 S3) With `no-function` fields, a primitive entry is a definition
 * without fields (ToPropertyDescriptor throws), and a number or boolean map
 * has no own enumerable keys, so it defines nothing. A `null` / `undefined`
 * map is the caller's question (ToObject throws; `Object.create` reads
 * `undefined` as no map) and is no literal map here.
 */
export function descriptorMapDefinitions(
  map: ts.Expression,
  admitsValue: (value: ts.Expression) => boolean,
  fieldSet: DescriptorFieldSet,
): readonly DescriptorDefinition[] | null {
  const bare = stripParens(map);
  if (fieldSet === "no-function" && isPrimitiveValue(bare) && !ts.isStringLiteral(bare) && !isNullish(bare)) return [];
  const entries = staticNamedProperties(map);
  if (entries === null) return null;
  const definitions: DescriptorDefinition[] = [];
  for (const { name: key, initializer } of entries) {
    if (key === "__proto__" || CANONICAL_ARRAY_INDEX.test(key)) return null;
    const primitive = fieldSet === "no-function" && isPrimitiveValue(initializer);
    const fields = primitive ? null : descriptorFields(initializer, admitsValue, fieldSet);
    if (fields === null && !primitive) return null;
    definitions.push({ key, fields });
  }
  return definitions;
}

/** `null` or the global `undefined`. */
export function isNullish(expr: ts.Expression): boolean {
  const e = stripParens(expr);
  return e.kind === ts.SyntaxKind.NullKeyword || isUnshadowedUndefined(e);
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
 * #7128's U1 define: every key is a literal and every descriptor a data
 * descriptor whose values are primitive literals, so it installs known keys
 * that hold no callable.
 */
export function definesLiteralsOnly(definitions: readonly DescriptorDefinition[]): boolean {
  return (
    definitions.length > 0 &&
    definitions.every(
      ({ key, fields }) =>
        typeof key === "string" &&
        fields !== null &&
        fields.every(({ name, initializer }) => DATA_DESCRIPTOR_FIELDS.has(name) && isPrimitiveLiteral(initializer)),
    )
  );
}
