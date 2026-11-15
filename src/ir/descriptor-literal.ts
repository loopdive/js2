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
import { NOT_COERCIBLE } from "./throw-type-error.js";

/** The ToPropertyDescriptor fields of a data descriptor (§6.2.5.5). */
const DATA_DESCRIPTOR_FIELDS: ReadonlySet<string> = new Set(["value", "writable", "enumerable", "configurable"]);

/** An accessor descriptor's function fields (§6.2.5.5). */
const ACCESSOR_FIELDS: ReadonlySet<string> = new Set(["get", "set"]);

/**
 * The ToPropertyDescriptor fields a descriptor literal may hold, by mode: a data descriptor's only, every value a
 * primitive literal (the JS environment's `Object.create`); or (#7338 S4a) any value of a data field, and `get` /
 * `set` spelled as a primitive, which carries no function value.
 */
export type DescriptorMode = "literal-data" | "no-function";

/** One field of a literal descriptor, in source order. */
export interface DataDescriptorField {
  readonly name: string;
  readonly initializer: ts.Expression;
}

/** One key a define applies, with its inline descriptor's fields in source order. */
export interface DescriptorDefinition {
  /** A literal key's ToPropertyKey string, else the key's own expression. */
  readonly key: string | ts.Expression;
  readonly fields: readonly DataDescriptorField[];
}

/**
 * A define's definitions, and (#7338 S3) the TypeError message when the static throws once every value is
 * evaluated and before it defines anything: ToObject of a nullish map, or ToPropertyDescriptor of one descriptor
 * (§20.1.2.3.1 converts every descriptor before it defines any).
 */
export interface DescriptorDefinitions {
  readonly definitions: readonly DescriptorDefinition[];
  readonly throws: string | undefined;
}

const NOT_AN_OBJECT = "Property description must be an object";

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
function isPrimitiveValue(expr: ts.Expression): boolean {
  const e = stripParens(expr);
  if (isPrimitiveLiteral(e) || e.kind === ts.SyntaxKind.NullKeyword || isUnshadowedUndefined(e)) return true;
  return (
    ts.isPrefixUnaryExpression(e) &&
    (e.operator === ts.SyntaxKind.MinusToken || e.operator === ts.SyntaxKind.PlusToken) &&
    ts.isNumericLiteral(e.operand)
  );
}

/**
 * One descriptor: its fields and the TypeError ToPropertyDescriptor raises for it (§6.2.5.5), else null when the
 * mode does not take it. A primitive descriptor throws; so does a non-`undefined` `get` / `set` (every admitted one
 * is a primitive, never callable) and an accessor half beside `value` / `writable`. A field the mode does not take,
 * a method or a spread is no descriptor here.
 */
function literalDescriptor(
  descriptor: ts.Expression,
  mode: DescriptorMode,
): {
  readonly fields: readonly DataDescriptorField[];
  readonly throws: string | undefined;
} | null {
  if (isPrimitiveValue(descriptor)) return mode === "no-function" ? { fields: [], throws: NOT_AN_OBJECT } : null;
  const fields = staticNamedProperties(descriptor);
  const takes = ({ name, initializer }: DataDescriptorField) =>
    mode === "literal-data"
      ? DATA_DESCRIPTOR_FIELDS.has(name) && isPrimitiveLiteral(initializer)
      : DATA_DESCRIPTOR_FIELDS.has(name) || (ACCESSOR_FIELDS.has(name) && isPrimitiveValue(initializer));
  if (fields === null || !fields.every(takes)) return null;
  const has = (name: string) => fields.some((field) => field.name === name);
  const callableHalf = (name: string) => {
    const half = fields.find((field) => field.name === name);
    return half === undefined || isUnshadowedUndefined(stripParens(half.initializer));
  };
  const throws = !callableHalf("get")
    ? "Getter must be a function"
    : !callableHalf("set")
      ? "Setter must be a function"
      : (has("get") || has("set")) && (has("value") || has("writable"))
        ? "Invalid property descriptor. Cannot both specify accessors and a value or writable attribute"
        : undefined;
  return { fields, throws };
}

/**
 * `Object.defineProperty`'s key and descriptor as one definition, else null.
 * A string or numeric literal key is its text: the scanner has canonicalised
 * the numeric text, so it is the ToPropertyKey string. A descriptor that
 * throws does so only behind a literal key, so no ToPropertyKey runs that the
 * IR would skip (§20.1.2.4 converts the key first).
 */
export function keyedDescriptorDefinition(key: ts.Expression, descriptor: ts.Expression): DescriptorDefinitions | null {
  const literalKey = ts.isStringLiteral(key) || ts.isNumericLiteral(key) ? key.text : undefined;
  const converted = literalDescriptor(descriptor, "no-function");
  if (converted === null || (converted.throws !== undefined && literalKey === undefined)) return null;
  return {
    definitions: [{ key: literalKey ?? key, fields: converted.fields }],
    throws: converted.throws,
  };
}

const CANONICAL_ARRAY_INDEX = /^(?:0|[1-9]\d*)$/;

/**
 * A literal descriptor map's definitions in source order, else null. A
 * canonical array-index key is refused because §20.1.2.3.1 defines in
 * [[OwnPropertyKeys]] order (indices first), and `__proto__` because it sets
 * the map's prototype and defines no key. (#7338 S3) In `no-function` mode a
 * `null` / `undefined` map fails ToObject, and a number or boolean map has no
 * own enumerable keys, so it defines nothing; the static throws when any
 * descriptor does, after every value is evaluated.
 */
export function descriptorMapDefinitions(map: ts.Expression, mode: DescriptorMode): DescriptorDefinitions | null {
  const bare = stripParens(map);
  if (mode === "no-function" && isPrimitiveValue(bare) && !ts.isStringLiteral(bare)) {
    return {
      definitions: [],
      throws: isNullish(bare) ? NOT_COERCIBLE : undefined,
    };
  }
  const entries = staticNamedProperties(map);
  if (entries === null) return null;
  const definitions: DescriptorDefinition[] = [];
  let throws: string | undefined;
  for (const { name: key, initializer } of entries) {
    if (key === "__proto__" || CANONICAL_ARRAY_INDEX.test(key)) return null;
    const converted = literalDescriptor(initializer, mode);
    if (converted === null) return null;
    throws ??= converted.throws;
    definitions.push({ key, fields: converted.fields });
  }
  return { definitions, throws };
}

/** `null` or the global `undefined`. */
function isNullish(expr: ts.Expression): boolean {
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
 * #7128's U1 define: a define that does not throw, every key is a literal and
 * every descriptor a data descriptor whose values are primitive literals, so
 * it installs known keys that hold no callable.
 */
export function definesLiteralsOnly({ definitions, throws }: DescriptorDefinitions): boolean {
  return (
    throws === undefined &&
    definitions.length > 0 &&
    definitions.every(
      ({ key, fields }) =>
        typeof key === "string" &&
        fields.every(({ name, initializer }) => DATA_DESCRIPTOR_FIELDS.has(name) && isPrimitiveLiteral(initializer)),
    )
  );
}
