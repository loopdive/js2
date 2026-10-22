// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { sourcePacket, typedOptions, requireProgram } from "./typed-program-fixtures.js";
import { AllocSiteRegistry } from "../../src/ir/analysis/alloc-registry.js";
import { asValueId, type IrInstr, type IrType } from "../../src/ir/core/nodes.js";
import { irUnitFuncRef } from "../../src/ir/core/callable-bindings.js";
import { CLASS_VALUE_ALLOCATION_DECLARATION } from "../../src/ir/runtime/class-value-callable.js";
import { prepareTypedIrProgram } from "../../src/ir/program-prepare-ir.js";

export const CLASS_ALLOCATION_SOURCE = `
export function make(seed:number):(x:number)=>number {return (x:number):number=>seed+x;}
export function stub():(x:number)=>number {return (x:number):number=>-99;}
export function invoke(f:(x:number)=>number,x:number):number{return f(x);}
export function run(seed:number):number {const f=make(seed); return invoke(f,9);}
`;
/** Constructed class IR in a complete source population; this does not exercise class frontend admission. */
export function classAllocationInput(source = CLASS_ALLOCATION_SOURCE) {
  const { packet } = sourcePacket({ "./entry.ts": source });
  const registry = AllocSiteRegistry.fromSnapshot(packet.allocations);
  const make = packet.ir.functions.find((fn) => fn.name === "make")!;
  const stub = packet.ir.functions.find((fn) => fn.name === "stub")!;
  const stubAllocation = stub.blocks[0]!.instrs.find((row) => row.kind === "closure.new")!;
  if (stubAllocation.kind !== "closure.new") throw Error("missing genuine noncapturing Call body");
  const construct = make.blocks[0]!.instrs.find((row) => row.kind === "closure.new")!;
  if (construct.kind !== "closure.new") throw Error("missing genuine captured Construct body");
  const packed = make.blocks[0]!.instrs.find((row) => row.kind === "coerce.to_externref")!;
  if (packed.kind !== "coerce.to_externref" || packed.resultType?.kind !== "callable")
    throw Error("missing callable return");
  const parent = asValueId(3),
    external: IrType = { kind: "val", val: { kind: "externref" } };
  const allocation: Extract<IrInstr, { kind: "class.value.new" }> = {
    kind: "class.value.new",
    signature: construct.signature,
    callTarget: stubAllocation.liftedFunc,
    allocator: CLASS_VALUE_ALLOCATION_DECLARATION.ref,
    construct: construct.result!,
    parent,
    properties: parent,
    result: packed.result,
    resultType: packed.resultType,
    alloc: registry.fresh("closure", packed.resultType),
  };
  const instructions: IrInstr[] = [
    construct,
    { kind: "const", value: { kind: "null", ty: external }, result: parent, resultType: external },
    allocation,
  ];
  const fn = { ...make, blocks: [{ ...make.blocks[0]!, instrs: instructions }] };
  // Keep the lifted Call body reachable ONLY through class.value.new. A separate
  // closure.new for this same body would mask missing ref.func declarations.
  if (stubAllocation.alloc === undefined) throw Error("missing original stub allocation provenance");
  registry.retire(stubAllocation.alloc);
  const stubFunction = {
    ...stub,
    blocks: [
      {
        ...stub.blocks[0]!,
        instrs: [
          {
            kind: "const" as const,
            value: { kind: "f64" as const, value: 0 },
            result: asValueId(0),
            resultType: construct.captureFieldTypes[0]!,
          },
          {
            kind: "call" as const,
            target: irUnitFuncRef(make),
            args: [asValueId(0)],
            result: asValueId(1),
            resultType: packed.resultType,
          },
        ],
      },
    ],
  };
  const input = {
    ...packet,
    ir: {
      ...packet.ir,
      functions: packet.ir.functions.map((row) => (row === make ? fn : row === stub ? stubFunction : row)),
    },
    allocations: registry.snapshot(),
  };
  return { input, allocation, make: fn, construct, options: typedOptions };
}
export function prepareClassAllocationProgram(source?: string) {
  const { input, options } = classAllocationInput(source);
  return requireProgram(prepareTypedIrProgram(input, options));
}
