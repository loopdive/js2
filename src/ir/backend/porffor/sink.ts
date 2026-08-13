// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { AllocSiteId, IrBinop, IrInstr, IrType, IrUnop } from "../../nodes.js";
import { asVal } from "../../nodes.js";
import type { LinearAllocationSitePlan } from "../../analysis/linear-memory-plan.js";
import type { LinearStringRuntimeBinding, LinearStringRuntimeRequest } from "../../analysis/linear-string-runtime.js";
import type { IrStringConcatMode, IrStringEncoding } from "../../string-runtime.js";
import type { BlockType, Instr } from "../../types.js";
import type {
  BackendEmitter,
  BackendI32BitwiseOp,
  BackendNumericConversionOp,
  BackendScalarConstType,
} from "../emitter.js";
import type {
  IrClassLowering,
  IrClosureLowering,
  IrObjectStructLowering,
  IrRefCellLowering,
  IrVecLowering,
  LinearVecLowering,
  PlannedObjectLowering,
} from "../handles.js";
import type { PorfforValueSlot } from "./type-converter.js";

/** Frozen Porffor FX bits, kept on symbolic nodes until final assembly. */
export const PORFFOR_FX = {
  none: 0,
  readMem: 1,
  writeMem: 2,
  call: 4,
  readGlobal: 8,
  writeLocal: 16,
} as const;

export type PorfforLocalRef =
  | { readonly kind: "lowered"; readonly index: number }
  | { readonly kind: "scratch"; readonly name: string; readonly type: PorfforTypeRef };

export type PorfforTypeRef =
  | PorfforValueSlot
  | { readonly kind: "local"; readonly local: PorfforLocalRef }
  | { readonly kind: "global"; readonly handle: number };

export type PorfforMemoryCType = "u8" | "i32" | "u32" | "f64";

interface PorfforExprBase {
  readonly type: PorfforTypeRef;
  readonly effects: number;
}

export type PorfforExpr =
  | (PorfforExprBase & { readonly kind: "const"; readonly value: number | bigint })
  | (PorfforExprBase & { readonly kind: "local"; readonly local: PorfforLocalRef })
  | (PorfforExprBase & { readonly kind: "global"; readonly handle: number })
  | (PorfforExprBase & {
      readonly kind: "binary";
      readonly op: string;
      readonly left: PorfforExpr;
      readonly right: PorfforExpr;
      readonly comparison: boolean;
    })
  | (PorfforExprBase & { readonly kind: "unary"; readonly op: string; readonly value: PorfforExpr })
  | (PorfforExprBase & {
      readonly kind: "select";
      readonly condition: PorfforExpr;
      readonly whenTrue: PorfforExpr;
      readonly whenFalse: PorfforExpr;
    })
  | (PorfforExprBase & {
      readonly kind: "convert";
      readonly value: PorfforExpr;
      readonly flags: number;
    })
  | (PorfforExprBase & {
      readonly kind: "alloc";
      readonly bytes: PorfforExpr;
      readonly typeId: number;
      readonly siteId: number;
    })
  | (PorfforExprBase & {
      readonly kind: "load";
      readonly ctype: PorfforMemoryCType;
      readonly pointer: PorfforExpr;
      readonly offset: number;
    })
  | (PorfforExprBase & { readonly kind: "call"; readonly target: number; readonly args: readonly PorfforExpr[] });

export type PorfforTarget =
  | { readonly kind: "local"; readonly local: PorfforLocalRef }
  | { readonly kind: "global"; readonly handle: number };

export type PorfforStatement =
  | { readonly kind: "assign"; readonly target: PorfforTarget; readonly value: PorfforExpr }
  | { readonly kind: "expr"; readonly value: PorfforExpr }
  | {
      readonly kind: "if";
      readonly controlId: number;
      readonly condition: PorfforExpr;
      readonly then: readonly PorfforStatement[];
      readonly else: readonly PorfforStatement[];
    }
  | { readonly kind: "block"; readonly controlId: number; readonly body: readonly PorfforStatement[] }
  | { readonly kind: "loop"; readonly controlId: number; readonly body: readonly PorfforStatement[] }
  | { readonly kind: "branch"; readonly depth: number; readonly condition?: PorfforExpr }
  | {
      readonly kind: "store";
      readonly ctype: PorfforMemoryCType;
      readonly pointer: PorfforExpr;
      readonly offset: number;
      readonly value: PorfforExpr;
    }
  | {
      readonly kind: "mem-copy";
      readonly destination: PorfforExpr;
      readonly source: PorfforExpr;
      readonly bytes: PorfforExpr;
      readonly mayOverlap: boolean;
    }
  | { readonly kind: "gc-barrier"; readonly pointer: PorfforExpr; readonly typeId: PorfforExpr }
  | { readonly kind: "return"; readonly value: PorfforExpr | null }
  | { readonly kind: "unreachable" };

export interface PorfforFunctionSymbol {
  readonly name: string;
  readonly params: readonly PorfforValueSlot[];
  readonly results: readonly PorfforValueSlot[];
}

export interface PorfforGlobalSymbol {
  readonly name: string;
  readonly type: PorfforValueSlot;
}

/** Symbol lookup stays handle-based until the module assembler freezes. */
export interface PorfforSymbolResolver {
  functionSymbol(handle: number): PorfforFunctionSymbol;
  globalSymbol(handle: number): PorfforGlobalSymbol;
  bindLinearStringRuntime(request: LinearStringRuntimeRequest): LinearStringRuntimeBinding;
}

export interface PorfforScratchLocal {
  readonly name: string;
  readonly type: PorfforTypeRef;
}

class PorfforFunctionContext {
  readonly scratchLocals: PorfforScratchLocal[] = [];
  private nextControlId = 0;

  scratch(type: PorfforTypeRef): PorfforLocalRef {
    const name = `#js2_tmp_${this.scratchLocals.length}`;
    const local: PorfforLocalRef = { kind: "scratch", name, type };
    this.scratchLocals.push({ name, type });
    return local;
  }

  controlId(): number {
    return this.nextControlId++;
  }
}

