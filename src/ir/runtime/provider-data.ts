// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { hasNativeCollectionState } from "../core/native-data-slots.js";
import type { RuntimeProviderDefinition } from "./contracts/manifest.js";

/** Read an exact record/array surface without invoking its fields. */
function fields(value: unknown, names: readonly string[], array = false): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) !== array) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if ((!array && prototype !== null && prototype !== Object.prototype) || hasNativeCollectionState(value))
    return undefined;
  if (Reflect.ownKeys(value).length !== names.length) return undefined;
  const result: Record<string, unknown> = Object.create(null);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !("value" in descriptor)) return undefined;
    result[name] = descriptor.value;
  }
  return result;
}
function scalarArray(value: unknown, expected: readonly string[]): boolean {
  const names = expected.map((_, index) => String(index));
  const data = fields(value, ["length", ...names], true);
  return !!data && data.length === expected.length && names.every((name, index) => data[name] === expected[index]);
}
function externalType(value: unknown): boolean {
  const type = fields(value, ["kind", "val"]);
  return type?.kind === "val" && fields(type.val, ["kind"])?.kind === "externref";
}
function errorSignature(value: unknown): boolean {
  const signature = fields(value, ["version", "params", "result"]);
  const params = fields(signature?.params, ["length", "0"], true);
  return (
    signature?.version === 1 && params?.length === 1 && externalType(params["0"]) && externalType(signature.result)
  );
}

/** Finite class-allocation/error provider contract; no arbitrary IR types or recursive snapshot data. */
export function runtimeProviderDataMismatch(expected: RuntimeProviderDefinition, actual: unknown): string | undefined {
  const keys = [
    "id",
    "feature",
    "dependencies",
    "hostCapabilities",
    "supportedTargets",
    "supportedBackends",
    "implementation",
  ];
  if (expected.signature) keys.push("signature");
  const data = fields(actual, keys);
  if (!data || data.id !== expected.id || data.feature !== expected.feature) return "provider fields";
  for (const name of ["dependencies", "hostCapabilities", "supportedTargets", "supportedBackends"] as const)
    if (!scalarArray(data[name], expected[name])) return name;
  const implementation = expected.implementation;
  if (implementation.kind !== "runtime-callable" && implementation.kind !== "host-callable")
    return "unsupported canonical implementation";
  const field = implementation.kind === "runtime-callable" ? "symbol" : "capability";
  const supplied = fields(data.implementation, ["kind", field]);
  const expectedName = implementation.kind === "runtime-callable" ? implementation.symbol : implementation.capability;
  if (supplied?.kind !== implementation.kind || supplied[field] !== expectedName) return "implementation";
  if (expected.signature && (!errorSignature(expected.signature) || !errorSignature(data.signature)))
    return "signature";
  return undefined;
}
