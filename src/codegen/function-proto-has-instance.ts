// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Native `%Function.prototype%[@@hasInstance]` method body for the standalone
 * builtin-prototype closure family.
 *
 * The method is the public spelling of OrdinaryHasInstance: its `this` value
 * is the candidate constructor and its first argument is the value being
 * tested.  The existing host-free dynamic-instanceof helper already owns the
 * representation-aware prototype walk, including the catchable TypeError
 * sentinel for a non-object `prototype`; this adapter only swaps the operands
 * and turns that tri-state result into the boolean method result.
 */

import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { popBody, pushBody } from "./context/bodies.js";
import { allocLocal } from "./context/locals.js";
import { emitFnctorProtoGet, resolveUserFnctorName } from "./expressions/fnctor-prototype.js";
import { emitThrowTypeError } from "./js-errors.js";
import { ensureNativeDynamicInstanceOf } from "./native-dynamic-instanceof.js";
import { ts } from "../ts-api.js";
import type { TypeFact } from "../checker/oracle.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";

export const FUNCTION_PROTO_HAS_INSTANCE_MEMBER = "@@hasInstance";

const BOOLEAN_RESULT: ValType = { kind: "i32", boolean: true };

/**
 * Reserve the compile-time fnctor → prototype identity edge used by the
 * native OrdinaryHasInstance helper. The emitted get is discarded: this call
 * only mints the per-fnctor global and records it for finalization. Runtime
 * prototype initialization remains lazy in `__closure_proto_of`.
 */
export function ensureFunctionProtoEdge(ctx: CodegenContext, fctx: FunctionContext, receiver: ts.Expression): void {
  const fnctorName = resolveUserFnctorName(ctx, receiver);
  if (fnctorName === undefined) return;
  const savedBody = fctx.body;
  const scratch: Instr[] = [];
  fctx.body = scratch;
  ctx.liveBodies.add(savedBody);
  try {
    emitFnctorProtoGet(ctx, fctx, fnctorName);
  } finally {
    fctx.body = savedBody;
    ctx.liveBodies.delete(savedBody);
  }
}

/** Emit `%Function.prototype%[@@hasInstance](value)` into a native closure. */
export function emitFunctionProtoHasInstanceBody(ctx: CodegenContext, fctx: FunctionContext): ValType | null {
  const helperIdx = ensureNativeDynamicInstanceOf(ctx);
  if (helperIdx === undefined) return null;

  fctx.body.push(...ownPrototypePropertyArm(ctx, fctx));
  // Native-method closure ABI: local 1 is `this`, local 2 is the first user
  // argument. `__instanceof_dynamic` takes (value, target), in that order.
  fctx.body.push({ op: "local.get", index: 2 });
  if (ctx.boundFnTypeIdx >= 0) {
    const targetLocal = allocLocal(fctx, `__has_instance_target_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.get", index: 1 });
    fctx.body.push({ op: "local.set", index: targetLocal });
    // BoundFunctionExoticObject forwards @@hasInstance to its target. Unwrap
    // the native carrier here, before the generic helper classifies the target;
    // the loop also handles bound-of-bound chains without changing the helper's
    // conservative treatment of unrelated callable carriers.
    fctx.body.push({
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: targetLocal },
            { op: "any.convert_extern" },
            { op: "ref.test", typeIdx: ctx.boundFnTypeIdx },
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: targetLocal },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: ctx.boundFnTypeIdx },
            { op: "struct.get", typeIdx: ctx.boundFnTypeIdx, fieldIdx: 0 },
            { op: "local.set", index: targetLocal },
            { op: "br", depth: 0 },
          ],
        },
      ],
    });
    fctx.body.push({ op: "local.get", index: targetLocal });
  } else {
    fctx.body.push({ op: "local.get", index: 1 });
  }
  fctx.body.push({ op: "call", funcIdx: helperIdx });

  // The dynamic helper returns 0 (false), 1 (true), or 2 (a required
  // TypeError). The operator path has the same guard; keep the throw in this
  // method body so `Function.prototype[@@hasInstance].call(...)` preserves
  // catchable TypeError identity too.
  const codeLocal = allocLocal(fctx, `__has_instance_code_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.tee", index: codeLocal });
  fctx.body.push({ op: "i32.const", value: 2 });
  fctx.body.push({ op: "i32.eq" });
  const savedBody = pushBody(fctx);
  emitThrowTypeError(ctx, fctx, "Right-hand side of 'instanceof' is not callable");
  // `emitThrowTypeError` appends a multi-instruction throw sequence directly;
  // put the whole sequence under the condition rather than executing it
  // unconditionally.
  const throwBody = fctx.body;
  popBody(fctx, savedBody);
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: throwBody,
    else: [],
  });
  fctx.body.push({ op: "local.get", index: codeLocal });
  return BOOLEAN_RESULT;
}

