// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Small host-side value/descriptor rules for opaque WasmGC structs. */

export const NO_GENERATED_FIELD = Symbol("no-generated-field");
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

type CallbackState = { getExports: () => Record<string, Function> | undefined };
const callableOwners = new WeakMap<Function, CallbackState>();

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

export function recordCallableOwner(callable: Function, owner: CallbackState | undefined): void {
  if (owner) callableOwners.set(callable, owner);
}

/**
 * (#6651) The sandbox's constructor bindings as they were when the instance's
 * imports were built — i.e. its realm INTRINSICS, before the test ran.
 *
 * `normalizeSandboxValue` maps a host-realm constructor read off `x.constructor`
 * onto the sandbox realm's counterpart. It used to read the sandbox's LIVE
 * global binding, so a test that replaces the binding
 * (`fnGlobalObject().Promise = function () {…}`, dynamic-import/returns-promise)
 * got the replacement back from `p.constructor` instead of %Promise%. The
 * spec's `constructor` is the intrinsic, whatever the global binding says now.
 */
const sandboxIntrinsics = new WeakMap<object, Map<string, unknown>>();

/** Record `sandbox`'s function-valued bindings once, before any compiled code writes to it. */
export function snapshotSandboxIntrinsics<T extends Record<string, any> | undefined>(sandbox: T): T {
  if (!sandbox || sandboxIntrinsics.has(sandbox)) return sandbox;
  const intrinsics = new Map<string, unknown>();
  for (const name of Object.getOwnPropertyNames(sandbox)) {
    const descriptor = Object.getOwnPropertyDescriptor(sandbox, name);
    if (descriptor && "value" in descriptor && typeof descriptor.value === "function") {
      intrinsics.set(name, descriptor.value);
    }
  }
  sandboxIntrinsics.set(sandbox, intrinsics);
  return sandbox;
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
    if (name && normalized === (globalThis as any)[name]) {
      const intrinsics = sandboxIntrinsics.get(sandbox);
      const mapped = intrinsics?.has(name) ? intrinsics.get(name) : sandbox[name];
      if (mapped !== undefined) return mapped;
    }
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
