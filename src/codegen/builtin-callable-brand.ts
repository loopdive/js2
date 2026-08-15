// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4120) The `[[Call]]` brand on a reified builtin CONSTRUCTOR/FUNCTION
 * carrier, and the single predicate the three standalone `typeof` natives share
 * to read it.
 *
 * ## The measured defect
 *
 * `typeof` is one of the few operators that cannot throw, so a wrong answer is a
 * SILENT wrong answer. Measured on the standalone lane (main `609c995ce`,
 * through a one-parameter indirection so the constant-folded static path is not
 * what gets probed — see [[reference_constant_folded_probe_tests_the_static_path]]):
 *
 * | reified builtin                          | `typeof` was | should be    |
 * | ---------------------------------------- | ------------ | ------------ |
 * | `Set` `Map` `WeakMap` `RegExp` `Array` …  | `"object"`   | `"function"` |
 * | `TypeError` `RangeError` `Error` …        | `"object"`   | `"function"` |
 * | `Math` `JSON` `Reflect`                   | `"object"`   | `"object"` ✓ |
 * | `Array.from` `Object.keys` `Math.max`     | `"function"` | `"function"` ✓ |
 *
 * The static-METHOD row already works: those reify through
 * `ensureStandaloneBuiltinStaticMethodClosure`, whose value is a genuine
 * closure-wrapper struct that `fillStandaloneTypeofClosureArms` already
 * recognises. The CONSTRUCTOR row does not, because #3006 / #2907 back it with a
 * plain `$Object` singleton (`__new_plain_object`) — deliberately, since that
 * carrier is what makes `Set.prototype.constructor === Set` genuinely true and
 * what owns the §17/§20 `length`/`name`/`prototype` data properties.
 *
 * ## Why a flag bit and not a distinct struct type
 *
 * `$Object` is a CLOSED (final) struct on purpose: opening it up for a subtype
 * triggered WasmGC iso-recursive canonicalization and produced a wrong-arity
 * `struct.new` (#1100/#2009, documented at the `$Object` declaration). So the
 * brand rides the existing `(mut i32) flags` slot as `OBJ_FLAG_CALLABLE`, which
 * leaves the carrier's REPRESENTATION — and therefore its identity, its own
 * properties and every existing MOP path — byte-for-byte unchanged. Every other
 * `flags` reader masks only its own bit, so the new bit is inert to them.
 *
 * `Math`/`JSON`/`Reflect` are NOT branded: `typeof Math === "object"` is
 * correct, and the brand is applied from `pushBuiltinCtorOwnPropSeed`, which
 * already declines for exactly those three (they have no ctor arity).
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";

/**
 * `[[Call]]` on a reified builtin carrier. `$Object.flags` bit; 0x01/0x02/0x04
 * are the integrity bits and 0x08 is `[[IsRawJSON]]` (object-runtime.ts). Every
 * existing reader masks only its own bit, so these two are inert to them.
 */
export const OBJ_FLAG_CALLABLE = 0x10;
/**
 * `[[Construct]]`, tracked SEPARATELY from `[[Call]]` on purpose. Every carrier
 * branded today is both — but `isNaN`/`parseInt` are callable and NOT
 * constructible, so collapsing the two bits would make a future callable-only
 * brand answer `isConstructor(isNaN) === true`: a LOUD `TypeError` refusal
 * turned into a silent wrong answer, which is worse than the bug fixed here.
 */
export const OBJ_FLAG_CONSTRUCTOR = 0x20;

/**
 * Contexts that have branded at least one carrier. A module CAN reify `Set` /
 * `TypeError` without ever compiling a closure, and the typeof finalize
 * otherwise returns early for such a module — but it still needs the callable
 * arm. Kept module-local (not a `CodegenContext` field) so the shared context
 * type stays flat; a `WeakSet` cannot outlive the compile.
 */
const brandedContexts = new WeakSet<CodegenContext>();

/** True once some carrier in this module was branded. */
export function hasBrandedBuiltinCarrier(ctx: CodegenContext): boolean {
  return brandedContexts.has(ctx);
}

/**
 * Set `OBJ_FLAG_CALLABLE | OBJ_FLAG_CONSTRUCTOR` on the `$Object` carrier held
 * (as an externref) in `objLocal`. Emits into `fctx.body`, stack-neutral, and
 * self-guarding: a non-`$Object` value (or a module with no object runtime) is
 * left untouched.
 *
 * Both bits, because the only carriers branded today are builtin CONSTRUCTORS
 * (the caller declines for `Math`/`JSON`/`Reflect`, which have no spec arity).
 * They are separate bits so a later callable-but-not-constructible brand
 * (`isNaN`, `parseInt`) cannot accidentally claim `[[Construct]]`.
 *
 * Records the context in `brandedContexts` so the finalize splice knows the
 * predicate is live even in a module that registered no closures at all.
 */
export function pushMarkBuiltinCarrierCallable(ctx: CodegenContext, fctx: FunctionContext, objLocal: number): void {
  const objectTypeIdx = ctx.objectRuntimeTypes?.objectTypeIdx;
  if (objectTypeIdx === undefined) return;

  const structLocal = allocLocal(fctx, `__callable_brand_obj_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: objectTypeIdx,
  });
  fctx.body.push(
    { op: "local.get", index: objLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: objectTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: objLocal },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: objectTypeIdx },
        // Land the cast in `structLocal` and read the struct.set RECEIVER back
        // from it. A `local.tee` + a second `local.get objLocal` would leave the
        // externref `local.get` as the deepest producer on the backward stack
        // walk in `fixups.ts` (`struct.set` receiver repair), which then splices
        // a SECOND `any.convert_extern + ref.cast_null` in front of this
        // already-correct sequence and the module fails validation
        // (`any.convert_extern[0] expected type externref, found ref.cast null`).
        // Reading through a non-externref local makes the walk land on a
        // producer it correctly leaves alone.
        { op: "local.set", index: structLocal },
        { op: "local.get", index: structLocal },
        { op: "ref.as_non_null" },
        { op: "local.get", index: structLocal },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
        { op: "i32.const", value: OBJ_FLAG_CALLABLE | OBJ_FLAG_CONSTRUCTOR },
        { op: "i32.or" },
        { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 4 },
      ],
    },
  );
  brandedContexts.add(ctx);
}

/**
 * The predicate arm the `typeof` natives and `__reflect_is_constructor` splice
 * in: when the anyref in `anyLocalIdx` is a `$Object` carrying `mask`, run
 * `onMatch` (which always ends in a `return`). Empty when no carrier was
 * branded, so a module that never reifies a builtin constructor stays
 * byte-identical.
 */
export function buildBuiltinBrandTestArm(
  ctx: CodegenContext,
  anyLocalIdx: number,
  mask: number,
  onMatch: Instr[],
): Instr[] {
  // (#2175 S3b-3 B/C) The `$__ta_ctor` arm is INDEPENDENT of `brandedContexts`
  // and of the `$Object` runtime: a TypedArray view constructor value is its own
  // struct, so it can neither carry `OBJ_FLAG_*` nor be reached by the `$Object`
  // test below. It must therefore be emitted even when this module branded no
  // `$Object` carrier at all (a program whose only reified builtin is
  // `Int8Array`).
  const taArm = buildTaCtorBrandTestArm(ctx, anyLocalIdx, onMatch);
  const objectTypeIdx = ctx.objectRuntimeTypes?.objectTypeIdx;
  if (!brandedContexts.has(ctx) || objectTypeIdx === undefined) return taArm;
  return [
    ...taArm,
    { op: "local.get", index: anyLocalIdx },
    { op: "ref.test", typeIdx: objectTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: anyLocalIdx },
        { op: "ref.cast", typeIdx: objectTypeIdx },
        { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
        { op: "i32.const", value: mask },
        { op: "i32.and" },
        { op: "if", blockType: { kind: "empty" }, then: [...onMatch] },
      ],
    },
  ];
}

/**
 * (#2175 S3b-3, defect C) A `$__ta_ctor` value — the reified `Int8Array` /
 * `Uint8Array` / … constructor (`registry/types.ts` `getOrRegisterTaCtorType`,
 * one immutable `kind` field) — is a **function**: `typeof Int8Array` is
 * `"function"` and `IsConstructor(Int8Array)` is true (§23.2.5).
 *
 * Measured on `origin/main` @ `9e17d34f3`, standalone, through an `any` binding
 * so the constant fold is not what is probed: `typeof Int8Array === "function"`
 * answered **false**. #4120 fixed exactly this class for `Set`/`Map`/`TypeError`
 * /…, but those reify as `$Object` carriers that can hold `OBJ_FLAG_CALLABLE`.
 * `$__ta_ctor` is a separate struct type, so the flag-bit mechanism cannot reach
 * it and it fell through to `"object"` — the same SILENT wrong answer #4120's
 * docstring describes, just for the eleven view constructors.
 *
 * Both `[[Call]]` and `[[Construct]]` arms get this (i.e. `mask` is ignored):
 * every TypedArray constructor has both. Calling one without `new` throws a
 * TypeError per §23.2.5.1, but that is a CALL-time refusal, not an absence of
 * `[[Call]]` — `typeof` must still say `"function"`, which is what the
 * `not-a-constructor.js` / `invoked-as-func.js` reflection files assert first.
 *
 * Type indices are rec-group / dead-elim stable, so a `ref.test` on the stashed
 * `ctx.taCtorTypeIdx` is safe at finalize; this READS the idx and never
 * registers, so a module without TypedArray ctors emits nothing here and stays
 * byte-identical.
 */
function buildTaCtorBrandTestArm(ctx: CodegenContext, anyLocalIdx: number, onMatch: Instr[]): Instr[] {
  const taCtorTypeIdx = ctx.taCtorTypeIdx;
  if (taCtorTypeIdx === undefined || taCtorTypeIdx < 0) return [];
  return [
    { op: "local.get", index: anyLocalIdx },
    { op: "ref.test", typeIdx: taCtorTypeIdx },
    { op: "if", blockType: { kind: "empty" }, then: [...onMatch] },
  ];
}

/** `typeof` arm: the carrier has `[[Call]]`, so `typeof` is `"function"`. */
export function buildBuiltinCallableTestArm(ctx: CodegenContext, anyLocalIdx: number, onMatch: Instr[]): Instr[] {
  return buildBuiltinBrandTestArm(ctx, anyLocalIdx, OBJ_FLAG_CALLABLE, onMatch);
}

/** `IsConstructor` arm: the carrier has `[[Construct]]` (§7.2.4). */
export function buildBuiltinConstructorTestArm(ctx: CodegenContext, anyLocalIdx: number, onMatch: Instr[]): Instr[] {
  return buildBuiltinBrandTestArm(ctx, anyLocalIdx, OBJ_FLAG_CONSTRUCTOR, onMatch);
}
