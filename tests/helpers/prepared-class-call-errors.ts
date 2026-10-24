// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { CLASS_ALLOCATION_SOURCE, classAllocationInput } from "./prepared-class-values.js";
import { IrFunctionBuilder } from "../../src/ir/builder.js";
import { AllocSiteRegistry } from "../../src/ir/analysis/alloc-registry.js";
import { emitNativeTypeError } from "../../src/ir/native-errors.js";
import { prepareTypedIrProgram } from "../../src/ir/program-prepare-ir.js";
import { requireProgram } from "./typed-program-fixtures.js";

export const CLASS_CALL_ERROR_MESSAGE = "Class constructor cannot be invoked without new";
/** Constructed class IR with a real throwing Call body; source classes remain refused. */
export function classCallErrorInput(mixed = false) {
  const prefix = mixed
    ? "let trace:number=0;try{trace=read();}catch(e){trace=17;}let value:number=3;function read():number{return value;}"
    : "";
  const source =
    prefix +
    CLASS_ALLOCATION_SOURCE.replace(
      "return invoke(f,9);",
      `try{return invoke(f,9);}catch(e){return ${mixed ? "trace*100" : "200"}+seed;}`,
    );
  const { input, allocation, options } = classAllocationInput(source);
  const target = allocation.callTarget.binding;
  if (target.kind !== "unit") throw Error("class Call is not an original unit");
  const original = input.ir.functions.find((fn) => fn.unitId === target.unitId)!;
  const registry = AllocSiteRegistry.fromSnapshot(input.allocations);
  const builder = new IrFunctionBuilder(original, original.resultTypes, false, registry);
  original.params.forEach((param) => builder.addParam(param.name, param.type));
  builder.openBlock();
  emitNativeTypeError(builder, CLASS_CALL_ERROR_MESSAGE);
  builder.terminate({
    kind: "return",
    values: [builder.emitConst({ kind: "f64", value: 0 }, original.resultTypes[0]!)],
  });
  const call = builder.finish(original.closureSubtype);
  const runtimePolicy = { ...options.policy, stringConst: { storage: "native" as const } };
  return {
    input: {
      ...input,
      allocations: registry.snapshot(),
      ir: { ...input.ir, functions: input.ir.functions.map((fn) => (fn === original ? call : fn)) },
    },
    options: {
      ...options,
      policy: runtimePolicy,
      runtimePolicies: options.runtimePolicies.map((policy) => ({
        ...policy,
        stringConst: { storage: "native" as const },
      })),
    },
  };
}
export function prepareClassCallErrorProgram(mixed = false) {
  const { input, options } = classCallErrorInput(mixed);
  return requireProgram(prepareTypedIrProgram(input, options));
}
