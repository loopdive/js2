// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function instantiate(source: string, script = false): Promise<WebAssembly.Instance> {
  const result = await compile(source, {
    fileName: "probe.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
    inferModuleStrictArguments: false,
    runtimeEvalProvider: false,
    deferTopLevelInit: script,
  } as never);
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const mod = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(mod)).toEqual([]);
  return new WebAssembly.Instance(mod, {});
}

describe("#6976 reference-slot binding guards (standalone)", () => {
  it("numeric default parameter receives an actual object without a body assignment", async () => {
    const { exports } = await instantiate(`
      function mask(a) { var m=0; for(var i=0;i<a.length;i++) if(a[i]) m+=1<<i; return m; }
      function B() { this.f={x:1}; } var arr=[new B()];
      function k(e=0) { return mask([typeof e === "object", typeof e.f === "object", e.f.x === 1]); }
      export function main() { return k(arr[0]); }
    `);
    expect((exports as { main: () => unknown }).main()).toBe(7);
  });

  it("a primitive script binding with an uninitialized redeclaration keeps its value and absent property", async () => {
    const { exports } = await instantiate(
      `
      var n=1; var n;
      if (typeof n !== "number") throw new Error("primitive value changed");
      if (typeof n.missing !== "undefined") throw new Error("absent property was not undefined");
    `,
      true,
    );
    expect(typeof exports.__module_init).toBe("function");
    (exports as { __module_init: () => void }).__module_init();
  });
  it("preserves a numeric arithmetic initializer in primitive script storage", async () => {
    const { exports } = await instantiate(
      `
      var n = 1 + 2;
      if (typeof n !== "number") throw new Error("arithmetic value changed");
      if (typeof n.missing !== "undefined") throw new Error("arithmetic absent property changed");
    `,
      true,
    );
    expect(typeof exports.__module_init).toBe("function");
    (exports as { __module_init: () => void }).__module_init();
  });

  it("preserves a boolean-expression initializer in primitive script storage", async () => {
    const { exports } = await instantiate(
      `
      var n = 1 < 2;
      if (typeof n !== "boolean") throw new Error("boolean value changed");
      if (typeof n.missing !== "undefined") throw new Error("boolean absent property changed");
    `,
      true,
    );
    expect(typeof exports.__module_init).toBe("function");
    (exports as { __module_init: () => void }).__module_init();
  });

  it("preserves a primitive-returning call initializer in script storage", async () => {
    const { exports } = await instantiate(
      `
      function makeNumber() { return 3; }
      var n = makeNumber();
      if (typeof n !== "number") throw new Error("call value changed");
      if (typeof n.missing !== "undefined") throw new Error("call absent property changed");
    `,
      true,
    );
    expect(typeof exports.__module_init).toBe("function");
    (exports as { __module_init: () => void }).__module_init();
  });
  it("preserves multiple initialized primitive declarations of one script var", async () => {
    const { exports } = await instantiate(
      `
      var n = 1; var n = 2;
      if (n !== 2 || typeof n !== "number") throw new Error("redeclared primitive value changed");
      if (typeof n.missing !== "undefined") throw new Error("redeclared primitive property changed");
    `,
      true,
    );
    expect(typeof exports.__module_init).toBe("function");
    (exports as { __module_init: () => void }).__module_init();
  });
});
