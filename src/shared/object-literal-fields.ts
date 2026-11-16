// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Object-literal property lists as both front-ends read them at compile time:
 * the static-name reader the IR's descriptor literals use
 * (`ir/descriptor-literal.ts`), and (#7352 O1) the data-only literal that legacy
 * and the IR both build as the open `$Object`.
 */

import { stripParens } from "./binding-writes.js";
import { ts } from "../ts-api.js";

/** A canonical array-index property key (§6.1.7): `0`, `1`, … without a sign or leading zero. */
export const CANONICAL_ARRAY_INDEX = /^(?:0|[1-9]\d*)$/;

/** One field of a literal descriptor, in source order. */
export interface DataDescriptorField {
  readonly name: string;
  readonly initializer: ts.Expression;
}

/**
 * The properties of an object literal whose every member is a
 * `name: initializer` assignment with a distinct identifier or string-literal
 * name, in source order; else null.
 */
export function staticNamedProperties(literal: ts.Expression): readonly DataDescriptorField[] | null {
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
 * (#7352 O1) A data-only object literal's properties in source order, else null: distinct identifier or
 * string-literal names, none a canonical array index (an open object enumerates indices first, §10.1.11.1)
 * nor `__proto__` (which sets the prototype), nor `toString` / `valueOf` (the conversions read them: O4's
 * `{ toString / valueOf }` objects), and no value a function, class, object or array literal (later slices).
 * Legacy and the IR both build such a literal as the open `$Object`, one put per property.
 */
const CONVERSION_OR_PROTO_KEYS: ReadonlySet<string> = new Set(["__proto__", "toString", "valueOf"]);

export function openObjectLiteralFields(literal: ts.Expression): readonly DataDescriptorField[] | null {
  const fields = staticNamedProperties(literal);
  const plain = (field: DataDescriptorField) => {
    const value = stripParens(field.initializer);
    return (
      !CONVERSION_OR_PROTO_KEYS.has(field.name) &&
      !CANONICAL_ARRAY_INDEX.test(field.name) &&
      !ts.isFunctionLike(value) &&
      !ts.isClassExpression(value) &&
      !ts.isObjectLiteralExpression(value) &&
      !ts.isArrayLiteralExpression(value)
    );
  };
  return fields !== null && fields.length > 0 && fields.every(plain) ? fields : null;
}
