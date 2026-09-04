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

// (#5280) An EXPLICIT `extends null` heritage, as distinct from "this name was
// never registered". The two used to be indistinguishable because
// `registerClassParent` dropped a null value on the floor — see the comment on
// that function for why that was a real, queue-parking bug and not a nicety.
const NULL_PARENT = Symbol("class-static-parent-null");

export function registerClassObject(value: object, name: string): void {
  classNamesByObj.set(value, name);
}

export function classObjectName(value: object): string | undefined {
  return classNamesByObj.get(value);
}

/**
 * Record a class's dynamic heritage under its NAME.
 *
 * (#5280) A null `value` — `class C extends null`, which the spec gives the
 * distinct meaning "the constructor's parent is %FunctionPrototype%, and a
 * SuperCall must throw a TypeError" — is now RECORDED as such instead of being
 * silently ignored.
 *
 * Why that mattered: these registries are process-global and keyed by class
 * NAME, while a sharded test262 worker compiles and runs hundreds of files in
 * one process, and `C` is among the most common class names in the corpus. So
 * dropping the null left the PREVIOUS file's `C` parent in place, and this
 * file's SuperCall applied that stale constructor instead of throwing. When the
 * stale parent resolved back into the current module's own `C`, the SuperCall
 * re-entered itself without bound and the row failed with "Maximum call stack
 * size exceeded" — non-deterministically, since the outcome depends only on
 * which files happened to precede it in that worker. That is the flake that
 * parked three unrelated PRs on 2026-09-02 (#5479/#5480/#5486, bucket
 * signature 96690aa5e0efb4ff), and it is invisible to a single-file run: a
 * fresh process has an empty registry, so the row passes every time.
 *
 * Reproduced at pool 1 by running
 * `test/language/statements/class/subclass/derived-class-return-override-catch-super.js`
 * and then `.../subclass/class-definition-null-proto-super.js` in one worker.
 *
 * The lazy resolver is dropped alongside an explicit null so the null cannot be
 * overridden by a stale property-access registration for the same name.
 */
export function registerClassParent(name: string, value: any): void {
  if (value != null) {
    classParentsByName.set(name, value);
    return;
  }
  classParentsByName.set(name, NULL_PARENT);
  classParentLazy.delete(name);
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
  // (#5280) An explicit `extends null` answers null and STOPS — it must not
  // fall through to a lazy resolver left by an earlier class of the same name.
  if (direct === NULL_PARENT) return null;
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
