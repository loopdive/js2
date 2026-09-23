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
import type { NumberBoundaryPolicy } from "../src/runtime/contracts/provider-policy.js";
import { buildImports } from "../src/runtime.js";
import { replayOptions } from "./helpers/ir-whole-program-replay.js";

const ENABLED = { box: "host", unbox: "unsupported" } as const;
const DISABLED = { box: "unsupported", unbox: "unsupported" } as const;
const REGULAR = "export function fail(): number { throw 17; }";
const COMBINED = `${REGULAR}
export async function rejected(): Promise<number> { const value = await fail(); return value; }`;

function prepare(source: string, boundary?: NumberBoundaryPolicy) {
  const ast = analyzeMultiSource({ "./entry.ts": source }, "./entry.ts");
  const policy = {
    target: "host" as const,
    backend: "wasmgc" as const,
    ...(boundary ? { numberBoundary: boundary } : {}),
  };
  return prepareWholeIrProgram({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy,
    runtimePolicies: [policy],
    deferTopLevelInit: false,
  });
}

function prepared(source: string): PreparedIrProgram {
  const result = prepare(source, ENABLED);
  expect(result.kind, JSON.stringify(result.kind === "prepared" ? {} : result)).toBe("prepared");
  if (result.kind !== "prepared") throw new Error(result.detail);
  const encoded = encodePreparedIrProgram(result.program);
  const program = decodePreparedIrProgram(encoded);
  expect(encodePreparedIrProgram(program)).toBe(encoded);
  const manifest = program.runtime[0]!.prepared.manifest;
  expect(manifest.policy.numberBoundary).toEqual(ENABLED);
  expect(manifest.providers.filter((provider) => provider.id === "host.js.number.box")).toHaveLength(1);
  expect(manifest.hostCapabilityRecords.filter((record) => record.capability === "number.box")).toHaveLength(1);
  return program;
}

async function instantiate(program: PreparedIrProgram, shared: boolean) {
  const accepted = acceptPreparedIrProgram(program, { ...replayOptions("wasmgc"), sharedExceptionTag: shared });
  expect(accepted.kind, JSON.stringify(accepted.kind === "accepted" ? {} : accepted)).toBe("accepted");
  if (accepted.kind !== "accepted") throw new Error(accepted.detail);
  const emitted = emitAcceptedIrProgram(accepted);
  expect(emitted.emittedUnitIds).toEqual(accepted.runtime.prepared.functions.map((fn) => fn.unitId));
  const boxes = emitted.module.imports.filter((entry) => entry.module === "env" && entry.name === "__box_number");
  expect(boxes).toHaveLength(1);
  const box = boxes[0]!;
  expect(box.desc.kind).toBe("func");
  if (box.desc.kind !== "func") throw new Error("number box is not a function");
  expect(emitted.module.types[box.desc.typeIdx]).toMatchObject({
    kind: "func",
    params: [{ kind: "f64" }],
    results: [{ kind: "externref" }],
  });
  const tags = emitted.module.imports.filter((entry) => entry.desc.kind === "tag");
  expect(tags).toHaveLength(shared ? 1 : 0);
  const manifest = buildImportManifest(emitted.module).filter(
    (entry) => !tags.some((tag) => tag.module === entry.module && tag.name === entry.name),
  );
  const imports = buildImports(manifest);
  const wasmImports = imports as unknown as WebAssembly.Imports;
  let sharedTag: WebAssembly.Tag | undefined;
  for (const tag of tags) {
    sharedTag = new WebAssembly.Tag({ parameters: ["externref"] });
    (wasmImports[tag.module] ??= {})[tag.name] = sharedTag;
  }
  const { instance } = await WebAssembly.instantiate(emitBinary(emitted.module), wasmImports);
  imports.setInstance?.(instance);
  return { exports: instance.exports, sharedTag };
}

function call(exports: WebAssembly.Exports, name: string): unknown {
  const target = exports[name];
  expect(target).toBeTypeOf("function");
  if (typeof target !== "function") throw new Error(`missing ${name}`);
  return target();
}

function caught(body: () => unknown): unknown {
  try {
    body();
  } catch (error) {
    return error;
  }
  throw new Error("numeric source throw did not throw");
}

