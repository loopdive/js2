// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O4) The string-keyed properties the specification (ES2025, Annex B included) gives the built-in prototypes a
 * member read can reach without an own property: Object.prototype for every object and primitive, each primitive's
 * wrapper prototype and (#7354 C) Function.prototype for a function. A read of a key outside these, off a value whose
 * prototypes no program code can change, answers the object's own property or `undefined`. The realm's prototypes do not hold these properties yet,
 * so a read of one of them refuses by name.
 */
const OBJECT_PROTOTYPE = [
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
];
const NUMBER_PROTOTYPE = ["toExponential", "toFixed", "toPrecision"];
/** Function.prototype's own keys, and the restricted `caller` / `arguments` an implementation may give a function. */
const FUNCTION_PROTOTYPE = ["apply", "bind", "call", "caller", "arguments"];
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
  object: new Set(OBJECT_PROTOTYPE),
  function: new Set([...OBJECT_PROTOTYPE, ...FUNCTION_PROTOTYPE]),
  number: new Set([...OBJECT_PROTOTYPE, ...NUMBER_PROTOTYPE]),
  boolean: new Set(OBJECT_PROTOTYPE),
  string: new Set([...OBJECT_PROTOTYPE, ...STRING_PROTOTYPE, "length"]),
} as const satisfies Readonly<Record<string, ReadonlySet<string>>>;

/** A canonical array index (§6.1.7): a string's own indexed character. */
export function isArrayIndexKey(key: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < 2 ** 32 - 1;
}
