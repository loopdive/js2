import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

type Target = "gc" | "standalone";

async function run(source: string, target: Target): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-4370.ts",
    platform: "node",
    skipSemanticDiagnostics: true,
    target,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);

  let instance: WebAssembly.Instance;
  if (target === "standalone") {
    expect(result.imports).toEqual([]);
    instance = await WebAssembly.instantiate(module, {});
  } else {
    const imports = buildImports(result.imports, undefined, result.stringPool);
    instance = await WebAssembly.instantiate(module, imports);
    imports.setInstance?.(instance);
  }
  return (instance.exports.runCase as () => number)();
}

describe.each<Target>(["gc", "standalone"])("#4370 Object.keys(any).map [%s]", (target) => {
  it("materializes the dynamic Object.keys result and preserves mapped values", async () => {
    const actual = await run(
      `
        export function runCase() {
          const method = "GET";
          const routes: any = { GET: { a: 3, bb: 4 } };
          const mapped = Object.keys(routes[method]).map(
            (path) => path.length * 10 + routes[method][path]
          );
          return mapped[0] * 100 + mapped[1];
        }
      `,
      target,
    );
    const routes = { GET: { a: 3, bb: 4 } };
    const method = "GET";
    const mapped = Object.keys(routes[method]).map((path) => path.length * 10 + routes[method][path]);
    expect(actual).toBe(mapped[0]! * 100 + mapped[1]!);
  });

  it("covers Hono's mapped path/value tuple shape", async () => {
    const actual = await run(
      `
        export function runCase() {
          const method = "GET";
          const routes: any = { GET: { alpha: 7, b: 9 } };
          const ownRoute = routes[method]
            ? Object.keys(routes[method]).map((path) => [path, routes[method][path]])
            : [];
          return ownRoute.length * 100 + ownRoute[0][0].length * 10 + ownRoute[1][1];
        }
      `,
      target,
    );
    const routes = { GET: { alpha: 7, b: 9 } };
    const method = "GET";
    const ownRoute = Object.keys(routes[method]).map((path) => [path, routes[method][path]] as const);
    expect(actual).toBe(ownRoute.length * 100 + ownRoute[0]![0].length * 10 + ownRoute[1]![1]);
  });

  it("keeps native typed-array map behavior unchanged", async () => {
    expect(
      await run(
        `
          export function runCase() {
            const mapped = [1, 2, 3].map((value) => value * 4);
            return mapped[0] * 100 + mapped[1] * 10 + mapped[2];
          }
        `,
        target,
      ),
    ).toBe(492);
  });
});
