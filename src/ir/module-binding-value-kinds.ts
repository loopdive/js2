// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";

/** Opaque externref whose producer and uses belong to one explicit provider. */
export interface IrModuleCapabilityExternValueKind {
  readonly kind: "capability-extern";
  readonly capability: "dom";
  readonly className: string;
}

export type IrModuleBindingValueKind =
  | { readonly kind: "f64" }
  | { readonly kind: "i32"; readonly semantic: "boolean" }
  // (#4208 S2 / #5289) A binding whose value is DYNAMIC — an `any`/`unknown`
  // declaration, or one a `++`/`--` retypes. Deliberately ONE kind for both
  // LANES (the `fast` flag, not the target): the source-level fact is "this
  // slot holds a JS value of unproven type", and the physical carrier —
  // `externref` in compatibility, `(ref null $AnyValue)` in fast — is the
  // lane's to pick. Both sides of the boundary pick it from `ctx.fast` alone
  // (`resolveWasmType` allocates the legacy slot, `resolveIrDynamicCarrierType`
  // resolves the IR one), so `resolveModuleBindingGlobal` arbitrates them as a
  // real agreement test rather than reinterpreting either.
  | { readonly kind: "dynamic" }
  | { readonly kind: "extern"; readonly className: string }
  | IrModuleCapabilityExternValueKind
  // (#4461) Host-free lanes lower `Map` to the WasmGC-native `$Map` struct
  // (#1103a), NOT to an externref host handle. That is a different physical
  // carrier — `(ref null $Map)` vs `externref` — so it remains distinct from
  // both ambient and capability-authenticated externref storage.
  | { readonly kind: "native-map"; readonly className: "Map" }
  // (#3523 R4-M1) A `string` module binding. Deliberately ONE kind for both
  // string backends (#679): the source-level fact is "this slot holds a JS
  // string", and the physical carrier — `externref` under host strings,
  // `(ref null $AnyString)` under `nativeStrings` — is the backend's to pick,
  // exactly as `IrType.string` defers to `IrLowerResolver.resolveString`. The
  // legacy slot is resolved against the ACTIVE backend's carrier in
  // `resolveModuleBindingGlobal`, so a lane whose allocation disagrees fails
  // the storage-agreement check there rather than silently reinterpreting it.
  | { readonly kind: "string" };

export interface IrModuleCapabilityExternCertification {
  readonly capability: "dom";
  readonly className: string;
}

/**
 * Exact provider-owned module-storage admission. A resolver must prove both
 * the source declaration and, when present, the concrete value written to it.
 * It remains separate from ambient-host admission so an explicit capability
 * cannot reopen generic extern storage.
 */
export type IrModuleCapabilityExternResolver = (
  declaration: ts.VariableDeclaration,
  writeValue?: ts.Expression,
) => IrModuleCapabilityExternCertification | undefined;

/** True for either carrier of a builtin `Map` module binding (#4461). */
export function isIrModuleMapValueKind(valueKind: IrModuleBindingValueKind): boolean {
  return valueKind.kind === "native-map" || (valueKind.kind === "extern" && valueKind.className === "Map");
}

/**
 * True when a binding exposes a reference carrier whose consumers need the
 * conservative extern discipline: ambient/capability externref, native Map, or
 * (#3523 R4-M1) a string.
 *
 * A string module binding joins this set because BOTH of its carriers are
 * reference-shaped and opaque to a shape-only selector — `externref` on the
 * host lane, `(ref null $AnyString)` on the native one. Admitting it as a
 * "scalar" instead would let the f64/boolean expression arms claim shapes
 * (unboxed `throw`, numeric method dispatch) whose string lowering was never
 * proven. A site that later earns a proven string lowering should test
 * `valueKind.kind === "string"` at that site rather than widen this predicate.
 *
 * (#5289) `dynamic` is deliberately NOT a member, even though both of ITS
 * carriers are reference-shaped too. The hazard this predicate exists to stop
 * — a scalar arm claiming a shape whose lowering was never proven — is already
 * stopped for `dynamic` at the site that matters: `moduleScalarExpressionFamily`
 * (`src/ir/select.ts`) returns `undefined` for a dynamic binding rather than
 * falling through to the initializer's static family. That is the "test the
 * kind at the site" discipline this comment asks for, already applied. Widening
 * here instead would change every existing #4208 retype binding's consumer
 * discipline, which this issue did not measure.
 */
export function isIrModuleReferenceValueKind(valueKind: IrModuleBindingValueKind): boolean {
  return (
    valueKind.kind === "extern" ||
    valueKind.kind === "capability-extern" ||
    valueKind.kind === "native-map" ||
    valueKind.kind === "string"
  );
}

export function isCapabilityExternKind(
  valueKind: IrModuleBindingValueKind,
): valueKind is IrModuleCapabilityExternValueKind {
  return valueKind.kind === "capability-extern";
}

/** Convert one exact provider certification into the persistent storage kind. */
export function resolveCapabilityExternKind(
  resolver: IrModuleCapabilityExternResolver | undefined,
  declaration: ts.VariableDeclaration,
  writeValue?: ts.Expression,
): IrModuleCapabilityExternValueKind | undefined {
  const certified = resolver?.(declaration, writeValue);
  return certified
    ? {
        kind: "capability-extern",
        capability: certified.capability,
        className: certified.className,
      }
    : undefined;
}

/** Re-certify every write against the declaration's frozen provider kind. */
export function capabilityExternWriteMatches(
  resolver: IrModuleCapabilityExternResolver | undefined,
  declaration: ts.VariableDeclaration,
  value: ts.Expression,
  target: IrModuleCapabilityExternValueKind,
): boolean {
  const certified = resolver?.(declaration, value);
  return certified?.capability === target.capability && certified.className === target.className;
}

/** Project only externref-backed binding kinds to their declared class. */
export function externBoundaryClassName(valueKind: IrModuleBindingValueKind): string | undefined {
  return valueKind.kind === "extern" || valueKind.kind === "capability-extern" ? valueKind.className : undefined;
}
