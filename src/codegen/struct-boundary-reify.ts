// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Which nominal object-literal STRUCTS must be reified as a `$Object` when they
 * cross to `externref` on a host-free target.
 *
 * Both members of this predicate exist for the same reason: once a struct's
 * `typeIdx` is erased at the boundary, whatever reads it afterwards has to find
 * its properties through the open `$Object` runtime — and the struct's own
 * closed representation cannot serve that reader. They were separate one-off
 * conditions in `type-coercion.ts`; collecting them here keeps that file (a
 * god-file under the #3102 budget) from growing per shape.
 */
import type { CodegenContext } from "./context/types.js";
import { isOpenDescriptorShape } from "./property-descriptor-shape.js";

/**
 * (#2358) Does a nominal OBJECT-LITERAL struct carry a USER ToPrimitive method —
 * `valueOf` / `@@toPrimitive` / `toString` — as a struct FIELD (stored as an
 * eqref/ref closure)? Used to gate the ref-struct→externref materialization:
 * such objects must cross the boundary as a `$Object` so `__to_primitive` can
 * dispatch the method once the typeIdx is erased (e.g. inside an `any` param);
 * plain data structs keep the byte-identical `extern.convert_any`.
 *
 * SCOPE: object literals only. A CLASS instance stores its methods as separate
 * `ClassName_<m>(self)` functions (NOT struct fields), so the field-copy
 * materializer cannot carry them onto the `$Object`; the class any-param case is
 * deferred to a follow-up (it has a partial `__call_<m>` / `$__shape_brand`
 * mechanism that wants its own slice). So this predicate matches FIELDS only.
 */
export function structHasUserToPrimitive(ctx: CodegenContext, name: string): boolean {
  const fields = ctx.structFields.get(name);
  if (fields) {
    for (const f of fields) {
      if (f.name === "valueOf" || f.name === "toString" || f.name === "@@toPrimitive") {
        if (f.type.kind === "ref" || f.type.kind === "ref_null" || f.type.kind === "eqref") return true;
      }
    }
  }
  return false;
}

/**
 * (#2358, #4491) The union consumed by the ref-struct→externref arm.
 */
export function structMustReifyAtExternrefBoundary(ctx: CodegenContext, name: string): boolean {
  if (structHasUserToPrimitive(ctx, name)) return true;
  // (#4491) An open-descriptor literal gets no closed-struct read arm
  // (`fillClosedStructExternGetArms` skips it), yet only the
  // `Object.defineProperty` call site ever reified one — so as an ordinary
  // function argument every field read `undefined`.
  //
  // This covers the ATTRIBUTES-ONLY shape (`{writable, enumerable,
  // configurable}`) as well as the value-carrying one. That is a deliberate
  // tech-lead decision, not an oversight: keeping attributes-only unreadable
  // held the standalone guard at a full score only because `verifyProperty`
  // SKIPS each attribute branch while `desc.X` reads `undefined` — a row that
  // passes by not asserting. See the unmasking list in the lane report.
  return isOpenDescriptorShape(name, ctx.structFields.get(name) ?? []);
}
