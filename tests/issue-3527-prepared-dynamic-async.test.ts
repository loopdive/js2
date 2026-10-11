// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { buildImportManifest } from "../src/compiler/import-manifest.js";
import { emitBinary } from "../src/emit/binary.js";
import { decodePreparedIrProgram, encodePreparedIrProgram } from "../src/ir/program-codec.js";
import { acceptPreparedIrProgram, emitAcceptedIrProgram } from "../src/ir/program-consumer.js";
import { subscribePreparedIrProgram } from "../src/ir/program-observation.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import type { PreparedIrProgram } from "../src/ir/program.js";
import { buildImports } from "../src/runtime.js";
import { replayOptions } from "./helpers/ir-whole-program-replay.js";

const FILES = {
  "./entry.ts": `
export async function once(input: any): Promise<any> {
  const value = await input;
  return value;
}
export async function twice(input: any): Promise<any> {
  const first = await input;
  const second = await first;
  return second;
}
`,
};

function prepare(): PreparedIrProgram {
  const ast = analyzeMultiSource(FILES, "./entry.ts");
  const result = prepareWholeIrProgram({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: { backend: "wasmgc", target: "host" },
    runtimePolicies: [{ backend: "wasmgc", target: "host" }],
    deferTopLevelInit: false,
  });
  expect(result.kind, JSON.stringify(result.kind === "prepared" ? {} : result)).toBe("prepared");
  if (result.kind !== "prepared") throw new Error(result.detail);
  const encoded = encodePreparedIrProgram(result.program);
  const program = decodePreparedIrProgram(encoded);
  expect(encodePreparedIrProgram(program)).toBe(encoded);
  const owners = program.ir.functions.filter((fn) => fn.asyncPlan);
  expect(owners).toHaveLength(2);
  for (const fn of owners) {
    expect(fn.params).toHaveLength(1);
    expect(fn.params[0]!.type).toEqual({ kind: "dynamic" });
    const plan = fn.asyncPlan!;
    expect(plan.abi.fulfillmentType).toEqual({ kind: "dynamic" });
    expect(plan.params[0]!.type).toEqual({ kind: "dynamic" });
    const resumed = plan.states.filter((state) => state.resume).map((state) => state.resume!.value);
    expect(resumed.length).toBeGreaterThan(0);
    for (const value of resumed)
      expect(plan.values.find((entry) => entry.value === value)?.type).toEqual({ kind: "dynamic" });
  }
  const twice = owners.find((fn) => fn.name === "twice");
  expect(twice?.asyncPlan?.states.filter((state) => state.resume)).toHaveLength(2);
  return program;
}

async function instantiate(program: PreparedIrProgram, shared: boolean) {
  const accepted = acceptPreparedIrProgram(program, { ...replayOptions("wasmgc"), sharedExceptionTag: shared });
  expect(accepted.kind, JSON.stringify(accepted.kind === "accepted" ? {} : accepted)).toBe("accepted");
  if (accepted.kind !== "accepted") throw new Error(accepted.detail);
  const emitted = emitAcceptedIrProgram(accepted);
  expect(emitted.emittedUnitIds).toEqual(accepted.runtime.prepared.functions.map((fn) => fn.unitId));
  const tags = emitted.module.imports.filter((entry) => entry.desc.kind === "tag");
  expect(tags).toHaveLength(shared ? 1 : 0);
  const manifest = buildImportManifest(emitted.module).filter(
    (entry) => !tags.some((tag) => tag.module === entry.module && tag.name === entry.name),
  );
  const imports = buildImports(manifest);
  const wasmImports = imports as unknown as WebAssembly.Imports;
  for (const tag of tags)
    (wasmImports[tag.module] ??= {})[tag.name] = new WebAssembly.Tag({ parameters: ["externref"] });
  const binary = emitBinary(emitted.module);
  const { instance } = await WebAssembly.instantiate(binary, wasmImports);
  imports.setInstance?.(instance);
  const once = instance.exports.once;
  const twice = instance.exports.twice;
  expect(once).toBeTypeOf("function");
  expect(twice).toBeTypeOf("function");
  if (typeof once !== "function" || typeof twice !== "function") throw new Error("missing original async exports");
  return { once, twice };
}

