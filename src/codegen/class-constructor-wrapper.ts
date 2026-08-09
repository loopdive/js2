// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { FieldDef, FuncHandle, Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt } from "./func-space.js";

function sameValType(left: ValType, right: ValType): boolean {
  if (left.kind !== right.kind) return false;
  if ((left.kind === "ref" || left.kind === "ref_null") && (right.kind === "ref" || right.kind === "ref_null")) {
    return left.typeIdx === right.typeIdx;
  }
  return true;
}

/** Fill the AST-free WasmGC allocation wrapper shared by direct and IR init bodies. */
export function installAstFreeClassConstructorNewWrapper(
  ctx: CodegenContext,
  input: {
    readonly className: string;
    readonly structTypeIdx: number;
    readonly fields: readonly FieldDef[];
    readonly newFuncIdx: FuncHandle;
    readonly initFuncIdx: FuncHandle;
  },
): void {
  const { className, structTypeIdx, fields, newFuncIdx, initFuncIdx } = input;
  const newFunc = definedFuncAt(ctx, newFuncIdx);
  const initFunc = definedFuncAt(ctx, initFuncIdx);
  if (!newFunc || !initFunc) {
    throw new Error(`constructor wrapper has no live slots: ${className}_new -> ${className}_init`);
  }
  const newSignature = ctx.mod.types[newFunc.typeIdx];
  const initSignature = ctx.mod.types[initFunc.typeIdx];
  if (
    !newSignature ||
    newSignature.kind !== "func" ||
    !initSignature ||
    initSignature.kind !== "func" ||
    initSignature.params.length !== newSignature.params.length + 1 ||
    !newSignature.params.every((param, index) => sameValType(param, initSignature.params[index]!)) ||
    !sameValType(initSignature.params.at(-1)!, { kind: "ref", typeIdx: structTypeIdx }) ||
    initSignature.results.length !== newSignature.results.length ||
    !newSignature.results.every((result, index) => sameValType(result, initSignature.results[index]!))
  ) {
    throw new Error(`constructor wrapper ABI mismatch: ${className}_new -> ${className}_init`);
  }

  const body: Instr[] = [];
  for (const field of fields) {
    if (field.name === "__tag") {
      body.push({ op: "i32.const", value: ctx.classTagMap.get(className) ?? 0 });
    } else if (field.type.kind === "f64") {
      body.push({ op: "f64.const", value: 0 });
    } else if (field.type.kind === "i32") {
      body.push({ op: "i32.const", value: 0 });
    } else if (field.type.kind === "externref") {
      body.push({ op: "ref.null.extern" });
    } else if (field.type.kind === "ref" || field.type.kind === "ref_null") {
      body.push({ op: "ref.null", typeIdx: field.type.typeIdx });
    } else if (field.type.kind === "i64") {
      body.push({ op: "i64.const", value: 0n });
    } else if (field.type.kind === "eqref") {
      body.push({ op: "ref.null.eq" });
    } else {
      body.push({ op: "i32.const", value: 0 });
    }
  }
  body.push({ op: "struct.new", typeIdx: structTypeIdx });
  const selfLocal = newSignature.params.length;
  body.push({ op: "local.set", index: selfLocal });
  for (let index = 0; index < newSignature.params.length; index++) {
    body.push({ op: "local.get", index });
  }
  body.push({ op: "local.get", index: selfLocal });
  body.push({ op: "return_call", funcIdx: initFuncIdx });
  newFunc.locals = [{ name: "__self", type: { kind: "ref", typeIdx: structTypeIdx } }];
  newFunc.body = body;
}
