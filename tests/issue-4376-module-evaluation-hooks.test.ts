// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { generateMultiModule } from "../src/codegen/index.js";
import { widenNonDefaultableTypes } from "../src/compiler/output.js";
import { emitBinary } from "../src/emit/binary.js";
import "../src/codegen/expressions.js";

it("completes legacy modules only after all source statements execute", () => {
  const ast = analyzeMultiSource(
    {
      "dep.ts": "let left:number=1; left=left+2; export {left};",
      "entry.ts": "import './dep'; let right:number=0; right=right+3; export {right};",
    },
    "entry.ts",
  );
  const sources = Object.fromEntries(
    ast.sourceFiles.map((source) => [source.fileName, source === ast.entryFile ? "entry" : "dependency"]),
  );
  const result = generateMultiModule(ast, {
    target: "standalone",
    experimentalIR: false,
    nativeStrings: true,
    deferTopLevelInit: true,
    standaloneGlobalThisImport: { module: "context", name: "realm" },
    standaloneModuleNamespaceImports: { module: "modules", sources, evaluationHooks: true },
    link: ["context", "modules"],
  });
  expect(result.errors.filter((error) => error.severity !== "warning")).toEqual([]);
  const module = structuredClone(result.module);
  widenNonDefaultableTypes(module);
  const importedGlobals = module.imports.filter((entry) => entry.desc.kind === "global").length;
  const counters = module.globals.flatMap((global, index) => {
    if (!global.name?.startsWith("__mod_") || global.type.kind !== "f64") return [];
    const name = `counter_${index}`;
    module.exports.push({ name, desc: { kind: "global", index: importedGlobals + index } });
    return [name];
  });
  expect(counters).toHaveLength(2);
  const wasm = new WebAssembly.Module(emitBinary(module));
  const completed = new Set<string>();
  const events: string[] = [];
  const values = () => counters.map((name) => (instance.exports[name] as WebAssembly.Global).value);
  const instance = new WebAssembly.Instance(wasm, {
    context: { realm: () => null },
    modules: Object.fromEntries(
      ["dependency", "entry"].flatMap((name) => [
        [name, () => (completed.has(name) ? {} : null)],
        [`${name}_enter`, () => events.push(`${name}_enter`)],
        [
          `${name}_complete`,
          () => {
            events.push(`${name}_complete`);
            if (name === "dependency") expect(values().sort()).toEqual([0, 3]);
            else expect(values()).toEqual([3, 3]);
            completed.add(name);
          },
        ],
      ]),
    ),
  });
  (instance.exports.__module_init as () => void)();
  expect(completed.size).toBe(2);
  expect(events.filter((event) => event === "dependency_complete")).toHaveLength(1);
  expect(events.filter((event) => event === "entry_complete")).toHaveLength(1);
  expect(events.filter((event) => event === "dependency_enter").length).toBeGreaterThan(0);
  expect(events.indexOf("dependency_complete")).toBeLessThan(events.indexOf("entry_enter"));
  expect(values()).toEqual([3, 3]);
  const original = new Error("enter rejected before initialization");
  const failing = new WebAssembly.Instance(wasm, {
    context: { realm: () => null },
    modules: {
      dependency: () => null,
      entry: () => null,
      dependency_enter: () => {
        throw original;
      },
      dependency_complete: () => {
        throw new Error("completion must not run");
      },
      entry_enter: () => {
        throw new Error("entry must not run");
      },
      entry_complete: () => {
        throw new Error("entry must not complete");
      },
    },
  });
  let thrown: unknown;
  try {
    (failing.exports.__module_init as () => void)();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBe(original);
});
