// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Small host-side value/descriptor rules for opaque WasmGC structs. */

export const NO_GENERATED_FIELD = Symbol("no-generated-field");

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
  hasBackingField: boolean,
): unknown | typeof NO_GENERATED_FIELD {
  if (typeof getter !== "function") return NO_GENERATED_FIELD;
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
): { handled: true; value: any } | undefined {
  if (typeof receiver !== "string" || !Array.isArray(args)) return undefined;
  // RegExp protocol methods and closure arguments retain the full bridge.
  if (["replace", "replaceAll", "match", "matchAll", "search", "split"].includes(method)) return undefined;
  for (let i = 0; i < args.length; i++) if (isWasmStruct(args[i])) return undefined;
  const fn = (receiver as Record<string, any>)[method];
  if (typeof fn !== "function" || isWasmStruct(fn)) return undefined;
  return { handled: true, value: apply(fn, receiver, args) };
}
