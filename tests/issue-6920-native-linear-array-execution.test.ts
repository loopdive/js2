// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, expect, it, vi } from "vitest";
import { compile } from "../src/index.js";
import { analyzeMultiSource } from "../src/checker/index.js";
import * as direct from "../src/codegen-linear/index.js";
import * as directGc from "../src/codegen/index.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import {
  acceptPreparedIrProgram,
  emitAcceptedIrProgram,
  emittedSupportFunctionReceipts,
} from "../src/ir/program-consumer.js";
import { decodePreparedIrProgram, encodePreparedIrProgram } from "../src/ir/program-codec.js";
import * as memoryPack from "../src/backend/linear/program/memory.js";
import { emitBinary } from "../src/emit/binary.js";

const source =
  "export function run(a:number,b:number):number { const values=[a,b]; return values[0]+values[1]+values.length; }";
afterEach(() => vi.restoreAllMocks());

async function execute(binary: Uint8Array) {
  expect(WebAssembly.validate(binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(binary, {});
  expect(instance.exports.memory).toBeInstanceOf(WebAssembly.Memory);
  const memory = instance.exports.memory as WebAssembly.Memory;
  const run = instance.exports.run as Function;
  expect(Reflect.apply(run, undefined, [1.5, -2.25])).toBe(1.25);
  const view = new DataView(memory.buffer);
  expect(view.getUint32(1024 + 8, true)).toBe(2);
  expect(view.getUint32(1024 + 12, true)).toBeGreaterThanOrEqual(2);
  expect(view.getFloat64(1024 + 16, true)).toBe(1.5);
  expect(view.getFloat64(1024 + 24, true)).toBe(-2.25);
  expect(Reflect.apply(run, undefined, [4, 9])).toBe(15);
  expect(view.getFloat64(1024 + 16, true)).toBe(1.5);
}

for (const target of ["standalone", "wasi"] as const) {
  it(`public native Linear ${target} allocates and reads the actual numeric vector`, async () => {
    const linear = vi.spyOn(direct, "generateLinearModule").mockImplementation(() => {
      throw new Error("direct Linear frontend forbidden");
    });
    const gc = vi.spyOn(directGc, "generateModule").mockImplementation(() => {
      throw new Error("direct GC frontend forbidden");
    });
    const result = await compile(source, { backend: "linear", target, optimize: false, sourceMap: false });
    expect(result.success, result.errors.map((row) => row.message).join("; ")).toBe(true);
    expect(linear).not.toHaveBeenCalled();
    expect(gc).not.toHaveBeenCalled();
    await execute(new Uint8Array(result.binary));
  });

  for (const decoded of [false, true]) {
    it(`source-free native Linear ${target} uses actual provider reservations, decoded=${decoded}`, async () => {
      const ast = analyzeMultiSource({ "./entry.ts": source }, "./entry.ts");
      const result = prepareWholeIrProgram({
        sourceFiles: ast.sourceFiles,
        entrySource: ast.entryFile,
        checker: ast.checker,
        policy: { backend: "linear", target: "standalone" },
        runtimePolicies: [
          { backend: "linear", target: "standalone" },
          { backend: "linear", target: "wasi" },
        ],
        deferTopLevelInit: false,
        linearVectorProjection: "native-f64",
      });
      expect(result.kind).toBe("prepared");
      if (result.kind !== "prepared") throw new Error(JSON.stringify(result));
      const program = decoded ? decodePreparedIrProgram(encodePreparedIrProgram(result.program)) : result.program;
      const accepted = acceptPreparedIrProgram(program, {
        backend: "linear",
        target,
        moduleName: "native-vector",
        sourceMap: false,
        utf8Storage: false,
        sharedExceptionTag: false,
      });
      expect(accepted.kind, JSON.stringify(accepted)).toBe("accepted");
      if (accepted.kind !== "accepted") throw new Error(JSON.stringify(accepted));
      const bindings: memoryPack.PreparedLinearBodyBindings[] = [];
      const original = memoryPack.preparedLinearMemoryBindings;
      vi.spyOn(memoryPack, "preparedLinearMemoryBindings").mockImplementation((...args) => {
        const binding = original(...args);
        bindings.push(binding);
        return binding;
      });
      const emitted = emitAcceptedIrProgram(accepted);
      expect(bindings).toHaveLength(1);
      expect(() => bindings[0]!.resolveVectorLayout({ kind: "val", val: { kind: "f64" } })).toThrow(
        /emission attempt is no longer active/,
      );
      expect(emittedSupportFunctionReceipts(emitted).map((row) => row.key)).toEqual(
        expect.arrayContaining([
          "linear:malloc",
          "linear:array-new",
          "linear:initialize-element",
          "linear:resolve-forwarding",
        ]),
      );
      await execute(new Uint8Array(emitBinary(emitted.module)));
    });
  }
}
