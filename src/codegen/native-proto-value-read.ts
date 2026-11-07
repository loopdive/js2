// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#2984 Phase 2) Standalone `<Builtin>.prototype.<member>` VALUE-read
// resolution policy — the subsystem module behind
// `tryCompileStandaloneBuiltinProtoMemberRead` (property-access.ts).
//
// A builtin-proto member value read resolves in three tiers:
//
//   1. OWN member (advertised in the receiver brand's glue CSV) — the
//      brand-keyed native-method/getter closure. Members whose native body is
//      not wired yet reify through the factory's `refusalBodyFallback`
//      (methods only): an identity-stable closure with spec `.name`/`.length`
//      whose INVOCATION throws a catchable TypeError (the #2193/#2651
//      degrade-to-catchable pattern). This is what makes the ES5 gOPD
//      identity assertion (`gOPD(Date.prototype, "getTime").value ===
//      Date.prototype.getTime`) hold — the #2885 Site-2 descriptor synthesis
//      (calls.ts) and this value read share one singleton per (brand, member).
//   2. INHERITED member — not own, but advertised by `Object.prototype`'s
//      glue. Every builtin prototype ultimately inherits Object.prototype's
//      methods, and the spec value of the inherited read IS the
//      Object.prototype member itself: `Function.prototype.valueOf ===
//      Object.prototype.valueOf` (Sputnik S15.3.4_A4). Resolve through the
//      OBJECT-brand singleton so both syntactic reads yield the same value.
//      NOTE: gOPD keeps own-property semantics — the Site-2 synthesis gates on
//      the receiver's OWN CSV and returns `undefined` for inherited members.
//   3. UNKNOWN member — `null`: the caller falls through to the dynamic path
//      (runtime `undefined`), never minting a phantom closure. (Pre-#2984 the
//      Array family could mint a throwing closure for an unknown member — the
//      `emitArrayProtoMemberBody` non-slice arm accepts any name — so the own-
//      CSV gate here also tightens that latent hole to spec `undefined`.)
//
// The reflective `.call(...)` route (`emitReflectiveNativeProtoClosureCall`,
// calls.ts) deliberately does NOT use this resolver: it relies on the
// factory's null return to fall through to its working legacy lowering
// (`Object.prototype.hasOwnProperty.call(o, k)` — the propertyHelper.js
// idiom), and a throwing refusal body would regress it.

