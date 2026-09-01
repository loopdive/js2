// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Small host-side value/descriptor rules for opaque WasmGC structs. */

export const NO_GENERATED_FIELD = Symbol("no-generated-field");
export const PRIMITIVE_STRING_UNDEFINED = Symbol("primitive-string-undefined");
const CONFIGURABLE_FLAG = 4;

/** Return whether a failed native assignment is a sloppy-mode no-op. */
export function failedSloppyNativeSetIsNoOp(obj: any, desc: PropertyDescriptor | undefined): boolean {
  if (desc && (("value" in desc && desc.writable === false) || (!("value" in desc) && !desc.set))) return true;
  try {
    return !Object.isExtensible(obj);
  } catch {
    return false;
  }
}

export function hasUserCallableSidecarProps(
  sidecar: Record<string | symbol, any> | undefined,
  hasAccessors: boolean,
): boolean {
  return (
    hasAccessors ||
    (!!sidecar && Reflect.ownKeys(sidecar).some((key) => key !== "name" && key !== "length" && key !== "prototype"))
  );
}

export function ownKeysResult(
  name: string,
  result: any,
  state: any,
  materialize: (value: any, state: any) => any,
): any {
  return name === "ownKeys" ? materialize(result, state) : result;
}

type CallbackState = { getExports: () => Record<string, Function> | undefined };
const callableOwners = new WeakMap<Function, CallbackState>();
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
  trimLeft: String.prototype.trimLeft,
  trimRight: String.prototype.trimRight,
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

export function recordCallableOwner(callable: Function, owner: CallbackState | undefined): void {
  if (owner) callableOwners.set(callable, owner);
}

/** Preserve cross-module facades and normalize values returning to their owning module. */
export function normalizeSandboxValue(
  receiver: unknown,
  value: any,
  key: PropertyKey,
  sandbox: Record<string, any> | undefined,
  owner: CallbackState | undefined,
  // (#5222) `unwrap` receives the READING module's callback state as its second
  // argument so it can decline to un-marshal a mirror minted by a DIFFERENT
  // module across the #2527 linked-provider seam. Passed as the state, not as
  // resolved exports, so the un-marshal never pays `getExports()` on the hot
  // single-module path.
  unwrap: (value: any, reader?: CallbackState) => any,
): any {
  if (sandbox && receiver === sandbox && typeof value === "function") {
    const callableOwner = callableOwners.get(value);
    if (!callableOwner || !owner || callableOwner !== owner) return value;
  }
  const normalized = unwrap(value, owner);
  if (sandbox && key === "constructor" && typeof normalized === "function") {
    const name = normalized.name;
    if (name && normalized === (globalThis as any)[name] && sandbox[name] !== undefined) return sandbox[name];
  }
  return normalized;
}

interface StructDeleteState {
  hasOwn: (obj: object, key: PropertyKey, exports: Record<string, Function> | undefined) => boolean;
  sidecarDelete: (obj: object, key: PropertyKey) => boolean;
  propDescs: WeakMap<object, Map<PropertyKey, number>>;
  accessors: WeakMap<object, Map<PropertyKey, { get?: Function; set?: Function }>>;
  deletedKeys: WeakMap<object, Set<PropertyKey>>;
  integrity: readonly [WeakSet<object>, WeakSet<object>];
}

/** Apply host-proxy deletion semantics to a fixed-shape WasmGC struct. */
export function deleteStructProperty(
  obj: object,
  key: PropertyKey,
  exports: Record<string, Function> | undefined,
  state: StructDeleteState,
): boolean {
  const normalizedKey = typeof key === "symbol" ? key : String(key);
  const hasOwn = state.hasOwn(obj, normalizedKey, exports);
  const descs = state.propDescs.get(obj);
  const flags = descs?.get(normalizedKey);
  if (
    ((hasOwn || exports === undefined) && state.integrity.some((objects) => objects.has(obj))) ||
    (flags !== undefined && !(flags & CONFIGURABLE_FLAG))
  ) {
    return false;
  }
  state.sidecarDelete(obj, key);
  descs?.delete(normalizedKey);
  if (typeof key === "symbol") state.accessors.get(obj)?.delete(key);
  if (hasOwn || exports === undefined) {
    let tombstones = state.deletedKeys.get(obj);
    if (!tombstones) {
      tombstones = new Set<PropertyKey>();
      state.deletedKeys.set(obj, tombstones);
    }
    tombstones.add(normalizedKey);
  }
  return true;
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

/** Preserve IsCallable for WasmGC replacement callbacks before ToString. */
export function deferStringReplacementArg(
  value: any,
  callbackState: { getExports: () => Record<string, Function> | undefined } | undefined,
  fallback: (value: any) => any,
  isWasmStruct: (value: any) => boolean,
  wrapCallable: (value: any, callbackState?: { getExports: () => Record<string, Function> | undefined }) => any,
): any {
  if (!isWasmStruct(value)) return fallback(value);
  const exports = callbackState?.getExports();
  const isClosure = exports?.__is_closure as ((candidate: any) => number) | undefined;
  if (typeof isClosure === "function") {
    try {
      if (isClosure(value) === 1) return wrapCallable(value, callbackState);
    } catch {
      // Keep the ordinary ToPrimitive path when the classifier cannot inspect this value.
    }
  }
  return fallback(value);
}

export function makeStringReplacementArg(
  method: string,
  callbackState: { getExports: () => Record<string, Function> | undefined } | undefined,
  fallback: (value: any) => any,
  isWasmStruct: (value: any) => boolean,
  wrapCallable: (value: any, callbackState?: { getExports: () => Record<string, Function> | undefined }) => any,
): (value: any) => any {
  return (value: any): any =>
    method === "replace" || method === "replaceAll"
      ? deferStringReplacementArg(value, callbackState, fallback, isWasmStruct, wrapCallable)
      : fallback(value);
}
