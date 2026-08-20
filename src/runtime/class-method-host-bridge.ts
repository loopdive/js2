type ClassMethodExports = Record<string, Function>;
type ClassMethodCallbackState = { getExports: () => ClassMethodExports | undefined };

export interface ClassMethodHostBridgeDeps {
  miss: unknown;
  canBeWeakKey(value: unknown): boolean;
  isRegisteredInstance(value: unknown): boolean;
  /** Return the innermost compiled user-class name for a host-backed object. */
  getClassName?(value: unknown): string | undefined;
  marshalBridgeResult(value: any, callbackState: ClassMethodCallbackState): any;
}

export function invokeResolvedClassMethod(
  resolver: (obj: any, key: any, exports: ClassMethodExports | undefined) => any,
  obj: any,
  key: any,
  exports: ClassMethodExports | undefined,
  receiver: any,
  args: any[],
  miss: unknown,
  unwrap: (value: any) => any,
): any {
  const method = resolver(obj, key, exports);
  if (method === miss) return miss;
  const result = method.apply(receiver, args);
  return result === obj || result === receiver ? obj : unwrap(result);
}

export function createResolvedClassMethodInvoker(
  resolver: (obj: any, key: any, exports: ClassMethodExports | undefined) => any,
  miss: unknown,
  unwrap: (value: any) => any,
): (obj: any, key: any, exports: ClassMethodExports | undefined, receiver: any, args: any[]) => any {
  return (obj, key, exports, receiver, args) =>
    invokeResolvedClassMethod(resolver, obj, key, exports, receiver, args, miss, unwrap);
}

export function resolveSubclassParent(
  parentName: string,
  deps: Record<string, any> | undefined,
  resolveNamespace: (path: string[], name: string, deps?: Record<string, any>) => any,
): any {
  let parent = (deps && deps[parentName]) ?? (globalThis as any)[parentName];
  if (typeof parent !== "function" && parentName.includes(".")) {
    const parts = parentName.split(".");
    const name = parts.pop();
    if (name) parent = resolveNamespace(parts, name, deps);
  }
  return parent;
}

/**
 * Build the host-side resolver for compiled class methods. The resolver keeps
 * method identity stable per instance and reads the compiler-emitted member
 * kind, arity, and vararg dispatch exports.
 */