import type { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import {
  getNativeProtoBuiltinGlue,
  ensureStandaloneNativeMethodClosure,
  withProvisionalNativeProtoGlue,
} from "./native-proto.js";
import { ensureObjectNativeProtoGlue } from "./array-object-proto.js";
import type { Instr, ValType } from "../ir/types.js";
import { pushBuiltinFnSingletonValueInstrs } from "./builtin-fn-meta.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { tryEnsureNativeProtoBrand } from "./property-access.js";
import { addFuncType } from "./registry/types.js";
import { ensureLateImport } from "./shared.js";
import { sourceOverridesBuiltinPrototypeMember } from "./builtin-proto-member-override.js";
import { builtinProtoMemberSymbol, type BuiltinProtoMemberRole } from "../shared/ambient-intrinsics.js";

/** The `{ type, funcIdx }` closure handle the native-method factory returns. */
export type NativeProtoClosure = { type: { kind: "ref"; typeIdx: number }; funcIdx: number };

/**
 * Resolve a standalone `<Builtin>.prototype.<member>` VALUE read to its
 * native-method/getter closure per the three-tier policy above. Returns the
 * closure plus the resolved kind (`"getter"` only for OWN accessor members —
 * the caller invokes those instead of returning the closure value), or `null`
 * to fall through to the dynamic path.
 */
export function resolveStandaloneProtoMemberValueClosure(
  ctx: CodegenContext,
  brand: number,
  builtinName: string,
  member: string,
): { closure: NativeProtoClosure; kind: "method" | "getter" } | null {
  const glue = getNativeProtoBuiltinGlue(ctx, brand);
  if (!glue) return null;

  // Tier 1 — own member.
  if (glue.memberCsv.split(",").includes(member)) {
    const kind = glue.memberKind(member);
    // Annex B §B.2.6 defines toGMTString as the same function object as
    // toUTCString. Value reads bypass prototype seeding, so canonicalize here
    // as well as in the seeded-property path.
    const closureMember = builtinName === "Date" && member === "toGMTString" ? "toUTCString" : member;
    // (#5194 step 2) §23.2.3.32 — a member whose initial value IS another
    // prototype's function object resolves to that brand's singleton.
    const closureBrand = glue.memberBrandAliasOf?.(ctx, member) ?? brand;
    const closure = ensureStandaloneNativeMethodClosure(ctx, closureBrand, closureMember, kind, {
      refusalBodyFallback: true,
    });
    return closure ? { closure, kind } : null;
  }

  // Tier 1.5 (#5194 step 1) — inherited from the glue's declared PARENT level.
  // `Uint8Array.prototype` owns no methods (§23.2.7); `Uint8Array.prototype.map`
  // resolves through `%TypedArray%.prototype`'s glue, and deliberately to the
  // PARENT brand's closure singleton, so `Uint8Array.prototype.map ===
  // TypedArray.prototype.map` holds by `ref.eq` — which is exactly what the
  // `gOPD(TypedArray.prototype, m).value === TA.prototype[m]` rows compare.
  const parentBrand = glue.parentBrand;
  if (parentBrand !== undefined && parentBrand !== brand) {
    const parentGlue = getNativeProtoBuiltinGlue(ctx, parentBrand);
    if (parentGlue && parentGlue.memberCsv.split(",").includes(member)) {
      const kind = parentGlue.memberKind(member);
      const closure = ensureStandaloneNativeMethodClosure(ctx, parentBrand, member, kind, {
        refusalBodyFallback: true,
      });
      if (closure) return { closure, kind };
    }
  }

  // Tier 2 — inherited from Object.prototype (methods only; Object.prototype
  // itself advertises no accessor getters in its glue CSV).
  if (builtinName !== "Object") {
    const objBrand = ensureObjectNativeProtoGlue(ctx);
    const objGlue = objBrand !== undefined ? getNativeProtoBuiltinGlue(ctx, objBrand) : undefined;
    if (
      objBrand !== undefined &&
      objGlue &&
      objGlue.memberCsv.split(",").includes(member) &&
      objGlue.memberKind(member) === "method"
    ) {
      const closure = ensureStandaloneNativeMethodClosure(ctx, objBrand, member, "method", {
        refusalBodyFallback: true,
      });
      if (closure) return { closure, kind: "method" };
    }
  }

  // Tier 3 — unknown member: dynamic fall-through.
  return null;
}

/**
 * (#7294) Compiler-support functions for an OWN member of a standalone builtin
 * prototype (`<B>.prototype.<m>`), keyed by (builtin, member):
 *
 *   - the VALUE getter returns the member's identity-stable singleton closure
 *     (`pushBuiltinFnSingletonValueInstrs`), the same function object every
 *     other `<B>.prototype.<m>` value read and the prototype companion seeder
 *     materialize;
 *   - the DESCRIPTOR builder returns `Object.getOwnPropertyDescriptor(
 *     <B>.prototype, "<m>")`: a data descriptor `{value, writable, configurable}`
 *     for a method, an accessor descriptor `{get, configurable}` for a getter,
 *     with the value getter's closure as `value` / `get`.
 *
 * Both are named functions so legacy's `gOPD(<B>.prototype, "<m>")` arm and the
 * IR (through `resolver.resolveFunc` on the runtime symbol) call the SAME
 * synthesis. Only the standalone lanes reach them: the native-proto glue is
 * standalone-only, and the IR resolves the runtime symbol only after the
 * selector's standalone-gated admission.
 */
const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };
/** §6.1.7.1 attribute bits `__create_descriptor` / `__create_accessor_descriptor` read. */
const FLAG_WRITABLE = 0x01;
const FLAG_CONFIGURABLE = 0x04;

/**
 * The member's kind when `<builtin>.prototype` OWNS `member` in the registered
 * native-proto glue (registering the glue on demand), else `undefined`. An
 * inherited member is not own, so `gOPD` must not answer it from here.
 */
