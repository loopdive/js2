// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 lane C1) The two places §15.7 makes `constructor` an OWN property that
 * the class's DECLARED elements do not mention.
 *
 * `object-ops.ts::compilePropertyIntrospection` folds
 * `hasOwnProperty` / `propertyIsEnumerable` on a class receiver from
 * `receiverType.getProperties()` — the declared elements. Two spec-mandated own
 * `constructor` keys are invisible to that walk, so the fold answered a constant
 * `false` for both:
 *
 *  1. **`C.prototype.constructor`** — ClassDefinitionEvaluation runs
 *     `MakeConstructor(F, false, proto)` (§15.7.14 step 8 / §10.2.5), which
 *     defines `constructor` on the prototype as `{value: F, writable: true,
 *     enumerable: false, configurable: true}`. It is not a class element, so it
 *     is not in the TS type. Measured 2026-09-26: standalone's prototype
 *     `$Object` (#3976) genuinely carries the property, so
 *     `gOPD(C.prototype,'constructor')` and
 *     `getOwnPropertyNames(C.prototype)[0]` both reported it own on the SAME
 *     object the fold called absent — an internal disagreement, not merely a
 *     missing feature.
 *
 *  2. **`C.constructor` when the class declares `static constructor(){}`** —
 *     §15.7 makes a static member whose PropName is "constructor" an ordinary
 *     static METHOD (a class may legally carry it *and* a real constructor), so
 *     it owns a key on the class object. TypeScript parses that spelling as a
 *     `ConstructorDeclaration` carrying `static`, so it is not a member of
 *     `typeof C` either. `static * constructor(){}` and
 *     `static get constructor(){}` parse as ordinary members and were already
 *     reported; only the plain-method spelling needs this.
 *
 * Both answers are target-independent — §15.7 says nothing about a host — so
 * neither is gated on `ctx.standalone`; the host lane was wrong in the same
 * direction and gains the same rows.
 */
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

/**
 * True when `constructor` must be reported as an own, NON-enumerable property of
 * this receiver even though it is absent from the receiver type's declared
 * properties.
 *
 * `isPrototypeReceiver` / `isConstructorReceiver` are the caller's already-computed
 * classification of `X.prototype` vs `typeof X`; this function only decides
 * whether the §15.7 `constructor` key applies to it.
 */
export function classConstructorIsOwnKey(
  ctx: CodegenContext,
  receiverType: ts.Type,
  isPrototypeReceiver: boolean,
  isConstructorReceiver: boolean,
): boolean {
  const symbol = receiverType.getSymbol();
  if (isPrototypeReceiver) {
    // Gated on the prototype's owner being a CLASS, not merely on the receiver
    // being spelled `X.prototype`: a generator function's `.prototype` is an
    // ordinary object with NO own `constructor`, and the builtin prototypes
    // (`Array.prototype` &c., whose TS symbol is an Interface) are answered by
    // `builtin-prototype-brand.ts`, not by this fold.
    return ((symbol?.flags ?? 0) & ts.SymbolFlags.Class) !== 0;
  }
  if (!isConstructorReceiver || symbol === undefined) return false;
  // A class EXPRESSION is collected under a synthetic codegen name, so the TS
  // symbol name is the lookup key only for a class DECLARATION;
  // `classExprNameMap` is the collector's own symbol→synthetic bridge. Without
  // it the `var C = class { static constructor(){} }` spelling missed and only
  // 3 of the 4 reachable test262 rows flipped (measured 2026-09-26).
  const className = ctx.classExprNameMap.get(symbol.name) ?? symbol.name;
  // `classStaticMethodNames` is the collector that already resolved the
  // static-`constructor` rule (#5195 r3-4); reading it here keeps the
  // own-property answer from diverging from the install it describes.
  return (ctx.classStaticMethodNames.get(className) ?? []).includes("constructor");
}
