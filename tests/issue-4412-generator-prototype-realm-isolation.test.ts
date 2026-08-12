// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";

async function createGenerator(): Promise<object> {
  const result = await compile("export function make(): any { return function*() {}(); }");
  if (!result.success) throw new Error(result.errors.map((error) => error.message).join("\n"));

  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports.make as () => object)();
}

function generatorPrototype(generator: object): object {
  return Object.getPrototypeOf(Object.getPrototypeOf(generator));
}

describe("#4412 — generator prototype realm isolation", () => {
  it("does not leak a deleted generator tag into the next harness realm", async () => {
    const sloppyPrototype = generatorPrototype(await createGenerator());
    expect(Reflect.get(sloppyPrototype, Symbol.toStringTag)).toBe("Generator");

    expect(Reflect.deleteProperty(sloppyPrototype, Symbol.toStringTag)).toBe(true);
    expect(Reflect.get(sloppyPrototype, Symbol.toStringTag)).toBe("Iterator");

    restoreHostBuiltins();

    const strictPrototype = generatorPrototype(await createGenerator());
    expect(strictPrototype).not.toBe(sloppyPrototype);
    expect(Reflect.get(strictPrototype, Symbol.toStringTag)).toBe("Generator");
  });
});
