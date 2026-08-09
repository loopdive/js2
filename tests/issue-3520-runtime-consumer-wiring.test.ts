// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { instantiatePlaygroundModule } from "../website/playground/runtime-wiring.js";

const PLAYGROUND_SOURCE = `
  class Box {
    alpha: number = 3;
    beta: number = 4;
  }
  export function countKeys(value: any): number {
    let count: number = 0;
    for (const _key in value) count = count + 1;
    return count;
  }
  export function makeBox(): Box { return new Box(); }
  export function install(target: HTMLElement): void {
    target.addEventListener("tick", (value: number) => value + countKeys(new Box()));
  }
`;

const CALLBACK_SOURCE = `
  export function install(target: HTMLElement): void {
    target.addEventListener("tick", (value: number) => value + 1);
  }
`;

async function compileConsumer(source: string, fileName: string) {
  const result = await compile(source, {
    fileName,
    experimentalIR: true,
    trackIrOutcomes: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result;
}

describe("#3520 branded runtime consumers", () => {
  it("gives the playground exact constant ownership before field and callback execution", async () => {
    const result = await compileConsumer(PLAYGROUND_SOURCE, "issue-3520-playground-runtime.ts");
    const makeImports = () => buildImports(result.imports, undefined, result.stringPool);

    const rawImports = makeImports();
    const { instance: rawInstance } = await WebAssembly.instantiate(result.binary, rawImports);
    rawImports.setExports?.(rawInstance.exports as Record<string, Function>);
    const rawBox = (rawInstance.exports.makeBox as () => unknown)();
    expect((rawInstance.exports.countKeys as (value: unknown) => number)(rawBox)).toBe(0);

    const mismatchedImports = makeImports();
    const donorImports = makeImports();
    const { instance: mismatchedInstance } = await WebAssembly.instantiate(result.binary, donorImports);
    mismatchedImports.setInstance?.(mismatchedInstance);
    const mismatchedBox = (mismatchedInstance.exports.makeBox as () => unknown)();
    expect((mismatchedInstance.exports.countKeys as (value: unknown) => number)(mismatchedBox)).toBe(0);

    const canonicalImports = makeImports();
    const { instance } = await instantiatePlaygroundModule(result.binary, canonicalImports);
    const box = (instance.exports.makeBox as () => unknown)();
    expect((instance.exports.countKeys as (value: unknown) => number)(box)).toBe(2);
    let listener: ((value: number) => number) | undefined;
    const target = {
      addEventListener(_type: string, callback: (value: number) => number): void {
        listener = callback;
      },
    };
    (instance.exports.install as (target: object) => void)(target);
    expect(listener).toBeTypeOf("function");
    expect(listener!(40)).toBe(42);
  });

  it("keeps generated load-time runtimes synchronized and wires callbacks through setInstance", async () => {
    const generatorSource = readFileSync(new URL("../scripts/generate-size-benchmarks.ts", import.meta.url), "utf8");
    const artifactPaths = [
      new URL("../benchmarks/results/loadtime/runtime.js", import.meta.url),
      new URL("../website/public/benchmarks/results/loadtime/runtime.js", import.meta.url),
    ];
    for (const required of [
      "string_constants16: buildStringConstants16(stringPool)",
      "setInstance(instance)",
      "brandedInstanceExports(instance)",
      "!preserveDataStructAssociation",
    ]) {
      expect(generatorSource).toContain(required);
      for (const artifactPath of artifactPaths) {
        expect(readFileSync(artifactPath, "utf8")).toContain(required);
      }
    }

    const result = await compileConsumer(CALLBACK_SOURCE, "issue-3520-loadtime-runtime.ts");
    for (const artifactPath of artifactPaths) {
      const runtime = (await import(`${artifactPath.href}?test=${Date.now()}-${Math.random()}`)) as {
        buildImports: (
          manifest: unknown[],
          deps: Record<string, unknown>,
          stringPool: string[],
        ) => {
          env: Record<string, Function>;
          string_constants: Record<string, WebAssembly.Global>;
          string_constants16: Record<string, WebAssembly.Global>;
          setInstance?: (instance: WebAssembly.Instance) => void;
        };
        instantiateWasm: (
          binary: BufferSource,
          env: Record<string, Function>,
          stringConstants: Record<string, WebAssembly.Global>,
          stringConstants16: Record<string, WebAssembly.Global>,
        ) => Promise<{ instance: WebAssembly.Instance }>;
      };
      const imports = runtime.buildImports(result.imports, {}, result.stringPool);
      const { instance } = await runtime.instantiateWasm(
        result.binary,
        imports.env,
        imports.string_constants,
        imports.string_constants16,
      );
      imports.setInstance?.(instance);
      let listener: ((value: number) => number) | undefined;
      const target = {
        addEventListener(_type: string, callback: (value: number) => number): void {
          listener = callback;
        },
      };
      (instance.exports.install as (target: object) => void)(target);
      expect(listener).toBeTypeOf("function");
      expect(listener!(41)).toBe(42);
    }
  });
});
