// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { emitBinary } from "../src/emit/binary.js";
import {
  reserveLinearBodyBatchExceptionTag,
  readLinearBodyBatchExceptionTag,
} from "../src/wasm/physical/linear-body-batch-exception-tag.js";
import {
  preflightLinearBodyBatchResources,
  reserveLinearBodyBatchExceptionTag as facadeReserve,
  readLinearBodyBatchExceptionTag as facadeRead,
} from "../src/ir/backend/linear-body-batch-resources.js";
import { LinearEmitter } from "../src/ir/backend/linear-emitter.js";
import type { IrLowerResolver } from "../src/ir/backend/lower-contracts.js";
import { createEmptyModule } from "../src/ir/types.js";
import type { Instr } from "../src/wasm/model/instructions.js";
import type { FuncTypeDef } from "../src/wasm/model/module-records.js";
import { IrFunctionBuilder, irVal } from "../src/ir/index.js";
import { forEachInstrDeep } from "../src/ir/core/nodes.js";
import { verifyIrFunction } from "../src/ir/verify.js";
import { lowerIrFunctionToWasm } from "../src/ir/lower.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

function reservation() {
  const module = createEmptyModule();
  let calls = 0;
  const intern = (type: FuncTypeDef): number => {
    calls++;
    module.types.push(type);
    return module.types.length - 1;
  };
  return { module, intern, calls: () => calls };
}

