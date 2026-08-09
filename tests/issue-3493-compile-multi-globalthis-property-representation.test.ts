import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";

async function compileStandalone(files: Record<string, string>, entry = "./entry.js") {
  const result = await compileMulti(files, entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports).toEqual([]);
  return result;
}

describe("#3493 — compileMulti top-level globalThis assignments", () => {
  it("reads an array property written by another module without an illegal cast", async () => {
    const result = await compileStandalone({
      "./setup.js": `globalThis.sharedValues = [];`,
      "./entry.js": `
        import "./setup.js";
        globalThis.sharedValues.push(7);
        export function test() { return globalThis.sharedValues.length; }
      `,
    });

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports as Record<string, () => number>).test()).toBe(1);
  });
});
