// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/** Identity/payload roles only. This is NOT a complete member/property catalog. */
export const NATIVE_PRIMITIVE_PROTOTYPE_IDENTITIES = Object.freeze([
  Object.freeze({ kind: "Boolean", intrinsic: "%Boolean.prototype%", payload: "false" }),
  Object.freeze({ kind: "Number", intrinsic: "%Number.prototype%", payload: "+0" }),
  Object.freeze({ kind: "String", intrinsic: "%String.prototype%", payload: "empty-string" }),
  Object.freeze({ kind: "Symbol", intrinsic: "%Symbol.prototype%", payload: "absent" }),
  Object.freeze({ kind: "BigInt", intrinsic: "%BigInt.prototype%", payload: "absent" }),
] as const);
export type NativePrimitivePrototypeKind = (typeof NATIVE_PRIMITIVE_PROTOTYPE_IDENTITIES)[number]["kind"];
