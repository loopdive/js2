// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Exact standalone dispatch for a TRANSFERRED `String.prototype.<m>` closure —
 * `obj.<m> = String.prototype.<m>; obj.<m>(…)`.
 *
 * The native closure ABI is `(self, thisValue, …args) -> externref`, while
 * `__apply_closure`'s generic method bridge installs the receiver only in
 * `__current_this` and fills every user parameter from the argument vector — so
 * the closure's `thisValue` param would receive the first user argument, or (for
 * a 0-arity method) nothing at all. Hence the exact arms here.
 *
 * (#4164) This started as a charAt-only exception and is now driven by
 * {@link TRANSFERRED_STRING_PROTO_MEMBERS}. The discriminator is the builtin
 * metadata id (`bfnid`), NOT `ref.test`: WasmGC canonicalizes structurally
 * equivalent meta types, so two same-shape member closures share one runtime
 * type and only the minted id tells them apart.
 */
import type { Instr, ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { BFN_ID_FIELD_IDX } from "./builtin-fn-meta.js";
import { runtimeToPrimitiveInstrs } from "./coercion-engine.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { emitThrowTypeError } from "./js-errors.js";
import {
  ensureAnyToStringHelper,
  ensureNativeStringHelpers,
  flatStringType,
  nativeStringLiteralInstrs,
} from "./native-strings.js";
import { compileExpression, ensureLateImport, flushLateImportShifts } from "./shared.js";

/**
 * Unbox an externref native-prototype argument to i32. Keeping this beside the
 * transferred-charAt lowering lets the generic proto emitter stay a dispatcher
 * instead of owning another argument-coercion implementation.
 */
export function unboxProtoArgToI32(ctx: CodegenContext, fctx: FunctionContext, paramIdx: number): number {
  const local = allocLocal(fctx, `__pm_arg_${fctx.locals.length}`, { kind: "i32" });
  const unboxIdx = ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
  flushLateImportShifts(ctx, fctx);
  // (#4465) §7.1.4 ToNumber of an OBJECT is ToPrimitive(number) first — that is
  // what runs a user `valueOf`/`toString` (and propagates a throw from one).
  // `__unbox_number` alone re-discriminates the shape it was handed and answers
  // NaN/0 for any object, so `"abc".substring(new Array(), new Boolean(1))` and
  // the `charAt(<object>)` position family never called the user's methods. This
  // is the canonical `__to_primitive` + `__unbox_number` pair (see
  // tonumber-fast-paths.ts); ToPrimitive early-outs on values that are ALREADY
  // primitive, so a number/string/boolean argument is unchanged in behaviour.
  const toPrimitive = runtimeToPrimitiveInstrs(ctx, "number");
  fctx.body.push({ op: "local.get", index: paramIdx });
  if (toPrimitive !== null) fctx.body.push(...toPrimitive);
  if (unboxIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: unboxIdx });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  } else {
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  fctx.body.push({ op: "local.set", index: local });
  return local;
}

/**
 * Compile one field RHS and retain new zero-argument closures when the field
 * participates in OrdinaryToPrimitive. Function-constructor instances store
 * these methods as externref, so finalization needs the closure provenance to
 * recover the per-instance callable.
 */
export function compileCoercionRhs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  value: ts.Expression,
  expectedType: ValType,
  typeName: string,
  fieldName: string,
): [ValType, number] | null {
  const before =
    fieldName === "toString" || fieldName === "valueOf" ? new Set(ctx.closureInfoByTypeIdx.keys()) : undefined;
  const valueType = compileExpression(ctx, fctx, value, expectedType);
  if (!valueType) return null;

  if (before) {
    const tracked = ctx.valueOfClosureTypes.get(typeName) ?? [];
    for (const [closureTypeIdx, closureInfo] of ctx.closureInfoByTypeIdx) {
      if (!before.has(closureTypeIdx) && closureInfo.paramTypes.length === 0 && !tracked.includes(closureTypeIdx)) {
        tracked.push(closureTypeIdx);
      }
    }
    if (tracked.length > 0) ctx.valueOfClosureTypes.set(typeName, tracked);
  }

  return [valueType, allocLocal(fctx, `__prop_assign_${fctx.locals.length}`, valueType)];
}

