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
  | { readonly kind: "dynamic" }
  | { readonly kind: "extern"; readonly className: string }
  | IrModuleCapabilityExternValueKind
  // (#4461) Host-free lanes lower `Map` to the WasmGC-native `$Map` struct
  // (#1103a), NOT to an externref host handle. That is a different physical
  // carrier — `(ref null $Map)` vs `externref` — so it remains distinct from
  // both ambient and capability-authenticated externref storage.
  | { readonly kind: "native-map"; readonly className: "Map" };

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
 * conservative extern discipline: ambient/capability externref or native Map.
 */
export function isIrModuleReferenceValueKind(valueKind: IrModuleBindingValueKind): boolean {
  return valueKind.kind === "extern" || valueKind.kind === "capability-extern" || valueKind.kind === "native-map";
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
