import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

describe("function values preserve promoted mutable captures", () => {
  for (const target of [undefined, "standalone"] as const) {
    for (const promoted of [false, true]) {
      it(`${target ?? "JS host"}: ${promoted ? "method-promoted" : "local"} shared cell`, async () => {
        const result = await compile(
          `
          export function test(): number {
            var value = 0;
            function increment() { value += 1; }
            ${promoted ? "const object = { update(n: number) { value += n; } };" : ""}
            const callback: any = increment;
            callback();
            ${promoted ? "object.update(10);" : "value += 10;"}
            callback();
            return value;
          }
        `,
          { target, fileName: "promoted.ts", skipSemanticDiagnostics: true },
        );
        expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
        await expect(WebAssembly.compile(result.binary)).resolves.toBeDefined();
        const imports = buildImports(result.imports, {}, result.stringPool);
        const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
        (imports as { setExports?: (exports: object) => void }).setExports?.(instance.exports);
        expect((instance.exports.test as () => number)()).toBe(12);
      });
    }
  }
});
