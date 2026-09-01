/** Host-side static inheritance for WasmGC-backed compiled class objects. */

export type ClassStaticParentExports = Record<string, Function>;
export type ClassStaticParentWrapper = (value: any, exports?: ClassStaticParentExports) => any;

// These registries used to live in runtime.ts beside the host mirror. Keeping
// them with the resolver makes the barrel pay only for the two-line lookup and
// lets dynamic heritage and builtin-derived static inheritance share state.
const classNamesByObj = new WeakMap<object, string>();
const classParentsByName = new Map<string, any>();
const classParentLazy = new Map<string, () => any>();

export const MISS = Symbol("class-static-parent-miss");

export function registerClassObject(value: object, name: string): void {
  classNamesByObj.set(value, name);
}

export function classObjectName(value: object): string | undefined {
  return classNamesByObj.get(value);
}

export function registerClassParent(name: string, value: any): void {
  if (value != null) classParentsByName.set(name, value);
}

export function registerClassParentLazy(name: string, resolver: () => any): void {
  classParentLazy.set(name, resolver);
}

export function rememberClassParent(name: string, value: any): void {
  if (value == null) return;
  classParentsByName.set(name, value);
  classParentLazy.delete(name);
}

export function getClassParent(name: string): any {
  const direct = classParentsByName.get(name);
  if (direct != null) return direct;
  const lazy = classParentLazy.get(name);
  if (lazy === undefined) return undefined;
  const value = lazy();
  if (value != null) rememberClassParent(name, value);
  return value;
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
  const parent = getClassParent(name);
  if (parent == null) return MISS;
  const parentView = classNamesByObj.has(parent) ? wrapForHost(parent, exports) : parent;
  if (parentView == null || (typeof parentView !== "object" && typeof parentView !== "function")) return MISS;
  const receiver = wrapForHost(obj, exports) ?? obj;
  if (!Reflect.has(parentView, key)) return MISS;
  return Reflect.get(parentView, key, receiver);
}
