// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compile, compileMulti, compileToObject, compileToWat } from "../src/index.js";
import { compileSourceSync } from "../src/compiler.js";
import { analyzeMultiSource } from "../src/checker/index.js";
import { emitBinary } from "../src/emit/binary.js";
import { runIrProgramDriver } from "../src/compiler/ir-program-driver.js";
import { IrProgramDriverInvariantError } from "../src/compiler/ir-program-result.js";
import * as preparation from "../src/ir/program-preparation.js";
import * as consumer from "../src/ir/program-consumer.js";
import * as gcCodegen from "../src/codegen/index.js";
import * as linearCodegen from "../src/codegen-linear/index.js";
import { subscribePreparedIrProgram } from "../src/ir/program-observation.js";
import { preparedIrProgramOwner, type PreparedIrBackendOptions } from "../src/ir/program.js";

const scalar = "export function calculate(value: number): number { return value * 3 + 2; }";

function input(files: Record<string, string> = { "./entry.ts": scalar }) {
  const ast = analyzeMultiSource(files, "./entry.ts");
  return {
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: { target: "host", backend: "wasmgc" } as const,
    deferTopLevelInit: false,
  };
}

function options(): PreparedIrBackendOptions {
  return {
    backend: "wasmgc",
    target: "host",
    sharedExceptionTag: false,
    utf8Storage: false,
    sourceMap: false,
    moduleName: "public-prepared-driver-control",
  };
}

afterEach(() => vi.restoreAllMocks());