/**
 * Structured Porffor builder used by the generic stack-oriented lowerer.
 *
 * Expressions remain symbolic trees on `values`; statements are committed in
 * source order. Before a statement is appended, every older pending value is
 * spilled to a function-scoped scratch. This is the key ordering invariant:
 * a later assignment/control edge can never move ahead of an earlier local or
 * global read merely because C evaluates the eventual expression later.
 */
export class PorfforSink {
  readonly statements: PorfforStatement[] = [];
  readonly values: PorfforExpr[] = [];

  constructor(private readonly context: PorfforFunctionContext) {}

  scratchLocals(): readonly PorfforScratchLocal[] {
    return this.context.scratchLocals;
  }

  push(value: PorfforExpr): void {
    this.values.push(value);
  }

  pop(where: string): PorfforExpr {
    const value = this.values.pop();
    if (!value) throw new Error(`porffor sink: value stack underflow in ${where}`);
    return value;
  }

  popMany(count: number, where: string): PorfforExpr[] {
    if (this.values.length < count) {
      throw new Error(`porffor sink: value stack underflow in ${where} (need ${count}, have ${this.values.length})`);
    }
    return this.values.splice(this.values.length - count, count);
  }

  /** Spill every older pending operand before a statement can observe state. */
  flushValues(): void {
    for (let i = 0; i < this.values.length; i++) {
      const value = this.values[i]!;
      const local = this.spillDirect(value);
      this.values[i] = localExpr(local);
    }
  }

  /** Evaluate expressions eagerly and in the exact supplied order. */
  sequence(expressions: readonly PorfforExpr[]): PorfforExpr[] {
    this.flushValues();
    return expressions.map((expression) => localExpr(this.spillDirect(expression)));
  }

  append(statement: PorfforStatement): void {
    this.flushValues();
    this.statements.push(statement);
  }

  assertEmpty(where: string): void {
    if (this.values.length !== 0) {
      throw new Error(`porffor sink: ${this.values.length} dangling value(s) in ${where}`);
    }
  }

  private spillDirect(value: PorfforExpr): PorfforLocalRef {
    const local = this.context.scratch(value.type);
    this.statements.push({ kind: "assign", target: { kind: "local", local }, value });
    return local;
  }
}

function localExpr(local: PorfforLocalRef): PorfforExpr {
  return {
    kind: "local",
    type: { kind: "local", local },
    effects: PORFFOR_FX.none,
    local,
  };
}

function irTypeSlot(type: IrType): PorfforValueSlot {
  if (type.kind === "string" || type.kind === "vec") return "ptr";
  const val = asVal(type);
  if (!val) throw new Error(`porffor backend does not support IR type '${type.kind}'`);
  switch (val.kind) {
    case "f64":
      return "f64";
    case "i32":
      return type.kind === "val" && type.signed === false ? "u32" : "i32";
    case "i64":
      return type.kind === "val" && type.signed === false ? "u64" : "i64";
    default:
      throw new Error(`porffor backend does not support ValType '${val.kind}'`);
  }
}

type VecLayout = IrVecLowering | LinearVecLowering;

function asPlannedObject(layout: IrObjectStructLowering | IrClassLowering): PlannedObjectLowering {
  if (!("linearMemory" in layout)) {
    throw new Error("porffor backend requires a shared linear-memory object handle");
  }
  return layout as PlannedObjectLowering;
}

function asPlannedVec(layout: VecLayout): LinearVecLowering {
  if (!("linearMemory" in layout)) {
    throw new Error("porffor backend requires a shared linear-memory vector handle");
  }
  return layout;
}

function memoryCType(type: { readonly kind: string }): PorfforMemoryCType {
  if (type.kind === "f64") return "f64";
  if (type.kind === "i32") return "i32";
  throw new Error(`porffor backend does not support planned memory value type '${type.kind}'`);
}

function allocateExpr(bytes: number | PorfforExpr, siteId: number): PorfforExpr {
  const size: PorfforExpr =
    typeof bytes === "number" ? { kind: "const", type: "u32", effects: PORFFOR_FX.none, value: bytes } : bytes;
  return {
    kind: "alloc",
    type: "ptr",
    effects: PORFFOR_FX.call,
    bytes: size,
    // Type id zero is deliberately representation-neutral in the selected
    // non-collecting arena. No Porffor object/array type is claimed here.
    typeId: 0,
    siteId,
  };
}

// Historical name retained so semantic emitters keep the same allocation
// interface. The plan-aware assembler selects arena versus stack storage.
function requireArenaAllocation(
  allocation: LinearAllocationSitePlan | undefined,
  family: string,
): LinearAllocationSitePlan & { readonly size: { readonly kind: "constant"; readonly bytes: number } } {
  if (!allocation) throw new Error(`porffor backend requires a planned allocation site for ${family}`);
  if (allocation.allocationClass !== "arena" && allocation.allocationClass !== "stack") {
    throw new Error(
      `porffor backend supports arena/stack allocation only; site ${allocation.id as number} is ${allocation.allocationClass}`,
    );
  }
  if (allocation.size.kind !== "constant") {
    throw new Error(`porffor backend requires a constant planned allocation size for ${family}`);
  }
  if (allocation.root.kind !== "none" || allocation.safepoints.kind !== "none" || allocation.barrier.kind !== "none") {
    throw new Error(
      `porffor allocation site ${allocation.id as number} unexpectedly requires roots, safepoints, or barriers`,
    );
  }
  return allocation as LinearAllocationSitePlan & {
    readonly size: { readonly kind: "constant"; readonly bytes: number };
  };
}

function addPointerOffset(pointer: PorfforExpr, offset: number): PorfforExpr {
  if (offset === 0) return pointer;
  return {
    kind: "binary",
    type: "ptr",
    effects: pointer.effects,
    op: "+",
    left: pointer,
    right: { kind: "const", type: "u32", effects: PORFFOR_FX.none, value: offset },
    comparison: false,
  };
}

function scalarConst(type: PorfforValueSlot, value: number): PorfforExpr {
  return { kind: "const", type, effects: PORFFOR_FX.none, value };
}

