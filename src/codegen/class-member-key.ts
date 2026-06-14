// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1983 — collision-free synthetic naming for USER-class members.
//
// Class methods/getters/setters are registered in `ctx.funcMap` /
// `ctx.classMethodSet` / `ctx.staticMethodSet` under a synthetic name derived
// from the class name and the member name. The historical convention was
// `${className}_${member}` — but `_` is a valid TS identifier character, so a
// user-defined top-level `function A_m()` collided with the method `A.m` (both
// keyed `A_m`). The second registration overwrote the first, so `new A().m()`
// and `A_m()` resolved to the same funcIdx with mismatched signatures → runtime
// trap (legacy) / invalid Wasm (IR). (#1983)
//
// `#` cannot appear in a TS identifier, so a `${className}#${member}` key can
// never be produced by user code. These synthetic keys are internal to codegen —
// they are NOT the exported function names (those come from the user-facing
// identifier), so the mangled separator never leaks into exports or WIT.
//
// CRITICAL: the SAME `${name}_${member}` convention also keys **extern/host
// class** members — `Array_push`, `Map_get`, `Map_new`, `String_charAt` are real
// `env` host-import names (`importPrefix === className`, index.ts). Those MUST
// stay `_`-joined or `WebAssembly.instantiate` fails on an unsatisfiable import.
// The discriminator is `ctx.classSet`, which holds ONLY user-class names; extern
// classes register via `ctx.externClasses` and are absent from `classSet`. So a
// member key is mangled iff its receiver is a user class.
//
// Every site that BUILDS or LOOKS UP a class-member funcMap key must go through
// `userClassMemberKey` so the separator is consistent across registration and
// dispatch. Missing one user-class lookup silently breaks method dispatch;
// wrongly mangling an extern key breaks host-class dispatch. This is the single
// source of truth.

import type { CodegenContext } from "./context/types.js";

/** Separator for synthetic user-class member keys — not a valid TS identifier char. */
export const CLASS_MEMBER_SEP = "#";

/**
 * Build the synthetic funcMap / method-set key for a class member.
 *
 * Mangles to `${className}#${member}` ONLY when `className` is a user class
 * (`ctx.classSet.has(className)`); otherwise returns the legacy
 * `${className}_${member}` so extern/host-class keys (which are real `env`
 * import names) are left untouched.
 *
 * `member` is the resolved member suffix — a method name (`m`), getter
 * (`get_x`), or setter (`set_x`).
 */
export function userClassMemberKey(ctx: CodegenContext, className: string, member: string): string {
  return ctx.classSet.has(className) ? `${className}${CLASS_MEMBER_SEP}${member}` : `${className}_${member}`;
}

/**
 * The `${className}<sep>` prefix used by member keys for `className`, with the
 * separator chosen the same way as {@link userClassMemberKey}. Use this for the
 * inheritance walk that scans `ctx.funcMap` for `key.startsWith(prefix)` and
 * extracts the member suffix via `key.substring(prefix.length)`.
 */
export function userClassMemberPrefix(ctx: CodegenContext, className: string): string {
  return ctx.classSet.has(className) ? `${className}${CLASS_MEMBER_SEP}` : `${className}_`;
}
