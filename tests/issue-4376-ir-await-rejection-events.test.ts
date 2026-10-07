// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import {
  buildPromiseRejectionEvent,
  buildPromiseReactionHandled,
} from "../src/runtime/wasmgc/promise/rejection-event-bodies.js";
import { emitBinary } from "../src/emit/binary.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { WasmGcEmitter } from "../src/ir/backend/wasmgc-emitter.js";
import { wasmValueTypeConverter } from "../src/ir/index.js";
import type { IrLowerResolver } from "../src/ir/backend/lower-contracts.js";
import { lowerIrFunctionBody } from "../src/ir/lower-generic.js";
import { irVal } from "../src/ir/nodes.js";
import { createEmptyModule } from "../src/ir/types.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

it.each([
  ["await", true],
  ["await", false],
  ["async.throw", true],
  ["async.throw", false],
] as const)("IR %s preserves exact carrier identity and rejection semantics, dispatcher=%s", (operation, enabled) => {
  const extern = irVal({ kind: "externref" });
  const builder = new IrFunctionBuilder(
    createTestIrFunctionIdentityFactory("4376-await").next("consume"),
    [extern],
    true,
  );
  builder.setFuncKind("async");
  const input = builder.addParam("promise", extern);
  builder.openBlock();
  const value = builder.emitAwait(input);
  builder.terminate({ kind: "return", values: [value] });
  const fn = builder.finish();
  if (operation === "async.throw") {
    for (const block of fn.blocks)
      (block as { instrs: typeof block.instrs }).instrs = block.instrs.map((instruction) =>
        instruction.kind === "await"
          ? {
              kind: "async.throw",
              reason: instruction.operand,
              result: instruction.result,
              resultType: instruction.resultType,
            }
          : instruction,
      );
  }
  const resolver: IrLowerResolver = {
    resolveFunc: () => {
      throw new Error("unexpected implicit runtime call");
    },
    resolveGlobal: () => 0,
    resolveType: () => 0,
    internFuncType: () => 1,
    resolvePromiseType: () => 0,
    nativePromiseCarrierActive: () => true,
    resolvePromiseRejectionDispatcher: () => (enabled ? 0 : undefined),
    ...(enabled ? { buildPromiseRejectionEvent, buildPromiseReactionHandled } : {}),
  };
  const lowered = lowerIrFunctionBody(
    fn,
    resolver,
    new WasmGcEmitter(resolver),
    wasmValueTypeConverter("wasmgc", resolver, fn.name),
  );
  const module = createEmptyModule();
  module.types.push(
    {
      kind: "struct",
      name: "$Promise",
      fields: [
        { name: "state", type: { kind: "i32" }, mutable: true },
        { name: "value", type: { kind: "externref" }, mutable: true },
        { name: "callbacks", type: { kind: "externref" }, mutable: true },
        { name: "bag", type: { kind: "externref" }, mutable: true },
        { name: "handled", type: { kind: "i32" }, mutable: true },
      ],
    },
    { kind: "func", params: [{ kind: "externref" }], results: [{ kind: "externref" }] },
    { kind: "func", params: [{ kind: "f64" }, { kind: "externref" }, { kind: "externref" }], results: [] },
  );
  module.imports.push({ module: "events", name: "record", desc: { kind: "func", typeIdx: 2 } });
  module.functions.push(
    {
      name: "consume",
      typeIdx: 1,
      exported: true,
      locals: lowered.locals.flatMap((local) => local.slots.map((type) => ({ name: local.name, type }))),
      body: lowered.body,
    },
    {
      name: "rejected",
      typeIdx: 1,
      exported: true,
      locals: [],
      body: [
        { op: "i32.const", value: 2 },
        { op: "local.get", index: 0 },
        { op: "ref.null.extern" },
        { op: "ref.null.extern" },
        { op: "i32.const", value: 0 },
        { op: "struct.new", typeIdx: 0 },
        { op: "extern.convert_any" },
      ],
    },
  );
  module.exports.push(
    { name: "consume", desc: { kind: "func", index: 1 } },
    { name: "rejected", desc: { kind: "func", index: 2 } },
  );
  const events: unknown[][] = [];
  const wasm = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(emitBinary(module))), {
    events: { record: (...args: unknown[]) => events.push(args) },
  });
  const e = wasm.exports as unknown as { consume(value: unknown): unknown; rejected(value: unknown): unknown };
  const reason = { marker: 42 };
  if (operation === "async.throw") {
    const rejected = e.consume(reason);
    expect(rejected === reason).toBe(false);
    expect(events).toEqual(enabled ? [[0, rejected, reason]] : []);
    return;
  }
  const promise = e.rejected(reason);
  expect(e.consume(promise)).toBe(reason);
  expect(e.consume(promise)).toBe(reason);
  expect(e.consume(reason)).toBe(reason);
  expect(events).toEqual(enabled ? [[1, promise, null]] : []);
});
