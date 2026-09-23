// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { buildImportManifest } from "../src/compiler/import-manifest.js";
import { emitBinary } from "../src/emit/binary.js";
import { absoluteFuncIndex } from "../src/emit/resolve-layout.js";
import { acceptPreparedIrProgram, emitAcceptedIrProgram } from "../src/ir/program-consumer.js";
import { decodePreparedIrProgram, encodePreparedIrProgram } from "../src/ir/program-codec.js";
import { subscribePreparedIrProgram } from "../src/ir/program-observation.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { PreparedIrProgramInvariantError, type PreparedIrProgram } from "../src/ir/program.js";
import { buildImports } from "../src/runtime.js";
import { STABLE_FUNC_BASE } from "../src/wasm/physical/function-handles.js";
import { replayOptions } from "./helpers/ir-whole-program-replay.js";

const owners = {
  "./numbers.ts": "export function step(value: number): number { return value + 7; }",
  "./entry.ts": `
import { step } from "./numbers";
export async function first(seed: number): Promise<number> {
  let value = await step(seed);
  value = await step(value);
  return value;
}
export async function second(seed: number): Promise<number> {
  const value = await step(seed);
  return value;
}
`,
};
const pendingOwner = {
  "./entry.ts": `
export async function suspend(input: Promise<number>): Promise<number> {
  const value = await input;
  return value;
}
`,
};
// Separate carrier probe; the original typed Promise fixture above stays intact.
const pendingAnyOwner = {
  "./entry.ts": `
export async function suspend(input: any): Promise<any> {
  const value = await input;
  return value;
}
`,
};
const throwingNullOwner = {
  "./entry.ts": `
function fail(): number { throw null; }
export async function rejected(): Promise<number> {
  const value = await fail();
  return value;
}
`,
};
const throwingOwner = {
  "./entry.ts": `
function fail(): number { throw 17; }
export async function rejected(): Promise<number> {
  const value = await fail();
  return value;
}
`,
};

function prepare(files: Record<string, string>, numericThrow = false): PreparedIrProgram {
  const ast = analyzeMultiSource(files, "./entry.ts");
  const result = prepareWholeIrProgram({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: {
      backend: "wasmgc",
      target: "host",
      ...(numericThrow ? { numberBoundary: { box: "host" as const, unbox: "unsupported" as const } } : {}),
    },
    runtimePolicies: [
      {
        backend: "wasmgc",
        target: "host",
        ...(numericThrow ? { numberBoundary: { box: "host" as const, unbox: "unsupported" as const } } : {}),
      },
    ],
    deferTopLevelInit: false,
  });
  expect(result.kind, JSON.stringify(result.kind === "prepared" ? {} : result)).toBe("prepared");
  if (result.kind !== "prepared") throw new Error(result.detail);
  const bytes = encodePreparedIrProgram(result.program);
  const decoded = decodePreparedIrProgram(bytes);
  expect(decoded).not.toBe(result.program);
  expect(encodePreparedIrProgram(decoded)).toBe(bytes);
  expect(decoded.ir.functions.some((fn) => fn.asyncPlan !== undefined)).toBe(true);
  return decoded;
}

async function instantiate(program: PreparedIrProgram, sharedExceptionTag = false) {
  const accepted = acceptPreparedIrProgram(program, { ...replayOptions("wasmgc"), sharedExceptionTag });
  expect(accepted.kind, JSON.stringify(accepted.kind === "accepted" ? {} : accepted)).toBe("accepted");
  if (accepted.kind !== "accepted") throw new Error(accepted.detail);
  const emitted = emitAcceptedIrProgram(accepted);
  const selected = accepted.runtime.prepared.functions.map((fn) => fn.unitId);
  expect(selected.length).toBeGreaterThan(0);
  expect(emitted.emittedUnitIds).toEqual(selected);
  expect(new Set(emitted.emittedUnitIds).size).toBe(selected.length);
  // Runtime continuation/helper bodies are physical bodies, not invented source unit receipts.
  const physicalHelpers = emitted.module.functions.length - emitted.emittedUnitIds.length;
  expect(physicalHelpers).toBeGreaterThan(0);
  const callbacks = emitted.module.exports.filter((entry) => /^__cb_\d+$/.test(entry.name));
  expect(callbacks.length).toBeGreaterThan(0);
  expect(new Set(callbacks.map((entry) => entry.name)).size).toBe(callbacks.length);
  const callbackIndices = callbacks.map((entry) => {
    expect(entry.desc.kind).toBe("func");
    if (entry.desc.kind !== "func") throw new Error("callback is not a function export");
    return entry.desc.index;
  });
  expect(new Set(callbackIndices).size).toBe(callbackIndices.length);
  const functionImports = emitted.module.imports.filter((entry) => entry.desc.kind === "func").length;
  expect(emitted.module.funcOrdinalToPosition).toHaveLength(emitted.module.functions.length);
  expect(new Set(emitted.module.funcOrdinalToPosition).size).toBe(emitted.module.functions.length);
  for (const [ordinal, position] of emitted.module.funcOrdinalToPosition.entries()) {
    expect(position).toBeGreaterThanOrEqual(0);
    expect(position).toBeLessThan(emitted.module.functions.length);
    expect(absoluteFuncIndex(emitted.module, STABLE_FUNC_BASE + ordinal)).toBe(functionImports + position);
  }
  const tags = emitted.module.imports.filter((entry) => entry.desc.kind === "tag");
  expect(tags.length).toBe(sharedExceptionTag ? 1 : 0);
  // Reuse the production host adapter. The compiler manifest covers functions/globals;
  // exception tags retain their separate Wasm import kind, as in codec replay.
  const manifest = buildImportManifest(emitted.module).filter(
    (entry) => !tags.some((tag) => tag.module === entry.module && tag.name === entry.name),
  );
  const imports = buildImports(manifest);
  const wasmImports = imports as unknown as WebAssembly.Imports;
  for (const tag of tags) {
    (wasmImports[tag.module] ??= {})[tag.name] = new WebAssembly.Tag({ parameters: ["externref"] });
  }
  const binary = emitBinary(emitted.module);
  expect(binary.byteLength).toBeGreaterThan(8);
  const { instance } = await WebAssembly.instantiate(binary, wasmImports);
  imports.setInstance?.(instance);
  return instance.exports;
}

