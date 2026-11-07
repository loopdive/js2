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
  marshalBridgeResult(value: any, callbackState: ClassMethodCallbackState): any;
  /**
   * (#5237) Strip a host mirror back to the raw carrier the compiled bridges
   * dispatch on. Used only to honour an explicit `this`; when absent the
   * bridges keep their historical bound-receiver behaviour.
   */
  unwrapReceiver?(value: any, reader?: ClassMethodCallbackState): any;
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

/**
 * (#6884) Strip host mirrors off the ARGUMENTS a compiled method bridge is
 * called with, the same way #5237 strips the receiver.
 *
 * `__extern_method_call` wraps every argument for host visibility before it
 * dispatches (`_wrapForHost`: a compiled struct becomes a Proxy). That is right
 * when the callee is a host function, but a class-method bridge forwards the
 * values straight into a compiled `__class_call_*` export, which then sees the
 * PROXY instead of its own struct: `arg instanceof C` is false and every field
 * read goes through the host mirror. The Temporal polyfill's
 * `d.subtract(c)` (two `TimeDuration`s, `d` untyped) read `c.totalNs` off the
 * mirror and handed JSBI a carrier without its class members —
 * "__digit is not a function".
 */
function unwrapBridgeArgs(
  args: any[],
  deps: ClassMethodHostBridgeDeps,
  callbackState: ClassMethodCallbackState,
): any[] {
  const unwrap = deps.unwrapReceiver;
  if (unwrap === undefined || args.length === 0) return args;
  let out: any[] | undefined;
  for (let i = 0; i < args.length; i++) {
    const raw = unwrap(args[i], callbackState);
    if (raw !== args[i]) {
      out ??= args.slice();
      out[i] = raw;
    }
  }
  return out ?? args;
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
        const rawArgs = unwrapBridgeArgs(args, deps, callbackState);
        if (hasRest) return deps.marshalBridgeResult(callFn(recv, rawArgs), callbackState);
        const callArgs =
          rawArgs.length < declaredArity
            ? rawArgs.concat(new Array(declaredArity - rawArgs.length).fill(undefined))
            : rawArgs;
        return deps.marshalBridgeResult(callFn(recv, ...callArgs), callbackState);
      };
      Object.defineProperty(fn, "name", { value: key, configurable: true });
      bridges.set(key, fn);
    }
    return fn;
  };
}