const native = {
  once: async (input: unknown) => {
    const value = await input;
    return value;
  },
  twice: async (input: unknown) => {
    const first = await input;
    const second = await first;
    return second;
  },
};

function promise(value: unknown): Promise<unknown> {
  expect(value).toBeInstanceOf(Promise);
  if (!(value instanceof Promise)) throw new Error("async export did not return a Promise");
  return value;
}

describe("#3527 host async unrefined dynamic is a semantic identity carrier", () => {
  for (const shared of [false, true]) {
    it(`preserves concurrent pending values and direct values without numeric reinterpretation (shared=${shared})`, async () => {
      const exports = await instantiate(prepare(), shared);
      const object = { marker: "same object" };
      const values = [object, undefined, "dynamic string", 73];
      for (const name of ["once", "twice"] as const) {
        const releases: ((value: unknown) => void)[] = [];
        const inputs = values.map(
          () =>
            new Promise<unknown>((resolve) => {
              releases.push(resolve);
            }),
        );
        const actual = inputs.map((input) => promise(exports[name](input)));
        expect(new Set(actual).size).toBe(values.length);
        actual.forEach((output, index) => expect(output).not.toBe(inputs[index]));
        const expected = inputs.map(native[name]);
        let completed = 0;
        const observed = actual.map((output) =>
          output.then((value) => {
            completed++;
            return value;
          }),
        );
        await Promise.resolve();
        await Promise.resolve();
        expect(completed).toBe(0);
        for (let index = releases.length - 1; index >= 0; index--) releases[index]!(values[index]);
        const results = await Promise.all(observed);
        const nativeResults = await Promise.all(expected);
        results.forEach((value, index) => {
          expect(value).toBe(values[index]);
          expect(value).toBe(nativeResults[index]);
        });
        expect(completed).toBe(values.length);
        // Direct non-Promises take canonical PromiseResolve too; repeat all carrier shapes.
        for (const value of values) expect(await promise(exports[name](value))).toBe(await native[name](value));
      }
    }, 30_000);

    it(`preserves rejected objects and assimilates genuine thenables through both await paths (shared=${shared})`, async () => {
      const exports = await instantiate(prepare(), shared);
      for (const name of ["once", "twice"] as const) {
        const reason = { marker: `${name} rejection` };
        const input = Promise.reject(reason);
        const expected = native[name](input).catch((error: unknown) => error);
        const actual = promise(exports[name](input)).catch((error: unknown) => error);
        expect(await actual).toBe(await expected);
        expect(await actual).toBe(reason);
        const value = { marker: `${name} thenable result` };
        let calls = 0;
        const thenable = {
          then(resolve: (value: unknown) => void) {
            calls++;
            resolve(value);
          },
        };
        const expectedValue = native[name](thenable);
        const actualValue = promise(exports[name](thenable));
        expect(calls).toBe(0);
        expect(await actualValue).toBe(await expectedValue);
        expect(await actualValue).toBe(value);
        expect(calls).toBe(2);
      }
    }, 30_000);
  }

  it("refuses unselected native/linear carriers and stale semantic parameter types before emission after a positive", async () => {
    const program = prepare();
    const exports = await instantiate(program, false);
    const object = { marker: "positive before malformed" };
    expect(await promise(exports.once(object))).toBe(object);
    const phases: string[] = [];
    const unsubscribe = subscribePreparedIrProgram((event) => {
      phases.push(event.phase);
    });
    try {
      for (const options of [replayOptions("linear"), replayOptions("wasmgc", "standalone")]) {
        expect(acceptPreparedIrProgram(program, options).kind).toBe("unsupported");
      }
      const stale = {
        ...program,
        ir: {
          ...program.ir,
          functions: program.ir.functions.map((fn) =>
            fn.asyncPlan
              ? {
                  ...fn,
                  params: fn.params.map((param) => ({
                    ...param,
                    type: { kind: "val" as const, val: { kind: "f64" as const } },
                  })),
                }
              : fn,
          ),
        },
      };
      expect(() => acceptPreparedIrProgram(stale, replayOptions("wasmgc"))).toThrow();
      expect(phases).not.toContain("emission-started");
      expect(phases).not.toContain("emitted");
    } finally {
      unsubscribe();
    }
  }, 30_000);
});