export function builtinProtoOwnMemberKind(
  ctx: CodegenContext,
  builtin: string,
  member: string,
): "method" | "getter" | undefined {
  const brand = tryEnsureNativeProtoBrand(ctx, builtin);
  const glue = brand === undefined ? undefined : getNativeProtoBuiltinGlue(ctx, brand);
  return glue?.memberCsv.split(",").includes(member) ? glue.memberKind(member) : undefined;
}

/**
 * (#7294) The member's kind when the IR may answer `<builtin>.prototype.<member>`
 * (or its descriptor) through the support function — an own glue member,
 * on a native lane that is not fast mode (the result is the externref dynamic
 * carrier), that the source does not override (`anchor`'s file; an
 * overridden member is a runtime value, read dynamically as legacy does).
 */
export function builtinProtoMemberProvided(
  ctx: CodegenContext,
  builtin: string,
  member: string,
  anchor: ts.Node,
): "method" | "getter" | undefined {
  if (!ctx.standalone || ctx.fast || sourceOverridesBuiltinPrototypeMember(anchor, builtin, member)) return undefined;
  return withProvisionalNativeProtoGlue(ctx, () => builtinProtoOwnMemberKind(ctx, builtin, member));
}

/**
 * The instruction sequence for `role`, leaving one externref on the stack;
 * `undefined` when the member is not an own glue member or its natives are
 * unavailable. The ONE synthesis: legacy's `gOPD(<B>.prototype, "<m>")` arm
 * inlines it (its bytes unchanged), and {@link ensureBuiltinProtoMemberFunc}
 * wraps it as the support function the IR calls. May register late imports, so
 * a caller with a body in flight flushes the import shifts before pushing it.
 */
export function builtinProtoMemberInstrs(
  ctx: CodegenContext,
  role: BuiltinProtoMemberRole,
  builtin: string,
  member: string,
): Instr[] | undefined {
  const kind = builtinProtoOwnMemberKind(ctx, builtin, member);
  if (kind === undefined) return undefined;
  const brand = tryEnsureNativeProtoBrand(ctx, builtin)!;
  // (#2984 Phase 2) Un-wired members use identity-stable throwing closures so
  // the value and the descriptor stay spec-shaped.
  const closure = ensureStandaloneNativeMethodClosure(ctx, brand, member, kind, { refusalBodyFallback: true });
  if (!closure) return undefined;
  // (#2175 V2-S2) The identity-stable singleton: the same function object as
  // every other `<B>.prototype.<m>` value read, and the descriptor's value/get.
  const value = (): Instr[] => [...pushBuiltinFnSingletonValueInstrs(ctx, closure), { op: "extern.convert_any" }];
  if (role === "value") return value();
  if (kind === "getter") {
    const createIdx = ensureLateImport(ctx, "__create_accessor_descriptor", [EXTERNREF, EXTERNREF, I32], [EXTERNREF]);
    if (createIdx === undefined) return undefined;
    // get = the closure, set = undefined, configurable, non-enumerable.
    return [
      ...value(),
      { op: "ref.null.extern" },
      { op: "i32.const", value: FLAG_CONFIGURABLE },
      { op: "call", funcIdx: createIdx },
    ];
  }
  const createIdx = ensureLateImport(ctx, "__create_descriptor", [EXTERNREF, I32], [EXTERNREF]);
  if (createIdx === undefined) return undefined;
  // value = the closure, writable, configurable, non-enumerable.
  return [
    ...value(),
    { op: "i32.const", value: FLAG_WRITABLE | FLAG_CONFIGURABLE },
    { op: "call", funcIdx: createIdx },
  ];
}

/** The support function wrapping {@link builtinProtoMemberInstrs}, minted once per (role, builtin, member). */
export function ensureBuiltinProtoMemberFunc(
  ctx: CodegenContext,
  role: BuiltinProtoMemberRole,
  builtin: string,
  member: string,
): number | undefined {
  const name = builtinProtoMemberSymbol(role, builtin, member);
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;
  const body = builtinProtoMemberInstrs(ctx, role, builtin, member);
  if (body === undefined) return undefined;
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name,
    typeIdx: addFuncType(ctx, [], [EXTERNREF], `$${name}_type`),
    locals: [],
    body,
    exported: false,
  });
  ctx.funcMap.set(name, funcIdx);
  return funcIdx;
}
