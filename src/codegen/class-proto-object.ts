/**
 * (#3976 slice 1) Standalone class prototypes as REAL ordinary objects.
 *
 * ## Why a representation change and not "prepend arms into the reflective natives"
 *
 * §15.7.14 installs every non-private class element on `C.prototype` with
 * `{writable: true, enumerable: false, configurable: true}`. In standalone
 * `C.prototype` was a `$ClassName` WasmGC struct with every field defaulted
 * (`expressions/extern.ts::emitLazyProtoGet`), so the own-property surface
 * answered "absent" for every method: `gOPD` → `undefined`,
 * `hasOwnProperty` → `false`.
 *
 * The issue's original slice-1 plan was to synthesize those answers by
 * prepending class-identity arms into `__hasOwnProperty` /
 * `__getOwnPropertyDescriptor` / `__propertyIsEnumerable` /
 * `__getOwnPropertyNames`. **That plan was measured to be worth zero on its own
 * stated population** (see the issue file): all 816 files in the class
 * own-property bucket assert `writable` AND `configurable`, and
 * `test262/harness/propertyHelper.js` probes those two BY MUTATING —
 * `isWritable` writes an unlikely value and reads it back (line 188/195),
 * `isConfigurable` deletes and re-checks `hasOwnProperty` (line 140/146). A
 * synthesized descriptor that cannot be written to or deleted from fails those
 * probes, so a presence-and-descriptor-only fix flips nothing. Faking the flags
 * would trade a missing property for a WRONG one, which is worse than the
 * status quo.
 *
 * Every one of those behaviours — presence, descriptor, enumerability,
 * for-in exclusion, write-through, delete, own-key enumeration — is exactly
 * what an ordinary object already does. So instead of re-implementing six
 * natives' worth of semantics behind class-identity guards, the prototype
 * singleton is built as a genuine `$Object` with the methods installed as own
 * data properties at §17 attributes. Every reflective native then answers
 * through its existing `$Object` path with no new arms at all.
 *
 * ## Why this is representation-safe
 *
 * `ctx.protoGlobals` has exactly three readers, and none of them inspects the
 * value: the producer here, `dynamic-proto.ts`'s hierarchy bookkeeping (index
 * only), and `__struct_proto_read`, which returns the global raw. The value
 * does reach `ref.test $ClassName` sites indirectly, and each behaviour change
 * moves TOWARD spec:
 *
 *  - `C.prototype instanceof C` was `true` (the defaulted proto struct carried a
 *    valid `__tag`); it is now `false`.
 *  - `hasOwnProperty(C.prototype, <instanceField>)` was `true` via the
 *    closed-struct arms; it is now `false` — instance fields are own properties
 *    of the INSTANCE, and several tests in this very cluster assert that.
 *  - `Object.getOwnPropertyNames(C.prototype)` returned the instance field
 *    names; it now returns the method names.
 *  - `C.prototype.<instanceField>` read the defaulted `0`/`null`; it is now
 *    `undefined`.
 *
 * The one thing that would REGRESS is `C.prototype.constructor`, which resolved
 * only by accident through `property-access.ts::tryEmitConstructorViaTag`'s
 * `__tag` dispatch. That is why `constructor` is installed as a real own
 * property here — spec-required (§15.7.14) and regression-preventing at once.
 *
 * ## Scope of this slice — deliberately the narrowest site with the measured effect
 *
 * Only `C.prototype`, only `ctx.standalone`, and only when the class has at
 * least one installable instance METHOD or ACCESSOR (#4455) and a class-object
 * singleton to point `constructor` at. In particular:
 *
 *  - The CLASS OBJECT (`__class_<C>`, the 179/816 static-receiver files) is NOT
 *    converted. `new-super.ts::emitDynamicNewFallback` `ref.test`s the
 *    class-object value against each `$ClassName` struct type BY DESIGN, so
 *    converting it would silently break value-bound `new K(...)`. Rolls to a
 *    later slice behind that blocker.
 *  - ACCESSORS were excluded by this slice and are handled since #4455 by
 *    `class-proto-accessors.ts` — as REAL accessor properties
 *    (`__defineProperty_accessor` → `$PropEntry.$get/$set`), never as a data
 *    property whose value is the getter function, which would be a silent wrong
 *    answer. `ctx.classMethodSet` still holds `ts.isMethodDeclaration` members
 *    only, so the method arm below is unchanged; the accessor arm keys off
 *    `ctx.classAccessorSet`.
 *  - PRIVATE elements are excluded: `resolveClassMemberName` mangles `#m` to
 *    `__priv_m`, which is not a spec-visible key and must never appear in the
 *    own-key surface. Several tests assert the private name is absent.
 *  - Classes with a builtin parent keep the legacy struct (they have no
 *    `classObjectGlobals` entry, so `constructor` could not be installed).
 *  - The `$Object`'s own `[[Prototype]]` is left null. It was effectively null
 *    before too, so this is behaviour-preserving; wiring `D.prototype.__proto__
 *    === C.prototype` and `%Object.prototype%` is a separate slice.
 */

