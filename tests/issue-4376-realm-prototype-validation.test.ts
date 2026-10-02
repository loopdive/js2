import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

describe("realm bridge prototype validation", () => {
  it("validates dynamic operands before changing the prototype", async () => {
    const result = await compile(
      `
      const values:any[] = [undefined, null, 1, true, "text", {}, function(){}];
      export function run():number {
        const object:any = {};
        let rejected = 0;
        for (const index of [0, 2, 3, 4]) {
          try { Reflect.setPrototypeOf(object, values[index]); }
          catch (error) { if (error instanceof TypeError) rejected++; }
        }
        for (const index of [0, 1, 2, 3, 4]) {
          try { Reflect.setPrototypeOf(values[index], null); }
          catch (error) { if (error instanceof TypeError) rejected++; }
        }
        if (!Reflect.setPrototypeOf(object, values[5])) return -1;
        if (!Reflect.setPrototypeOf(object, values[6])) return -2;
        if (!Reflect.setPrototypeOf(object, null)) return -3;
        return rejected;
      }
    `,
      { target: "standalone", deferTopLevelInit: true, skipSemanticDiagnostics: true },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = result.importObject ?? {};
    const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), imports);
    (imports as { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance?.(instance);
    (instance.exports.__module_init as () => void)();
    expect((instance.exports.run as () => number)()).toBe(9);
  });
});
