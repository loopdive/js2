// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import {
  forEachInstrDeep,
  forEachNestedBuffer,
  type IrFunction,
  type IrInstr,
  type IrValueId,
} from "../../core/nodes.js";
import type { IrType } from "../../core/types.js";
import { irVecElemSetSymbol } from "../../core/vector-runtime.js";
import { IrUnsupportedError, IrInvariantError } from "../../../shared/contracts/ir-preparation-errors.js";

const SYMBOL = irVecElemSetSymbol({ kind: "val", val: { kind: "f64" } });
type Call = Extract<IrInstr, { kind: "call" }>;
type IntrinsicCall = Call & {
  readonly target: Call["target"] & { readonly binding: Extract<Call["target"]["binding"], { kind: "intrinsic" }> };
};
export interface NativeNumericAppendOccurrence {
  readonly fn: IrFunction;
  readonly call: Call;
  readonly receiver: IrValueId;
}
interface Definition {
  readonly type: IrType;
  readonly instruction?: IrInstr;
  readonly buffer?: readonly IrInstr[];
  readonly position: number;
}
export function isNativeNumericAppendCall(instruction: IrInstr): instruction is IntrinsicCall {
  return (
    instruction.kind === "call" &&
    instruction.target.binding.kind === "intrinsic" &&
    instruction.target.binding.symbol === SYMBOL
  );
}
const f64 = (type: IrType | undefined): boolean => type?.kind === "val" && type.val.kind === "f64" && !type.typeRef;
const i32 = (type: IrType | undefined): boolean => type?.kind === "val" && type.val.kind === "i32" && !type.typeRef;
const vector = (type: IrType | undefined): boolean => type?.kind === "vec" && !type.layout && f64(type.elementType);
function unsupported(fn: IrFunction, detail: string): never {
  throw new IrUnsupportedError("array-representation-unsupported", "build", `native numeric append: ${detail}`, {
    unitId: fn.unitId,
  });
}
function invalid(fn: IrFunction, detail: string): never {
  throw new IrInvariantError("type-map-failure", "build", `native numeric append: ${detail}`, { unitId: fn.unitId });
}

/** Recompute append sequences and length writers. Whole lexical/origin/effect validation remains required. */
export function collectNativeNumericAppendProtocol(
  functions: readonly IrFunction[],
): readonly NativeNumericAppendOccurrence[] {
  const calls: NativeNumericAppendOccurrence[] = [];
  for (const fn of functions)
    for (const body of [...fn.blocks.map((b) => b.instrs), ...(fn.asyncPlan?.states.map((s) => s.body) ?? [])])
      for (const root of body)
        forEachInstrDeep(root, (instruction) => {
          if (isNativeNumericAppendCall(instruction))
            calls.push({ fn, call: instruction, receiver: instruction.args[0]! });
        });
  if (!calls.length) return calls;
  const owners = new Set(functions.map((fn) => fn.unitId));
  if (owners.size !== functions.length) invalid(functions[0]!, "duplicate function owner");
  for (const fn of functions) {
    if (
      (fn.funcKind !== undefined && fn.funcKind !== "regular") ||
      ["asyncPlan", "asyncRuntime", "closureSubtype", "captures", "generatorBufferSlot"].some((key) =>
        Object.hasOwn(fn, key),
      )
    )
      unsupported(fn, "closed synchronous owner population is required");
    const definitions = new Map<IrValueId, Definition>();
    const define = (value: IrValueId, definition: Definition): void => {
      if (definitions.has(value)) invalid(fn, "duplicate actual SSA definition");
      definitions.set(value, definition);
    };
    fn.params.forEach((p) => define(p.value, { type: p.type, position: -1 }));
    fn.blocks.forEach((block) =>
      block.blockArgs.forEach((value, index) => {
        const type = block.blockArgTypes[index];
        if (!type) invalid(fn, "block argument lacks its type");
        define(value, { type, position: -1 });
      }),
    );
    const buffers = new Set<readonly IrInstr[]>();
    const visit = (body: readonly IrInstr[]): void => {
      if (!body.length) return;
      if (buffers.has(body)) invalid(fn, "shared or cyclic executable buffer");
      buffers.add(body);
      body.forEach((instruction, position) => {
        if (instruction.result !== null && instruction.resultType !== null)
          define(instruction.result, { type: instruction.resultType, instruction, buffer: body, position });
        forEachNestedBuffer(instruction, visit);
      });
    };
    fn.blocks.forEach((block) => visit(block.instrs));
    for (const body of buffers)
      for (const [position, instruction] of body.entries()) {
        if (instruction.kind === "vec.set_length" && vector(definitions.get(instruction.vec)?.type))
          unsupported(fn, "unproved numeric length writer is outside the closed append protocol");
        if (!isNativeNumericAppendCall(instruction)) continue;
        const receiver = definitions.get(instruction.args[0]!);
        if (
          instruction.args.length !== 3 ||
          !vector(receiver?.type) ||
          !i32(definitions.get(instruction.args[1]!)?.type) ||
          !f64(definitions.get(instruction.args[2]!)?.type) ||
          instruction.result !== null ||
          instruction.resultType !== null
        )
          invalid(fn, "canonical append signature differs from actual definitions");
        const index = definitions.get(instruction.args[1]!)!;
        const conversion = index.instruction;
        const length = conversion?.kind === "unary" ? definitions.get(conversion.rand) : undefined;
        const read = length?.instruction;
        if (
          conversion?.kind !== "unary" ||
          conversion.op !== "i32.trunc_sat_f64_s" ||
          read?.kind !== "vec.len" ||
          read.vec !== instruction.args[0] ||
          index.buffer !== body ||
          length?.buffer !== body ||
          length.position >= index.position ||
          index.position >= position
        )
          unsupported(fn, "indexed grow/store is not its original length-captured append sequence");
        const value = definitions.get(instruction.args[2]!)!;
        if (value.buffer === body && value.position >= length.position)
          unsupported(fn, "append argument must evaluate before its length capture");
        if (
          body
            .slice(length.position + 1, position)
            .some((i) => i.kind !== "const" && i.kind !== "unary" && i.kind !== "binary")
        )
          unsupported(fn, "intervening effects invalidate captured append length");
      }
  }
  return Object.freeze(calls.map((row) => Object.freeze(row)));
}
