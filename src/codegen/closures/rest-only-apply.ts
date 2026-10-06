// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, ValType } from "../../ir/types.js";
import { buildStandardTryTable } from "../../wasm/physical/exception-control.js";
import type { CodegenContext } from "../context/types.js";

/** Full-vector calls for closures whose entire user signature is `...args`. */
export function buildRestOnlyApply(
  ctx: CodegenContext,
  locals: { name: string; type: ValType }[],
  argcLocal: number,
  argcGlobal: number,
  services: {
    readonly classifyClosureDispatchRest: typeof import("./closure-dispatch-rest.js").classifyClosureDispatchRest;
    readonly buildClosureResultBoxing: typeof import("./result-boxing.js").buildClosureResultBoxing;
    readonly ensureCurrentThisGlobal: typeof import("../statements/nested-declarations.js").ensureCurrentThisGlobal;
    readonly installableReceiverInstrs: typeof import("../helpers/undefined-receiver.js").installableReceiverInstrs;
    readonly ensureExnTag: typeof import("../registry/imports.js").ensureExnTag;
  },
): Instr[] {
  const {
    classifyClosureDispatchRest,
    buildClosureResultBoxing,
    ensureCurrentThisGlobal,
    installableReceiverInstrs,
    ensureExnTag,
  } = services;
  const getIndex = ctx.funcMap.get("__extern_get_idx");
  if (getIndex === undefined) return [];
  const emitted = new Set<number>();
  const body: Instr[] = [];
  for (const info of ctx.closureInfoByTypeIdx.values()) {
    const type = ctx.mod.types[info.funcTypeIdx];
    if (!info.hasRestParam || type?.kind !== "func" || type.params.length !== 2 || emitted.has(info.funcTypeIdx))
      continue;
    const self = type.params[0];
    if (self?.kind !== "ref" && self?.kind !== "ref_null") continue;
    const rest = classifyClosureDispatchRest(ctx, info.structTypeIdx, info, type, 0);
    if (rest?.kind !== "vec" || rest.elemType.kind !== "externref") continue;
    emitted.add(info.funcTypeIdx);
    const arr = 3 + locals.length,
      index = arr + 1,
      previous = arr + 2,
      result = arr + 3,
      error = arr + 4;
    locals.push(
      { name: "__rest_apply_array", type: { kind: "ref_null", typeIdx: rest.arrTypeIdx } },
      { name: "__rest_apply_index", type: { kind: "i32" } },
      { name: "__rest_apply_receiver", type: { kind: "externref" } },
      { name: "__rest_apply_result", type: { kind: "externref" } },
      { name: "__rest_apply_error", type: { kind: "externref" } },
    );
    const receiver = ensureCurrentThisGlobal(ctx);
    const callee: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: self.typeIdx },
    ];
    const restore: Instr[] = [
      { op: "local.get", index: previous },
      { op: "global.set", index: receiver },
    ];
    body.push(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: self.typeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...callee,
          { op: "struct.get", typeIdx: self.typeIdx, fieldIdx: 1 },
          { op: "i32.eqz" },
          ...callee,
          { op: "struct.get", typeIdx: self.typeIdx, fieldIdx: 0 },
          { op: "ref.test", typeIdx: info.funcTypeIdx },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              // Declared arity zero AND a vec formal distinguish rest-only bodies
              // from a non-rest callback accepting a single array (even a default).
              { op: "local.get", index: argcLocal },
              { op: "array.new_default", typeIdx: rest.arrTypeIdx },
              { op: "local.set", index: arr },
              { op: "i32.const", value: 0 },
              { op: "local.set", index },
              {
                op: "block",
                blockType: { kind: "empty" },
                body: [
                  {
                    op: "loop",
                    blockType: { kind: "empty" },
                    body: [
                      { op: "local.get", index },
                      { op: "local.get", index: argcLocal },
                      { op: "i32.ge_s" },
                      { op: "br_if", depth: 1 },
                      { op: "local.get", index: arr },
                      { op: "local.get", index },
                      { op: "local.get", index: 2 },
                      { op: "local.get", index },
                      { op: "f64.convert_i32_s" },
                      { op: "call", funcIdx: getIndex },
                      { op: "array.set", typeIdx: rest.arrTypeIdx },
                      { op: "local.get", index },
                      { op: "i32.const", value: 1 },
                      { op: "i32.add" },
                      { op: "local.set", index },
                      { op: "br", depth: 0 },
                    ],
                  },
                ],
              },
              { op: "global.get", index: receiver },
              { op: "local.set", index: previous },
              ...installableReceiverInstrs(ctx, 1),
              { op: "global.set", index: receiver },
              buildStandardTryTable(
                { kind: "empty" },
                [
                  ...callee,
                  { op: "local.get", index: argcLocal },
                  { op: "local.get", index: arr },
                  { op: "ref.as_non_null" },
                  { op: "struct.new", typeIdx: rest.vecTypeIdx },
                  ...callee,
                  { op: "struct.get", typeIdx: self.typeIdx, fieldIdx: 0 },
                  { op: "ref.cast", typeIdx: info.funcTypeIdx },
                  { op: "call_ref", typeIdx: info.funcTypeIdx },
                  ...buildClosureResultBoxing(ctx, info.returnType, ctx.funcMap.get("__box_number")),
                  { op: "local.set", index: result },
                ],
                [
                  {
                    kind: "catch",
                    tagIdx: ensureExnTag(ctx),
                    payloadType: { kind: "externref" },
                    body: [
                      { op: "local.set", index: error },
                      ...restore,
                      { op: "local.get", index: error },
                      { op: "throw", tagIdx: ensureExnTag(ctx) },
                    ],
                  },
                ],
              ),
              ...restore,
              { op: "i32.const", value: -1 },
              { op: "global.set", index: argcGlobal },
              { op: "local.get", index: result },
              { op: "return" },
            ],
          },
        ],
      },
    );
  }
  return body;
}
