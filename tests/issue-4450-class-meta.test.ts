import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const SOURCE = `
  function sameNames(actual: string[], expected: string[]): boolean {
    if (actual.length !== expected.length) return false;
    for (let i = 0; i < expected.length; i++) {
      if (actual[i] !== expected[i]) return false;
    }
    return true;
  }

  class Name {
    static method() { throw 1; }
    static name() { throw 1; }
  }
  class Length {
    static method() { throw 1; }
    static length() { throw 1; }
  }
  var nameKey = "name";
  class ComputedName {
    static [nameKey]() { throw 1; }
  }
  var lengthKey = "length";
  class ComputedLength {
    static [lengthKey]() { throw 1; }
  }
  let getterReady = false;
  class Getter {
    static get name() {
      if (getterReady) return "pass";
      throw 1;
    }
  }
  class Setter {
    static set name(_: unknown) { throw 1; }
  }
  class Generator {
    static *name() { throw 1; }
  }

  getterReady = true;
  export function test(): number {
    let ok = 1;
    ok = ok && (typeof Name.name === "function") ? 1 : 0;
    ok = ok && (typeof Length.length === "function") ? 1 : 0;
    ok = ok && (typeof ComputedName.name === "function") ? 1 : 0;
    ok = ok && (typeof ComputedLength.length === "function") ? 1 : 0;
    ok = ok && (Getter.name === "pass") ? 1 : 0;
    ok = ok && (Setter.name === undefined) ? 1 : 0;
    ok = ok && (typeof Generator.name === "function") ? 1 : 0;
    ok = ok && sameNames(Object.getOwnPropertyNames(Name), ["length", "name", "prototype", "method"]) ? 1 : 0;
    ok = ok && sameNames(Object.getOwnPropertyNames(Length), ["length", "name", "prototype", "method"]) ? 1 : 0;
    ok = ok && sameNames(Object.getOwnPropertyNames(ComputedName), ["length", "name", "prototype"]) ? 1 : 0;
    ok = ok && sameNames(Object.getOwnPropertyNames(ComputedLength), ["length", "name", "prototype"]) ? 1 : 0;
    ok = ok && sameNames(Object.getOwnPropertyNames(Getter), ["length", "name", "prototype"]) ? 1 : 0;
    ok = ok && sameNames(Object.getOwnPropertyNames(Setter), ["length", "name", "prototype"]) ? 1 : 0;
    ok = ok && sameNames(Object.getOwnPropertyNames(Generator), ["length", "name", "prototype"]) ? 1 : 0;
    return ok;
  }
`;

async function run(source: string, target?: "standalone"): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-4450-class-meta.ts",
    ...(target ? { target } : {}),
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  if (target === "standalone") {
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    return (instance.exports as Record<string, () => number>).test();
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), imports);
  imports.setInstance?.(instance);
  return (instance.exports as Record<string, () => number>).test();
}

describe("#4450 class static name/length metadata", () => {
  it("preserves ES class own-key precedence on the host lane", async () => {
    expect(await run(SOURCE)).toBe(1);
  });

  it("preserves ES class own-key precedence in standalone", async () => {
    expect(await run(SOURCE, "standalone")).toBe(1);
  });
});
