// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { analyzeSource } from "../src/checker/index.js";
import { generateLinearModule } from "../src/codegen-linear/index.js";
import { compile } from "../src/index.js";
import { addRuntime, addArrayRuntime } from "../src/codegen-linear/runtime.js";
import { emitBinary } from "../src/emit/binary.js";
import { LinearEmitter } from "../src/ir/backend/linear-emitter.js";
import { collectLinearBackendResourceDemand, getLastLinearIrReport } from "../src/ir/backend/linear-integration.js";
import {
  IrFunctionBuilder,
  AllocSiteRegistry,
  irVal,
  planLinearMemory,
  planLinearVectorLayout,
  defaultOperationsForLayout,
} from "../src/ir/index.js";
import type { IrModule } from "../src/ir/nodes.js";
import type { LinearVecLowering } from "../src/ir/backend/handles.js";
import { createEmptyModule, type Instr, type WasmModule, type FuncTypeDef } from "../src/ir/types.js";
import { LINEAR_ARRAY_FORWARDING } from "../src/ir/analysis/linear-memory-plan.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const hooks = vi.hoisted(() => ({
  mutate: undefined as ((mod: WasmModule) => void) | undefined,
  consumers: 0,
  restorers: [] as (() => void)[],
}));
vi.mock("../src/codegen-linear/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/codegen-linear/runtime.js")>();
  const original = actual.addArrayRuntime;
  const spy = vi.spyOn(actual, "addArrayRuntime").mockImplementation(function (this: unknown, ...args) {
    const result = Reflect.apply(original, this, args);
    hooks.mutate?.(args[0]);
    return result;
  });
  hooks.restorers.push(() => spy.mockRestore());
  return { ...actual, addArrayRuntime: spy };
});
vi.mock("../src/ir/backend/frozen-body-consumer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ir/backend/frozen-body-consumer.js")>();
  const original = actual.consumeFrozenIrBodyBatchWithFactories;
  const spy = vi.spyOn(actual, "consumeFrozenIrBodyBatchWithFactories").mockImplementation(function <B, V>(
    this: unknown,
    ...args: Parameters<typeof original<B, V>>
  ) {
    hooks.consumers++;
    return Reflect.apply(original<B, V>, this, args);
  });
  hooks.restorers.push(() => spy.mockRestore());
  return { ...actual, consumeFrozenIrBodyBatchWithFactories: spy };
});
afterEach(() => {
  hooks.mutate = undefined;
  hooks.consumers = 0;
  vi.unstubAllEnvs();
});
afterAll(() => {
  for (const restore of hooks.restorers.reverse()) restore();
});
const F64 = irVal({ kind: "f64" });
const I32 = irVal({ kind: "i32" });
const identities = createTestIrFunctionIdentityFactory("issue-6893-read-forwarding");
const operation = { family: "vector", operation: "resolve-forwarding" } as const;
function vectorLayout(): LinearVecLowering {
  const layout = planLinearVectorLayout(F64),
    ops = defaultOperationsForLayout(layout);
  return {
    elementValType: { kind: "f64" },
    linearMemory: {
      layout,
      allocate: ops.find((x) => x.family === "vector" && x.operation === "allocate")!,
      initializeElement: ops.find((x) => x.family === "vector" && x.operation === "initialize-element")!,
    },
  };
}
function index(mod: WasmModule, name: string): number {
  const local = mod.functions.findIndex((fn) => fn.name === name);
  if (local < 0) throw Error(`missing genuine runtime ${name}`);
  return mod.imports.filter((x) => x.desc.kind === "func").length + local;
}
async function runtime(importNamesake = false) {
  const mod = createEmptyModule();
  if (importNamesake) {
    mod.types.push({ kind: "func", params: [{ kind: "i32" }], results: [{ kind: "i32" }] });
    mod.imports.push({ module: "probe", name: "__arr_resolve", desc: { kind: "func", typeIdx: 0 } });
  }
  addRuntime(mod);
  addArrayRuntime(mod);
  mod.exports.push({
    name: "allocator",
    desc: { kind: "global", index: mod.globals.findIndex((g) => g.name === "__heap_ptr") },
  });
  const emitter = new LinearEmitter({
    resolveRuntimeOperation: (op) => {
      expect(op).toEqual(operation);
      return index(mod, "__arr_resolve");
    },
  });
  const len: Instr[] = [{ op: "local.get", index: 0 }];
  emitter.emitVecLen(vectorLayout(), len);
  const get: Instr[] = [{ op: "local.get", index: 0 }];
  emitter.emitVecDataPtr(vectorLayout(), get);
  get.push({ op: "local.get", index: 1 });
  emitter.emitElemGet(vectorLayout(), get);
  for (const [name, params, results, body] of [
    ["readLength", [{ kind: "i32" }], [{ kind: "i32" }], len],
    ["readValue", [{ kind: "i32" }, { kind: "i32" }], [{ kind: "f64" }], get],
  ] as const) {
    const typeIdx = mod.types.length;
    mod.types.push({ kind: "func", params: [...params], results: [...results] });
    mod.functions.push({ name, typeIdx, locals: [], body: [...body], exported: true });
    mod.exports.push({ name, desc: { kind: "func", index: index(mod, name) } });
  }
  for (const name of ["__arr_new", "__arr_set", "__arr_push", "__arr_resolve"]) {
    mod.exports.push({ name, desc: { kind: "func", index: index(mod, name) } });
  }
  const bytes = Uint8Array.from(emitBinary(mod)).buffer;
  expect(WebAssembly.validate(bytes)).toBe(true);
  const namesake = vi.fn((n: number) => n);
  const { instance } = await WebAssembly.instantiate(
    bytes,
    importNamesake ? { probe: { __arr_resolve: namesake } } : {},
  );
  const f = instance.exports as unknown as {
    memory: WebAssembly.Memory;
    allocator: WebAssembly.Global;
    __arr_new: (cap: number) => number;
    __arr_set: (ptr: number, i: number, v: number) => void;
    __arr_push: (ptr: number, v: number) => void;
    __arr_resolve: (ptr: number) => number;
    readLength: (ptr: number) => number;
    readValue: (ptr: number, i: number) => number;
  };
  return { mod, f, namesake };
}
function demandFixture(kind: "vec.len" | "vec.get" | "vec.set" | "forof.vec" | "scalar" | "string", nested = false) {
  const b = new IrFunctionBuilder(identities.next(kind), [F64], true);
  const vec = b.addParam("values", { kind: "vec", elementType: F64, nullable: false });
  b.openBlock();
  const zero = b.emitConst({ kind: "i32", value: 0 }, I32),
    value = b.emitConst({ kind: "f64", value: 1.5 }, F64);
  if (kind === "vec.len") b.emitVecLen(vec);
  if (kind === "vec.get") b.emitVecGet(vec, zero, F64);
  if (kind === "vec.set") b.emitVecSet(vec, zero, value);
  if (kind === "forof.vec")
    b.emitForOfVec({
      vec,
      elementType: F64,
      counterSlot: 0,
      lengthSlot: 1,
      vecSlot: 2,
      dataSlot: 3,
      elementSlot: 4,
      body: [],
    });
  if (kind === "string") b.emitStringConst("abc");
  b.terminate({ kind: "return", values: [value] });
  let fn = b.finish();
  if (nested) {
    const roots = fn.blocks[0]!.instrs;
    fn = {
      ...fn,
      blocks: [
        {
          ...fn.blocks[0]!,
          instrs: [
            ...roots.filter((instr) => instr.kind === "const"),
            {
              kind: "if.stmt",
              cond: zero,
              then: roots.filter((instr) => instr.kind !== "const"),
              else: [],
              result: null,
              resultType: null,
            },
          ],
        },
      ],
    };
  }
  const module: IrModule = { functions: [fn] };
  const plan = planLinearMemory(module, new AllocSiteRegistry());
  return { module, plan, demand: collectLinearBackendResourceDemand(module, plan) };
}

