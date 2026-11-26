// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7364 — a script with no executable top-level code is a valid program: it compiles through the strict Prepared
// entry and runs. An empty script (no terminal unit) presents as a module without functions; a script of bare
// declarations (`var x;`) owns a module-init unit that its startup never invokes.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as driver from "../src/compiler/ir-program-driver.js";
import { assertPreparedIrProgram } from "../src/ir/program-validation.js";
import type { PreparedIrProgram } from "../src/ir/program.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import {
  compile,
  requiredPreparedEmission,
  type Test262CompileOptions,
} from "../src/test262/test262-prepared-entry.js";

const options = (): Test262CompileOptions =>
  ({
    wholeProgram: Object.freeze({ kind: "prepared-program-required" as const, version: 1 as const }),
    backend: "wasmgc",
    target: "standalone",
    sourceMap: false,
    optimize: false,
    emitWat: false,
    fileName: "test.js",
    allowJs: true,
  }) as Test262CompileOptions;

describe("#7364 — Prepared programs without executable top-level code", () => {
  it.each([
    ["an empty file", ""],
    ["a comment only", "/* c */\n// d"],
    ["a directive only", '"use strict";'],
    ["an empty statement", ";"],
    ["a bare var", "var x;"],
    ["a bare var list", "var x, y;"],
    ["a function declaration only", "function f() { return 1; }"],
  ])("compiles and runs %s", async (_label, source) => {
    const result = await compile(source, options());
    expect(result.errors.map((error) => error.message)).toEqual([]);
    expect(requiredPreparedEmission(result)).toBeDefined();
    const { instance } = instantiatePreparedArtifact(result);
    expect(() => (instance.exports.__module_init as (() => void) | undefined)?.()).not.toThrow();
  });

  // The program's own check runs with node's answer (returns) and with a wrong one (throws).
  it.each([
    ["x !== undefined", "returned"],
    ["x === undefined", "threw"],
  ])("still runs the code beside a bare var: if (%s) throw 1", async (test, outcome) => {
    const result = await compile(`var x;\nif (${test}) throw 1;`, options());
    expect(result.errors.map((error) => error.message)).toEqual([]);
    let ran = "returned";
    try {
      const { instance } = instantiatePreparedArtifact(result);
      (instance.exports.__module_init as (() => void) | undefined)?.();
    } catch {
      ran = "threw";
    }
    expect(ran).toBe(outcome);
  });
});

// The relaxations admit exactly the empty cases: a forged population that only looks empty still refuses.
describe("#7364 — forgeries of an empty program still refuse", () => {
  afterEach(() => vi.restoreAllMocks());

  /** The validated program the strict entry prepares for `source`, as the driver receives it. */
  async function preparedProgram(source: string): Promise<PreparedIrProgram> {
    const real = driver.runIrProgramDriver;
    let program: PreparedIrProgram | undefined;
    vi.spyOn(driver, "runIrProgramDriver").mockImplementationOnce((...args: Parameters<typeof real>) => {
      const result = real(...args);
      if (result.kind === "emitted") program = result.program;
      return result;
    });
    await compile(source, options());
    vi.restoreAllMocks();
    if (program === undefined) throw new Error("no emitted program");
    return program;
  }

  it("validation names only the one module-init unit of a non-executable source", async () => {
    // `f` names `x`, so the #3418 dead-binding elision (#7354 F0) keeps the declaration.
    const program = await preparedProgram("var x; function f() { return x; }");
    const [plan] = program.startup;
    expect(plan!.executable).toBe(false);
    expect(() => assertPreparedIrProgram(program)).not.toThrow();
    const unnamed = { ...program, startup: [{ ...plan!, unitId: null }] } as PreparedIrProgram;
    expect(() => assertPreparedIrProgram(unnamed)).toThrow("names other than its one module-init unit");
    const unit = program.inventory.terminalUnits.find((terminal) => terminal.kind === "module-init")!;
    const doubled = {
      ...program,
      inventory: {
        ...program.inventory,
        terminalUnits: [...program.inventory.terminalUnits, { ...unit, id: `${unit.id}:forged` }],
      },
    } as PreparedIrProgram;
    // The inventory's own identity check refuses a second module-init unit before startup is read.
    expect(() => assertPreparedIrProgram(doubled)).toThrow("terminal");
  });

  it("presentation refuses an empty module whose inventory claims a unit", async () => {
    const real = driver.runIrProgramDriver;
    const [unit] = (await preparedProgram("var x = 1; var y = x;")).inventory.terminalUnits;
    vi.spyOn(driver, "runIrProgramDriver").mockImplementation((...args: Parameters<typeof real>) => {
      const result = real(...args);
      if (result.kind !== "emitted") return result;
      return {
        ...result,
        program: { ...result.program, inventory: { ...result.program.inventory, terminalUnits: [unit] } },
      } as typeof result;
    });
    const result = await compile("/* c */", options());
    expect(result.errors.map((error) => error.code)).toContain("empty-population");
  });
});
