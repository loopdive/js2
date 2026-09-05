// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4639 C2) `<Builtin>.<unknownProp>` as a VALUE, standalone — the ORDINARY
 * [[Get]] the refusal used to pre-empt.
 *
 * ## The gap
 *
 * `property-access-dispatch.ts` resolves `<Builtin>.<prop>` through a ladder of
 * compile-time folds (`.prototype`, `.length`/`.name`, the Math/Number/Symbol
 * constants, a reified static-method closure, `.constructor`). Anything the
 * ladder does not recognise hit `reportUnsupportedStandaloneBuiltinValueRead`
 * and failed the WHOLE FILE with a Codegen error — including reads the spec
 * answers trivially:
 *
 * ```js
 * Function.prototype.indicator = 1;
 * String.indicator   // 1  — inherited; `String`'s [[Prototype]] is %Function.prototype%
 * RegExp.indicator   // 1  — idem (§20.2.3, §22.2.4.x)
 * Math.NaN           // undefined — `Math` simply has no such property
 * ```
 *
 * Measured on this branch's base, all three were `compile_error`
 * (`built-ins/String/S15.5.3_A2_T2`, `built-ins/RegExp/S15.10.5_A2_T2`,
 * `built-ins/RegExp/prototype/exec/S15.10.6.2_A4_T7`).
 *
 * ## What this module does
 *
 * The ordinary [[Get]], in two hops, against the objects standalone ALREADY has:
 *
 *   1. the builtin's identity-stable **carrier** (`__builtin_ctor_<N>` /
 *      `__builtin_<N>`, #3006/#2907) — its own properties, including any expando
 *      a program wrote onto it;
 *   2. failing that, its **[[Prototype]]**: `%Function.prototype%` for a
 *      constructor (it is a function object) and `%Object.prototype%` for a
 *      namespace (`Math`/`JSON`/`Reflect`, which are ordinary objects).
 *
 * Both are read with the SAME `__extern_get` the dynamic reader uses, so an
 * expando written through any spelling is found by any other. Presence on the
 * carrier is decided by `__object_hasOwn` rather than by "the value is not
 * undefined", so a genuine own `undefined` does not fall through to the
 * prototype.
 *
 * The [[Prototype]] hop is a direct read, NOT a `$Object.$parent` link: measured
 * on this branch's base, `Object.setPrototypeOf(o, Function.prototype)` followed
 * by `o.indicator` answers `undefined` — `__extern_get`'s chain walk does not
 * cross from a `$Object` into a `$NativeProto`'s companion table. Making it do
 * so is a change to the object MOP itself and is left to its own issue; this
 * module needs only the one hop the spec fixes statically.
 *
 * ## Absent-not-wrong: what still REFUSES
 *
 * A `propName` that names a real builtin STATIC METHOD
 * (`BUILTIN_STATIC_METHOD_ARITY`) but reached the refusal — i.e. its closure
 * could not be reified — keeps the loud refusal. That read has a genuine
 * function value the spec requires; answering `undefined` for it would be a
 * silent wrong answer, which is strictly worse than a compile error. Only reads
 * with NO modelled value take this path, and for those `undefined`/the inherited
 * value IS the spec answer.
 *
 * Standalone only; the host lane keeps its `__get_builtin`/`__extern_get` read.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { BUILTIN_CTOR_ARITY, tryEnsureNativeProtoBrand } from "./builtin-value-read.js";
import { BUILTIN_STATIC_METHOD_ARITY } from "./builtin-fn-meta.js";
import { emitBuiltinProtoConstructorValue, hasBuiltinProtoConstructorCarrier } from "./builtin-proto-constructor.js";
import { emitLazyNativeProtoGet } from "./native-proto.js";
import { withSpeculativeCompile } from "./context/speculative.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";

/**
 * Push the `[[Prototype]]` object of the builtin named `builtinName` — the
 * object an unresolved own read must consult next. Returns `false` having
 * pushed NOTHING when the prototype object cannot be materialized.
 *
 * A builtin CONSTRUCTOR is a function object, so its [[Prototype]] is
 * `%Function.prototype%` (§20.2.3.1 and every `<Ctor>` clause's "the value of
 * the [[Prototype]] internal slot of <Ctor> is %Function.prototype%").
 * `Math`/`JSON`/`Reflect` are ordinary objects whose [[Prototype]] is
 * `%Object.prototype%`.
 */
