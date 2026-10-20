// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import {
  reserveNativeJsClassPhysicalValues,
  reserveNativeJsClassPhysicalFunctions,
  reserveNativeJsClassPhysicalRealm,
  reserveNativeJsClassPhysicalModuleBindings,
  fillNativeJsClassPhysicalValues,
  fillNativeJsClassPhysicalRealm,
  fillNativeJsClassPhysicalModuleBindings,
  nativeJsClassPhysicalFunctionPlan,
  nativeJsClassPhysicalLowering,
  emitNativeJsClassPhysicalDefinition,
  emitNativeJsClassPhysicalFrame,
  emitNativeJsClassPhysicalModuleInitialization,
  nativeJsClassPhysicalSignatureConverter,
} from "../src/backend/wasmgc/program/native-realm.js";
import type { Instr, ValType } from "../src/wasm/model/instructions.js";
import { irRuntimeTypeRef } from "../src/ir/core/binding-references.js";
import type { IrTypeRef } from "../src/ir/core/types.js";
import type { IrType } from "../src/ir/core/types.js";

const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture() {
  const policy = { backend: "wasmgc" as const, target: "standalone" as const };
  const ast = analyzeMultiSource({ "./entry.ts": "class C{}export function run():number{return 1;}" }, "./entry.ts");
  const result = prepareWholeIrProgram({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy,
    runtimePolicies: [policy],
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
  });
  if (result.kind !== "prepared") throw Error(JSON.stringify(result));
  const program = result.program,
    projection = program.runtime[0]!,
    module = createEmptyModule();
  const tx = new PhysicalModuleReservations(module);
  const values = reserveNativeJsClassPhysicalValues(tx, program, projection)!;
  reserveNativeJsClassPhysicalFunctions(values);
  reserveNativeJsClassPhysicalRealm(values);
  reserveNativeJsClassPhysicalModuleBindings(values);
  tx.freezeReservations();
  fillNativeJsClassPhysicalValues(values);
  fillNativeJsClassPhysicalRealm(values);
  fillNativeJsClassPhysicalModuleBindings(values);
  const fn = projection.prepared.functions.find((fn) =>
    fn.blocks.some((b) => b.instrs.some((i) => i.kind === "js.class.define")),
  )!;
  const instruction = fn.blocks.flatMap((b) => b.instrs).find((i) => i.kind === "js.class.define")!;
  if (instruction.kind !== "js.class.define") throw Error("missing actual source definition");
  const mutate = () =>
    module.functions.find((f) => f.name === "__class_function_prototype")!.body.push({ op: "unreachable" });
  const makePlan = (callbacks: { raw?: () => void; resolve?: () => void; convert?: () => void } = {}) => {
    const plan = nativeJsClassPhysicalFunctionPlan(
      values,
      fn,
      {
        resolveType: (() => {
          callbacks.resolve?.();
          return 0;
        }) as (ref: IrTypeRef) => number,
      },
      {
        pushRaw(out: Instr[], instruction: Instr) {
          callbacks.raw?.();
          out.push(instruction);
        },
      },
      {
        backend: "wasmgc",
        convertType(_type: IrType): readonly ValType[] {
          callbacks.convert?.();
          return [{ kind: "i32" }];
        },
      },
    );
    if (!plan) throw Error("missing issued module-init function plan");
    return plan;
  };
  const fallbackRef = irRuntimeTypeRef(program.inventory.sources[0]!.id, "guard-test-runtime-type");
  return { program, projection, tx, values, fn, instruction, mutate, makePlan, fallbackRef };
}

it("executes healthy issued direct and terminal recipes without a cached verdict", async () => {
  await yieldLoop();
  const f = fixture();
  let local = 0;
  expect(emitNativeJsClassPhysicalDefinition(f.values, f.fn, f.instruction, () => local++)).not.toHaveLength(0);
  const out: Instr[] = [];
  f.makePlan().emitter.emitNativeJsClass(f.fn, f.instruction, [], () => local++, out);
  expect(out.length).toBeGreaterThan(0);
  f.mutate();
  expect(() => f.makePlan()).toThrow();
  await yieldLoop();
}, 35000);

it.each(["direct", "port", "terminal"] as const)(
  "rejects mutation by scratch through the %s entry",
  async (entry) => {
    await yieldLoop();
    const f = fixture();
    let calls = 0;
    const scratch = () => {
      calls++;
      f.mutate();
      return 0;
    };
    const invoke =
      entry === "direct"
        ? () => emitNativeJsClassPhysicalDefinition(f.values, f.fn, f.instruction, scratch)
        : entry === "port"
          ? () => nativeJsClassPhysicalLowering(f.values, f.fn).emit(f.instruction, [], scratch)
          : () => f.makePlan().emitter.emitNativeJsClass(f.fn, f.instruction, [], scratch, []);
    expect(invoke).toThrow();
    expect(calls).toBe(1);
    await yieldLoop();
  },
  35000,
);

