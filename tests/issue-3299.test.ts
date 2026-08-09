// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { addArrayRuntime, addLinearIrVecRuntime, addRuntime } from "../src/codegen-linear/runtime.js";
import { emitBinary } from "../src/emit/binary.js";
import {
  AllocSiteRegistry,
  IrFunctionBuilder,
  irVal,
  planLinearMemory,
  verifyIrBackendLegality,
  verifyIrFunction,
  type AllocSiteId,
  type IrFunction,
  type IrLowerResolver,
  type IrModule,
  type IrObjectShape,
  type IrType,
} from "../src/ir/index.js";
import { LinearEmitter } from "../src/ir/backend/linear-emitter.js";
import type {
  IrVecLowering,
  LinearMemoryFieldLowering,
  LinearObjectLowering,
  LinearVecLowering,
} from "../src/ir/backend/handles.js";
import { PORFFOR_KIND_NAMES, porfforRendererOutputText, type PorfforNode } from "../src/ir/backend/porffor/compat.js";
import { lowerIrModuleToPorffor } from "../src/ir/backend/porffor/integration.js";
import { loadOptionalPorffor } from "../src/ir/backend/porffor/loader.js";
import { lowerIrFunctionBody } from "../src/ir/lower.js";
import type { FuncTypeDef, ValType, WasmFunction, WasmModule } from "../src/ir/types.js";
import type {
  LinearAllocationSitePlan,
  LinearMemoryPlan,
  LinearRuntimeOperation,
} from "../src/ir/analysis/linear-memory-plan.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-3299");
const here = dirname(fileURLToPath(import.meta.url));
const porfforRoot = process.env.JS2WASM_PORFFOR_ROOT ?? join(here, "../vendor/Porffor");
const hasOptionalPorffor = existsSync(join(porfforRoot, "compiler/ir.js"));
const F64: IrType = irVal({ kind: "f64" });
const I32: IrType = irVal({ kind: "i32" });
const VECTOR_POINTER: IrType = irVal({ kind: "i32" });
const SHAPE: IrObjectShape = {
  fields: [
    { name: "x", type: F64 },
    { name: "y", type: F64 },
  ],
};

function proofFixture(): { module: IrModule; plan: LinearMemoryPlan } {
  const allocations = new AllocSiteRegistry();

  const object = new IrFunctionBuilder(identities.next("objectProof"), [F64], true, allocations);
  object.openBlock();
  const four = object.emitConst({ kind: "f64", value: 4 }, F64);
  const five = object.emitConst({ kind: "f64", value: 5 }, F64);
  const first = object.emitObjectNew(SHAPE, [four, five]);
  const second = object.emitObjectNew(SHAPE, [four, five]);
  const truth = object.emitConst({ kind: "bool", value: true }, I32);
  const alias = object.emitSelect(truth, first, second, { kind: "object", shape: SHAPE });
  const nine = object.emitConst({ kind: "f64", value: 9 }, F64);
  object.emitObjectSet(alias, "x", nine);
  const observed = object.emitObjectGet(first, "x", F64);
  const sameIdentity = object.emitBinary("i32.eq", first, alias, I32);
  const distinctIdentity = object.emitBinary("i32.ne", first, second, I32);
  const sameNumber = object.emitUnary("f64.convert_i32_s", sameIdentity, F64);
  const distinctNumber = object.emitUnary("f64.convert_i32_s", distinctIdentity, F64);
  const hundred = object.emitConst({ kind: "f64", value: 100 }, F64);
  const ten = object.emitConst({ kind: "f64", value: 10 }, F64);
  const mutationScore = object.emitBinary("f64.mul", observed, hundred, F64);
  const aliasScore = object.emitBinary("f64.mul", sameNumber, ten, F64);
  const identityScore = object.emitBinary("f64.add", aliasScore, distinctNumber, F64);
  const objectResult = object.emitBinary("f64.add", mutationScore, identityScore, F64);
  object.terminate({ kind: "return", values: [objectResult] });

  const vector = new IrFunctionBuilder(identities.next("vectorProof"), [F64], true, allocations);
  const index = vector.addParam("index", I32);
  vector.openBlock();
  const values = [4, 5, 6].map((value) => vector.emitConst({ kind: "f64", value }, F64));
  const vec = vector.emitVecNewFixed(values, F64, VECTOR_POINTER);
  const one = vector.emitConst({ kind: "i32", value: 1 }, I32);
  const replacement = vector.emitConst({ kind: "f64", value: 9 }, F64);
  vector.emitVecSet(vec, one, replacement);
  const length = vector.emitVecLen(vec);
  const lengthI32 = vector.emitUnary("i32.trunc_sat_f64_s", length, I32);
  const inBounds = vector.emitBinary("i32.lt_u", index, lengthI32, I32);
  let found!: ReturnType<IrFunctionBuilder["emitVecGet"]>;
  const foundBody = vector.collectBodyInstrs(() => {
    found = vector.emitVecGet(vec, index, F64);
  });
  let missing!: ReturnType<IrFunctionBuilder["emitConst"]>;
  const missingBody = vector.collectBodyInstrs(() => {
    missing = vector.emitConst({ kind: "f64", value: 0 }, F64);
  });
  const selected = vector.emitIfElse({
    cond: inBounds,
    then: foundBody,
    thenValue: found,
    else: missingBody,
    elseValue: missing,
    resultType: F64,
  });
  const vectorHundred = vector.emitConst({ kind: "f64", value: 100 }, F64);
  const lengthScore = vector.emitBinary("f64.mul", length, vectorHundred, F64);
  const vectorResult = vector.emitBinary("f64.add", selected, lengthScore, F64);
  vector.terminate({ kind: "return", values: [vectorResult] });

  const module = { functions: [object.finish(), vector.finish()] };
  for (const func of module.functions) {
    expect(verifyIrFunction(func)).toEqual([]);
    expect(verifyIrBackendLegality(func, "linear")).toEqual([]);
    expect(verifyIrBackendLegality(func, "porffor")).toEqual([]);
  }
  return { module, plan: planLinearMemory(module, allocations) };
}

