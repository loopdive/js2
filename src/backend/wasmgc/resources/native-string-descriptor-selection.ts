// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import type { NativeObjectStorageDependencies } from "./native-object-storage.js";
import {
  requireNativeStringOwnDescriptorReservations,
  requireCompletedNativeStringOwnDescriptors,
  type NativeStringOwnDescriptorReservations,
  type NativeStringOwnDescriptorDependencies,
} from "./native-string-exotic-own-descriptors.js";

/** Selection data is authenticated against the actual shared String and ordinary owners. */
export interface NativeStringDescriptorSelection {
  readonly pack: NativeStringOwnDescriptorReservations;
  readonly dependencies: NativeStringOwnDescriptorDependencies;
}
function fail(detail: string): never {
  throw Error("native String descriptor selection: " + detail);
}
export function readNativeStringDescriptorSelection(
  tx: PhysicalModuleReservations,
  input: object,
  storage: NativeObjectStorageDependencies,
): NativeStringDescriptorSelection | undefined {
  const field = Object.getOwnPropertyDescriptor(input, "stringOwn");
  if (!field) return undefined;
  if (!Object.hasOwn(field, "value")) fail("non-data selection");
  if (field.value === undefined) return undefined;
  const selection: unknown = field.value;
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) fail("plain selection required");
  const prototype = Object.getPrototypeOf(selection);
  if (prototype !== null && prototype !== Object.prototype) fail("plain selection required");
  const fields = Object.getOwnPropertyDescriptors(selection);
  if (Reflect.ownKeys(fields).some((key) => key !== "pack" && key !== "dependencies")) fail("unknown selection field");
  for (const key of ["pack", "dependencies"])
    if (!Object.hasOwn(fields, key) || !Object.hasOwn(fields[key]!, "value")) fail("missing/non-data " + key);
  const pack = fields.pack!.value as NativeStringOwnDescriptorReservations;
  const dependencies = fields.dependencies!.value as NativeStringOwnDescriptorDependencies;
  requireNativeStringOwnDescriptorReservations(tx, pack, dependencies);
  if (dependencies.lookup !== storage.lookup || dependencies.lookupDependencies !== storage.lookupDependencies)
    fail("different ordinary lookup/layout/String owners");
  return Object.freeze({ pack, dependencies });
}
export function assertNativeStringDescriptorSelectionCurrent(
  current: NativeStringDescriptorSelection | undefined,
  original: NativeStringDescriptorSelection | undefined,
): void {
  if (current?.pack !== original?.pack || current?.dependencies !== original?.dependencies)
    fail("changed issued selection");
}
export function requireCompletedNativeStringDescriptorSelection(
  tx: PhysicalModuleReservations,
  selection: NativeStringDescriptorSelection | undefined,
): void {
  if (selection) requireCompletedNativeStringOwnDescriptors(tx, selection.pack, selection.dependencies);
}