describe("6920 Linear body-batch exception resources", () => {
  it("preserves canonical physical provider identity through the IR compatibility exports", () => {
    expect(facadeReserve).toBe(reserveLinearBodyBatchExceptionTag);
    expect(facadeRead).toBe(readLinearBodyBatchExceptionTag);
  });
  it("refuses emission before preflight without creating resources", () => {
    const { module } = reservation();
    expect(() => readLinearBodyBatchExceptionTag(module)).toThrow(/not reserved/);
    expect(module.tags).toEqual([]);
    expect(module.types).toEqual([]);
  });

  it("reserves once and reads the original tag without mutating the module", () => {
    const { module, intern, calls } = reservation();
    reserveLinearBodyBatchExceptionTag(module, intern);
    const before = structuredClone(module);
    reserveLinearBodyBatchExceptionTag(module, intern);
    expect(calls()).toBe(1);
    expect(readLinearBodyBatchExceptionTag(module)).toBe(0);
    expect(readLinearBodyBatchExceptionTag(module)).toBe(0);
    expect(module).toEqual(before);
  });

  it("does not confer reservation authority through a module copy", () => {
    const { module, intern } = reservation();
    reserveLinearBodyBatchExceptionTag(module, intern);
    const copy = { ...module };
    expect(() => readLinearBodyBatchExceptionTag(copy)).toThrow(/not reserved/);
  });

  const mutations = [
    (module: ReturnType<typeof createEmptyModule>) => {
      module.tags[0] = { ...module.tags[0]! };
    },
    (module: ReturnType<typeof createEmptyModule>) => module.tags.unshift({ name: "other", typeIdx: 0 }),
    (module: ReturnType<typeof createEmptyModule>) => {
      module.tags[0]!.typeIdx = 1;
    },
    (module: ReturnType<typeof createEmptyModule>) => {
      module.types[0] = { kind: "func", params: [{ kind: "externref" }], results: [] };
    },
    (module: ReturnType<typeof createEmptyModule>) => {
      module.types[0] = { kind: "func", params: [{ kind: "i32" }], results: [] };
    },
    (module: ReturnType<typeof createEmptyModule>) => {
      module.types[0] = { kind: "func", params: [{ kind: "externref" }], results: [{ kind: "i32" }] };
    },
    (module: ReturnType<typeof createEmptyModule>) => {
      const type = module.types[0]!;
      if (type.kind !== "func") throw new Error("invalid test fixture");
      type.params[0] = { kind: "i32" };
    },
    (module: ReturnType<typeof createEmptyModule>) => {
      const type = module.types[0]!;
      if (type.kind !== "func") throw new Error("invalid test fixture");
      type.results.push({ kind: "i32" });
    },
    (module: ReturnType<typeof createEmptyModule>) =>
      module.imports.push({ module: "env", name: "late", desc: { kind: "tag", typeIdx: 0 } }),
  ];
  for (const [index, mutate] of mutations.entries()) {
    it(`refuses reservation coordinate/type drift ${index}`, () => {
      const { module, intern } = reservation();
      reserveLinearBodyBatchExceptionTag(module, intern);
      mutate(module);
      expect(() => readLinearBodyBatchExceptionTag(module)).toThrow(/resources changed/);
      expect(() => reserveLinearBodyBatchExceptionTag(module, intern)).toThrow(/resources changed/);
    });
  }

  it("refuses an interner result without the actual opaque function type", () => {
    const { module } = reservation();
    module.types.push({ kind: "func", params: [{ kind: "i32" }], results: [] });
    expect(() => reserveLinearBodyBatchExceptionTag(module, () => 0)).toThrow(/actual.*type/);
    expect(module.tags).toEqual([]);
  });

  it("does not adopt an unreserved same-named tag", () => {
    const { module, intern } = reservation();
    module.types.push({ kind: "func", params: [{ kind: "externref" }], results: [] });
    module.tags.push({ name: "__linear_ir_exn", typeIdx: 0 });
    expect(() => reserveLinearBodyBatchExceptionTag(module, intern)).toThrow(/unreserved resource/);
  });

  it("refuses tag coordinates after an unresolved recursive type group", () => {
    const { module, intern } = reservation();
    module.types.push({
      kind: "rec",
      types: [
        { kind: "func", params: [], results: [] },
        { kind: "func", params: [], results: [] },
      ],
    });
    expect(() => reserveLinearBodyBatchExceptionTag(module, intern)).toThrow(/direct physical type coordinates/);
    expect(module.tags).toEqual([]);
  });

  it("refuses a recursive prefix introduced after reservation", () => {
    const { module, intern } = reservation();
    module.types.push({ kind: "func", params: [], results: [] });
    reserveLinearBodyBatchExceptionTag(module, intern);
    module.types[0] = {
      kind: "rec",
      types: [
        { kind: "func", params: [], results: [] },
        { kind: "func", params: [], results: [] },
      ],
    };
    expect(() => readLinearBodyBatchExceptionTag(module)).toThrow(/resources changed/);
  });

  it("preflights a genuine throw-only owner and executes its original opaque payload", async () => {
    const { module, intern } = reservation();
    const identities = createTestIrFunctionIdentityFactory("6920-body-batch-throw");
    const builder = new IrFunctionBuilder(identities.next("run"), [], true);
    builder.openBlock();
    const type = irVal({ kind: "externref" });
    const value = builder.emitConst({ kind: "null", ty: type }, type);
    builder.emitThrow(value);
    builder.terminate({ kind: "unreachable" });
    const fn = builder.finish();
    expect(verifyIrFunction(fn)).toEqual([]);
    const missing = (): never => {
      throw new Error("unrequested resource");
    };
    let validated = 0;
    preflightLinearBodyBatchResources(
      { functions: [fn] },
      module,
      {
        runtimeFunctions: [],
        runtimeOperations: [],
        allocationSites: [],
        layoutIds: [],
        dataSegmentIds: [],
      },
      {
        validateDemand: () => {
          validated++;
        },
        resolveRuntimeOperation: missing,
        internFunctionType: intern,
        forEachInstruction: (owner, visit) => {
          for (const block of owner.blocks) for (const instr of block.instrs) forEachInstrDeep(instr, visit);
        },
      },
    );
    expect(validated).toBe(1);
    const tagIndex = readLinearBodyBatchExceptionTag(module);
    const resolver: IrLowerResolver = {
      resolveFunc: missing,
      resolveGlobal: missing,
      resolveType: missing,
      internFuncType: intern,
      ensureExnTag: () => readLinearBodyBatchExceptionTag(module),
    };
    const lowered = lowerIrFunctionToWasm(fn, resolver, new LinearEmitter({ stringRuntime: resolver }));
    module.functions.push(lowered.func);
    module.exports.push(
      { name: "run", desc: { kind: "func", index: 0 } },
      { name: "tag", desc: { kind: "tag", index: tagIndex } },
    );
    const binary = new Uint8Array(emitBinary(module));
    expect(WebAssembly.validate(binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(binary, {});
    let observed: unknown;
    try {
      Reflect.apply(instance.exports.run as Function, undefined, []);
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(WebAssembly.Exception);
    expect((observed as WebAssembly.Exception).getArg(instance.exports.tag as WebAssembly.Tag, 0)).toBe(null);
  });

  for (const rethrow of [false, true]) {
    it(`uses displaced type/tag coordinates and preserves payload identity, rethrow=${rethrow}`, async () => {
      const { module, intern } = reservation();
      module.types.push({ kind: "func", params: [], results: [{ kind: "i32" }] });
      module.types.push({ kind: "func", params: [{ kind: "externref" }], results: [] });
      module.imports.push({ module: "env", name: "other", desc: { kind: "tag", typeIdx: 1 } });
      module.tags.push({ name: "unrelated", typeIdx: 1 });
      reserveLinearBodyBatchExceptionTag(module, intern);
      const tagIndex = readLinearBodyBatchExceptionTag(module);
      expect(tagIndex).toBe(2);
      expect(module.tags[1]!.typeIdx).toBe(2);
      const missing = (): never => {
        throw new Error("unrequested runtime resource");
      };
      const resolver: IrLowerResolver = {
        resolveFunc: missing,
        resolveGlobal: missing,
        resolveType: missing,
        internFuncType: missing,
        ensureExnTag: () => readLinearBodyBatchExceptionTag(module),
      };
      const emitter = new LinearEmitter({ stringRuntime: resolver });
      const thrown: Instr[] = [{ op: "local.get", index: 0 }];
      emitter.emitThrow(tagIndex, thrown);
      const body: Instr[] = [];
      if (rethrow) {
        const cleanup: Instr[] = [
          { op: "global.get", index: 0 },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "global.set", index: 0 },
        ];
        emitter.emitRethrow(0, cleanup);
        emitter.emitTry({ kind: "empty" }, thrown, [], cleanup, body);
        body.push({ op: "local.get", index: 0 });
      } else {
        emitter.emitTry(
          { kind: "val", type: { kind: "externref" } },
          thrown,
          [{ tagIdx: tagIndex, body: [] }],
          undefined,
          body,
        );
      }
      module.globals.push({
        name: "visits",
        type: { kind: "i32" },
        mutable: true,
        init: [{ op: "i32.const", value: 0 }],
      });
      const functionType = intern({ kind: "func", params: [{ kind: "externref" }], results: [{ kind: "externref" }] });
      module.functions.push({ name: "run", typeIdx: functionType, locals: [], body, exported: true });
      module.exports.push(
        { name: "run", desc: { kind: "func", index: 0 } },
        { name: "tag", desc: { kind: "tag", index: tagIndex } },
        { name: "visits", desc: { kind: "global", index: 0 } },
      );
      const binary = new Uint8Array(emitBinary(module));
      expect(WebAssembly.validate(binary)).toBe(true);
      const wasmModule = await WebAssembly.compile(binary);
      // DOM import typings omit the genuine Wasm exception-tag import value.
      const instantiateWithTags = WebAssembly.instantiate as (
        module: WebAssembly.Module,
        imports: Record<string, Record<string, WebAssembly.ImportValue | WebAssembly.Tag>>,
      ) => Promise<WebAssembly.Instance>;
      const instance = await instantiateWithTags(wasmModule, {
        env: { other: new WebAssembly.Tag({ parameters: ["externref"] }) },
      });
      const payload = { name: "ReferenceError", message: "original opaque identity" };
      if (!rethrow) {
        expect(Reflect.apply(instance.exports.run as Function, undefined, [payload])).toBe(payload);
      } else {
        let observed: unknown;
        try {
          Reflect.apply(instance.exports.run as Function, undefined, [payload]);
        } catch (error) {
          observed = error;
        }
        expect(observed).toBeInstanceOf(WebAssembly.Exception);
        expect((observed as WebAssembly.Exception).getArg(instance.exports.tag as WebAssembly.Tag, 0)).toBe(payload);
        expect((instance.exports.visits as WebAssembly.Global).value).toBe(1);
      }
    });
  }

  it("keeps a numeric-only public Linear module free of exception tags", async () => {
    const result = await compile("export function run(x: number): number { return x + 1; }", { target: "linear" });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.wat).not.toContain("(tag ");
    const { instance } = await WebAssembly.instantiate(new Uint8Array(result.binary), {});
    expect(Reflect.apply(instance.exports.run as Function, undefined, [4])).toBe(5);
  });

  it("preflights nested try bodies before the public Linear consumer executes break/continue", async () => {
    const source = `
      export function stop(): number { let n = 0; for (let i = 0; i < 3; i++) { try { if (i === 0) break; } finally { n = n + 1; } } return n; }
      export function next(): number { let n = 0; for (let i = 0; i < 3; i++) { try { continue; } finally { n = n + 1; } } return n; }
    `;
    const result = await compile(source, { target: "linear" });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(new Uint8Array(result.binary))).toBe(true);
    const wasmModule = await WebAssembly.compile(new Uint8Array(result.binary));
    expect(WebAssembly.Module.imports(wasmModule)).toEqual([]);
    const instance = await WebAssembly.instantiate(wasmModule, {});
    expect(Reflect.apply(instance.exports.stop as Function, undefined, [])).toBe(1);
    expect(Reflect.apply(instance.exports.next as Function, undefined, [])).toBe(3);
  });
});