function collectNodes(value: unknown, out: PorfforNode[] = []): PorfforNode[] {
  if (!Array.isArray(value)) return out;
  if (value.length === 6 && typeof value[0] === "number" && PORFFOR_KIND_NAMES[value[0]]) {
    const node = value as unknown as PorfforNode;
    out.push(node);
    collectNodes(node[3], out);
    collectNodes(node[4], out);
    collectNodes(node[5], out);
    return out;
  }
  for (const item of value) collectNodes(item, out);
  return out;
}

function nodeName(node: PorfforNode): string {
  return PORFFOR_KIND_NAMES[node[0]]!;
}

describe("#3299 shared heap/layout plan", () => {
  it("binds Porffor Alloc/Load/Store exclusively to planned arena layouts", () => {
    const { module, plan } = proofFixture();
    const input = lowerIrModuleToPorffor(module, { memoryPlan: plan });
    const nodes = input.funcs.flatMap((func) => collectNodes(func?.body ?? []));
    const names = nodes.map(nodeName);

    expect(names).toContain("Alloc");
    expect(names).toContain("Load");
    expect(names).toContain("Store");
    for (const forbidden of ["GcBarrier", "ArrGet", "ArrSet", "ArrLenSet", "LenGet", "LenSet", "RawC"] as const) {
      expect(names, `Porffor-native heap operation ${forbidden} escaped the adapter`).not.toContain(forbidden);
    }

    const objectLayout = plan.layoutForObjectShape(SHAPE)!;
    const vectorLayout = plan.layoutForVector(F64)!;
    expect(objectLayout.fields.map(({ name, offset }) => ({ name, offset }))).toEqual([
      { name: "x", offset: 8 },
      { name: "y", offset: 16 },
    ]);
    expect(vectorLayout).toMatchObject({
      lengthOffset: 8,
      capacityOffset: 12,
      elementsOffset: 16,
      elementStride: 8,
    });

    const stores = nodes.filter((node) => nodeName(node) === "Store");
    const loads = nodes.filter((node) => nodeName(node) === "Load");
    const storeOffsets = stores.map((node) => (node[5] as readonly unknown[])[0]);
    const loadOffsets = loads.map((node) => (node[5] as readonly unknown[])[0]);
    for (const field of objectLayout.fields) {
      expect(storeOffsets).toContain(field.offset);
    }
    expect(loadOffsets).toContain(objectLayout.fields.find((field) => field.name === "x")!.offset);
    expect(storeOffsets).toEqual(
      expect.arrayContaining([
        vectorLayout.lengthOffset,
        vectorLayout.capacityOffset,
        vectorLayout.elementsOffset,
        vectorLayout.elementsOffset + vectorLayout.elementStride,
        vectorLayout.elementsOffset + vectorLayout.elementStride * 2,
      ]),
    );
    expect(loadOffsets).toContain(vectorLayout.lengthOffset);
    const scaledIndex = nodes.find(
      (node) =>
        nodeName(node) === "Bin" &&
        node[3] === "*" &&
        Array.isArray(node[5]) &&
        nodeName(node[5] as unknown as PorfforNode) === "Const" &&
        (node[5] as unknown as PorfforNode)[3] === vectorLayout.elementStride,
    );
    expect(scaledIndex, "vector addressing must multiply by the planned stride").toBeDefined();

    const allocs = nodes.filter((node) => nodeName(node) === "Alloc");
    expect(allocs).toHaveLength(plan.allocations.length);
    const allocatedBytes = allocs.map((alloc) => {
      const bytesNode = alloc[3] as PorfforNode;
      expect(nodeName(bytesNode)).toBe("Const");
      expect(alloc[4]).toBe(0);
      expect(alloc[5]).toBe(0);
      return bytesNode[3] as number;
    });
    const plannedBytes = plan.allocations.map((allocation) => {
      expect(allocation.size.kind).toBe("constant");
      return allocation.size.kind === "constant" ? allocation.size.bytes : Number.NaN;
    });
    expect(allocatedBytes.sort((left, right) => left - right)).toEqual(
      plannedBytes.sort((left, right) => left - right),
    );
    expect(plan.policy).toBe("arena-v1");
    expect(
      plan.allocations.every(
        (allocation: LinearAllocationSitePlan) =>
          allocation.allocationClass === "arena" &&
          allocation.root.kind === "none" &&
          allocation.safepoints.kind === "none" &&
          allocation.barrier.kind === "none",
      ),
    ).toBe(true);
    expect(input.prefs.gc).toBe(false);
    expect(input.usedTypes).toEqual(new Set());
    expect(() => lowerIrModuleToPorffor(module, { memoryPlan: plan, prefs: { gc: true } })).toThrow(
      /arena-v1 requires prefs\.gc=false/,
    );
  });

  const optionalIt = hasOptionalPorffor && findCCompiler() ? it : it.skip;
  optionalIt(
    "executes the same typed SSA through linear-Wasm and Porffor-C with JS semantics",
    async () => {
      const { module, plan } = proofFixture();
      const expected = [objectOracle(), vectorOracle(1), vectorOracle(-1), vectorOracle(8)];

      const linear = await instantiateLinearProof(module, plan);
      const linearValues = [linear.objectProof(), linear.vectorProof(1), linear.vectorProof(-1), linear.vectorProof(8)];

      const input = lowerIrModuleToPorffor(module, { memoryPlan: plan });
      const porffor = await loadOptionalPorffor({ root: porfforRoot });
      const rendered = porfforRendererOutputText(porffor.render(input));
      const porfforValues = compileAndRunC(rendered, input.funcs, [
        { name: "objectProof", args: [] },
        { name: "vectorProof", args: [1] },
        { name: "vectorProof", args: [-1] },
        { name: "vectorProof", args: [8] },
      ]);

      expect(expected).toEqual([911, 309, 300, 300]);
      expect(linearValues).toStrictEqual(expected);
      expect(porfforValues).toStrictEqual(expected);
    },
    60_000,
  );
});

