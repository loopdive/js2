// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { runPreparedIrPipelinePresentation } from "../src/compiler.js";
import { runIrProgramDriver } from "../src/compiler/ir-program-driver.js";
import * as presentation from "../src/compiler/ir-program-presentation.js";
import * as consumer from "../src/ir/program-consumer.js";
import * as preflight from "../src/ir/program-native-async-resources.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { decodePreparedIrProgram, encodePreparedIrProgram } from "../src/ir/program-codec.js";
import { subscribePreparedIrProgram } from "../src/ir/program-observation.js";
import {
  snapshotNativePromiseConfiguration,
  type NativePromiseConfiguration,
} from "../src/shared/contracts/compile-runtime-options.js";
import { sourceInput, requireProgram } from "./helpers/typed-program-fixtures.js";
import { replayOptions } from "./helpers/ir-whole-program-replay.js";

const scalar = { "./entry.ts": "export function run(): number { return 42; }" };
const options = replayOptions("wasmgc", "standalone");
const promiseOptions = { ...options, numberFormat: { integerBeforeScratch: true } };
const selected: NativePromiseConfiguration = { hooks: "dispatch", unhandledRejections: "track" };
function asyncInput() {
  return {
    ...sourceInput({
      "./entry.ts": readFileSync(new URL("../website/playground/examples/js/async.ts", import.meta.url), "utf8"),
    }),
    policy: {
      backend: "wasmgc",
      target: "standalone",
      stringConst: { storage: "native" },
      stringConcat: { concat: "native" },
    } as const,
    nativeStringValueProjection: "standalone-native" as const,
    promiseDelayProjection: "standalone-native" as const,
    asyncFamilyProjection: "standalone-native" as const,
  };
}
afterEach(() => vi.restoreAllMocks());