describe("#3527 numeric throw consumes an explicit independently materialized box provider", () => {
  for (const shared of [false, true]) {
    it(`emits a regular numeric throw without an async runtime (shared=${shared})`, async () => {
      const program = prepared(REGULAR);
      expect(program.ir.functions.some((fn) => fn.asyncPlan)).toBe(false);
      expect(program.runtime[0]!.prepared.manifest.providers.map((provider) => provider.id)).toEqual([
        "host.js.number.box",
      ]);
      const result = await instantiate(program, shared);
      const error = caught(() => call(result.exports, "fail"));
      expect(error).toBeInstanceOf(WebAssembly.Exception);
      // A regular local tag is deliberately not exported: only the shared-tag
      // case exposes payload identity here; combined async cases below expose both.
      if (result.sharedTag) {
        expect((error as WebAssembly.Exception).is(result.sharedTag)).toBe(true);
        expect((error as WebAssembly.Exception).getArg(result.sharedTag, 0)).toBe(17);
      }
    }, 30_000);

    it(`shares one box import between regular and async bodies and rejects with native payload (shared=${shared})`, async () => {
      const result = await instantiate(prepared(COMBINED), shared);
      expect(caught(() => call(result.exports, "fail"))).toBeInstanceOf(WebAssembly.Exception);
      const native = async () => {
        throw 17;
      };
      const expected = await native().catch((reason: unknown) => reason);
      let output: unknown;
      expect(() => {
        output = call(result.exports, "rejected");
      }).not.toThrow();
      expect(output).toBeInstanceOf(Promise);
      await expect(output).rejects.toBe(expected);
      expect(expected).toBe(17);
    }, 30_000);
  }

  for (const boundary of [undefined, DISABLED])
    it(`does not infer permission from numeric throw when policy is ${boundary ? "disabled" : "omitted"}`, async () => {
      await instantiate(prepared(REGULAR), false);
      const phases: string[] = [];
      const unsubscribe = subscribePreparedIrProgram((event) => {
        phases.push(event.phase);
      });
      try {
        const result = prepare(REGULAR, boundary);
        expect(result.kind).toBe("unsupported");
        if (result.kind === "prepared") throw new Error("disabled number-box policy prepared");
        expect(result.code).toBe("body-shape-rejected");
        expect(result.detail).toBe(
          "semantic intrinsic js.number.box is unavailable under number-boundary policy box=unsupported/unbox=unsupported",
        );
        expect(result.stage).toBe("build");
        expect(result.sourceFile).toBe("entry.ts");
        expect(phases).not.toContain("emission-started");
        expect(phases).not.toContain("emitted");
      } finally {
        unsubscribe();
      }
    }, 30_000);

  it("rejects a removed provider and altered canonical box signature before emission, following a real positive", async () => {
    const program = prepared(COMBINED);
    const positive = await instantiate(program, true);
    await expect(call(positive.exports, "rejected")).rejects.toBe(17);
    const missingProvider: PreparedIrProgram = {
      ...program,
      runtime: program.runtime.map((projection) => ({
        ...projection,
        prepared: {
          ...projection.prepared,
          manifest: {
            ...projection.prepared.manifest,
            providers: projection.prepared.manifest.providers.filter(
              (provider) => provider.id !== "host.js.number.box",
            ),
          },
        },
      })),
    };
    const badSignature: PreparedIrProgram = {
      ...program,
      runtime: program.runtime.map((projection) => ({
        ...projection,
        prepared: {
          ...projection.prepared,
          manifest: {
            ...projection.prepared.manifest,
            hostCapabilityRecords: projection.prepared.manifest.hostCapabilityRecords.map((record) =>
              record.kind === "func" && record.capability === "number.box"
                ? { ...record, params: ["i32" as const] }
                : record,
            ),
          },
        },
      })),
    };
    const phases: string[] = [];
    const unsubscribe = subscribePreparedIrProgram((event) => {
      phases.push(event.phase);
    });
    try {
      for (const malformed of [missingProvider, badSignature])
        expect(() => acceptPreparedIrProgram(malformed, replayOptions("wasmgc"))).toThrow();
      expect(phases).not.toContain("emission-started");
      expect(phases).not.toContain("emitted");
    } finally {
      unsubscribe();
    }
  }, 30_000);
});
