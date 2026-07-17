// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrBinop, IrInstr, IrType, IrUnop } from "../../nodes.js";
import { asVal } from "../../nodes.js";
import type { BlockType, Instr } from "../../types.js";
import type { BackendEmitter } from "../emitter.js";
import type {
  IrClassLowering,
  IrClosureLowering,
  IrObjectStructLowering,
  IrRefCellLowering,
  IrVecLowering,
  LinearVecLowering,
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
      case "i32.eqz":
        out.push({ kind: "unary", type: "i32", effects: value.effects, op: "!", value });
        return;
      case "i32.trunc_sat_f64_s":
        out.push(convertExpr("i32", value, 1));
        return;
      case "f64.convert_i32_s":
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

  emitVecLen(_layout: VecLayout, _out: PorfforSink): void {
    this.unsupported("vec.len");
  }
  emitVecDataPtr(_layout: VecLayout, _out: PorfforSink): void {
    this.unsupported("vec data pointer");
  }
  emitElemGet(_layout: VecLayout, _out: PorfforSink): void {
    this.unsupported("element get");
  }
  emitVecNewFixed(_layout: VecLayout, _count: number, _scratch: number, _out: PorfforSink): void {
    this.unsupported("vec.new_fixed");
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
  emitAggregateNew(_layout: IrObjectStructLowering, _fieldCount: number, _out: PorfforSink): void {
    this.unsupported("heap aggregate allocation");
  }
  emitFieldGet(_layout: IrObjectStructLowering | IrClassLowering, _name: string, _out: PorfforSink): void {
    this.unsupported("heap field read");
  }
  emitFieldSet(_layout: IrObjectStructLowering | IrClassLowering, _name: string, _out: PorfforSink): void {
    this.unsupported("heap field write");
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
