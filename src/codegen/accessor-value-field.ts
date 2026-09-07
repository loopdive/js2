// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";

/**
 * (#5376) True when a struct property's VALUE is an object literal that carries
 * a `get`/`set` accessor — i.e. a value `compileObjectLiteralWithAccessors`
 * builds at runtime as a HOST externref (`__new_plain_object` +
 * `__defineProperty_accessor`), never as a WasmGC struct.
 *
 * TypeScript types such a property from the getter's RETURN type, so
 * `resolveWasmType` picks a `(ref null $__anon_N)` field for it. The store then
 * emits `any.convert_extern` + `ref.test $__anon_N`, which a host object always
 * fails, and the `else` arm writes `ref.null` — the accessor object is SILENTLY
 * DROPPED. `o.v` reads back null, so `Number(o.v)` answers 0 with the getter
 * never invoked. That is the exact shape `TemporalHelpers.toPrimitiveObserver`
 * mints (`{ v: { get valueOf() { return () => 3 } } }`), which is why the
 * observer rows and the three `intl402/Temporal/**\/infinity-throws-rangeerror.js`
 * rows failed with the observer's `calls` array EMPTY.
 *
 * Callers widen the field to externref, which preserves the value and lets the
 * host `_toPrimitive` walker see a real JS object with a real accessor
 * descriptor — the same path that already made a DIRECT `Number({ get valueOf()
 * {…} })` work. This is #1589A's treatment of an empty object literal
 * (externref at runtime, struct ref in the type) applied one step further.
 *
 * Deliberately NOT extended to the other `objectLiteralForcesHostPath` reasons
 * (runtime computed key, `[Symbol.dispose]`, empty-string key, colon
 * `__proto__`, spread-in-non-specific-context). They share the null-drop
 * mechanism and are recorded in the issue as reported-not-fixed; widening the
 * predicate to them is a separate, separately-measured change. Lives in its own
 * module because `src/codegen/index.ts` cannot import `literals.ts`
 * (index↔literals cycle) where `objectLiteralForcesHostPath` lives.
 */
export function propertyValueIsAccessorObjectLiteral(prop: ts.Symbol): boolean {
  return (prop.declarations ?? []).some(
    (d) =>
      ts.isPropertyAssignment(d) &&
      ts.isObjectLiteralExpression(d.initializer) &&
      d.initializer.properties.some((p) => ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)),
  );
}
