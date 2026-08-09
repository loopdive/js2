// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr, ValType } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { BFN_ID_FIELD_IDX } from "../builtin-fn-meta.js";
import { buildClosureResultBoxing } from "./result-boxing.js";

export interface TransferredNativeReceiverEntry {
  typeIdx: number;
  funcTypeIdx: number;
  /** Declared USER parameter count (closure params minus the `thisValue` slot). */
  declaredUserArity: number;
  /**
   * (#4082) The closure's declared result type, so this arm can lower it to the
   * externref the `__call_fn_method_N` ABI returns. Without it the arm assumed
   * `call_ref` already yields an externref — see the note on
   * {@link buildTransferredNativeProtoCallInstrs}.
   */
  returnType: ValType | null;
}

/**
 * (#3992) Native-prototype METHOD closures carry an internal receiver param
 * ahead of their user arguments: the lifted signature is
 * `(self, thisValue, arg0 … arg{n-1})`. `__call_fn_method_N`'s generic dispatch,
 * by contrast, fills every closure param from the argument vector and publishes
 * the receiver only through the `__current_this` global. So a transferred /
 * borrowed native-proto method — the test262 shape
 * `obj.m = String.prototype.m; obj.m(…)` — had its arguments shifted one slot
 * left (`thisValue` received `arg0`) and answered a silently WRONG value
 * (measured: `null`), rather than throwing.
 *
 * The correction is a property of the closure SHAPE, not of a member name, so
 * this collector keys on `nativeProtoReceiverClosureStructTypes` — the set the
 * closure factory already populates for every `kind === "method"` proto closure
 * (`native-proto.ts`). It formerly pinned `arity === 2` + `name === "substring"`,
 * which is why exactly one member worked; `charAt` needed a SECOND, separately
 * hard-coded arm (`buildTransferredCharAtApplyArm`) for the identical reason.
 * Both were per-member clones of one shape rule: every unlisted member stayed
 * silently wrong, and a third clone per member does not scale.
 *
 * A closure is eligible at call arity `N` iff it declares AT LEAST `N + 1`
 * params (the extra slot being `thisValue`). `>=` rather than `===` covers
 * UNDER-APPLICATION, which is the norm here rather than the exception: several
 * members carry an uncounted optional trailing arg (`indexOf`/`lastIndexOf`/
 * `includes`/`startsWith`/`endsWith` all get 2 slots via
 * `STRING_PROTO_METHOD_PARAM_SLOTS` while spec `length` is 1), so the ordinary
 * `s.indexOf(x)` call site supplies one fewer argument than the closure
 * declares. Missing trailing args are padded with the reflective ABI's
 * omitted-arg convention (`ref.null.extern`), which the member bodies already
 * test for alongside the #2106 undefined sentinel.
 *
 * OVER-application is deliberately NOT claimed here: at arity > declared the
 * generic dispatch already owns the closure, and re-routing it would change
 * behaviour beyond the receiver bug this fixes.
 */
export function collectTransferredNativeProtoReceivers(
  ctx: CodegenContext,
  arity: number,
): TransferredNativeReceiverEntry[] {
  const entries: TransferredNativeReceiverEntry[] = [];
  if (!ctx.nativeProtoReceiverClosureStructTypes) return entries;
  for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
    if (info.paramTypes.length < arity + 1) continue;
    if (!ctx.nativeProtoReceiverClosureStructTypes.has(typeIdx)) continue;
    // Only the per-(brand, member) META subtype carries the field-3 exact-identity
    // discriminator that the call arm re-checks after its structural `ref.test`.
    // The shared base wrapper is also in the set but has no such field, and
    // dispatching on it would capture every structurally equal closure.
    if (!ctx.builtinFnMetaByTypeIdx?.has(typeIdx)) continue;
    entries.push({
      typeIdx,
      funcTypeIdx: info.funcTypeIdx,
      declaredUserArity: info.paramTypes.length - 1,
      returnType: info.returnType,
    });
  }
  return entries;
}

export function resolveClosureBaseWrapperTypeIdx(
  ctx: CodegenContext,
  arity: number,
  initial: number | undefined,
): number | undefined {
  if (initial !== undefined) return initial;
  for (const [typeIdx] of ctx.closureInfoByTypeIdx) {
    const typeDef = ctx.mod.types[typeIdx];
    if (typeDef && typeDef.kind === "struct" && typeDef.superTypeIdx === -1) return typeIdx;
  }
  for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
    if (info.paramTypes.length === arity) return typeIdx;
  }
  return undefined;
}

