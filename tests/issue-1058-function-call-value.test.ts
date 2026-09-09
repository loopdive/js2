import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { compile } from "../src/index.js";

it.each(["alias", "property", "ordinary"])("calls stored function (%s)", async (mode) => {
  const result = await compile(
    `
    const hasOwnProperty = ${mode === "ordinary" ? "function(this: any, key: string): boolean { return this[key] !== undefined; }" : "Object.prototype.hasOwnProperty"};
    const holder = { hasOwnProperty };
    const callValue: any = Function.prototype.call;
    function hasProperty<T>(map: T, key: string): boolean {
      return ${mode === "ordinary" ? "callValue.call(hasOwnProperty, map, key)" : `${mode === "alias" ? "hasOwnProperty" : "holder.hasOwnProperty"}.call(map, key)`};
    }
    const present = hasProperty({ x: 1 }, "x");
    const absent = hasProperty({ x: 1 }, "y");
    function own(receiver: any, key: any): boolean { return hasOwnProperty.call(receiver, key); }
    export function run(): number {
      ${
        mode !== "ordinary"
          ? `
      if (!own("ab", "length") || !own("ab", 0) || own(3, "x")) return -5;
      for (const key of ["01", "-0", " 1", "+1", "1e0", "2", ""]) {
        if (own("ab", key)) return -9;
      }
      if (!own(new String("ab"), 1) || own(true, "x")) return -10;
      const symbol = Symbol("key");
      const object: any = { [symbol]: undefined };
      if (!own(object, symbol) || own("ab", symbol)) return -11;
      if (!own({ undefined: 1 }, undefined)) return -12;
      if (own(Object.create({ inherited: 1 }), "inherited")) return -6;
      let conversions = 0;
      const key: any = { toString() { conversions++; throw 17; } };
      let marker = 0;
      try { own(null, key); } catch (error) { marker = error as number; }
      if (marker !== 17 || conversions !== 1) return -7;
      let rejected = false;
      try { own(undefined, "x"); } catch (error) { rejected = error instanceof TypeError; }
      if (!rejected) return -8;
      `
          : ""
      }
      ${
        mode === "ordinary"
          ? `
      const target: any = function(this: any, a: number, b: number, c: number): number { return this.base + a + b + c; };
      if (callValue.call(target, { base: 10 }, 1, 2, 3) !== 16) return -2;
      const noArgs: any = function(this: any): boolean { "use strict"; return this === undefined; };
      if (callValue.call(noArgs) !== true) return -4;
      let caught = false;
      try { callValue.call(3); } catch (error) { caught = error instanceof TypeError; }
      if (!caught) return -3;
      `
          : ""
      }
      return present && !absent && typeof callValue === "function" ? 1 : -1;
    }
  `,
    { target: "standalone" },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const child = spawnSync(
    process.execPath,
    [
      "--experimental-wasm-exnref",
      "--input-type=module",
      "-e",
      `
    import { readFileSync } from "node:fs";
    import { setFlagsFromString } from "node:v8";
    const module = new WebAssembly.Module(readFileSync(0));
    if (WebAssembly.Module.imports(module).length) throw new Error("Unexpected imports");
    if (process.env.JS2WASM_TEST_TRACE) setFlagsFromString("--trace-wasm");
    const instance = await WebAssembly.instantiate(module, {});
    console.log(instance.exports.run());
  `,
    ],
    { input: result.binary, encoding: "utf8", timeout: 10000 },
  );
  expect(child.status, child.stderr + child.stdout.slice(-6000)).toBe(0);
  expect(child.stdout.trim()).toBe("1");
});