it("replays after an actual raw emitter effect", async () => {
  await yieldLoop();
  const f = fixture();
  let calls = 0;
  const plan = f.makePlan({
    raw() {
      calls++;
      f.mutate();
    },
  });
  let local = 0;
  expect(() => plan.emitter.emitNativeJsClass(f.fn, f.instruction, [], () => local++, [])).toThrow();
  expect(calls).toBeGreaterThan(0);
  await yieldLoop();
}, 35000);

it.each(["resolve", "convert", "signature"] as const)(
  "replays after actual generic %s fallback",
  async (kind) => {
    await yieldLoop();
    const f = fixture();
    let calls = 0;
    const effect = () => {
      calls++;
      f.mutate();
    };
    const plan = f.makePlan({ [kind]: effect });
    const invoke =
      kind === "resolve"
        ? () => plan.resolver.resolveType(f.fallbackRef)
        : kind === "convert"
          ? () => plan.typeConverter.convertType({ kind: "val", val: { kind: "i32" } })
          : () =>
              nativeJsClassPhysicalSignatureConverter(f.values, () => {
                effect();
                return { params: [{ kind: "i32" } as ValType], results: [] };
              })({ params: [{ kind: "i32" } as ValType], results: [] });
    expect(invoke).toThrow();
    expect(calls).toBe(1);
    await yieldLoop();
  },
  35000,
);

it.each(["scratch", "raw", "resolve", "convert", "signature"] as const)(
  "preserves the actual %s exception",
  async (kind) => {
    await yieldLoop();
    const f = fixture();
    const error = new Error("original callback throw");
    const fail = () => {
      throw error;
    };
    const plan = f.makePlan({ [kind]: fail });
    let local = 0;
    const invoke =
      kind === "scratch"
        ? () => plan.emitter.emitNativeJsClass(f.fn, f.instruction, [], fail, [])
        : kind === "raw"
          ? () => plan.emitter.emitNativeJsClass(f.fn, f.instruction, [], () => local++, [])
          : kind === "resolve"
            ? () => plan.resolver.resolveType(f.fallbackRef)
            : kind === "convert"
              ? () => plan.typeConverter.convertType({ kind: "val", val: { kind: "i32" } })
              : () =>
                  nativeJsClassPhysicalSignatureConverter(
                    f.values,
                    fail,
                  )({ params: [{ kind: "i32" } as ValType], results: [] });
    expect(invoke).toThrow(error);
    expect(() => f.makePlan()).not.toThrow();
    await yieldLoop();
  },
  35000,
);

it("rejects foreign instruction getters before effects and copied plans", async () => {
  await yieldLoop();
  const f = fixture();
  const port = nativeJsClassPhysicalLowering(f.values, f.fn);
  let reads = 0;
  const foreign = Object.defineProperty({}, "kind", {
    get() {
      reads++;
      throw Error("getter");
    },
  });
  expect(() => port.emit(foreign as never, [], () => 0)).toThrow("foreign class lowering occurrence");
  expect(() => emitNativeJsClassPhysicalDefinition({ ...f.values }, f.fn, f.instruction, () => 0)).toThrow();
  expect(reads).toBe(0);
  await yieldLoop();
}, 35000);

it("executes healthy raw and generic fallbacks before any stale-state refusal", async () => {
  await yieldLoop();
  const f = fixture();
  const calls = { raw: 0, resolve: 0, convert: 0, signature: 0 };
  const plan = f.makePlan({
    raw() {
      calls.raw++;
    },
    resolve() {
      calls.resolve++;
    },
    convert() {
      calls.convert++;
    },
  });
  let local = 0;
  const out: Instr[] = [];
  plan.emitter.emitNativeJsClass(f.fn, f.instruction, [], () => local++, out);
  expect(out.length).toBeGreaterThan(0);
  expect(calls.raw).toBe(out.length);
  expect(plan.resolver.resolveType(f.fallbackRef)).toBe(0);
  expect(plan.typeConverter.convertType({ kind: "val", val: { kind: "i32" } })).toEqual([{ kind: "i32" }]);
  const signature = nativeJsClassPhysicalSignatureConverter(f.values, () => {
    calls.signature++;
    return { params: [{ kind: "i32" } as ValType], results: [] };
  });
  expect(signature({ params: [{ kind: "i32" } as ValType], results: [] })).toEqual({
    params: [{ kind: "i32" }],
    results: [],
  });
  expect(calls.resolve).toBe(1);
  expect(calls.convert).toBe(1);
  expect(calls.signature).toBe(1);
  f.mutate();
  expect(() => plan.resolver.resolveType(f.fallbackRef)).toThrow();
  expect(calls.resolve).toBe(1);
  await yieldLoop();
}, 35000);

