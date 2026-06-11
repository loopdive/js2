// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Per-backend IR legality verifier (#1850).
//
// `verifyIrFunction` answers "is this a valid IR function?". This pass answers
// the emit-boundary question: "is this valid IR legal for the selected backend
// emitter?". Keeping the check before lowering gives unsupported backend
// surfaces a localized diagnostic instead of a late raw-emitter throw or
// malformed Wasm/bytecode.

import type { IrBinop, IrBlock, IrFunction, IrInstr, IrType } from "../nodes.js";
import { asVal } from "../nodes.js";
import type { ValType } from "../types.js";

export type IrBackendKind = "wasmgc" | "linear" | "bytecode";

export interface IrBackendLegalityError {
  readonly message: string;
  readonly func: string;
  readonly block?: number;
  readonly instr?: string;
}

export function verifyIrBackendLegality(func: IrFunction, backend: IrBackendKind): IrBackendLegalityError[] {
  const errors: IrBackendLegalityError[] = [];
  const checkType = (type: IrType, block: number | undefined, where: string): void => {
    const msg = backendTypeError(backend, type);
    if (msg) errors.push({ message: `${where}: ${msg}`, func: func.name, block });
    checkNestedTypeShapes(type, block, where, checkType);
  };

  for (const p of func.params) checkType(p.type, undefined, `param ${p.name}`);
  for (let i = 0; i < func.resultTypes.length; i++) checkType(func.resultTypes[i]!, undefined, `result ${i}`);
  for (const slot of func.slots ?? [])
    checkValType(backend, slot.type, errors, func.name, undefined, `slot ${slot.name}`);

  for (const block of func.blocks) {
    const blockId = block.id as number;
    for (let i = 0; i < block.blockArgTypes.length; i++) checkType(block.blockArgTypes[i]!, blockId, `block arg ${i}`);
    for (const instr of block.instrs) checkInstr(func, backend, block, instr, errors, checkType);
  }
  return errors;
}

function checkInstr(
  func: IrFunction,
  backend: IrBackendKind,
  block: IrBlock,
  instr: IrInstr,
  errors: IrBackendLegalityError[],
  checkType: (type: IrType, block: number | undefined, where: string) => void,
): void {
  const blockId = block.id as number;
  const reject = (reason: string): void => {
    errors.push({
      message: `block ${blockId} instr ${instr.kind}: ${reason}`,
      func: func.name,
      block: blockId,
      instr: instr.kind,
    });
  };

  if (instr.resultType) checkType(instr.resultType, blockId, `${instr.kind} result`);

  if (backend === "linear") {
    reject(`linear backend does not support IR instruction '${instr.kind}' at the function-lowering boundary`);
  } else if (backend === "bytecode") {
    const reason = bytecodeInstrError(instr);
    if (reason) reject(reason);
  }

  checkInstrEmbeddedTypes(instr, blockId, checkType);
  for (const nested of nestedInstrBuffers(instr)) {
    for (const sub of nested) checkInstr(func, backend, block, sub, errors, checkType);
  }
}

function bytecodeInstrError(instr: IrInstr): string | null {
  switch (instr.kind) {
    case "const":
      switch (instr.value.kind) {
        case "i32":
        case "f32":
        case "f64":
        case "bool":
          return null;
        default:
          return `bytecode backend does not support const '${instr.value.kind}'`;
      }
    case "binary":
      return bytecodeBinopLegal(instr.op) ? null : `bytecode backend does not support binary op '${instr.op}'`;
    case "unary":
      return instr.op === "f64.neg" ? null : `bytecode backend does not support unary op '${instr.op}'`;
    case "call":
    case "global.get":
    case "global.set":
    case "select":
    case "if":
    case "object.new":
    case "object.get":
    case "object.set":
    case "throw":
      return null;
    default:
      return `bytecode backend does not support IR instruction '${instr.kind}'`;
  }
}

function bytecodeBinopLegal(op: IrBinop): boolean {
  switch (op) {
    case "f64.add":
    case "f64.sub":
    case "f64.mul":
    case "f64.div":
    case "f64.gt":
    case "f64.lt":
    case "f64.ge":
    case "f64.le":
    case "f64.eq":
    case "f64.ne":
    case "i32.gt_s":
    case "i32.lt_s":
    case "i32.ge_s":
    case "i32.le_s":
    case "i32.eq":
    case "i32.ne":
      return true;
    default:
      return false;
  }
}