/**
 * (#6775 S16) OrdinaryHasInstance steps 3-6 for a `this` whose `prototype` is
 * an OWN property in its carrier bag — `Object.defineProperty(f, "prototype",
 * {get})` on a function value that had none
 * (`Symbol.hasInstance/this-val-poisoned-prototype.js`). The dynamic helper
 * reads the compiled-in prototype edge and never sees the bag, so the getter
 * did not run. Here: a non-Object `O` answers false; else `P = ? Get(C,
 * "prototype")` (the getter runs and its throw propagates); a non-Object `P`
 * is a TypeError; else `P.isPrototypeOf(O)`. Emits nothing when the carrier
 * bag substrate is absent (no function value can carry such a property).
 */
function ownPrototypePropertyArm(ctx: CodegenContext, fctx: FunctionContext): Instr[] {
  const bagHasIdx = ctx.funcMap.get("__carrier_bag_has");
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const isProtoOfIdx = ctx.funcMap.get("__isPrototypeOf");
  const typeofObjectIdx = ctx.funcMap.get("__typeof_object");
  const typeofFunctionIdx = ctx.funcMap.get("__typeof_function");
  if (
    bagHasIdx === undefined ||
    externGetIdx === undefined ||
    isProtoOfIdx === undefined ||
    typeofObjectIdx === undefined ||
    typeofFunctionIdx === undefined
  ) {
    return [];
  }
  addStringConstantGlobal(ctx, "prototype");
  const key = stringConstantExternrefInstrs(ctx, "prototype");
  const protoLocal = allocLocal(fctx, `__has_instance_proto_${fctx.locals.length}`, { kind: "externref" });
  const isObject = (local: number): Instr[] => [
    { op: "local.get", index: local },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    { op: "local.get", index: local },
    { op: "call", funcIdx: typeofObjectIdx },
    { op: "local.get", index: local },
    { op: "call", funcIdx: typeofFunctionIdx },
    { op: "i32.or" },
    { op: "i32.and" },
  ];
  const savedBody = pushBody(fctx);
  emitThrowTypeError(ctx, fctx, "Function has non-object prototype in instanceof check");
  const throwBody = fctx.body;
  popBody(fctx, savedBody);
  return [
    { op: "local.get", index: 1 },
    ...key,
    { op: "call", funcIdx: bagHasIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...isObject(2),
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
        { op: "local.get", index: 1 },
        ...stringConstantExternrefInstrs(ctx, "prototype"),
        { op: "call", funcIdx: externGetIdx },
        { op: "local.set", index: protoLocal },
        ...isObject(protoLocal),
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "empty" }, then: throwBody },
        { op: "local.get", index: protoLocal },
        { op: "local.get", index: 2 },
        { op: "call", funcIdx: isProtoOfIdx },
        { op: "return" },
      ],
    },
  ];
}

/**
 * (#6775 S16) `f[Symbol.hasInstance](v)` where `f` is typed `F | undefined`
 * (`Object.getOwnPropertyDescriptor(o, k).get`). The direct native lowering
 * admits it like a plain function value; a nullish receiver still throws the
 * member read's TypeError first.
 */
export function isNullableFunctionFact(fact: TypeFact): boolean {
  return fact.kind === "union" && fact.parts.length === 1 && fact.parts[0]!.kind === "function";
}

/** Throw TypeError when the externref `local` is null or `undefined`. */
export function emitNullishHasInstanceReceiverThrow(ctx: CodegenContext, fctx: FunctionContext, local: number): void {
  const isUndefIdx = ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
  flushLateImportShifts(ctx, fctx);
  if (isUndefIdx === undefined) return;
  const savedBody = pushBody(fctx);
  emitThrowTypeError(ctx, fctx, "Cannot read properties of null or undefined (reading 'Symbol(Symbol.hasInstance)')");
  const throwBody = fctx.body;
  popBody(fctx, savedBody);
  fctx.body.push(
    { op: "local.get", index: local },
    { op: "ref.is_null" },
    { op: "local.get", index: local },
    { op: "call", funcIdx: ctx.funcMap.get("__extern_is_undefined") ?? isUndefIdx },
    { op: "i32.or" },
    { op: "if", blockType: { kind: "empty" }, then: throwBody },
  );
}