it("independently checks a reentrant actual operation and rejects later outer mutation", async () => {
  await yieldLoop();
  const f = fixture();
  let nested = 0;
  let local = 0;
  const plan = f.makePlan({
    raw() {
      if (nested === 0) {
        nested++;
        expect(emitNativeJsClassPhysicalDefinition(f.values, f.fn, f.instruction, () => local++)).not.toHaveLength(0);
        f.mutate();
      }
    },
  });
  expect(() => plan.emitter.emitNativeJsClass(f.fn, f.instruction, [], () => local++, [])).toThrow();
  expect(nested).toBe(1);
  await yieldLoop();
}, 35000);

it("captures actual frame operands before scratch can install an executable getter", async () => {
  await yieldLoop();
  const f = fixture();
  const fn = f.projection.prepared.functions.find((fn) =>
    fn.blocks.some((b) => b.instrs.some((i) => i.kind === "js.class.frame.new")),
  )!;
  const instruction = fn.blocks.flatMap((b) => b.instrs).find((i) => i.kind === "js.class.frame.new")!;
  if (instruction.kind !== "js.class.frame.new") throw Error("missing genuine activation frame");
  const operands: Instr[][] = Array.from({ length: 4 }, (_, index) => [{ op: "local.get", index }]);
  let local = 4,
    reads = 0,
    scratches = 0;
  const result = nativeJsClassPhysicalLowering(f.values, fn).emit(instruction, operands, () => {
    if (scratches++ === 0)
      Object.defineProperty(operands[0]!, "0", {
        configurable: true,
        get() {
          reads++;
          throw Error("caller operand getter after entry");
        },
      });
    return local++;
  });
  expect(scratches).toBe(4);
  expect(reads).toBe(0);
  expect(result.filter((operation) => operation.op === "local.get").slice(0, 4)).toEqual(
    [0, 1, 2, 3].map((index) => ({ op: "local.get", index })),
  );
  let laterScratch = 0;
  expect(() => nativeJsClassPhysicalLowering(f.values, fn).emit(instruction, operands, () => laterScratch++)).toThrow();
  expect(reads).toBe(0);
  expect(laterScratch).toBe(0);
  await yieldLoop();
}, 35000);

it("keeps direct helper family restrictions after exact current membership", async () => {
  await yieldLoop();
  const f = fixture();
  let calls = 0;
  const fn = f.projection.prepared.functions.find((fn) =>
    fn.blocks.some((b) => b.instrs.some((i) => i.kind === "js.class.frame.new")),
  )!;
  const frame = fn.blocks.flatMap((b) => b.instrs).find((i) => i.kind === "js.class.frame.new")!;
  expect(() =>
    emitNativeJsClassPhysicalDefinition(f.values, fn, frame as unknown as typeof f.instruction, () => calls++),
  ).toThrow("wrong direct class recipe family");
  expect(calls).toBe(0);
  expect(emitNativeJsClassPhysicalDefinition(f.values, f.fn, f.instruction, () => calls++)).not.toHaveLength(0);
  expect(calls).toBeGreaterThan(0);
  await yieldLoop();
}, 35000);

it.each(["foreign", "wrong-family"] as const)(
  "preserves %s refusal before hostile operands",
  async (mode) => {
    await yieldLoop();
    const f = fixture();
    let reads = 0,
      scratches = 0;
    const operands = Object.defineProperty([], "0", {
      get() {
        reads++;
        throw Error("operand getter");
      },
    }) as Instr[][];
    const ctor = f.projection.prepared.functions.find((fn) =>
      fn.blocks.some((b) => b.instrs.some((i) => i.kind === "js.class.frame.new")),
    )!;
    const frame = ctor.blocks.flatMap((b) => b.instrs).find((i) => i.kind === "js.class.frame.new")!;
    const instruction = mode === "foreign" ? { ...frame } : f.instruction;
    const fn = mode === "foreign" ? ctor : f.fn;
    expect(() =>
      emitNativeJsClassPhysicalFrame(
        f.values,
        fn,
        instruction as unknown as typeof frame & { kind: "js.class.frame.new" },
        operands,
        () => scratches++,
      ),
    ).toThrow(mode === "foreign" ? "unissued activation occurrence" : "wrong direct class recipe family");
    expect(reads).toBe(0);
    expect(scratches).toBe(0);
    await yieldLoop();
  },
  35000,
);

