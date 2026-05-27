import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports, instantiateWasm } from "../src/runtime.ts";

async function run(src: string): Promise<any> {
  const result = compile(src, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error("Compile error: " + result.errors.map((e) => e.message).join("; "));
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(
    result.binary,
    imports.env,
    imports["wasm:js-string"],
    imports.string_constants,
  );
  if (imports.setExports) imports.setExports(instance.exports as Record<string, Function>);
  return (instance.exports as any).test();
}

describe("#1613 for-in head with binding pattern", () => {
  it("destructures the key string via an array binding pattern", async () => {
    // key 'hi' -> [first] binds first = 'h'
    const r = await run(`
      export function test(): string {
        let c = '';
        for (let [first] in { hi: 1 }) { c = first; }
        return c;
      }
    `);
    expect(r).toBe("h");
  });

  it("duplicate binding names take the last enumerated character", async () => {
    // key 'ab' -> [x, x] binds x = 'a' then x = 'b'
    const r = await run(`
      export function test(): string {
        let last = '';
        for (var [x, x] in { ab: 1 }) { last = x; }
        return last;
      }
    `);
    expect(r).toBe("b");
  });
});