function callable(exports: WebAssembly.Exports, name: string): (...args: unknown[]) => unknown {
  const value = exports[name];
  expect(value).toBeTypeOf("function");
  if (typeof value !== "function") throw new Error(`missing source export ${name}`);
  return value;
}

async function nativeFirst(seed: number) {
  let value = await (seed + 7);
  value = await (value + 7);
  return value;
}
async function nativeSecond(seed: number) {
  const value = await (seed + 7);
  return value;
}

async function schedule(first: (seed: number) => unknown, second: (seed: number) => unknown) {
  const completed: string[] = [];
  const promises = [first(3), second(20), first(100), second(-10)];
  for (const promise of promises) expect(promise).toBeInstanceOf(Promise);
  expect(new Set(promises).size).toBe(promises.length);
  const observed = promises.map((promise, index) =>
    (promise as Promise<number>).then((value) => {
      completed.push(`${index}:${value}`);
      return value;
    }),
  );
  expect(completed).toEqual([]);
  const values = await Promise.all(observed);
  return { values, completed };
}

// These are acceptance positives, not a snapshot of the former async refusal.
// The existing mixed-app fixture and its broader capability gaps remain separate.
describe("#3527 source → prepared codec → production async consumer", () => {
  for (const shared of [false, true]) {
    it(`executes concurrent owners without callback collisions (shared tag=${shared})`, async () => {
      const exports = await instantiate(prepare(owners), shared);
      const expected = await schedule(nativeFirst, nativeSecond);
      expect(expected.values).toEqual([17, 27, 114, -3]);
      const actual = await schedule(callable(exports, "first"), callable(exports, "second"));
      expect(actual).toEqual(expected);
    }, 30_000);

    for (const fixture of [
      { label: "preserves pending input and rejection identity", files: pendingOwner },
      { label: "any carrier preserves pending input and rejection identity", files: pendingAnyOwner },
    ])
      it(`${fixture.label} (shared tag=${shared})`, async () => {
        const exports = await instantiate(prepare(fixture.files), shared);
        const suspend = callable(exports, "suspend");
        const native = async (input: Promise<number>) => {
          const value = await input;
          return value;
        };
        let release!: (value: number) => void;
        const input = new Promise<number>((resolve) => {
          release = resolve;
        });
        const actual = suspend(input);
        expect(actual).toBeInstanceOf(Promise);
        expect(actual).not.toBe(input);
        const expected = native(input);
        let completed = false;
        const observed = (actual as Promise<number>).then((value) => {
          completed = true;
          return value;
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(completed).toBe(false);
        release(73);
        expect(await observed).toBe(await expected);
        expect(completed).toBe(true);
        const reason = { marker: "same rejected input object" };
        const rejected = Promise.reject<number>(reason);
        const nativeRejected = native(rejected).catch((error: unknown) => error);
        const actualRejected = suspend(rejected);
        expect(actualRejected).toBeInstanceOf(Promise);
        const actualReason = await (actualRejected as Promise<unknown>).catch((error: unknown) => error);
        expect(actualReason).toBe(await nativeRejected);
        expect(actualReason).toBe(reason);
      }, 30_000);

    for (const fixture of [
      { label: "turns synchronous source throws into rejected Promises", files: throwingOwner, reason: 17 },
      { label: "supported null throw becomes rejected Promise", files: throwingNullOwner, reason: null },
    ])
      it(`${fixture.label} (shared tag=${shared})`, async () => {
        const exports = await instantiate(prepare(fixture.files, fixture.files === throwingOwner), shared);
        const native = async () => {
          throw fixture.reason;
        };
        const expected = await native().catch((reason: unknown) => reason);
        let result: unknown;
        expect(() => {
          result = callable(exports, "rejected")();
        }).not.toThrow();
        expect(result).toBeInstanceOf(Promise);
        await expect(result).rejects.toBe(expected);
      }, 30_000);
  }

  it("refuses a missing runtime projection and malformed population before emission, after a real positive", async () => {
    const program = prepare(owners);
    const exports = await instantiate(program);
    expect(await callable(exports, "first")(5)).toBe(await nativeFirst(5));
    const phases: string[] = [];
    const unsubscribe = subscribePreparedIrProgram((event) => {
      phases.push(event.phase);
    });
    try {
      const failure = acceptPreparedIrProgram(program, replayOptions("wasmgc", "standalone"));
      expect(failure.kind).toBe("unsupported");
      const malformed = { ...program, ir: { ...program.ir, functions: [] } };
      expect(() => acceptPreparedIrProgram(malformed, replayOptions("wasmgc"))).toThrow(
        PreparedIrProgramInvariantError,
      );
      expect(phases).not.toContain("emission-started");
      expect(phases).not.toContain("emitted");
    } finally {
      unsubscribe();
    }
  }, 30_000);
});