describe("issue 6893: linear IR resolves forwarding before reads", () => {
  it("reads relocated length and fractional payload from a stale alias", async () => {
    const { f } = await runtime();
    const old = f.__arr_new(2);
    f.__arr_set(old, 0, 1.5);
    f.__arr_set(old, 31, 3.75);
    expect(f.__arr_resolve(old)).not.toBe(old);
    expect(f.readLength(old)).toBe(32);
    expect(f.readValue(old, 31)).toBe(3.75);
  });
  it("reads a changed old in-range entry from the current payload", async () => {
    const { f } = await runtime();
    const old = f.__arr_new(2);
    f.__arr_set(old, 0, 1.5);
    f.__arr_set(old, 31, 3.75);
    f.__arr_set(old, 0, -2.25);
    expect(f.readValue(old, 0)).toBe(-2.25);
  });
  it("follows multiple genuine forwarding hops and resolves again after intervening growth", async () => {
    const { f } = await runtime();
    const old = f.__arr_new(2);
    f.__arr_set(old, 31, 3.75);
    const first = f.__arr_resolve(old);
    expect(f.readLength(old)).toBe(32);
    f.__arr_set(old, 127, -4.5);
    const second = f.__arr_resolve(old);
    expect(second).not.toBe(first);
    expect(second).not.toBe(old);
    expect(new DataView(f.memory.buffer).getUint32(old + LINEAR_ARRAY_FORWARDING.pointerOffset, true)).toBe(first);
    expect(new DataView(f.memory.buffer).getUint32(first + LINEAR_ARRAY_FORWARDING.pointerOffset, true)).toBe(second);
    expect(f.readLength(old)).toBe(128);
    expect(f.readValue(old, 127)).toBe(-4.5);
  });
  it("keeps memory, allocator and forwarding records unchanged across repeated reads", async () => {
    const { mod, f } = await runtime();
    const old = f.__arr_new(2);
    f.__arr_set(old, 31, 3.75);
    f.__arr_set(old, 127, -4.5);
    const before = new Uint8Array(f.memory.buffer).slice();
    const allocatorBefore = f.allocator.value;
    const heap = mod.globals.findIndex((g) => g.name === "__heap_ptr");
    expect(heap).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < 3; i++) {
      expect(f.readLength(old)).toBe(128);
      expect(f.readValue(old, 31)).toBe(3.75);
      expect(f.readValue(old, 127)).toBe(-4.5);
    }
    expect(new Uint8Array(f.memory.buffer)).toEqual(before);
    expect(f.allocator.value).toBe(allocatorBefore);
  });
  it("preserves no-growth and direct in-bounds fractional stores", async () => {
    const { f } = await runtime();
    const old = f.__arr_new(16);
    f.__arr_set(old, 0, 1.5);
    f.__arr_set(old, 1, -2.25);
    expect(f.__arr_resolve(old)).toBe(old);
    expect(f.readLength(old)).toBe(2);
    expect(f.readValue(old, 1)).toBe(-2.25);
  });
  it("uses a real defined resolver after imports without calling the import namesake", async () => {
    const { f, namesake } = await runtime(true);
    const old = f.__arr_new(2);
    f.__arr_set(old, 31, 3.75);
    expect(f.readLength(old)).toBe(32);
    expect(f.readValue(old, 31)).toBe(3.75);
    expect(namesake).not.toHaveBeenCalled();
  });
  for (const method of ["emitVecLen", "emitVecDataPtr"] as const) {
    it(`${method} refuses a missing resolver without changing its supplied buffer`, () => {
      const out: Instr[] = [{ op: "local.get", index: 0 }],
        before = structuredClone(out);
      expect(() => new LinearEmitter()[method](vectorLayout(), out)).toThrow(/forwarding resolver/);
      expect(out).toEqual(before);
    });
    it(`${method} refuses an invalid binding without changing its supplied buffer`, () => {
      const out: Instr[] = [{ op: "local.get", index: 0 }],
        before = structuredClone(out);
      expect(() => new LinearEmitter({ resolveRuntimeOperation: () => -1 })[method](vectorLayout(), out)).toThrow(
        /binding is invalid/,
      );
      expect(out).toEqual(before);
    });
  }
  for (const kind of ["vec.len", "vec.get", "vec.set", "forof.vec"] as const) {
    it(`demands forwarding for allocation-free ${kind}`, () => {
      const { plan, demand } = demandFixture(kind);
      expect(plan.allocations).toHaveLength(0);
      expect(demand.runtimeOperations).toContainEqual(operation);
      expect(demand.runtimeFunctions).toContain("__arr_resolve");
    });
  }
  it("discovers forwarding in nested buffers without allocation demand", () => {
    const { plan, demand } = demandFixture("vec.get", true);
    expect(plan.allocations).toHaveLength(0);
    expect(demand.runtimeOperations.filter((x) => x.operation === "resolve-forwarding")).toHaveLength(1);
  });
  for (const kind of ["scalar", "string"] as const) {
    it(`does not demand forwarding for ${kind}-only instructions`, () => {
      const { demand } = demandFixture(kind);
      expect(demand.runtimeOperations).not.toContainEqual(operation);
      expect(demand.runtimeFunctions).not.toContain("__arr_resolve");
    });
  }
  const invalidTypes: readonly [string, FuncTypeDef | "absent" | "non-function"][] = [
    ["absent type", "absent"],
    ["non-function type", "non-function"],
    ["wrong parameter kind", { kind: "func", params: [{ kind: "f64" }], results: [{ kind: "i32" }] }],
    ["wrong result kind", { kind: "func", params: [{ kind: "i32" }], results: [{ kind: "f64" }] }],
    ["wrong parameter arity", { kind: "func", params: [], results: [{ kind: "i32" }] }],
    ["wrong result arity", { kind: "func", params: [{ kind: "i32" }], results: [] }],
  ];
  for (const [name, type] of invalidTypes) {
    it(`production preflight rejects ${name} before the frozen-body consumer`, async () => {
      hooks.mutate = (mod) => {
        const fn = mod.functions.find((f) => f.name === "__arr_resolve")!;
        fn.typeIdx = mod.types.length;
        if (type === "absent") fn.typeIdx += 10;
        else mod.types.push(type === "non-function" ? { kind: "struct", name: "not-a-function", fields: [] } : type);
      };
      const result = await compile("export function test(): number { const a=[1.5]; return a[0]; }", {
        target: "linear",
      });
      expect(result.success).toBe(false);
      expect(result.errors.map((x) => x.message).join(";")).toContain("must have signature (i32)->i32");
      expect(result.binary).toHaveLength(0);
      expect(hooks.consumers).toBe(0);
    });
  }
  for (const importOnly of [false, true]) {
    it(`production preflight rejects ${importOnly ? "an import-only namesake" : "a missing defined helper"} before the frozen-body consumer`, async () => {
      hooks.mutate = (mod) => {
        mod.functions.find((f) => f.name === "__arr_resolve")!.name = "__missing_resolve";
        if (importOnly) {
          const typeIdx = mod.types.length;
          mod.types.push({ kind: "func", params: [{ kind: "i32" }], results: [{ kind: "i32" }] });
          mod.imports.push({ module: "probe", name: "__arr_resolve", desc: { kind: "func", typeIdx } });
        }
      };
      const result = await compile("export function test(): number { const a=[1.5]; return a[0]; }", {
        target: "linear",
      });
      expect(result.success).toBe(false);
      expect(result.errors.map((x) => x.message).join(";")).toContain("__arr_resolve");
      expect(result.binary).toHaveLength(0);
      expect(hooks.consumers).toBe(0);
    });
  }
});