function binaryExpr(
  type: PorfforValueSlot,
  op: string,
  left: PorfforExpr,
  right: PorfforExpr,
  comparison = false,
): PorfforExpr {
  return {
    kind: "binary",
    type: comparison ? "i32" : type,
    effects: left.effects | right.effects,
    op,
    left,
    right,
    comparison,
  };
}

function loadExpr(
  ctype: PorfforMemoryCType,
  type: PorfforValueSlot,
  pointer: PorfforExpr,
  offset: number,
): PorfforExpr {
  return { kind: "load", type, effects: pointer.effects | PORFFOR_FX.readMem, ctype, pointer, offset };
}

function requireStringAllocation(binding: LinearStringRuntimeBinding, family: string): LinearAllocationSitePlan {
  const allocation = binding.allocation;
  if (!allocation) throw new Error(`porffor backend requires a planned allocation site for ${family}`);
  if (allocation.allocationClass !== "arena" && allocation.allocationClass !== "stack") {
    throw new Error(
      `porffor backend supports arena/stack allocation only; site ${allocation.id as number} is ${allocation.allocationClass}`,
    );
  }
  if (allocation.root.kind !== "none" || allocation.safepoints.kind !== "none" || allocation.barrier.kind !== "none") {
    throw new Error(`porffor string allocation site ${allocation.id as number} requires unsupported GC coordination`);
  }
  return allocation;
}

/** Scalar/control-flow BackendEmitter implementation for Porffor's tree IR. */
export class PorfforEmitter implements BackendEmitter<PorfforSink> {
  readonly backend = "porffor" as const;
  private readonly context = new PorfforFunctionContext();

  constructor(
    private readonly symbols: PorfforSymbolResolver,
    private readonly resultSlots: readonly PorfforValueSlot[],
  ) {
    if (resultSlots.length > 1) throw new Error("porffor backend does not support multi-value function results");
  }

  scratchLocals(): readonly PorfforScratchLocal[] {
    return this.context.scratchLocals;
  }

  newSink(): PorfforSink {
    return new PorfforSink(this.context);
  }

  pushRaw(_out: PorfforSink, instr: Instr): void {
    throw new Error(`porffor backend does not support raw Wasm instruction '${instr.op}'`);
  }

  emitStringConst(value: string, alloc: AllocSiteId | undefined, out: PorfforSink): void {
    const binding = this.symbols.bindLinearStringRuntime({ intrinsic: "constant", alloc });
    const allocation = requireStringAllocation(binding, "string.const");
    if (allocation.size.kind !== "constant") {
      throw new Error("porffor backend requires a constant planned allocation size for string.const");
    }
    const bytes = [...value].map((character) => character.charCodeAt(0));
    if (bytes.some((byte) => byte > 0x7f)) {
      throw new Error("porffor backend received non-ASCII string.const after ASCII proof");
    }
    const [pointer] = out.sequence([allocateExpr(allocation.size.bytes, allocation.id as number)]);
    out.append({
      kind: "store",
      ctype: "u32",
      pointer: pointer!,
      offset: binding.layout.payloadSizeOffset,
      value: scalarConst("u32", binding.layout.payloadPrefixBytes + bytes.length),
    });
    out.append({
      kind: "store",
      ctype: "u32",
      pointer: pointer!,
      offset: binding.layout.lengthOffset,
      value: scalarConst("u32", bytes.length),
    });
    bytes.forEach((byte, index) => {
      out.append({
        kind: "store",
        ctype: "u8",
        pointer: pointer!,
        offset: binding.layout.elementsOffset + index,
        value: scalarConst("u32", byte),
      });
    });
    out.push(pointer!);
  }

  emitStringConcat(alloc: AllocSiteId | undefined, mode: IrStringConcatMode, out: PorfforSink): void {
    const binding = this.symbols.bindLinearStringRuntime({ intrinsic: "concat", alloc });
    const allocation = requireStringAllocation(binding, "string.concat");
    const [left, right] = out.sequence(out.popMany(2, "string.concat"));
    const [leftLength, rightLength] = out.sequence([
      loadExpr("u32", "u32", left!, binding.layout.lengthOffset),
      loadExpr("u32", "u32", right!, binding.layout.lengthOffset),
    ]);
    const total = binaryExpr("u32", "+", leftLength!, rightLength!);
    if (mode === "owned-append") {
      const [payloadSize] = out.sequence([loadExpr("u32", "u32", left!, binding.layout.payloadSizeOffset)]);
      const capacity = binaryExpr("u32", "-", payloadSize!, scalarConst("u32", binding.layout.payloadPrefixBytes));
      const resultLocal = this.context.scratch("ptr");
      const result = localExpr(resultLocal);
      const leftDestination = addPointerOffset(left!, binding.layout.elementsOffset);
      const appendDestination = binaryExpr("ptr", "+", leftDestination, leftLength!);
      const doubledCapacity = binaryExpr("u32", "*", capacity!, scalarConst("u32", 2));
      const minimumCapacity: PorfforExpr = {
        kind: "select",
        type: "u32",
        effects: doubledCapacity.effects,
        condition: binaryExpr("i32", "<", doubledCapacity, scalarConst("u32", 16), true),
        whenTrue: scalarConst("u32", 16),
        whenFalse: doubledCapacity,
      };
      const nextCapacity: PorfforExpr = {
        kind: "select",
        type: "u32",
        effects: minimumCapacity.effects | total.effects,
        condition: binaryExpr("i32", "<", minimumCapacity, total, true),
        whenTrue: total,
        whenFalse: minimumCapacity,
      };
      const allocationBytes = binaryExpr("u32", "+", scalarConst("u32", binding.layout.elementsOffset), nextCapacity);
      const grownPointer = allocateExpr(allocationBytes, allocation.id as number);
      const grownDestination = addPointerOffset(result, binding.layout.elementsOffset);
      out.append({
        kind: "if",
        controlId: this.context.controlId(),
        condition: binaryExpr("i32", "<=", total, capacity!, true),
        then: [
          {
            kind: "mem-copy",
            destination: appendDestination,
            source: addPointerOffset(right!, binding.layout.elementsOffset),
            bytes: rightLength!,
            mayOverlap: false,
          },
          {
            kind: "store",
            ctype: "u32",
            pointer: left!,
            offset: binding.layout.lengthOffset,
            value: total,
          },
          { kind: "assign", target: { kind: "local", local: resultLocal }, value: left! },
        ],
        else: [
          { kind: "assign", target: { kind: "local", local: resultLocal }, value: grownPointer },
          {
            kind: "store",
            ctype: "u32",
            pointer: result,
            offset: binding.layout.payloadSizeOffset,
            value: binaryExpr("u32", "+", scalarConst("u32", binding.layout.payloadPrefixBytes), nextCapacity),
          },
          {
            kind: "store",
            ctype: "u32",
            pointer: result,
            offset: binding.layout.lengthOffset,
            value: total,
          },
          {
            kind: "mem-copy",
            destination: grownDestination,
            source: addPointerOffset(left!, binding.layout.elementsOffset),
            bytes: leftLength!,
            mayOverlap: false,
          },
          {
            kind: "mem-copy",
            destination: binaryExpr("ptr", "+", grownDestination, leftLength!),
            source: addPointerOffset(right!, binding.layout.elementsOffset),
            bytes: rightLength!,
            mayOverlap: false,
          },
        ],
      });
      out.push(result);
      return;
    }

    const bytes = binaryExpr("u32", "+", scalarConst("u32", binding.layout.elementsOffset), total);
    const [pointer] = out.sequence([allocateExpr(bytes, allocation.id as number)]);
    out.append({
      kind: "store",
      ctype: "u32",
      pointer: pointer!,
      offset: binding.layout.payloadSizeOffset,
      value: binaryExpr("u32", "+", scalarConst("u32", binding.layout.payloadPrefixBytes), total),
    });
    out.append({
      kind: "store",
      ctype: "u32",
      pointer: pointer!,
      offset: binding.layout.lengthOffset,
      value: total,
    });
    const destination = addPointerOffset(pointer!, binding.layout.elementsOffset);
    out.append({
      kind: "mem-copy",
      destination,
      source: addPointerOffset(left!, binding.layout.elementsOffset),
      bytes: leftLength!,
      mayOverlap: false,
    });
    out.append({
      kind: "mem-copy",
      destination: binaryExpr("ptr", "+", destination, leftLength!),
      source: addPointerOffset(right!, binding.layout.elementsOffset),
      bytes: rightLength!,
      mayOverlap: false,
    });
    out.push(pointer!);
  }

