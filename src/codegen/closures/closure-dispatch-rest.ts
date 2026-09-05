// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Rest-parameter carriers for the host closure dispatchers (#5329).
 *
 * `__call_fn_N` / `__call_fn_method_N` take every user argument as
 * `externref`, but a closure with a source rest parameter declares ONE hidden
 * Wasm formal for it, whose shape depends on how the rest type lowered. This
 * module owns the classification of that formal and the instruction sequence
 * that builds it, so the two dispatcher emitters in `closure-exports.ts` cannot
 * disagree about it. Extracted from that file, which is over its LOC budget.
 */

import type { FuncTypeDef, Instr, ValType } from "../../ir/types.js";
import type { ClosureInfo, CodegenContext } from "../context/types.js";
import { getArrTypeIdxFromVec } from "../registry/types.js";
import { defaultValueInstrs } from "../type-coercion.js";
import { classifyTupleRestCarrier } from "./tuple-rest-carrier.js";

export type ClosureDispatchRestInfo =
  | {
      kind: "vec";
      matchTypeIdx: number;
      vecTypeIdx: number;
      arrTypeIdx: number;
      elemType: ValType;
    }
  | {
      kind: "empty-struct";
      matchTypeIdx: number;
      vecTypeIdx: number;
    }
  | {
      kind: "externref";
      matchTypeIdx: number;
    }
  | {
      /**
       * (#5329) A TUPLE-typed rest (`...args: [Error]`) lowers to a fixed-field
       * `__tuple_N` struct, one field per element — not to the canonical
       * `{ length, data }` vec. Materialize it positionally.
       */
      kind: "tuple";
      matchTypeIdx: number;
      tupleTypeIdx: number;
      fieldTypes: ValType[];
    }
  | {
      /**
       * (#5329) A rest FORMAL exists on the funcref but this dispatcher has no
       * recipe for its carrier. The caller MUST skip the entry entirely: the
       * only alternative — treating the closure as an ordinary arity-`hostArity`
       * one — omits the formal and emits a `call_ref` one operand short, which
       * fails module validation. See `classifyClosureDispatchRest`.
       */
      kind: "unsupported";
    };

/**
 * Recover the concrete carrier needed for a source rest parameter.
 *
 * Most rest parameters lower to the canonical `{ length, data }` vec. A
 * generic rest (`...args: T`, where `T extends unknown[]`) instead resolves to
 * `externref`: the lifted function still has one Wasm rest formal, but the
 * host dispatcher must build the array value that formal represents. Treating
 * that signature as an ordinary arity-0 closure omitted the formal entirely
 * and made every `__call_fn_N`/`__call_fn_method_N` containing it invalid.
 *
 * (#5329) Returns `undefined` only when there is NO rest formal to build. A
 * formal that exists but has no known carrier answers `{ kind: "unsupported" }`,
 * which the caller must translate into "skip this entry" — falling through to
 * the plain-arity push is what produced the invalid module above, and a bare
 * `undefined` could not tell the two cases apart. jest's `queueRunner.ts`
 * (`const next = function (...args: [Error]) {…}`) is the witness: a TUPLE-typed
 * rest lowers to a `__tuple_N` struct with one field per element, matching none
 * of the vec / empty-struct / externref carriers, so the whole module failed to
 * validate with "not enough arguments on the stack for call_ref (need 2, got 1)".
 */
