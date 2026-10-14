// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { emitBinary } from "../src/emit/binary.js";
import { IrFunctionBuilder, irVal } from "../src/ir/index.js";
import { lowerIrFunctionToWasm } from "../src/ir/lower.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";
import { REFERENCE_ERROR_RUNTIME_PROVIDERS } from "../src/ir/runtime/callable-declarations.js";
import { referenceErrorProviderMismatch } from "../src/ir/runtime/reference-error-callable.js";
import { LinearEmitter } from "../src/ir/backend/linear-emitter.js";
import type { IrLowerResolver } from "../src/ir/backend/lower-contracts.js";
import { type Instr, createEmptyModule } from "../src/ir/types.js";

function runtime(standard: boolean): IrLowerResolver {
  const unavailable = (): never => {
    throw new Error("unrequested test resource");
  };
  return {
    resolveFunc: unavailable,
    resolveGlobal: unavailable,
    resolveType: unavailable,
    internFuncType: unavailable,
    resolveVec: unavailable,
    standardizedExceptions: () => standard,
    ensureExnTag: () => 0,
  };
}
async function instance(standard: boolean, finallyRethrow: boolean) {
  const mod = createEmptyModule();
  mod.types.push({
    kind: "func",
    params: [{ kind: "externref" }],
    results: [],
  });
  mod.types.push({
    kind: "func",
    params: [{ kind: "externref" }],
    results: [{ kind: "externref" }],
  });
  mod.tags.push({ name: "__exn", typeIdx: 0 });
  mod.globals.push({
    name: "visits",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  });
  const emitter = new LinearEmitter({ stringRuntime: runtime(standard) });
  const thrown: Instr[] = [{ op: "local.get", index: 0 }];
  emitter.emitThrow(0, thrown);
  const body: Instr[] = [];
  if (finallyRethrow) {
    const handler: Instr[] = [
      { op: "global.get", index: 0 },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "global.set", index: 0 },
    ];
    emitter.emitRethrow(0, handler);
    emitter.emitTry({ kind: "empty" }, thrown, [], handler, body);
    body.push({ op: "local.get", index: 0 });
  } else
    emitter.emitTry({ kind: "val", type: { kind: "externref" } }, thrown, [{ tagIdx: 0, body: [] }], undefined, body);
  mod.functions.push({
    name: "run",
    typeIdx: 1,
    locals: [],
    body,
    exported: true,
  });
  mod.functions.push({ name: "pass", typeIdx: 1, locals: [], body: [{ op: "local.get", index: 0 }], exported: true });
  const nullBody: Instr[] = [];
  emitter.emitNull({ kind: "val", val: { kind: "externref" } }, nullBody);
  mod.types.push({ kind: "func", params: [], results: [{ kind: "externref" }] });
  mod.functions.push({ name: "null", typeIdx: 2, locals: [], body: nullBody, exported: true });
  mod.exports.push({ name: "null", desc: { kind: "func", index: 2 } });
  mod.exports.push({ name: "pass", desc: { kind: "func", index: 1 } });
  mod.exports.push(
    { name: "run", desc: { kind: "func", index: 0 } },
    { name: "tag", desc: { kind: "tag", index: 0 } },
    { name: "visits", desc: { kind: "global", index: 0 } },
  );
  const binary = new Uint8Array(emitBinary(mod));
  expect(WebAssembly.validate(binary)).toBe(true);
  return (await WebAssembly.instantiate(binary, {})).instance;
}
describe("6920 Linear opaque exception payload", () => {
  for (const standard of [false, true]) {
    it(`catch preserves payload identity, standardized=${standard}`, async () => {
      const mod = await instance(standard, false);
      const payload = {
        name: "ReferenceError",
        message: "before initialization",
      };
      expect(Reflect.apply(mod.exports.run as Function, undefined, [payload])).toBe(payload);
      expect(Reflect.apply(mod.exports.run as Function, undefined, [null])).toBe(null);
    });
    it(`finally executes once and rethrows original payload, standardized=${standard}`, async () => {
      const mod = await instance(standard, true);
      const payload = {
        name: "ReferenceError",
        message: "before initialization",
      };
      let observed: unknown;
      try {
        Reflect.apply(mod.exports.run as Function, undefined, [payload]);
      } catch (error) {
        observed = error;
      }
      expect(observed).toBeInstanceOf(WebAssembly.Exception);
      expect((observed as WebAssembly.Exception).getArg(mod.exports.tag as WebAssembly.Tag, 0)).toBe(payload);
      expect((mod.exports.visits as WebAssembly.Global).value).toBe(1);
    });
  }
  it("refuses a standardized finally without the actual shared tag", () => {
    const emitter = new LinearEmitter({
      stringRuntime: { ...runtime(true), ensureExnTag: undefined },
    });
    expect(() => emitter.emitTry({ kind: "empty" }, [], [], [{ op: "rethrow", depth: 0 }], [])).toThrow(
      /shared exception tag/,
    );
  });
});

for (const provider of REFERENCE_ERROR_RUNTIME_PROVIDERS) {
  it(`${provider.id}: binds the full callable signature and recipe policy`, () => {
    expect(referenceErrorProviderMismatch(provider)).toBeUndefined();
    expect(referenceErrorProviderMismatch({ ...provider, signature: undefined })).toMatch(/signature mismatch/);
    expect(
      referenceErrorProviderMismatch({
        ...provider,
        implementation: { kind: "runtime-callable", symbol: "__new_TypeError" },
      }),
    ).toMatch(/implementation mismatch/);
    expect(referenceErrorProviderMismatch({ ...provider, supportedBackends: [] })).toMatch(
      /supportedBackends mismatch/,
    );
    expect(
      referenceErrorProviderMismatch({
        ...provider,
        hostCapabilities: provider.hostCapabilities.length ? [] : ["error.reference.construct"],
      }),
    ).toMatch(/hostCapabilities mismatch/);
  });
}

it("refuses non-opaque null representations", () => {
  const emitter = new LinearEmitter();
  expect(() => emitter.emitNull({ kind: "val", val: { kind: "ref_null", typeIdx: 0 } }, [])).toThrow(
    /cannot materialize null/,
  );
  expect(() => emitter.emitNull({ kind: "string" }, [])).toThrow(/cannot materialize null/);
});

it("lowers a genuine opaque null IR constant through the Linear backend", async () => {
  const mod = createEmptyModule();
  const resolver: IrLowerResolver = {
    ...runtime(true),
    internFuncType: (type) => {
      mod.types.push(type);
      return mod.types.length - 1;
    },
  };
  const type = irVal({ kind: "externref" });
  const identities = createTestIrFunctionIdentityFactory("6920-opaque-null");
  const builder = new IrFunctionBuilder(identities.next("run"), [type], true);
  builder.openBlock();
  const value = builder.emitConst({ kind: "null", ty: type }, type);
  builder.terminate({ kind: "return", values: [value] });
  const lowered = lowerIrFunctionToWasm(builder.finish(), resolver, new LinearEmitter({ stringRuntime: resolver }));
  mod.functions.push(lowered.func);
  mod.exports.push({ name: "run", desc: { kind: "func", index: 0 } });
  const binary = new Uint8Array(emitBinary(mod));
  expect(WebAssembly.validate(binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(binary, {});
  expect(Reflect.apply(instance.exports.run as Function, undefined, [])).toBe(null);
});
