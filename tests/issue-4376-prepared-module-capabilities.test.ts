// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, expect, it, vi } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { generateMultiModule } from "../src/codegen/index.js";
import { widenNonDefaultableTypes } from "../src/compiler/output.js";
import { emitBinary } from "../src/emit/binary.js";
import "../src/codegen/expressions.js";

afterEach(() => vi.unstubAllEnvs());

it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])("guards each prepared initializer (batch=%s, deferred=%s)", (batch, deferred) => {
  vi.stubEnv("JS2WASM_MULTI_PREPARED_MODULE_INIT_CUTOVER", "1");
  vi.stubEnv("JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY", "1");
  const ast = analyzeMultiSource(
    {
      "./dep.ts": "let left:number=0; left=left+2; export {left};",
      "./entry.ts": batch
        ? "import './dep'; let right:number=0; right=right+3; export {right};"
        : "import './dep'; export interface Marker {value:number;}",
    },
    "./entry.ts",
  );
  const sources = Object.fromEntries(
    ast.sourceFiles.map((source) => [source.fileName, source === ast.entryFile ? "entry" : "dependency"]),
  );
  const options = {
    target: "standalone" as const,
    experimentalIR: true,
    nativeStrings: true,
    trackIrOutcomes: true,
    deferTopLevelInit: deferred,
    standaloneGlobalThisImport: { module: "context", name: "realm" },
    standaloneModuleNamespaceImports: { module: "modules", sources },
    link: ["context", "modules"],
  };
  const generated = generateMultiModule(ast, options);
  expect(generated.errors.filter((error) => error.severity !== "warning")).toEqual([]);
  expect(generated.multiPreparedProgramAudit?.moduleInit).toMatchObject({
    executablePlanCount: batch ? 2 : 1,
    directCompileModuleInitBodyRoots: 0,
    irBodyEmissions: batch ? 2 : 1,
    invocationKind: deferred ? "deferred-export" : "wasm-start",
  });
  const module = structuredClone(generated.module);
  widenNonDefaultableTypes(module);
  const importedGlobals = module.imports.filter((entry) => entry.desc.kind === "global").length;
  const counters = module.globals.flatMap((global, index) => {
    if (!global.name?.startsWith("__mod_") || global.type.kind !== "f64") return [];
    const name = `test_counter_${index}`;
    module.exports.push({ name, desc: { kind: "global", index: importedGlobals + index } });
    return [name];
  });
  expect(counters).toHaveLength(batch ? 2 : 1);
  const wasm = new WebAssembly.Module(emitBinary(module));
  expect(WebAssembly.Module.imports(wasm).filter((entry) => entry.module === "modules")).toHaveLength(batch ? 2 : 1);
  for (const evaluated of [false, true]) {
    const observed: string[] = [];
    const instance = new WebAssembly.Instance(wasm, {
      modules: {
        dependency: () => {
          observed.push("dependency");
          return evaluated ? {} : null;
        },
        entry: () => {
          observed.push("entry");
          return null;
        },
      },
      context: { realm: () => null },
    });
    const values = () => counters.map((name) => (instance.exports[name] as WebAssembly.Global).value).sort();
    if (deferred) {
      expect(values()).toEqual(batch ? [0, 0] : [0]);
      (instance.exports.__module_init as () => void)();
    }
    expect(observed).toEqual(batch ? ["dependency", "entry"] : ["dependency"]);
    expect(values()).toEqual(batch ? [evaluated ? 0 : 2, 3] : [evaluated ? 0 : 2]);
  }
  if (deferred) {
    const failure = new Error("native dependency evaluation failed");
    const instance = new WebAssembly.Instance(wasm, {
      modules: {
        dependency: () => {
          throw failure;
        },
        entry: () => null,
      },
      context: { realm: () => null },
    });
    let thrown: unknown;
    try {
      (instance.exports.__module_init as () => void)();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(failure);
    expect(counters.map((name) => (instance.exports[name] as WebAssembly.Global).value)).toEqual(batch ? [0, 0] : [0]);
  }
  const plain = generateMultiModule(ast, { ...options, standaloneModuleNamespaceImports: undefined });
  const empty = generateMultiModule(ast, {
    ...options,
    standaloneModuleNamespaceImports: { module: "unused", sources: {} },
  });
  for (const result of [plain, empty])
    expect(result.errors.filter((error) => error.severity !== "warning")).toEqual([]);
  const binary = (result: typeof plain) => {
    const owned = structuredClone(result.module);
    widenNonDefaultableTypes(owned);
    return emitBinary(owned);
  };
  expect(binary(empty)).toEqual(binary(plain));
});