describe("explicit native Promise runtime configuration", () => {
  it("snapshots finite policies and preserves unresolved absence", () => {
    expect(snapshotNativePromiseConfiguration(undefined)).toBeUndefined();
    for (const hooks of ["disabled", "dispatch"] as const)
      for (const unhandledRejections of ["disabled", "track"] as const) {
        const original = { hooks, unhandledRejections };
        const copy = snapshotNativePromiseConfiguration(original)!;
        expect(copy).toEqual(original);
        expect(copy).not.toBe(original);
        expect(Object.isFrozen(copy)).toBe(true);
      }
  });

  it("rejects malformed finite policy data without executing getters", () => {
    const getter = vi.fn(() => "disabled");
    const malformed = [
      null,
      false,
      [],
      {},
      { hooks: "disabled" },
      { ...selected, hooks: "other" },
      { ...selected, unhandledRejections: "other" },
      { ...selected, extra: true },
      Object.assign(Object.create({ inherited: true }), selected),
      { ...selected, [Symbol("hidden")]: true },
      Object.defineProperty({ unhandledRejections: "track" }, "hooks", { get: getter }),
    ];
    for (const value of malformed)
      expect(() => snapshotNativePromiseConfiguration(value)).toThrow(/invalid native Promise configuration/);
    expect(getter).not.toHaveBeenCalled();
  });

  it("freezes caller configuration before normal driver observers and retains acceptance copies", () => {
    const caller = { ...selected };
    const mutable = { ...options, nativePromise: caller };
    const accept = vi.spyOn(consumer, "acceptPreparedIrProgram");
    let mutated = false;
    const unsubscribe = subscribePreparedIrProgram((event) => {
      if (event.phase === "prepared") {
        caller.hooks = "disabled";
        mutable.nativePromise = { hooks: "disabled", unhandledRejections: "disabled" };
        mutated = true;
      }
    });
    try {
      const result = runIrProgramDriver(sourceInput(scalar), mutable);
      expect(result.kind).toBe("emitted");
      expect(mutated).toBe(true);
      const accepted = accept.mock.results[0]!.value;
      expect(accepted.kind).toBe("accepted");
      expect(accepted.options.nativePromise).toEqual(selected);
      expect(accepted.options.nativePromise).not.toBe(caller);
      expect(Object.isFrozen(accepted.options.nativePromise)).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it("rejects invalid configuration before preparation observers", () => {
    let observed = false;
    const unsubscribe = subscribePreparedIrProgram(() => {
      observed = true;
    });
    try {
      expect(() =>
        runIrProgramDriver(sourceInput(scalar), {
          ...options,
          nativePromise: { ...selected, hooks: "wrong" } as never,
        }),
      ).toThrow(/invalid native Promise configuration/);
      expect(observed).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  it("rejects entry accessors before observers or planning execute", () => {
    const getter = vi.fn(() => selected);
    const invalid = Object.defineProperty({ ...options }, "nativePromise", { get: getter });
    let events = 0;
    const unsubscribe = subscribePreparedIrProgram(() => {
      events++;
    });
    try {
      expect(() => runIrProgramDriver(sourceInput(scalar), invalid)).toThrow(/non-executable data property/);
      expect(events).toBe(0);
      const program = requireProgram(prepareWholeIrProgram(sourceInput(scalar)));
      const plan = vi.spyOn(preflight, "planNativePromiseInventoryPreflight");
      expect(() => consumer.acceptPreparedIrProgram(program, invalid)).toThrow(/non-executable data property/);
      expect(plan).not.toHaveBeenCalled();
      expect(getter).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it("rejects supplied policies outside standalone WasmGC and leaves absent policies unchanged", () => {
    for (const scope of [
      { backend: "wasmgc", target: "host" },
      { backend: "linear", target: "standalone" },
    ] as const) {
      const ordinary = replayOptions(scope.backend, scope.target);
      expect(snapshotNativePromiseConfiguration(undefined, scope)).toBeUndefined();
      expect(() => runIrProgramDriver(sourceInput(scalar), { ...ordinary, nativePromise: selected })).toThrow(
        /requires standalone WasmGC/,
      );
      const program = requireProgram(prepareWholeIrProgram(sourceInput(scalar)));
      expect(() => consumer.acceptPreparedIrProgram(program, { ...ordinary, nativePromise: selected })).toThrow(
        /requires standalone WasmGC/,
      );
    }
  });

  it("forwards actual compiler options to the presentation boundary as an independent snapshot", () => {
    const ast = analyzeMultiSource(scalar, "./entry.ts");
    const caller = { ...selected };
    const capture = vi.spyOn(presentation, "prepareIrProgramPresentation");
    const result = runPreparedIrPipelinePresentation({
      userSourceFiles: ast.sourceFiles,
      entryAst: {
        sourceFile: ast.entryFile,
        checker: ast.checker,
        program: ast.program,
        diagnostics: ast.diagnostics,
        syntacticDiagnostics: ast.syntacticDiagnostics,
      },
      multiAst: ast,
      errors: [],
      codegenOptions: { link: [], sourceMap: false },
      sourcesContent: new Map(ast.sourceFiles.map((source) => [source.fileName, source.text])),
      diagnosticAnchor: ast.entryFile,
      options: { target: "standalone", optimize: false, nativePromise: caller },
    });
    // The independent presentation target gap remains; forwarding does not bypass it.
    expect(result.kind).toBe("presentation-unsupported");
    expect(capture).toHaveBeenCalledTimes(1);
    const forwarded = capture.mock.calls[0]![0].backendOptions.nativePromise;
    expect(forwarded).toEqual(selected);
    expect(forwarded).not.toBe(caller);
    expect(Object.isFrozen(forwarded)).toBe(true);
    caller.hooks = "disabled";
    expect(forwarded).toEqual(selected);
  });

  it("forwards normal driver and codec policies while keeping every other Promise obligation", async () => {
    // Flush pending runner updates before synchronous whole-program planning.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const source = asyncInput();
    const observed = vi.spyOn(preflight, "planNativePromiseInventoryPreflight");
    const driver = runIrProgramDriver(source, { ...promiseOptions, nativePromise: selected });
    expect(driver.kind).toBe("unsupported");
    expect(observed).toHaveBeenCalled();
    const first = observed.mock.results.at(-1)!.value as preflight.NativePromiseInventoryPreflight;
    expect(first.kind).toBe("unavailable");
    if (first.kind !== "unavailable") throw new Error("expected actual Promise preflight refusal");
    const original = requireProgram(prepareWholeIrProgram(source));
    const decoded = decodePreparedIrProgram(encodePreparedIrProgram(original));
    for (const program of [original, decoded])
      for (const config of [undefined, selected, { hooks: "disabled", unhandledRejections: "disabled" } as const]) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        observed.mockClear();
        const result = consumer.acceptPreparedIrProgram(program, {
          ...promiseOptions,
          ...(config ? { nativePromise: config } : {}),
        });
        expect(result.kind).toBe("unsupported");
        expect(observed).toHaveBeenCalledTimes(1);
        expect(observed.mock.calls[0]![4]).toEqual(config);
        const inventory = observed.mock.results[0]!.value as preflight.NativePromiseInventoryPreflight;
        expect(inventory.kind).toBe("unavailable");
        if (inventory.kind !== "unavailable") throw new Error("expected actual Promise obligations");
        expect(inventory.obligations.filter((row) => row.code === "missing-runtime-configuration")).toHaveLength(
          config ? 0 : 1,
        );
        expect(inventory.obligations.filter((row) => row.code !== "missing-runtime-configuration")).toEqual(
          first.obligations,
        );
        expect(inventory.obligations.some((row) => row.code === "complete-composition")).toBe(true);
      }
  }, 180_000);
});
