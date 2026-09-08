import { expect, it } from "vitest";
import { compile } from "../src/index.js";

it.each([undefined, "deno"] as const)("preserves sparse mixed-array values and presence on %s", async (platform) => {
  const result = await compile(
    `
    const values: any = [1, true, null];
    function write(owner: any, key: any, value: any): void { owner[key] = value; }
    function read(owner: any, key: any): any { return owner[key]; }
    export function probe(): number {
      write(values, "4", 9);
      if (read(values, "2") !== null) return -1;
      if (read(values, "4") !== 9) return -2;
      if (read(values, "3") !== undefined) return 0;
      if ("3" in values || Object.prototype.hasOwnProperty.call(values, "3")) return -3;
      if (Object.keys(values).join(",") !== "0,1,2,4") return -4;
      (Array.prototype as any)[3] = 17;
      if (read(values, "3") !== 17) return -5;
      if (!("3" in values)) return -6;
      if (Object.prototype.hasOwnProperty.call(values, "3")) return -7;
      if (Object.keys(values).join(",") !== "0,1,2,4") return -8;
      return 1;
    }
  `,
    { target: "standalone", platform, hostBridge: "always" },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  expect((instance.exports.probe as () => number)()).toBe(1);
});
