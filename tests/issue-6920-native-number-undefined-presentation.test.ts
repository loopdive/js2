// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it, vi } from "vitest";
import * as directGc from "../src/codegen/index.js";
import * as directLinear from "../src/codegen-linear/index.js";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { compile } from "../src/index.js";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import {
  acceptPreparedIrProgram,
  emitAcceptedIrProgram,
  emittedPhysicalSetupPlan,
  emittedProgramBindingIndex,
} from "../src/ir/program-consumer.js";
import { completedNativeNumberUndefinedPresentation } from "../src/compiler/ir-native-number-undefined-presentation.js";
import type { PreparedIrBackendOptions } from "../src/ir/program.js";
const policies = [
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
] as const;
function fixture(policy: (typeof policies)[number] = policies[2]) {
  const text = "export function run(x:number):number{const a=[x];return a[99]===a[99]?1:0;}";
  const ast = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
  const result = prepareWholeIrProgram({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: policies[0],
    runtimePolicies: policies,
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
  });
  expect(result.kind).toBe("prepared");
  if (result.kind !== "prepared") throw Error(JSON.stringify(result));
  const backend: PreparedIrBackendOptions = {
    ...policy,
    moduleName: "number-undefined-presentation",
    sharedExceptionTag: false,
    utf8Storage: false,
    sourceMap: false,
  };
  const accepted = acceptPreparedIrProgram(result.program, backend);
  expect(accepted.kind).toBe("accepted");
  if (accepted.kind !== "accepted") throw Error(JSON.stringify(accepted));
  const emission = emitAcceptedIrProgram(accepted),
    program = result.program;
  const physical = emittedPhysicalSetupPlan(emission),
    plan = physical.numberUndefined!;
  const binding = emittedProgramBindingIndex(emission, plan.singletonBindingId)!;
  const globalIndex = binding.index - emission.module.imports.filter((row) => row.desc.kind === "global").length;
  return { program, emission, backend, physical, plan, globalIndex, global: emission.module.globals[globalIndex]! };
}
it("joins only authentic internal immutable singleton and one GC carrier on all four native profiles", async () => {
  for (const policy of policies) {
    await yieldTurn();
    const f = fixture(policy);
    const result = completedNativeNumberUndefinedPresentation(f.program, f.emission, f.backend)!;
    expect(result.bindingId).toBe(f.plan.singletonBindingId);
    expect(result.carrierTypeIndices).toHaveLength(policy.backend === "wasmgc" ? 1 : 0);
    expect(
      f.emission.module.exports.some(
        (row) =>
          row.desc.kind === "global" &&
          row.desc.index === emittedProgramBindingIndex(f.emission, result.bindingId)!.index,
      ),
    ).toBe(false);
  }
}, 120000);
it.each([
  "emissionCopy",
  "foreignProgram",
  "wrongBackend",
  "globalCopy",
  "globalMutable",
  "globalInit",
  "carrierField",
  "carrierIndex",
  "globalGetter",
  "moduleGetter",
  "sourceGetter",
  "bindingIntent",
  "supportType",
  "alias",
  "export",
  "startup",
  "physicalExport",
  "staleAfterFirstProof",
])(
  "refuses actual GC completed artifact %s without presentation authority",
  async (kind) => {
    await yieldTurn();
    const f = fixture();
    if (kind === "emissionCopy") {
      expect(() => completedNativeNumberUndefinedPresentation(f.program, { ...f.emission }, f.backend)).toThrow();
      return;
    }
    if (kind === "foreignProgram") {
      expect(() => completedNativeNumberUndefinedPresentation({ ...f.program }, f.emission, f.backend)).toThrow();
      return;
    }
    if (kind === "wrongBackend") {
      expect(() =>
        completedNativeNumberUndefinedPresentation(f.program, f.emission, { ...f.backend, backend: "linear" }),
      ).toThrow();
      return;
    }
    if (kind === "globalCopy") f.emission.module.globals[f.globalIndex] = { ...f.global };
    if (kind === "globalMutable") f.global.mutable = true;
    if (kind === "globalInit") f.global.init = [{ op: "i32.const", value: 0 }];
    if (kind === "carrierField" && f.global.type.kind === "ref") {
      const type = f.emission.module.types[f.global.type.typeIdx]!;
      if (type.kind !== "struct") throw Error("genuine carrier was not struct");
      type.fields[0]!.mutable = true;
    }
    if (kind === "carrierIndex" && f.global.type.kind === "ref")
      f.global.type = { kind: "ref", typeIdx: f.global.type.typeIdx + 1 };
    if (kind === "globalGetter" || kind === "moduleGetter" || kind === "sourceGetter") {
      let reads = 0;
      if (kind === "globalGetter")
        Object.defineProperty(f.global, "init", {
          get() {
            reads++;
            throw Error("getter executed");
          },
          enumerable: true,
        });
      if (kind === "moduleGetter") {
        expect(Object.getOwnPropertyDescriptor(f.emission, "module")?.configurable).toBe(false);
        const emission = { ...f.emission };
        Object.defineProperty(emission, "module", {
          get() {
            reads++;
            throw Error("getter executed");
          },
          enumerable: true,
        });
        expect(() => completedNativeNumberUndefinedPresentation(f.program, emission, f.backend)).toThrow();
        expect(reads).toBe(0);
        return;
      }
      if (kind === "sourceGetter") {
        const program = { ...f.program };
        Object.defineProperty(program, "abi", {
          get() {
            reads++;
            throw Error("getter executed");
          },
          enumerable: true,
        });
        expect(() => completedNativeNumberUndefinedPresentation(program, f.emission, f.backend)).toThrow();
        expect(reads).toBe(0);
        return;
      }
      expect(() => completedNativeNumberUndefinedPresentation(f.program, f.emission, f.backend)).toThrow();
      expect(reads).toBe(0);
      return;
    }
    if (
      kind === "bindingIntent" ||
      kind === "supportType" ||
      kind === "alias" ||
      kind === "export" ||
      kind === "startup"
    ) {
      const entries = f.program.abi.entries.map((row) =>
        row.plan.id === f.plan.singletonBindingId
          ? { ...row, plan: { ...row.plan }, contract: { ...row.contract } }
          : row,
      );
      const entry = entries.find((row) => row.plan.id === f.plan.singletonBindingId)!;
      if (kind === "bindingIntent") Object.assign(entry.plan, { structuralReferenceKey: "foreign" });
      if (kind === "supportType") Object.assign(entry.contract, { type: { kind: "val", val: { kind: "f64" } } });
      if (kind === "alias")
        entries.push({
          ...entry,
          plan: { ...entry.plan, id: "foreign-alias", slotPolicy: "alias", aliasOf: f.plan.singletonBindingId },
        } as typeof entry);
      if (kind === "export")
        entries.push({
          ...entry,
          plan: { ...entry.plan, id: "foreign-export" },
          contract: { kind: "export", externalName: "leaked", targetId: f.plan.singletonBindingId },
        } as typeof entry);
      const program = { ...f.program, abi: { ...f.program.abi, entries } };
      if (kind === "startup")
        Object.assign(program, {
          startup: f.program.startup.map((row, i) =>
            i === 0
              ? {
                  ...row,
                  bindings: [
                    ...row.bindings,
                    {
                      globalBindingId: f.plan.singletonBindingId,
                      tdzBindingId: null,
                      names: ["leaked"],
                      start: 0,
                      end: 0,
                    },
                  ],
                }
              : row,
          ),
        });
      expect(() => completedNativeNumberUndefinedPresentation(program, f.emission, f.backend)).toThrow();
      return;
    }
    if (kind === "physicalExport")
      f.emission.module.exports.push({
        name: "leaked",
        desc: { kind: "global", index: emittedProgramBindingIndex(f.emission, f.plan.singletonBindingId)!.index },
      });
    if (kind === "staleAfterFirstProof") {
      expect(completedNativeNumberUndefinedPresentation(f.program, f.emission, f.backend)).toBeDefined();
      f.global.init[0] = { op: "i32.const", value: 2 };
    }
    expect(() => completedNativeNumberUndefinedPresentation(f.program, f.emission, f.backend)).toThrow();
  },
  120000,
);
it.each(["dataCopy", "dataByte", "dataOffset", "dataGetter", "pointerInit", "unrelatedRef"])(
  "refuses actual Linear completed artifact %s",
  async (kind) => {
    await yieldTurn();
    const f = fixture(policies[0]);
    const data = f.emission.module.dataSegments[0]!;
    if (kind === "dataCopy") f.emission.module.dataSegments[0] = { ...data, bytes: new Uint8Array(data.bytes) };
    if (kind === "dataByte") data.bytes[0] = 3;
    if (kind === "dataOffset") data.offset += 8;
    if (kind === "pointerInit") f.global.init = [{ op: "i32.const", value: 0 }];
    if (kind === "unrelatedRef") f.global.type = { kind: "ref", typeIdx: 0 };
    if (kind === "dataGetter") {
      let reads = 0;
      Object.defineProperty(data, "bytes", {
        get() {
          reads++;
          throw Error("getter executed");
        },
        enumerable: true,
      });
      expect(() => completedNativeNumberUndefinedPresentation(f.program, f.emission, f.backend)).toThrow();
      expect(reads).toBe(0);
      return;
    }
    expect(() => completedNativeNumberUndefinedPresentation(f.program, f.emission, f.backend)).toThrow();
  },
  120000,
);