export function createClassMemberResolver(
  deps: ClassMethodHostBridgeDeps,
): (obj: any, key: any, exports: ClassMethodExports | undefined) => any {
  const classMethodHostBridges = new WeakMap<object, Map<string, Function>>();
  const memberKindFnCache = new WeakMap<object, Map<string, Function | null>>();

  return function resolveClassMemberOnInstance(obj: any, key: any, exports: ClassMethodExports | undefined): any {
    if (exports === undefined || typeof key !== "string") return deps.miss;
    if (obj == null || typeof obj !== "object" || !deps.canBeWeakKey(obj)) return deps.miss;
    if (!deps.isRegisteredInstance(obj)) return deps.miss;
    const callbackState: ClassMethodCallbackState = { getExports: () => exports };
    const className = deps.getClassName?.(obj);
    if (className !== undefined) {
      // Externref-backed subclasses cannot use the ordinary ref.test cascade:
      // the receiver is the real host object, not a WasmGC struct. The codegen
      // emits a class-qualified bridge for each such method, so resolve it
      // directly before consulting the historical fnctor/struct surface.
      const prefix = `__class_call_${className}_${key}_`;
      const candidates: Array<{ arity: number; fn: Function }> = [];
      // `callbackState.getExports()` may be the host-bridge projection whose
      // generated helpers live on a prototype. Walk the full export view, not
      // only its enumerable own keys, so class-qualified bridges remain
      // discoverable after projection.
      const seenNames = new Set<string>();
      let exportView: Record<string, any> | null = exports;
      while (exportView !== null) {
        for (const name of Object.getOwnPropertyNames(exportView)) {
          if (seenNames.has(name) || !name.startsWith(prefix)) continue;
          seenNames.add(name);
          const suffix = name.slice(prefix.length);
          if (!/^\d+$/.test(suffix)) continue;
          const fn = exports[name];
          if (typeof fn === "function") candidates.push({ arity: Number(suffix), fn });
        }
        exportView = Object.getPrototypeOf(exportView) as Record<string, any> | null;
      }
      if (candidates.length > 0) {
        candidates.sort((a, b) => a.arity - b.arity);
        let bridges = classMethodHostBridges.get(obj);
        if (!bridges) {
          bridges = new Map();
          classMethodHostBridges.set(obj, bridges);
        }
        let fn = bridges.get(key);
        if (!fn) {
          fn = function externrefClassMethodHostBridge(this: any, ...args: any[]) {
            // Prefer the declaration whose arity covers the call, while
            // retaining the smallest declaration for omitted/default args.
            const selected =
              candidates.find((candidate) => candidate.arity >= args.length) ?? candidates[candidates.length - 1]!;
            const callArgs =
              args.length < selected.arity
                ? args.concat(new Array(selected.arity - args.length).fill(undefined))
                : args.slice(0, selected.arity);
            return deps.marshalBridgeResult(selected.fn(obj, ...callArgs), callbackState);
          };
          Object.defineProperty(fn, "name", { value: key, configurable: true });
          bridges.set(key, fn);
        }
        return fn;
      }
    }
    let kindCache = memberKindFnCache.get(exports);
    if (!kindCache) {
      kindCache = new Map();
      memberKindFnCache.set(exports, kindCache);
    }
    let kindFn: Function | null | undefined = kindCache.get(key);
    if (kindFn === undefined) {
      const found = exports[`__member_kind_${key}`];
      kindFn = typeof found === "function" ? found : null;
      kindCache.set(key, kindFn);
    }
    if (kindFn === null) return deps.miss;
    let kind = 0;
    try {
      kind = kindFn(obj);
    } catch {
      return deps.miss;
    }
    if (kind === 2) {
      const getFn = exports[`__call_get_${key}`] as unknown as ((value: any) => any) | undefined;
      if (typeof getFn !== "function") return deps.miss;
      return deps.marshalBridgeResult(getFn(obj), callbackState);
    }
    if (kind !== 1) return deps.miss;

    let declaredArity = 0;
    let hasRest = false;
    const arityFn = exports[`__member_arity_${key}`] as unknown as ((value: any) => number) | undefined;
    if (typeof arityFn === "function") {
      try {
        const observed = arityFn(obj);
        if (Number.isInteger(observed) && observed < 0) hasRest = true;
        else if (Number.isInteger(observed) && observed >= 0) declaredArity = observed;
      } catch {
        return deps.miss;
      }
    }
    const callFn = (hasRest
      ? exports[`__class_call_${key}_vararg`]
      : (exports[`__class_call_${key}_${declaredArity}`] ??
        // Older modules only published the iterator-shaped zero-argument
        // bridge. Keep that fallback for compatibility with cached modules.
        exports[`__call_${key}`])) as unknown as ((value: any, ...args: any[]) => any) | undefined;
    if (typeof callFn !== "function") return deps.miss;
    let bridges = classMethodHostBridges.get(obj);
    if (!bridges) {
      bridges = new Map();
      classMethodHostBridges.set(obj, bridges);
    }
    let fn = bridges.get(key);
    if (!fn) {
      fn = function classMethodHostBridge(this: any, ...args: any[]) {
        if (hasRest) return deps.marshalBridgeResult(callFn(obj, args), callbackState);
        const callArgs =
          args.length < declaredArity ? args.concat(new Array(declaredArity - args.length).fill(undefined)) : args;
        return deps.marshalBridgeResult(callFn(obj, ...callArgs), callbackState);
      };
      Object.defineProperty(fn, "name", { value: key, configurable: true });
      bridges.set(key, fn);
    }
    return fn;
  };
}
