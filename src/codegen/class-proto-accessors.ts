/**
 * (#4455) ACCESSOR members of a standalone class prototype, installed as real
 * accessor properties of the `$Object` prototype singleton.
 *
 * ## What this closes
 *
 * `#3976` slice 1 (`class-proto-object.ts`) made `C.prototype` a genuine
 * `$Object` and installed instance METHODS on it as own data properties, so
 * every reflective native answers through its existing `$Object` path. It
 * deliberately excluded accessors, because a getter installed as a DATA
 * property whose value is the getter function is a silently wrong answer:
 * `gOPD(C.prototype,"m")` would report `{value, writable}` where §15.7.14 wants
 * `{get, set, enumerable:false, configurable:true}`, and reading
 * `c.m` would hand back the function instead of calling it.
 *
 * The runtime has carried the right storage since #1888 S5: `$PropEntry` has
 * `$get`/`$set` slots, `__defineProperty_accessor` stores into them behind
 * `FLAG_ACCESSOR`, `__getOwnPropertyDescriptor` reads them back as an accessor
 * descriptor, and `__extern_get`/`__extern_set` invoke them with the original
 * receiver bound as `this`. Object literals already reach all of that
 * (`literals.ts`, the `emitObjectLiteralAccessorFn` arm). This module points the
 * class-prototype singleton at the same three helpers, so the class case stops
 * being the odd one out.
 *
 * Measured on this base (standalone): `gOPD(C.prototype,"m")` answered
 * `undefined` for `class C { set m(x) {} }` while the same shape as an object
 * literal answered a full accessor descriptor — the asymmetry this removes.
 *
 * ## Why the getter/setter closure is the CACHED singleton
 *
 * `emitCachedMethodClosureAccess` is used, not a fresh per-site closure, for
 * the same reason the method arm uses it: it is the one canonical value for
 * that member, so `gOPD(C.prototype,"m").get === gOPD(C.prototype,"m").get`
 * holds, and — the thing the `*length-dflt.js` files actually assert — the
 * closure carries the `$fnmeta` slot #4440 attached to the physical member name
 * (`C_get_m` / `C_set_m`), so the extracted accessor reports the §10.2.9
 * `name` (`"get m"` / `"set m"`) and the §15.1.5 ExpectedArgumentCount `length`
 * rather than the declared formal count.
 *
 * A class accessor's wasm function has the same `(self, ...params) -> results`
 * shape as a method, which is the only thing that helper requires; the getter
 * is the 0-param case and the setter the 1-param, void-result case.
 *
 * ## Scope
 *
 * Own, non-static, non-private, non-computed instance accessors of a class that
 * already qualifies for the `$Object` prototype. Statics live on the class
 * object, which #3976 deliberately did not convert; private elements are
 * mangled to `__priv_*` and must never surface as a spec-visible key; a
 * computed key has no compile-time name to install under. Each of those keeps
 * exactly its pre-#4455 answer.
 */

import type { CodegenContext, FunctionContext } from "./context/types.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { emitCachedMethodClosureAccess } from "./closures.js";
import { classMemberFuncKey } from "./class-member-keys.js";

/** The `__priv_` prefix `resolveClassMemberName` gives `#private` element names. */
const PRIVATE_NAME_PREFIX = "__priv_";

/**
 * §15.7.14 accessor-member attributes — `{enumerable: false, configurable:
 * true}`, in the `__defineProperty_accessor` host flag word (the
 * `computeRuntimeFlags` encoding, NOT the `__defineProperty_value` one):
 * bit 4/5 mark enumerable/configurable as SPECIFIED, bits 1/2 carry their
 * values. Enumerable is specified-and-false, which is what makes the member
 * skip `for-in` and `Object.keys` while still answering `gOPD`.
 *
 * Bits 8/9 ([[Get]]/[[Set]] specified) are deliberately left clear: the
 * runtime reads "neither set" as the legacy "both halves specified", which is
 * the correct reading for a class body — a member declared with only a setter
 * has NO getter, and the absent half must be stored as absent, not merged from
 * a previous entry.
 */
