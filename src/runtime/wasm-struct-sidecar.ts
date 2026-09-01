// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

export interface WasmStructSidecarState {
  readonly props: WeakMap<object, Record<string | symbol, any>>;
  readonly prototypes: WeakMap<object, any>;
  readonly deletedKeys: WeakMap<object, Set<string | symbol>>;
  readonly shadowedFields: WeakMap<object, Set<string>>;
  readonly descriptors: WeakMap<object, Map<string | symbol, number>>;
  readonly accessors: WeakMap<object, Map<string | symbol, { get?: Function; set?: Function }>>;
  readonly frozen: WeakSet<object>;
  readonly sealed: WeakSet<object>;
  readonly nonExtensible: WeakSet<object>;
}

export function arrayIndexForPropertyKey(key: string): number | undefined {
  if (key === "0") return 0;
  if (key.length === 0 || key.charCodeAt(0) === 48) return undefined;
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < 4294967295 && String(index) === key ? index : undefined;
}

export function getOrCreateWasmStructSidecar(
  state: WasmStructSidecarState,
  value: object,
): Record<string | symbol, any> {
  let sidecar = state.props.get(value);
  if (!sidecar) {
    sidecar = Object.create(null) as Record<string | symbol, any>;
    state.props.set(value, sidecar);
  }
  return sidecar;
}

export function readWasmStructSidecar(state: WasmStructSidecarState, value: object, key: PropertyKey): any {
  return state.props.get(value)?.[key];
}

export function writeWasmStructSidecar(
  state: WasmStructSidecarState,
  value: object,
  key: PropertyKey,
  next: any,
): void {
  getOrCreateWasmStructSidecar(state, value)[key] = next;
  state.deletedKeys.get(value)?.delete(typeof key === "symbol" ? key : String(key));
}

/** Alias every ordinary-property record when a vec projection changes only its physical carrier. */
export function copyWasmStructSidecar(
  state: WasmStructSidecarState,
  source: any,
  destination: any,
  normalize: (value: any) => any,
  canBeWeakKey: (value: any) => boolean,
): void {
  const rawSource = normalize(source);
  const rawDestination = normalize(destination);
  if (rawSource === rawDestination || !canBeWeakKey(rawSource) || !canBeWeakKey(rawDestination)) return;

  const alias = <T>(store: WeakMap<object, T>): void => {
    const value = store.get(rawSource);
    if (value) store.set(rawDestination, value);
  };
  alias(state.props);
  alias(state.descriptors);
  alias(state.accessors);
  alias(state.deletedKeys);
  alias(state.shadowedFields);
  if (state.prototypes.has(rawSource)) state.prototypes.set(rawDestination, state.prototypes.get(rawSource));
  if (state.frozen.has(rawSource)) state.frozen.add(rawDestination);
  if (state.sealed.has(rawSource)) state.sealed.add(rawDestination);
  if (state.nonExtensible.has(rawSource)) state.nonExtensible.add(rawDestination);
}

export function isVisibleWasmVecSidecarKey(state: WasmStructSidecarState, vec: object, key: string | symbol): boolean {
  const normalized = typeof key === "symbol" ? key : String(key);
  if (state.deletedKeys.get(vec)?.has(normalized)) return false;
  if (
    typeof normalized === "string" &&
    (normalized === "length" ||
      arrayIndexForPropertyKey(normalized) !== undefined ||
      normalized.startsWith("__get_") ||
      normalized.startsWith("__set_"))
  ) {
    return false;
  }
  const sidecar = state.props.get(vec);
  return (
    (!!sidecar && normalized in sidecar) ||
    (state.descriptors.get(vec)?.has(normalized) ?? false) ||
    (state.accessors.get(vec)?.has(normalized) ?? false)
  );
}

/** Preserve array own-key order while adding the vec's named and symbol sidecars. */
export function wasmVecOwnKeys(
  state: WasmStructSidecarState,
  vec: object,
  target: any[],
  length: number,
  mappedArguments: boolean,
  rawDescriptor: (key: string | symbol) => PropertyDescriptor | undefined,
): (string | symbol)[] {
  const keys: (string | symbol)[] = [];
  const symbols: symbol[] = [];
  const push = (key: string | symbol): void => {
    if (!keys.includes(key)) keys.push(key);
  };
  for (let index = 0; index < length; index++) {
    if (!mappedArguments || rawDescriptor(String(index)) !== undefined) push(String(index));
  }
  push("length");
  const addSidecarKey = (key: string | symbol): void => {
    if (!isVisibleWasmVecSidecarKey(state, vec, key)) return;
    if (typeof key === "symbol") {
      if (!symbols.includes(key)) symbols.push(key);
    } else {
      push(key);
    }
  };
  const sidecar = state.props.get(vec);
  if (sidecar) {
    for (const key of Object.getOwnPropertyNames(sidecar)) addSidecarKey(key);
    for (const key of Object.getOwnPropertySymbols(sidecar)) addSidecarKey(key);
  }
  for (const key of state.descriptors.get(vec)?.keys() ?? []) addSidecarKey(key);
  for (const key of state.accessors.get(vec)?.keys() ?? []) addSidecarKey(key);
  for (const key of Reflect.ownKeys(target)) {
    if (typeof key === "symbol") {
      if (!symbols.includes(key)) symbols.push(key);
    } else {
      push(key);
    }
  }
  for (const key of symbols) push(key);
  return keys;
}

export function wasmVecSidecarDescriptor(
  state: WasmStructSidecarState,
  vec: object,
  key: string | symbol,
  hostDescriptor: (key: string | symbol) => PropertyDescriptor | undefined,
  materializeNonConfigurable: (key: string | symbol, descriptor: PropertyDescriptor | undefined) => void,
): PropertyDescriptor | undefined {
  if (!isVisibleWasmVecSidecarKey(state, vec, key)) return undefined;
  const descriptor = hostDescriptor(key);
  if (descriptor !== undefined) materializeNonConfigurable(key, descriptor);
  return descriptor;
}
