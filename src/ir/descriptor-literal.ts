// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Inline property-descriptor literals as the IR reads them at compile time:
 * the data descriptor of `Object.defineProperty(o, k, { … })` and the
 * descriptor map of `Object.defineProperties` / `Object.create`. Shared by the
 * `Object` statics table (`object-statics.ts`), the JS environment's
 * `Object.create` (`object-create-call.ts`) and #7128's open-carrier define.
 */

import { ts } from "../ts-api.js";

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