it.each(["memories", "tags", "tables", "startFuncIdx", "canonicalRuntimeRecGroup"])(
  "screens completed module %s getter before opaque replay",
  async (key) => {
    await yieldTurn();
    const f = fixture();
    let reads = 0;
    Object.defineProperty(f.emission.module, key, {
      configurable: true,
      enumerable: true,
      get() {
        reads++;
        throw Error("getter executed");
      },
    });
    expect(() => completedNativeNumberUndefinedPresentation(f.program, f.emission, f.backend)).toThrow();
    expect(reads).toBe(0);
  },
);

it.each(["shadow", "getter", "fakePrototype"])("rejects byte-buffer %s without effects", async (kind) => {
  await yieldTurn();
  const f = fixture(policies[0]);
  const bytes = f.emission.module.dataSegments[0]!.bytes;
  let reads = 0;
  if (kind === "shadow") Object.defineProperty(bytes, "shadow", { value: 1 });
  if (kind === "getter")
    Object.defineProperty(bytes, "shadow", {
      get() {
        reads++;
        return 1;
      },
    });
  if (kind === "fakePrototype") Object.setPrototypeOf(bytes, Object.create(Uint8Array.prototype));
  expect(() => completedNativeNumberUndefinedPresentation(f.program, f.emission, f.backend)).toThrow();
  expect(reads).toBe(0);
});

