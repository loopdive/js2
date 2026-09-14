// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Middle-end SSA IR — per spec #1131.
//
// This file is intentionally separate from `types.ts` (the backend Wasm IR).
// The middle-end IR sits between the TypedAST and the Wasm IR, and carries:
//   - Symbolic references to functions, globals, and types (not raw indices).
//   - Typed SSA value nodes carrying IrType, not ValType.
//   - Basic-block structure with block arguments (linear SSA with blockargs).
//   - Source location metadata (for error reporting and debug info).
//
// Phase 1 scope: the smallest set of node shapes needed to describe
// `function f(): number { return <literal>; }`. The union is open —
// Phase 2 & 3 widen the Instr and Terminator sets.

import type { IrType } from "./core/types.js";
import type { ValType } from "./types.js";
export type {
  IrTypeBinding,
  IrTypeRef,
  IrVecLayoutRef,
  IrObjectShape,
  IrClosureSignature,
  IrClassFieldDescriptor,
  IrClassMemberKind,
  IrClassMethodDescriptor,
  IrClassShape,
  IrType,
} from "./core/types.js";
export {
  IR_CLASS_SHAPE_CELL,
  irVal,
  irVec,
  irFnctor,
  asVal,
  irDynamic,
  irTypeEquals,
  classShapeEquals,
  closureSignatureEquals,
  objectShapeEquals,
} from "./core/types.js";
export type { IrDomCallbackAuthority } from "./capability-provenance.js";
export type { IrCallableBinding, IrFuncRef, IrGlobalBinding, IrGlobalRef } from "./value-references.js";
export type {
  IrValueId,
  IrLabelId,
  AllocSiteId,
  AllocKind,
  IrConst,
  IrSiteId,
  IrInstrBase,
  IrInstrConst,
  IrInstrCall,
  IrIntrinsicBackendOp,
  IrIntrinsicBackendSequence,
  IrIntrinsicBackendComposite,
  IrIntrinsicProvider,
  IrInstrIntrinsic,
  IrInstrGlobalGet,
  IrInstrGlobalSet,
  IrBinop,
  IrUnop,
  IrInstrBinary,
  IrInstrUnary,
  IrInstrSelect,
  IrInstrIf,
  IrInstrRawWasm,
  IrInstrBox,
  IrInstrUnbox,
  IrInstrTagTest,
  IrInstrStringConst,
  IrInstrStringConcat,
  IrInstrStringEq,
  IrInstrStringLen,
  IrStringLengthProvider,
  IrInstrFnctorNew,
  IrInstrFnctorGet,
  IrInstrObjectNew,
  IrInstrObjectGet,
  IrInstrObjectSet,
  IrInstrClosureNew,
  IrInstrClosureCap,
  IrInstrClosureCall,
  IrInstrRefCellNew,
  IrInstrRefCellGet,
  IrInstrRefCellSet,
  IrInstrClassNew,
  IrInstrClassGet,
  IrInstrClassSet,
  IrInstrClassCall,
  IrInstrClassSuperInit,
  IrInstrClassSuperCall,
  IrInstrClassInstanceOf,
  IrInstrClassStaticCall,
  IrInstrSlotRead,
  IrInstrSlotWrite,
  IrInstrVecLen,
  IrInstrVecGet,
  IrInstrVecSet,
  IrInstrVecSetLength,
  IrInstrVecNewFixed,
  IrInstrForOfVec,
  IrInstrCoerceToExternref,
  IrInstrThrow,
  IrInstrEarlyReturn,
  IrInstrWhileLoop,
  IrInstrForLoop,
  IrInstrTry,
  IrInstrBrLabel,
  IrInstrIfStmt,
  IrInstrLabeledBlock,
  IrInstrSwitch,
  IrInstr,
  IrSlotDef,
  IrBranch,
  IrBlockId,
  IrTerminatorReturn,
  IrTerminatorBr,
  IrTerminatorBrIf,
  IrTerminatorUnreachable,
  IrTerminator,
  IrBlock,
  IrParam,
  IrDeclaredSignature,
  IrModuleDeclarations,
  IrInstrAwait,
  IrInstrAsyncReturn,
  IrInstrAsyncThrow,
  IrInstrDynTruthy,
  IrInstrDynToNumber,
  IrInstrDynEq,
  IrInstrDynMemberGet,
  IrInstrDynMemberSet,
  IrInstrGenPush,
  IrInstrIterNew,
  IrInstrIterNext,
  IrInstrIterDone,
  IrInstrIterValue,
  IrInstrIterReturn,
  IrInstrForOfIter,
  IrInstrGenEpilogue,
  IrInstrGenYieldStar,
  IrInstrGenSetReturn,
  IrInstrExternNew,
  IrInstrExternCall,
  IrInstrExternProp,
  IrInstrExternPropSet,
  IrInstrRegExpLiteral,
  IrInstrStringRepeat,
  IrInstrStringCharAt,
  IrInstrStringCharCodeAt,
  IrInstrForOfString,
} from "./core/nodes.js";
export {
  asValueId,
  asLabelId,
  asAllocSiteId,
  asBlockId,
  forEachNestedBuffer,
  forEachInstrDeep,
  mapNestedBuffers,
  directUses,
  collectUses,
  IrValueIdAllocator,
} from "./core/nodes.js";
export type { PreparedIrFunction as IrFunction, PreparedIrModule as IrModule } from "./async-plan.js";

/**
 * Wrap a ValType as an IrType with an explicit signedness fact (#1126 Stage 1).
 * Use this only for `i32` ValTypes where the value-domain (signed `int32` vs
 * unsigned `uint32`) is known. For non-i32 ValTypes the `signed` flag is
 * meaningless; callers should use `irVal()` instead.
 *
 * The flag is read by Stage 3 emit decisions (signed vs unsigned shifts,
 * comparisons, conversions back to f64). For Stage 1 it is purely additive —
 * no existing emitter consults it yet.
 */
export function irValSigned(v: ValType, signed: boolean): IrType {
  return { kind: "val", val: v, signed };
}

/** #2949 slice 1 — narrow an IrType to its dynamic arm (refined or not). */
export function isDynamic(t: IrType): t is Extract<IrType, { kind: "dynamic" }> {
  return t.kind === "dynamic";
}