describe("internal prepared-program driver (public cutover remains pending)", () => {
  beforeEach(() => {
    vi.spyOn(gcCodegen, "generateModule");
    vi.spyOn(gcCodegen, "generateMultiModule");
    vi.spyOn(linearCodegen, "generateLinearModule");
    vi.spyOn(linearCodegen, "generateLinearMultiModule");
  });
  afterEach(() => {
    expect(gcCodegen.generateModule).not.toHaveBeenCalled();
    expect(gcCodegen.generateMultiModule).not.toHaveBeenCalled();
    expect(linearCodegen.generateLinearModule).not.toHaveBeenCalled();
    expect(linearCodegen.generateLinearMultiModule).not.toHaveBeenCalled();
  });
  it.each([
    { backend: "wasmgc", target: "host" },
    { backend: "wasmgc", target: "strict-no-host" },
    { backend: "linear", target: "host" },
  ] as const)("executes real scalar $backend/$target with legacy generators poisoned", (policy) => {
    const poison = () => {
      throw new Error("legacy generator entered");
    };
    const direct = [
      vi.spyOn(gcCodegen, "generateModule").mockImplementation(poison),
      vi.spyOn(gcCodegen, "generateMultiModule").mockImplementation(poison),
      vi.spyOn(linearCodegen, "generateLinearModule").mockImplementation(poison),
      vi.spyOn(linearCodegen, "generateLinearMultiModule").mockImplementation(poison),
    ];
    const phases: string[] = [];
    const unsubscribe = subscribePreparedIrProgram((event) => phases.push(event.phase));
    try {
      const result = runIrProgramDriver({ ...input(), policy }, { ...options(), ...policy });
      expect(result.kind).toBe("emitted");
      if (result.kind !== "emitted") throw new Error(result.failure.detail);
      const instance = new WebAssembly.Instance(new WebAssembly.Module(emitBinary(result.emission.module)));
      expect((instance.exports.calculate as CallableFunction)(7)).toBe(23);
      expect((instance.exports.calculate as CallableFunction)(11)).toBe(35);
      expect(result.emission.emittedUnitIds).toHaveLength(1);
      expect(phases).toEqual(["prepared", "accepted", "emission-started", "emitted"]);
      for (const generator of direct) expect(generator).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it("keeps a real namespace preparation refusal located and never enters a legacy generator", () => {
    const direct = [
      vi.spyOn(gcCodegen, "generateModule"),
      vi.spyOn(gcCodegen, "generateMultiModule"),
      vi.spyOn(linearCodegen, "generateLinearModule"),
      vi.spyOn(linearCodegen, "generateLinearMultiModule"),
    ];
    const result = runIrProgramDriver(
      input({
        "./entry.ts":
          "namespace N { export function f(): number { return 7; } } export function main(): number { return N.f(); }",
      }),
      options(),
    );
    expect(result.kind).toBe("unsupported");
    if (result.kind !== "unsupported") throw new Error("expected namespace refusal");
    expect(result.phase).toBe("preparation");
    expect(result.failure.sourceFile).toBe("entry.ts");
    expect(result.failure.location.line).toBeGreaterThanOrEqual(1);
    expect(result).not.toHaveProperty("emission");
    for (const generator of direct) expect(generator).not.toHaveBeenCalled();
  });

  it("executes C's real two-source callable dependency control", () => {
    const result = runIrProgramDriver(
      input({
        "./math.ts": "export function double(x: number): number { return x * 2; }",
        "./entry.ts": 'import { double } from "./math"; export function main(): number { return double(20) + 2; }',
      }),
      options(),
    );
    expect(result.kind).toBe("emitted");
    if (result.kind !== "emitted") throw new Error(result.failure.detail);
    const instance = new WebAssembly.Instance(new WebAssembly.Module(emitBinary(result.emission.module)));
    expect((instance.exports.main as CallableFunction)()).toBe(42);
    expect(result.emission.emittedUnitIds).toHaveLength(2);
    expect(result.program.inventory.sources).toHaveLength(2);
  });

  it("retains a real located acceptance refusal without an artifact", () => {
    const emit = vi.spyOn(consumer, "emitAcceptedIrProgram");
    const result = runIrProgramDriver(input(), { ...options(), target: "wasi" });
    expect(result.kind).toBe("unsupported");
    if (result.kind !== "unsupported") throw new Error("expected refusal");
    expect(result.phase).toBe("acceptance");
    expect(result.failure.sourceFile).toBe("entry.ts");
    expect(result.failure.detail).toContain("no wasmgc:wasi runtime projection");
    expect(result).not.toHaveProperty("emission");
    expect(emit).not.toHaveBeenCalled();
  });

  it("freezes target options before preparation observers can mutate the caller's bag", () => {
    const mutable = { ...options() };
    const unsubscribe = subscribePreparedIrProgram((event) => {
      if (event.phase === "prepared") mutable.target = "wasi";
    });
    try {
      expect(runIrProgramDriver(input(), mutable).kind).toBe("emitted");
      expect(mutable.target).toBe("wasi");
    } finally {
      unsubscribe();
    }
  });

  it("preserves an injected located preparation Unsupported without reaching C", () => {
    const source = input();
    const prepared = preparation.prepareWholeIrProgram(source);
    if (prepared.kind !== "prepared") throw new Error(prepared.detail);
    const owner = preparedIrProgramOwner(prepared.program, prepared.program.ir.functions[0].unitId)!;
    const failure = {
      ...owner,
      kind: "unsupported",
      code: "body-shape-rejected",
      stage: "build",
      detail: "injected preparation refusal",
    } as const;
    vi.spyOn(preparation, "prepareWholeIrProgram").mockReturnValueOnce(failure);
    const accept = vi.spyOn(consumer, "acceptPreparedIrProgram");
    const result = runIrProgramDriver(source, options());
    expect(result).toEqual({ kind: "unsupported", phase: "preparation", failure });
    expect(accept).not.toHaveBeenCalled();
  });

  it.each(["preparation", "acceptance"] as const)(
    "makes returned %s invariants fatal with original location",
    (phase) => {
      const source = input();
      const prepared = preparation.prepareWholeIrProgram(source);
      if (prepared.kind !== "prepared") throw new Error(prepared.detail);
      const owner = preparedIrProgramOwner(prepared.program, prepared.program.ir.functions[0].unitId)!;
      const failure = {
        ...owner,
        kind: "invariant",
        code: "unknown-function-ref",
        stage: "resolve",
        detail: "injected invariant",
      } as const;
      if (phase === "preparation") vi.spyOn(preparation, "prepareWholeIrProgram").mockReturnValueOnce(failure);
      else vi.spyOn(consumer, "acceptPreparedIrProgram").mockReturnValueOnce(failure);
      const emit = vi.spyOn(consumer, "emitAcceptedIrProgram");
      try {
        runIrProgramDriver(source, options());
        throw new Error("driver did not throw");
      } catch (error) {
        expect(error).toBeInstanceOf(IrProgramDriverInvariantError);
        expect((error as IrProgramDriverInvariantError).failure).toBe(failure);
      }
      expect(emit).not.toHaveBeenCalled();
    },
  );

  it.each(["preparation", "acceptance", "emission"] as const)("propagates thrown %s failures unchanged", (phase) => {
    const source = input();
    const failure = new Error(`injected ${phase} failure`);
    const fail = () => {
      throw failure;
    };
    if (phase === "preparation") vi.spyOn(preparation, "prepareWholeIrProgram").mockImplementationOnce(fail);
    else if (phase === "acceptance") vi.spyOn(consumer, "acceptPreparedIrProgram").mockImplementationOnce(fail);
    else vi.spyOn(consumer, "emitAcceptedIrProgram").mockImplementationOnce(fail);
    let caught: unknown;
    try {
      runIrProgramDriver(source, options());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
  });
});

describe("public output contract before prepared-program cutover", () => {
  it("proves the poison is attached to the unchanged public object route", () => {
    const generator = vi.spyOn(gcCodegen, "generateModule").mockImplementation(() => {
      throw new Error("public legacy poison attachment");
    });
    const result = compileToObject(scalar);
    expect(generator).toHaveBeenCalledOnce();
    expect(result.success).toBe(false);
    expect(result.object).toHaveLength(0);
    expect(result.errors.some((error) => error.message.includes("public legacy poison attachment"))).toBe(true);
  });

  it("retains executable scalar output and presentation metadata", async () => {
    const result = await compile(scalar, { sourceMap: true, optimize: false });
    expect(result.success).toBe(true);
    const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), result.importObject);
    expect((instance.exports.calculate as CallableFunction)(7)).toBe(23);
    expect(result.dts).toContain("calculate");
    expect(result.wat).toContain("calculate");
    expect(result.sourceMap).toBeTruthy();
    // The recovered base does not publish scalar export-signature metadata.
    expect(result.exportSignatures?.calculate).toBeUndefined();
    expect(result.adapterManifest).toBeDefined();
    expect(result.importsHelper).toContain("createImports");
    expect(result.hasTopLevelStatements).toBe(false);
  });

  it("keeps sync, multi, WAT and object routes available", async () => {
    expect(compileSourceSync(scalar, { optimize: false }).success).toBe(true);
    expect((await compileMulti({ "./entry.ts": scalar }, "./entry.ts", { optimize: false })).success).toBe(true);
    expect(await compileToWat(scalar)).toContain("calculate");
    const object = compileToObject(scalar);
    expect(object.success).toBe(true);
    expect(object.object.length).toBeGreaterThan(0);
    const standalone = compileToObject(scalar, { target: "standalone" });
    expect(standalone.success).toBe(false);
    expect(standalone.object.length).toBe(0);
    expect(standalone.errors[0].message).toContain("Prepared IR program");
  });
});
