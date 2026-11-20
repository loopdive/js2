// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O4) The string-keyed properties the specification (ES2025, Annex B included) gives the built-in prototypes a
 * member read can reach without an own property: Object.prototype for every object and primitive, and each
 * primitive's wrapper prototype. A read of a key outside these, off a value whose prototypes no program code can
 * change, answers the object's own property or `undefined`. The realm's prototypes do not hold these properties yet,
 * so a read of one of them refuses by name.
 *
 * (#7354 M1, C3) Object.prototype's keys are the realm catalog's (`OBJECT_PROTOTYPE_KEYS`); the wrapper prototypes
 * are not in the catalog yet, so their keys are listed here from the specification.
 */
import { OBJECT_PROTOTYPE_KEYS } from "../realm-keys.js";

const NUMBER_PROTOTYPE = ["toExponential", "toFixed", "toPrecision"];
const STRING_PROTOTYPE = [
  "at",
  "charAt",
  "charCodeAt",
  "codePointAt",
  "concat",
  "endsWith",
  "includes",
  "indexOf",
  "isWellFormed",
  "lastIndexOf",
  "localeCompare",
  "match",
  "matchAll",
  "normalize",
  "padEnd",
  "padStart",
  "repeat",
  "replace",
  "replaceAll",
  "search",
  "slice",
  "split",
  "startsWith",
  "substring",
  "toLocaleLowerCase",
  "toLocaleUpperCase",
  "toLowerCase",
  "toUpperCase",
  "toWellFormed",
  "trim",
  "trimEnd",
  "trimStart",
  "substr",
  "anchor",
  "big",
  "blink",
  "bold",
  "fixed",
  "fontcolor",
  "fontsize",
  "italics",
  "link",
  "small",
  "strike",
  "sub",
  "sup",
  "trimLeft",
  "trimRight",
];

/** The keys a read of each value reaches through built-in prototypes (or, for a string, its own exotic keys). */
export const BUILTIN_REACHABLE_KEYS = {
  object: OBJECT_PROTOTYPE_KEYS,
  number: new Set([...OBJECT_PROTOTYPE_KEYS, ...NUMBER_PROTOTYPE]),
  boolean: OBJECT_PROTOTYPE_KEYS,
  string: new Set([...OBJECT_PROTOTYPE_KEYS, ...STRING_PROTOTYPE, "length"]),
} as const satisfies Readonly<Record<string, ReadonlySet<string>>>;

/** A canonical array index (§6.1.7): a string's own indexed character. */
export function isArrayIndexKey(key: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < 2 ** 32 - 1;
}