/**
 * Emit the exact transferred-charAt prototype body. Receiver ToString must
 * precede position coercion, so unboxing is registered early for funcidx
 * stability but its instructions are replayed only after the receiver is flat.
 */
export function emitTransferredCharAtProtoMemberBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  prepareReceiverGuard: () => void,
  emitReceiverGuard: () => void,
): ValType | null {
  ensureNativeStringHelpers(ctx);
  prepareReceiverGuard();

  const positionStart = fctx.body.length;
  const positionLocal = unboxProtoArgToI32(ctx, fctx, 2);
  const deferredPosition = fctx.body.splice(positionStart, fctx.body.length - positionStart);
  const anyToStringIdx = ensureAnyToStringHelper(ctx);
  const toPrimitive = runtimeToPrimitiveInstrs(ctx, "string");
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const charAtIdx = ctx.nativeStrHelpers.get("__str_charAt");
  if (toPrimitive === null || flattenIdx === undefined || charAtIdx === undefined) {
    emitThrowTypeError(ctx, fctx, "String.prototype.charAt is not yet implemented in --target standalone");
    return null;
  }

  emitReceiverGuard();
  fctx.body.push({ op: "local.get", index: 1 });
  fctx.body.push(...toPrimitive);
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "call", funcIdx: anyToStringIdx });
  fctx.body.push({ op: "call", funcIdx: flattenIdx });
  const flatLocal = allocLocal(fctx, `__str_pm_flat_${fctx.locals.length}`, flatStringType(ctx));
  fctx.body.push({ op: "local.set", index: flatLocal });
  fctx.body.push(...deferredPosition);
  fctx.body.push({ op: "local.get", index: flatLocal });
  fctx.body.push({ op: "local.get", index: positionLocal });
  fctx.body.push({ op: "call", funcIdx: charAtIdx });
  fctx.body.push({ op: "extern.convert_any" });
  return { kind: "externref" };
}

/**
 * Non-$Object arm for `__extern_method_call`. Closed/fnctor structs are outside
 * the existing object/vec/closure carrier ladder, but late `__extern_get` arms
 * can recover their stored or prototype charAt value. Restrict the new route to
 * the interned literal name; user functions stored there still flow through the
 * unchanged generic apply bridge.
 */
export function buildTransferredCharAtMethodArm(
  ctx: CodegenContext,
  externGetIdx: number,
  applyClosureIdx: number,
): Instr[] {
  if (ctx.nativeStrTypeIdx < 0) return [];
  const out: Instr[] = [];
  for (const member of TRANSFERRED_STRING_PROTO_MEMBERS) {
    out.push(
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: ctx.nativeStrTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: ctx.nativeStrTypeIdx },
          ...nativeStringLiteralInstrs(ctx, member),
          { op: "ref.eq" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 0 },
              { op: "local.get", index: 1 },
              { op: "call", funcIdx: externGetIdx },
              ...(ctx.funcMap.has("__nullish_to_null")
                ? ([{ op: "call", funcIdx: ctx.funcMap.get("__nullish_to_null")! }] satisfies Instr[])
                : []),
              { op: "local.get", index: 0 },
              { op: "local.get", index: 2 },
              { op: "call", funcIdx: applyClosureIdx },
              { op: "return" },
            ],
          },
        ],
      },
    );
  }
  return out;
}

/**
 * (#4164) The `String.prototype` members whose TRANSFERRED (property-assigned)
 * closure gets an exact dispatch arm:
 *
 *   `obj.<m> = String.prototype.<m>; obj.<m>(…)`
 *
 * `charAt` was the original single-member exception; the case-conversion family
 * is added because it is the largest ES5 standalone `String.prototype` failure
 * cluster (52 reachable tests — `S15.5.4.1[6789]_A1_T*`), and the generic
 * `__apply_closure` bridge cannot serve it: that bridge installs the receiver
 * only in `__current_this` and fills every declared closure parameter from the
 * argument VECTOR, so the closure's param 1 (`this`) receives the first user
 * argument (or nothing) instead of the receiver. The borrowed method then
 * ToStrings the wrong value — for a 0-arg method, nothing at all.
 *
 * Membership requirements (why this list is not simply `STRING_PROTO_METHODS`):
 * a member here must have a REAL reflective closure body in
 * `emitStringProtoMemberBody` (an unwired member's body is a refusal that
 * returns `null`, i.e. "fall through"), and its closure ABI must be
 * `(self, this, …args) -> externref` with every user param externref.
 * `buildTransferredStringProtoApplyArm` re-verifies both at emit time and
 * silently omits any member that does not match, so an entry added here can
 * never produce a wrong answer — at worst it is inert.
 */
