// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { WasmFunction } from "../model/module-records.js";
import type { Instr, LocalDef } from "../model/instructions.js";

// Capture language operations before any input callback.
const apply = Reflect.apply,
  ownKeys = Reflect.ownKeys;
const descriptor = Object.getOwnPropertyDescriptor,
  define = Object.defineProperty;
const create = Object.create,
  freeze = Object.freeze,
  setPrototype = Object.setPrototypeOf,
  preventExtensions = Object.preventExtensions;
const getPrototype = Object.getPrototypeOf,
  isArray = Array.isArray;
const objectPrototype = Object.prototype,
  arrayPrototype = Array.prototype;
const entries = Object.entries,
  hasOwn = Object.hasOwn;
const NativeUint8Array = Uint8Array,
  uint8Prototype = Uint8Array.prototype,
  isView = ArrayBuffer.isView;
const NativeMap = Map,
  NativeSet = Set,
  safeInteger = Number.isSafeInteger;
const mapGet = Map.prototype.get,
  mapSet = Map.prototype.set;
const setHas = Set.prototype.has,
  setAdd = Set.prototype.add,
  setDelete = Set.prototype.delete;
const typedArrayPrototype = getPrototype(Uint8Array.prototype);
const byteLength = descriptor(typedArrayPrototype, "length")!.get!;
const byteValues = uint8Prototype.values;
const iteratorNext = getPrototype(apply(arrayPrototype.values, [], [])).next;
const privateArrayPrototype = create(null);
const immutableArrays = new WeakSet<object>();
const weakHas = WeakSet.prototype.has,
  weakAdd = WeakSet.prototype.add;

function dataDescriptor(
  value: unknown,
  enumerable: boolean,
  writable: boolean,
  configurable: boolean,
): PropertyDescriptor {
  const result = create(null);
  result.value = value;
  result.enumerable = enumerable;
  result.writable = writable;
  result.configurable = configurable;
  return result;
}
function own(target: object, key: PropertyKey, value: unknown, enumerable = true): void {
  define(target, key, dataDescriptor(value, enumerable, true, true));
}
function safeIterator(method: (...args: never[]) => unknown, receiver: unknown, args: unknown[], pairs: boolean) {
  const native = apply(method, receiver, args);
  const result = create(null);
  own(
    result,
    "next",
    () => {
      const step = apply(iteratorNext, native, []) as IteratorResult<unknown>;
      if (pairs && !step.done && isArray(step.value)) setPrototype(step.value, privateArrayPrototype);
      return step;
    },
    false,
  );
  own(result, Symbol.iterator, () => result, false);
  return freeze(result);
}
for (const key of ownKeys(arrayPrototype)) {
  if (key === "constructor" || key === Symbol.unscopables) continue;
  const d = descriptor(arrayPrototype, key)!;
  if (typeof d.value !== "function") continue;
  const method = d.value;
  const iterator = key === Symbol.iterator || key === "values" || key === "keys" || key === "entries";
  const allocatesArray =
    key === "map" ||
    key === "filter" ||
    key === "slice" ||
    key === "concat" ||
    key === "flat" ||
    key === "flatMap" ||
    key === "toReversed" ||
    key === "toSorted" ||
    key === "toSpliced" ||
    key === "with" ||
    key === "splice";
  own(
    privateArrayPrototype,
    key,
    function (this: unknown, ...args: unknown[]) {
      if (iterator) return safeIterator(method, this, args, key === "entries");
      const result = apply(method, this, args);
      // Only our frozen, constructor-free receiver proves ordinary ArraySpeciesCreate.
      // Borrowed methods and callback-returned arrays must never rewrite caller objects.
      if (allocatesArray && apply(weakHas, immutableArrays, [this]) && isArray(result))
        setPrototype(result, privateArrayPrototype);
      return result;
    },
    false,
  );
}
freeze(privateArrayPrototype);

