// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * Receiver-independent native builtin values using the canonical argv-vector
 * ABI. Registration, alias preparation and dynamic apply identity guards must
 * consult the same population; signature equality alone also admits user code.
 */
export const VARIADIC_VALUE_STATICS: ReadonlySet<string> = new Set([
  "Math.max",
  "Math.min",
  "String.fromCharCode",
  "Object.assign",
]);

export function isVariadicValueStatic(builtinName: string, propName: string): boolean {
  return VARIADIC_VALUE_STATICS.has(`${builtinName}.${propName}`);
}
