import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { compile } from "../src/index.js";

it.each(["() => number", "any"])("runs a stored Date.now (%s) during startup", async (type) => {
  const result = await compile(
    `const timestamp: ${type} = Date.now;
     const origin = timestamp();
     export function run(): number {
       return origin === 0 && timestamp() === Date.now() && timestamp === Date.now ? 1 : -1;
     }`,
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