import type { CodegenContext, FunctionContext } from "./context/types.js";
import type { Instr } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { emitCachedMethodClosureAccess } from "./closures.js";
import { classMemberFuncKey } from "./class-member-keys.js";
import { emitClassProtoAccessorInstalls, installableClassAccessors } from "./class-proto-accessors.js";

/**
 * §17 / §15.7.14 method descriptor attributes — `{writable: true,
 * enumerable: false, configurable: true}`. `__defineProperty_value` takes the
 * HOST flag encoding, whose bits 0/1/2 are the writable/enumerable/configurable
 * VALUES (bit 1 left clear ⇒ non-enumerable). Same constant the generator
 * prototype singleton uses (`array-object-proto.ts`).
 */
const METHOD_FLAGS = 0x01 | 0x04;

/** The `__priv_` prefix `resolveClassMemberName` gives `#private` element names. */
const PRIVATE_NAME_PREFIX = "__priv_";

/**
 * The instance methods of `className` that can be installed as own data
 * properties of its prototype: declared methods (not accessors, not statics,
 * not abstract), excluding private elements, and only those whose canonical
 * closure singleton is actually resolvable.
 */
function installableMethodNames(ctx: CodegenContext, className: string): string[] {
  const declared = ctx.classMethodNames.get(className);
  if (!declared || declared.length === 0) return [];
  const out: string[] = [];
  for (const name of declared) {
    if (name.startsWith(PRIVATE_NAME_PREFIX)) continue;
    const fullName = `${className}_${name}`;
    // `classMethodNames` folds accessors in with methods and carries no kind
    // tag; `classMethodSet` is populated from `ts.isMethodDeclaration` only, so
    // this membership test is what separates the two.
    if (!ctx.classMethodSet.has(fullName)) continue;
    if (ctx.staticMethodSet.has(fullName)) continue;
    if (ctx.funcMap.get(classMemberFuncKey(ctx, fullName)) === undefined) continue;
    out.push(name);
  }
  return out;
}

/**
 * True when {@link emitStandaloneClassProtoObject} would take over this class's
 * prototype. Pure predicate — no emission, no context mutation — so callers can
 * branch before committing to a body.
 */
export function standaloneClassProtoObjectApplies(ctx: CodegenContext, className: string): boolean {
  if (!ctx.standalone) return false;
  if (ctx.structMap.get(className) === undefined) return false;
  // No class-object singleton ⇒ no value to install `constructor` with, and
  // `tryEmitConstructorViaTag`'s `__tag` route would stop working. Keep the
  // legacy struct for those (builtin-parent subclasses, #1366a).
  if (ctx.classObjectGlobals?.get(className) === undefined) return false;
  // (#4455) An accessor-only class qualifies too. Before this, `class C { set
  // m(x) {} }` kept the legacy defaulted struct, so `gOPD(C.prototype,"m")`
  // answered `undefined` — the R1 residual of #4440. The accessor members are
  // installed as REAL accessor properties (`class-proto-accessors.ts`), never
  // as data properties holding the function.
  return installableMethodNames(ctx, className).length > 0 || installableClassAccessors(ctx, className).length > 0;
}

/**
 * Emit the lazy-initialized `$Object` prototype singleton for `className`,
 * leaving its externref on the stack. Returns `false` without emitting anything
 * if the object runtime cannot supply the helpers, in which case the caller
 * must fall back to the legacy defaulted-struct path.
 *
 * `emitClassObjectValue` is injected rather than imported to keep this module
 * free of a cycle back into `expressions/extern.ts`.
 */
