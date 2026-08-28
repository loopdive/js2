// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function instantiate(source: string): Promise<WebAssembly.Exports> {
  const result = await compile(source, {
    target: "standalone",
    fileName: "reflected-symbol-promise-statics.ts",
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, result.success ? "" : result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary!);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports;
}

describe("reflected Symbol and Promise constructor statics", () => {
  it("invokes Symbol.for and Symbol.keyFor after computed carrier reads", async () => {
    const exports = await instantiate(`
      const realm: any = globalThis;
      const ctor: any = realm["Symbol"];
      const symbolFor: any = ctor["for"];
      const symbolKeyFor: any = ctor["keyFor"];
      export function test(): number {
        const first: any = symbolFor("deno.reflected.symbol");
        const second: any = symbolFor("deno.reflected.symbol");
        return first === second && symbolKeyFor(first) === "deno.reflected.symbol" ? 42 : 0;
      }
    `);
    expect((exports.test as () => number)()).toBe(42);
  });

  it("invokes Promise.resolve and Promise.reject after computed carrier reads", async () => {
    const exports = await instantiate(`
      declare function __drain_microtasks(): void;
      const realm: any = globalThis;
      const ctor: any = realm["Promise"];
      const resolve: any = ctor["resolve"];
      const reject: any = ctor["reject"];
      let score = 0;
      export function test(): number {
        const fulfilled: any = resolve(40);
        const rejected: any = reject(2);
        fulfilled.then((value: number) => { score += value; });
        rejected.catch((reason: number) => { score += reason; });
        __drain_microtasks();
        return score;
      }
    `);
    expect((exports.test as () => number)()).toBe(42);
  });
});