function objectOracle(): number {
  const first = { x: 4, y: 5 };
  const alias = first;
  const second = { x: 4, y: 5 };
  alias.x = 9;
  return first.x * 100 + (first === alias ? 10 : 0) + (first !== second ? 1 : 0);
}

function vectorOracle(index: number): number {
  const values = [4, 5, 6];
  values[1] = 9;
  return (index >= 0 && index < values.length ? values[index]! : 0) + values.length * 100;
}

function emptyLinearModule(): WasmModule {
  return {
    types: [],
    imports: [],
    functions: [],
    exports: [],
    tables: [],
    elements: [],
    globals: [],
    tags: [],
    stringPool: [],
    externClasses: [],
    nodeBuiltinModules: new Set(),
    stringLiteralValues: new Map(),
    asyncFunctions: new Set(),
    declaredFuncRefs: [],
    funcOrdinalToPosition: [],
    memories: [],
    dataSegments: [],
  };
}

async function instantiateLinearProof(
  module: IrModule,
  plan: LinearMemoryPlan,
): Promise<{ objectProof: () => number; vectorProof: (index: number) => number }> {
  const wasm = emptyLinearModule();
  addRuntime(wasm);
  addArrayRuntime(wasm);
  addLinearIrVecRuntime(wasm);

  const objectLayout = plan.layoutForObjectShape(SHAPE)!;
  const mallocIdx = functionIndex(wasm, "__malloc");
  const objectHelperType = internFuncType(wasm, {
    kind: "func",
    params: SHAPE.fields.map(() => ({ kind: "f64" as const })),
    results: [{ kind: "i32" }],
  });
  const objectHelperIdx = wasm.functions.length;
  wasm.functions.push({
    name: "__proof_object_new",
    typeIdx: objectHelperType,
    locals: [{ name: "#ptr", type: { kind: "i32" } }],
    body: [
      { op: "i32.const", value: objectLayout.size.kind === "constant" ? objectLayout.size.bytes : 0 },
      { op: "call", funcIdx: mallocIdx },
      { op: "local.set", index: 2 },
      ...objectLayout.fields.flatMap((field, index) => [
        { op: "local.get" as const, index: 2 },
        { op: "local.get" as const, index },
        { op: "f64.store" as const, align: 3 as const, offset: field.offset },
      ]),
      { op: "local.get", index: 2 },
    ],
    exported: false,
  });

  const resolver = linearResolver(wasm, plan, objectHelperIdx);
  for (const ir of module.functions) {
    const emitter = new LinearEmitter({ resolveRuntimeOperation: (operation) => runtimeOperation(wasm, operation) });
    const body = lowerIrFunctionBody(ir, resolver, emitter, {
      backend: "linear",
      convertType(type: IrType): readonly ValType[] {
        if (type.kind === "val") return [type.val];
        if (type.kind === "object") return [{ kind: "i32" }];
        throw new Error(`proof linear converter cannot carry '${type.kind}'`);
      },
    });
    const params = body.params.flatMap((param) => [...param.slots]);
    const results = body.results.flatMap((result) => [...result]);
    const vecScratch = new Set(emitter.getVecScratchLocalIndices());
    const lowered: WasmFunction = {
      name: body.name,
      typeIdx: internFuncType(wasm, { kind: "func", params, results }),
      locals: body.locals.flatMap((local) =>
        local.slots.map((type, slot) => {
          const index =
            params.length +
            body.locals.slice(0, body.locals.indexOf(local)).reduce((n, item) => n + item.slots.length, 0) +
            slot;
          return {
            name: slot === 0 ? local.name : `${local.name}$${slot}`,
            type: vecScratch.has(index) ? ({ kind: "i32" } as const) : type,
          };
        }),
      ),
      body: body.body,
      exported: body.exported,
    };
    const index = wasm.functions.length;
    wasm.functions.push(lowered);
    wasm.exports.push({ name: ir.name, desc: { kind: "func", index } });
  }

  const binary = emitBinary(wasm);
  const { instance } = await WebAssembly.instantiate(binary, {});
  return instance.exports as unknown as { objectProof: () => number; vectorProof: (index: number) => number };
}

