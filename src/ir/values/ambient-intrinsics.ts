// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7106) Ambient intrinsics the IR reads as VALUES — `assert.throws(TypeError,
 * fn)`, `Object.prototype`. Each is a property of the realm's
 * global object (§19.1, §19.3), so the IR reads it as `dyn.member_get` off
 * `dyn.global_object`: the same object, and so the same constructor identity,
 * legacy's own `globalThis` read yields. Names outside this list keep the
 * existing refusal; the selector also requires the identifier to resolve to
 * its lib declaration (never a user binding of the same name). `globalThis`
 * itself is not listed: the checker synthesizes it without a lib declaration.
 */
const AMBIENT_INTRINSIC_VALUE_NAMES: ReadonlySet<string> = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "EvalError",
  "URIError",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Symbol",
  "Function",
]);

export function isAmbientIntrinsicName(name: string): boolean {
  return AMBIENT_INTRINSIC_VALUE_NAMES.has(name);
}