const originalObligations = [
  {
    key: "aliasScalar31-out-of-scope-A",
    source:
      "export function run(): number { const values=[1.5,-2.25]; const alias=values; alias[31]=3.75; return values[31]; }",
    expected: 3.75,
    options: {
      target: "linear",
      abi: "c",
      optimize: false,
    },
  },
  {
    key: "pushed values survive relocation",
    source:
      "\n      export function test(): number {\n        const a = [7];\n        for (let i = 1; i <= 30; i++) a.push(i);\n        return a[0] + a[1] + a[30] + a.length;\n      }\n    ",
    expected: 69,
    options: {
      target: "linear",
    },
  },
  {
    key: "aliases observe growth through the forwarding record",
    source:
      "\n      export function test(): number {\n        const a = [1];\n        const b = a;\n        for (let i = 0; i < 20; i++) a.push(i);\n        return b.length + b[20];\n      }\n    ",
    expected: 40,
    options: {
      target: "linear",
    },
  },
] as const;
for (const fixture of originalObligations) {
  it(`keeps the original ${fixture.expected} requirement for ${fixture.key}`, async () => {
    if (fixture.key === "aliasScalar31-out-of-scope-A") vi.stubEnv("JS2WASM_LINEAR_IR", "1");
    const result = await compile(fixture.source, fixture.options);
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const report = getLastLinearIrReport()!;
    const name = fixture.key === "aliasScalar31-out-of-scope-A" ? "run" : "test";
    const fn = report.irModule.functions.find((fn) => fn.name === name)!;
    expect(fn).toBeDefined();
    expect(report.ownerEvidence).toContainEqual({ outcome: "compiled", ownerUnitId: fn.unitId, legacyName: name });
    expect(report.funcs.get(fn.unitId)?.name).toBe(name);
    const bytes = Uint8Array.from(result.binary).buffer;
    expect(WebAssembly.validate(bytes)).toBe(true);
    const { instance } = await WebAssembly.instantiate(
      bytes,
      fixture.key === "aliasScalar31-out-of-scope-A" ? {} : { env: {} },
    );
    const actual = (instance.exports[name] as () => number)();
    console.info(
      "vector-forwarding-original",
      JSON.stringify({ fixture: fixture.key, owner: fn.unitId, actual, expected: fixture.expected }),
    );
    expect(actual).toBe(fixture.expected);
  });
}
it("preserves unsigned bounds and out-of-bounds numeric zero after growth", async () => {
  const result = await compile("export function test(): number { const a=[1.5]; a[31]=3.75; return a[-1]+a[32]; }", {
    target: "linear",
    optimize: false,
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  expect(getLastLinearIrReport()!.compiled).toContain("test");
  const { instance } = await WebAssembly.instantiate(Uint8Array.from(result.binary).buffer);
  expect((instance.exports.test as () => number)()).toBe(0);
});

it("typed production preflight binds the defined resolver after preceding imports and an import namesake", async () => {
  const mod = generateLinearModule(
    analyzeSource("export function test(): number { const a=[1.5]; a[31]=3.75; return a[31]; }"),
    {
      externImports: [
        { module: "probe", name: "unused", params: [], results: [] },
        { module: "probe", name: "__arr_resolve", params: [{ kind: "i32" }], results: [{ kind: "i32" }] },
      ],
    },
  );
  expect(hooks.consumers).toBeGreaterThan(0);
  const report = getLastLinearIrReport()!;
  expect(report.compiled).toContain("test");
  const fn = report.irModule.functions.find((fn) => fn.name === "test")!;
  const physical = report.funcs.get(fn.unitId)!;
  const resolved = index(mod, "__arr_resolve");
  expect(resolved).toBeGreaterThan(1);
  expect(physical.body).toContainEqual({ op: "call", funcIdx: resolved });
  const namesake = vi.fn((n: number) => n);
  const { instance } = await WebAssembly.instantiate(Uint8Array.from(emitBinary(mod)).buffer, {
    probe: { unused: () => {}, __arr_resolve: namesake },
  });
  expect((instance.exports.test as () => number)()).toBe(3.75);
  expect(namesake).not.toHaveBeenCalled();
});