  emitStringEquals(_negate: boolean, _out: PorfforSink): void {
    throw new Error("porffor backend does not yet support string.eq");
  }

  emitStringLength(inputEncoding: IrStringEncoding | undefined, out: PorfforSink): void {
    const binding = this.symbols.bindLinearStringRuntime({ intrinsic: "length", inputEncoding });
    const pointer = out.pop("string.length");
    out.push(convertExpr("f64", loadExpr("u32", "u32", pointer, binding.layout.lengthOffset), 0));
  }

  emitStringCharAt(alloc: AllocSiteId | undefined, inputEncoding: IrStringEncoding, out: PorfforSink): void {
    const binding = this.symbols.bindLinearStringRuntime({ intrinsic: "char-at", alloc, inputEncoding });
    const allocation = requireStringAllocation(binding, "string.char_at");
    const [pointer, index] = out.sequence(out.popMany(2, "string.char_at"));
    const [length] = out.sequence([loadExpr("u32", "u32", pointer!, binding.layout.lengthOffset)]);
    const nonNegative = binaryExpr("i32", ">=", index!, scalarConst("i32", 0), true);
    const belowLength = binaryExpr("i32", "<", convertExpr("u32", index!, 0), length!, true);
    const inBounds = binaryExpr("i32", "&&", nonNegative, belowLength);
    const resultLength: PorfforExpr = {
      kind: "select",
      type: "u32",
      effects: inBounds.effects,
      condition: inBounds,
      whenTrue: scalarConst("u32", 1),
      whenFalse: scalarConst("u32", 0),
    };
    const [result] = out.sequence([allocateExpr(binding.layout.elementsOffset + 1, allocation.id as number)]);
    out.append({
      kind: "store",
      ctype: "u32",
      pointer: result!,
      offset: binding.layout.payloadSizeOffset,
      value: binaryExpr("u32", "+", scalarConst("u32", binding.layout.payloadPrefixBytes), resultLength),
    });
    out.append({
      kind: "store",
      ctype: "u32",
      pointer: result!,
      offset: binding.layout.lengthOffset,
      value: resultLength,
    });
    const indexedPointer = binaryExpr(
      "ptr",
      "+",
      addPointerOffset(pointer!, binding.layout.elementsOffset),
      convertExpr("u32", index!, 0),
    );
    out.append({
      kind: "store",
      ctype: "u8",
      pointer: result!,
      offset: binding.layout.elementsOffset,
      value: {
        kind: "select",
        type: "u32",
        effects: inBounds.effects | PORFFOR_FX.readMem,
        condition: inBounds,
        whenTrue: loadExpr("u8", "u32", indexedPointer, 0),
        whenFalse: scalarConst("u32", 0),
      },
    });
    out.push(result!);
  }

  emitStringCharCodeAt(inputEncoding: IrStringEncoding, out: PorfforSink): void {
    const binding = this.symbols.bindLinearStringRuntime({ intrinsic: "char-code-at", inputEncoding });
    const [pointer, index] = out.sequence(out.popMany(2, "string.char_code_at"));
    const [length] = out.sequence([loadExpr("u32", "u32", pointer!, binding.layout.lengthOffset)]);
    const nonNegative = binaryExpr("i32", ">=", index!, scalarConst("i32", 0), true);
    const belowLength = binaryExpr("i32", "<", convertExpr("u32", index!, 0), length!, true);
    const inBounds = binaryExpr("i32", "&&", nonNegative, belowLength);
    const indexedPointer = binaryExpr(
      "ptr",
      "+",
      addPointerOffset(pointer!, binding.layout.elementsOffset),
      convertExpr("u32", index!, 0),
    );
    out.push({
      kind: "select",
      type: "f64",
      effects: inBounds.effects | PORFFOR_FX.readMem,
      condition: inBounds,
      whenTrue: convertExpr("f64", loadExpr("u8", "u32", indexedPointer, 0), 0),
      whenFalse: scalarConst("f64", Number.NaN),
    });
  }