export function classifyClosureDispatchRest(
  ctx: CodegenContext,
  matchTypeIdx: number,
  info: ClosureInfo,
  funcTypeDef: FuncTypeDef | undefined,
  hostArity: number,
): ClosureDispatchRestInfo | undefined {
  if (info.hasRestParam !== true || funcTypeDef === undefined) return undefined;
  const restParam = funcTypeDef.params[hostArity + 1]; // +1 for closure self
  if (!restParam) return undefined;

  if (restParam.kind === "externref" || restParam.kind === "ref_extern") {
    return { kind: "externref", matchTypeIdx };
  }
  if (restParam.kind !== "ref" && restParam.kind !== "ref_null") return { kind: "unsupported" };

  const vecTypeIdx = restParam.typeIdx;
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  const arrDef = ctx.mod.types[arrTypeIdx];
  if (arrDef?.kind === "array") {
    return { kind: "vec", matchTypeIdx, vecTypeIdx, arrTypeIdx, elemType: arrDef.element };
  }
  const vecDef = ctx.mod.types[vecTypeIdx];
  if (vecDef?.kind === "struct" && vecDef.fields.length === 0) {
    return { kind: "empty-struct", matchTypeIdx, vecTypeIdx };
  }
  // (#5329) A tuple-typed rest lowers to a `__tuple_N` struct, one field per
  // element — see closures/tuple-rest-carrier.ts for the shared recognizer.
  const tuple = classifyTupleRestCarrier(ctx, vecTypeIdx);
  if (tuple !== null) {
    return { kind: "tuple", matchTypeIdx, tupleTypeIdx: tuple.tupleTypeIdx, fieldTypes: tuple.fieldTypes };
  }
  return { kind: "unsupported" };
}

/** Build the single hidden Wasm argument that implements a source rest array. */
export function materializeClosureDispatchRest(
  rest: ClosureDispatchRestInfo,
  dispatcherArity: number,
  fixedArity: number,
  externVecTypeIdx: number,
  externArrTypeIdx: number,
  emitElement: (argumentIndex: number, elemType: ValType) => Instr[],
): Instr[] {
  if (rest.kind === "empty-struct") return [{ op: "struct.new", typeIdx: rest.vecTypeIdx }];
  // (#5329) A tuple carrier has one FIELD per element, not a length + array. Push
  // the positional argument for each field it covers and pad the rest with that
  // field type's missing-argument default (the f64 `undefined` sentinel, typed
  // null, 0 — `defaultValueInstrs`), then build the struct.
  if (rest.kind === "tuple") {
    const instrs: Instr[] = [];
    for (let i = 0; i < rest.fieldTypes.length; i++) {
      const fieldType = rest.fieldTypes[i]!;
      const argumentIndex = fixedArity + i;
      instrs.push(
        ...(argumentIndex < dispatcherArity ? emitElement(argumentIndex, fieldType) : defaultValueInstrs(fieldType)),
      );
    }
    instrs.push({ op: "struct.new", typeIdx: rest.tupleTypeIdx });
    return instrs;
  }
  if (rest.kind === "unsupported") {
    // Unreachable: callers skip an `unsupported` entry before it can reach a
    // dispatch arm (see `emitClosureCallExportN`). Keep the exhaustive tail so a
    // future carrier kind cannot silently fall through to the vec path.
    return [];
  }

  const restCount = Math.max(0, dispatcherArity - fixedArity);
  const elemType: ValType = rest.kind === "externref" ? { kind: "externref" } : rest.elemType;
  const arrTypeIdx = rest.kind === "externref" ? externArrTypeIdx : rest.arrTypeIdx;
  const vecTypeIdx = rest.kind === "externref" ? externVecTypeIdx : rest.vecTypeIdx;
  const instrs: Instr[] = [{ op: "i32.const", value: restCount }];
  for (let i = fixedArity; i < dispatcherArity; i++) {
    instrs.push(...emitElement(i, elemType));
  }
  instrs.push(
    { op: "array.new_fixed", typeIdx: arrTypeIdx, length: restCount },
    { op: "struct.new", typeIdx: vecTypeIdx },
  );
  if (rest.kind === "externref") instrs.push({ op: "extern.convert_any" });
  return instrs;
}

/**
 * (#5329) The struct type a lifted funcref expects as its `self` operand: the
 * declared param-0 type when it is a reference, else the closure's own struct.
 * Three dispatcher loops in `closure-exports.ts` had this open-coded.
 */
export function closureDispatchSelfTypeIdx(funcTypeDef: FuncTypeDef | undefined, structTypeIdx: number): number {
  const selfParam = funcTypeDef?.kind === "func" ? funcTypeDef.params[0] : undefined;
  return selfParam && (selfParam.kind === "ref" || selfParam.kind === "ref_null") ? selfParam.typeIdx : structTypeIdx;
}
