// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7354 D1) Dynamic-value legalization for the Prepared standalone WasmGC
 * source program.
 *
 * The Prepared backend binds runtime functions only through semantic
 * intrinsics, so the dynamic IR operations from-ast emits (`box` to dynamic,
 * `unbox`, `tag.test`, `dyn.*`) are rewritten into the intrinsics that name
 * the same meaning, and every `dynamic` type becomes its carrier, an
 * `externref`. The source producer runs it on each lowered function, so every
 * later stage (runtime projection, validator replay, physical plan) sees one
 * ordinary externref program. The pass is total: an operation it cannot
 * express throws {@link DynamicValueGap} with a name instead of reaching the
 * backend.
 *
 * Soundness rests on the admitted value set: only numbers, booleans and
 * `undefined` can enter a dynamic value here (every other box refuses), and the
 * runtime functions behind the intrinsics are exact for that set.
 */
import { INTRINSIC_SIGNATURE_VERSION, INTRINSIC_DEFINITIONS, type IntrinsicId } from "../core/intrinsics.js";
import { mapNestedBuffers, type IrFunction, type IrInstr, type IrValueId } from "../core/nodes.js";
import type { IrType } from "../core/types.js";
import { irRuntimeCallableDeclaration } from "../runtime/callable-declarations.js";
import { JS_TAG_IDS } from "../runtime/js-tag-domain.js";
import { nativeAsyncCallableValueTypes } from "../runtime/native-async-callables.js";

const CARRIER: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "externref" }) });
const F64: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "f64" }) });

/** A dynamic operation the Prepared path has no intrinsic for; the message names it. */
export class DynamicValueGap extends Error {}

function gap(operation: string): never {
  throw new DynamicValueGap(`dynamic operation ${operation} has no Prepared intrinsic`);
}

/** Walk the data structurally: IR constants may hold bigints, which JSON cannot. */
function containsDynamic(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if ((value as { kind?: unknown }).kind === "dynamic") return true;
  return Object.values(value).some(containsDynamic);
}

function carrierOf(type: IrType): IrType {
  return type.kind === "dynamic" ? CARRIER : type;
}

/**
 * Rewrite one function; `fresh` allocates the SSA values the expansions add.
 * A function without a dynamic value is returned unchanged.
 */
export function legalizeDynamicValues(fn: IrFunction): IrFunction {
  if (!containsDynamic(fn)) return fn;
  const types = nativeAsyncCallableValueTypes(fn);
  let valueCount = fn.valueCount;
  const fresh = (): IrValueId => valueCount++ as IrValueId;
  const intrinsic = (instr: IrInstr, id: IntrinsicId, args: readonly IrValueId[], result = instr.result): IrInstr => ({
    kind: "intrinsic",
    id,
    version: INTRINSIC_SIGNATURE_VERSION,
    args,
    result,
    resultType: INTRINSIC_DEFINITIONS[id].signature.result,
    ...(instr.site === undefined ? {} : { site: instr.site }),
  });
  const unary = (
    op: "i32.eqz" | "f64.convert_i32_s",
    rand: IrValueId,
    result: IrValueId,
    resultType: IrType,
  ): IrInstr => ({ kind: "unary", op, rand, result, resultType });
  const isDynamic = (value: IrValueId): boolean => types.get(value)?.kind === "dynamic";

  const expand = (instr: IrInstr): readonly IrInstr[] => {
    switch (instr.kind) {
      case "box": {
        if (instr.toType.kind !== "dynamic") return [instr];
        const source = types.get(instr.value);
        if (instr.toType.tag === JS_TAG_IDS.Boolean) return [intrinsic(instr, "js.boolean.box", [instr.value])];
        if (source?.kind === "val" && source.val.kind === "f64")
          return [intrinsic(instr, "js.number.box", [instr.value])];
        if (source?.kind === "val" && source.val.kind === "i32") {
          const widened = fresh();
          return [unary("f64.convert_i32_s", instr.value, widened, F64), intrinsic(instr, "js.number.box", [widened])];
        }
        return gap(`box of a non-primitive value`);
      }
      case "unbox":
        if (!isDynamic(instr.value)) return [instr];
        if (instr.tagId === JS_TAG_IDS.NumberF64) return [intrinsic(instr, "js.number.unbox", [instr.value])];
        if (instr.tagId === JS_TAG_IDS.Boolean) return [intrinsic(instr, "js.boolean.unbox", [instr.value])];
        return gap(`unbox of tag ${instr.tagId}`);
      case "tag.test":
        if (!isDynamic(instr.value)) return [instr];
        if (instr.tagId === JS_TAG_IDS.NumberF64) return [intrinsic(instr, "js.value.is_number", [instr.value])];
        if (instr.tagId === JS_TAG_IDS.Boolean) return [intrinsic(instr, "js.value.is_boolean", [instr.value])];
        if (instr.tagId === JS_TAG_IDS.Undefined) return [intrinsic(instr, "js.extern.is_undefined", [instr.value])];
        return gap(`tag.test of tag ${instr.tagId}`);
      case "dyn.undefined":
        return [intrinsic(instr, "js.value.undefined", [])];
      // ToNumber over the admitted set (number, boolean, undefined) is exactly the
      // primitive unboxer: a number reads its payload, a boolean 0/1, the
      // `undefined` singleton NaN.
      case "dyn.to_number":
        return [intrinsic(instr, "js.number.unbox", [instr.value])];
      case "dyn.eq": {
        if (instr.loose) return gap("dyn.eq (loose)");
        if (!instr.negate) return [intrinsic(instr, "js.value.strict_eq", [instr.lhs, instr.rhs])];
        const positive = fresh();
        return [
          intrinsic(instr, "js.value.strict_eq", [instr.lhs, instr.rhs], positive),
          unary("i32.eqz", positive, instr.result!, instr.resultType!),
        ];
      }
      // A front-end dynamic helper (`__ir_dyn_add`, ...) has no runtime declaration.
      case "call":
        return instr.target.binding.kind === "runtime" &&
          !irRuntimeCallableDeclaration(instr.target) &&
          [instr.resultType, ...instr.args.map((arg) => types.get(arg))].some((type) => type?.kind === "dynamic")
          ? gap(instr.target.name)
          : [instr];
      case "coerce.to_externref":
        return isDynamic(instr.value) ? gap("coerce.to_externref") : [instr];
      default:
        return instr.kind.startsWith("dyn.") ? gap(instr.kind) : [instr];
    }
  };
  const mapBuffer = (buffer: readonly IrInstr[]): readonly IrInstr[] =>
    buffer.flatMap((instr) => {
      const nested = mapNestedBuffers(instr, mapBuffer);
      return expand(nested).map((out) =>
        out.resultType?.kind === "dynamic" ? ({ ...out, resultType: CARRIER } as IrInstr) : out,
      );
    });
  const legalized: IrFunction = {
    ...fn,
    params: fn.params.map((param) => ({ ...param, type: carrierOf(param.type) })),
    resultTypes: fn.resultTypes.map(carrierOf),
    blocks: fn.blocks.map((block) => ({
      ...block,
      blockArgTypes: block.blockArgTypes.map(carrierOf),
      instrs: mapBuffer(block.instrs),
    })),
    valueCount,
  };
  // Any `dynamic` left (inside a composite type, an async frame, a closure
  // signature) has no carrier on this projection.
  if (containsDynamic(legalized)) gap("on a value of composite type");
  return legalized;
}
