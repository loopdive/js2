type ClassMethodExports = Record<string, Function>;
type ClassMethodCallbackState = { getExports: () => ClassMethodExports | undefined };

/** Resolve and invoke a compiled coercion method; `miss` means no callable member (#5239). */
export function callResolvedClassPrimitive(
  resolver: (obj: any, key: any, exports: ClassMethodExports | undefined) => any,
  raw: any,
  name: string,
  exports: ClassMethodExports,
  miss: unknown,
): any {
  const member = resolver(raw, name, exports);
  return member !== miss && typeof member === "function" ? member.call(raw) : miss;
}

export interface ClassMethodHostBridgeDeps {
  miss: unknown;
  canBeWeakKey(value: unknown): boolean;
  isRegisteredInstance(value: unknown): boolean;
  /** Return the innermost compiled user-class name for a host-backed object. */
  getClassName?(value: unknown): string | undefined;
  marshalBridgeResult(value: any, callbackState: ClassMethodCallbackState): any;
  /**
   * (#5237) Strip a host mirror back to the raw carrier the compiled bridges
   * dispatch on. Used only to honour an explicit `this`; when absent the
   * bridges keep their historical bound-receiver behaviour.
   */
  unwrapReceiver?(value: any): any;
}

/**
 * (#5237) Pick the carrier a method bridge should dispatch on.
 *
 * A bridge is minted per (carrier, key) and, until now, closed over the carrier
 * it was RESOLVED from and ignored `this` entirely. That is right for the
 * `inst.m()` shape it was built for, but wrong for the two shapes a linked
 * consumer reaches a provider class through: `C.prototype.m.call(inst)` and
 * `C.prototype.m.apply(inst, …)` both resolve `m` off the PROTOTYPE struct, so
 * the call ran against the prototype and every field read `null` (measured:
 * `Point.prototype.label.call(new Point(1,2))` answered "Pnull:null").
 *
 * `this` is honoured only when it is a genuine alternative carrier that the
 * SAME member-kind discriminator accepts — so an unrelated or absent `this`
 * still falls back to the bound carrier and nothing that worked before moves.
 */
function selectBridgeReceiver(
  thisArg: any,
  bound: any,
  accepts: (candidate: any) => boolean,
  unwrap: ((value: any) => any) | undefined,
): any {
  if (thisArg == null || unwrap === undefined) return bound;
  if (typeof thisArg !== "object" && typeof thisArg !== "function") return bound;
  const raw = unwrap(thisArg);
  if (raw === bound || raw == null || typeof raw !== "object") return bound;
  return accepts(raw) ? raw : bound;
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
      // (#5204) A GETTER on an externref-backed class. The generic
      // `__call_get_<key>` is reached only after `__member_kind_<key>`'s
      // ref.test cascade classifies the receiver, and a host-object receiver
      // never passes that test — so `get g()` read `NaN` with no error. The
      // class-qualified export is unambiguous; check it before the method
      // candidates, since a key is either an accessor or a method.
      const classGetFn = exports[`__call_get_${className}_${key}`] as unknown as ((value: any) => any) | undefined;
      if (typeof classGetFn === "function") {
        return deps.marshalBridgeResult(classGetFn(obj), callbackState);
      }
      const prefix = `__class_call_${className}_${key}_`;
      const candidates: Array<{ arity: number; fn: Function }> = [];
      // (#5204) A rest-parameter method publishes ONE `_vararg` bridge taking
      // the whole argument array, not an arity-suffixed family.
      let varargFn: ((value: any, args: any[]) => any) | undefined;
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
          const fn = exports[name];
          if (suffix === "vararg") {
            if (typeof fn === "function") varargFn = fn as (value: any, args: any[]) => any;
            continue;
          }
          if (!/^\d+$/.test(suffix)) continue;
          if (typeof fn === "function") candidates.push({ arity: Number(suffix), fn });
        }
        exportView = Object.getPrototypeOf(exportView) as Record<string, any> | null;
      }
      if (varargFn !== undefined) {
        const restFn = varargFn;
        let bridges = classMethodHostBridges.get(obj);
        if (!bridges) {
          bridges = new Map();
          classMethodHostBridges.set(obj, bridges);
        }
        let fn = bridges.get(key);
        if (!fn) {
          fn = function externrefClassVarargHostBridge(this: any, ...args: any[]) {
            return deps.marshalBridgeResult(restFn(obj, args), callbackState);
          };
          Object.defineProperty(fn, "name", { value: key, configurable: true });
          bridges.set(key, fn);
        }
        return fn;
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
      const resolvedKindFn = kindFn;
      const acceptsReceiver = (candidate: any): boolean => {
        if (!deps.isRegisteredInstance(candidate)) return false;
        try {
          return resolvedKindFn(candidate) === kind;
        } catch {
          return false;
        }
      };
      fn = function classMethodHostBridge(this: any, ...args: any[]) {
        const recv = selectBridgeReceiver(this, obj, acceptsReceiver, deps.unwrapReceiver);
        if (hasRest) return deps.marshalBridgeResult(callFn(recv, args), callbackState);
        const callArgs =
          args.length < declaredArity ? args.concat(new Array(declaredArity - args.length).fill(undefined)) : args;
        return deps.marshalBridgeResult(callFn(recv, ...callArgs), callbackState);
      };
      Object.defineProperty(fn, "name", { value: key, configurable: true });
      bridges.set(key, fn);
    }
    return fn;
  };
}

/**
 * (#5358) Does `obj` — a compiled class instance or prototype singleton —
 * carry `key` as a compiled prototype member? Presence only, through the same
 * `__member_kind_<key>` discriminator `createClassMemberResolver` resolves
 * with, so `k in h` and `h[k]` agree; a getter is NOT invoked. A key whose
 * bridge was never published (nothing registered the demand) answers false,
 * which is the pre-#5358 answer.
 */
export function hasCompiledClassMember(obj: any, key: any, exports: ClassMethodExports | undefined): boolean {
  if (exports === undefined || typeof key !== "string") return false;
  const kindFn = exports[`__member_kind_${key}`];
  if (typeof kindFn !== "function") return false;
  try {
    return kindFn(obj) !== 0;
  } catch {
    return false;
  }
}