function linearResolver(wasm: WasmModule, plan: LinearMemoryPlan, objectHelperIdx: number): IrLowerResolver {
  const allocationFor = (layoutId: string, alloc?: AllocSiteId): LinearAllocationSitePlan => {
    const allocation = alloc === undefined ? plan.allocationsForLayout(layoutId)[0] : plan.allocation(alloc);
    if (!allocation || allocation.layoutId !== layoutId) throw new Error(`missing allocation for ${layoutId}`);
    return allocation;
  };
  const operation = (
    allocation: LinearAllocationSitePlan,
    predicate: (candidate: LinearRuntimeOperation) => boolean,
  ): LinearRuntimeOperation => {
    const found = allocation.operations.find(predicate);
    if (!found) throw new Error(`missing planned operation for site ${allocation.id as number}`);
    return found;
  };
  const vec = (alloc?: AllocSiteId): IrVecLowering & LinearVecLowering => {
    const layout = plan.layoutForVector(F64)!;
    const allocation = allocationFor(layout.id, alloc);
    return {
      vecStructTypeIdx: 0,
      lengthFieldIdx: 0,
      dataFieldIdx: 0,
      arrayTypeIdx: 0,
      elementValType: { kind: "f64" },
      linearMemory: {
        allocation,
        layout,
        allocate: operation(
          allocation,
          (candidate) => candidate.family === "vector" && candidate.operation === "allocate",
        ),
        initializeElement: operation(
          allocation,
          (candidate) => candidate.family === "vector" && candidate.operation === "initialize-element",
        ),
      },
    };
  };

  return {
    resolveFunc(): number {
      throw new Error("proof module has no calls");
    },
    resolveGlobal(): number {
      throw new Error("proof module has no globals");
    },
    resolveType(): number {
      throw new Error("proof module has no symbolic types");
    },
    internFuncType(type: FuncTypeDef): number {
      return internFuncType(wasm, type);
    },
    resolveObject(shape: IrObjectShape, alloc?: AllocSiteId): LinearObjectLowering | null {
      const layout = plan.layoutForObjectShape(shape);
      if (!layout) return null;
      const allocation = allocationFor(layout.id, alloc);
      const fields = shape.fields.map((field, fieldIdx) => {
        const planned = layout.fields.find((candidate) => candidate.name === field.name)!;
        return { name: field.name, fieldIdx, offset: planned.offset, type: { kind: "f64" as const } };
      });
      const byName = new Map(fields.map((field) => [field.name, field]));
      return {
        typeIdx: 0,
        fieldIdx(name: string): number {
          return byName.get(name)!.fieldIdx;
        },
        linearMemory: {
          allocation,
          layout,
          allocate: operation(
            allocation,
            (candidate) => candidate.family === "memory" && candidate.operation === "allocate",
          ),
          newFuncIdx: objectHelperIdx,
          fieldCount: fields.length,
          field(name: string): LinearMemoryFieldLowering {
            return byName.get(name)!;
          },
        },
      };
    },
    resolveVec(valType: ValType): IrVecLowering | null {
      return valType.kind === "i32" ? vec() : null;
    },
    resolveVecForElement(elementValType: ValType, alloc?: AllocSiteId): IrVecLowering | null {
      return elementValType.kind === "f64" ? vec(alloc) : null;
    },
  };
}

