// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice R — the Prepared presentation selects the native number boundary on wasmgc standalone, and its
// resource check authenticates each selected provider against the completed physical plan (the number
// remainders, and the native setup's runtime callables) instead of refusing every provider. A reserved
// reference type asks for the detached finalization, which widens a copy, so the completed emission the
// receipts check is never altered. Hosts and WASI keep their contract.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as gc from "../src/codegen/index.js";
import * as linear from "../src/codegen-linear/index.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import {
  compile,
  requiredPreparedEmission,
  type Test262CompileOptions,
} from "../src/test262/test262-prepared-entry.js";

const base = {
  wholeProgram: Object.freeze({ kind: "prepared-program-required" as const, version: 1 as const }),
  backend: "wasmgc",
  sourceMap: false,
  optimize: false,
  emitWat: false,
} as const;
const options = (target: "standalone" | "gc" | "wasi", fileName: string): Test262CompileOptions =>
  ({ ...base, target, fileName, ...(fileName.endsWith(".js") ? { allowJs: true } : {}) }) as Test262CompileOptions;

function forbidDirectGenerators(): void {
  for (const spy of [
    vi.spyOn(gc, "generateModule"),
    vi.spyOn(gc, "generateMultiModule"),
    vi.spyOn(linear, "generateLinearModule"),
    vi.spyOn(linear, "generateLinearMultiModule"),
  ])
    spy.mockImplementation(() => {
      throw new Error("strict request entered a direct generator");
    });
}
afterEach(() => vi.restoreAllMocks());

const messages = (result: { errors: readonly { message: string }[] }) => result.errors.map((error) => error.message);

async function present(source: string, fileName: string) {
  forbidDirectGenerators();
  const result = await compile(source, options("standalone", fileName));
  expect(messages(result)).toEqual([]);
  expect(requiredPreparedEmission(result)).toBeDefined();
  return instantiatePreparedArtifact(result).instance.exports;
}

describe("#7354 R — the Prepared presentation's provider census", () => {
  it.each([
    ["if (1 !== 1) throw 1;", "test.js"],
    ["try { throw 1; } catch (e) { }", "test.js"],
    ["if (1 + 1 !== 2) throw 1;", "entry.ts"],
    ["function g(a: number): void { if (a !== a) throw a; }\ng(1);", "entry.ts"],
  ])("presents and runs a script that boxes a thrown number: %s", async (source, fileName) => {
    const exports = await present(source, fileName);
    const start = exports.__module_init ?? exports._start;
    if (typeof start === "function") expect(() => (start as () => void)()).not.toThrow();
  });

  it("throws the boxed number from an exported function, and returns otherwise", async () => {
    const exports = await present(
      "export function f(x: number): number { if (x !== 1) throw x; return x; }",
      "entry.ts",
    );
    const f = exports.f as (x: number) => number;
    expect(f(1)).toBe(1);
    expect(() => f(2)).toThrow();
  });

  it("joins a number remainder and the native box in one program", async () => {
    const exports = await present(
      "export function f(x: number): number { if (x % 2 !== 0) throw x; return x; }",
      "entry.ts",
    );
    const f = exports.f as (x: number) => number;
    expect(f(4)).toBe(4);
    expect(() => f(3)).toThrow();
  });

  it("catches the boxed number inside the program", async () => {
    const exports = await present(
      "export function f(x: number): number { try { if (x > 1) throw x; return 0; } catch (e) { return 1; } }",
      "entry.ts",
    );
    const f = exports.f as (x: number) => number;
    expect(f(0)).toBe(0);
    expect(f(2)).toBe(1);
  });

  it.each(["gc", "wasi"] as const)("keeps the %s contract: no native number boundary is selected", async (target) => {
    const result = await compile(
      "export function f(x: number): number { if (x !== 1) throw x; return x; }",
      options(target, "entry.ts"),
    );
    expect(result.success).toBe(false);
    expect(messages(result).join("\n")).toContain("js.number.box is unavailable under number-boundary policy");
  });

  it("still refuses a native family the presentation does not select (string constants)", async () => {
    const result = await compile('if (1 > 2) throw "x";', options("standalone", "test.js"));
    expect(result.success).toBe(false);
    expect(messages(result).join("\n")).toContain("js.string.const is unavailable");
  });

  it("leaves a numeric-only program on the exact numeric contract (no detached finalization)", async () => {
    const exports = await present("export function f(x: number): number { return x % 3; }", "entry.ts");
    expect((exports.f as (x: number) => number)(7)).toBe(1);
  });
});