  emitConst(instr: Extract<IrInstr, { kind: "const" }>, _funcName: string, out: PorfforSink): void {
    const type = instr.resultType ? irTypeSlot(instr.resultType) : constSlot(instr);
    switch (instr.value.kind) {
      case "bool":
        out.push({ kind: "const", type, effects: PORFFOR_FX.none, value: instr.value.value ? 1 : 0 });
        return;
      case "i32":
      case "i64":
      case "f64":
        out.push({ kind: "const", type, effects: PORFFOR_FX.none, value: instr.value.value });
        return;
      default:
        throw new Error(`porffor backend does not support const '${instr.value.kind}'`);
    }
  }

  emitBinary(op: IrBinop, out: PorfforSink): void {
    let [left, right] = out.popMany(2, `binary ${op}`);
    const effects = left!.effects | right!.effects;
    if (effects !== PORFFOR_FX.none) [left, right] = out.sequence([left!, right!]);

    // (#3758) Native i32 arithmetic — computed via u32 (unsigned) arithmetic
    // and converted back to i32. Signed-integer-overflow is undefined
    // behavior in C; unsigned arithmetic wraps modulo 2^32 by definition,
    // and the resulting BIT PATTERN is identical to true two's-complement
    // wrapped signed arithmetic (the same fact `emitI32Bitwise`'s shl/shr_s
    // arms already lean on to sidestep C UB — see their comments below).
    if (op === "i32.add" || op === "i32.sub" || op === "i32.mul") {
      const lu = convertExpr("u32", left!, 0);
      const ru = convertExpr("u32", right!, 0);
      const opSymbol = op === "i32.add" ? "+" : op === "i32.sub" ? "-" : "*";
      const sum: PorfforExpr = {
        kind: "binary",
        type: "u32",
        effects: lu.effects | ru.effects,
        op: opSymbol,
        left: lu,
        right: ru,
        comparison: false,
      };
      out.push(convertExpr("i32", sum, 1));
      return;
    }

    const mapped = binaryOp(op);
    const operandType = mapped.operandType ?? left!.type;
    if (mapped.operandType && mapped.operandType !== left!.type) {
      left = convertExpr(mapped.operandType, left!, mapped.unsigned ? 0 : 1);
      right = convertExpr(mapped.operandType, right!, mapped.unsigned ? 0 : 1);
    }
    out.push({
      kind: "binary",
      type: mapped.comparison ? "i32" : operandType,
      effects: left!.effects | right!.effects,
      op: mapped.op,
      left: left!,
      right: right!,
      comparison: mapped.comparison,
    });
  }

  emitUnary(op: IrUnop, out: PorfforSink): void {
    const value = out.pop(`unary ${op}`);
    switch (op) {
      case "f64.neg":
        out.push({ kind: "unary", type: "f64", effects: value.effects, op: "neg", value });
        return;
      case "f64.reinterpret_i64":
      case "i64.reinterpret_f64":
        throw new Error(`porffor backend does not support unary op '${op}'`);
      case "i32.eqz":
        out.push({ kind: "unary", type: "i32", effects: value.effects, op: "!", value });
        return;
      case "i32.trunc_sat_f64_s":
        out.push(convertExpr("i32", value, 1));
        return;
      case "f64.convert_i32_s":
        out.push(convertExpr("f64", value, 1));
        return;
      case "i64.trunc_f64_s":
        // This trapping conversion is emitted only in an AOT-proven arm or
        // behind explicit finite/integral/signed-i64 bounds checks.
        out.push(convertExpr("i64", value, 3));
        return;
      case "f64.convert_i64_s":
        out.push(convertExpr("f64", value, 1));
        return;
      case "f64.abs":
      case "f64.sqrt":
      case "f64.floor":
      case "f64.ceil":
      case "f64.trunc":
        out.push({ kind: "unary", type: "f64", effects: value.effects, op: op.slice(4), value });
        return;
      case "ref.is_null":
        throw new Error(`porffor backend does not support unary op '${op}'`);
    }
  }

  emitScalarConst(type: BackendScalarConstType, value: number, out: PorfforSink): void {
    out.push({ kind: "const", type, effects: PORFFOR_FX.none, value });
  }

  emitNumericConversion(op: BackendNumericConversionOp, out: PorfforSink): void {
    const value = out.pop(`numeric conversion ${op}`);
    switch (op) {
      case "i32.trunc_sat_f64_u":
        // The shared ToInt32 expansion has already reduced the f64 modulo
        // 2^32. Keep rangeKnown clear so NaN/Infinity still use Porffor's
        // defined saturating helper and become zero rather than a raw C cast.
        out.push(convertExpr("u32", value, 0));
        return;
      case "f64.convert_i32_s":
        out.push(convertExpr("f64", convertExpr("i32", value, 1), 1));
        return;
      case "f64.convert_i32_u":
        out.push(convertExpr("f64", convertExpr("u32", value, 0), 0));
        return;
    }
  }

