/** Host-side static inheritance for WasmGC-backed compiled class objects. */

export type ClassStaticParentExports = Record<string, Function>;
export type ClassStaticParentWrapper = (value: any, exports?: ClassStaticParentExports) => any;

// The name/registry lookups below are keyed by the class OBJECT (weakly); the
// name -> parent tables themselves live in a per-instance ClassParentRegistry.
const classNamesByObj = new WeakMap<object, string>();
const registryByObj = new WeakMap<object, ClassParentRegistry>();

export const MISS = Symbol("class-static-parent-miss");

// (#5280) An EXPLICIT `extends null` heritage, as distinct from "this name was
// never registered". The two used to be indistinguishable because
// `register` dropped a null value on the floor — see the comment on that
// method for why that was a real, queue-parking bug and not a nicety.
const NULL_PARENT = Symbol("class-static-parent-null");

/**
 * (#6790) One instance's dynamic class heritage, keyed by class NAME.
 *
 * The name key is sound only WITHIN one instance — a module cannot declare two
 * classes of one name that both register here. These tables used to be
 * module-level, i.e. one per PROCESS: two live instances that each declared
 * `class C extends X` / `class C extends Y` shared one entry, last writer
 * winning for both (the first instance's `new C()` ran Y's constructor, and
 * `C.who` read Y's static), and every registered parent was retained for the
 * life of the process. `buildImports` now creates one per instance
 * (`instanceState.classParents`), and a class object reaches its own through
 * `registerClassObject`.
 */
export class ClassParentRegistry {
  private readonly parents = new Map<string, any>();
  private readonly lazy = new Map<string, () => any>();

  /**
   * Record a class's dynamic heritage under its NAME.
   *
   * (#5280) A null `value` — `class C extends null`, which the spec gives the
   * distinct meaning "the constructor's parent is %FunctionPrototype%, and a
   * SuperCall must throw a TypeError" — is RECORDED as such instead of being
   * silently ignored. Dropping it left an EARLIER registration of the same
   * name in place, and that SuperCall applied the stale constructor instead
   * of throwing; when the stale parent resolved back into the current
   * module's own `C` it re-entered itself without bound ("Maximum call stack
   * size exceeded"). That was the flake that parked #5479/#5480/#5486 on
   * 2026-09-02, when the table was process-global and a test262 worker ran
   * hundreds of files through it; per-instance tables (#6790) remove the
   * cross-file half of it, and the null record still guards a lazy resolver
   * registered for the same name in the same instance.
   *
   * The lazy resolver is dropped alongside an explicit null so the null cannot
   * be overridden by a property-access registration for the same name.
   *
   * Bound, so it IS the `__register_class_parent` import (#4618: emitted at the
   * class declaration statement by emitRegisterDynamicClassParent).
   */
  readonly register = (name: unknown, value: unknown): void => {
    if (typeof name !== "string" || name.length === 0) return;
    if (value != null) {
      this.parents.set(name, value);
      return;
    }
    this.parents.set(name, NULL_PARENT);
    this.lazy.delete(name);
  };

  /** `__register_class_parent_ref`: resolve on first use, memoized by {@link get}. */
  registerLazy(name: unknown, resolver: (() => any) | undefined): void {
    if (typeof name !== "string" || name.length === 0 || resolver === undefined) return;
    this.lazy.set(name, resolver);
  }

  remember(name: string, value: any): void {
    if (value == null) return;
    this.parents.set(name, value);
    this.lazy.delete(name);
  }

  get(name: string): any {
    const direct = this.parents.get(name);
    // (#5280) An explicit `extends null` answers null and STOPS — it must not
    // fall through to a lazy resolver left by an earlier class of the same name.
    if (direct === NULL_PARENT) return null;
    if (direct != null) return direct;
    const lazy = this.lazy.get(name);
    if (lazy === undefined) return undefined;
    const value = lazy();
    if (value != null) this.remember(name, value);
    return value;
  }
}

/** The registry on a per-instance state object, created on first use. */
export function classParentsFor(state: { classParents?: ClassParentRegistry } | undefined): ClassParentRegistry {
  // `buildImports` always threads its state; a registry minted for a missing one is deliberately unshared.
  return state === undefined ? new ClassParentRegistry() : (state.classParents ??= new ClassParentRegistry());
}

/**
 * Pair a compiled class object with its name and with the registry of the
 * instance that declared it, so a lookup that starts from the object never has
 * to guess which instance's `C` it means.
 */
export function registerClassObject(value: object, name: unknown, registry: ClassParentRegistry): void {
  if (typeof name === "string" && name.length > 0) classNamesByObj.set(value, name);
  registryByObj.set(value, registry);
}

export function classObjectName(value: object): string | undefined {
  return classNamesByObj.get(value);
}

/** The dynamic parent registered for `name` in the instance that owns `classObj`. */
export function classParentOf(classObj: object, name: string): any {
  return registryByObj.get(classObj)?.get(name);
}

/** Resolve an inherited static property with the compiled class as receiver. */
export function resolveClassStaticParent(
  obj: any,
  key: PropertyKey,
  exports: ClassStaticParentExports | undefined,
  wrapForHost: ClassStaticParentWrapper,
): any {
  if (obj == null || typeof obj !== "object") return MISS;
  const name = classNamesByObj.get(obj);
  if (name === undefined || name.length === 0) return MISS;
  const parent = classParentOf(obj, name);
  if (parent == null) return MISS;
  const parentView = classNamesByObj.has(parent) ? wrapForHost(parent, exports) : parent;
  if (parentView == null || (typeof parentView !== "object" && typeof parentView !== "function")) return MISS;
  const receiver = wrapForHost(obj, exports) ?? obj;
  if (!Reflect.has(parentView, key)) return MISS;
  return Reflect.get(parentView, key, receiver);
}