const ACCESSOR_FLAGS = (1 << 4) | (1 << 5) | (1 << 2);

/** One installable accessor member and the halves that resolved for it. */
export interface InstallableClassAccessor {
  /** Spec-visible property key. */
  name: string;
  /** `C_get_<name>` func index, when a getter is declared. */
  getterFuncIdx?: number;
  /** `C_set_<name>` func index, when a setter is declared. */
  setterFuncIdx?: number;
}

/**
 * The own instance accessors of `className` that can be installed on its
 * prototype `$Object`. Ordered by declaration (`ctx.classMethodNames` is built
 * in member order), so the own-key enumeration order matches the class body.
 */
export function installableClassAccessors(ctx: CodegenContext, className: string): InstallableClassAccessor[] {
  const declared = ctx.classMethodNames.get(className);
  if (!declared || declared.length === 0) return [];
  const out: InstallableClassAccessor[] = [];
  for (const name of declared) {
    if (name.startsWith(PRIVATE_NAME_PREFIX)) continue;
    const fullName = `${className}_${name}`;
    // `classMethodNames` folds accessors in with methods and carries no kind
    // tag; `classAccessorSet` is what separates the two. `staticAccessorSet` is
    // a subset of it — a static accessor is not a prototype member at all.
    if (!ctx.classAccessorSet.has(fullName)) continue;
    if (ctx.staticAccessorSet.has(fullName)) continue;
    const getterFuncIdx = ctx.funcMap.get(classMemberFuncKey(ctx, `${className}_get_${name}`));
    const setterFuncIdx = ctx.funcMap.get(classMemberFuncKey(ctx, `${className}_set_${name}`));
    if (getterFuncIdx === undefined && setterFuncIdx === undefined) continue;
    out.push({
      name,
      ...(getterFuncIdx !== undefined ? { getterFuncIdx } : {}),
      ...(setterFuncIdx !== undefined ? { setterFuncIdx } : {}),
    });
  }
  return out;
}

/**
 * Append the `__defineProperty_accessor` installs for `className`'s instance
 * accessors onto the CURRENT `fctx.body` (the caller's prototype-init body),
 * with the prototype `$Object` in `objLocal`.
 *
 * Returns `false` when a half's closure could not be emitted, in which case the
 * caller must abandon the whole `$Object` prototype rather than publish one
 * with a half-written member — the stack is left unbalanced on that path, which
 * is exactly why the caller discards the body wholesale on `false`.
 */
export function emitClassProtoAccessorInstalls(
  ctx: CodegenContext,
  fctx: FunctionContext,
  className: string,
  objLocal: number,
  structTypeIdx: number,
  accessors: readonly InstallableClassAccessor[],
): boolean {
  if (accessors.length === 0) return true;
  const defineAccessorIdx = ctx.funcMap.get("__defineProperty_accessor");
  if (defineAccessorIdx === undefined) return false;

  for (const accessor of accessors) {
    // Stack: [obj, key, getter | null, setter | null, flags]
    fctx.body.push({ op: "local.get", index: objLocal });
    addStringConstantGlobal(ctx, accessor.name);
    for (const instr of stringConstantExternrefInstrs(ctx, accessor.name)) fctx.body.push(instr);

    if (accessor.getterFuncIdx !== undefined) {
      if (
        !emitCachedMethodClosureAccess(
          ctx,
          fctx,
          `${className}_get_${accessor.name}`,
          accessor.getterFuncIdx,
          structTypeIdx,
        )
      ) {
        return false;
      }
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }

    if (accessor.setterFuncIdx !== undefined) {
      if (
        !emitCachedMethodClosureAccess(
          ctx,
          fctx,
          `${className}_set_${accessor.name}`,
          accessor.setterFuncIdx,
          structTypeIdx,
        )
      ) {
        return false;
      }
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }

    fctx.body.push({ op: "f64.const", value: ACCESSOR_FLAGS });
    fctx.body.push({ op: "call", funcIdx: defineAccessorIdx });
    fctx.body.push({ op: "drop" }); // helper returns the target; discard
  }
  return true;
}
