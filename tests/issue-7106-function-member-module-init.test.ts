// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile, type CompileResult } from "../src/index.js";

const OPTIONS = {
  target: "standalone",
  skipSemanticDiagnostics: true,
  trackIrOutcomes: true,
  deferTopLevelInit: true,
} as const;

function moduleInit(result: CompileResult) {
  const rows = (result.irOutcomes ?? []).filter((row) => row.unitKind === "module-init");
  expect(rows, JSON.stringify(result.irOutcomes)).toHaveLength(1);
  return rows[0]!;
}

function requirePrepared(result: CompileResult, name: string): void {
  const rows = (result.irOutcomes ?? []).filter((row) => row.displayName === name);
  expect(rows, JSON.stringify(result.irOutcomes)).toHaveLength(1);
  const row = rows[0]!;
  expect(row).toMatchObject({
    kind: "emitted",
    irBodyEmitted: true,
    legacyBodyEmitted: false,
    directBodyEmissions: 0,
    preparedComponentId: expect.any(String),
  });
  expect(row).not.toHaveProperty("r2Withdrawal");
}

function requireDirect(result: CompileResult, name: string): void {
  const rows = (result.irOutcomes ?? []).filter((row) => row.displayName === name);
  expect(rows, JSON.stringify(result.irOutcomes)).toHaveLength(1);
  expect(rows[0]!.legacyBodyEmitted).toBe(true);
  expect(rows[0]!.preparedComponentId).toBeUndefined();
  // An overlay may also record irBodyEmitted; that is not prepared ownership.
}

async function initializeAndRun(result: CompileResult): Promise<number> {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  expect(typeof instance.exports.__module_init).toBe("function");
  (instance.exports.__module_init as () => void)();
  expect(typeof instance.exports.run).toBe("function");
  return (instance.exports.run as () => number)();
}

describe("#7106 exact function-member module initializer admission", () => {
  it("member-only authentic prepared initializer", async () => {
    const result = await compile(
      "function subject(): number { return 0; }\nsubject.equal = function (a, b) { return a === b; };\nexport function run(): number { return subject.equal(1, 1) ? 1 : 0; }",
      OPTIONS,
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    moduleInit(result);
    for (const name of ["subject", "<module-init>", "run"]) requirePrepared(result, name);
    expect(await initializeAndRun(result)).toBe(1);
  }, 35_000);

  it("extra executable numeric property write", async () => {
    const result = await compile(
      "function subject(): number { return 0; }\nsubject.equal = function (a, b) { return a === b; };\nsubject.marker = 1;\nexport function run(): number { return subject.equal(1, 1) && subject.marker === 1 ? 1 : 0; }",
      OPTIONS,
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    moduleInit(result);
    requireDirect(result, "<module-init>");
    expect(await initializeAndRun(result)).toBe(1);
  }, 35_000);

  it("mixed lexical variable initialization", async () => {
    const result = await compile(
      "function subject(): number { return 0; }\nlet marker: number = 1;\nsubject.equal = function (a, b) { return a === b; };\nexport function run(): number { return subject.equal(1, 1) && marker === 1 ? 1 : 0; }",
      OPTIONS,
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    moduleInit(result);
    requireDirect(result, "<module-init>");
    expect(await initializeAndRun(result)).toBe(1);
  }, 35_000);

  it("class static field work", async () => {
    const result = await compile(
      "function subject(): number { return 0; }\nclass Marker { static value: number = 1; }\nsubject.equal = function (a, b) { return a === b; };\nexport function run(): number { return subject.equal(1, 1) && Marker.value === 1 ? 1 : 0; }",
      OPTIONS,
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    moduleInit(result);
    requireDirect(result, "<module-init>");
    expect(await initializeAndRun(result)).toBe(1);
  }, 35_000);

  it("unprepared physical function target", async () => {
    const result = await compile(
      "function subject(): number { return arguments.length; }\nsubject.equal = function (a, b) { return a === b; };\nexport function run(): number { return subject.equal(1, 1) ? 1 : 0; }",
      OPTIONS,
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    moduleInit(result);
    requireDirect(result, "<module-init>");
    requireDirect(result, "subject");
    expect(await initializeAndRun(result)).toBe(1);
  }, 35_000);

  it("reassigned receiver binding", async () => {
    const result = await compile(
      "function subject(): number { return 0; }\nsubject = function (): number { return 1; };\nsubject.equal = function (a, b) { return a === b; };\nexport function run(): number { return subject.equal(1, 1) ? 1 : 0; }",
      OPTIONS,
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    moduleInit(result);
    requireDirect(result, "<module-init>");
    expect(await initializeAndRun(result)).toBe(1);
  }, 35_000);
});
