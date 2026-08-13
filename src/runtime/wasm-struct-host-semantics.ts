// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Small host-side value/descriptor rules for opaque WasmGC structs. */

export const NO_GENERATED_FIELD = Symbol("no-generated-field");
export const PRIMITIVE_STRING_UNDEFINED = Symbol("primitive-string-undefined");
const PRIMITIVE_STRING_INTRINSICS: Readonly<Record<string, Function | undefined>> = Object.freeze({
  charAt: String.prototype.charAt,
  charCodeAt: String.prototype.charCodeAt,
  codePointAt: String.prototype.codePointAt,
  endsWith: String.prototype.endsWith,
  includes: String.prototype.includes,
  indexOf: String.prototype.indexOf,
  lastIndexOf: String.prototype.lastIndexOf,
  localeCompare: String.prototype.localeCompare,
  normalize: String.prototype.normalize,
  padEnd: String.prototype.padEnd,
  padStart: String.prototype.padStart,
  repeat: String.prototype.repeat,
  slice: String.prototype.slice,
  startsWith: String.prototype.startsWith,
  substr: String.prototype.substr,
  substring: String.prototype.substring,
  toLowerCase: String.prototype.toLowerCase,
  toUpperCase: String.prototype.toUpperCase,
  toString: String.prototype.toString,
  trim: String.prototype.trim,
  trimEnd: String.prototype.trimEnd,
  trimStart: String.prototype.trimStart,
  valueOf: String.prototype.valueOf,
});

export function masksField(
  sidecar: Record<PropertyKey, unknown> | undefined,
  key: PropertyKey,
  flags: number | undefined,
  hasBackingField: boolean,
  accessorFlag: number,
): boolean {
  return !!sidecar && key in sidecar ? true : flags !== undefined && (!!(flags & accessorFlag) || !hasBackingField);
}

export function readField(
  getter: unknown,
  receiver: unknown,
  hasBackingField: boolean | undefined,
): unknown | typeof NO_GENERATED_FIELD {
  // A known field-name miss must not probe a getter shared by structurally
  // compatible shapes. Unknown legacy/prepared shapes retain the old probe.
  if (hasBackingField === false || typeof getter !== "function") return NO_GENERATED_FIELD;
  const value = getter(receiver);
  return value !== undefined && value !== null ? value : hasBackingField ? value : NO_GENERATED_FIELD;
}

export function ordinaryFields(fields: readonly string[] | null): boolean {
  return fields !== null && !fields.includes("__tag");
}

export function unboxSymbol(cache: Map<number, symbol>, value: unknown): number {
  if (typeof value !== "symbol") return 0;
  for (const [id, symbol] of cache) if (symbol === value) return id;
  let id = -0x40000000 - cache.size;
  while (cache.has(id)) id--;
  cache.set(id, value);
  return id;
}

/**
 * Skip generic WasmGC/closure marshaling for dynamic calls on primitive
 * strings while preserving dynamic String.prototype lookup.
 */
export function tryPrimitiveStringMethod(
  receiver: any,
  method: string,
  args: any[],
  isWasmStruct: (value: any) => boolean,
  apply: (fn: Function, receiver: any, args: any[]) => any,
): any {
  if (typeof receiver !== "string" || !Array.isArray(args)) return undefined;
  const intrinsic = PRIMITIVE_STRING_INTRINSICS[method];
  // RegExp protocol methods, closure-valued patches, and unknown names retain
  // the full bridge. Intrinsic identity keeps String.prototype monkey-patches
  // observable without allocating a result wrapper on every successful call.
  if (intrinsic === undefined) return undefined;
  const fn = (receiver as unknown as Record<string, any>)[method];
  if (fn !== intrinsic) return undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg !== null && (typeof arg === "object" || typeof arg === "function") && isWasmStruct(arg)) return undefined;
  }
  const value = apply(fn, receiver, args);
  return value === undefined ? PRIMITIVE_STRING_UNDEFINED : value;
}