  emitI32Bitwise(op: BackendI32BitwiseOp, out: PorfforSink): void {
    let [left, right] = out.popMany(2, `i32 bitwise ${op}`);
    if ((left!.effects | right!.effects) !== PORFFOR_FX.none) [left, right] = out.sequence([left!, right!]);

    const signed = (value: PorfforExpr): PorfforExpr => convertExpr("i32", value, 1);
    const unsigned = (value: PorfforExpr): PorfforExpr => convertExpr("u32", value, 0);
    const binary = (type: "i32" | "u32", operator: string, lhs: PorfforExpr, rhs: PorfforExpr): PorfforExpr => ({
      kind: "binary",
      type,
      effects: lhs.effects | rhs.effects,
      op: operator,
      left: lhs,
      right: rhs,
      comparison: false,
    });
    const maskedShift = (): PorfforExpr =>
      binary("u32", "&", unsigned(right!), {
        kind: "const",
        type: "u32",
        effects: PORFFOR_FX.none,
        value: 31,
      });
    const u32Const = (value: number): PorfforExpr => ({
      kind: "const",
      type: "u32",
      effects: PORFFOR_FX.none,
      value,
    });

    switch (op) {
      case "i32.and":
        out.push(binary("i32", "&", signed(left!), signed(right!)));
        return;
      case "i32.or":
        out.push(binary("i32", "|", signed(left!), signed(right!)));
        return;
      case "i32.xor":
        out.push(binary("i32", "^", signed(left!), signed(right!)));
        return;
      case "i32.shl": {
        // C signed left shift can overflow or shift a negative value. Perform
        // the bit movement as u32, with the ECMAScript/Wasm 0x1f mask, then
        // recover the signed i32 result.
        const shifted = binary("u32", "<<", unsigned(left!), maskedShift());
        out.push(convertExpr("i32", shifted, 1));
        return;
      }
      case "i32.shr_s": {
        // C leaves right-shifting a negative signed integer
        // implementation-defined. Reconstruct Wasm/ECMAScript arithmetic
        // shift entirely with defined u32 operations:
        //   logical | ((signMask << ((32 - n) & 31)) & nonZeroMask)
        // The non-zero mask suppresses sign fill when n == 0 without ever
        // shifting by 32.
        const value = unsigned(left!);
        const count = maskedShift();
        const logical = binary("u32", ">>", value, count);
        const signBit = binary("u32", ">>", value, u32Const(31));
        const signMask = binary("u32", "-", u32Const(0), signBit);
        const fillCount = binary("u32", "&", binary("u32", "-", u32Const(32), count), u32Const(31));
        const shiftedSignMask = binary("u32", "<<", signMask, fillCount);
        const negatedCount = binary("u32", "-", u32Const(0), count);
        const countHighBit = binary("u32", ">>", binary("u32", "|", count, negatedCount), u32Const(31));
        const nonZeroMask = binary("u32", "-", u32Const(0), countHighBit);
        const signFill = binary("u32", "&", shiftedSignMask, nonZeroMask);
        out.push(convertExpr("i32", binary("u32", "|", logical, signFill), 1));
        return;
      }
      case "i32.shr_u":
        out.push(binary("u32", ">>", unsigned(left!), maskedShift()));
        return;
    }
  }

  emitLocalGet(index: number, out: PorfforSink): void {
    const local: PorfforLocalRef = { kind: "lowered", index };
    out.push(localExpr(local));
  }

  emitLocalSet(index: number, out: PorfforSink): void {
    const value = out.pop("local.set");
    out.append({ kind: "assign", target: { kind: "local", local: { kind: "lowered", index } }, value });
  }

  emitLocalTee(index: number, out: PorfforSink): void {
    const local: PorfforLocalRef = { kind: "lowered", index };
    const value = out.pop("local.tee");
    out.append({ kind: "assign", target: { kind: "local", local }, value });
    out.push(localExpr(local));
  }

  emitGlobalGet(handle: number, out: PorfforSink): void {
    const global = this.symbols.globalSymbol(handle);
    out.push({ kind: "global", type: global.type, effects: PORFFOR_FX.readGlobal, handle });
  }

  emitGlobalSet(handle: number, out: PorfforSink): void {
    const value = out.pop("global.set");
    out.append({ kind: "assign", target: { kind: "global", handle }, value });
  }

  emitDrop(out: PorfforSink): void {
    const value = out.pop("drop");
    if (value.effects !== PORFFOR_FX.none) out.append({ kind: "expr", value });
  }

  emitSelect(out: PorfforSink): void {
    const condition = out.pop("select condition");
    const whenFalse = out.pop("select false");
    const whenTrue = out.pop("select true");
    const [eagerTrue, eagerFalse, eagerCondition] = out.sequence([whenTrue, whenFalse, condition]);
    out.push({
      kind: "select",
      type: eagerTrue!.type,
      effects: eagerTrue!.effects | eagerFalse!.effects | eagerCondition!.effects,
      condition: eagerCondition!,
      whenTrue: eagerTrue!,
      whenFalse: eagerFalse!,
    });
  }

  emitReturn(out: PorfforSink): void {
    const value = this.resultSlots.length === 0 ? null : out.pop("return");
    out.append({ kind: "return", value });
  }

  emitUnreachable(out: PorfforSink): void {
    out.append({ kind: "unreachable" });
  }

  emitIf(blockType: BlockType, thenSink: PorfforSink, elseSink: PorfforSink, out: PorfforSink): void {
    const condition = out.pop("if condition");
    if (blockType.kind === "val") {
      const thenValue = thenSink.pop("if then result");
      const elseValue = elseSink.pop("if else result");
      const resultLocal = this.context.scratch(thenValue.type);
      thenSink.append({ kind: "assign", target: { kind: "local", local: resultLocal }, value: thenValue });
      elseSink.append({ kind: "assign", target: { kind: "local", local: resultLocal }, value: elseValue });
      thenSink.assertEmpty("value if then arm");
      elseSink.assertEmpty("value if else arm");
      out.append({
        kind: "if",
        controlId: this.context.controlId(),
        condition,
        then: thenSink.statements,
        else: elseSink.statements,
      });
      out.push(localExpr(resultLocal));
      return;
    }

    thenSink.assertEmpty("if then arm");
    elseSink.assertEmpty("if else arm");
    out.append({
      kind: "if",
      controlId: this.context.controlId(),
      condition,
      then: thenSink.statements,
      else: elseSink.statements,
    });
  }

  emitBr(depth: number, out: PorfforSink): void {
    out.append({ kind: "branch", depth });
  }

  emitBrIf(depth: number, out: PorfforSink): void {
    const condition = out.pop("br_if condition");
    out.append({ kind: "branch", depth, condition });
  }

  emitBlock(_blockType: BlockType, body: PorfforSink, out: PorfforSink): void {
    body.assertEmpty("block");
    out.append({ kind: "block", controlId: this.context.controlId(), body: body.statements });
  }

  emitLoop(_blockType: BlockType, body: PorfforSink, out: PorfforSink): void {
    body.assertEmpty("loop");
    out.append({ kind: "loop", controlId: this.context.controlId(), body: body.statements });
  }

