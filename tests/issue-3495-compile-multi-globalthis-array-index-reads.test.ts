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
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return instance.exports as Record<string, () => number>;
}

describe("#3495 — standalone indexed reads of cross-module compiler vecs", () => {
  it("preserves exact string values stored through a globalThis array", async () => {
    const exports = await compileStandalone({
      "./setup.js": `globalThis.sharedValues = [];`,
      "./writer.js": `
        import "./setup.js";
        globalThis.sharedValues.push("alpha", "beta");
      `,
      "./entry.js": `
        import "./writer.js";
        export function score() {
          return (globalThis.sharedValues.length === 2 ? 1 : 0)
            + (globalThis.sharedValues[0] === "alpha" ? 2 : 0)
            + (globalThis.sharedValues[1] === "beta" ? 4 : 0);
        }
      `,
    });

    expect(exports.score()).toBe(7);
  });

  it("preserves the official async-cycle graph's exact five-string order", async () => {
    const exports = await compileStandalone({
      "./setup.js": `globalThis.logs = [];`,
      "./cycle-leaf.js": `
        import "./cycle-root.js";
        globalThis.logs.push("cycle leaf start");
        await 1;
        globalThis.logs.push("cycle leaf end");
      `,
      "./cycle-root.js": `
        import "./cycle-leaf.js";
        globalThis.logs.push("cycle root start");
        await 1;
        globalThis.logs.push("cycle root end");
      `,
      "./import-cycle-leaf.js": `
        import "./cycle-leaf.js";
        globalThis.logs.push("importer of cycle leaf");
      `,
      "./entry.js": `
        import "./setup.js";
        import "./cycle-root.js";
        import "./import-cycle-leaf.js";
        export function score() {
          return (globalThis.logs.length === 5 ? 1 : 0)
            + (globalThis.logs[0] === "cycle leaf start" ? 2 : 0)
            + (globalThis.logs[1] === "cycle leaf end" ? 4 : 0)
            + (globalThis.logs[2] === "cycle root start" ? 8 : 0)
            + (globalThis.logs[3] === "cycle root end" ? 16 : 0)
            + (globalThis.logs[4] === "importer of cycle leaf" ? 32 : 0);
        }
      `,
    });

    expect(exports.score()).toBe(63);
  });
});
