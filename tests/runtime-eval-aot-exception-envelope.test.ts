// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

describe("runtime-eval AOT callable exception envelope", () => {
  it("rethrows an AOT-owned payload through the receiving module tag", { timeout: 120_000 }, async () => {
    const result = await compile(
      `
        const thrown: any = {};
        function aotThrow(): never { throw thrown; }
        function aotValue(): number { return 42; }
        globalThis.aotThrow = aotThrow;
        globalThis.aotValue = aotValue;

        // Statically enable the runtime-eval callable boundary. The probe does
        // not execute this import; its only purpose is to exercise the exact
        // carrier shape used by a separately instantiated provider.
        export function unusedEval(source: any): any {
          return (0, eval)(source);
        }

        export function probeThrow(): number {
          try {
            globalThis.aotThrow();
            return 0;
          } catch (error) {
            return error === thrown ? 1 : 2;
          }
        }

        export function probeValue(): number {
          return globalThis.aotValue() === 42 ? 1 : 2;
        }
      `,
      {
        fileName: "runtime-eval-aot-exception-envelope.ts",
        skipSemanticDiagnostics: true,
        target: "standalone",
        emitWat: false,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const module = new WebAssembly.Module(result.binary);
    const imports: WebAssembly.Imports = {};
    for (const entry of WebAssembly.Module.imports(module)) {
      const namespace = (imports[entry.module] ??= {}) as Record<string, unknown>;
      namespace[entry.name] = () => null;
    }
    const instance = new WebAssembly.Instance(module, imports);

    expect((instance.exports.probeValue as () => number)()).toBe(1);
    expect((instance.exports.probeThrow as () => number)()).toBe(1);
  });
});