  emitCall(handle: number, out: PorfforSink): void {
    const symbol = this.symbols.functionSymbol(handle);
    let args = out.popMany(symbol.params.length, `call ${symbol.name}`);
    if (args.some((arg) => arg.effects !== PORFFOR_FX.none)) args = out.sequence(args);
    const call: PorfforExpr = {
      kind: "call",
      type: symbol.results[0] ?? "i32",
      effects: args.reduce<number>((effects, arg) => effects | arg.effects, PORFFOR_FX.call),
      target: handle,
      args,
    };
    if (symbol.results.length === 0) out.append({ kind: "expr", value: call });
    else if (symbol.results.length === 1) out.push(call);
    else throw new Error(`porffor backend does not support multi-value call '${symbol.name}'`);
  }

  emitVecLen(layout: VecLayout, out: PorfforSink): void {
    const planned = asPlannedVec(layout).linearMemory.layout;
    const pointer = out.pop("vec.len");
    out.push({
      kind: "load",
      type: "i32",
      effects: pointer.effects | PORFFOR_FX.readMem,
      ctype: "u32",
      pointer,
      offset: planned.lengthOffset,
    });
  }
  emitVecDataPtr(layout: VecLayout, out: PorfforSink): void {
    const planned = asPlannedVec(layout).linearMemory.layout;
    out.push(addPointerOffset(out.pop("vec data pointer"), planned.elementsOffset));
  }
  emitElemGet(layout: VecLayout, out: PorfforSink): void {
    const planned = asPlannedVec(layout).linearMemory.layout;
    const [data, index] = out.popMany(2, "element get");
    const scaled: PorfforExpr = {
      kind: "binary",
      type: "u32",
      effects: index!.effects,
      op: "*",
      left: index!,
      right: { kind: "const", type: "u32", effects: PORFFOR_FX.none, value: planned.elementStride },
      comparison: false,
    };
    const pointer: PorfforExpr = {
      kind: "binary",
      type: "ptr",
      effects: data!.effects | scaled.effects,
      op: "+",
      left: data!,
      right: scaled,
      comparison: false,
    };
    out.push({
      kind: "load",
      type: irTypeSlot({ kind: "val", val: layout.elementValType }),
      effects: pointer.effects | PORFFOR_FX.readMem,
      ctype: memoryCType(layout.elementValType),
      pointer,
      offset: 0,
    });
  }
  emitElemSet(layout: VecLayout, _valueScratch: number, out: PorfforSink): void {
    const planned = asPlannedVec(layout).linearMemory.layout;
    const [data, index, value] = out.sequence(out.popMany(3, "element set"));
    const scaled: PorfforExpr = {
      kind: "binary",
      type: "u32",
      effects: index!.effects,
      op: "*",
      left: index!,
      right: { kind: "const", type: "u32", effects: PORFFOR_FX.none, value: planned.elementStride },
      comparison: false,
    };
    out.append({
      kind: "store",
      ctype: memoryCType(layout.elementValType),
      pointer: {
        kind: "binary",
        type: "ptr",
        effects: data!.effects | scaled.effects,
        op: "+",
        left: data!,
        right: scaled,
        comparison: false,
      },
      offset: 0,
      value: value!,
    });
  }
  emitVecSetLength(layout: VecLayout, out: PorfforSink): void {
    const planned = asPlannedVec(layout).linearMemory.layout;
    const [pointer, length] = out.sequence(out.popMany(2, "vec.set_length"));
    out.append({
      kind: "store",
      ctype: "u32",
      pointer: pointer!,
      offset: planned.lengthOffset,
      value: length!,
    });
  }
  emitVecNewFixed(layout: VecLayout, count: number, capacity: number, _scratch: number, out: PorfforSink): void {
    const linear = asPlannedVec(layout).linearMemory;
    const allocation = requireArenaAllocation(linear.allocation, "vec.new_fixed");
    const elements = out.sequence(out.popMany(count, "vec.new_fixed elements"));
    const [pointer] = out.sequence([allocateExpr(allocation.size.bytes, allocation.id as number)]);
    const storedCapacity = Math.max(capacity, linear.layout.minimumCapacity);
    out.append({
      kind: "store",
      ctype: "u32",
      pointer: pointer!,
      offset: linear.layout.lengthOffset,
      value: { kind: "const", type: "u32", effects: PORFFOR_FX.none, value: count },
    });
    out.append({
      kind: "store",
      ctype: "u32",
      pointer: pointer!,
      offset: linear.layout.capacityOffset,
      value: { kind: "const", type: "u32", effects: PORFFOR_FX.none, value: storedCapacity },
    });
    elements.forEach((value, index) => {
      out.append({
        kind: "store",
        ctype: memoryCType(layout.elementValType),
        pointer: pointer!,
        offset: linear.layout.elementsOffset + index * linear.layout.elementStride,
        value,
      });
    });
    out.push(pointer!);
  }
  emitNull(_type: IrType, _out: PorfforSink): void {
    this.unsupported("null/reference values");
  }
  emitToExternref(_out: PorfforSink): void {
    this.unsupported("externref conversion");
  }
  emitDowncast(_target: { typeIdx: number } | IrType, _out: PorfforSink): void {
    this.unsupported("reference downcast");
  }
  emitFromExternref(_target: { typeIdx: number } | IrType, _out: PorfforSink): void {
    this.unsupported("externref conversion");
  }
  emitFuncRef(_funcIdx: number, _out: PorfforSink): void {
    this.unsupported("function references");
  }
  emitPromiseNew(_typeIdx: number, _out: PorfforSink): void {
    this.unsupported("Promise allocation");
  }
  emitPromiseStateGet(_typeIdx: number, _out: PorfforSink): void {
    this.unsupported("Promise state");
  }
  emitPromiseValueGet(_typeIdx: number, _out: PorfforSink): void {
    this.unsupported("Promise value");
  }
  emitCallRef(_typeIdx: number, _out: PorfforSink): void {
    this.unsupported("indirect calls");
  }
  emitAggregateNew(layout: IrObjectStructLowering, fieldCount: number, out: PorfforSink): void {
    const linear = asPlannedObject(layout).linearMemory;
    if (fieldCount !== linear.fieldCount) {
      throw new Error(`porffor backend aggregate arity mismatch (expected ${linear.fieldCount}, got ${fieldCount})`);
    }
    const allocation = requireArenaAllocation(linear.allocation, "object.new");
    const values = out.sequence(out.popMany(fieldCount, "object.new fields"));
    const [pointer] = out.sequence([allocateExpr(allocation.size.bytes, allocation.id as number)]);
    linear.layout.fields.forEach((field, index) => {
      const memory = linear.field(field.name);
      out.append({
        kind: "store",
        ctype: memoryCType(memory.type),
        pointer: pointer!,
        offset: field.offset,
        value: values[index]!,
      });
    });
    out.push(pointer!);
  }
  emitFieldGet(layout: IrObjectStructLowering | IrClassLowering, name: string, out: PorfforSink): void {
    const field = asPlannedObject(layout).linearMemory.field(name);
    const pointer = out.pop(`field read ${name}`);
    out.push({
      kind: "load",
      type: irTypeSlot({ kind: "val", val: field.type }),
      effects: pointer.effects | PORFFOR_FX.readMem,
      ctype: memoryCType(field.type),
      pointer,
      offset: field.offset,
    });
  }
  emitFieldSet(layout: IrObjectStructLowering | IrClassLowering, name: string, out: PorfforSink): void {
    const field = asPlannedObject(layout).linearMemory.field(name);
    const [pointer, value] = out.sequence(out.popMany(2, `field write ${name}`));
    out.append({
      kind: "store",
      ctype: memoryCType(field.type),
      pointer: pointer!,
      offset: field.offset,
      value: value!,
    });
  }
  emitThrow(_tagIdx: number, _out: PorfforSink): void {
    this.unsupported("throw");
  }
  emitRethrow(_depth: number, _out: PorfforSink): void {
    this.unsupported("rethrow");
  }
  emitTry(
    _blockType: BlockType,
    _body: PorfforSink,
    _catches: { tagIdx: number; body: PorfforSink }[],
    _catchAll: PorfforSink | undefined,
    _out: PorfforSink,
  ): void {
    this.unsupported("try/catch");
  }
  emitClosureNew(_layout: IrClosureLowering, _captureCount: number, _out: PorfforSink): void {
    this.unsupported("closure allocation");
  }
  emitClosureFuncGet(_layout: IrClosureLowering, _out: PorfforSink): void {
    this.unsupported("closure function read");
  }
  emitCaptureGet(_layout: IrClosureLowering, _index: number, _out: PorfforSink): void {
    this.unsupported("closure capture read");
  }
  emitRefCellNew(_layout: IrRefCellLowering, _out: PorfforSink): void {
    this.unsupported("reference cell allocation");
  }
  emitRefCellGet(_layout: IrRefCellLowering, _out: PorfforSink): void {
    this.unsupported("reference cell read");
  }
  emitRefCellSet(_layout: IrRefCellLowering, _out: PorfforSink): void {
    this.unsupported("reference cell write");
  }