export function emitStandaloneClassProtoObject(
  ctx: CodegenContext,
  fctx: FunctionContext,
  className: string,
  protoGlobalIdx: number,
  emitClassObjectValue: (ctx: CodegenContext, fctx: FunctionContext, className: string) => boolean,
): boolean {
  if (!standaloneClassProtoObjectApplies(ctx, className)) return false;

  ensureObjectRuntime(ctx);
  const newObjectIdx = ctx.funcMap.get("__new_plain_object");
  const defineIdx = ctx.funcMap.get("__defineProperty_value");
  if (newObjectIdx === undefined || defineIdx === undefined) return false;

  const structTypeIdx = ctx.structMap.get(className)!;
  const methodNames = installableMethodNames(ctx, className);
  const accessors = installableClassAccessors(ctx, className);
  // (#4455) The accessor store is a separate native from the data-property one;
  // a class that has accessors and cannot reach it must keep the legacy struct
  // rather than publish a prototype missing those members.
  if (accessors.length > 0 && ctx.funcMap.get("__defineProperty_accessor") === undefined) return false;

  const objLocal = allocLocal(fctx, `__class_proto_obj_${fctx.locals.length}`, { kind: "externref" });
  const initBody: Instr[] = [
    { op: "call", funcIdx: newObjectIdx },
    { op: "local.set", index: objLocal },
  ];

  // (#2182 pattern, same as `emitGeneratorPrototypeSingleton`) `savedBody` is
  // detached across the swap; register it in `liveBodies` so a late-import
  // funcidx shift walks it. This is NOT optional here — unlike the legacy
  // struct init, this body bakes `ref.func`s (via the method closure
  // singletons) and calls into helpers that can add late imports.
  const savedBody = fctx.body;
  fctx.body = initBody;
  ctx.liveBodies.add(savedBody);
  let ok = true;
  try {
    for (const name of methodNames) {
      const fullName = `${className}_${name}`;
      const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName))!;
      fctx.body.push({ op: "local.get", index: objLocal });
      addStringConstantGlobal(ctx, name);
      for (const instr of stringConstantExternrefInstrs(ctx, name)) fctx.body.push(instr);
      // The SAME canonical closure singleton the typed `C.prototype.m` read and
      // the dynamic `c.m` read both yield, so the §15.7 identities
      // `c.m === C.prototype.m === gOPD(C.prototype,"m").value` all hold.
      if (!emitCachedMethodClosureAccess(ctx, fctx, fullName, funcIdx, structTypeIdx)) {
        ok = false;
        break;
      }
      fctx.body.push({ op: "f64.const", value: METHOD_FLAGS });
      fctx.body.push({ op: "call", funcIdx: defineIdx });
      fctx.body.push({ op: "drop" }); // helper returns the target; discard
    }

    // (#4455) Accessors, after the methods so own-key order stays declaration
    // order for a body that mixes both (`classMethodNames` is one ordered list;
    // methods and accessors are two disjoint filters over it — a body that
    // interleaves them enumerates methods-then-accessors, which no test in the
    // measured population asserts and which the pre-#4455 tree could not
    // express at all, having no accessor keys to order).
    if (ok && !emitClassProtoAccessorInstalls(ctx, fctx, className, objLocal, structTypeIdx, accessors)) {
      ok = false;
    }

    if (ok) {
      // §15.7.14: `C.prototype.constructor` is an own property with the same
      // §17 attributes. Required for correctness AND to replace the accidental
      // `__tag` route in `tryEmitConstructorViaTag`, which no longer fires now
      // that the prototype is not a `$ClassName` struct.
      fctx.body.push({ op: "local.get", index: objLocal });
      addStringConstantGlobal(ctx, "constructor");
      for (const instr of stringConstantExternrefInstrs(ctx, "constructor")) fctx.body.push(instr);
      if (emitClassObjectValue(ctx, fctx, className)) {
        fctx.body.push({ op: "f64.const", value: METHOD_FLAGS });
        fctx.body.push({ op: "call", funcIdx: defineIdx });
        fctx.body.push({ op: "drop" });
      } else {
        // `standaloneClassProtoObjectApplies` already proved a class-object
        // global exists, so this is unreachable in practice; bail rather than
        // leave the key/receiver stranded on the stack.
        ok = false;
      }
    }

    if (ok) {
      fctx.body.push({ op: "local.get", index: objLocal });
      fctx.body.push({ op: "global.set", index: protoGlobalIdx });
    }
  } finally {
    fctx.body = savedBody;
    ctx.liveBodies.delete(savedBody);
  }
  if (!ok) return false;

  fctx.body.push({ op: "global.get", index: protoGlobalIdx });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: initBody, else: [] });
  fctx.body.push({ op: "global.get", index: protoGlobalIdx });
  return true;
}
