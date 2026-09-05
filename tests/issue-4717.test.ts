import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, target: "gc" | "standalone" = "gc"): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-4717.ts",
    skipSemanticDiagnostics: true,
    target,
  });
  if (!result.success) {
    throw new Error(result.errors.map((error) => error.message).join("\n"));
  }
  if (!WebAssembly.validate(result.binary)) throw new Error("invalid Wasm");

  const runtime = buildImports(result.imports as any, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, runtime as any);
  runtime.setInstance?.(instance);
  return (instance.exports.test as () => number)();
}

describe("#4717 nested array assignment undefined propagation", () => {
  for (const target of ["gc", "standalone"] as const) {
    describe(target, () => {
      it("uses undefined for a missing nested rest element after null", async () => {
        expect(
          await run(
            `export function test(): number {
              let x: any, y: any;
              const vals: any[] = [null];
              [...[x, y]] = vals;
              return x === null && y === undefined ? 1 : 0;
            }`,
            target,
          ),
        ).toBe(1);
      });

      it("uses undefined for an empty nested rest", async () => {
        expect(
          await run(
            `export function test(): number {
              let x: any = null;
              const vals: any[] = [];
              [...[x]] = vals;
              return x === undefined ? 1 : 0;
            }`,
            target,
          ),
        ).toBe(1);
      });

      it("throws when a nested array reads a missing object property", async () => {
        expect(
          await run(
            `export function test(): number {
              let x: any;
              try {
                ({ x: [x] } = {});
                return 0;
              } catch (_error) {
                return 1;
              }
            }`,
            target,
          ),
        ).toBe(1);
      });

      it("keeps present and hole controls working", async () => {
        expect(
          await run(
            `export function test(): number {
              let x: any = null;
              let vals: any[] = [ , ];
              [...[x]] = vals;
              return x === undefined ? 1 : 0;
            }`,
            target,
          ),
        ).toBe(1);
      });
    });
  }
});
