// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { buildImports, compile, wrapExports } from "../src/index.js";

const AMBIENT_SOURCE = `
interface PerformanceLike {
  now(): number;
  timeOrigin: number;
}

declare const performance: PerformanceLike | undefined;

function readPerformance() {
  if (false) {
    const { performance } = { performance: undefined as PerformanceLike | undefined };
    if (performance) return { performance };
  }

  if (typeof performance === "object") return { performance };
  return undefined;
}

const selectedPerformance = readPerformance();
const selectedTimeOrigin = selectedPerformance ? selectedPerformance.performance.timeOrigin : -1;

export function run(): number {
  return selectedTimeOrigin;
}
`;

async function instantiate(
  source: string,
  dependencies?: Record<string, unknown>,
  globalSandbox?: Record<string, unknown>,
) {
  const result = await compile(source, {
    fileName: "ambient-performance.ts",
    target: "gc",
    platform: "node",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = buildImports(result.imports, dependencies, result.stringPool, { globalSandbox });
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return { result, exports: wrapExports(instance, { signatures: result.exportSignatures }) };
}

describe("#1058 explicit ambient performance global", () => {
  it("resolves a supplied ambient object during top-level initialization despite a dead local collision", async () => {
    const { result, exports } = await instantiate(AMBIENT_SOURCE, undefined, {
      performance: { now: () => 1, timeOrigin: 42 },
    });

    expect(result.imports.some((entry) => entry.name === "global_performance")).toBe(false);
    expect(result.imports.some((entry) => entry.name === "__get_globalThis")).toBe(true);
    expect(exports.run()).toBe(42);
  });

  it("classifies an absent optional ambient from its runtime value", async () => {
    const { exports } = await instantiate(AMBIENT_SOURCE, undefined, {});

    expect(exports.run()).toBe(-1);
  });

  it("keeps a real lexical shadow ahead of the ambient host capability", async () => {
    const { exports } = await instantiate(
      `
        interface PerformanceLike { timeOrigin: number; }
        declare const performance: PerformanceLike | undefined;

        export function run(): number {
          const performance = { timeOrigin: 7 };
          return typeof performance === "object" ? performance.timeOrigin : -1;
        }
      `,
      undefined,
      { performance: { timeOrigin: 42 } },
    );

    expect(exports.run()).toBe(7);
  });

  it("lets a sloppy direct-eval var shadow the ambient host capability", async () => {
    const globalSandbox: Record<string, unknown> = { ambientProbe: { x: 42 } };
    await instantiate(
      `
        interface P { x: number; }
        declare const ambientProbe: P;

        function test(): number {
          eval("var ambientProbe = { x: 7 };");
          return ambientProbe.x;
        }

        globalThis.answer = test();
      `,
      undefined,
      globalSandbox,
    );

    expect(globalSandbox.answer).toBe(7);
  });

  it("does not publish an eval var from an untaken conditional", async () => {
    const globalSandbox: Record<string, unknown> = { ambientProbe: { x: 42 } };
    await instantiate(
      `
        interface P { x: number; }
        declare const ambientProbe: P;

        function test(runEval: boolean): number {
          if (runEval) eval("var ambientProbe = { x: 7 };");
          return ambientProbe.x;
        }

        globalThis.answer = test(false);
      `,
      undefined,
      globalSandbox,
    );

    expect(globalSandbox.answer).toBe(42);
  });

  it("keeps a strict module eval var private to the eval", async () => {
    const { exports } = await instantiate(
      `
        interface P { x: number; }
        declare const ambientProbe: P;

        export function run(): number {
          eval("var ambientProbe = { x: 7 };");
          return ambientProbe.x;
        }
      `,
      undefined,
      { ambientProbe: { x: 42 } },
    );

    expect(exports.run()).toBe(42);
  });

  it("does not reinterpret a generated module-import stub as a host global", async () => {
    const result = await compile(
      `
        import importedProbe from "missing-package";
        export function run(): number { return importedProbe ? 1 : 0; }
      `,
      {
        fileName: "ambient-import-stub.ts",
        target: "gc",
        platform: "node",
        skipSemanticDiagnostics: true,
      },
    );

    expect(result.imports.some((entry) => entry.name === "global_importedProbe")).toBe(false);
  });

  it("does not add an ambient host-global import to a standalone build", async () => {
    const result = await compile(AMBIENT_SOURCE, {
      fileName: "ambient-performance.ts",
      target: "standalone",
      platform: "node",
      skipSemanticDiagnostics: true,
    });

    expect(result.imports.some((entry) => entry.name === "global_performance")).toBe(false);
  });
});
