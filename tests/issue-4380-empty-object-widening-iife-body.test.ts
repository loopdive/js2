// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const entry = "/issue-4380/entry.ts";
  const result = await compileMulti(
    {
      [entry]:
        `import "./bootstrap.js";\n` +
        `export function probe(): number { return (globalThis as any).__issue4380Result; }\n`,
      "/issue-4380/bootstrap.js": `${source}\nglobalThis.__issue4380Result = result;\n`,
    },
    entry,
    {
      target: "standalone",
      allowJs: true,
      skipSemanticDiagnostics: true,
    },
  );
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { probe(): number }).probe();
}

describe("#4380 — empty-object widening inside IIFEs", () => {
  it.each([
    ["arrow", "(() => { BODY })();"],
    ["function expression", "(function () { BODY })();"],
  ])("preserves an object populated in a %s IIFE", async (_name, wrapper) => {
    const body = `
      const primordials = {};
      const {
        defineProperty: ReflectDefineProperty,
        getOwnPropertyDescriptor: ReflectGetOwnPropertyDescriptor,
        ownKeys: ReflectOwnKeys,
      } = Reflect;
      const { apply, bind, call } = Function.prototype;
      const uncurryThis = bind.bind(call);
      primordials.uncurryThis = uncurryThis;
      const applyBind = bind.bind(apply);
      primordials.applyBind = applyBind;
      globalThis.__issue4380Primordials = primordials;
      result = typeof primordials.uncurryThis === "function" &&
          typeof primordials.applyBind === "function" &&
          typeof globalThis.__issue4380Primordials.uncurryThis === "function" &&
          typeof ReflectDefineProperty === "function" &&
          typeof ReflectGetOwnPropertyDescriptor === "function" &&
          typeof ReflectOwnKeys === "function" ? 42 : 0;
      return;

      const {
        ArrayPrototypeForEach,
        ArrayPrototypeJoin,
        ArrayPrototypeMap,
        FunctionPrototypeCall,
        ObjectDefineProperty,
        ObjectFreeze,
        ObjectPrototypeIsPrototypeOf,
        ObjectSetPrototypeOf,
        Promise,
        PromisePrototype,
        PromisePrototypeThen,
        SymbolIterator,
        TypedArrayPrototypeJoin,
      } = primordials;
    `;

    await expect(
      runStandalone(`
        let result = 0;
        ${wrapper.replace("BODY", body)}
      `),
    ).resolves.toBe(42);
  });

  it("preserves the existing named-function path", async () => {
    await expect(
      runStandalone(`
        let result = 0;
        function makeResult() {
          const holder = {};
          holder.value = 41;
          holder["extra"] = 1;
          return holder.value + holder["extra"];
        }
        result = makeResult();
      `),
    ).resolves.toBe(42);
  });
});