  private unsupported(family: string): never {
    throw new Error(`porffor backend does not support ${family} in the scalar/control-flow slice`);
  }
}

function constSlot(instr: Extract<IrInstr, { kind: "const" }>): PorfforValueSlot {
  switch (instr.value.kind) {
    case "bool":
    case "i32":
      return "i32";
    case "i64":
      return "i64";
    case "f64":
      return "f64";
    default:
      throw new Error(`porffor backend does not support const '${instr.value.kind}'`);
  }
}

function convertExpr(type: PorfforValueSlot, value: PorfforExpr, flags: number): PorfforExpr {
  if (type === value.type) return value;
  return { kind: "convert", type, effects: value.effects, value, flags };
}

function binaryOp(op: IrBinop): {
  readonly op: string;
  readonly comparison: boolean;
  readonly operandType?: PorfforValueSlot;
  readonly unsigned?: boolean;
} {
  const comparison = op.includes(".eq") || op.includes(".ne") || /\.(?:lt|le|gt|ge)(?:_[su])?$/.test(op);
  switch (op) {
    case "f64.add":
      return { op: "+", comparison: false, operandType: "f64" };
    case "f64.sub":
      return { op: "-", comparison: false, operandType: "f64" };
    case "f64.mul":
      return { op: "*", comparison: false, operandType: "f64" };
    case "f64.div":
      return { op: "/", comparison: false, operandType: "f64" };
    case "f64.copysign":
      return { op: "copysign", comparison: false, operandType: "f64" };
    case "i64.rem_s":
      return { op: "%", comparison: false, operandType: "i64" };
    case "i32.and":
      return { op: "&", comparison: false, operandType: "i32" };
    case "i32.or":
      return { op: "|", comparison: false, operandType: "i32" };
    case "f64.eq":
    case "i32.eq":
      return { op: "==", comparison, operandType: op.startsWith("f64") ? "f64" : undefined };
    case "f64.ne":
    case "i32.ne":
      return { op: "!=", comparison, operandType: op.startsWith("f64") ? "f64" : undefined };
    case "f64.lt":
    case "f64.le":
    case "f64.gt":
    case "f64.ge":
      return { op: relationSymbol(op.slice(4)), comparison, operandType: "f64" };
    case "i32.lt_s":
    case "i32.le_s":
    case "i32.gt_s":
    case "i32.ge_s":
      return { op: relationSymbol(op.slice(4, 6)), comparison, operandType: "i32" };
    case "i32.lt_u":
    case "i32.le_u":
    case "i32.gt_u":
    case "i32.ge_u":
      return { op: relationSymbol(op.slice(4, 6)), comparison, operandType: "u32", unsigned: true };
    default:
      throw new Error(`porffor backend does not support binary op '${op}'`);
  }
}

function relationSymbol(op: string): "<" | "<=" | ">" | ">=" {
  switch (op) {
    case "lt":
      return "<";
    case "le":
      return "<=";
    case "gt":
      return ">";
    case "ge":
      return ">=";
    default:
      throw new Error(`porffor backend does not support relation '${op}'`);
  }
}