function internFuncType(wasm: WasmModule, type: FuncTypeDef): number {
  const index = wasm.types.length;
  wasm.types.push({ ...type, name: `$proof_type_${index}` });
  return index;
}

function functionIndex(wasm: WasmModule, name: string): number {
  const index = wasm.functions.findIndex((func) => func.name === name);
  if (index < 0) throw new Error(`missing linear runtime function ${name}`);
  return wasm.imports.filter((entry) => entry.desc.kind === "func").length + index;
}

function runtimeOperation(wasm: WasmModule, operation: LinearRuntimeOperation): number {
  if (operation.family === "memory" && operation.operation === "allocate") return functionIndex(wasm, "__malloc");
  if (operation.family === "vector" && operation.operation === "allocate") return functionIndex(wasm, "__arr_new");
  if (operation.family === "vector" && operation.operation === "initialize-element") {
    return functionIndex(wasm, "__linear_ir_vec_init_f64");
  }
  throw new Error(`unsupported proof runtime operation ${JSON.stringify(operation)}`);
}

function findCCompiler(): string | null {
  const candidates = [process.env.CC, "cc", "clang", "gcc"].filter((candidate): candidate is string => !!candidate);
  for (const candidate of candidates) {
    if (spawnSync(candidate, ["--version"], { stdio: "ignore" }).status === 0) return candidate;
  }
  return null;
}

function compileAndRunC(
  rendered: string,
  funcs: readonly ({ readonly name: string; readonly index: number } | null | undefined)[],
  calls: readonly { readonly name: string; readonly args: readonly number[] }[],
): number[] {
  const compiler = findCCompiler();
  if (!compiler) throw new Error("no C compiler available");
  const symbols = new Map(
    funcs.filter((func): func is NonNullable<typeof func> => !!func).map((func) => [func.name, func]),
  );
  const invocationLines = calls.map((call) => {
    const func = symbols.get(call.name);
    if (!func) throw new Error(`missing Porffor function ${call.name}`);
    return `  printf("%.17g\\n", p${func.index}_${func.name}(${call.args.join(", ")}));`;
  });
  const harness = `
int main(int argc, char** argv) {
  porf_init(argc, argv);
  porf_data_init();
${invocationLines.join("\n")}
  return 0;
}
`;
  const directory = mkdtempSync(join(tmpdir(), "js2-porffor-3299-"));
  const sourcePath = join(directory, "proof.c");
  const binaryPath = join(directory, "proof");
  try {
    writeFileSync(sourcePath, rendered + harness);
    const result = spawnSync(
      compiler,
      ["-std=gnu11", "-Werror", "-Wno-unused-function", sourcePath, "-lm", "-o", binaryPath],
      { encoding: "utf8" },
    );
    expect(result.status, `C compiler failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
    return execFileSync(binaryPath, { encoding: "utf8" }).trim().split("\n").map(Number);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