it("keeps primitive native-off standalone and WASI artifacts outside singleton admission", () => {
  const ast = analyzeMultiSource({ "./entry.ts": "export function run(x:number):number{return x*2;}" }, "./entry.ts");
  const result = prepareWholeIrProgram({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: policies[0],
    runtimePolicies: policies,
    deferTopLevelInit: false,
  });
  expect(result.kind).toBe("prepared");
  if (result.kind !== "prepared") throw Error(JSON.stringify(result));
  for (const policy of policies) {
    const backend: PreparedIrBackendOptions = {
      ...policy,
      moduleName: "primitive-control",
      sharedExceptionTag: false,
      utf8Storage: false,
      sourceMap: false,
    };
    const accepted = acceptPreparedIrProgram(result.program, backend);
    expect(accepted.kind).toBe("accepted");
    if (accepted.kind !== "accepted") throw Error(JSON.stringify(accepted));
    const emission = emitAcceptedIrProgram(accepted);
    expect(completedNativeNumberUndefinedPresentation(result.program, emission, backend)).toBeUndefined();
  }
}, 120000);

it("preserves actual primitive public numeric compilation on all four profiles", async () => {
  for (const policy of policies) {
    await yieldTurn();
    const result = await compile("export function run(x:number):number{return x*2;}", {
      ...policy,
      optimize: false,
      sourceMap: false,
    });
    expect(result.success).toBe(true);
  }
}, 120000);

it("executes native singleton public false-mode on all four profiles without legacy generators", async () => {
  const gc = vi.spyOn(directGc, "generateModule").mockImplementation(() => {
    throw Error("legacy GC forbidden");
  });
  const linear = vi.spyOn(directLinear, "generateLinearModule").mockImplementation(() => {
    throw Error("legacy Linear forbidden");
  });
  try {
    for (const policy of policies) {
      await yieldTurn();
      const result = await compile(
        "export function run(x:number,i:number):number{const a=[x];const v=a[i];return v===undefined?1:0;}",
        {
          ...policy,
          optimize: false,
          sourceMap: false,
        },
      );
      expect(result.success, JSON.stringify(result.errors)).toBe(true);
      if (!result.success) throw Error(JSON.stringify(result.errors));
      const binary = Uint8Array.from(result.binary);
      expect(WebAssembly.validate(binary)).toBe(true);
      const module = new WebAssembly.Module(binary);
      expect(WebAssembly.Module.imports(module)).toEqual([]);
      const instance = new WebAssembly.Instance(module, {});
      if (instance.exports._start) Reflect.apply(instance.exports._start as Function, undefined, []);
      for (const [x, i] of [
        [2, 0],
        [NaN, 0],
        [2, 99],
        [NaN, 99],
        [2, -1],
        [2, 0.5],
        [2, NaN],
        [-0, 0],
      ]) {
        const js = [x][i] === undefined ? 1 : 0;
        expect(Object.is(Reflect.apply(instance.exports.run as Function, undefined, [x, i]), js)).toBe(true);
      }
    }
    expect(gc).not.toHaveBeenCalled();
    expect(linear).not.toHaveBeenCalled();
  } finally {
    gc.mockRestore();
    linear.mockRestore();
  }
}, 120000);