it.each(["healthy", "getter", "stale"] as const)(
  "observes multi-type signature %s effects at each fallback boundary",
  async (mode) => {
    await yieldLoop();
    const f = fixture();
    const ctor = f.projection.prepared.functions.find((fn) => fn.params.length === 4)!;
    const role = ctor.params[0]!.type;
    const signature = {
      params: [{ kind: "i32" } as ValType, role, { kind: "i32" } as ValType],
      results: [] as (IrType | ValType)[],
    };
    let calls = 0,
      reads = 0;
    const convert = nativeJsClassPhysicalSignatureConverter(f.values, () => {
      calls++;
      if (calls === 1 && mode === "getter")
        Object.defineProperty(signature.params, "1", {
          get() {
            reads++;
            return role;
          },
        });
      if (calls === 1 && mode === "stale") f.mutate();
      return { params: [{ kind: "i32" } as ValType], results: [] };
    });
    if (mode === "stale") {
      expect(() => convert(signature)).toThrow();
      expect(calls).toBe(1);
    } else {
      const result = convert(signature);
      expect(result.params).toHaveLength(3);
      expect(result.params[0]).toEqual({ kind: "i32" });
      expect(result.params[1]!.kind).toBe("ref");
      expect(result.params[2]).toEqual({ kind: "i32" });
      expect(calls).toBe(2);
    }
    expect(reads).toBe(0);
    await yieldLoop();
  },
  35000,
);

it("screens the actual fallback result before an executable params getter", async () => {
  await yieldLoop();
  const f = fixture();
  let calls = 0,
    reads = 0;
  const convert = nativeJsClassPhysicalSignatureConverter(f.values, () => {
    calls++;
    return Object.defineProperty({ results: [] as ValType[] }, "params", {
      get() {
        reads++;
        throw Error("fallback params getter");
      },
    }) as { params: ValType[]; results: ValType[] };
  });
  expect(() => convert({ params: [{ kind: "i32" } as ValType], results: [] })).toThrow();
  expect(calls).toBe(1);
  expect(reads).toBe(0);
  await yieldLoop();
}, 35000);

it("captures earlier fallback result types before a later callback mutates their aliases", async () => {
  await yieldLoop();
  const f = fixture();
  const role = f.projection.prepared.functions.find((fn) => fn.params.length === 4)!.params[0]!.type;
  const first: ValType = { kind: "i32" };
  let calls = 0,
    reads = 0;
  const convert = nativeJsClassPhysicalSignatureConverter(f.values, () => {
    calls++;
    if (calls === 2)
      Object.defineProperty(first, "kind", {
        get() {
          reads++;
          return "i32";
        },
      });
    return { params: [calls === 1 ? first : ({ kind: "i32" } as ValType)], results: [] };
  });
  const result = convert({ params: [{ kind: "i32" } as ValType, role, { kind: "i32" } as ValType], results: [] });
  expect(calls).toBe(2);
  expect(result.params.map((type) => type.kind)).toEqual(["i32", "ref", "i32"]);
  expect(reads).toBe(0);
  await yieldLoop();
}, 35000);

it("rejects an actual generic converter result getter before downstream type observation", async () => {
  await yieldLoop();
  const f = fixture();
  let calls = 0,
    reads = 0;
  const plan = nativeJsClassPhysicalFunctionPlan(
    f.values,
    f.fn,
    {
      resolveType() {
        throw Error("unused resolver");
      },
    },
    {
      pushRaw(out: Instr[], instruction: Instr) {
        out.push(instruction);
      },
    },
    {
      backend: "wasmgc",
      convertType(): readonly ValType[] {
        calls++;
        return Object.defineProperty([], "0", {
          get() {
            reads++;
            return { kind: "i32" };
          },
        });
      },
    },
  )!;
  let threw = false;
  try {
    plan.typeConverter.convertType({ kind: "val", val: { kind: "i32" } }).map((type) => type.kind);
  } catch {
    threw = true;
  }
  expect(calls).toBe(1);
  expect(reads).toBe(0);
  expect(threw).toBe(true);
  await yieldLoop();
}, 35000);

it("retains deep module operand screening and the genuine healthy initialization recipe", async () => {
  await yieldLoop();
  const f = fixture();
  let reads = 0;
  const instruction = f.fn.blocks.flatMap((block) => block.instrs).find((i) => i.kind === "js.class.binding.init")!;
  if (instruction.kind !== "js.class.binding.init") throw Error("missing actual module initialization");
  const hostile = Object.defineProperty([], "0", {
    get() {
      reads++;
      throw Error("module operand getter");
    },
  }) as Instr[];
  expect(() => emitNativeJsClassPhysicalModuleInitialization(f.values, f.fn, instruction, hostile)).toThrow();
  expect(reads).toBe(0);
  let local = 0;
  const constructorCode = emitNativeJsClassPhysicalDefinition(f.values, f.fn, f.instruction, () => local++);
  const result = emitNativeJsClassPhysicalModuleInitialization(f.values, f.fn, instruction, constructorCode);
  expect(result.filter((operation) => operation.op === "global.set")).toHaveLength(2);
  expect(reads).toBe(0);
  await yieldLoop();
}, 35000);
