type ClassMethodExports = Record<string, Function>;
type ClassMethodCallbackState = { getExports: () => ClassMethodExports | undefined };

export interface ClassMethodHostBridgeDeps {
  miss: unknown;
  canBeWeakKey(value: unknown): boolean;
  marshalBridgeResult(value: any, callbackState: ClassMethodCallbackState): any;
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
    const callbackState: ClassMethodCallbackState = { getExports: () => exports };
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
      : declaredArity > 0
        ? exports[`__class_call_${key}_${declaredArity}`]
        : exports[`__call_${key}`]) as unknown as ((value: any, ...args: any[]) => any) | undefined;
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