/**
 * Build the method-call arm that supplies `(self, thisVal, arg0 … arg{n-1})`.
 * The structural `ref.test` is only a family guard (WasmGC canonicalizes
 * structurally equal metadata structs), so the immutable field-3 bfnid is
 * re-checked for exact identity before invocation. The saved `__current_this`
 * is restored before returning, matching the generic dispatch's nesting
 * discipline.
 *
 * Local convention inside `__call_fn_method_N` (see `emitClosureMethodCallExportN`):
 * `0` = thisVal, `1` = closure, `2 … arity+1` = the user args. `arity` is the
 * USER arity — one less than the closure's declared param count.
 *
 * Stack balance: each arm pushes exactly one externref and immediately sinks it
 * into `resultSaveLocal`, so the arm is stack-neutral up to its own `return`;
 * the enclosing `if` is `blockType: empty`.
 *
 * (#4082) That externref is produced by `buildClosureResultBoxing`, NOT by
 * `call_ref` directly.
 * This comment used to claim the `call_ref` result *was* the externref, and the
 * arm emitted no coercion — true only for reference-returning closures. A
 * closure returning i32 (`RegExp.prototype.test`) pushed an i32 into the
 * externref `resultSaveLocal` and the module failed validation:
 * `local.set[0] expected type externref, found call_ref of type i32`. The
 * caller supplies the same boxing every other dispatch arm in this ABI uses, so
 * there is one decision rather than a per-arm copy.
 */
export function buildTransferredNativeProtoCallInstrs(
  ctx: CodegenContext,
  entries: TransferredNativeReceiverEntry[],
  arity: number,
  slots: {
    anyLocal: number;
    resultSaveLocal: number;
    prevThisLocal: number;
    currentThisGlobalIdx: number;
    boxNumberIdx: number | undefined;
  },
): Instr[] {
  const { anyLocal, resultSaveLocal, prevThisLocal, currentThisGlobalIdx, boxNumberIdx } = slots;
  const body: Instr[] = [];
  for (const entry of entries) {
    // Supplied args come from locals 2 … arity+1; any trailing slot the closure
    // declares but the call site omitted is padded with the reflective ABI's
    // omitted-arg null (see the collector's note on under-application).
    const userArgs: Instr[] = [];
    for (let k = 0; k < entry.declaredUserArity; k++) {
      userArgs.push(k < arity ? { op: "local.get", index: 2 + k } : { op: "ref.null.extern" });
    }
    body.push(
      { op: "local.get", index: anyLocal },
      { op: "ref.test", typeIdx: entry.typeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: anyLocal },
          { op: "ref.cast", typeIdx: entry.typeIdx },
          { op: "struct.get", typeIdx: entry.typeIdx, fieldIdx: BFN_ID_FIELD_IDX },
          { op: "i32.const", value: entry.typeIdx },
          { op: "i32.eq" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              // self
              { op: "local.get", index: anyLocal },
              { op: "ref.cast", typeIdx: entry.typeIdx },
              // thisValue — the receiver the generic dispatch would have dropped
              { op: "local.get", index: 0 },
              // user args, shifted one slot right of the generic dispatch
              ...userArgs,
              { op: "local.get", index: anyLocal },
              { op: "ref.cast", typeIdx: entry.typeIdx },
              { op: "struct.get", typeIdx: entry.typeIdx, fieldIdx: 0 },
              { op: "ref.cast", typeIdx: entry.funcTypeIdx },
              { op: "call_ref", typeIdx: entry.funcTypeIdx },
              // (#4082) Lower the callee's ACTUAL result to the ABI's externref
              // before it reaches the externref `resultSaveLocal`.
              ...buildClosureResultBoxing(ctx, entry.returnType, boxNumberIdx),
              { op: "local.set", index: resultSaveLocal },
              { op: "local.get", index: prevThisLocal },
              { op: "global.set", index: currentThisGlobalIdx },
              { op: "local.get", index: resultSaveLocal },
              { op: "return" },
            ],
          },
        ],
      },
    );
  }
  return body;
}