function backendTypeError(backend: IrBackendKind, type: IrType): string | null {
  if (backend === "wasmgc") return null;
  if (backend === "linear") {
    const v = asVal(type);
    if (!v) return `${backend} backend does not support IR type '${type.kind}'`;
    return linearValTypeError(v);
  }
  if (backend === "bytecode") {
    if (type.kind === "object") return null;
    const v = asVal(type);
    if (!v) return `bytecode backend does not support IR type '${type.kind}'`;
    return bytecodeValTypeError(v);
  }
  return null;
}

function checkValType(
  backend: IrBackendKind,
  type: ValType,
  errors: IrBackendLegalityError[],
  func: string,
  block: number | undefined,
  where: string,
): void {
  const msg =
    backend === "bytecode" ? bytecodeValTypeError(type) : backend === "linear" ? linearValTypeError(type) : null;
  if (msg) errors.push({ message: `${where}: ${msg}`, func, block });
}

function linearValTypeError(v: ValType): string | null {
  switch (v.kind) {
    case "i32":
    case "i64":
    case "f32":
    case "f64":
      return null;
    default:
      return `linear backend does not support ValType '${v.kind}'`;
  }
}

function bytecodeValTypeError(v: ValType): string | null {
  switch (v.kind) {
    case "i32":
    case "f32":
    case "f64":
      return null;
    default:
      return `bytecode backend does not support ValType '${v.kind}'`;
  }
}

function checkNestedTypeShapes(
  type: IrType,
  block: number | undefined,
  where: string,
  checkType: (type: IrType, block: number | undefined, where: string) => void,
): void {
  switch (type.kind) {
    case "object":
      for (const field of type.shape.fields) checkType(field.type, block, `${where}.${field.name}`);
      return;
    case "closure":
      for (let i = 0; i < type.signature.params.length; i++)
        checkType(type.signature.params[i]!, block, `${where}.param${i}`);
      if (type.signature.returnType) checkType(type.signature.returnType, block, `${where}.return`);
      return;
    case "class":
      for (const field of type.shape.fields) checkType(field.type, block, `${where}.${field.name}`);
      for (const method of type.shape.methods) {
        for (let i = 0; i < method.params.length; i++)
          checkType(method.params[i]!, block, `${where}.${method.name}.param${i}`);
        if (method.returnType) checkType(method.returnType, block, `${where}.${method.name}.return`);
      }
      return;
    default:
      return;
  }
}

function checkInstrEmbeddedTypes(
  instr: IrInstr,
  block: number,
  checkType: (type: IrType, block: number | undefined, where: string) => void,
): void {
  switch (instr.kind) {
    case "const":
      if (instr.value.kind === "null") checkType(instr.value.ty, block, "const null type");
      return;
    case "box":
      checkType(instr.toType, block, "box target");
      return;
    case "object.new":
      checkType({ kind: "object", shape: instr.shape }, block, "object.new shape");
      return;
    case "closure.new":
      for (let i = 0; i < instr.captureFieldTypes.length; i++) {
        checkType(instr.captureFieldTypes[i]!, block, `closure.new capture ${i}`);
      }
      return;
    case "class.new":
      checkType({ kind: "class", shape: instr.shape }, block, "class.new shape");
      return;
    case "forof.vec":
      checkType(instr.elementType, block, "forof.vec element");
      return;
    default:
      return;
  }
}

function nestedInstrBuffers(instr: IrInstr): readonly (readonly IrInstr[])[] {
  switch (instr.kind) {
    case "if":
      return [instr.then, instr.else];
    case "forof.vec":
    case "forof.iter":
    case "forof.string":
      return [instr.body];
    case "while.loop":
      return [instr.cond, instr.body];
    case "for.loop":
      return [instr.cond, instr.body, instr.update];
    case "try": {
      const out: (readonly IrInstr[])[] = [instr.body];
      if (instr.catchClause) out.push(instr.catchClause.body);
      if (instr.finallyBody) out.push(instr.finallyBody);
      return out;
    }
    default:
      return [];
  }
}