const TRANSFERRED_STRING_PROTO_MEMBERS = [
  "charAt",
  "slice",
  "substring",
  "toUpperCase",
  "toLowerCase",
  "toLocaleUpperCase",
  "toLocaleLowerCase",
  "trim",
  "trimStart",
  "trimEnd",
  "indexOf",
  "lastIndexOf",
  "charCodeAt",
  "codePointAt",
  "at",
  "includes",
  "startsWith",
  "endsWith",
] as const;

export function buildTransferredCharAtApplyArm(ctx: CodegenContext, argOf: (index: number) => Instr[]): Instr[] {
  const out: Instr[] = [];
  for (const member of TRANSFERRED_STRING_PROTO_MEMBERS) {
    out.push(...buildTransferredStringProtoApplyArm(ctx, argOf, member));
  }
  return out;
}

/**
 * One exact-identity dispatch arm for a transferred `String.prototype.<member>`
 * closure inside the `__apply_closure` bridge. Emits nothing unless the meta
 * type, the `__proto_method_<brand>_<member>` body and the closure ABI all
 * resolve — so an unwired member costs zero bytes and changes no behaviour.
 */
function buildTransferredStringProtoApplyArm(
  ctx: CodegenContext,
  argOf: (index: number) => Instr[],
  member: string,
): Instr[] {
  const metaEntry = Array.from(ctx.builtinFnMetaTypeByKey?.entries() ?? []).find(([key]) =>
    key.endsWith(`:method:${member}`),
  );
  if (!metaEntry) return [];

  const [key, metaTypeIdx] = metaEntry;
  const closureInfo = ctx.closureInfoByTypeIdx.get(metaTypeIdx);
  const brand = key.split(":")[1];
  const funcIdx = brand === undefined ? undefined : ctx.funcMap.get(`__proto_method_${brand}_${member}`);
  const funcType = closureInfo === undefined ? undefined : ctx.mod.types[closureInfo.funcTypeIdx];
  if (
    closureInfo === undefined ||
    funcIdx === undefined ||
    funcType?.kind !== "func" ||
    // param 0 is the `this` receiver; params 1.. are the user args. Every one
    // must be externref (the uniform closure ABI) for the arg-vector threading
    // below to be type-correct.
    closureInfo.paramTypes.length < 1 ||
    closureInfo.paramTypes.some((p) => p.kind !== "externref") ||
    closureInfo.returnType?.kind !== "externref"
  ) {
    return [];
  }
  const userArgCount = closureInfo.paramTypes.length - 1;

  const selfType = funcType.params[0];
  if (!selfType || (selfType.kind !== "ref" && selfType.kind !== "ref_null")) return [];

  const userArgs: Instr[] = [];
  for (let i = 0; i < userArgCount; i++) userArgs.push(...argOf(i));

  return [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: metaTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // Equivalent metadata structs share one Wasm runtime type. `bfnid` is
        // the stable exact-identity discriminator minted with the closure.
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: metaTypeIdx },
        { op: "struct.get", typeIdx: metaTypeIdx, fieldIdx: BFN_ID_FIELD_IDX },
        { op: "i32.const", value: metaTypeIdx },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // self
            { op: "local.get", index: 0 },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: selfType.typeIdx },
            // explicit native-prototype receiver
            { op: "local.get", index: 1 },
            // user args (missing -> the ordinary undefined sentinel)
            ...userArgs,
            { op: "call", funcIdx },
            { op: "return" },
          ],
        },
      ],
    },
  ];
}
