import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { compile } from "../src/index.js";

it.each([false, true])("keeps mixed reverse-map results (numeric first: %s)", async (numericFirst) => {
  const initializers = [
    'const names = makeReverseMap(new Map<string, number>([["break", 1], ["return", 2]]));',
    "const codes = makeReverseMap(new Map<number, number>([[100, 1], [103, 2]]));",
  ];
  if (numericFirst) initializers.reverse();
  const result = await compile(
    `
    function makeReverseMap<T>(source: Map<T, number>): T[] {
      const result: T[] = [];
      source.forEach((value, name) => { result[value] = name; });
      return result;
    }
    ${initializers.join("\n")}
    function same<T>(value: T[]): T[] { return value; }
    export function run(): number {
      const original = [1, 2];
      if (same(original) !== original) return -2;
      return names[1] === "break" && names[2] === "return" && codes[1] === 100 && codes[2] === 103 ? 1 : -1;
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
    const module = new WebAssembly.Module(readFileSync(0));
    if (WebAssembly.Module.imports(module).length) throw new Error("Unexpected imports");
    const instance = await WebAssembly.instantiate(module, {});
    console.log(instance.exports.run());
  `,
    ],
    { input: result.binary, encoding: "utf8", timeout: 10000 },
  );
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout.trim()).toBe("1");
});
