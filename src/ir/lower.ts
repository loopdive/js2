// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// Explicit compatibility surface. Implementations live at their owning seams.
export { lowerIrFunctionBody, lowerIrTypeToValType, bufferHasBrLabel, collectForOfBodyUses } from "./lower-generic.js";
export { wasmValueTypeConverter, projectIrFunctionSignature, lowerIrFunctionToWasm } from "./backend/wasm-lowering.js";
export { emitConstInstr } from "./backend/wasm-constants.js";
export type {
  IrLowerResolver,
  IrLowerResult,
  IrLoweredValue,
  IrLoweredBody,
  IrLoweredSignature,
  IrBoxedLowering,
  IrClassLowering,
  IrClosureLowering,
  IrDynamicLowering,
  IrFnctorLowering,
  IrObjectStructLowering,
  IrRefCellLowering,
  IrUnionLowering,
  IrVecLowering,
} from "./backend/lower-contracts.js";