function pushBuiltinIntrinsicPrototype(ctx: CodegenContext, fctx: FunctionContext, builtinName: string): boolean {
  const protoOwner = builtinName in BUILTIN_CTOR_ARITY ? "Function" : "Object";
  const brand = tryEnsureNativeProtoBrand(ctx, protoOwner);
  if (brand === undefined) return false;
  return emitLazyNativeProtoGet(ctx, fctx, brand);
}

/**
 * `<builtinName>.<propName>` as an ordinary [[Get]]. Returns the pushed
 * `ValType`, or `undefined` having pushed NOTHING (caller keeps its refusal).
 *
 * Stack: `[] → [externref]` on success.
 */
export function tryEmitBuiltinStaticExpandoRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  builtinName: string,
  propName: string,
): ValType | undefined {
  if (!ctx.standalone) return undefined;
  // A real static METHOD that failed to reify keeps the loud refusal — see the
  // "absent-not-wrong" note in the module header.
  if (BUILTIN_STATIC_METHOD_ARITY[builtinName]?.[propName] !== undefined) return undefined;

  const getIdx = ensureLateImport(
    ctx,
    "__extern_get",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  const hasOwnIdx = ensureLateImport(
    ctx,
    "__object_hasOwn",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "i32" }],
  );
  flushLateImportShifts(ctx, fctx);
  const finalGetIdx = ctx.funcMap.get("__extern_get") ?? getIdx;
  const finalHasOwnIdx = ctx.funcMap.get("__object_hasOwn") ?? hasOwnIdx;
  if (finalGetIdx === undefined || finalHasOwnIdx === undefined) return undefined;

  addStringConstantGlobal(ctx, propName);
  const pushKey = (): Instr[] => [...stringConstantExternrefInstrs(ctx, propName)];

  const carrierLocal = allocLocal(fctx, `__bse_carrier_${fctx.locals.length}`, { kind: "externref" });

  // Both halves are speculative: the carrier and the intrinsic prototype each
  // allocate locals / late imports before they can decline, so a raw
  // `body.length = mark` would strand them (#1919).
  const emitted = withSpeculativeCompile(ctx, fctx, () => {
    let hasCarrier = false;
    if (hasBuiltinProtoConstructorCarrier(builtinName)) {
      const carrierType = emitBuiltinProtoConstructorValue(ctx, fctx, builtinName);
      if (carrierType !== null) {
        fctx.body.push({ op: "local.set", index: carrierLocal });
        hasCarrier = true;
      }
    }

    // The inherited read is built into a detached body so it can serve as the
    // `else` arm below; `liveBodies` keeps it under the funcidx-shift walk.
    const protoBody: Instr[] = [];
    const savedBody = fctx.body;
    fctx.body = protoBody;
    ctx.liveBodies.add(savedBody);
    let hasProto: boolean;
    try {
      hasProto = pushBuiltinIntrinsicPrototype(ctx, fctx, builtinName);
      if (hasProto) {
        fctx.body.push(...pushKey());
        fctx.body.push({ op: "call", funcIdx: finalGetIdx });
      }
    } finally {
      fctx.body = savedBody;
      ctx.liveBodies.delete(savedBody);
    }
    if (!hasProto) {
      protoBody.length = 0;
      protoBody.push({ op: "ref.null.extern" });
    }

    if (!hasCarrier) {
      fctx.body.push(...protoBody);
      return { commit: true, value: true as const };
    }

    fctx.body.push({ op: "local.get", index: carrierLocal });
    fctx.body.push(...pushKey());
    fctx.body.push({ op: "call", funcIdx: finalHasOwnIdx });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } as ValType },
      then: [{ op: "local.get", index: carrierLocal }, ...pushKey(), { op: "call", funcIdx: finalGetIdx }],
      else: protoBody,
    });
    return { commit: true, value: true as const };
  });

  if (emitted !== true) return undefined;
  return { kind: "externref" };
}