function fail(message: string): never {
  throw Error("owned function data: " + message);
}
function dataField(value: object, key: PropertyKey): unknown {
  const d = descriptor(value, key);
  if (!d || !hasOwn(d, "value")) fail("own data field required: " + String(key));
  return d.value;
}
export function copyOwnedFunctionDefinition(definition: { locals: LocalDef[]; body: Instr[] }) {
  let immutable = true;
  const active = new NativeSet<object>(),
    copies = new NativeMap<object, object>();
  function copy(value: unknown): unknown {
    if (value === null || typeof value !== "object") {
      if (typeof value === "function" || typeof value === "symbol") fail("non-data value");
      return value;
    }
    if (apply(setHas, active, [value])) fail("cyclic payload");
    const prior = apply(mapGet, copies, [value]);
    if (prior) return prior;
    if (isView(value)) {
      if (getPrototype(value) !== uint8Prototype) fail("unsupported byte view");
      const length = apply(byteLength, value, []);
      const keys = ownKeys(value);
      if (keys.length !== length) fail("byte view must contain only indexed data");
      for (let index = 0; index < length; index++) {
        const d = descriptor(value, String(index));
        if (!d || !hasOwn(d, "value") || !d.enumerable) fail("indexed byte data required");
      }
      const result = new NativeUint8Array(length);
      for (let index = 0; index < length; index++) result[index] = (value as Uint8Array)[index]!;
      // Keep content live, but never permit hidden callbacks to alter an emitter read.
      define(result, "length", dataDescriptor(length, false, false, false));
      define(
        result,
        Symbol.iterator,
        dataDescriptor(() => safeIterator(byteValues, result, [], false), false, false, false),
      );
      preventExtensions(result);
      apply(mapSet, copies, [value, result]);
      immutable = false; // Mutable owned bytes retain the full live snapshot audit.
      return result;
    }
    const array = isArray(value),
      prototype = getPrototype(value);
    if (!array && prototype !== objectPrototype && prototype !== null) fail("plain data required");
    const result = array ? [] : create(null);
    if (array) setPrototype(result, privateArrayPrototype);
    apply(setAdd, active, [value]);
    apply(mapSet, copies, [value, result]);
    const keys = ownKeys(value);
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]!;
      if (typeof key !== "string") fail("symbol payload field");
      if (array && key === "length") continue;
      const d = descriptor(value, key)!;
      if (!hasOwn(d, "value") || !d.enumerable) fail("enumerable own data required");
      own(result, key, copy(d.value));
    }
    if (array) {
      const length = dataField(value, "length");
      if (typeof length !== "number" || !safeInteger(length) || length < 0) fail("invalid array length");
      if (keys.length !== length + 1) fail("dense array required");
      for (let index = 0; index < length; index++) if (!hasOwn(result, index)) fail("dense array required");
    }
    apply(setDelete, active, [value]);
    freeze(result);
    if (array) apply(weakAdd, immutableArrays, [result]);
    return result;
  }
  const locals = dataField(definition, "locals"),
    body = dataField(definition, "body");
  if (!isArray(locals) || !isArray(body)) fail("locals/body arrays required");
  return { locals: copy(locals) as LocalDef[], body: copy(body) as Instr[], immutable };
}

export function publishOwnedFunctionDefinition(target: object, locals: LocalDef[], body: Instr[]): void {
  define(target, "locals", dataDescriptor(locals, true, false, false));
  define(target, "body", dataDescriptor(body, true, false, false));
}

/** Preserve the old snapshot's complete enumerable shell, excluding only protected owned payloads. */
export function ownedFunctionShell(target: WasmFunction): Omit<WasmFunction, "locals" | "body"> {
  const fields = entries(target),
    shell = create(null);
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!;
    if (field[0] !== "locals" && field[0] !== "body") own(shell, field[0], field[1]);
  }
  return shell;
}

/** Private authority map: callbacks never receive it or select its methods. */
export function createOwnedFunctionSnapshotStore<T extends object, S>() {
  const values = new NativeMap<T, S>();
  const store = create(null);
  own(store, "get", (key: T): S | undefined => apply(mapGet, values, [key]));
  own(store, "set", (key: T, value: S): void => {
    apply(mapSet, values, [key, value]);
  });
  return freeze(store) as { readonly get: (key: T) => S | undefined; readonly set: (key: T, value: S) => void };
}

/** Plain mutable copies of owned payloads; shared references are preserved. */
function thawOwnedFunctionDefinition(locals: LocalDef[], body: Instr[]) {
  const copies = new NativeMap<object, object>();
  function thaw(value: unknown): unknown {
    if (value === null || typeof value !== "object") return value;
    const prior = apply(mapGet, copies, [value]);
    if (prior) return prior;
    if (isView(value)) {
      const bytes = value as Uint8Array,
        length = apply(byteLength, bytes, []);
      const result = new NativeUint8Array(length);
      for (let index = 0; index < length; index++) result[index] = bytes[index]!;
      apply(mapSet, copies, [value, result]);
      return result;
    }
    const array = isArray(value),
      result = array ? [] : {};
    apply(mapSet, copies, [value, result]);
    const keys = ownKeys(value);
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]!;
      if (!array || key !== "length") own(result, key, thaw(descriptor(value, key)!.value));
    }
    return result;
  }
  return { locals: thaw(locals) as LocalDef[], body: thaw(body) as Instr[] };
}

/**
 * Owned payloads stay locked for as long as the ledger can audit them, so output
 * finalizers that rewrite bodies in place (widening, allocation-owner stamping)
 * take this released view instead: owned functions become plain mutable clones,
 * every other function object is shared unchanged. The input is never mutated.
 */
export function releaseOwnedFunctions<M extends { functions: WasmFunction[] }>(module: M): M {
  if (!module.functions.some((fn) => isPrivatelyCopiedFrozenArray(fn.body))) return module;
  const functions = module.functions.map((fn) =>
    isPrivatelyCopiedFrozenArray(fn.body) ? { ...fn, ...thawOwnedFunctionDefinition(fn.locals, fn.body) } : fn,
  );
  return { ...module, functions };
}

/** Allocation provenance only: neither ledger ownership nor recursive immutability. */
export function isPrivatelyCopiedFrozenArray(value: unknown): boolean {
  return apply(weakHas, immutableArrays, [value]);
}
