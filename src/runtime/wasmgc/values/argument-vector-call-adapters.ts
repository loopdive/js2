// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, Instr, LocalDef } from "../../../wasm/model/instructions.js";

interface ArgumentVectorCall {
  readonly newVector: FuncHandle;
  readonly push: FuncHandle;
  readonly call: FuncHandle;
}
/** Pack actual arguments once; transport parameters never count as user formals. */
export function buildArgumentVectorMethodAdapter(
  arity: number,
  d: ArgumentVectorCall,
  order: "receiver-first" | "callee-first",
  vectorTypeIdx?: number,
): { locals: LocalDef[]; body: Instr[] } {
  const vector = arity + 2;
  return {
    locals: [{ name: "arguments", type: { kind: "externref" } }],
    body: [
      { op: "call", funcIdx: d.newVector },
      { op: "local.set", index: vector },
      ...Array.from({ length: arity }, (_, index): Instr[] => [
        { op: "local.get", index: vector },
        { op: "local.get", index: index + 2 },
        { op: "call", funcIdx: d.push },
      ]).flat(),
      { op: "local.get", index: order === "receiver-first" ? 1 : 0 },
      { op: "local.get", index: order === "receiver-first" ? 0 : 1 },
      { op: "local.get", index: vector },
      ...(vectorTypeIdx === undefined
        ? []
        : ([{ op: "any.convert_extern" }, { op: "ref.cast", typeIdx: vectorTypeIdx }] satisfies Instr[])),
      { op: "call", funcIdx: d.call },
    ],
  };
}

/** Bridge a source vector to the runtime carrier, retaining null-as-empty semantics. */
export function buildArgumentVectorApplyAdapter(
  d: ArgumentVectorCall,
  input: { readonly vectorTypeIdx: number; readonly arrayTypeIdx: number },
): { locals: LocalDef[]; body: Instr[] } {
  return {
    locals: [
      { name: "arguments", type: { kind: "externref" } },
      { name: "index", type: { kind: "i32" } },
    ],
    body: [
      { op: "call", funcIdx: d.newVector },
      { op: "local.set", index: 3 },
      { op: "local.get", index: 2 },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          {
            op: "block",
            blockType: { kind: "empty" },
            body: [
              {
                op: "loop",
                blockType: { kind: "empty" },
                body: [
                  { op: "local.get", index: 4 },
                  { op: "local.get", index: 2 },
                  { op: "struct.get", typeIdx: input.vectorTypeIdx, fieldIdx: 0 },
                  { op: "i32.ge_u" },
                  { op: "br_if", depth: 1 },
                  { op: "local.get", index: 3 },
                  { op: "local.get", index: 2 },
                  { op: "struct.get", typeIdx: input.vectorTypeIdx, fieldIdx: 1 },
                  { op: "local.get", index: 4 },
                  { op: "array.get", typeIdx: input.arrayTypeIdx },
                  { op: "call", funcIdx: d.push },
                  { op: "local.get", index: 4 },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: 4 },
                  { op: "br", depth: 0 },
                ],
              },
            ],
          },
        ],
      },
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 3 },
      { op: "call", funcIdx: d.call },
    ],
  };
}
